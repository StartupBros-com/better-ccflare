import { afterAll, expect, it, mock, spyOn } from "bun:test";
import "@better-ccflare/core";
import {
	AsyncDbWriter,
	CacheHealthRepository,
	DatabaseOperations,
} from "@better-ccflare/database";
import type { Account, RequestResponse } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import type { StartMessage } from "../worker-messages";

// Isolate the pricing catalogue, not the protocol/accounting path: these
// fixtures must never fetch models.dev or contact an inference provider.
const actualCore = await import("@better-ccflare/core");
mock.module("@better-ccflare/core", () => ({
	...actualCore,
	isModelPriced: async () => false,
	estimateCostUSD: async () => 0,
}));
afterAll(() => mock.module("@better-ccflare/core", () => actualCore));
const usageCollectorModule = await import("../usage-collector");
const { UsageCollector } = usageCollectorModule;
const { forwardToClient } = await import("../response-handler");

it("persists server-owned accounting even when a successful completion has no usage", async () => {
	// This fixture must always use its own SQLite database, even in a PG job.
	const ambientUrl = process.env.DATABASE_URL;
	let db: DatabaseOperations;
	try {
		delete process.env.DATABASE_URL;
		db = new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
	const adapter = db.getAdapter();
	const collector = new UsageCollector(
		db,
		new AsyncDbWriter(),
		() => false,
		() => {},
	);
	try {
		await adapter.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES ('cache-a', 'Cache A', 'codex', 1)",
		);
		const base: StartMessage = {
			type: "start",
			messageId: "cache-start",
			requestId: "cache-ordinary",
			accountId: "cache-a",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream: false,
			providerName: "codex",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: "Cache A",
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
			comboName: null,
			comboModelOverrideFrom: null,
			comboModelOverrideTo: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
			accounting: {
				accountGeneration: 1,
				provider: "codex",
				model: "physical",
				nativeCache: true,
				internal: false,
			},
		};
		collector.handleStart(base);
		await collector.handleEnd({
			type: "end",
			requestId: base.requestId,
			success: true,
		});
		collector.handleStart({
			...base,
			requestId: "cache-internal",
			accounting: {
				accountGeneration: 1,
				provider: "codex",
				model: "physical",
				nativeCache: true,
				internal: true,
			},
		});
		await collector.handleEnd({
			type: "end",
			requestId: "cache-internal",
			success: true,
		});
		await collector.drain();
		await adapter.run("UPDATE requests SET timestamp = 1800000000000");
		const rows = await new CacheHealthRepository(adapter).fetchBuckets(
			1_800_000_000_000,
			1_800_000_600_000,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			scope: { model: "physical", accountGeneration: 1 },
			missing: 1,
			eligible: 1,
			measured: 0,
			internal: 1,
		});
	} finally {
		collector.dispose();
		await collector.drain();
		await db.close();
	}
});

interface PersistedAccounting {
	model: string | null;
	routed_model: string | null;
	success: number;
	stream_terminal_state: string | null;
	input_tokens: number | null;
	prompt_tokens: number | null;
	cache_read_input_tokens: number | null;
	output_tokens: number | null;
}

