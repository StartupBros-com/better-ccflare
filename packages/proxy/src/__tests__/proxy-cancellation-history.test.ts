import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import * as operations from "../handlers/proxy-operations";
import { INTERNAL_PROBE_SECRET_HEADER } from "../handlers/proxy-types";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";
import { handleProxy } from "../proxy";
import {
	getRequestLifecycleCoordinator,
	recordRoutingTerminalRequest,
} from "../routing-terminal-recorder";
import * as usage from "../usage-collector";

const originalFetch = globalThis.fetch;
let db: DatabaseOperations;
let collector: usage.UsageCollector;
let restores: Array<() => void> = [];
let ctx: ProxyContext;

beforeEach(async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "ccflare-cancellation-history-"),
	);
	DatabaseFactory.initialize(join(directory, "history.db"));
	db = DatabaseFactory.getInstance();
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id, name, provider, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
			["cancel-account", "cancel-account", "test-provider", "synthetic-key", 1],
		);
	const writer = new AsyncDbWriter();
	collector = new usage.UsageCollector(
		db,
		writer,
		() => false,
		() => undefined,
	);
	for (const name of ["getUsageCollector", "tryGetUsageCollector"] as const) {
		const spy = spyOn(usage, name).mockReturnValue(collector);
		restores.push(() => spy.mockRestore());
	}
	ctx = {
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: db,
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () => "exhausted",
			getStorePayloads: () => false,
		},
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://synthetic.invalid/v1/messages",
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			isStreamingResponse: (response: Response) =>
				response.headers.get("content-type")?.includes("text/event-stream") ===
				true,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight: new Map(),
		asyncWriter: writer,
	} as unknown as ProxyContext;
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const restore of restores) restore();
	restores = [];
	collector.dispose();
	await collector.drain();
	await DatabaseFactory.reset();
});

function makeRequest(controller: AbortController): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		signal: controller.signal,
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-account-id": "cancel-account",
			authorization: "Bearer private-credential",
		},
		body: JSON.stringify({
			model: "test-model",
			messages: [{ role: "user", content: "private prompt" }],
			max_tokens: 1,
		}),
	});
}

