import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	getPreTransportDeadlineConfig,
	PRE_TRANSPORT_ACCOUNT_SELECTION_TIMEOUT_ENV,
	PRE_TRANSPORT_AGENT_INTERCEPTION_TIMEOUT_ENV,
	PRE_TRANSPORT_CREDENTIAL_RESOLUTION_TIMEOUT_ENV,
	PRE_TRANSPORT_MAX_ACCOUNT_SELECTION_TIMEOUT_MS,
	PRE_TRANSPORT_MAX_AGENT_INTERCEPTION_TIMEOUT_MS,
	PRE_TRANSPORT_MAX_CREDENTIAL_RESOLUTION_TIMEOUT_MS,
	PreTransportPhaseTimeoutError,
	runWithPreTransportDeadline,
} from "../pre-transport-deadline";
import type { UsageCollector } from "../usage-collector";

// Loading proxy.ts in a focused unit test must not require ignored embedded
// worker artifacts from the CLI build.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const usageCollectorModule = await import("../usage-collector");
const modelCatalogModule = await import("../model-catalog");
const { handleProxy } = await import("../proxy");

const MODEL = "claude-opus-4-8";
const DEADLINE_ENVS = [
	PRE_TRANSPORT_AGENT_INTERCEPTION_TIMEOUT_ENV,
	PRE_TRANSPORT_ACCOUNT_SELECTION_TIMEOUT_ENV,
	PRE_TRANSPORT_CREDENTIAL_RESOLUTION_TIMEOUT_ENV,
] as const;
const originalEnv = new Map(
	DEADLINE_ENVS.map((name) => [name, process.env[name]] as const),
);
const originalFetch = globalThis.fetch;
let restoreUsageCollector = (): void => {};

function makeAccount(id: string, options: { oauth?: boolean } = {}): Account {
	return {
		id,
		name: `private-name-${id}`,
		provider: "anthropic",
		api_key: options.oauth ? null : `key-${id}`,
		refresh_token: options.oauth ? `refresh-${id}` : null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
	};
}

function makeContext(accounts: Account[]) {
	const reportCandidateFailure = mock(
		(
			_meta: RequestMeta,
			_failure: { candidateId: string; reason: string; suppressForMs: number },
		) => undefined,
	);
	const pauseAccount = mock(async () => undefined);
	const refreshInFlight = new Map<string, Promise<string>>();
	const ctx = {
		strategy: {
			select: mock(async (selected: Account[]) => selected),
			peek: mock(() => accounts[0]?.id ?? null),
			reportCandidateFailure,
			reportCandidateSuccess: mock(() => undefined),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
			pauseAccount,
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
			name: "anthropic",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string, account: Account) =>
				`https://upstream.test/${account.id}`,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
		},
		refreshInFlight,
		asyncWriter: { enqueue: mock(() => undefined) },
	} as unknown as ProxyContext;
	return { ctx, pauseAccount, refreshInFlight, reportCandidateFailure };
}

function makeRequest(
	options: { signal?: AbortSignal; agentId?: string } = {},
): Request {
	const headers = new Headers({
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	});
	if (options.agentId) {
		headers.set("x-better-ccflare-agent-id", options.agentId);
	}
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
			stream: false,
		}),
		signal: options.signal,
	});
}

beforeEach(() => {
	process.env[PRE_TRANSPORT_AGENT_INTERCEPTION_TIMEOUT_ENV] = "5";
	process.env[PRE_TRANSPORT_ACCOUNT_SELECTION_TIMEOUT_ENV] = "5";
	process.env[PRE_TRANSPORT_CREDENTIAL_RESOLUTION_TIMEOUT_ENV] = "5";
	const collectorSpy = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue({
		handleStart: mock(() => undefined),
		handleChunk: mock(() => undefined),
		handleEnd: mock(async () => undefined),
	} as unknown as UsageCollector);
	restoreUsageCollector = () => collectorSpy.mockRestore();
});

