import { describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

const usageCollectorModule = await import("../../usage-collector");
const { codexWebSocketTransport } = await import(
	"../../codex-websocket-transport"
);
const { RoutingAttemptLedger } = await import("../routing-attempt-ledger");
const {
	filterCodexReasoningBlocks,
	isCodexReasoningVerificationError,
	proxyWithAccount,
} = await import("../proxy-operations");

function encodeBody(body: unknown): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(body)).buffer;
}

function decodeBody(buffer: ArrayBuffer): unknown {
	return JSON.parse(new TextDecoder().decode(buffer));
}

function makeCodexAccount(): Account {
	return {
		id: "codex-reasoning-account",
		name: "codex-reasoning-test",
		provider: "codex",
		api_key: null,
		refresh_token: "",
		access_token: "test-access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: JSON.stringify({ sonnet: "gpt-5.4" }),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeRequestMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function codexSuccessResponse(): Response {
	return new Response(
		[
			'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_reasoning_retry","model":"gpt-5.4"}}\n\n',
			'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
			'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_reasoning_retry","model":"gpt-5.4","status":"completed","usage":{"input_tokens":10,"output_tokens":1,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}}\n\n',
			"data: [DONE]\n\n",
		].join(""),
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function makeReasoningRequestBody(includeCacheControl = false): ArrayBuffer {
	return encodeBody({
		model: "claude-sonnet-4-5",
		max_tokens: 16,
		stream: true,
		...(includeCacheControl
			? {
					system: [
						{
							type: "text",
							text: "stable system prefix",
							cache_control: { type: "ephemeral" },
						},
					],
				}
			: {}),
		metadata: {
			user_id: JSON.stringify({
				session_id: "11111111-1111-4111-8111-111111111111",
			}),
		},
		messages: [
			{ role: "user", content: "initial" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "before" },
					{
						type: "redacted_thinking",
						data: "bccfr1.rs_bound.encrypted-payload",
					},
					{ type: "text", text: "after" },
				],
			},
			{ role: "user", content: "continue" },
		],
	});
}

function makeReasoningRequest(body: ArrayBuffer): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
		},
		body,
	});
}

async function runCodexRecoveryScenario(
	requestId: string,
	responseForAttempt: (attempt: number) => Response,
	body: ArrayBuffer = makeReasoningRequestBody(),
): Promise<{
	response: Awaited<ReturnType<typeof proxyWithAccount>>;
	outboundBodies: Array<Record<string, unknown>>;
	logicalAttemptCount: number;
	physicalAttemptCount: number;
}> {
	const originalFetch = globalThis.fetch;
	const outboundBodies: Array<Record<string, unknown>> = [];
	const websocketAttempt = spyOn(
		codexWebSocketTransport,
		"tryRequest",
	).mockResolvedValue(null);
	const usageCollector = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(() => Promise.resolve()),
	} as never);

	try {
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			outboundBodies.push(
				(await request.clone().json()) as Record<string, unknown>,
			);
			return responseForAttempt(outboundBodies.length);
		});
		const request = makeReasoningRequest(body);
		const ledger = new RoutingAttemptLedger();
		const response = await proxyWithAccount(
			request,
			new URL(request.url),
			makeCodexAccount(),
			makeRequestMeta(requestId),
			body,
			() => undefined,
			0,
			makeProxyContext(),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
		);
		return {
			response,
			outboundBodies,
			logicalAttemptCount: ledger.attemptedCount,
			physicalAttemptCount: ledger.physicalAttemptCount,
		};
	} finally {
		globalThis.fetch = originalFetch;
		websocketAttempt.mockRestore();
		usageCollector.mockRestore();
	}
}

function readRequestTraces(
	directory: string,
	requestId: string,
): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	for (const file of readdirSync(directory).filter((name) =>
		name.endsWith(".jsonl"),
	)) {
		for (const line of readFileSync(join(directory, file), "utf8").split(
			"\n",
		)) {
			if (!line.trim()) continue;
			const record = JSON.parse(line) as Record<string, unknown>;
			if (record.phase === "request" && record.request_id === requestId) {
				records.push(record);
			}
		}
	}
	return records.sort(
		(a, b) => Number(a.attempt_ordinal) - Number(b.attempt_ordinal),
	);
}

