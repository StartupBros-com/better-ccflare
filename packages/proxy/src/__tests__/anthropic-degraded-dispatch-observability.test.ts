import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ANTHROPIC_DEGRADED_MODE_DEFAULTS } from "@better-ccflare/config";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	AnthropicDegradedModeCoordinator,
	buildAnthropicDegradedCohortKey,
	classifyAnthropicReplayRisk,
} from "../anthropic-degraded-mode";
import {
	type DegradedModeDiagnosticEvent,
	DegradedModeObservability,
} from "../anthropic-degraded-observability";
import { cacheBodyStore } from "../cache-body-store";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers/proxy-types";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";

const usageCollectorModule = await import("../usage-collector");
spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
	handleStart: mock(() => undefined),
	handleChunk: mock(() => undefined),
	handleEnd: mock(async () => undefined),
} as unknown as usageCollectorModule.UsageCollector);

const { proxyWithAccount } = await import("../handlers/proxy-operations");

const originalFetch = globalThis.fetch;

function makeAccount(): Account {
	return {
		id: "dispatch-account",
		name: "dispatch-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "oauth-refresh-token",
		access_token: "oauth-access-token",
		expires_at: Date.now() + 3 * 60 * 60_000,
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
		id: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeContext(
	coordinator: AnthropicDegradedModeCoordinator,
	observability: DegradedModeObservability,
): ProxyContext {
	return {
		strategy: { select: async (accounts: Account[]) => accounts } as never,
		anthropicDegradedMode: coordinator,
		anthropicDegradedObservability: observability,
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
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => true) } as never,
	};
}

function makeProtectedAttempt(events?: DegradedModeDiagnosticEvent[]) {
	let now = 0;
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
	if (cohortKey === null) throw new Error("expected cohort");
	for (const accountId of ["evidence-a", "evidence-b"]) {
		coordinator.observeTrustedOverload({
			cohortKey,
			accountId,
			outcome: "http_529",
			phase: "pre_commit",
			forceRouted: false,
		});
	}
	now = coordinator.config.retryFallbackMs;
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
	const observability = new DegradedModeObservability({
		mode: "enforce",
		largeRequestTokenThreshold: coordinator.config.largeRequestTokenThreshold,
		largeRequestByteThreshold: coordinator.config.largeRequestByteThreshold,
		detailedEventsEnabled: events !== undefined,
		sink:
			events === undefined
				? undefined
				: (event) => {
						events.push(event);
					},
	});
	const tracker = observability.beginRequest({
		correlationKey: crypto.randomUUID(),
		replayRisk: "large",
		sizeBucket: "large",
	});
	const ledger = new RoutingAttemptLedger();
	ledger.attachDegradedTracker(tracker);
	const request = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"anthropic-beta": "oauth-2025-04-20",
			"content-type": "application/json",
		},
		body,
	});
	return {
		admission,
		body,
		coordinator,
		ledger,
		observability,
		request,
		state: { admission, lifecycle: null, tracker },
	};
}

async function runAttempt(
	fixture: ReturnType<typeof makeProtectedAttempt>,
	modelFallbackPolicy?: unknown,
) {
	return proxyWithAccount(
		fixture.request,
		new URL(fixture.request.url),
		makeAccount(),
		makeRequestMeta(),
		fixture.body.buffer,
		() => undefined,
		0,
		makeContext(fixture.coordinator, fixture.observability),
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		fixture.ledger,
		modelFallbackPolicy as never,
		fixture.state,
	);
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	cacheBodyStore.setEnabled(false);
});

describe("Anthropic degraded dispatch-time observability", () => {
	it("emits the accepted probe transition before its exact terminal event", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const fixture = makeProtectedAttempt(events);
		globalThis.fetch = mock(async () => {
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const result = await runAttempt(fixture);
		expect(result).toBeInstanceOf(Response);
		if (!(result instanceof Response)) throw new Error("expected response");
		await result.text();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const settlementEvents = events.filter(
			(event) =>
				event.kind === "terminal" ||
				(event.kind === "transition" && event.from === "committed"),
		);
		expect(
			settlementEvents.map((event) =>
				event.kind === "terminal"
					? `terminal:${event.outcome}`
					: `transition:${event.from}->${event.to}`,
			),
		).toEqual(["transition:committed->recovering", "terminal:success"]);
		expect(fixture.observability.snapshot()).toMatchObject({
			physicalAttempts: 1,
			probeSends: 1,
			probeTransitions: 2,
			terminalRequests: 1,
			terminalSuccesses: 1,
			terminalFailures: 0,
			droppedEvents: 0,
		});
	});

	it("does not count a physical or probe send when the attempt budget is already zero", async () => {
		const fixture = makeProtectedAttempt();
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response("unexpected");
		}) as unknown as typeof fetch;
		const signal = new AbortController().signal;

		await runAttempt(fixture, {
			anthropicPreCommitRescue: {
				signal,
				commitmentDeadlineAt: 0,
				activate: () => undefined,
				getAttemptCommitmentDeadlineAt: () => 0,
			},
			isFinalSemanticAttempt: () => true,
		});

		expect(fetchCount).toBe(0);
		expect(fixture.state.lifecycle).not.toBeNull();
		expect(fixture.observability.snapshot()).toMatchObject({
			physicalAttempts: 0,
			probeSends: 0,
		});
	});

	it("does not count a physical or probe send when cache staging fails", async () => {
		const fixture = makeProtectedAttempt();
		cacheBodyStore.setEnabled(true);
		const staging = spyOn(cacheBodyStore, "stageRequest").mockImplementation(
			() => {
				throw new Error("staging failed");
			},
		);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			return new Response("unexpected");
		}) as unknown as typeof fetch;

		try {
			await runAttempt(fixture).catch(() => null);
		} finally {
			staging.mockRestore();
		}

		expect(fetchCount).toBe(0);
		expect(fixture.state.lifecycle).not.toBeNull();
		expect(fixture.observability.snapshot()).toMatchObject({
			physicalAttempts: 0,
			probeSends: 0,
		});
	});
});