afterEach(() => {
	restoreUsageCollector();
	restoreUsageCollector = (): void => {};
	globalThis.fetch = originalFetch;
	for (const [name, value] of originalEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("pre-transport deadline primitive", () => {
	it("clamps operator overrides to hard phase-specific maxima", () => {
		process.env[PRE_TRANSPORT_AGENT_INTERCEPTION_TIMEOUT_ENV] = "999999";
		process.env[PRE_TRANSPORT_ACCOUNT_SELECTION_TIMEOUT_ENV] = "999999";
		process.env[PRE_TRANSPORT_CREDENTIAL_RESOLUTION_TIMEOUT_ENV] = "999999";

		expect(getPreTransportDeadlineConfig()).toEqual({
			agentInterceptionTimeoutMs:
				PRE_TRANSPORT_MAX_AGENT_INTERCEPTION_TIMEOUT_MS,
			accountSelectionTimeoutMs: PRE_TRANSPORT_MAX_ACCOUNT_SELECTION_TIMEOUT_MS,
			credentialResolutionTimeoutMs:
				PRE_TRANSPORT_MAX_CREDENTIAL_RESOLUTION_TIMEOUT_MS,
		});
	});

	it("emits only fixed sanitized phase telemetry on slow timeout", async () => {
		const events: unknown[] = [];
		const outcome = runWithPreTransportDeadline({
			phase: "credential_resolution",
			timeoutMs: 10,
			operation: () => new Promise<string>(() => undefined),
			onEvent: (event) => events.push(event),
		});

		await expect(outcome).rejects.toBeInstanceOf(PreTransportPhaseTimeoutError);
		expect(events).toHaveLength(2);
		expect(events.map((event) => (event as { kind: string }).kind)).toEqual([
			"slow",
			"timeout",
		]);
		for (const event of events) {
			expect(Object.keys(event as object).sort()).toEqual([
				"elapsedMs",
				"kind",
				"phase",
				"timeoutMs",
			]);
			expect((event as { phase: string }).phase).toBe("credential_resolution");
		}
	});

	it("clears both timers and the abort listener when the caller aborts", async () => {
		const controller = new AbortController();
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
		const removeListenerSpy = spyOn(controller.signal, "removeEventListener");
		const outcome = runWithPreTransportDeadline({
			phase: "account_selection",
			timeoutMs: 10_000,
			signal: controller.signal,
			operation: () => new Promise<string>(() => undefined),
		});

		controller.abort(new DOMException("caller left", "AbortError"));
		await expect(outcome).rejects.toHaveProperty("name", "AbortError");
		expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(removeListenerSpy).toHaveBeenCalledTimes(1);
		clearTimeoutSpy.mockRestore();
		removeListenerSpy.mockRestore();
	});
});

describe("proxy pre-transport recovery", () => {
	it("preserves a fast successful agent rewrite in the transported body", async () => {
		const account = makeAccount("agent-rewrite");
		const { ctx } = makeContext([account]);
		const catalog = await modelCatalogModule.getModelCatalog();
		const preferredModel = catalog.models.find(
			(entry) => entry.id !== MODEL,
		)?.id;
		expect(preferredModel).toBeDefined();
		ctx.dbOps.getAgentPreference = mock(async () => ({
			model: preferredModel ?? MODEL,
		}));
		const fetchedModels: string[] = [];
		globalThis.fetch = mock(async (request: Request) => {
			fetchedModels.push(((await request.json()) as { model: string }).model);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = makeRequest({ agentId: "fast-agent" });
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(fetchedModels).toEqual([preferredModel]);
	});

	it("fails open to the original request when agent interception hangs", async () => {
		const account = makeAccount("agent-fallback");
		const { ctx } = makeContext([account]);
		let resolvePreference!: (value: { model: string }) => void;
		ctx.dbOps.getAgentPreference = mock(
			() =>
				new Promise((resolve) => {
					resolvePreference = resolve;
				}),
		);
		const fetchedModels: string[] = [];
		globalThis.fetch = mock(async (request: Request) => {
			fetchedModels.push(((await request.json()) as { model: string }).model);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = makeRequest({ agentId: "private-agent-name" });
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(fetchedModels).toEqual([MODEL]);
		resolvePreference({ model: MODEL });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fetchedModels).toEqual([MODEL]);
	});

	it("returns a stable retryable route-unavailable response when selection hangs", async () => {
		const account = makeAccount("selection-private");
		const { ctx } = makeContext([account]);
		ctx.strategy.select = mock(() => new Promise<Account[]>(() => undefined));
		const providerFetch = mock(async () => new Response("must not fetch"));
		globalThis.fetch = providerFetch as unknown as typeof fetch;

		const request = makeRequest();
		const startedAt = Date.now();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as {
			error: { code: string; message: string; accounts: unknown[] };
		};

		expect(Date.now() - startedAt).toBeLessThan(100);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(payload.error.code).toBe("route_unavailable");
		expect(payload.error.accounts).toEqual([]);
		expect(JSON.stringify(payload)).not.toContain(account.name);
		expect(providerFetch).not.toHaveBeenCalled();
	});

	it("skips a credential timeout, fetches only the next candidate, and ignores late resolution", async () => {
		const first = makeAccount("credential-hang", { oauth: true });
		const second = makeAccount("credential-winner");
		const { ctx, pauseAccount, refreshInFlight, reportCandidateFailure } =
			makeContext([first, second]);
		let resolveLateCredential!: (token: string) => void;
		refreshInFlight.set(
			first.id,
			new Promise((resolve) => {
				resolveLateCredential = resolve;
			}),
		);
		const fetchedCredentialMarkers: Array<string | null> = [];
		globalThis.fetch = mock(async (request: Request) => {
			fetchedCredentialMarkers.push(request.headers.get("x-api-key"));
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const request = makeRequest();
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(response.status).toBe(200);
		expect(fetchedCredentialMarkers).toEqual([second.api_key]);
		expect(pauseAccount).not.toHaveBeenCalled();
		expect(reportCandidateFailure).not.toHaveBeenCalled();
		resolveLateCredential("late-secret-token");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fetchedCredentialMarkers).toEqual([second.api_key]);
	});

	it("bounds all hanging credential phases to no-route without issuing a fetch", async () => {
		const first = makeAccount("all-hang-a", { oauth: true });
		const second = makeAccount("all-hang-b", { oauth: true });
		const { ctx, pauseAccount, refreshInFlight, reportCandidateFailure } =
			makeContext([first, second]);
		refreshInFlight.set(first.id, new Promise(() => undefined));
		refreshInFlight.set(second.id, new Promise(() => undefined));
		const providerFetch = mock(async () => new Response("must not fetch"));
		globalThis.fetch = providerFetch as unknown as typeof fetch;

		const request = makeRequest();
		const startedAt = Date.now();
		const response = await handleProxy(request, new URL(request.url), ctx);
		const payload = (await response.json()) as { error: { code: string } };

		expect(Date.now() - startedAt).toBeLessThan(100);
		expect(response.status).toBe(503);
		expect(payload.error.code).toBe("route_unavailable");
		expect(providerFetch).not.toHaveBeenCalled();
		expect(pauseAccount).not.toHaveBeenCalled();
		expect(reportCandidateFailure).not.toHaveBeenCalled();
	});
});