describe("canonical history for caller cancellation before forwarding", () => {
	it("records an unattempted cancellation once with no invented account or physical attempt and sanitized headers", async () => {
		const requestMeta = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			method: "POST",
			path: "/v1/messages",
		} as RequestMeta;
		getRequestLifecycleCoordinator(requestMeta).bindRoutingObservation(
			new RoutingAttemptLedger(),
			(status) => status,
		);
		const startSpy = spyOn(collector, "handleStart");
		restores.push(() => startSpy.mockRestore());
		const fetch = mock(async () => {
			throw new Error("No provider or pricing calls permitted");
		});
		globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
		const options = {
			collector,
			requestMeta,
			requestHeaders: new Headers({
				authorization: "Bearer private-credential",
				"x-api-key": "private-api-key",
			}),
			response: new Response(null, { status: 499 }),
			providerName: "anthropic",
			terminalKind: "client_cancelled",
			upstreamAttempts: 0,
		};
		await Promise.all([
			recordRoutingTerminalRequest(options),
			recordRoutingTerminalRequest(options),
		]);
		await collector.drain();
		expect(fetch).not.toHaveBeenCalled();
		expect(startSpy).toHaveBeenCalledTimes(1);
		const headers = JSON.stringify(startSpy.mock.calls[0][0].requestHeaders);
		expect(headers).not.toContain("private-credential");
		expect(headers).not.toContain("private-api-key");
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: requestMeta.id,
			account_used: null,
			status_code: 499,
			success: false,
		});
		const row = await db
			.getAdapter()
			.get<{ routing_attempt_summary: string }>(
				"SELECT routing_attempt_summary FROM requests WHERE id=?",
				[requestMeta.id],
			);
		expect(JSON.parse(row?.routing_attempt_summary)).toMatchObject({
			physicalAttemptCount: 0,
			attempts: [],
			winnerOrdinal: null,
			terminalCause: "client_cancelled",
		});
	});
	it("keeps authenticated auto-refresh cancellation out of request history", async () => {
		const controller = new AbortController();
		ctx.internalProbeSecret = "synthetic-internal-secret";
		const request = makeRequest(controller);
		request.headers.set(INTERNAL_PROBE_SECRET_HEADER, ctx.internalProbeSecret);
		request.headers.set("x-better-ccflare-auto-refresh", "true");
		globalThis.fetch = mock(async () => {
			controller.abort();
			throw new DOMException("synthetic disconnect", "AbortError");
		}) as unknown as typeof globalThis.fetch;
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(499);
		await collector.drain();
		expect(await db.getRecentRequests()).toEqual([]);
	});

	it("keeps telemetry failure fail-open on a caller cancellation", async () => {
		const controller = new AbortController();
		const request = makeRequest(controller);
		const endSpy = spyOn(collector, "handleEnd").mockRejectedValue(
			new Error("synthetic telemetry failure"),
		);
		restores.push(() => endSpy.mockRestore());
		globalThis.fetch = mock(async () => {
			controller.abort();
			throw new DOMException("synthetic disconnect", "AbortError");
		}) as unknown as typeof globalThis.fetch;
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(499);
		expect(endSpy).toHaveBeenCalledTimes(1);
	});

	it("does not log an internally discarded candidate as caller cancellation", async () => {
		const controller = new AbortController();
		globalThis.fetch = mock(async () =>
			Response.json({ content: [] }),
		) as unknown as typeof globalThis.fetch;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			const result = await proxyWithAccount(...args);
			expect(operations.isPreparedProxyAccountResponse(result)).toBe(true);
			if (operations.isPreparedProxyAccountResponse(result))
				await result.discard("synthetic internal loser");
			return new Response(null, { status: 499 });
		});
		restores.push(() => operationSpy.mockRestore());
		const request = makeRequest(controller);
		await handleProxy(request, new URL(request.url), ctx);
		expect(controller.signal.aborted).toBe(false);
		await collector.drain();
		expect(await db.getRecentRequests()).toEqual([]);
	});

	it.each([
		"started",
		"finalizing",
		"streaming",
	] as const)("preserves a %s collector when caller cancellation follows response ownership", async (phase) => {
		const controller = new AbortController();
		const startSpy = spyOn(collector, "handleStart");
		const end = collector.handleEnd.bind(collector);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pendingEnd: Promise<void> | undefined;
		const endSpy = spyOn(collector, "handleEnd").mockImplementation(
			(message) => {
				pendingEnd = gate.then(() => end(message));
				return pendingEnd;
			},
		);
		restores.push(
			() => startSpy.mockRestore(),
			() => endSpy.mockRestore(),
		);
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			if (
				String(input instanceof Request ? input.url : input) !==
				"https://synthetic.invalid/v1/messages"
			)
				throw new Error("External fetch disabled in integration test");
			if (phase === "streaming") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							stream.enqueue(
								new TextEncoder().encode(
									'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"test-model","usage":{"input_tokens":17,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":3}}\n\n',
								),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return Response.json({
				model: "test-model",
				content: [],
				usage: { input_tokens: 17, output_tokens: 3 },
			});
		}) as unknown as typeof globalThis.fetch;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			const result = await proxyWithAccount(...args);
			expect(operations.isPreparedProxyAccountResponse(result)).toBe(true);
			if (operations.isPreparedProxyAccountResponse(result)) {
				const commit = result.commit;
				result.commit = async () => {
					const response = await commit();
					if (phase === "finalizing") await response.text();
					expect(getRequestLifecycleCoordinator(args[3]).state).toBe(
						phase === "finalizing" ? "finalized" : "started",
					);
					if (phase !== "streaming") controller.abort();
					return response;
				};
			}
			return result;
		});
		restores.push(() => operationSpy.mockRestore());
		const request = makeRequest(controller);
		try {
			const response = await handleProxy(request, new URL(request.url), ctx);
			expect(startSpy).toHaveBeenCalledTimes(1);
			if (phase !== "finalizing") {
				expect(endSpy).not.toHaveBeenCalled();
				if (phase === "streaming") {
					const reader = response.body?.getReader();
					const chunk = await reader.read();
					expect(chunk.done).toBe(false);
					expect(new TextDecoder().decode(chunk.value)).toContain(
						"message_start",
					);
					controller.abort();
					release();
					await reader.cancel();
				} else await response.body?.cancel();
			}
			await Promise.resolve();
			expect(endSpy).toHaveBeenCalledTimes(1);
		} finally {
			release();
		}
		await pendingEnd;
		await collector.drain();
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(rows[0].status_code).toBe(200);
		expect(rows[0].success).toBe(phase === "finalizing");
		if (phase !== "started") {
			const row = await db
				.getAdapter()
				.get<Record<string, unknown>>(
					"SELECT input_tokens, output_tokens FROM requests WHERE id=?",
					[rows[0].id],
				);
			expect(row).toEqual({ input_tokens: 17, output_tokens: 3 });
		}
	});

	it.each([
		"fetch",
		"prepared",
	] as const)("persists one failed request on %s cancellation, without failover or account penalty", async (phase) => {
		const controller = new AbortController();
		let originalRequestId: string | undefined;
		let discarded = 0;
		const proxyWithAccount = operations.proxyWithAccount;
		const operationSpy = spyOn(
			operations,
			"proxyWithAccount",
		).mockImplementation(async (...args) => {
			originalRequestId = args[3].id;
			const result = await proxyWithAccount(...args);
			if (phase === "prepared") {
				expect(operations.isPreparedProxyAccountResponse(result)).toBe(true);
				if (operations.isPreparedProxyAccountResponse(result)) {
					const discard = result.discard;
					result.discard = async (reason) => {
						discarded++;
						await discard(reason);
					};
					controller.abort();
				}
			}
			return result;
		});
		restores.push(() => operationSpy.mockRestore());
		const fetch = mock(async () => {
			if (phase === "fetch") {
				controller.abort();
				throw new DOMException("synthetic caller disconnect", "AbortError");
			}
			return Response.json({
				model: "test-model",
				content: [],
				usage: { input_tokens: 100, output_tokens: 50 },
			});
		});
		globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "cancel-account",
			},
			body: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user", content: "private prompt" }],
				max_tokens: 1,
			}),
		});
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(499);
		expect(fetch).toHaveBeenCalledTimes(1);
		await collector.drain();
		const rows = await db.getRecentRequests();
		expect(rows).toHaveLength(1);
		expect(originalRequestId).toBeDefined();
		expect(rows[0]).toMatchObject({
			id: originalRequestId,
			account_used: "cancel-account",
			status_code: 499,
			success: false,
		});
		expect(discarded).toBe(phase === "prepared" ? 1 : 0);
		const persisted = await db
			.getAdapter()
			.get<Record<string, unknown>>("SELECT * FROM requests WHERE id=?", [
				originalRequestId,
			]);
		expect(persisted).toMatchObject({
			error_message: "client_cancelled",
			stream_terminal_state: "client_cancelled",
			input_tokens: null,
			output_tokens: null,
			cost_usd: null,
			routed_provider: "anthropic",
			routed_model: "test-model",
		});
		const summary = JSON.parse(persisted?.routing_attempt_summary as string);
		expect(summary).toMatchObject({
			physicalAttemptCount: 1,
			winnerOrdinal: null,
			nativeStatus: 499,
			terminalCause: "client_cancelled",
			cancellationOrigin: "unknown",
		});
		expect(summary.attempts).toHaveLength(1);
		expect(summary.attempts[0]).toMatchObject({
			accountId: "cancel-account",
			outcome: "cancelled",
			cause: "client_cancelled",
		});
		expect(await db.getRequestPayload(rows[0].id)).toBeNull();
		const account = await db.getAccount("cancel-account");
		expect(account?.paused).toBe(false);
		expect(account?.rate_limited_until).toBeNull();
	});
});