/** Real forwarder -> collector -> isolated SQLite -> cache-health query. */
async function forwardAccountingFixture(options: {
	body: string;
	stream?: boolean;
	native?: boolean;
	termination?: "close" | "cancel" | "error";
	chunkBytes?: number;
	requestHeaders?: Headers;
}) {
	const ambientUrl = process.env.DATABASE_URL;
	let db: DatabaseOperations;
	try {
		delete process.env.DATABASE_URL;
		db = new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
	let complete!: (summary: RequestResponse) => void;
	const summarized = new Promise<RequestResponse>((resolve) => {
		complete = resolve;
	});
	const collector = new UsageCollector(
		db,
		new AsyncDbWriter(),
		() => false,
		complete,
	);
	const spy = spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue(
		collector,
	);
	const reportCandidateFailure = mock(() => {});
	const reportCandidateSuccess = mock(() => {});
	try {
		const adapter = db.getAdapter();
		await adapter.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES ('cache-a', 'Cache A', 'codex', 1)",
		);
		const headers = new Headers({
			"content-type": options.stream ? "text/event-stream" : "application/json",
		});
		if (options.stream && options.native !== false) {
			headers.set("x-better-ccflare-codex-response-format", "responses-api");
		}
		const bytes = new TextEncoder().encode(options.body);
		let offset = 0;
		const body = options.stream
			? new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset < bytes.length) {
							const end = Math.min(
								bytes.length,
								offset + (options.chunkBytes ?? bytes.length),
							);
							controller.enqueue(bytes.slice(offset, end));
							offset = end;
						} else if (options.termination === "error") {
							controller.error(new Error("fixture transport failure"));
						} else if (options.termination !== "cancel") {
							controller.close();
						}
					},
				})
			: options.body;
		const response = await forwardToClient(
			{
				requestId: "cache-forwarded",
				method: "POST",
				path: "/v1/messages",
				account: {
					id: "cache-a",
					name: "Cache A",
					provider: "codex",
					created_at: 1,
				} as Account,
				attemptedModel: "attempted",
				requestHeaders: options.requestHeaders ?? new Headers(),
				requestBody: null,
				response: new Response(body, { status: 200, headers }),
				timestamp: Date.now(),
				retryAttempt: 0,
				failoverAttempts: 0,
			},
			{
				strategy: { reportCandidateFailure, reportCandidateSuccess },
				dbOps: db,
				runtime: { port: 8080, tlsEnabled: false },
				config: { getStorePayloads: () => false },
				provider: {
					name: "codex",
					isStreamingResponse: () => options.stream === true,
				},
				refreshInFlight: new Map(),
				asyncWriter: {},
			} as unknown as ProxyContext,
		);
		expect(response.status).toBe(200);
		if (options.termination === "cancel") {
			const reader = response.body?.getReader();
			expect((await reader.read()).done).toBe(false);
			await reader.cancel("fixture client cancel");
			reader.releaseLock();
		} else if (options.termination === "error") {
			await expect(response.text()).rejects.toThrow(
				"fixture transport failure",
			);
		} else {
			// Accounting must not synthesize, rewrite, or swallow response bytes.
			expect(await response.text()).toBe(options.body);
		}
		const summary = await summarized;
		await collector.drain();
		const row = await adapter.get<PersistedAccounting>(
			"SELECT model, routed_model, success, stream_terminal_state, input_tokens, prompt_tokens, cache_read_input_tokens, output_tokens FROM requests WHERE id = 'cache-forwarded'",
		);
		expect(row).not.toBeNull();
		await adapter.run("UPDATE requests SET timestamp = 1800000000000");
		const buckets = await new CacheHealthRepository(adapter).fetchBuckets(
			1_800_000_000_000,
			1_800_000_600_000,
		);
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		expect(reportCandidateSuccess).not.toHaveBeenCalled();
		return { row: row!, summary, buckets };
	} finally {
		spy.mockRestore();
		collector.dispose();
		await collector.drain();
		await db.close();
	}
}

for (const fixture of [
	{
		name: "response model without usage",
		body: { model: " served " },
		model: "served",
	},
	{
		name: "response model over fallback block",
		body: {
			model: "served",
			content: [
				{
					type: "fallback",
					from: { model: "attempted" },
					to: { model: "fallback" },
				},
			],
		},
		model: "served",
	},
	{
		name: "fallback block with blank response model",
		body: {
			model: "  ",
			content: [
				{
					type: "fallback",
					from: { model: "attempted" },
					to: { model: "fallback" },
				},
			],
		},
		model: "fallback",
	},
	{
		name: "attempted model when response model is absent",
		body: { content: [] },
		model: null,
	},
]) {
	it(`keeps missing usage null and attributes ${fixture.name}`, async () => {
		const { row, summary, buckets } = await forwardAccountingFixture({
			body: JSON.stringify(fixture.body),
		});
		expect(row).toMatchObject({
			model: fixture.model,
			routed_model: "attempted",
			success: 1,
			stream_terminal_state: null,
			input_tokens: null,
			prompt_tokens: null,
			cache_read_input_tokens: null,
			output_tokens: null,
		});
		expect(summary.success).toBe(true);
		expect(buckets).toHaveLength(1);
		expect(buckets[0]).toMatchObject({
			scope: { model: fixture.model ?? "attempted" },
			eligible: 1,
			missing: 1,
			measured: 0,
			failed: 0,
		});
	});
}