function jsonErrorResponse(message: string, status = 400): Response {
	return new Response(JSON.stringify({ error: { message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("isCodexReasoningVerificationError", () => {
	it("recognizes an encrypted reasoning payload that could not be verified", async () => {
		const response = jsonErrorResponse(
			"The encrypted content for item rs_bound could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
		);

		expect(await isCodexReasoningVerificationError(response)).toBe(true);
	});

	it("recognizes a legacy empty reasoning item ID rejection", async () => {
		const response = jsonErrorResponse(
			"Invalid 'input[1].id': ''. Expected an ID that contains letters, numbers, underscores, or dashes.",
		);

		expect(await isCodexReasoningVerificationError(response)).toBe(true);
	});

	it("matches encrypted-content markers case-insensitively", async () => {
		const response = jsonErrorResponse(
			"ENCRYPTED CONTENT for item rs_bound COULD NOT BE DECRYPTED.",
		);

		expect(await isCodexReasoningVerificationError(response)).toBe(true);
	});

	it("rejects unrelated and incomplete JSON 400 messages", async () => {
		for (const message of [
			"model not found",
			"cache_control: Extra inputs are not permitted",
			"random invalid request",
			"Encrypted content is malformed",
			"Item could not be verified",
		]) {
			expect(
				await isCodexReasoningVerificationError(jsonErrorResponse(message)),
			).toBe(false);
		}
	});

	it("rejects non-400 responses before reading JSON", async () => {
		const readJson = mock(async () => ({
			error: {
				message: "Encrypted content could not be verified",
			},
		}));

		expect(
			await isCodexReasoningVerificationError(
				jsonErrorResponse("ignored", 422),
				readJson,
			),
		).toBe(false);
		expect(readJson).not.toHaveBeenCalled();
	});

	it("rejects non-JSON 400 responses without cloning or reading the body", async () => {
		const response = new Response("Encrypted content could not be verified", {
			status: 400,
			headers: { "content-type": "text/plain" },
		});
		const readJson = mock(async () => ({
			error: {
				message: "Encrypted content could not be verified",
			},
		}));

		expect(await isCodexReasoningVerificationError(response, readJson)).toBe(
			false,
		);
		expect(readJson).not.toHaveBeenCalled();
		expect(response.bodyUsed).toBe(false);
	});
});

describe("filterCodexReasoningBlocks", () => {
	it("removes only proxy-minted reasoning blocks from assistant arrays", () => {
		const original = {
			model: "claude-sonnet-4-5",
			metadata: { request: "preserve-me" },
			messages: [
				{
					role: "user",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.user-copy" },
						{ type: "text", text: "continue" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "before" },
						{ type: "redacted_thinking", data: "bccfr1.rs_bound.cipher" },
						{ type: "redacted_thinking", data: "anthropic-genuine" },
						{ type: "redacted_thinking", data: "bccfr10.not-ours" },
						{ type: "tool_use", id: "tool_1", name: "Lookup", input: {} },
					],
				},
				{ role: "assistant", content: "plain assistant content" },
			],
		};
		const originalBuffer = encodeBody(original);

		const filtered = filterCodexReasoningBlocks(originalBuffer);

		expect(filtered).not.toBeNull();
		expect(filtered).not.toBe(originalBuffer);
		expect(decodeBody(filtered as ArrayBuffer)).toEqual({
			...original,
			messages: [
				original.messages[0],
				{
					...original.messages[1],
					content: [
						{ type: "text", text: "before" },
						{ type: "redacted_thinking", data: "anthropic-genuine" },
						{ type: "redacted_thinking", data: "bccfr10.not-ours" },
						{ type: "tool_use", id: "tool_1", name: "Lookup", input: {} },
					],
				},
				original.messages[2],
			],
		});
	});

	it("returns null and warns when the request body is invalid JSON", () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		try {
			const invalid = new TextEncoder().encode("{").buffer;

			expect(filterCodexReasoningBlocks(invalid)).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain(
				"Failed to filter Codex reasoning blocks",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("drops only assistant messages made effectively empty by stripping", () => {
		const keptEmptyMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
		};
		const body = {
			messages: [
				{ role: "user", content: "before" },
				{
					role: "assistant",
					content: [{ type: "redacted_thinking", data: "bccfr1.rs_1.a" }],
				},
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.rs_2.b" },
						{ type: "text", text: "" },
					],
				},
				keptEmptyMessage,
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.rs_3.c" },
						{ type: "text", text: "kept sibling" },
					],
				},
				{ role: "user", content: "after" },
			],
		};

		const filtered = filterCodexReasoningBlocks(encodeBody(body));

		expect(decodeBody(filtered as ArrayBuffer)).toEqual({
			messages: [
				body.messages[0],
				keptEmptyMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: "kept sibling" }],
				},
				body.messages[5],
			],
		});
	});

	it("returns the original buffer by identity when there is nothing to strip", () => {
		const originalBuffer = encodeBody({
			model: "claude-sonnet-4-5",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "anthropic-genuine" },
						{ type: "redacted_thinking", data: 42 },
					],
				},
				{
					role: "user",
					content: [{ type: "redacted_thinking", data: "bccfr1.user-copy" }],
				},
			],
		});

		expect(filterCodexReasoningBlocks(originalBuffer)).toBe(originalBuffer);
		expect(filterCodexReasoningBlocks(null)).toBeNull();
	});
});

