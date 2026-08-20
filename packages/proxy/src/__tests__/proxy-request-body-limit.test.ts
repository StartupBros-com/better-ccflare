import { describe, expect, it, mock, spyOn } from "bun:test";
import { MAX_REQUEST_BODY_BYTES } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function makeAdmissionCalls() {
	return {
		select: mock<(accounts: Account[]) => Account[]>(() => []),
		getAllAccounts: mock<() => Promise<Account[]>>(async () => []),
		prepareHeaders: mock((headers: Headers) => headers),
		buildUrl: mock(() => "https://upstream.test/v1/messages"),
		enqueue: mock(() => undefined),
		verifyGuardCorrelation: mock(() => undefined),
		canHandle: mock(() => true),
	};
}

function makeAccount(): Account {
	return {
		id: "boundary-account",
		name: "boundary-account",
		provider: "test-provider" as Account["provider"],
		api_key: "provider-secret",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
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
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeContext(
	calls: ReturnType<typeof makeAdmissionCalls>,
): ProxyContext {
	return {
		strategy: { select: calls.select },
		dbOps: {
			getAllAccounts: calls.getAllAccounts,
			getActiveComboForFamily: mock(async () => null),
		},
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		},
		provider: {
			name: "test-provider",
			canHandle: calls.canHandle,
			buildUrl: calls.buildUrl,
			prepareHeaders: calls.prepareHeaders,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: calls.enqueue },
		guardCorrelationVerifier: calls.verifyGuardCorrelation,
	} as unknown as ProxyContext;
}

describe("proxy request body admission", () => {
	it("returns a stable 413 before parsing, selection, persistence, or provider fetch", async () => {
		const calls = makeAdmissionCalls();
		const request = new Request("https://proxy.test/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-length": String(32 * 1024 * 1024 + 1),
			},
			body: '{"model":"must-not-be-parsed"}',
		});
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(async () => new Response("unexpected upstream call"));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		try {
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(calls),
			);

			expect(response.status).toBe(413);
			expect(response.headers.get("content-type")).toContain(
				"application/json",
			);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "request_too_large",
					message: "Request body exceeds the 32 MiB limit.",
				},
			});
			expect(calls.verifyGuardCorrelation).not.toHaveBeenCalled();
			expect(calls.canHandle).toHaveBeenCalledTimes(1);
			expect(calls.select).not.toHaveBeenCalled();
			expect(calls.getAllAccounts).not.toHaveBeenCalled();
			expect(calls.enqueue).not.toHaveBeenCalled();
			expect(calls.prepareHeaders).not.toHaveBeenCalled();
			expect(calls.buildUrl).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("admits the exact 32 MiB body at the production boundary and rejects one additional byte", async () => {
		const calls = makeAdmissionCalls();
		const account = makeAccount();
		calls.getAllAccounts.mockResolvedValue([account]);
		calls.select.mockImplementation((accounts) => accounts);
		const usageCollectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => undefined),
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		} as never);
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", content: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const prefix =
			'{"model":"claude-opus-5","messages":[{"role":"user","content":"';
		const suffix = '"}],"max_tokens":1}';
		const paddingLength =
			MAX_REQUEST_BODY_BYTES -
			new TextEncoder().encode(prefix + suffix).byteLength;

		const sendPaddedRequest = async (extraBytes: number): Promise<Response> => {
			const request = new Request("https://proxy.test/v1/messages", {
				method: "POST",
				headers: { "anthropic-version": "2023-06-01" },
				body: `${prefix}${"x".repeat(paddingLength + extraBytes)}${suffix}`,
			});
			return handleProxy(request, new URL(request.url), makeContext(calls));
		};

		try {
			expect((await sendPaddedRequest(0)).status).toBe(200);
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			expect((await sendPaddedRequest(1)).status).toBe(413);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.fetch = originalFetch;
			usageCollectorSpy.mockRestore();
		}
	});

	it("returns 413 for streamed overflow before parsing, selection, persistence, or provider work", async () => {
		const calls = makeAdmissionCalls();
		const request = new Request("https://proxy.test/v1/messages", {
			method: "POST",
			headers: { "anthropic-version": "2023-06-01" },
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
				},
			}),
		});
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(async () => new Response("unexpected upstream call"));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		try {
			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(calls),
			);

			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "request_too_large",
					message: "Request body exceeds the 32 MiB limit.",
				},
			});
			expect(calls.canHandle).toHaveBeenCalledTimes(1);
			expect(calls.verifyGuardCorrelation).not.toHaveBeenCalled();
			expect(calls.select).not.toHaveBeenCalled();
			expect(calls.getAllAccounts).not.toHaveBeenCalled();
			expect(calls.enqueue).not.toHaveBeenCalled();
			expect(calls.prepareHeaders).not.toHaveBeenCalled();
			expect(calls.buildUrl).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