function responsesFrame(type: string, response: Record<string, unknown>) {
	return `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
}

const measuredResponse = {
	model: "served",
	usage: {
		input_tokens: 10_000,
		input_tokens_details: { cached_tokens: 9_000 },
		output_tokens: 10,
	},
};

for (const fixture of [
	{ type: "response.failed", status: "failed", terminal: "error" },
	{ type: "response.incomplete", status: "incomplete", terminal: "truncated" },
	{
		type: "response.cancelled",
		status: "cancelled",
		terminal: "client_cancelled",
	},
	{ type: "response.completed", status: "failed", terminal: "error" },
	{ type: "response.completed", status: "incomplete", terminal: "truncated" },
]) {
	it(`excludes native ${fixture.type}/${fixture.status} with positive usage from cache health`, async () => {
		const { row, summary, buckets } = await forwardAccountingFixture({
			stream: true,
			chunkBytes: 17,
			body: responsesFrame(fixture.type, {
				...measuredResponse,
				status: fixture.status,
			}),
		});
		expect(row).toMatchObject({
			model: "served",
			success: 0,
			stream_terminal_state: fixture.terminal,
			input_tokens: 1_000,
			prompt_tokens: 10_000,
			cache_read_input_tokens: 9_000,
			output_tokens: 10,
		});
		expect(summary).toMatchObject({
			success: false,
			streamTerminalState: fixture.terminal,
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]).toMatchObject({
			eligible: 0,
			measured: 0,
			missing: 0,
			failed: 1,
			inputTokens: 0,
			cacheReadTokens: 0,
		});
	});
}

it("keeps a genuine native completion usable across CRLF and multiline data frames", async () => {
	const body = `event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":${JSON.stringify({ ...measuredResponse, status: "completed" })}}\r\n\r\n`;
	const { row, summary, buckets } = await forwardAccountingFixture({
		body,
		stream: true,
		chunkBytes: 11,
	});
	expect(row).toMatchObject({
		model: "served",
		success: 1,
		stream_terminal_state: "complete",
		input_tokens: 1_000,
		prompt_tokens: 10_000,
		cache_read_input_tokens: 9_000,
	});
	expect(summary).toMatchObject({
		success: true,
		streamTerminalState: "complete",
	});
	expect(buckets[0]).toMatchObject({
		eligible: 1,
		measured: 1,
		failed: 0,
		inputTokens: 1_000,
		cacheReadTokens: 9_000,
	});
});

for (const body of [
	"",
	responsesFrame("response.created", {
		model: "served",
		status: "in_progress",
	}),
	`${responsesFrame("response.completed", { ...measuredResponse, status: "completed" }).trimEnd()}\n`,
	'event: response.completed\ndata: {"type":"response.completed","response":\n\n',
	'event: response.failed\ndata: {"type":"response.failed"}\n\n',
	'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
	responsesFrame("response.completed", {
		...measuredResponse,
		status: "completed",
	}).replace('"type":"response.completed"', '"type":"response.failed"'),
]) {
	it(`excludes native absent, truncated, or invalid terminal evidence: ${JSON.stringify(body).slice(0, 95)}`, async () => {
		const { row, summary, buckets } = await forwardAccountingFixture({
			body,
			stream: true,
		});
		expect(row.success).toBe(0);
		expect(row.stream_terminal_state).not.toBe("complete");
		expect(summary.success).toBe(false);
		expect(buckets).toHaveLength(1);
		expect(buckets[0]).toMatchObject({
			eligible: 0,
			measured: 0,
			missing: 0,
			failed: 1,
		});
	});
}

for (const termination of ["cancel", "error"] as const) {
	it(`excludes native transport ${termination} without a completed event`, async () => {
		const { row, summary, buckets } = await forwardAccountingFixture({
			stream: true,
			termination,
			body: responsesFrame("response.created", {
				model: "served",
				status: "in_progress",
			}),
		});
		expect(row.success).toBe(0);
		expect(row.stream_terminal_state).toBe(
			termination === "cancel" ? "client_cancelled" : "error",
		);
		expect(summary.success).toBe(false);
		expect(buckets[0]).toMatchObject({ eligible: 0, measured: 0, failed: 1 });
	});
}