describe("proxyWithAccount Codex reasoning recovery", () => {
	it("retries once without retained reasoning while preserving siblings and the physical route", async () => {
		const originalFetch = globalThis.fetch;
		const previousTraceDirectory = process.env.CCFLARE_CODEX_TRACE_DIR;
		const traceDirectory = mkdtempSync(
			join(tmpdir(), "codex-reasoning-retry-"),
		);
		const requestId = "codex-reasoning-retry";
		const outboundBodies: Array<Record<string, unknown>> = [];
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);
		const usageCollector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock(() => Promise.resolve()),
		} as never);

		try {
			process.env.CCFLARE_CODEX_TRACE_DIR = traceDirectory;
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request =
					input instanceof Request ? input : new Request(String(input));
				outboundBodies.push(
					(await request.clone().json()) as Record<string, unknown>,
				);
				if (outboundBodies.length === 1) {
					return jsonErrorResponse(
						"The encrypted content for item rs_bound could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
					);
				}
				return codexSuccessResponse();
			});

			const bodyBuffer = encodeBody({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: true,
				metadata: {
					user_id: JSON.stringify({
						session_id: "11111111-1111-4111-8111-111111111111",
					}),
				},
				messages: [
					{ role: "user", content: "initial" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "before" },
							{
								type: "redacted_thinking",
								data: "bccfr1.rs_bound.encrypted-payload",
							},
							{ type: "text", text: "after" },
						],
					},
					{ role: "user", content: "continue" },
				],
			});
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				body: bodyBuffer,
			});
			const ledger = new RoutingAttemptLedger();

			const response = await proxyWithAccount(
				request,
				new URL(request.url),
				makeCodexAccount(),
				makeRequestMeta(requestId),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				ledger,
			);

			expect(outboundBodies).toHaveLength(2);
			expect(response).toBeInstanceOf(Response);
			expect((response as Response).status).toBe(200);
			expect(websocketAttempt).toHaveBeenCalledTimes(2);
			expect(ledger.attemptedCount).toBe(1);
			expect(ledger.physicalAttemptCount).toBe(2);
			expect(outboundBodies.map((body) => body.model)).toEqual([
				"gpt-5.4",
				"gpt-5.4",
			]);

			const firstInput = outboundBodies[0]?.input as Array<
				Record<string, unknown>
			>;
			const secondInput = outboundBodies[1]?.input as Array<
				Record<string, unknown>
			>;
			expect(firstInput).toContainEqual({
				type: "reasoning",
				id: "rs_bound",
				summary: [],
				encrypted_content: "encrypted-payload",
			});
			expect(secondInput.some((item) => item.type === "reasoning")).toBe(false);
			const outputTexts = (input: Array<Record<string, unknown>>) =>
				input.flatMap((item) =>
					Array.isArray(item.content)
						? (item.content as Array<Record<string, unknown>>)
								.filter((block) => block.type === "output_text")
								.map((block) => block.text)
						: [],
				);
			expect(outputTexts(firstInput)).toEqual(["before", "after"]);
			expect(outputTexts(secondInput)).toEqual(["before", "after"]);

			const traces = readRequestTraces(traceDirectory, requestId);
			expect(traces.map((trace) => trace.attempt_cause)).toEqual([
				"initial",
				"reasoning_retry",
			]);
			expect(traces.map((trace) => trace.attempt_ordinal)).toEqual([1, 2]);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousTraceDirectory === undefined) {
				delete process.env.CCFLARE_CODEX_TRACE_DIR;
			} else {
				process.env.CCFLARE_CODEX_TRACE_DIR = previousTraceDirectory;
			}
			rmSync(traceDirectory, { recursive: true, force: true });
			websocketAttempt.mockRestore();
			usageCollector.mockRestore();
		}
	});

	it("bounds repeated verification failures to one retry", async () => {
		const scenario = await runCodexRecoveryScenario(
			"codex-reasoning-repeated-400",
			() =>
				jsonErrorResponse(
					"The encrypted content for item rs_bound could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
				),
		);

		expect(scenario.outboundBodies).toHaveLength(2);
		expect(scenario.logicalAttemptCount).toBe(1);
		expect(scenario.physicalAttemptCount).toBe(2);
		expect(scenario.response).toBeInstanceOf(Response);
		expect((scenario.response as Response).status).toBe(400);
		const firstInput = scenario.outboundBodies[0]?.input as Array<
			Record<string, unknown>
		>;
		const secondInput = scenario.outboundBodies[1]?.input as Array<
			Record<string, unknown>
		>;
		expect(firstInput.some((item) => item.type === "reasoning")).toBe(true);
		expect(secondInput.some((item) => item.type === "reasoning")).toBe(false);
	});

	it("does not retry an unrelated JSON 400", async () => {
		const scenario = await runCodexRecoveryScenario(
			"codex-reasoning-unrelated-400",
			() => jsonErrorResponse("random invalid request"),
		);

		expect(scenario.outboundBodies).toHaveLength(1);
		expect(scenario.logicalAttemptCount).toBe(1);
		expect(scenario.physicalAttemptCount).toBe(1);
		expect(scenario.response).toBeInstanceOf(Response);
		expect((scenario.response as Response).status).toBe(400);
	});

	it("does not retry a matching error when the source has no proxy reasoning block", async () => {
		const body = encodeBody({
			model: "claude-sonnet-4-5",
			max_tokens: 16,
			stream: true,
			messages: [
				{ role: "user", content: "initial" },
				{ role: "assistant", content: "ordinary history" },
				{ role: "user", content: "continue" },
			],
		});
		const scenario = await runCodexRecoveryScenario(
			"codex-reasoning-no-block",
			() =>
				jsonErrorResponse(
					"The encrypted content for item rs_missing could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
				),
			body,
		);

		expect(scenario.outboundBodies).toHaveLength(1);
		expect(scenario.logicalAttemptCount).toBe(1);
		expect(scenario.physicalAttemptCount).toBe(1);
		expect(scenario.response).toBeInstanceOf(Response);
		expect((scenario.response as Response).status).toBe(400);
	});

	it("keeps reasoning stripped through a following cache-control retry", async () => {
		const previousTraceDirectory = process.env.CCFLARE_CODEX_TRACE_DIR;
		const traceDirectory = mkdtempSync(
			join(tmpdir(), "codex-reasoning-cache-control-retry-"),
		);
		const requestId = "codex-reasoning-cache-control-retry";

		try {
			process.env.CCFLARE_CODEX_TRACE_DIR = traceDirectory;
			const scenario = await runCodexRecoveryScenario(
				requestId,
				(attempt) => {
					if (attempt === 1) {
						return jsonErrorResponse(
							"The encrypted content for item rs_bound could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
						);
					}
					if (attempt === 2) {
						return jsonErrorResponse(
							"cache_control: Extra inputs are not permitted",
						);
					}
					return codexSuccessResponse();
				},
				makeReasoningRequestBody(true),
			);

			expect(scenario.response).toBeInstanceOf(Response);
			expect((scenario.response as Response).status).toBe(200);
			expect(scenario.logicalAttemptCount).toBe(1);
			expect(scenario.physicalAttemptCount).toBe(3);
			expect(scenario.outboundBodies).toHaveLength(3);
			expect(
				scenario.outboundBodies.map((body) =>
					(body.input as Array<Record<string, unknown>>).some(
						(item) => item.type === "reasoning",
					),
				),
			).toEqual([true, false, false]);

			const traces = readRequestTraces(traceDirectory, requestId);
			expect(traces.map((trace) => trace.attempt_cause)).toEqual([
				"initial",
				"reasoning_retry",
				"cache_control_retry",
			]);
			expect(traces.map((trace) => trace.attempt_ordinal)).toEqual([1, 2, 3]);
		} finally {
			if (previousTraceDirectory === undefined) {
				delete process.env.CCFLARE_CODEX_TRACE_DIR;
			} else {
				process.env.CCFLARE_CODEX_TRACE_DIR = previousTraceDirectory;
			}
			rmSync(traceDirectory, { recursive: true, force: true });
		}
	});
	it("keeps reasoning stripped when a model fallback follows the retry", async () => {
		const originalFetch = globalThis.fetch;
		const previousTraceDirectory = process.env.CCFLARE_CODEX_TRACE_DIR;
		const traceDirectory = mkdtempSync(
			join(tmpdir(), "codex-reasoning-fallback-"),
		);
		const requestId = "codex-reasoning-fallback";
		const outboundBodies: Array<Record<string, unknown>> = [];
		const websocketAttempt = spyOn(
			codexWebSocketTransport,
			"tryRequest",
		).mockResolvedValue(null);
		const usageCollector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock(() => Promise.resolve()),
		} as never);

		try {
			process.env.CCFLARE_CODEX_TRACE_DIR = traceDirectory;
			// 1: reasoning-verification 400 -> strip+retry.
			// 2: the stripped retry is rate-limited -> model fallback.
			// 3: the fallback candidate must NOT carry the stripped block back.
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const request =
					input instanceof Request ? input : new Request(String(input));
				outboundBodies.push(
					(await request.clone().json()) as Record<string, unknown>,
				);
				if (outboundBodies.length === 1) {
					return jsonErrorResponse(
						"The encrypted content for item rs_bound could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
					);
				}
				if (outboundBodies.length === 2) {
					return jsonErrorResponse("model not found", 404);
				}
				return codexSuccessResponse();
			});

			const bodyBuffer = encodeBody({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: true,
				metadata: {
					user_id: JSON.stringify({
						session_id: "22222222-2222-4222-8222-222222222222",
					}),
				},
				messages: [
					{ role: "user", content: "initial" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "before" },
							{
								type: "redacted_thinking",
								data: "bccfr1.rs_bound.encrypted-payload",
							},
						],
					},
					{ role: "user", content: "continue" },
				],
			});
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				body: bodyBuffer,
			});
			const account = makeCodexAccount();
			// getModelList reads model_mappings: [primary, ...fallbacks].
			account.model_mappings = JSON.stringify({
				sonnet: ["gpt-5.4", "gpt-5.4-mini"],
			});
			const ledger = new RoutingAttemptLedger();

			await proxyWithAccount(
				request,
				new URL(request.url),
				account,
				makeRequestMeta(requestId),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				ledger,
			);

			expect(outboundBodies.length).toBeGreaterThanOrEqual(3);
			const reasoningItems = (index: number) =>
				(
					(outboundBodies[index]?.input as Array<Record<string, unknown>>) ?? []
				).filter((item) => item.type === "reasoning");
			// The first attempt carries it, the strip removes it, and the model
			// fallback must not resurrect it from the pre-strip body.
			expect(reasoningItems(0)).toHaveLength(1);
			expect(reasoningItems(1)).toHaveLength(0);
			expect(reasoningItems(2)).toHaveLength(0);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousTraceDirectory === undefined) {
				delete process.env.CCFLARE_CODEX_TRACE_DIR;
			} else {
				process.env.CCFLARE_CODEX_TRACE_DIR = previousTraceDirectory;
			}
			rmSync(traceDirectory, { recursive: true, force: true });
			websocketAttempt.mockRestore();
			usageCollector.mockRestore();
		}
	});
});
