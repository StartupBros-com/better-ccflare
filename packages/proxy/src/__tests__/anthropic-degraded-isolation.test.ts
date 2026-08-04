import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ANTHROPIC_DEGRADED_MODE_DEFAULTS } from "@better-ccflare/config";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	AnthropicDegradedModeCoordinator,
	type AnthropicDegradedRouteInspection,
} from "../anthropic-degraded-mode";
import { DegradedModeObservability } from "../anthropic-degraded-observability";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import type { ProxyContext } from "../handlers/proxy-types";

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

const providers = await import("@better-ccflare/providers");
const estimateAdmissionTokens = spyOn(
	providers,
	"estimateAnthropicAdmissionTokens",
);
const { handleProxy } = await import("../proxy");
const { selectAccountsForRequest } = await import(
	"../handlers/account-selector"
);

const originalFetch = globalThis.fetch;
const originalPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "isolation-account",
		name: "isolation-account",
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
		...overrides,
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

function makeCoordinator(mode: "off" | "observe" | "enforce") {
	return new AnthropicDegradedModeCoordinator({
		config: {
			...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
			mode,
		},
	});
}

function makeContext(options: {
	mode: "off" | "observe" | "enforce";
	providerName: string;
	accounts?: Account[];
	snapshotAffinityOwner?: (meta: RequestMeta) => null;
}): ProxyContext {
	const accounts = options.accounts ?? [];
	const coordinator = makeCoordinator(options.mode);
	return {
		strategy: {
			select: mock(async (selected: Account[]) => selected),
			snapshotAffinityOwner: options.snapshotAffinityOwner,
		} as never,
		anthropicDegradedMode: coordinator,
		anthropicDegradedObservability: new DegradedModeObservability({
			mode: options.mode,
			largeRequestTokenThreshold: coordinator.config.largeRequestTokenThreshold,
			largeRequestByteThreshold: coordinator.config.largeRequestByteThreshold,
		}),
		degradedOwnerOverlay: new DegradedOwnerOverlay(),
		degradedOwnerShadowOverlay: new DegradedOwnerOverlay(),
		serverToolReplay: Object.freeze({ status: "disabled" }),
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: options.providerName,
			canHandle: () => true,
			buildUrl: () => "https://upstream.test/v1/messages",
			prepareHeaders: (headers: Headers) => new Headers(headers),
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false, resetTime: null }),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => true) } as never,
	};
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-opus-4-6",
			messages: [{ role: "user", content: "isolation" }],
			max_tokens: 16,
			stream: false,
		}),
	});
}

afterEach(() => {
	estimateAdmissionTokens.mockClear();
	globalThis.fetch = originalFetch;
	if (originalPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = originalPassthrough;
	}
});

describe("Anthropic degraded-mode isolation", () => {
	it("does not estimate replay risk when degraded mode and diagnostics are off", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		globalThis.fetch = mock(async () => {
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			makeContext({ mode: "off", providerName: "anthropic" }),
		);
		await response.text();

		expect(estimateAdmissionTokens).not.toHaveBeenCalled();
	});

	it("does not estimate replay risk for an unrelated provider", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		globalThis.fetch = mock(async () => {
			return new Response('{"ok":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = makeRequest();

		const response = await handleProxy(
			request,
			new URL(request.url),
			makeContext({ mode: "enforce", providerName: "openai-compatible" }),
		);
		await response.text();

		expect(estimateAdmissionTokens).not.toHaveBeenCalled();
	});

	it("does not snapshot affinity ownership while degraded mode is off", async () => {
		const snapshotAffinityOwner = mock((_meta: RequestMeta) => null);
		const ctx = makeContext({
			mode: "off",
			providerName: "anthropic",
			accounts: [makeAccount()],
			snapshotAffinityOwner,
		});

		await selectAccountsForRequest(makeRequestMeta(), ctx);

		expect(snapshotAffinityOwner).not.toHaveBeenCalled();
	});

	it("does not snapshot affinity ownership for ineligible candidates", async () => {
		const snapshotAffinityOwner = mock((_meta: RequestMeta) => null);
		const ctx = makeContext({
			mode: "enforce",
			providerName: "anthropic",
			accounts: [
				makeAccount({
					provider: "openai",
					refresh_token: null,
					access_token: null,
				}),
			],
			snapshotAffinityOwner,
		});
		const inspection: AnthropicDegradedRouteInspection = {
			cohortKey: "isolation-cohort" as never,
			state: "open",
			detail: { state: "open", nextProbeAt: 0 },
		};

		await selectAccountsForRequest(makeRequestMeta(), ctx, undefined, {
			degradedOwner: { inspection, requestKind: "large" },
		});

		expect(snapshotAffinityOwner).not.toHaveBeenCalled();
	});
});