it("does not let a later completed event erase native failure evidence", async () => {
	const { row, buckets } = await forwardAccountingFixture({
		stream: true,
		body:
			responsesFrame("response.failed", {
				...measuredResponse,
				status: "failed",
			}) +
			responsesFrame("response.completed", {
				...measuredResponse,
				status: "completed",
			}),
	});
	expect(row).toMatchObject({ success: 0, stream_terminal_state: "error" });
	expect(buckets[0]).toMatchObject({ eligible: 0, measured: 0, failed: 1 });
});

it("does not let a client format header reclassify a transformed Anthropic stream", async () => {
	const body =
		'event: message_start\ndata: {"type":"message_start","message":{"model":"served","usage":{"input_tokens":1000,"cache_read_input_tokens":9000,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
	const { row, buckets } = await forwardAccountingFixture({
		body,
		stream: true,
		native: false,
		requestHeaders: new Headers({
			"x-better-ccflare-codex-response-format": "responses-api",
		}),
	});
	expect(row).toMatchObject({ success: 1, stream_terminal_state: "complete" });
	expect(buckets[0]).toMatchObject({ eligible: 1, measured: 1, failed: 0 });
});

it("keeps the response model authoritative over non-stream fallback iteration metadata", async () => {
	const { row, buckets } = await forwardAccountingFixture({
		body: JSON.stringify({
			model: "served",
			usage: {
				input_tokens: 1_000,
				cache_read_input_tokens: 9_000,
				output_tokens: 10,
				iterations: [
					{
						type: "fallback_message",
						model: "fallback",
						input_tokens: 1_000,
						output_tokens: 10,
					},
				],
			},
		}),
	});
	expect(row).toMatchObject({
		model: "served",
		success: 1,
		stream_terminal_state: null,
		input_tokens: 1_000,
		prompt_tokens: 10_000,
	});
	expect(buckets[0]).toMatchObject({
		scope: { model: "served" },
		eligible: 1,
		measured: 1,
		failed: 0,
	});
});

it("accepts a valid native terminal larger than the legacy 64KiB usage-line buffer", async () => {
	const { row, buckets } = await forwardAccountingFixture({
		stream: true,
		chunkBytes: 4096,
		body: responsesFrame("response.completed", {
			...measuredResponse,
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: "x".repeat(128 * 1024) }],
				},
			],
		}),
	});
	expect(row).toMatchObject({ success: 1, stream_terminal_state: "complete" });
	expect(buckets[0]).toMatchObject({ eligible: 1, measured: 1, failed: 0 });
});

it("keeps a native completion without usage as missing recorded telemetry", async () => {
	const { row, buckets } = await forwardAccountingFixture({
		stream: true,
		body: responsesFrame("response.completed", {
			model: "served",
			status: "completed",
		}),
	});
	expect(row).toMatchObject({
		model: "served",
		success: 1,
		stream_terminal_state: "complete",
		prompt_tokens: null,
		cache_read_input_tokens: null,
	});
	expect(buckets[0]).toMatchObject({
		eligible: 1,
		missing: 1,
		measured: 0,
		failed: 0,
	});
});

for (const termination of ["cancel", "error"] as const) {
	it(`does not promote native transport ${termination} to success after a completed frame`, async () => {
		const { row, buckets } = await forwardAccountingFixture({
			stream: true,
			termination,
			body: responsesFrame("response.completed", {
				...measuredResponse,
				status: "completed",
			}),
		});
		expect(row).toMatchObject({
			success: 0,
			stream_terminal_state:
				termination === "cancel" ? "client_cancelled" : "error",
			prompt_tokens: 10_000,
		});
		expect(buckets[0]).toMatchObject({
			eligible: 0,
			measured: 0,
			failed: 1,
			cacheReadTokens: 0,
		});
	});
}

it("recognizes a native terminal from its JSON type without an event field", async () => {
	const body = `data: ${JSON.stringify({ type: "response.completed", response: { ...measuredResponse, status: "completed" } })}\n\n`;
	const { row, buckets } = await forwardAccountingFixture({
		body,
		stream: true,
	});
	expect(row).toMatchObject({
		model: "served",
		success: 1,
		stream_terminal_state: "complete",
		prompt_tokens: 10_000,
	});
	expect(buckets[0]).toMatchObject({ eligible: 1, measured: 1, failed: 0 });
});
