import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { ANTHROPIC_DEGRADED_MODE_DEFAULTS } from "@better-ccflare/config";
import type {
	Account,
	ComboWithSlots,
	RequestMeta,
} from "@better-ccflare/types";
import {
	AnthropicDegradedModeCoordinator,
	buildAnthropicDegradedCohortKey,
	classifyAnthropicReplayRisk,
} from "../anthropic-degraded-mode";
import { DegradedModeObservability } from "../anthropic-degraded-observability";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers/proxy-types";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";

// Loading proxy-operations in a focused test must not require ignored embedded
// database worker artifacts from the packaged CLI build.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const usageCollectorModule = await import("../usage-collector");
spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
	handleStart: mock(() => undefined),
	handleChunk: mock(() => undefined),
	handleEnd: mock(async () => undefined),
} as unknown as usageCollectorModule.UsageCollector);

const { isAnthropicDegradedSendDenied, proxyWithAccount } = await import(
	"../handlers/proxy-operations"
);
const { deriveAffinityLaneKey } = await import("../handlers/account-selector");
const { handleProxy } = await import("../proxy");

const OVERLOAD_BODY =
	'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const EXTRA_USAGE_MESSAGE =
	"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";
const SEMANTIC_OVERLOAD = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: error",
	'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
	"",
	"",
].join("\n");
const SEMANTIC_API_ERROR = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: error",
	'data: {"type":"error","error":{"type":"api_error","message":"temporary upstream failure"}}',
	"",
	"",
].join("\n");

function makeAccount(id: string): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "oauth-refresh-token",
		access_token: "oauth-access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1_000,
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
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "large-request",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeContext(
	coordinator: AnthropicDegradedModeCoordinator,
): ProxyContext {
	return {
		strategy: { select: async (accounts: Account[]) => accounts } as never,
		anthropicDegradedMode: coordinator,
		anthropicDegradedObservability: new DegradedModeObservability({
			mode: coordinator.config.mode,
			largeRequestTokenThreshold: coordinator.config.largeRequestTokenThreshold,
			largeRequestByteThreshold: coordinator.config.largeRequestByteThreshold,
		}),
		degradedOwnerOverlay: new DegradedOwnerOverlay(),
		degradedOwnerShadowOverlay: new DegradedOwnerOverlay(),
		serverToolReplay: Object.freeze({ status: "disabled" }),
		dbOps: {
			markAccountRateLimited: mock(async () => ({
				consecutiveRateLimits: 1,
				applied: true,
			})),
			saveRequest: mock(async () => undefined),
			updateAccountUsage: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: { getStorePayloads: () => false } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: (headers: Headers) => new Headers(headers),
			transformRequestBody: undefined,
			processResponse: async (response: Response) => response,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: (response: Response) =>
				response.headers
					.get("content-type")
					?.toLowerCase()
					.includes("text/event-stream") === true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => true) } as never,
	};
}

function makeEmptyPoolContext(
	coordinator: AnthropicDegradedModeCoordinator,
): ProxyContext {
	return {
		...makeContext(coordinator),
		strategy: { select: async () => [] } as never,
		dbOps: {
			getAllAccounts: mock(async () => []),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		} as never,
	};
}

function makeCohortKey(
	model = "claude-opus-4-6",
	endpoint = "https://api.anthropic.com",
) {
	const cohortKey = buildAnthropicDegradedCohortKey({
		provider: "anthropic",
		endpoint,
		path: "/v1/messages",
		protocol: "messages",
		model,
		betaSignature: "oauth-2025-04-20",
	});
	if (cohortKey === null) throw new Error("expected canonical cohort");
	return cohortKey;
}

function makeLargeBody(
	coordinator: AnthropicDegradedModeCoordinator,
	model = "claude-opus-4-6",
) {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "large" }],
			max_tokens: 16,
			_admission_padding: "x".repeat(
				coordinator.config.largeRequestByteThreshold,
			),
		}),
	);
}

function openCohort(
	coordinator: AnthropicDegradedModeCoordinator,
	cohortKey: ReturnType<typeof makeCohortKey>,
	retryAfter = "30",
): void {
	for (const accountId of ["evidence-a", "evidence-b"]) {
		coordinator.observeTrustedOverload({
			cohortKey,
			accountId,
			outcome: "http_529",
			phase: "pre_commit",
			forceRouted: false,
			retryAfter,
		});
	}
	expect(coordinator.getCohortState(cohortKey).state).toBe("open");
}

function makeRoutedContext(
	coordinator: AnthropicDegradedModeCoordinator,
	accounts: Account[],
	strategy: {
		select: (
			accounts: Account[],
			meta: RequestMeta,
		) => Account[] | Promise<Account[]>;
		snapshotAffinityOwner?: (
			meta: RequestMeta,
		) => NonNullable<RequestMeta["affinityOwnerSnapshot"]> | null;
	},
): ProxyContext {
	const base = makeContext(coordinator);
	return {
		...base,
		strategy: {
			...strategy,
			reportCandidateFailure: mock(() => undefined),
			reportCandidateSuccess: mock(() => undefined),
		} as never,
		dbOps: {
			...(base.dbOps as object),
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
		} as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		} as never,
	};
}

function makeLargeHandleRequest(
	coordinator: AnthropicDegradedModeCoordinator,
	options: { forceAccountId?: string; session?: string } = {},
): Request {
	const headers = new Headers({
		"anthropic-version": "2023-06-01",
		"content-type": "application/json",
	});
	if (options.forceAccountId !== undefined) {
		headers.set("x-better-ccflare-account-id", options.forceAccountId);
	}
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: "claude-opus-4-6",
			messages: [
				{
					role: "user",
					content: "x".repeat(coordinator.config.largeRequestByteThreshold),
				},
			],
			metadata: { user_id: options.session ?? "degraded-routing-session" },
			max_tokens: 16,
		}),
	});
}

describe("Anthropic degraded-mode physical-send admission", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	});

	it("observes the second-account 529 before denying its in-place resend without draining the trusted response", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		expect(cohortKey).not.toBeNull();
		if (cohortKey === null) throw new Error("expected canonical cohort");

		expect(
			coordinator.observeTrustedOverload({
				cohortKey,
				accountId: "account-b",
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
			}),
		).toMatchObject({ kind: "recorded", distinctAccounts: 1 });

		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "large" }],
				max_tokens: 16,
			}),
		);
		const risk = classifyAnthropicReplayRisk({
			body,
			estimateInputTokens: () => coordinator.config.largeRequestTokenThreshold,
			config: coordinator.config,
		});
		const admission = coordinator.createRequestAdmission({
			cohortKey,
			risk,
			ownerAccountId: null,
			forceRouted: false,
		});

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const account = makeAccount("account-a");
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			account,
			makeRequestMeta(),
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			admission,
		);

		expect(fetchCount).toBe(1);
		expect(isAnthropicDegradedSendDenied(result)).toBe(true);
		if (!isAnthropicDegradedSendDenied(result)) {
			throw new Error("expected a typed degraded-mode denial");
		}
		expect(result.decision.action).toBe("suppress");
		expect(result.retainedTrustedResponse?.status).toBe(529);
		expect(await result.retainedTrustedResponse?.text()).toBe(OVERLOAD_BODY);
	});

	it("observes a semantic pre-commit overload before the next account can send", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		coordinator.observeTrustedOverload({
			cohortKey,
			accountId: "account-b",
			outcome: "http_529",
			phase: "pre_commit",
			forceRouted: false,
		});

		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "large" }],
				max_tokens: 16,
				stream: true,
			}),
		);
		const admission = coordinator.createRequestAdmission({
			cohortKey,
			risk: classifyAnthropicReplayRisk({
				body,
				estimateInputTokens: () =>
					coordinator.config.largeRequestTokenThreshold,
				config: coordinator.config,
			}),
			ownerAccountId: null,
			forceRouted: false,
		});
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		const ledger = new RoutingAttemptLedger();
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(SEMANTIC_OVERLOAD, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const firstResult = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("account-a"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			undefined,
			admission,
		);
		expect(firstResult).toBeNull();
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");

		const secondResult = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("account-c"),
			requestMeta,
			body.buffer,
			() => undefined,
			1,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
			undefined,
			admission,
		);

		expect(fetchCount).toBe(1);
		expect(isAnthropicDegradedSendDenied(secondResult)).toBe(true);
	});

	it("elects exactly one physical recovery send across ten concurrent large requests", async () => {
		let now = 10_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		for (const accountId of ["evidence-a", "evidence-b"]) {
			coordinator.observeTrustedOverload({
				cohortKey,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
				retryAfter: "1",
			});
		}
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "large" }],
				max_tokens: 16,
			}),
		);
		const risk = classifyAnthropicReplayRisk({
			body,
			estimateInputTokens: () => coordinator.config.largeRequestTokenThreshold,
			config: coordinator.config,
		});
		const account = makeAccount("recovery-owner");
		const ctx = makeContext(coordinator);
		let fetchCount = 0;
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			await fetchGate;
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const attempts = Array.from({ length: 10 }, async (_, index) => {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			const meta = makeRequestMeta();
			meta.id = `large-request-${index}`;
			return proxyWithAccount(
				request,
				new URL(request.url),
				account,
				meta,
				body.buffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				new RoutingAttemptLedger(),
				undefined,
				coordinator.createRequestAdmission({
					cohortKey,
					risk,
					ownerAccountId: null,
					forceRouted: false,
				}),
			);
		});

		for (let spin = 0; spin < 20 && fetchCount === 0; spin++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		expect(fetchCount).toBe(1);
		expect(coordinator.getCohortState(cohortKey).state).toBe("probing");
		releaseFetch?.();
		const results = await Promise.all(attempts);

		expect(fetchCount).toBe(1);
		expect(results.filter(isAnthropicDegradedSendDenied)).toHaveLength(9);
		expect(results.filter((result) => result instanceof Response)).toHaveLength(
			1,
		);
	});

	it("shares one protected-send budget across different physical cohort keys", () => {
		let now = 12_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const opusKey = makeCohortKey("claude-opus-4-6");
		const sonnetKey = makeCohortKey("claude-sonnet-4-6");
		openCohort(coordinator, opusKey, "1");
		openCohort(coordinator, sonnetKey, "1");
		const opusState = coordinator.getCohortState(opusKey);
		const sonnetState = coordinator.getCohortState(sonnetKey);
		if (opusState.state !== "open" || sonnetState.state !== "open") {
			throw new Error("expected open physical cohorts");
		}
		now = Math.max(opusState.nextProbeAt, sonnetState.nextProbeAt);
		const body = makeLargeBody(coordinator);
		const admission = coordinator.createRequestAdmission({
			cohortKey: opusKey,
			risk: classifyAnthropicReplayRisk({
				body,
				config: coordinator.config,
			}),
			ownerAccountId: null,
			forceRouted: false,
		});

		const first = admission.reserve("shared-owner", opusKey);
		const second = admission.reserve("shared-owner", sonnetKey);

		expect(first).toMatchObject({
			action: "send",
			reservation: "reserved",
		});
		expect(second).toMatchObject({
			action: "suppress",
			reason: "request_budget_spent",
		});
		expect(coordinator.getCohortState(sonnetKey).state).toBe("open");
	});

	it("leaves a small request's existing in-place failover behavior unchanged", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		for (const accountId of ["evidence-a", "evidence-b"]) {
			coordinator.observeTrustedOverload({
				cohortKey,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
			});
		}
		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "small" }],
				max_tokens: 16,
			}),
		);
		const risk = classifyAnthropicReplayRisk({
			body,
			estimateInputTokens: () => 1,
			config: coordinator.config,
		});
		expect(risk.kind).toBe("small");
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return fetchCount === 1
				? new Response(OVERLOAD_BODY, {
						status: 529,
						headers: { "content-type": "application/json" },
					})
				: new Response('{"ok":true}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
		}) as unknown as typeof fetch;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("small-request-account"),
			makeRequestMeta(),
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk,
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(2);
		expect(result).toBeInstanceOf(Response);
		expect(result instanceof Response ? result.status : null).toBe(200);
	});

	it("excludes force-routed overload evidence but still suppresses a protected force route", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "1";
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "large" }],
				max_tokens: 16,
			}),
		);
		const risk = classifyAnthropicReplayRisk({
			body,
			estimateInputTokens: () => coordinator.config.largeRequestTokenThreshold,
			config: coordinator.config,
		});
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		for (const accountId of ["forced-a", "forced-b"]) {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			await proxyWithAccount(
				request,
				new URL(request.url),
				makeAccount(accountId),
				makeRequestMeta(),
				body.buffer,
				() => undefined,
				0,
				makeContext(coordinator),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				new RoutingAttemptLedger(),
				undefined,
				coordinator.createRequestAdmission({
					cohortKey,
					risk,
					ownerAccountId: null,
					forceRouted: true,
				}),
			);
		}
		expect(fetchCount).toBe(2);
		expect(coordinator.snapshot().retainedCohorts).toBe(0);

		for (const accountId of ["evidence-a", "evidence-b"]) {
			coordinator.observeTrustedOverload({
				cohortKey,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
			});
		}
		const protectedRequest = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		const protectedResult = await proxyWithAccount(
			protectedRequest,
			new URL(protectedRequest.url),
			makeAccount("forced-c"),
			makeRequestMeta(),
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk,
				ownerAccountId: null,
				forceRouted: true,
			}),
		);

		expect(fetchCount).toBe(2);
		expect(isAnthropicDegradedSendDenied(protectedResult)).toBe(true);
	});

	it("does not let a synthetic provider response consume the recovery lease", async () => {
		let now = 25_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		for (const accountId of ["evidence-a", "evidence-b"]) {
			coordinator.observeTrustedOverload({
				cohortKey,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
				retryAfter: "1",
			});
		}
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const body = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "large" }],
				max_tokens: 16,
			}),
		);
		const risk = classifyAnthropicReplayRisk({
			body,
			estimateInputTokens: () => coordinator.config.largeRequestTokenThreshold,
			config: coordinator.config,
		});
		const ctx = makeContext(coordinator);
		(
			ctx.provider as {
				transformRequestBody: (request: Request) => Promise<Request>;
			}
		).transformRequestBody = async (request) =>
			new Request("https://better-ccflare.local/synthetic", {
				method: request.method,
				headers: {
					...Object.fromEntries(request.headers.entries()),
					"x-better-ccflare-synthetic-response": "true",
					"x-better-ccflare-synthetic-status": "200",
				},
				body: await request.clone().arrayBuffer(),
			});
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(null, { status: 500 });
		}) as unknown as typeof fetch;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			{
				...makeAccount("synthetic-account"),
				// Unregistered provider names deliberately fall back to ctx.provider,
				// allowing this fixture to exercise its synthetic transform.
				provider: "test-provider",
			} as Account,
			makeRequestMeta(),
			body.buffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk,
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(0);
		expect(result).toBeInstanceOf(Response);
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("denies matching large empty-pool passthrough without claiming a probe or fetching", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		for (const accountId of ["evidence-a", "evidence-b"]) {
			coordinator.observeTrustedOverload({
				cohortKey,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
				retryAfter: "30",
			});
		}
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");

		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"unexpected":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-opus-4-6",
				messages: [
					{
						role: "user",
						content: "x".repeat(coordinator.config.largeRequestByteThreshold),
					},
				],
				max_tokens: 16,
			}),
		});

		const ctx = makeEmptyPoolContext(coordinator);
		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(fetchCount).toBe(0);
		expect(response.status).toBe(529);
		expect(response.headers.get("retry-after")).not.toBeNull();
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "overloaded_error",
				message: "Overloaded",
			},
		});
		expect(ctx.anthropicDegradedObservability.snapshot()).toMatchObject({
			logicalRequests: 1,
			physicalAttempts: 0,
			terminalRequests: 1,
			terminalSuppressed: 1,
		});
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
		expect(coordinator.snapshot()).toMatchObject({
			retainedCohorts: 1,
			openCohorts: 1,
			probingCohorts: 0,
			activeProbes: 0,
		});
	});

	it("denies pre-existing probing and recovering empty-pool cohorts without mutating them", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"unexpected":true}', { status: 200 });
		}) as unknown as typeof fetch;

		for (const targetState of ["probing", "recovering"] as const) {
			let now = Date.now();
			const coordinator = new AnthropicDegradedModeCoordinator({
				config: {
					...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
					mode: "enforce",
					largeRequestByteThreshold: 64 * 1024,
				},
				now: () => now,
			});
			const cohortKey = buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "https://api.anthropic.com",
				path: "/v1/messages",
				protocol: "messages",
				model: "claude-opus-4-6",
				betaSignature: "oauth-2025-04-20",
			});
			if (cohortKey === null) throw new Error("expected canonical cohort");
			for (const accountId of ["evidence-a", "evidence-b"]) {
				coordinator.observeTrustedOverload({
					cohortKey,
					accountId,
					outcome: "http_529",
					phase: "pre_commit",
					forceRouted: false,
					retryAfter: "1",
				});
			}
			const openState = coordinator.getCohortState(cohortKey);
			if (openState.state !== "open") throw new Error("expected open cohort");
			now = openState.nextProbeAt;
			const admission = coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body: new Uint8Array(coordinator.config.largeRequestByteThreshold),
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			});
			const decision = admission.reserve("probe-owner");
			if (decision.action !== "send") {
				throw new Error("expected recovery probe reservation");
			}
			if (targetState === "recovering") {
				expect(decision.permit.commit()).toBe(true);
				expect(decision.permit.complete("success")).toBe(true);
			}
			expect(coordinator.getCohortState(cohortKey).state).toBe(targetState);
			const stateBefore = coordinator.getCohortState(cohortKey);
			const snapshotBefore = coordinator.snapshot();
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-opus-4-6",
					messages: [
						{
							role: "user",
							content: "x".repeat(coordinator.config.largeRequestByteThreshold),
						},
					],
					max_tokens: 16,
				}),
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				makeEmptyPoolContext(coordinator),
			);

			expect(response.status).toBe(529);
			expect(coordinator.getCohortState(cohortKey)).toEqual(stateBefore);
			expect(coordinator.snapshot()).toEqual(snapshotBefore);
		}
		expect(fetchCount).toBe(0);
	});

	it("does not let an unauthenticated 529 establish degraded-mode quorum", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		coordinator.observeTrustedOverload({
			cohortKey,
			accountId: "single-authenticated-evidence",
			outcome: "http_529",
			phase: "pre_commit",
			forceRouted: false,
		});
		expect(coordinator.getCohortState(cohortKey)).toMatchObject({
			state: "collecting",
			distinctAccounts: 1,
		});

		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-opus-4-6",
				messages: [
					{
						role: "user",
						content: "x".repeat(coordinator.config.largeRequestByteThreshold),
					},
				],
				max_tokens: 16,
			}),
		});

		const response = await handleProxy(
			request,
			new URL(request.url),
			makeEmptyPoolContext(coordinator),
		);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(529);
		expect(await response.text()).toBe(OVERLOAD_BODY);
		expect(coordinator.getCohortState(cohortKey)).toMatchObject({
			state: "collecting",
			distinctAccounts: 1,
		});
		expect(coordinator.snapshot()).toMatchObject({
			retainedCohorts: 1,
			collectingCohorts: 1,
			openCohorts: 0,
			activeProbes: 0,
		});
	});

	it("keeps closed, off-mode, and small empty-pool passthrough behavior unchanged", async () => {
		const makeCoordinator = (mode: "off" | "enforce") =>
			new AnthropicDegradedModeCoordinator({
				config: {
					...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
					mode,
					largeRequestByteThreshold: 64 * 1024,
				},
			});
		const closedCoordinator = makeCoordinator("enforce");
		const offCoordinator = makeCoordinator("off");
		const openSmallCoordinator = makeCoordinator("enforce");
		const cohortKey = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (cohortKey === null) throw new Error("expected canonical cohort");
		for (const accountId of ["evidence-a", "evidence-b"]) {
			openSmallCoordinator.observeTrustedOverload({
				cohortKey,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
			});
		}

		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		const largeContent = "x".repeat(64 * 1024);
		for (const testCase of [
			{
				label: "closed-large",
				coordinator: closedCoordinator,
				content: largeContent,
			},
			{
				label: "off-large",
				coordinator: offCoordinator,
				content: largeContent,
			},
			{
				label: "open-small",
				coordinator: openSmallCoordinator,
				content: "small",
			},
		]) {
			let fetchCount = 0;
			globalThis.fetch = mock(async () => {
				fetchCount += 1;
				return new Response(JSON.stringify({ label: testCase.label }), {
					status: 202,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-opus-4-6",
					messages: [{ role: "user", content: testCase.content }],
					max_tokens: 16,
				}),
			});

			const ctx = makeEmptyPoolContext(testCase.coordinator);
			const response = await handleProxy(request, new URL(request.url), ctx);

			expect({
				label: testCase.label,
				fetchCount,
				status: response.status,
				body: await response.json(),
			}).toEqual({
				label: testCase.label,
				fetchCount: 1,
				status: 202,
				body: { label: testCase.label },
			});
			if (testCase.label === "off-large") {
				expect(ctx.anthropicDegradedObservability.snapshot()).toMatchObject({
					logicalRequests: 0,
					physicalAttempts: 0,
					terminalRequests: 0,
				});
			}
		}
		expect(openSmallCoordinator.getCohortState(cohortKey).state).toBe("open");
		expect(openSmallCoordinator.snapshot().activeProbes).toBe(0);
	});

	it("binds admission ownership to the selector's validated retained owner", async () => {
		let now = 75_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const accountA = {
			...makeAccount("stale-owner"),
			access_token: "oauth-access-stale-owner",
		};
		const accountB = {
			...makeAccount("retained-owner"),
			access_token: "oauth-access-retained-owner",
		};
		const session = "validated-owner-session";
		const request = makeLargeHandleRequest(coordinator, { session });
		const laneMeta = makeRequestMeta();
		laneMeta.headers = request.headers;
		laneMeta.clientSessionId = session;
		const laneKey = deriveAffinityLaneKey(laneMeta, "claude-opus-4-6");
		if (laneKey === null) throw new Error("expected affinity lane");
		const overlay = new DegradedOwnerOverlay();
		overlay.retainQualifyingOwner({
			laneKey,
			cohortKey,
			owner: {
				candidateId: `account:${accountB.id}`,
				accountId: accountB.id,
			},
		});
		let selectedDirectiveOwner: string | null = null;
		const ctx = makeRoutedContext(coordinator, [accountA, accountB], {
			snapshotAffinityOwner: () => ({
				candidateId: `account:${accountA.id}`,
				accountId: accountA.id,
			}),
			select: async (accounts, meta) => {
				selectedDirectiveOwner =
					meta.affinityOwnerDirective?.kind === "retain-owner"
						? meta.affinityOwnerDirective.owner.accountId
						: null;
				return [...accounts].sort((left, right) => {
					if (left.id === selectedDirectiveOwner) return -1;
					if (right.id === selectedDirectiveOwner) return 1;
					return 0;
				});
			},
		});
		ctx.degradedOwnerOverlay = overlay;
		let fetchCount = 0;
		let authorization: string | null = null;
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			fetchCount += 1;
			authorization =
				input instanceof Request ? input.headers.get("authorization") : null;
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(selectedDirectiveOwner).toBe(accountB.id);
		expect(fetchCount).toBe(1);
		expect(authorization).toBe(`Bearer ${accountB.access_token}`);
		expect(response.status).toBe(200);
	});

	it("binds a retained owner discovered only after combo exhaustion before fallback admission", async () => {
		let now = 85_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const comboAccount: Account = {
			...makeAccount("combo-api-key"),
			api_key: "combo-api-key",
			access_token: "combo-access-token",
		};
		const retainedOwner: Account = {
			...makeAccount("late-retained-owner"),
			rate_limited_until: Date.now() + 60_000,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		};
		const fallbackAccount = makeAccount("late-owner-fallback");
		const combo: ComboWithSlots = {
			id: "combo-without-native-oauth",
			name: "API key only combo",
			description: null,
			enabled: true,
			created_at: 0,
			updated_at: 0,
			slots: [
				{
					id: "api-key-slot",
					combo_id: "combo-without-native-oauth",
					account_id: comboAccount.id,
					model: "claude-opus-4-6",
					priority: 0,
					enabled: true,
				},
			],
		};
		const session = "late-owner-combo-session";
		const request = makeLargeHandleRequest(coordinator, { session });
		const laneMeta = makeRequestMeta();
		laneMeta.headers = request.headers;
		laneMeta.clientSessionId = session;
		const laneKey = deriveAffinityLaneKey(laneMeta, "claude-opus-4-6");
		if (laneKey === null) throw new Error("expected affinity lane");
		const overlay = new DegradedOwnerOverlay();
		overlay.retainQualifyingOwner({
			laneKey,
			cohortKey,
			owner: {
				candidateId: `account:${retainedOwner.id}`,
				accountId: retainedOwner.id,
			},
		});

		const selectedDirectiveOwners: Array<string | null> = [];
		const ctx = makeRoutedContext(
			coordinator,
			[comboAccount, retainedOwner, fallbackAccount],
			{
				snapshotAffinityOwner: () => ({
					candidateId: `account:${retainedOwner.id}`,
					accountId: retainedOwner.id,
				}),
				select: async (accounts, meta) => {
					selectedDirectiveOwners.push(
						meta.affinityOwnerDirective?.kind === "retain-owner"
							? meta.affinityOwnerDirective.owner.accountId
							: null,
					);
					const comboSelection =
						meta.routingCandidates?.some(
							(candidate) => candidate.comboSlotId !== null,
						) === true;
					return comboSelection
						? accounts
						: accounts.filter((account) => account.id === fallbackAccount.id);
				},
			},
		);
		ctx.degradedOwnerOverlay = overlay;
		ctx.dbOps = {
			...(ctx.dbOps as object),
			getActiveComboForFamily: mock(async () => combo),
		} as never;
		const upstreamCredentials: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const upstreamRequest =
				input instanceof Request ? input : new Request(input);
			upstreamCredentials.push(
				upstreamRequest.headers.get("x-api-key") ??
					upstreamRequest.headers.get("authorization") ??
					"missing",
			);
			if (upstreamCredentials.length === 1) {
				return new Response(
					'{"type":"error","error":{"type":"authentication_error"}}',
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const response = await handleProxy(request, new URL(request.url), ctx);

		expect(selectedDirectiveOwners).toEqual([null, retainedOwner.id]);
		expect(upstreamCredentials).toEqual(["Bearer combo-access-token"]);
		expect(response.status).toBe(529);
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
		expect(coordinator.snapshot().activeProbes).toBe(0);
	});

	it("treats an empty force-route header as normal-pool evidence while preserving resolved force routes", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "1";

		const emptyHeaderCoordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const accounts = [makeAccount("pool-a"), makeAccount("pool-b")];
		const emptyHeaderRequest = makeLargeHandleRequest(emptyHeaderCoordinator, {
			forceAccountId: "",
		});
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		await handleProxy(
			emptyHeaderRequest,
			new URL(emptyHeaderRequest.url),
			makeRoutedContext(emptyHeaderCoordinator, accounts, {
				select: async (selected) => selected,
			}),
		);

		expect(fetchCount).toBe(2);
		expect(
			emptyHeaderCoordinator.getCohortState(makeCohortKey()),
		).toMatchObject({
			state: "open",
		});

		const forcedCoordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const forcedAccounts = [makeAccount("resolved-force")];
		const forcedRequest = makeLargeHandleRequest(forcedCoordinator, {
			forceAccountId: forcedAccounts[0].id,
		});
		fetchCount = 0;
		await handleProxy(
			forcedRequest,
			new URL(forcedRequest.url),
			makeRoutedContext(forcedCoordinator, forcedAccounts, {
				select: async (selected) => selected,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(forcedCoordinator.getCohortState(makeCohortKey()).state).toBe(
			"inactive",
		);
	});

	it("keeps the real owner overlay inert for off, force-routed, and observe-only overloads", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "1";

		for (const testCase of [
			{ label: "off", mode: "off" as const, forceRouted: false },
			{ label: "forced", mode: "enforce" as const, forceRouted: true },
			{ label: "observe", mode: "observe" as const, forceRouted: false },
		]) {
			const coordinator = new AnthropicDegradedModeCoordinator({
				config: {
					...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
					mode: testCase.mode,
					largeRequestByteThreshold: 64 * 1024,
				},
			});
			const cohortKey = makeCohortKey();
			const body = makeLargeBody(coordinator);
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body,
			});
			const requestMeta = makeRequestMeta();
			requestMeta.headers = request.headers;
			requestMeta.affinityLaneKey = `lane-${testCase.label}`;
			requestMeta.affinityOwnerSnapshot = {
				candidateId: "account:owner",
				accountId: "owner",
			};
			const ctx = makeContext(coordinator);
			globalThis.fetch = mock(async () => {
				return new Response(OVERLOAD_BODY, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;

			await proxyWithAccount(
				request,
				new URL(request.url),
				makeAccount(`account-${testCase.label}`),
				requestMeta,
				body.buffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				new RoutingAttemptLedger(),
				undefined,
				coordinator.createRequestAdmission({
					cohortKey,
					risk: classifyAnthropicReplayRisk({
						body,
						config: coordinator.config,
					}),
					ownerAccountId: null,
					forceRouted: testCase.forceRouted,
				}),
			);

			expect({
				label: testCase.label,
				overlaySize: ctx.degradedOwnerOverlay.size,
			}).toEqual({
				label: testCase.label,
				overlaySize: 0,
			});
		}
	});

	it("fails open when an observe-only shadow permit expires before commit", async () => {
		let now = 50_000;
		let expireDuringPhysicalSend = false;
		let physicalClockReads = 0;
		const config = {
			...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
			mode: "observe" as const,
			largeRequestByteThreshold: 64 * 1024,
		};
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: () => {
				if (!expireDuringPhysicalSend) return now;
				physicalClockReads += 1;
				return physicalClockReads === 1 ? now : now + config.probeLeaseMs + 1;
			},
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		expireDuringPhysicalSend = true;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("observe-shadow"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		expect(result instanceof Response ? result.status : null).toBe(200);
	});

	it("fails open when observe-only reservation bookkeeping throws", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "observe",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const cohortKey = makeCohortKey();
		const body = makeLargeBody(coordinator);
		const admission = coordinator.createRequestAdmission({
			cohortKey,
			risk: classifyAnthropicReplayRisk({
				body,
				config: coordinator.config,
			}),
			ownerAccountId: null,
			forceRouted: false,
		});
		spyOn(admission, "reserve").mockImplementation(() => {
			throw new Error("shadow reservation bookkeeping failed");
		});
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("observe-bookkeeping"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			admission,
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		expect(result instanceof Response ? result.status : null).toBe(200);
	});

	it("enforces the actual physical model and endpoint cohort keys", async () => {
		for (const testCase of [
			{
				label: "model",
				account: makeAccount("physical-model"),
				modelOverride: "claude-sonnet-4-6",
				physicalModel: "claude-sonnet-4-6",
				physicalEndpoint: "https://api.anthropic.com",
			},
			{
				label: "endpoint",
				account: {
					...makeAccount("physical-endpoint"),
					custom_endpoint: "https://anthropic-variant.example",
				},
				modelOverride: undefined,
				physicalModel: "claude-opus-4-6",
				physicalEndpoint: "https://anthropic-variant.example",
			},
		]) {
			const coordinator = new AnthropicDegradedModeCoordinator({
				config: {
					...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
					mode: "enforce",
					largeRequestByteThreshold: 64 * 1024,
				},
			});
			const logicalCohortKey = makeCohortKey();
			const physicalCohortKey = makeCohortKey(
				testCase.physicalModel,
				testCase.physicalEndpoint,
			);
			openCohort(coordinator, physicalCohortKey);
			const body = makeLargeBody(coordinator);
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body,
			});
			const requestMeta = makeRequestMeta();
			requestMeta.headers = request.headers;
			let fetchCount = 0;
			globalThis.fetch = mock(async () => {
				fetchCount += 1;
				return new Response('{"unexpected":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const result = await proxyWithAccount(
				request,
				new URL(request.url),
				testCase.account,
				requestMeta,
				body.buffer,
				() => undefined,
				0,
				makeContext(coordinator),
				testCase.modelOverride,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				new RoutingAttemptLedger(),
				undefined,
				coordinator.createRequestAdmission({
					cohortKey: logicalCohortKey,
					risk: classifyAnthropicReplayRisk({
						body,
						config: coordinator.config,
					}),
					ownerAccountId: null,
					forceRouted: false,
				}),
			);

			expect({
				label: testCase.label,
				fetchCount,
				denied: isAnthropicDegradedSendDenied(result),
			}).toEqual({
				label: testCase.label,
				fetchCount: 0,
				denied: true,
			});
		}
	});

	it("uses the exact OAuth eligibility predicate at the physical send gate", async () => {
		const cohortKey = makeCohortKey();

		for (const testCase of [
			{
				label: "trimmed-empty-api-key",
				account: {
					...makeAccount("trimmed-empty-api-key"),
					api_key: "   ",
				},
				expectDenied: true,
			},
			{
				label: "trimmed-empty-refresh-token",
				account: {
					...makeAccount("trimmed-empty-refresh-token"),
					refresh_token: "   ",
				},
				expectDenied: false,
			},
		]) {
			const coordinator = new AnthropicDegradedModeCoordinator({
				config: {
					...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
					mode: "enforce",
					largeRequestByteThreshold: 64 * 1024,
				},
			});
			openCohort(coordinator, cohortKey);
			const body = makeLargeBody(coordinator);
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"anthropic-version": "2023-06-01",
					"content-type": "application/json",
				},
				body,
			});
			const requestMeta = makeRequestMeta();
			requestMeta.headers = request.headers;
			let fetchCount = 0;
			globalThis.fetch = mock(async () => {
				fetchCount += 1;
				return new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const result = await proxyWithAccount(
				request,
				new URL(request.url),
				testCase.account,
				requestMeta,
				body.buffer,
				() => undefined,
				0,
				makeContext(coordinator),
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				undefined,
				new RoutingAttemptLedger(),
				undefined,
				coordinator.createRequestAdmission({
					cohortKey,
					risk: classifyAnthropicReplayRisk({
						body,
						config: coordinator.config,
					}),
					ownerAccountId: null,
					forceRouted: false,
				}),
			);

			expect({
				label: testCase.label,
				fetchCount,
				denied: isAnthropicDegradedSendDenied(result),
			}).toEqual({
				label: testCase.label,
				fetchCount: testCase.expectDenied ? 0 : 1,
				denied: testCase.expectDenied,
			});
		}
	});

	it("claims recovery and commits an ownerless affinity only after full response consumption", async () => {
		let now = 200_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const account = makeAccount("terminal-success-owner");
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		requestMeta.affinityLaneKey = "ownerless-success-lane";
		requestMeta.affinityOwnerDirective = { kind: "defer-owner-assignment" };
		const commitAffinityOwner = mock(() => true);
		const ctx = makeContext(coordinator);
		ctx.strategy = {
			select: async (accounts: Account[]) => accounts,
			commitAffinityOwner,
		} as never;
		globalThis.fetch = mock(
			async () =>
				new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			account,
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			{ routeCandidateId: `account:${account.id}` },
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(result).toBeInstanceOf(Response);
		expect(coordinator.getCohortState(cohortKey).state).toBe("probing");
		expect(commitAffinityOwner).not.toHaveBeenCalled();
		if (!(result instanceof Response)) throw new Error("expected response");
		await result.text();
		expect(coordinator.getCohortState(cohortKey).state).toBe("recovering");
		expect(commitAffinityOwner).toHaveBeenCalledWith(requestMeta, {
			candidateId: `account:${account.id}`,
			accountId: account.id,
		});
	});

	it("moves an existing retained owner into post-recovery hold-down", async () => {
		let now = 300_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;

		const account = makeAccount("retained-terminal-owner");
		const laneKey = "retained-success-lane";
		const owner = {
			candidateId: `account:${account.id}`,
			accountId: account.id,
		};
		const overlay = new DegradedOwnerOverlay({ now: () => now });
		expect(overlay.retainQualifyingOwner({ laneKey, cohortKey, owner })).toBe(
			true,
		);
		const ctx = makeContext(coordinator);
		ctx.degradedOwnerOverlay = overlay;
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		requestMeta.affinityLaneKey = laneKey;
		requestMeta.affinityOwnerSnapshot = owner;
		requestMeta.affinityOwnerDirective = { kind: "retain-owner", owner };
		globalThis.fetch = mock(
			async () =>
				new Response('{"ok":true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			account,
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			{ routeCandidateId: owner.candidateId },
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: account.id,
				forceRouted: false,
			}),
		);

		if (!(result instanceof Response)) throw new Error("expected response");
		await result.text();
		const recovering = coordinator.getCohortState(cohortKey);
		if (recovering.state !== "recovering") {
			throw new Error("expected recovering cohort");
		}
		now = recovering.recoveringUntil + 1;
		expect(overlay.peekRetainedOwner(laneKey, cohortKey)).toEqual(owner);
	});

	it("returns one canonical terminal 529 for a protected semantic overload", async () => {
		let now = 400_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(SEMANTIC_OVERLOAD, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"set-cookie": "secret=1",
				},
			});
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("semantic-probe"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(isAnthropicDegradedSendDenied(result)).toBe(true);
		if (!isAnthropicDegradedSendDenied(result)) {
			throw new Error("expected degraded terminal");
		}
		expect(result.retainedTrustedResponse?.status).toBe(529);
		expect(
			result.retainedTrustedResponse?.headers.get("set-cookie"),
		).toBeNull();
		expect(await result.retainedTrustedResponse?.json()).toEqual({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		});
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("preserves a protected non-overload precommit SSE error without failover", async () => {
		let now = 450_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(SEMANTIC_API_ERROR, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("semantic-api-error-probe"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) throw new Error("expected response");
		expect(result.status).toBe(200);
		expect(await result.text()).toBe(SEMANTIC_API_ERROR);
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("rebuilds a protected trusted 529 with only safe client headers", async () => {
		let now = 500_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const account = makeAccount("trusted-probe");
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"retry-after": "999",
					"x-request-id": "safe-upstream-id",
					"set-cookie": "secret=1",
					authorization: "Bearer secret",
					"x-better-ccflare-guard-request-id": "internal",
					connection: "keep-alive",
				},
			});
		}) as unknown as typeof fetch;

		const request = makeLargeHandleRequest(coordinator);
		const response = await handleProxy(
			request,
			new URL(request.url),
			makeRoutedContext(coordinator, [account], {
				select: async (accounts) => accounts,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(529);
		expect(response.headers.get("content-type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(response.headers.get("x-request-id")).toBe("safe-upstream-id");
		for (const forbiddenHeader of [
			"set-cookie",
			"authorization",
			"x-better-ccflare-guard-request-id",
			"connection",
		]) {
			expect(response.headers.get(forbiddenHeader)).toBeNull();
		}
		expect(await response.text()).toBe(OVERLOAD_BODY);
	});

	it("rebuilds a retained-ledger 529 before a later protected reservation is suppressed", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const cohortKey = makeCohortKey();
		coordinator.observeTrustedOverload({
			cohortKey,
			accountId: "earlier-evidence",
			outcome: "http_529",
			phase: "pre_commit",
			forceRouted: false,
			retryAfter: "30",
		});
		expect(coordinator.getCohortState(cohortKey).state).toBe("collecting");

		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: {
					"content-type": "application/json",
					"retry-after": "30",
					"x-request-id": "retained-safe-id",
					"set-cookie": "secret=1",
					authorization: "Bearer secret",
					"x-better-ccflare-guard-request-id": "internal",
				},
			});
		}) as unknown as typeof fetch;

		const request = makeLargeHandleRequest(coordinator);
		const response = await handleProxy(
			request,
			new URL(request.url),
			makeRoutedContext(
				coordinator,
				[makeAccount("quorum-account"), makeAccount("suppressed-follower")],
				{ select: async (accounts) => accounts },
			),
		);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(529);
		expect(response.headers.get("retry-after")).toBe("30");
		expect(response.headers.get("x-request-id")).toBe("retained-safe-id");
		for (const forbiddenHeader of [
			"set-cookie",
			"authorization",
			"x-better-ccflare-guard-request-id",
		]) {
			expect(response.headers.get(forbiddenHeader)).toBeNull();
		}
		expect(await response.text()).toBe(OVERLOAD_BODY);
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("discards a retained non-529 terminal when a later protected reservation is suppressed", async () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
				largeRequestByteThreshold: 64 * 1024,
			},
		});
		const cohortKey = makeCohortKey();
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			for (const accountId of [
				"concurrent-evidence-a",
				"concurrent-evidence-b",
			]) {
				coordinator.observeTrustedOverload({
					cohortKey,
					accountId,
					outcome: "http_529",
					phase: "pre_commit",
					forceRouted: false,
					retryAfter: "30",
				});
			}
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: EXTRA_USAGE_MESSAGE,
					},
				}),
				{
					status: 400,
					headers: {
						"content-type": "application/json",
						"x-non529-terminal": "must-not-escape",
					},
				},
			);
		}) as unknown as typeof fetch;

		const request = makeLargeHandleRequest(coordinator);
		const response = await handleProxy(
			request,
			new URL(request.url),
			makeRoutedContext(
				coordinator,
				[makeAccount("retained-400"), makeAccount("suppressed-follower")],
				{ select: async (accounts) => accounts },
			),
		);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(529);
		expect(response.headers.get("x-non529-terminal")).toBeNull();
		expect(await response.json()).toEqual({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		});
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("preserves a processed 401 terminal for a committed protected probe", async () => {
		let now = 600_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		const ctx = makeContext(coordinator);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"type":"error","message":"raw auth"}', {
				status: 401,
				headers: {
					"content-type": "application/json",
					"x-auth-path": "initial",
				},
			});
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("auth-initial"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) throw new Error("expected response");
		expect(result.status).toBe(401);
		expect(result.headers.get("x-auth-path")).toBe("initial");
		await result.text();
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("preserves a model-scoped 429 instead of entering protected model fallback", async () => {
		let now = 700_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(
				'{"type":"error","error":{"type":"rate_limit_error","message":"model capacity"}}',
				{
					status: 429,
					headers: {
						"content-type": "application/json",
						"x-model-terminal": "preserved",
					},
				},
			);
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			{
				...makeAccount("model-rate-limit"),
				model_mappings: JSON.stringify({
					opus: ["claude-opus-4-6", "claude-sonnet-4-6"],
				}),
			},
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) throw new Error("expected response");
		expect(result.status).toBe(429);
		expect(result.headers.get("x-model-terminal")).toBe("preserved");
		await result.text();
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});

	it("keeps successful observe shadow probes from mutating real owner state", async () => {
		let now = 800_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "observe",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const account = makeAccount("observe-success");
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		requestMeta.affinityOwnerDirective = { kind: "defer-owner-assignment" };
		const ctx = makeContext(coordinator);
		const retainAfterRecovery = spyOn(
			ctx.degradedOwnerOverlay,
			"retainAfterRecovery",
		);
		const commitAffinityOwner = mock(() => true);
		ctx.strategy = {
			select: async (accounts: Account[]) => accounts,
			commitAffinityOwner,
		} as never;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			account,
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			{ routeCandidateId: `account:${account.id}` },
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) throw new Error("expected response");
		await result.text();
		expect(coordinator.getCohortState(cohortKey).state).toBe("recovering");
		expect(retainAfterRecovery).not.toHaveBeenCalled();
		expect(commitAffinityOwner).not.toHaveBeenCalled();
	});

	it("preserves a protected non-overload failure without a second physical send", async () => {
		let now = 900_000;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: {
				...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				mode: "enforce",
			},
			now: () => now,
		});
		const cohortKey = makeCohortKey();
		openCohort(coordinator, cohortKey, "1");
		const openState = coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		now = openState.nextProbeAt;
		const body = makeLargeBody(coordinator);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body,
		});
		const requestMeta = makeRequestMeta();
		requestMeta.headers = request.headers;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"type":"error","message":"upstream failed"}', {
				status: 500,
				headers: {
					"content-type": "application/json",
					"x-upstream-failure": "preserved",
				},
			});
		}) as unknown as typeof fetch;

		const result = await proxyWithAccount(
			request,
			new URL(request.url),
			makeAccount("failed-probe"),
			requestMeta,
			body.buffer,
			() => undefined,
			0,
			makeContext(coordinator),
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			new RoutingAttemptLedger(),
			undefined,
			coordinator.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body,
					config: coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			}),
		);

		expect(fetchCount).toBe(1);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) throw new Error("expected response");
		expect(result.status).toBe(500);
		expect(result.headers.get("x-upstream-failure")).toBe("preserved");
		expect(await result.text()).toContain("upstream failed");
		expect(fetchCount).toBe(1);
		expect(coordinator.getCohortState(cohortKey).state).toBe("open");
	});
});
