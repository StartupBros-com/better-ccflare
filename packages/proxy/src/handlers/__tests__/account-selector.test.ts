import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ImplicitFallbackPolicyConfig } from "@better-ccflare/config";
import { Logger } from "@better-ccflare/logger";
import type { Provider } from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	ComboWithSlots,
	RequestMeta,
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityTuple,
	ServerToolRequirements,
	StrategyStore,
} from "@better-ccflare/types";
import type {
	AnthropicDegradedCohortKey,
	AnthropicDegradedRouteInspection,
} from "../../anthropic-degraded-mode";
import { CacheAffinityOrderer } from "../../cache-affinity-orderer";
import { DegradedOwnerOverlay } from "../../degraded-owner-overlay";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../../model-route-profiles";
import type { ProxyContext } from "../proxy-types";

const { getProvider, registerProvider, usageCache } = await import(
	"@better-ccflare/providers"
);
const { SessionStrategy } = await import("@better-ccflare/load-balancer");
const {
	ForceRouteUnavailableError,
	deriveAffinityLaneKey,
	getClientVisibleServerToolAccountId,
	getCapacityDeferredModelRoutes,
	getComboSlotInfo,
	getReactiveModelCapacityBlocker,
	getRoutingCapacityContext,
	evaluateImplicitFallbackPolicy,
	isImplicitFallbackAccountAllowed,
	resolveEffectiveModel,
	selectAccountsForRequest,
	setComboSlotInfo,
} = await import("../account-selector");

// ── Fixtures ──────────────────────────────────────────────────────────────────

afterEach(() => {
	delete process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK;
});

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		billing_type: null,
		model_fallbacks: null,
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeRoutingPolicy(
	combo: ComboWithSlots | null,
	family: ComboFamily,
	overrides: Partial<ComboRoutingPolicySnapshot> = {},
): ComboRoutingPolicySnapshot {
	const { slots: comboSlots = [], ...comboRecord } = combo ?? { slots: [] };
	return {
		assignment: {
			family,
			combo_id: combo?.id ?? null,
			enabled: combo !== null,
			membership_mode: "manual",
			managed_model: null,
		},
		combo: combo ? comboRecord : null,
		slots: comboSlots,
		rules: [],
		exclusions: [],
		...overrides,
	};
}

function makeCtx(
	opts: {
		accounts?: Account[];
		activeCombo?: ComboWithSlots | null;
		routingPolicy?: ComboRoutingPolicySnapshot;
	} = {},
): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => _all),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getComboRoutingPolicy: mock(
				async (family: ComboFamily) =>
					opts.routingPolicy ??
					makeRoutingPolicy(opts.activeCombo ?? null, family),
			),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

function makeProfileOnlyRegistry(
	accountId: string,
	options: { exclusive?: boolean; includeCapabilityProfile?: boolean } = {},
): ModelRouteSessionRegistry {
	return new ModelRouteSessionRegistry(
		parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "exclusive-route",
					displayName: "Exclusive route",
					accountId,
					logicalModel: "claude-fable-5",
					...(options.exclusive === false ? {} : { exclusiveAccount: true }),
				},
				...(options.includeCapabilityProfile
					? [
							{
								id: "capability-route",
								displayName: "Capability route",
								selection: "capability",
								logicalModel: "claude-fable-5",
								expectedProvider: "anthropic",
								expectedPhysicalModel: "local-champion",
							},
						]
					: []),
			]),
		),
	);
}

function useSessionStrategy(ctx: ProxyContext): {
	resumeAccount: ReturnType<typeof mock>;
} {
	const resumeAccount = mock(async (_accountId: string) => ({
		resumed: true,
		pauseReason: null,
	}));
	const strategy = new SessionStrategy();
	strategy.initialize({
		resetAccountSession: mock((_accountId: string, _timestamp: number) => {}),
		resumeAccount,
	} as StrategyStore);
	ctx.strategy = strategy;
	return { resumeAccount };
}

const SERVER_TOOL_REQUIREMENTS: ServerToolRequirements = Object.freeze({
	revision: 2,
	profileId: "web-search:test-profile",
	optionProfileId:
		"server-tool-option-profile-v1.sha256.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	responseMode: "json",
	mixedToolMode: "server_only",
	declarations: Object.freeze([
		Object.freeze({ type: "web_search_20250305" as const, maxUses: 1 }),
	]),
	replay: Object.freeze({
		input: Object.freeze([]),
		output: Object.freeze([]),
		requiresOutputReplay: true,
	}),
});

type CapabilityProviderContext = Parameters<
	NonNullable<Provider["createServerToolCapabilityTuple"]>
>[0];

function proofFor(
	tuple: ServerToolCapabilityTuple,
	decision: "proven" | "unsupported",
): ServerToolCapabilityProof {
	return Object.freeze({
		revision: `proof:${tuple.candidateId}:${tuple.model}:${decision}`,
		tuple,
		decision,
		provenance: "account-selector-test-fixture",
		owner: "account-selector-test",
		verifiedAt: "2026-08-01T00:00:00.000Z",
		revalidateAfter: "2099-01-01T00:00:00.000Z",
		fixtureRevision: "fixture-v1",
		contractRevision: "contract-v1",
		revalidationTriggers: Object.freeze([
			"tuple_change" as const,
			"contract_change" as const,
			"decoder_change" as const,
			"observed_behavior_change" as const,
		]),
	});
}

function installCapabilityProvider(input: {
	name: string;
	decision: (
		context: CapabilityProviderContext,
		tuple: ServerToolCapabilityTuple,
	) => ServerToolCapabilityDecision;
	onTuple?: (context: CapabilityProviderContext) => void;
}): Provider | undefined {
	const previous = getProvider(input.name);
	const provider = {
		name: input.name,
		getLogicalModelCapability: () => ({
			status: "supported" as const,
			provenance: "native_passthrough" as const,
			reason: "included" as const,
		}),
		createServerToolCapabilityTuple(context: CapabilityProviderContext) {
			input.onTuple?.(context);
			const { optionProfileId, responseMode, mixedToolMode } =
				context.requirements;
			if (!optionProfileId || !responseMode || !mixedToolMode) {
				throw new Error("Expected exact server-tool requirement profile");
			}
			const tuple = {
				candidateId: context.candidateId,
				provider: input.name,
				authMode: "test-auth",
				endpointClass: "test-endpoint",
				model: context.physicalModel,
				toolType: context.requirements.declarations?.[0]?.type ?? "unknown",
				profile: context.requirements.profileId ?? "unknown",
				optionProfile: optionProfileId,
				responseMode,
				mixedToolMode,
				inputReplay: context.requirements.replay.input,
				outputReplay: context.physicalModel.includes("proxy-replay")
					? ["proxy-evidence-v1" as const]
					: ["native-Anthropic" as const],
				providerContractRevision: "provider-contract-v1",
				replayDecoderRevision: "decoder-v1",
				requestTransport: "test-request-v1",
				responseTransport: "test-response-v1",
			};
			return tuple;
		},
		resolveServerToolCapability(
			_requirement: ServerToolRequirements,
			tuple: ServerToolCapabilityTuple,
		) {
			const context = {
				candidateId: tuple.candidateId,
				account: {} as CapabilityProviderContext["account"],
				path: "/v1/messages",
				query: "",
				physicalModel: tuple.model,
				requirements: SERVER_TOOL_REQUIREMENTS,
			};
			return input.decision(context, tuple);
		},
	} as unknown as Provider;
	registerProvider(provider);
	return previous;
}

function provenDecision(
	_context: CapabilityProviderContext,
	tuple: ServerToolCapabilityTuple,
): ServerToolCapabilityDecision {
	return { decision: "proven", proof: proofFor(tuple, "proven") };
}

function serverToolMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return makeRequestMeta({
		serverToolRequirements: SERVER_TOOL_REQUIREMENTS,
		...overrides,
	});
}

const cachedUsageAccountIds = new Set<string>();

function cacheUsage(accountId: string, data: unknown): void {
	usageCache.set(accountId, data as never);
	cachedUsageAccountIds.add(accountId);
}

afterEach(() => {
	for (const accountId of cachedUsageAccountIds) usageCache.delete(accountId);
	cachedUsageAccountIds.clear();
});

// ── setComboSlotInfo / getComboSlotInfo ───────────────────────────────────────

describe("setComboSlotInfo / getComboSlotInfo", () => {
	it("stores and retrieves combo slot info on a RequestMeta", () => {
		const meta = makeRequestMeta();
		const info = {
			comboName: "My Combo",
			slots: [{ accountId: "acc-1", modelOverride: "gpt-4" }],
		};
		setComboSlotInfo(meta, info);
		expect(getComboSlotInfo(meta)).toEqual(info);
	});

	it("returns null for a meta that was never set", () => {
		const meta = makeRequestMeta();
		expect(getComboSlotInfo(meta)).toBeNull();
	});

	it("is isolated per RequestMeta object (WeakMap semantics)", () => {
		const meta1 = makeRequestMeta();
		const meta2 = makeRequestMeta();
		setComboSlotInfo(meta1, {
			comboName: "Combo A",
			slots: [{ accountId: "a", modelOverride: "m" }],
		});
		expect(getComboSlotInfo(meta2)).toBeNull();
	});
});

describe("selectAccountsForRequest — implicit fallback drain policy", () => {
	const enforcePaidDrain: ImplicitFallbackPolicyConfig = {
		mode: "enforce",
		allowedClasses: [],
		deniedClasses: ["api-key", "cloud-credential"],
	};

	function openRouterAccount(id = "openrouter"): Account {
		return makeAccount({
			id,
			provider: "openrouter",
			api_key: "sk-test",
			refresh_token: null,
			access_token: null,
		});
	}

	it("filters paid and cloud credentials in enforce mode but keeps OAuth/local classes", () => {
		const oauth = makeAccount({ id: "oauth" });
		const local = makeAccount({
			id: "local",
			provider: "ollama",
			api_key: null,
			refresh_token: null,
			access_token: null,
		});
		const paid = openRouterAccount();
		const cloud = makeAccount({
			id: "cloud",
			provider: "bedrock",
			api_key: null,
			refresh_token: null,
			access_token: null,
		});
		const ctx = makeCtx({ accounts: [oauth, paid, local, cloud] });
		ctx.implicitFallbackPolicy = enforcePaidDrain;

		return selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-8",
		).then((result) => {
			expect(result.map(({ id }) => id)).toEqual([oauth.id, local.id]);
		});
	});

	it("preserves candidate order in observe mode even when the same classes would be denied", async () => {
		const paid = openRouterAccount();
		const oauth = makeAccount({ id: "oauth" });
		const ctx = makeCtx({ accounts: [paid, oauth] });
		ctx.implicitFallbackPolicy = {
			...enforcePaidDrain,
			mode: "observe",
		};

		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
		expect(result.map(({ id }) => id)).toEqual([paid.id, oauth.id]);
		expect(meta.routingSelectionDiagnostics).toMatchObject({
			mode: "observe",
			structuralCandidateCount: 2,
			eligibleCandidateCount: 1,
			excludedCandidateCount: 1,
			selectedCandidateCount: 2,
			zeroAttemptReason: "all_unavailable",
		});
	});

	it("fails closed for an unknown route class only in enforce mode", () => {
		const unknown = makeAccount({
			id: "unknown",
			provider: "future-provider",
			api_key: null,
			refresh_token: null,
			access_token: null,
		});
		expect(isImplicitFallbackAccountAllowed(unknown, enforcePaidDrain)).toBe(
			false,
		);
		expect(
			isImplicitFallbackAccountAllowed(unknown, {
				...enforcePaidDrain,
				mode: "observe",
			}),
		).toBe(true);
		expect(
			evaluateImplicitFallbackPolicy(unknown, enforcePaidDrain),
		).toMatchObject({
			allowed: false,
			routeClass: null,
			reason: "unknown",
		});
	});

	it("does not block an explicit forced account even when its class is denied", async () => {
		const paid = openRouterAccount("forced-openrouter");
		const fallback = makeAccount({ id: "oauth-fallback" });
		const ctx = makeCtx({ accounts: [paid, fallback] });
		ctx.implicitFallbackPolicy = enforcePaidDrain;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": paid.id }),
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
		expect(result).toEqual([paid]);
	});

	it("applies enforcement to combo candidates before normal fallback", async () => {
		const paid = openRouterAccount("combo-openrouter");
		const oauth = makeAccount({ id: "combo-oauth" });
		const unrelatedPaid = openRouterAccount("unrelated-openrouter");
		const combo = makeCombo([
			{
				id: "slot-paid",
				combo_id: "combo-1",
				account_id: paid.id,
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-oauth",
				combo_id: "combo-1",
				account_id: oauth.id,
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [paid, oauth, unrelatedPaid],
			activeCombo: combo,
		});
		ctx.implicitFallbackPolicy = enforcePaidDrain;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map(({ id }) => id)).toEqual([oauth.id]);
		expect(
			getComboSlotInfo(meta)?.slots.map(({ accountId }) => accountId),
		).toEqual([oauth.id]);
		expect(meta.routingSelectionDiagnostics).toMatchObject({
			structuralCandidateCount: 2,
			eligibleCandidateCount: 1,
			excludedCandidateCount: 1,
		});
	});

	it("classifies an enforce-mode zero pool as all_unavailable when the remaining account is paused", async () => {
		const pausedOauth = makeAccount({ id: "paused-oauth", paused: true });
		const ctx = makeCtx({ accounts: [pausedOauth] });
		ctx.implicitFallbackPolicy = enforcePaidDrain;
		useSessionStrategy(ctx);
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
		expect(result).toEqual([]);
		expect(meta.routingSelectionDiagnostics).toMatchObject({
			mode: "enforce",
			structuralCandidateCount: 1,
			eligibleCandidateCount: 1,
			zeroAttemptReason: "all_unavailable",
		});
	});

	it("records policy_excluded only when enforce mode removes every implicit candidate", async () => {
		const paid = openRouterAccount("only-paid");
		const ctx = makeCtx({ accounts: [paid] });
		ctx.implicitFallbackPolicy = enforcePaidDrain;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
		expect(result).toEqual([]);
		expect(meta.routingSelectionDiagnostics).toMatchObject({
			mode: "enforce",
			structuralCandidateCount: 1,
			eligibleCandidateCount: 0,
			excludedCandidateCount: 1,
			zeroAttemptReason: "policy_excluded",
		});
	});

	it("bypasses implicit fallback policy for an explicit capability-profile API-key route", async () => {
		const paid = openRouterAccount("capability-paid");
		paid.model_mappings = JSON.stringify({ opus: "openrouter/physical-opus" });
		const fallback = makeAccount({ id: "oauth-fallback" });
		const ctx = makeCtx({ accounts: [paid, fallback] });
		ctx.implicitFallbackPolicy = enforcePaidDrain;
		const meta = makeRequestMeta({
			routeProfileId: "capability-openrouter-opus",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-opus-5",
			routeProfileExpectedPhysicalModel: "openrouter/physical-opus",
			routeExpectedProvider: "openrouter",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-5");
		expect(result).toEqual([paid]);
		expect(meta.routingSelectionDiagnostics).toBeNull();
	});
});

describe("getClientVisibleServerToolAccountId", () => {
	it("preserves public force-route account ids", () => {
		expect(
			getClientVisibleServerToolAccountId(
				makeRequestMeta(),
				"public-account-id",
			),
		).toBe("public-account-id");
	});

	it("redacts private account ids from profile-originated routes", () => {
		expect(
			getClientVisibleServerToolAccountId(
				makeRequestMeta({ routeProfileId: "pro-primary-sol" }),
				"private-account-id",
			),
		).toBeUndefined();
	});

	it("treats any present profile marker as private", () => {
		expect(
			getClientVisibleServerToolAccountId(
				makeRequestMeta({ routeProfileId: "" }),
				"private-account-id",
			),
		).toBeUndefined();
	});
});

describe("selectAccountsForRequest — authoritative owner capture", () => {
	const cohortKey = "cohort-owner-test" as AnthropicDegradedCohortKey;
	const inspection: AnthropicDegradedRouteInspection = {
		cohortKey,
		state: "open",
		detail: { state: "open", nextProbeAt: 0 },
	};

	it("captures once and materializes retention before mutating select", async () => {
		const owner = makeAccount({ id: "owner" });
		const fallback = makeAccount({ id: "fallback" });
		const snapshot = {
			candidateId: "account:owner",
			accountId: "owner",
		};
		const capture = mock((_meta: RequestMeta) => snapshot);
		const select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(meta.affinityOwnerSnapshot).toEqual(snapshot);
			expect(meta.affinityOwnerDirective).toEqual({
				kind: "retain-owner",
				owner: snapshot,
			});
			return accounts;
		});
		const ctx = makeCtx({ accounts: [owner, fallback] });
		ctx.strategy = {
			select,
			snapshotAffinityOwner: capture,
		} as unknown as ProxyContext["strategy"];
		ctx.degradedOwnerOverlay = new DegradedOwnerOverlay();
		ctx.anthropicDegradedMode = {
			config: { mode: "enforce" },
		} as ProxyContext["anthropicDegradedMode"];
		const meta = makeRequestMeta({
			clientSessionId: "capture-once-client",
		});

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-8", {
			degradedOwner: { inspection, requestKind: "large" },
		});
		await selectAccountsForRequest(meta, ctx, "claude-opus-4-8", {
			degradedOwner: { inspection, requestKind: "large" },
		});

		expect(capture).toHaveBeenCalledTimes(1);
		expect(select).toHaveBeenCalledTimes(2);
	});

	it("materializes defer-owner-assignment for a protected ownerless request", async () => {
		const account = makeAccount({ id: "selected" });
		const select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(meta.affinityOwnerSnapshot).toBeNull();
			expect(meta.affinityOwnerDirective).toEqual({
				kind: "defer-owner-assignment",
			});
			return accounts;
		});
		const ctx = makeCtx({ accounts: [account] });
		ctx.strategy = {
			select,
			snapshotAffinityOwner: mock(() => null),
		} as unknown as ProxyContext["strategy"];
		ctx.degradedOwnerOverlay = new DegradedOwnerOverlay();
		ctx.anthropicDegradedMode = {
			config: { mode: "enforce" },
		} as ProxyContext["anthropicDegradedMode"];

		await selectAccountsForRequest(
			makeRequestMeta({ clientSessionId: "ownerless-client" }),
			ctx,
			"claude-opus-4-8",
			{ degradedOwner: { inspection, requestKind: "large" } },
		);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("drops a retained directive when the captured owner is paused", async () => {
		const pausedOwner = makeAccount({ id: "owner", paused: true });
		const fallback = makeAccount({ id: "fallback" });
		const snapshot = {
			candidateId: "account:owner",
			accountId: "owner",
		};
		const select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(meta.affinityOwnerDirective).toBeNull();
			return accounts;
		});
		const ctx = makeCtx({ accounts: [pausedOwner, fallback] });
		ctx.strategy = {
			select,
			snapshotAffinityOwner: mock(() => snapshot),
		} as unknown as ProxyContext["strategy"];
		ctx.degradedOwnerOverlay = new DegradedOwnerOverlay();
		ctx.anthropicDegradedMode = {
			config: { mode: "enforce" },
		} as ProxyContext["anthropicDegradedMode"];

		await selectAccountsForRequest(
			makeRequestMeta({ clientSessionId: "invalid-owner-client" }),
			ctx,
			"claude-opus-4-8",
			{ degradedOwner: { inspection, requestKind: "large" } },
		);
		expect(select).toHaveBeenCalledTimes(1);
		expect(ctx.degradedOwnerOverlay.size).toBe(0);
	});

	for (const [label, overrides] of [
		[
			"Anthropic API-key",
			{
				provider: "anthropic",
				api_key: "api-key",
				refresh_token: "",
				access_token: null,
			},
		],
		[
			"Anthropic access-token-only",
			{
				provider: "anthropic",
				api_key: null,
				refresh_token: "",
				access_token: "access-token",
			},
		],
		[
			"Codex OAuth",
			{
				provider: "codex",
				api_key: null,
				refresh_token: "codex-refresh",
				access_token: "codex-access",
			},
		],
		[
			"Anthropic-compatible",
			{
				provider: "anthropic-compatible",
				api_key: "compatible-key",
				refresh_token: "",
				access_token: null,
			},
		],
	] as const) {
		it(`leaves ${label} owner selection unchanged without consulting affinity ownership`, async () => {
			const account = makeAccount({ id: "owner", ...overrides });
			const snapshot = {
				candidateId: "account:owner",
				accountId: "owner",
			};
			const snapshotAffinityOwner = mock(() => snapshot);
			const select = mock((accounts: Account[], meta: RequestMeta) => {
				expect(meta.affinityOwnerDirective).toBeNull();
				return accounts;
			});
			const ctx = makeCtx({ accounts: [account] });
			ctx.strategy = {
				select,
				snapshotAffinityOwner,
			} as unknown as ProxyContext["strategy"];
			ctx.degradedOwnerOverlay = new DegradedOwnerOverlay();
			ctx.anthropicDegradedMode = {
				config: { mode: "enforce" },
			} as ProxyContext["anthropicDegradedMode"];
			const meta = makeRequestMeta({
				clientSessionId: `unrelated-${label}`,
			});

			const selected = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-opus-4-8",
				{ degradedOwner: { inspection, requestKind: "large" } },
			);

			expect(selected).toEqual([account]);
			expect(meta.affinityOwnerSnapshot).toBeUndefined();
			expect(snapshotAffinityOwner).not.toHaveBeenCalled();
			expect(ctx.degradedOwnerOverlay.size).toBe(0);
		});
	}

	it("does not defer ownerless selection when its current route is not native Anthropic OAuth", async () => {
		const account = makeAccount({
			id: "codex-current",
			provider: "codex",
			api_key: null,
			refresh_token: "codex-refresh",
		});
		const select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(meta.affinityOwnerDirective).toBeNull();
			return accounts;
		});
		const ctx = makeCtx({ accounts: [account] });
		ctx.strategy = {
			select,
			snapshotAffinityOwner: mock(() => null),
		} as unknown as ProxyContext["strategy"];
		ctx.degradedOwnerOverlay = new DegradedOwnerOverlay();
		ctx.anthropicDegradedMode = {
			config: { mode: "enforce" },
		} as ProxyContext["anthropicDegradedMode"];

		const selected = await selectAccountsForRequest(
			makeRequestMeta({ clientSessionId: "ownerless-codex" }),
			ctx,
			"claude-opus-4-8",
			{ degradedOwner: { inspection, requestKind: "large" } },
		);
		expect(selected).toEqual([account]);
	});

	it("simulates the enforce owner decision in observe mode without mutating routing or the real overlay", async () => {
		const owner = makeAccount({ id: "owner" });
		const fallback = makeAccount({ id: "fallback" });
		const snapshot = {
			candidateId: "account:owner",
			accountId: "owner",
		};
		const enforceCtx = makeCtx({ accounts: [owner, fallback] });
		enforceCtx.strategy = {
			select: mock((accounts: Account[]) => accounts),
			snapshotAffinityOwner: mock(() => snapshot),
		} as unknown as ProxyContext["strategy"];
		enforceCtx.degradedOwnerOverlay = new DegradedOwnerOverlay();
		enforceCtx.degradedOwnerShadowOverlay = new DegradedOwnerOverlay();
		enforceCtx.anthropicDegradedMode = {
			config: { mode: "enforce" },
		} as ProxyContext["anthropicDegradedMode"];
		const enforceMeta = makeRequestMeta({ clientSessionId: "owner-client" });
		let enforceDecision: unknown;
		const enforceSelected = await selectAccountsForRequest(
			enforceMeta,
			enforceCtx,
			"claude-opus-4-8",
			{
				degradedOwner: {
					inspection,
					requestKind: "large",
					onDecision: (decision) => {
						enforceDecision = decision;
					},
				},
			},
		);

		const observeCtx = makeCtx({ accounts: [owner, fallback] });
		const baselineOrder = [fallback, owner];
		observeCtx.strategy = {
			select: mock(() => baselineOrder),
			snapshotAffinityOwner: mock(() => snapshot),
		} as unknown as ProxyContext["strategy"];
		observeCtx.degradedOwnerOverlay = new DegradedOwnerOverlay();
		observeCtx.degradedOwnerShadowOverlay = new DegradedOwnerOverlay();
		observeCtx.anthropicDegradedMode = {
			config: { mode: "observe" },
		} as ProxyContext["anthropicDegradedMode"];
		const observeMeta = makeRequestMeta({ clientSessionId: "owner-client" });
		let observeDecision: unknown;
		const observeSelected = await selectAccountsForRequest(
			observeMeta,
			observeCtx,
			"claude-opus-4-8",
			{
				degradedOwner: {
					inspection,
					requestKind: "large",
					onDecision: (decision) => {
						observeDecision = decision;
					},
				},
			},
		);

		expect(enforceDecision).toEqual({
			kind: "retain-owner",
			owner: snapshot,
		});
		expect(observeDecision).toEqual(enforceDecision);
		expect(enforceMeta.affinityOwnerDirective).toEqual(enforceDecision);
		expect(observeMeta.affinityOwnerDirective).toBeNull();
		expect(enforceSelected).toEqual([owner, fallback]);
		expect(observeSelected).toEqual(baselineOrder);
		expect(observeCtx.degradedOwnerOverlay.size).toBe(0);
		expect(observeCtx.degradedOwnerShadowOverlay.size).toBe(1);

		const restarted = new DegradedOwnerOverlay();
		expect(restarted.size).toBe(0);
	});
});

// ── selectAccountsForRequest — forced account via header ──────────────────────

describe("selectAccountsForRequest — x-better-ccflare-account-id header", () => {
	it("returns exactly the forced account when the header matches", async () => {
		const acc1 = makeAccount({ id: "acc-1", name: "first" });
		const acc2 = makeAccount({ id: "acc-2", name: "second" });
		const ctx = makeCtx({ accounts: [acc1, acc2] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-2");
	});

	it("fails closed when the forced account id is not found", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "nonexistent" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "nonexistent",
			reason: "not_found",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the forced account is paused", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		// Strategy mock returns only the active account (simulates SessionStrategy filtering)
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-paused",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the forced account is rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		// Strategy mock returns only the active account (simulates SessionStrategy filtering)
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-rl" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-rl",
			reason: "rate_limited_or_unavailable",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the forced-account database lookup fails", async () => {
		const active = makeAccount({ id: "acc-active" });
		const ctx = makeCtx({ accounts: [active] });
		ctx.dbOps.getAllAccounts = mock(async () => {
			throw new Error("database offline");
		});
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-forced",
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-forced",
			reason: "lookup_failed",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
});

describe("selectAccountsForRequest — profile-only account eligibility", () => {
	it("rejects a public force route to a profile-only account", async () => {
		const exclusive = makeAccount({ id: "profile-only" });
		const fallback = makeAccount({ id: "ordinary" });
		const ctx = makeCtx({ accounts: [exclusive, fallback] });
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id);
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": exclusive.id,
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toBeInstanceOf(
			ForceRouteUnavailableError,
		);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("excludes profile-only accounts from ordinary strategy candidates", async () => {
		const exclusive = makeAccount({ id: "profile-only", priority: 0 });
		const ordinary = makeAccount({ id: "ordinary", priority: 1 });
		const ctx = makeCtx({ accounts: [exclusive, ordinary] });
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id);

		const result = await selectAccountsForRequest(makeRequestMeta(), ctx);

		expect(result).toEqual([ordinary]);
		expect(ctx.strategy.select).toHaveBeenCalledWith(
			[ordinary],
			expect.anything(),
		);
	});

	it("excludes profile-only accounts from combo membership", async () => {
		const exclusive = makeAccount({ id: "profile-only" });
		const ordinary = makeAccount({ id: "ordinary" });
		const combo = makeCombo([
			{
				id: "exclusive-slot",
				combo_id: "combo-1",
				account_id: exclusive.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "ordinary-slot",
				combo_id: "combo-1",
				account_id: ordinary.id,
				model: "claude-fable-5",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [exclusive, ordinary],
			activeCombo: combo,
		});
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id);
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toEqual([ordinary]);
		expect(
			meta.routingCandidateCatalog?.map((candidate) => candidate.accountId),
		).toEqual([ordinary.id]);
	});

	it("excludes profile-only accounts from capability-profile pools", async () => {
		const exclusive = makeAccount({
			id: "profile-only",
			model_mappings: JSON.stringify({ fable: "local-champion" }),
		});
		const ctx = makeCtx({ accounts: [exclusive] });
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id, {
			includeCapabilityProfile: true,
		});
		const meta = makeRequestMeta({
			routeProfileId: "capability-route",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-fable-5",
			routeProfileExpectedPhysicalModel: "local-champion",
			routeExpectedProvider: "anthropic",
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-fable-5"),
		).rejects.toMatchObject({ reason: "model_mapping_mismatch" });
		expect(ctx.strategy.select).toHaveBeenCalledWith([], expect.anything());
	});

	it("excludes profile-only combo slots before implicit session fallback", async () => {
		const exclusive = makeAccount({ id: "profile-only" });
		const ordinary = makeAccount({ id: "ordinary" });
		const combo = makeCombo([
			{
				id: "exclusive-slot",
				combo_id: "combo-1",
				account_id: exclusive.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [exclusive, ordinary],
			activeCombo: combo,
		});
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id);
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toEqual([ordinary]);
		expect(
			meta.routingCandidateCatalog?.map((candidate) => candidate.accountId),
		).toEqual([ordinary.id]);
	});

	it("allows an unpaused profile-only account for its exact configured profile", async () => {
		const exclusive = makeAccount({ id: "profile-only" });
		const ctx = makeCtx({ accounts: [exclusive] });
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id);
		const meta = makeRequestMeta({
			forcedAccountId: exclusive.id,
			routeProfileId: "exclusive-route",
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-fable-5"),
		).resolves.toEqual([exclusive]);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("keeps a manually paused profile-only account unavailable to its exact profile", async () => {
		const exclusive = makeAccount({
			id: "profile-only",
			paused: true,
			pause_reason: "manual",
		});
		const ctx = makeCtx({ accounts: [exclusive] });
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(exclusive.id);
		const meta = makeRequestMeta({
			forcedAccountId: exclusive.id,
			routeProfileId: "exclusive-route",
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-fable-5"),
		).rejects.toMatchObject({ accountId: exclusive.id, reason: "paused" });
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("preserves ordinary routing for exact profiles without exclusiveAccount", async () => {
		const ordinary = makeAccount({ id: "ordinary-profile-account" });
		const ctx = makeCtx({ accounts: [ordinary] });
		ctx.modelRouteSessionRegistry = makeProfileOnlyRegistry(ordinary.id, {
			exclusive: false,
		});

		await expect(
			selectAccountsForRequest(makeRequestMeta(), ctx),
		).resolves.toEqual([ordinary]);
	});
});

describe("selectAccountsForRequest — server-derived route profile", () => {
	it("selects every currently eligible account in a capability pool", async () => {
		const pausedPrimary = makeAccount({
			id: "pro-primary-wmgm",
			provider: "codex",
			paused: true,
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const availableSecondary = makeAccount({
			id: "pro-secondary-bros",
			provider: "codex",
			priority: 1,
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const futureAccount = makeAccount({
			id: "future-sol-account",
			provider: "codex",
			priority: 2,
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const unrelated = makeAccount({
			id: "terra-account",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.6-terra" }),
		});
		const ctx = makeCtx({
			accounts: [pausedPrimary, availableSecondary, futureAccount, unrelated],
		});
		ctx.strategy.select = mock((accounts: Account[]) =>
			accounts.filter(
				(account) => !account.paused && !account.rate_limited_until,
			),
		);
		const meta = makeRequestMeta({
			routeProfileId: "sol-capability",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-opus-5",
			routeProfileExpectedPhysicalModel: "gpt-5.6-sol",
			routeExpectedProvider: "codex",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-5");

		expect(result.map(({ id }) => id)).toEqual([
			availableSecondary.id,
			futureAccount.id,
		]);
		expect(
			(ctx.strategy.select as ReturnType<typeof mock>).mock.calls[0]?.[0].map(
				(account: Account) => account.id,
			),
		).toEqual([pausedPrimary.id, availableSecondary.id, futureAccount.id]);
	});

	it("fails closed when every matching capability account is paused or exhausted", async () => {
		const paused = makeAccount({
			id: "paused-sol",
			provider: "codex",
			paused: true,
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const exhausted = makeAccount({
			id: "exhausted-sol",
			provider: "codex",
			rate_limited_until: Date.now() + 60_000,
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const unrelated = makeAccount({
			id: "unrelated",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.6-terra" }),
		});
		const ctx = makeCtx({ accounts: [paused, exhausted, unrelated] });
		const meta = makeRequestMeta({
			routeProfileId: "sol-capability",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-opus-5",
			routeProfileExpectedPhysicalModel: "gpt-5.6-sol",
			routeExpectedProvider: "codex",
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-opus-5"),
		).rejects.toMatchObject({
			name: "ForceRouteUnavailableError",
			reason: "rate_limited_or_unavailable",
		});
		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
	});

	it("filters a usage-exhausted matching account before capability strategy order", async () => {
		const exhausted = makeAccount({
			id: "usage-exhausted-sol",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const healthy = makeAccount({
			id: "usage-healthy-sol",
			provider: "codex",
			priority: 1,
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		cacheUsage(exhausted.id, {
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					scope: null,
				},
			],
		});
		const ctx = makeCtx({ accounts: [exhausted, healthy] });
		const meta = makeRequestMeta({
			routeProfileId: "sol-capability",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-opus-5",
			routeProfileExpectedPhysicalModel: "gpt-5.6-sol",
			routeExpectedProvider: "codex",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-5");

		expect(result.map(({ id }) => id)).toEqual([healthy.id]);
		expect(meta.hardExcludedAccountIds).toEqual(new Set([exhausted.id]));
		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
		expect(
			(ctx.strategy.select as ReturnType<typeof mock>).mock.calls[0]?.[0].map(
				(account: Account) => account.id,
			),
		).toEqual([healthy.id]);
	});

	it("keeps a child request inside the root capability pool", async () => {
		const sol = makeAccount({
			id: "sol-child-pool",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const terraOnly = makeAccount({
			id: "terra-only-child",
			provider: "codex",
			model_mappings: JSON.stringify({ sonnet: "gpt-5.6-terra" }),
		});
		const ctx = makeCtx({ accounts: [sol, terraOnly] });
		const meta = makeRequestMeta({
			routeProfileId: "sol-capability",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-opus-5",
			routeProfileExpectedPhysicalModel: "gpt-5.6-sol",
			routeExpectedProvider: "codex",
		});

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map(({ id }) => id)).toEqual([sol.id]);
	});

	it("rejects a stale strategy result that escapes the capability pool", async () => {
		const sol = makeAccount({
			id: "sol-capability",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.6-sol" }),
		});
		const unrelated = makeAccount({
			id: "unrelated-capability",
			provider: "codex",
			model_mappings: JSON.stringify({ opus: "gpt-5.6-terra" }),
		});
		const ctx = makeCtx({ accounts: [sol, unrelated] });
		ctx.strategy.select = mock(() => [unrelated, sol]);
		const meta = makeRequestMeta({
			routeProfileId: "sol-capability",
			routeProfileSelection: "capability",
			routeProfileLogicalModel: "claude-opus-5",
			routeProfileExpectedPhysicalModel: "gpt-5.6-sol",
			routeExpectedProvider: "codex",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-5");

		expect(result.map(({ id }) => id)).toEqual([sol.id]);
	});

	it("uses the server-derived forced account without consulting normal routing", async () => {
		const forced = makeAccount({
			id: "route-account",
			provider: "codex",
			model_mappings: JSON.stringify({
				"claude-opus-5": "gpt-5.6-sol",
			}),
		});
		const fallback = makeAccount({ id: "fallback" });
		const ctx = makeCtx({ accounts: [fallback, forced] });
		const meta = makeRequestMeta({
			forcedAccountId: forced.id,
			routeProfileId: "pro-primary-sol",
			routeExpectedProvider: "codex",
			routeExpectedPhysicalModel: "gpt-5.6-sol",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-5");
		expect(result.map((account) => account.id)).toEqual([forced.id]);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	for (const profileCase of [
		{
			kind: "invalid",
			expectedReason: "invalid_requirement",
			requirements: Object.freeze({
				...SERVER_TOOL_REQUIREMENTS,
				invalid: Object.freeze([
					Object.freeze({
						type: "web_search_20250305",
						reason: "invalid_options" as const,
					}),
				]),
			}),
		},
		{
			kind: "unsupported",
			expectedReason: "unsupported_requirement",
			requirements: Object.freeze({
				...SERVER_TOOL_REQUIREMENTS,
				unsupported: Object.freeze([
					Object.freeze({ type: "future_server_tool" }),
				]),
			}),
		},
		{
			kind: "incapable",
			expectedReason: "forced_incapable",
			requirements: SERVER_TOOL_REQUIREMENTS,
		},
	] as const) {
		it(`redacts the private account id from an initial ${profileCase.kind} server-tool terminal`, async () => {
			const providerName = `profile-initial-${profileCase.kind}`;
			installCapabilityProvider({
				name: providerName,
				decision: () => ({
					decision: "unknown",
					reason: "no_exact_proof",
				}),
			});
			const forced = makeAccount({
				id: `private-${profileCase.kind}-account-id`,
				provider: providerName,
				model_mappings: JSON.stringify({ opus: "physical-profile-model" }),
			});
			const ctx = makeCtx({ accounts: [forced] });
			const meta = serverToolMeta({
				forcedAccountId: forced.id,
				routeProfileId: "pro-primary-sol",
				serverToolRequirements: profileCase.requirements,
			});

			try {
				await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
				expect.unreachable("expected a profile server-tool terminal");
			} catch (error) {
				expect(error).toMatchObject({
					name: "ServerToolRoutingError",
					reason: profileCase.expectedReason,
				});
				expect((error as { accountId?: string }).accountId).toBeUndefined();
			}
			expect(ctx.strategy.select).not.toHaveBeenCalled();
		});
	}

	it("fails a server-derived route closed when its provider is excluded", async () => {
		const forced = makeAccount({ id: "route-account", provider: "codex" });
		const fallback = makeAccount({ id: "fallback", provider: "anthropic" });
		const ctx = makeCtx({ accounts: [forced, fallback] });
		const meta = makeRequestMeta({
			forcedAccountId: forced.id,
			routeProfileId: "pro-primary-sol",
			headers: new Headers({
				"x-better-ccflare-exclude-providers": "codex",
			}),
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-opus-5"),
		).rejects.toMatchObject({
			accountId: forced.id,
			reason: "provider_excluded",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("rejects conflicting public and server-derived force routes", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount({ id: "server" }), makeAccount({ id: "public" })],
		});
		const meta = makeRequestMeta({
			forcedAccountId: "server",
			routeProfileId: "profile",
			headers: new Headers({ "x-better-ccflare-account-id": "public" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "server",
			reason: "conflicting_force_route",
		});
		expect(ctx.dbOps.getAllAccounts).not.toHaveBeenCalled();
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("allows matching public and server-derived force routes", async () => {
		const account = makeAccount({ id: "same" });
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta({
			forcedAccountId: account.id,
			routeProfileId: "profile",
			headers: new Headers({
				"x-better-ccflare-account-id": account.id,
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result.map(({ id }) => id)).toEqual([account.id]);
	});

	it("fails closed when the route profile targets the wrong provider", async () => {
		const account = makeAccount({ id: "account", provider: "codex" });
		const fallback = makeAccount({ id: "fallback" });
		const ctx = makeCtx({ accounts: [account, fallback] });
		const meta = makeRequestMeta({
			forcedAccountId: account.id,
			routeProfileId: "profile",
			routeExpectedProvider: "anthropic",
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-opus-5"),
		).rejects.toMatchObject({
			accountId: account.id,
			reason: "provider_mismatch",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed when the first physical model mapping differs", async () => {
		const account = makeAccount({
			id: "account",
			provider: "codex",
			model_mappings: JSON.stringify({
				"claude-opus-5": ["gpt-5.6-terra", "gpt-5.6-sol"],
			}),
		});
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta({
			forcedAccountId: account.id,
			routeProfileId: "profile",
			routeExpectedProvider: "codex",
			routeExpectedPhysicalModel: "gpt-5.6-sol",
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-opus-5"),
		).rejects.toMatchObject({
			accountId: account.id,
			reason: "model_mapping_mismatch",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("validates the unchanged logical model when the account has no mappings", async () => {
		const account = makeAccount({ id: "account", provider: "anthropic" });
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta({
			forcedAccountId: account.id,
			routeProfileId: "profile",
			routeExpectedPhysicalModel: "claude-opus-5",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-5");
		expect(result).toEqual([account]);
	});
});

describe("selectAccountsForRequest — Grok cache-native ownership", () => {
	it("keeps the same owner when the configured strategy changes order", async () => {
		const a = makeAccount({ id: "xai-a", provider: "xai" });
		const b = makeAccount({ id: "xai-b", provider: "xai" });
		let reverse = false;
		const ctx = makeCtx({ accounts: [a, b] });
		ctx.strategy.select = mock(() => {
			reverse = !reverse;
			return reverse ? [a, b] : [b, a];
		});
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);

		const firstMeta = makeRequestMeta({
			xaiCacheNativeActive: true,
			cacheAffinityKey: "conversation",
		});
		const first = await selectAccountsForRequest(firstMeta, ctx);
		ctx.cacheAffinityOrderer.recordSuccess(firstMeta, "account:xai-a", a.id);
		const second = await selectAccountsForRequest(
			makeRequestMeta({
				xaiCacheNativeActive: true,
				cacheAffinityKey: "conversation",
			}),
			ctx,
		);

		expect(first[0]?.id).toBe("xai-a");
		expect(second[0]?.id).toBe("xai-a");
	});

	it("keeps an equal-tier managed owner but yields immediately to a better managed tier", async () => {
		const a = makeAccount({
			id: "xai-managed-a",
			provider: "xai",
			priority: 1,
		});
		const b = makeAccount({
			id: "xai-managed-b",
			provider: "xai",
			priority: 1,
		});
		const combo = makeCombo([]);
		const policy = makeRoutingPolicy(combo, "fable", {
			assignment: {
				family: "fable",
				combo_id: combo.id,
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-fable-5",
			},
			rules: [
				{
					id: "rule-xai-oauth",
					family: "fable",
					combo_id: combo.id,
					provider: "xai",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
		});
		const ctx = makeCtx({ accounts: [a, b], routingPolicy: policy });
		let reverseStrategy = false;
		ctx.strategy.select = mock(() => (reverseStrategy ? [b, a] : [a, b]));
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);
		const affinity = {
			xaiCacheNativeActive: true,
			cacheAffinityKey: "managed-conversation",
		};

		const firstMeta = makeRequestMeta(affinity);
		const first = await selectAccountsForRequest(
			firstMeta,
			ctx,
			"claude-fable-5",
		);
		const firstCandidateId = firstMeta.routingCandidates?.[0]?.candidateId;
		if (!firstCandidateId)
			throw new Error("expected managed candidate identity");
		ctx.cacheAffinityOrderer.recordSuccess(firstMeta, firstCandidateId, a.id);
		reverseStrategy = true;
		const equalTierMeta = makeRequestMeta({ ...affinity, id: "req-equal" });
		const equalTier = await selectAccountsForRequest(
			equalTierMeta,
			ctx,
			"claude-fable-5",
		);

		expect(first[0]?.id).toBe(a.id);
		expect(equalTier[0]?.id).toBe(a.id);
		expect(equalTierMeta.routingCandidates?.[0]).toMatchObject({
			candidateId:
				"combo:combo-1:managed:fable:rule:rule-xai-oauth:account:xai-managed-a",
			tier: 1,
			comboSlotId: null,
		});

		b.priority = 0;
		const betterTierMeta = makeRequestMeta({ ...affinity, id: "req-better" });
		const betterTier = await selectAccountsForRequest(
			betterTierMeta,
			ctx,
			"claude-fable-5",
		);
		expect(betterTier.map((account) => account.id)).toEqual([b.id, a.id]);
		expect(betterTierMeta.routingCandidates?.[0]).toMatchObject({
			candidateId:
				"combo:combo-1:managed:fable:rule:rule-xai-oauth:account:xai-managed-b",
			tier: 0,
			comboSlotId: null,
		});
	});

	it("replaces combo ownership when a better slot tier becomes routable", async () => {
		const a = makeAccount({ id: "xai-a", provider: "xai" });
		const b = makeAccount({ id: "xai-b", provider: "xai" });
		const ctx = makeCtx({
			accounts: [a, b],
			activeCombo: makeCombo([
				{
					id: "slot-a",
					combo_id: "combo-1",
					account_id: "xai-a",
					model: "grok-a",
					priority: 0,
					enabled: true,
				},
				{
					id: "slot-b",
					combo_id: "combo-1",
					account_id: "xai-b",
					model: "grok-b",
					priority: 1,
					enabled: true,
				},
			]),
		});
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);
		const affinity = {
			xaiCacheNativeActive: true,
			cacheAffinityKey: "conversation",
		};

		const initialMeta = makeRequestMeta(affinity);
		await selectAccountsForRequest(initialMeta, ctx, "claude-sonnet-4-5");
		const initialCandidateId = initialMeta.routingCandidates?.[0]?.candidateId;
		if (!initialCandidateId)
			throw new Error("expected combo candidate identity");
		ctx.cacheAffinityOrderer.recordSuccess(
			initialMeta,
			initialCandidateId,
			a.id,
		);
		const reversedCombo = makeCombo([
			{
				id: "slot-b",
				combo_id: "combo-1",
				account_id: "xai-b",
				model: "grok-b",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-a",
				combo_id: "combo-1",
				account_id: "xai-a",
				model: "grok-a",
				priority: 1,
				enabled: true,
			},
		]);
		(
			ctx.dbOps.getComboRoutingPolicy as ReturnType<typeof mock>
		).mockImplementation(async (family: ComboFamily) =>
			makeRoutingPolicy(reversedCombo, family),
		);
		const meta = makeRequestMeta(affinity);
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((account) => account.id)).toEqual(["xai-b", "xai-a"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{
				accountId: "xai-b",
				modelOverride: "grok-b",
			},
			{
				accountId: "xai-a",
				modelOverride: "grok-a",
			},
		]);
		expect(
			meta.routingCandidates?.map(
				({ comboSlotId, accountId, modelOverride, tier, ordinal }) => ({
					comboSlotId,
					accountId,
					modelOverride,
					tier,
					ordinal,
				}),
			),
		).toEqual([
			{
				comboSlotId: "slot-b",
				accountId: "xai-b",
				modelOverride: "grok-b",
				tier: 0,
				ordinal: 0,
			},
			{
				comboSlotId: "slot-a",
				accountId: "xai-a",
				modelOverride: "grok-a",
				tier: 1,
				ordinal: 1,
			},
		]);
	});

	it("keeps repeated-account xAI slots aligned by stable resolved identity", async () => {
		const account = makeAccount({ id: "xai-a", provider: "xai" });
		const initialCombo = makeCombo([
			{
				id: "slot-opus",
				combo_id: "combo-1",
				account_id: account.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-fable",
				combo_id: "combo-1",
				account_id: account.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [account], activeCombo: initialCombo });
		ctx.cacheAffinityOrderer = new CacheAffinityOrderer(60_000);
		const affinity = {
			xaiCacheNativeActive: true,
			cacheAffinityKey: "repeated-slot-conversation",
		};

		const initialMeta = makeRequestMeta(affinity);
		await selectAccountsForRequest(initialMeta, ctx, "claude-sonnet-4-5");
		const initialCandidateId = initialMeta.routingCandidates?.[0]?.candidateId;
		if (!initialCandidateId)
			throw new Error("expected combo candidate identity");
		ctx.cacheAffinityOrderer.recordSuccess(
			initialMeta,
			initialCandidateId,
			account.id,
		);
		(
			ctx.dbOps.getComboRoutingPolicy as ReturnType<typeof mock>
		).mockImplementation(async (family: ComboFamily) =>
			makeRoutingPolicy(
				makeCombo([initialCombo.slots[1], initialCombo.slots[0]]),
				family,
			),
		);
		const meta = makeRequestMeta(affinity);
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result.map((entry) => entry.id)).toEqual([account.id, account.id]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: account.id, modelOverride: "claude-fable-5" },
			{ accountId: account.id, modelOverride: "claude-opus-4-8" },
		]);
		expect(
			meta.routingCandidates?.map((candidate) => ({
				comboSlotId: candidate.comboSlotId,
				modelOverride: candidate.modelOverride,
				tier: candidate.tier,
				ordinal: candidate.ordinal,
			})),
		).toEqual([
			{
				comboSlotId: "slot-fable",
				modelOverride: "claude-fable-5",
				tier: 0,
				ordinal: 0,
			},
			{
				comboSlotId: "slot-opus",
				modelOverride: "claude-opus-4-8",
				tier: 0,
				ordinal: 1,
			},
		]);
	});
});

describe("selectAccountsForRequest — Grok cache-native force-route fail-closed", () => {
	it("throws when feature is active and forced xAI account is paused", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			provider: "xai",
			paused: true,
		});
		const activeAcc = makeAccount({
			id: "acc-active",
			name: "active",
			provider: "xai",
		});
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});
		await expect(selectAccountsForRequest(meta, ctx)).rejects.toBeInstanceOf(
			ForceRouteUnavailableError,
		);
	});

	it("fails closed for an unavailable custom-endpoint xAI account", async () => {
		const customAcc = makeAccount({
			id: "acc-custom",
			name: "custom",
			provider: "xai",
			custom_endpoint: "https://xai.internal.example/v1",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [customAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-custom",
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-custom",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("fails closed for an unavailable non-xAI account", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			provider: "codex",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-paused",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("still allows an authenticated scheduler probe for an official xAI account", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			provider: "xai",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx = makeCtx({ accounts: [rateLimitedAcc, activeAcc] });
		const meta = makeRequestMeta({
			xaiCacheNativeActive: true,
			trustedInternalAutoRefresh: true,
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-rl",
				"x-better-ccflare-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toEqual([rateLimitedAcc]);
	});

	it("remains fail-closed when the cache-native feature is off", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			provider: "xai",
			paused: true,
		});
		const activeAcc = makeAccount({
			id: "acc-active",
			name: "active",
			provider: "xai",
		});
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			xaiCacheNativeActive: false,
			headers: new Headers({ "x-better-ccflare-account-id": "acc-paused" }),
		});
		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-paused",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
});

// ── selectAccountsForRequest — combo routing ──────────────────────────────────

describe("selectAccountsForRequest — combo routing", () => {
	it("keeps the legacy manual candidate contract exactly", async () => {
		const first = makeAccount({ id: "manual-first", priority: 99 });
		const second = makeAccount({ id: "manual-second", priority: 0 });
		const combo = makeCombo([
			{
				id: "slot-a",
				combo_id: "combo-1",
				account_id: first.id,
				model: "claude-opus-4-8",
				priority: 2,
				enabled: true,
			},
			{
				id: "slot-b",
				combo_id: "combo-1",
				account_id: second.id,
				model: "claude-opus-4-5",
				priority: 3,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [first, second], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
		const expectedCandidates = [
			{
				candidateId: "combo:combo-1:slot:slot-a",
				accountId: first.id,
				tier: 2,
				ordinal: 0,
				comboSlotId: "slot-a",
				modelOverride: "claude-opus-4-8",
				quotaPressure: null,
			},
			{
				candidateId: "combo:combo-1:slot:slot-b",
				accountId: second.id,
				tier: 3,
				ordinal: 1,
				comboSlotId: "slot-b",
				modelOverride: "claude-opus-4-5",
				quotaPressure: null,
			},
		];

		expect(result).toEqual([first, second]);
		expect(meta.routingCandidateCatalog).toEqual(expectedCandidates);
		expect(meta.routingCandidates).toEqual(expectedCandidates);
		expect(getComboSlotInfo(meta)).toEqual({
			comboName: "Test Combo",
			slots: [
				{ accountId: first.id, modelOverride: "claude-opus-4-8" },
				{ accountId: second.id, modelOverride: "claude-opus-4-5" },
			],
		});
	});

	it("keeps manual combo selection equivalent when the managed-policy reader is unavailable", async () => {
		const first = makeAccount({ id: "manual-first", priority: 99 });
		const second = makeAccount({ id: "manual-second", priority: 0 });
		const combo = makeCombo([
			{
				id: "slot-a",
				combo_id: "combo-1",
				account_id: first.id,
				model: "claude-opus-4-8",
				priority: 2,
				enabled: true,
			},
			{
				id: "slot-b",
				combo_id: "combo-1",
				account_id: second.id,
				model: "claude-opus-4-5",
				priority: 3,
				enabled: true,
			},
		]);
		const accounts = [first, second];
		const currentCtx = makeCtx({ accounts, activeCombo: combo });
		const legacyCtx = makeCtx({ accounts, activeCombo: combo });
		const legacyDbOps = legacyCtx.dbOps as unknown as {
			getComboRoutingPolicy?: ProxyContext["dbOps"]["getComboRoutingPolicy"];
			getActiveComboForFamily: ProxyContext["dbOps"]["getActiveComboForFamily"];
		};
		delete legacyDbOps.getComboRoutingPolicy;
		const getActiveComboForFamily = mock(async () => combo);
		legacyDbOps.getActiveComboForFamily = getActiveComboForFamily;
		const currentMeta = makeRequestMeta();
		const legacyMeta = makeRequestMeta();

		const currentResult = await selectAccountsForRequest(
			currentMeta,
			currentCtx,
			"claude-opus-4-8",
		);
		const legacyResult = await selectAccountsForRequest(
			legacyMeta,
			legacyCtx,
			"claude-opus-4-8",
		);

		expect(legacyResult).toEqual(currentResult);
		expect(legacyMeta.routingCandidateCatalog).toEqual(
			currentMeta.routingCandidateCatalog,
		);
		expect(legacyMeta.routingCandidates).toEqual(currentMeta.routingCandidates);
		expect(getComboSlotInfo(legacyMeta)).toEqual(getComboSlotInfo(currentMeta));
		expect(legacyMeta.comboName).toBe(currentMeta.comboName);
		expect(getActiveComboForFamily).toHaveBeenCalledWith("opus");
	});

	it("synthesizes a fourth managed peer at account priority with a stable virtual identity", async () => {
		const accounts = [
			"anthropic-1",
			"anthropic-2",
			"anthropic-3",
			"anthropic-4",
		].map((id) => makeAccount({ id, priority: 0 }));
		const combo = makeCombo([]);
		const policy = makeRoutingPolicy(combo, "opus", {
			assignment: {
				family: "opus",
				combo_id: combo.id,
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			rules: [
				{
					id: "rule-anthropic-oauth",
					family: "opus",
					combo_id: combo.id,
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
		});
		const ctx = makeCtx({ accounts, routingPolicy: policy });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result.map((account) => account.id)).toEqual(
			accounts.map((account) => account.id),
		);
		expect(meta.routingCandidates?.at(-1)).toMatchObject({
			candidateId:
				"combo:combo-1:managed:opus:rule:rule-anthropic-oauth:account:anthropic-4",
			accountId: "anthropic-4",
			tier: 0,
			ordinal: 3,
			comboSlotId: null,
			modelOverride: "claude-opus-4-8",
		});
		expect(ctx.dbOps.getAllAccounts).toHaveBeenCalledTimes(1);
		expect(ctx.dbOps.getComboRoutingPolicy).toHaveBeenCalledWith("opus");

		const reconstructedMeta = makeRequestMeta({ id: "req-reconstructed" });
		await selectAccountsForRequest(reconstructedMeta, ctx, "claude-opus-4-8");
		expect(
			reconstructedMeta.routingCandidates?.map(
				(candidate) => candidate.candidateId,
			),
		).toEqual(
			meta.routingCandidates?.map((candidate) => candidate.candidateId),
		);
		expect(ctx.dbOps.getAllAccounts).toHaveBeenCalledTimes(2);
	});

	it("keeps repeated manual lanes while suppressing their managed duplicate", async () => {
		const overridden = makeAccount({ id: "manual-account", priority: 0 });
		const managed = makeAccount({ id: "managed-account", priority: 1 });
		const combo = makeCombo([
			{
				id: "slot-manual-opus",
				combo_id: "combo-1",
				account_id: overridden.id,
				model: "claude-opus-4-8",
				priority: 5,
				enabled: true,
			},
			{
				id: "slot-manual-fable",
				combo_id: "combo-1",
				account_id: overridden.id,
				model: "claude-fable-5",
				priority: 6,
				enabled: true,
			},
		]);
		const policy = makeRoutingPolicy(combo, "opus", {
			assignment: {
				family: "opus",
				combo_id: combo.id,
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			rules: [
				{
					id: "rule-anthropic-oauth",
					family: "opus",
					combo_id: combo.id,
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
		});
		const ctx = makeCtx({
			accounts: [overridden, managed],
			routingPolicy: policy,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result.map((account) => account.id)).toEqual([
			managed.id,
			overridden.id,
			overridden.id,
		]);
		expect(
			meta.routingCandidates?.map((candidate) => ({
				candidateId: candidate.candidateId,
				comboSlotId: candidate.comboSlotId,
				modelOverride: candidate.modelOverride,
			})),
		).toEqual([
			{
				candidateId:
					"combo:combo-1:managed:opus:rule:rule-anthropic-oauth:account:managed-account",
				comboSlotId: null,
				modelOverride: "claude-opus-4-8",
			},
			{
				candidateId: "combo:combo-1:slot:slot-manual-opus",
				comboSlotId: "slot-manual-opus",
				modelOverride: "claude-opus-4-8",
			},
			{
				candidateId: "combo:combo-1:slot:slot-manual-fable",
				comboSlotId: "slot-manual-fable",
				modelOverride: "claude-fable-5",
			},
		]);
	});

	it("applies request provider exclusions after managed membership synthesis", async () => {
		const managed = makeAccount({ id: "managed-anthropic", priority: 0 });
		const manual = makeAccount({
			id: "manual-xai",
			provider: "xai",
			priority: 99,
		});
		const combo = makeCombo([
			{
				id: "slot-xai",
				combo_id: "combo-1",
				account_id: manual.id,
				model: "grok-4",
				priority: 1,
				enabled: true,
			},
		]);
		const policy = makeRoutingPolicy(combo, "opus", {
			assignment: {
				family: "opus",
				combo_id: combo.id,
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-opus-4-8",
			},
			rules: [
				{
					id: "rule-anthropic-oauth",
					family: "opus",
					combo_id: combo.id,
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
		});
		const ctx = makeCtx({
			accounts: [managed, manual],
			routingPolicy: policy,
		});
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-exclude-providers": "anthropic-oauth",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result.map((account) => account.id)).toEqual([manual.id]);
		expect(
			meta.routingCandidateCatalog?.map((candidate) => candidate.accountId),
		).toEqual([manual.id]);
	});

	it("retains unavailable or exhausted managed members while routing to a later tier", async () => {
		const unavailable = makeAccount({
			id: "managed-paused",
			priority: 0,
			paused: true,
		});
		const fallback = makeAccount({ id: "managed-fallback", priority: 1 });
		const combo = makeCombo([]);
		const policy = makeRoutingPolicy(combo, "fable", {
			assignment: {
				family: "fable",
				combo_id: combo.id,
				enabled: true,
				membership_mode: "managed",
				managed_model: "claude-fable-5",
			},
			rules: [
				{
					id: "rule-anthropic-oauth",
					family: "fable",
					combo_id: combo.id,
					provider: "anthropic",
					route_class: "oauth-subscription",
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
			],
		});
		const ctx = makeCtx({
			accounts: [unavailable, fallback],
			routingPolicy: policy,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((account) => account.id)).toEqual([fallback.id]);
		expect(
			meta.routingCandidateCatalog?.map((candidate) => candidate.accountId),
		).toEqual([unavailable.id, fallback.id]);
		expect(meta.routingCandidates?.[0]).toMatchObject({
			accountId: fallback.id,
			tier: 1,
			comboSlotId: null,
			modelOverride: "claude-fable-5",
		});

		unavailable.paused = false;
		cacheUsage(unavailable.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					scope: {
						model: { id: null, display_name: "Fable" },
						surface: null,
					},
				},
			],
		});
		const exhaustedMeta = makeRequestMeta({ id: "req-exhausted" });
		const exhaustedResult = await selectAccountsForRequest(
			exhaustedMeta,
			ctx,
			"claude-fable-5",
		);

		expect(exhaustedResult.map((account) => account.id)).toEqual([fallback.id]);
		expect(getRoutingCapacityContext(exhaustedMeta)?.exclusions).toMatchObject([
			{
				accountId: unavailable.id,
				model: "claude-fable-5",
				comboSlotId: null,
				comboSlotOrdinal: 0,
			},
		]);
	});

	it("returns combo-ordered accounts when an active combo exists for the model family", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Both accounts should be returned in slot priority order
		expect(result.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("stores combo slot info on the RequestMeta when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-5");

		const slotInfo = getComboSlotInfo(meta);
		expect(slotInfo).not.toBeNull();
		expect(slotInfo?.comboName).toBe("Test Combo");
		expect(slotInfo?.slots[0]?.accountId).toBe("acc-1");
		expect(slotInfo?.slots[0]?.modelOverride).toBe("claude-opus-4-5");
	});

	it("propagates an empty slot model as an empty passthrough override", async () => {
		const account = makeAccount({ id: "acc-passthrough" });
		const combo = makeCombo([
			{
				id: "slot-passthrough",
				combo_id: "combo-1",
				account_id: account.id,
				model: "",
				priority: 0,
				enabled: true,
			},
		]);
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account], activeCombo: combo }),
			"claude-sonnet-4-5",
		);

		expect(result).toEqual([account]);
		expect(getComboSlotInfo(meta)).toEqual({
			comboName: "Test Combo",
			slots: [{ accountId: account.id, modelOverride: "" }],
		});
		expect(meta.routingCandidates?.[0]).toMatchObject({
			accountId: account.id,
			comboSlotId: "slot-passthrough",
			modelOverride: "",
		});
	});

	it("sets meta.comboName when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-haiku-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-haiku-4-5");
		expect(meta.comboName).toBe("Test Combo");
	});

	it("performs one combo pass, then an explicit normal fallback without stale sidecar metadata", async () => {
		const comboAccount = makeAccount({ id: "acc-combo" });
		const normalAccount = makeAccount({ id: "acc-normal" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: comboAccount.id,
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [comboAccount, normalAccount],
			activeCombo: combo,
		});
		ctx.strategy.select = mock((accounts: Account[], meta: RequestMeta) =>
			meta.routingCandidates?.some(
				(candidate) => candidate.comboSlotId !== null,
			)
				? accounts
				: [normalAccount],
		);
		const meta = makeRequestMeta();

		expect(
			(await selectAccountsForRequest(meta, ctx, "claude-opus-4-5")).map(
				(account) => account.id,
			),
		).toEqual([comboAccount.id]);
		expect(getComboSlotInfo(meta)?.comboName).toBe("Test Combo");
		meta.comboSlotIndex = 3;

		const fallback = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-opus-4-5",
			{ skipCombo: true },
		);

		expect(fallback.map((account) => account.id)).toEqual([normalAccount.id]);
		expect(ctx.dbOps.getComboRoutingPolicy).toHaveBeenCalledTimes(1);
		expect(ctx.dbOps.getAllAccounts).toHaveBeenCalledTimes(2);
		expect(ctx.strategy.select).toHaveBeenCalledTimes(2);
		expect(getComboSlotInfo(meta)).toBeNull();
		expect(meta.comboName).toBeNull();
		expect(meta.comboSlotIndex).toBeNull();
	});

	it("skips disabled slots", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: false, // disabled
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
	});

	it("falls back to SessionStrategy when all combo slots are rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-1",
			rate_limited_until: Date.now() + 3_600_000, // rate limited for 1h
		});
		const fallbackAcc = makeAccount({ id: "acc-fallback" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = {
			strategy: {
				select: mock(() => [fallbackAcc]),
			},
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, fallbackAcc]),
				getComboRoutingPolicy: mock(async (family: ComboFamily) =>
					makeRoutingPolicy(combo, family),
				),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;

		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Should fall back to strategy result (fallbackAcc)
		expect(result[0]?.id).toBe("acc-fallback");
		expect(ctx.dbOps.getAllAccounts).toHaveBeenCalledTimes(1);
	});

	it("does not fall back to SessionStrategy when all combo slots are unavailable and combo fallback is disabled", async () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "true";
		const rateLimitedAcc = makeAccount({
			id: "acc-1",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const fallbackAcc = makeAccount({ id: "acc-fallback" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const select = mock(() => [fallbackAcc]);
		const ctx = {
			strategy: { select },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, fallbackAcc]),
				getActiveComboForFamily: mock(async () => combo),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;

		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result).toEqual([]);
		expect(meta.comboName).toBe("Test Combo");
		expect(getComboSlotInfo(meta)).toEqual({
			comboName: "Test Combo",
			slots: [],
		});
		expect(select).not.toHaveBeenCalled();
	});

	it("falls back to SessionStrategy when no combo is active for the model family", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc], activeCombo: null });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// No combo — strategy.select is used
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("fails safely when the recognized-family account preload rejects", async () => {
		const ctx = makeCtx({ activeCombo: null });
		ctx.dbOps.getAllAccounts = mock(async () => {
			throw new Error("database unavailable");
		});
		const meta = makeRequestMeta();

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-opus-4-8"),
		).resolves.toEqual([]);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
		expect(ctx.dbOps.getAllAccounts).toHaveBeenCalledTimes(1);
	});

	it("falls back to normal routing when no model is provided", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo lookup for unknown model families", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		// A model that doesn't map to a known family
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"gpt-4-turbo-unknown",
		);
		// getComboRoutingPolicy should not be called for unknown families.
		// dbOps is a plain mock object (not a real DatabaseOperations instance),
		// so the mock-specific assertion methods require escaping the type here.
		// biome-ignore lint/suspicious/noExplicitAny: accessing bun:test mock assertion API on a test double
		const ctxAny = ctx as any;
		expect(ctxAny.dbOps.getComboRoutingPolicy).not.toHaveBeenCalled();
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo slots that reference unknown accounts", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-ghost",
				combo_id: "combo-1",
				account_id: "acc-ghost", // does not exist in accounts list
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-real",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Ghost slot is skipped; only acc-1 is returned
		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
	});
});

// ── selectAccountsForRequest — auto-refresh bypass for overage-paused accounts ─

describe("selectAccountsForRequest — trusted auto-refresh bypass", () => {
	/**
	 * The auto-refresh scheduler intentionally refreshes accounts that are paused
	 * due to auto_pause_on_overage. Only the authenticated in-process credential,
	 * not caller-controlled routing hints, may grant that narrow exception.
	 */
	it("rejects spoofed public auto-refresh headers for an overage-paused account", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-overage",
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-overage",
			reason: "paused",
		});
	});

	it("allows an authenticated internal probe through an overage pause", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		const ctx = makeCtx({ accounts: [overagePausedAcc] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-overage",
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toEqual([overagePausedAcc]);
	});

	it("blocks an overage-paused account without trusted internal authentication", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-overage",
				// Public traffic has no trustedInternalAutoRefresh bit.
			}),
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-overage",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("blocks a manually-paused account even for an authenticated internal probe", async () => {
		// A manual pause must win even when auto_pause_on_overage_enabled is set:
		// the auto-resume guard would never un-pause it, so admitting it on a
		// bypass-session force-route just produces an endless probe loop. Mirrors
		// the scheduler eligibility query and the sendDummyMessage resume guard.
		const manualPausedAcc = makeAccount({
			id: "acc-manual",
			name: "manual-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "manual",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [manualPausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-manual",
				"x-better-ccflare-bypass-session": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-manual",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});

	it("allows an authenticated internal probe through an account cooldown", async () => {
		// The scheduler probes rate-limited accounts to detect when the window has reset.
		// Without this fix the account selector falls through to SessionStrategy and routes
		// to a *different* account, corrupting the intended account's rate_limit_reset row.
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			paused: false,
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-rl",
				"x-better-ccflare-bypass-session": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Rate-limited account must be returned directly — bypass-session overrides the guard
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-rl");
	});

	it("blocks a failure-paused account even for an authenticated internal probe", async () => {
		// A failure-paused account: paused=true, auto_pause_on_overage_enabled=false
		const failurePausedAcc = makeAccount({
			id: "acc-broken",
			name: "failure-paused",
			paused: true,
			auto_pause_on_overage_enabled: false,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [failurePausedAcc, activeAcc]),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
			usageWorker: { postMessage: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": "acc-broken",
				"x-better-ccflare-bypass-session": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		await expect(selectAccountsForRequest(meta, ctx)).rejects.toMatchObject({
			accountId: "acc-broken",
			reason: "paused",
		});
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
});

// ── selectAccountsForRequest — paused account handling ───────────────────────

describe("selectAccountsForRequest — paused accounts in combo", () => {
	it("excludes paused accounts from combo slot results", async () => {
		const pausedAcc = makeAccount({ id: "acc-paused", paused: true });
		const activeAcc = makeAccount({ id: "acc-active" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-paused",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-active",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({
			accounts: [pausedAcc, activeAcc],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-active"]);
	});
});

// ── resolveEffectiveModel ──────────────────────────────────────────────────────

describe("resolveEffectiveModel", () => {
	it("returns the applied model when the interceptor rewrote the request", () => {
		expect(resolveEffectiveModel("claude-opus-4-5", "claude-sonnet-4-5")).toBe(
			"claude-opus-4-5",
		);
	});

	it("falls back to the original request model when nothing was applied", () => {
		expect(resolveEffectiveModel(null, "claude-sonnet-4-5")).toBe(
			"claude-sonnet-4-5",
		);
		expect(resolveEffectiveModel(undefined, "claude-sonnet-4-5")).toBe(
			"claude-sonnet-4-5",
		);
	});

	it("returns null when neither an applied nor an original model is available", () => {
		expect(resolveEffectiveModel(null, null)).toBeNull();
		expect(resolveEffectiveModel(undefined, undefined)).toBeNull();
	});
});

// ── selectAccountsForRequest — routes on the post-rewrite (effective) model ────

describe("selectAccountsForRequest — routes on effective model, not the client's original model", () => {
	it("combo routing matches the applied model's family, not the original request's family", async () => {
		// Client requested a sonnet model, but the agent interceptor rewrote it
		// to an opus model (e.g. via an agent preference). Routing must pick
		// the combo for the *opus* family, mirroring what proxy.ts does by
		// calling selectAccountsForRequest with resolveEffectiveModel's result
		// instead of the raw client-requested model.
		const opusAcc = makeAccount({ id: "acc-opus" });
		const opusCombo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-opus",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [opusAcc], activeCombo: opusCombo });
		const meta = makeRequestMeta();

		const originalModel = "claude-sonnet-4-5";
		const appliedModel = "claude-opus-4-5"; // simulates interceptor rewrite
		const effectiveModel = resolveEffectiveModel(appliedModel, originalModel);
		expect(effectiveModel).toBe("claude-opus-4-5");

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			effectiveModel ?? undefined,
		);

		expect(result.map((a) => a.id)).toEqual(["acc-opus"]);
		const slotInfo = getComboSlotInfo(meta);
		expect(slotInfo?.comboName).toBe("Test Combo");
		expect(slotInfo?.slots[0]?.modelOverride).toBe("claude-opus-4-5");
	});
});

// ── model-lane capacity planning ─────────────────────────────────────────────

describe("selectAccountsForRequest — model-lane hard capacity", () => {
	function weeklyScoped(
		displayName: string | null,
		percent = 100,
		resetAt = Date.now() + 60 * 60 * 1000,
	) {
		return {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: new Date(resetAt).toISOString(),
					scope:
						displayName === null
							? null
							: {
									model: { id: null, display_name: displayName },
									surface: null,
								},
				},
			],
		};
	}

	it("excludes a Fable-full account before strategy selection but keeps it eligible for Opus", async () => {
		const preferred = makeAccount({
			id: "capacity-preferred",
			priority: 0,
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const fallback = makeAccount({ id: "capacity-fallback", priority: 1 });
		cacheUsage(preferred.id, weeklyScoped("Fable"));

		const strategy = mock((_accounts: Account[]) => [preferred, fallback]);
		const ctx = makeCtx({ accounts: [preferred, fallback] });
		ctx.strategy.select = strategy;
		const fableMeta = makeRequestMeta({ clientSessionId: "conversation-1" });

		const fable = await selectAccountsForRequest(
			fableMeta,
			ctx,
			"claude-fable-5",
		);
		const candidatesSeenByStrategy = strategy.mock.calls[0]?.[0] as Account[];
		expect(candidatesSeenByStrategy.map((account) => account.id)).toEqual([
			fallback.id,
		]);
		// Defensive filtering still wins if a strategy returns an account that was
		// not present in its candidate input.
		expect(fable.map((account) => account.id)).toEqual([fallback.id]);
		expect(fableMeta.hardExcludedAccountIds?.has(preferred.id)).toBe(true);
		expect(fableMeta.routingCandidateCatalog).toMatchObject([
			{ accountId: preferred.id, tier: 0, comboSlotId: null },
			{ accountId: fallback.id, tier: 1, comboSlotId: null },
		]);

		const context = getRoutingCapacityContext(fableMeta);
		expect(context?.effectiveModel).toBe("claude-fable-5");
		expect(context?.exclusions).toHaveLength(1);
		expect(context?.exclusions[0]?.accountId).toBe(preferred.id);
		expect(context?.exclusions[0]?.modelFamily).toBe("fable");
		expect(context?.exclusions[0]?.exclusions[0]?.scope).toBe("family");
		expect(context?.blockedUntil).toBeGreaterThan(Date.now());

		strategy.mockClear();
		strategy.mockImplementation((_accounts: Account[]) => [
			preferred,
			fallback,
		]);
		const opus = await selectAccountsForRequest(
			makeRequestMeta({ clientSessionId: "conversation-1" }),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
		expect(
			((strategy.mock.calls[0]?.[0] ?? []) as Account[]).map(
				(account) => account.id,
			),
		).toEqual([preferred.id, fallback.id]);
	});

	it("queues a configured native Opus fallback after excluding its capacity-blocked Fable lane", async () => {
		const account = makeAccount({
			id: "capacity-native-fallback",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(account.id, weeklyScoped("Fable"));
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toEqual([]);
		expect(meta.routingCandidates).toEqual([]);
		expect(getCapacityDeferredModelRoutes(meta)).toMatchObject([
			{
				account,
				candidateId: `capacity-deferred:${account.id}:claude-opus-4-8`,
				model: "claude-opus-4-8",
				fallbackRank: 0,
			},
		]);
		expect(meta.hardExcludedAccountIds).toEqual(new Set([account.id]));
		expect(getRoutingCapacityContext(meta)?.exclusions).toMatchObject([
			{
				accountId: account.id,
				model: "claude-fable-5",
				modelFamily: "fable",
			},
		]);
	});

	it("queues fallbacks only for available capacity-blocked accounts", async () => {
		const exhausted = makeAccount({
			id: "capacity-active-exhausted",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const paused = makeAccount({
			id: "capacity-paused",
			paused: true,
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(exhausted.id, weeklyScoped("Fable"));
		cacheUsage(paused.id, weeklyScoped("Fable"));
		const meta = makeRequestMeta();
		const ctx = makeCtx({ accounts: [exhausted, paused] });
		ctx.strategy.select = mock((accounts: Account[]) =>
			accounts.filter((account) => !account.paused),
		);

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toEqual([]);
		expect(meta.routingCandidates).toEqual([]);
		expect(
			getCapacityDeferredModelRoutes(meta).map(({ account, model }) => ({
				accountId: account.id,
				model,
			})),
		).toEqual([
			{
				accountId: exhausted.id,
				model: "claude-opus-4-8",
			},
		]);
	});

	it("preserves every capacity-clear model in the original mapping tail", async () => {
		const account = makeAccount({
			id: "capacity-full-tail",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-5"],
			}),
		});
		cacheUsage(account.id, weeklyScoped("Fable"));
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account] }),
			"claude-fable-5",
		);

		expect(result).toEqual([]);
		expect(
			getCapacityDeferredModelRoutes(meta).map(({ model, fallbackRank }) => ({
				model,
				fallbackRank,
			})),
		).toEqual([
			{ model: "claude-opus-4-8", fallbackRank: 0 },
			{ model: "claude-sonnet-4-5", fallbackRank: 1 },
		]);
	});

	it("records a blocked fallback model while preserving a later clear route", async () => {
		const account = makeAccount({
			id: "capacity-partial-tail",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-5"],
			}),
		});
		cacheUsage(account.id, {
			spend: { enabled: false },
			limits: [...weeklyScoped("Fable").limits, ...weeklyScoped("Opus").limits],
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account] }),
			"claude-fable-5",
		);

		expect(result).toEqual([]);
		expect(getCapacityDeferredModelRoutes(meta)).toMatchObject([
			{ account, model: "claude-sonnet-4-5", fallbackRank: 1 },
		]);
		expect(
			getRoutingCapacityContext(meta)?.exclusions.map(
				(exclusion) => exclusion.model,
			),
		).toEqual(["claude-fable-5", "claude-opus-4-8"]);
	});

	it("counts blocked mapped models when assigning family occurrences", async () => {
		const account = makeAccount({
			id: "capacity-blocked-family-occurrence",
			model_mappings: JSON.stringify({
				fable: [
					"claude-fable-5",
					"claude-opus-4-8",
					"claude-sonnet-4-5",
					"claude-opus-5",
				],
			}),
		});
		cacheUsage(account.id, weeklyScoped("Fable"));
		usageCache.markModelScopedExhausted(
			account.id,
			"claude-opus-4-8",
			"",
			Date.now() + 60_000,
		);
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account] }),
			"claude-fable-5",
		);

		expect(result).toEqual([]);
		expect(
			getCapacityDeferredModelRoutes(meta).map(
				({ model, fallbackRank, familyOccurrence }) => ({
					model,
					fallbackRank,
					familyOccurrence,
				}),
			),
		).toEqual([
			{
				model: "claude-sonnet-4-5",
				fallbackRank: 1,
				familyOccurrence: 0,
			},
			{
				model: "claude-opus-5",
				fallbackRank: 2,
				familyOccurrence: 1,
			},
		]);
	});

	it("resets a deferred plan when the same RequestMeta is selected again", async () => {
		const account = makeAccount({
			id: "capacity-plan-reuse",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(account.id, weeklyScoped("Fable"));
		const meta = makeRequestMeta();
		const ctx = makeCtx({ accounts: [account] });

		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[],
		);
		expect(getCapacityDeferredModelRoutes(meta)).toHaveLength(1);

		usageCache.delete(account.id);
		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[account],
		);
		expect(getCapacityDeferredModelRoutes(meta)).toEqual([]);
	});

	it("clears a prepared deferred plan when strategy selection throws", async () => {
		const account = makeAccount({
			id: "capacity-plan-error",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(account.id, weeklyScoped("Fable"));
		const meta = makeRequestMeta();
		const ctx = makeCtx({ accounts: [account] });
		ctx.strategy.select = mock(() => {
			throw new Error("selection failed");
		});

		expect(await selectAccountsForRequest(meta, ctx, "claude-fable-5")).toEqual(
			[],
		);
		expect(getCapacityDeferredModelRoutes(meta)).toEqual([]);
	});

	it("applies provider exclusions before a healthy account can suppress an allowed fallback", async () => {
		const excludedHealthy = makeAccount({
			id: "excluded-healthy",
			provider: "anthropic",
			refresh_token: "oauth-refresh",
		});
		const allowedBlocked = makeAccount({
			id: "allowed-blocked",
			provider: "test-provider" as Account["provider"],
			refresh_token: null,
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(allowedBlocked.id, weeklyScoped("Fable"));
		const ctx = makeCtx({ accounts: [excludedHealthy, allowedBlocked] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-exclude-providers": "anthropic-oauth",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result).toEqual([]);
		expect(ctx.strategy.select).toHaveBeenCalledWith([], meta);
		expect(meta.routingCandidateCatalog).toMatchObject([
			{ accountId: allowedBlocked.id },
		]);
		expect(getCapacityDeferredModelRoutes(meta)).toMatchObject([
			{ account: allowedBlocked, model: "claude-opus-4-8" },
		]);
	});

	it("keeps the account excluded when its configured Opus fallback is also capacity-blocked", async () => {
		const account = makeAccount({
			id: "capacity-fallback-blocked",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(account.id, {
			spend: { enabled: false },
			limits: [...weeklyScoped("Fable").limits, ...weeklyScoped("Opus").limits],
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account] }),
			"claude-fable-5",
		);

		expect(result).toEqual([]);
		expect(meta.hardExcludedAccountIds).toEqual(new Set([account.id]));
		expect(getCapacityDeferredModelRoutes(meta)).toEqual([]);
		expect(
			getRoutingCapacityContext(meta)?.exclusions.map(
				(exclusion) => exclusion.model,
			),
		).toEqual(["claude-fable-5", "claude-opus-4-8"]);
	});

	it("does not promote a model fallback through an account-wide capacity blocker", async () => {
		const account = makeAccount({
			id: "capacity-account-wide",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		cacheUsage(account.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					is_active: true,
				},
			],
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			makeCtx({ accounts: [account] }),
			"claude-fable-5",
		);

		expect(result).toEqual([]);
		expect(meta.hardExcludedAccountIds).toEqual(new Set([account.id]));
		expect(getCapacityDeferredModelRoutes(meta)).toEqual([]);
	});

	it("fails open for a 100% weekly-scoped cap whose family is unknown", async () => {
		const account = makeAccount({ id: "capacity-unknown-scope" });
		cacheUsage(account.id, weeklyScoped(null));
		const ctx = makeCtx({ accounts: [account] });

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-fable-5",
		);

		expect(result).toEqual([account]);
	});

	it("fails a forced exhausted model lane closed without substituting another account", async () => {
		const forced = makeAccount({
			id: "forced-capacity",
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8"],
			}),
		});
		const substitute = makeAccount({ id: "forced-substitute" });
		cacheUsage(forced.id, weeklyScoped("Fable"));
		const ctx = makeCtx({ accounts: [forced, substitute] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": forced.id,
			}),
		});

		try {
			await selectAccountsForRequest(meta, ctx, "claude-fable-5");
			expect.unreachable("expected force-route capacity failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ForceRouteUnavailableError);
			expect((error as ForceRouteUnavailableError).accountId).toBe(forced.id);
			expect((error as ForceRouteUnavailableError).reason).toBe(
				"model_capacity_exhausted",
			);
		}
		expect(ctx.strategy.select).not.toHaveBeenCalled();
		expect(getRoutingCapacityContext(meta)?.exclusions[0]?.accountId).toBe(
			forced.id,
		);

		const opus = await selectAccountsForRequest(
			makeRequestMeta({
				headers: new Headers({
					"x-better-ccflare-account-id": forced.id,
				}),
			}),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus).toEqual([forced]);
	});

	it("still enforces hard model capacity for an authenticated internal probe", async () => {
		const forced = makeAccount({
			id: "forced-refresh-capacity",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		cacheUsage(forced.id, weeklyScoped("Fable"));
		const ctx = makeCtx({ accounts: [forced] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-better-ccflare-account-id": forced.id,
				"x-better-ccflare-bypass-session": "true",
				"x-better-ccflare-auto-refresh": "true",
			}),
			trustedInternalAutoRefresh: true,
		});

		await expect(
			selectAccountsForRequest(meta, ctx, "claude-fable-5"),
		).rejects.toMatchObject({
			accountId: forced.id,
			reason: "model_capacity_exhausted",
		});
	});

	it("uses exact reactive model+beta evidence across normal routing and leaves Opus usable", async () => {
		const preferred = makeAccount({ id: "reactive-preferred", priority: 0 });
		const fallback = makeAccount({ id: "reactive-fallback", priority: 1 });
		usageCache.markModelScopedExhausted(
			preferred.id,
			"claude-fable-5",
			"beta-b,context-1m",
			Date.now() + 60_000,
		);
		cachedUsageAccountIds.add(preferred.id);
		const ctx = makeCtx({ accounts: [preferred, fallback] });
		const fableMeta = makeRequestMeta({
			headers: new Headers({
				"anthropic-beta": "CONTEXT-1M, beta-b",
			}),
		});

		const fable = await selectAccountsForRequest(
			fableMeta,
			ctx,
			"claude-fable-5",
		);
		expect(fable.map((account) => account.id)).toEqual([fallback.id]);
		expect(
			getRoutingCapacityContext(fableMeta)?.exclusions[0]?.exclusions[0]
				?.source,
		).toBe("reactive_marker");

		const opus = await selectAccountsForRequest(
			makeRequestMeta({
				headers: new Headers({
					"anthropic-beta": "beta-b,context-1m",
				}),
			}),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
	});

	it("bypasses reactive markers only for explicit synthetic probes while preserving snapshot blockers", async () => {
		const account = makeAccount({ id: "synthetic-capacity" });
		const headers = new Headers({
			"x-better-ccflare-account-id": account.id,
		});
		usageCache.markFamilyScopedExhausted(
			account.id,
			"claude-fable-5",
			Date.now() + 60_000,
		);
		cachedUsageAccountIds.add(account.id);
		const ctx = makeCtx({ accounts: [account] });

		await expect(
			selectAccountsForRequest(
				makeRequestMeta({ headers }),
				ctx,
				"claude-fable-5",
			),
		).rejects.toMatchObject({ reason: "model_capacity_exhausted" });

		const synthetic = await selectAccountsForRequest(
			makeRequestMeta({ headers: new Headers(headers) }),
			ctx,
			"claude-fable-5",
			{ syntheticProbe: true },
		);
		expect(synthetic).toEqual([account]);

		cacheUsage(account.id, weeklyScoped("Fable"));
		await expect(
			selectAccountsForRequest(
				makeRequestMeta({ headers: new Headers(headers) }),
				ctx,
				"claude-fable-5",
				{ syntheticProbe: true },
			),
		).rejects.toMatchObject({ reason: "model_capacity_exhausted" });
	});

	it("uses inferred family evidence for every Fable version while leaving Opus usable", async () => {
		const preferred = makeAccount({
			id: "reactive-family-preferred",
			priority: 0,
		});
		const fallback = makeAccount({
			id: "reactive-family-fallback",
			priority: 1,
		});
		usageCache.markFamilyScopedExhausted(
			preferred.id,
			"claude-fable-5",
			Date.now() + 60_000,
		);
		cachedUsageAccountIds.add(preferred.id);
		const ctx = makeCtx({ accounts: [preferred, fallback] });
		const fableMeta = makeRequestMeta();

		const fable = await selectAccountsForRequest(
			fableMeta,
			ctx,
			"claude-fable-5-20260701",
		);
		expect(fable.map((account) => account.id)).toEqual([fallback.id]);
		expect(
			getRoutingCapacityContext(fableMeta)?.exclusions[0]?.exclusions[0],
		).toMatchObject({
			source: "reactive_marker",
			scope: "family",
			window: "reactive_family",
			modelFamily: "fable",
		});

		const opus = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-8",
		);
		expect(opus.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
	});

	it("keeps exact model+beta evidence ahead of a matching family marker", () => {
		const accountId = "reactive-exact-precedence";
		const now = Date.now();
		usageCache.markModelScopedExhausted(
			accountId,
			"claude-fable-5",
			"beta-a",
			now + 30_000,
		);
		usageCache.markFamilyScopedExhausted(
			accountId,
			"claude-fable-5",
			now + 60_000,
		);
		cachedUsageAccountIds.add(accountId);

		expect(
			getReactiveModelCapacityBlocker(
				accountId,
				"claude-fable-5",
				"beta-a",
				now,
			),
		).toMatchObject({
			scope: "model",
			window: "reactive_model",
			evidenceExpiresAt: now + 30_000,
		});
	});

	it("preserves legacy selection when no concrete model is available", async () => {
		const account = makeAccount({ id: "capacity-no-model" });
		cacheUsage(account.id, {
			limits: [
				{
					kind: "session",
					percent: 100,
					resets_at: new Date(Date.now() + 60_000).toISOString(),
					scope: null,
				},
			],
		});
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();

		expect(await selectAccountsForRequest(meta, ctx)).toEqual([account]);
		expect(meta.hardExcludedAccountIds).toBeNull();
		expect(meta.affinityLaneKey).toBeNull();
	});
});

describe("selectAccountsForRequest — lane identity and quota pressure", () => {
	function weeklyAll(
		percent: number,
		hoursUntilReset: number,
	): Record<string, unknown> {
		return {
			limits: [
				{
					kind: "weekly_all",
					percent,
					resets_at: new Date(
						Date.now() + hoursUntilReset * 60 * 60 * 1000,
					).toISOString(),
					scope: null,
				},
			],
		};
	}

	it("isolates Fable and Opus affinity while canonicalizing client beta order", async () => {
		const account = makeAccount({ id: "lane-account" });
		const ctx = makeCtx({ accounts: [account] });
		const fableA = makeRequestMeta({
			clientSessionId: "conversation-2",
			headers: new Headers({
				"anthropic-beta": "context-1m, beta-b,context-1m",
			}),
		});
		const fableB = makeRequestMeta({
			clientSessionId: "conversation-2",
			headers: new Headers({
				"anthropic-beta": "BETA-B, context-1m",
			}),
		});
		const opus = makeRequestMeta({
			clientSessionId: "conversation-2",
			headers: new Headers({
				"anthropic-beta": "context-1m,beta-b",
			}),
		});

		await selectAccountsForRequest(fableA, ctx, "claude-fable-5");
		await selectAccountsForRequest(fableB, ctx, "claude-fable-5");
		await selectAccountsForRequest(opus, ctx, "claude-opus-4-8");

		expect(fableA.affinityLaneKey).toBe(fableB.affinityLaneKey);
		expect(fableA.affinityLaneKey).not.toBe(opus.affinityLaneKey);
		expect(fableA.affinityLaneKey).toContain("/v1/messages");
		expect(fableA.affinityLaneKey).toContain("fable");
	});

	it("preserves the legacy lane tuple and namespaces profile lanes separately", () => {
		const ordinary = makeRequestMeta({
			clientSessionId: "conversation-legacy",
			headers: new Headers({ "anthropic-beta": "beta-b, context-1m" }),
		});
		const ordinaryLane = deriveAffinityLaneKey(ordinary, "claude-opus-4-8");
		expect(ordinaryLane).not.toBeNull();
		expect(JSON.parse(ordinaryLane as string)).toEqual([
			"routing-lane-v1",
			"conversation-legacy",
			"messages",
			"/v1/messages",
			"opus",
			"claude-opus-4-8",
			"beta-b,context-1m",
		]);

		const profiledLane = deriveAffinityLaneKey(
			{ ...ordinary, routeProfileId: "gpt-sol-capability" },
			"claude-opus-4-8",
		);
		expect(JSON.parse(profiledLane as string)).toEqual([
			"routing-lane-profile-v1",
			"gpt-sol-capability",
			"conversation-legacy",
			"messages",
			"/v1/messages",
			"opus",
			"claude-opus-4-8",
			"beta-b,context-1m",
		]);
	});

	it("derives comparable quota metadata for OAuth subscription accounts with null billing_type", async () => {
		const urgent = makeAccount({
			id: "pressure-urgent",
			priority: 0,
			billing_type: null,
			refresh_token: "oauth-token-a",
		});
		const steady = makeAccount({
			id: "pressure-steady",
			priority: 0,
			billing_type: null,
			refresh_token: "oauth-token-b",
		});
		cacheUsage(urgent.id, weeklyAll(90, 2));
		cacheUsage(steady.id, weeklyAll(50, 200));
		const ctx = makeCtx({ accounts: [urgent, steady] });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		const urgentPressure = meta.quotaPressureByAccountId?.get(urgent.id);
		const steadyPressure = meta.quotaPressureByAccountId?.get(steady.id);
		expect(urgentPressure?.band).toBe("critical");
		expect(steadyPressure?.band).toBe("steady");
		expect(urgentPressure?.comparisonKey).not.toBeNull();
		expect(urgentPressure?.comparisonKey).toBe(steadyPressure?.comparisonKey);
	});

	it("does not invent a pressure comparison class for an unclassified API-key account", async () => {
		const account = makeAccount({
			id: "pressure-api-unknown",
			billing_type: null,
			refresh_token: "",
			api_key: "secret",
		});
		cacheUsage(account.id, weeklyAll(80, 20));
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(
			meta.quotaPressureByAccountId?.get(account.id)?.comparisonKey,
		).toBeNull();
	});
});

describe("selectAccountsForRequest — atomic combo capacity", () => {
	it("flows eligible combo candidates through the configured strategy atomically", async () => {
		const first = makeAccount({ id: "combo-first", priority: 99 });
		const second = makeAccount({ id: "combo-second", priority: 0 });
		const combo = makeCombo([
			{
				id: "slot-first",
				combo_id: "combo-1",
				account_id: first.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-second",
				combo_id: "combo-1",
				account_id: second.id,
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [first, second], activeCombo: combo });
		ctx.strategy.select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(
				meta.routingCandidates?.map((candidate) => candidate.candidateId),
			).toEqual([
				"combo:combo-1:slot:slot-first",
				"combo:combo-1:slot:slot-second",
			]);
			meta.routingCandidates = [...(meta.routingCandidates ?? [])].reverse();
			return [...accounts].reverse();
		});
		const meta = makeRequestMeta({
			clientSessionId: "conversation-1",
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(ctx.strategy.select).toHaveBeenCalledTimes(1);
		expect(result.map((account) => account.id)).toEqual([second.id, first.id]);
		expect(
			meta.routingCandidates?.map((candidate) => candidate.comboSlotId),
		).toEqual(["slot-second", "slot-first"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: second.id, modelOverride: "claude-opus-4-5" },
			{ accountId: first.id, modelOverride: "claude-opus-4-8" },
		]);
	});

	it("reconciles a custom account-only strategy by unused occurrence", async () => {
		const first = makeAccount({ id: "custom-first" });
		const second = makeAccount({ id: "custom-second" });
		const combo = makeCombo([
			{
				id: "custom-slot-first",
				combo_id: "combo-1",
				account_id: first.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "custom-slot-second",
				combo_id: "combo-1",
				account_id: second.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [first, second], activeCombo: combo });
		ctx.strategy.select = mock((accounts: Account[]) =>
			[...accounts].reverse(),
		);
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((account) => account.id)).toEqual([second.id, first.id]);
		expect(
			meta.routingCandidates?.map((candidate) => candidate.comboSlotId),
		).toEqual(["custom-slot-second", "custom-slot-first"]);
	});

	it("removes only an exhausted duplicate-account slot and keeps each model sidecar aligned", async () => {
		const preferred = makeAccount({ id: "combo-preferred", priority: 0 });
		const fallback = makeAccount({ id: "combo-fallback", priority: 1 });
		cacheUsage(preferred.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					scope: {
						model: { id: null, display_name: "Fable" },
						surface: null,
					},
				},
			],
		});
		const combo = makeCombo([
			{
				id: "slot-preferred-fable",
				combo_id: "combo-1",
				account_id: preferred.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-preferred-opus",
				combo_id: "combo-1",
				account_id: preferred.id,
				model: "claude-opus-4-8",
				priority: 1,
				enabled: true,
			},
			{
				id: "slot-fallback-fable",
				combo_id: "combo-1",
				account_id: fallback.id,
				model: "claude-fable-5",
				priority: 2,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [preferred, fallback],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-fable-5");

		expect(result.map((account) => account.id)).toEqual([
			preferred.id,
			fallback.id,
		]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{
				accountId: preferred.id,
				modelOverride: "claude-opus-4-8",
			},
			{
				accountId: fallback.id,
				modelOverride: "claude-fable-5",
			},
		]);
		expect(
			meta.routingCandidates?.map(
				({ comboSlotId, accountId, modelOverride, tier, ordinal }) => ({
					comboSlotId,
					accountId,
					modelOverride,
					tier,
					ordinal,
				}),
			),
		).toEqual([
			{
				comboSlotId: "slot-preferred-opus",
				accountId: preferred.id,
				modelOverride: "claude-opus-4-8",
				tier: 1,
				ordinal: 1,
			},
			{
				comboSlotId: "slot-fallback-fable",
				accountId: fallback.id,
				modelOverride: "claude-fable-5",
				tier: 2,
				ordinal: 2,
			},
		]);
		expect(getRoutingCapacityContext(meta)?.exclusions).toMatchObject([
			{
				accountId: preferred.id,
				model: "claude-fable-5",
				modelFamily: "fable",
			},
		]);
	});

	it("uses slot priority and repository order independently of account priority", async () => {
		const accountHigh = makeAccount({ id: "combo-account-high", priority: 9 });
		const accountLow = makeAccount({ id: "combo-account-low", priority: 0 });
		const combo = makeCombo([
			{
				id: "slot-high-late-tier",
				combo_id: "combo-1",
				account_id: accountHigh.id,
				model: "claude-opus-4-8",
				priority: 2,
				enabled: true,
			},
			{
				id: "slot-low-first-in-tier",
				combo_id: "combo-1",
				account_id: accountLow.id,
				model: "claude-opus-4-8",
				priority: 1,
				enabled: true,
			},
			{
				id: "slot-high-second-in-tier",
				combo_id: "combo-1",
				account_id: accountHigh.id,
				model: "claude-opus-4-5",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [accountHigh, accountLow],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result.map((account) => account.id)).toEqual([
			accountHigh.id,
			accountLow.id,
			accountHigh.id,
		]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-5",
			},
			{
				accountId: accountLow.id,
				modelOverride: "claude-opus-4-8",
			},
			{
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-8",
			},
		]);
		expect(
			meta.routingCandidates?.map(
				({ comboSlotId, accountId, modelOverride, tier, ordinal }) => ({
					comboSlotId,
					accountId,
					modelOverride,
					tier,
					ordinal,
				}),
			),
		).toEqual([
			{
				comboSlotId: "slot-high-second-in-tier",
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-5",
				tier: 1,
				ordinal: 0,
			},
			{
				comboSlotId: "slot-low-first-in-tier",
				accountId: accountLow.id,
				modelOverride: "claude-opus-4-8",
				tier: 1,
				ordinal: 1,
			},
			{
				comboSlotId: "slot-high-late-tier",
				accountId: accountHigh.id,
				modelOverride: "claude-opus-4-8",
				tier: 2,
				ordinal: 2,
			},
		]);
	});

	it("uses only same-family quota pressure inside an equal slot tier", async () => {
		const expiringFable = makeAccount({
			id: "combo-expiring-fable",
			priority: 99,
		});
		const expiringOpus = makeAccount({
			id: "combo-expiring-opus",
			priority: 0,
		});
		const resetAt = (hours: number) =>
			new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
		const scoped = (displayName: string, percent: number, hours: number) => ({
			kind: "weekly_scoped",
			percent,
			resets_at: resetAt(hours),
			scope: {
				model: { id: null, display_name: displayName },
				surface: null,
			},
		});
		cacheUsage(expiringFable.id, {
			limits: [scoped("Fable", 90, 2), scoped("Opus", 10, 200)],
		});
		cacheUsage(expiringOpus.id, {
			limits: [scoped("Fable", 50, 200), scoped("Opus", 90, 2)],
		});
		const combo = makeCombo([
			{
				id: "slot-opus-pressure-first",
				combo_id: "combo-1",
				account_id: expiringOpus.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-fable-pressure-second",
				combo_id: "combo-1",
				account_id: expiringFable.id,
				model: "claude-fable-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [expiringFable, expiringOpus],
			activeCombo: combo,
		});

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-fable-5",
		);

		// Fable pressure outranks repository order. Account.priority and the
		// opposite Opus scoped pressure must not participate in this lane.
		expect(result.map((account) => account.id)).toEqual([
			expiringFable.id,
			expiringOpus.id,
		]);
	});
});

describe("selectAccountsForRequest — server-tool capability-first routing", () => {
	function blockedFableCapacity() {
		return {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					scope: {
						model: { id: null, display_name: "Fable" },
						surface: null,
					},
				},
			],
		};
	}

	it("does not allocate capability metadata or call capability hooks for ordinary requests", async () => {
		const providerName = "u4-ordinary-provider";
		const onTuple = mock((_context: CapabilityProviderContext) => {});
		installCapabilityProvider({
			name: providerName,
			decision: provenDecision,
			onTuple,
		});
		const account = makeAccount({ id: "ordinary", provider: providerName });
		const ctx = makeCtx({ accounts: [account] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result).toEqual([account]);
		expect(onTuple).not.toHaveBeenCalled();
		expect(meta.serverToolCapabilitySummary).toBeUndefined();
		expect(meta.routingCandidateCatalog).toEqual([
			{
				candidateId: "account:ordinary",
				accountId: "ordinary",
				tier: 0,
				ordinal: 0,
				comboSlotId: null,
				modelOverride: "claude-opus-4-8",
				quotaPressure: null,
			},
		]);
		expect(
			Object.hasOwn(
				meta.routingCandidateCatalog?.[0] ?? {},
				"serverToolCapability",
			),
		).toBe(false);
	});

	it("removes request-excluded providers before capability evaluation and terminal classification", async () => {
		const excludedProvider = "u4-request-excluded-proven";
		const excludedTuple = mock((_context: CapabilityProviderContext) => {});
		installCapabilityProvider({
			name: excludedProvider,
			decision: provenDecision,
			onTuple: excludedTuple,
		});
		const includedProvider = "u4-request-included-unknown";
		const includedTuple = mock((_context: CapabilityProviderContext) => {});
		installCapabilityProvider({
			name: includedProvider,
			decision: () => ({ decision: "unknown", reason: "no_exact_proof" }),
			onTuple: includedTuple,
		});
		const excluded = makeAccount({
			id: "excluded-proven",
			provider: excludedProvider,
			model_mappings: JSON.stringify({ opus: "physical-excluded" }),
		});
		const included = makeAccount({
			id: "included-unknown",
			provider: includedProvider,
			model_mappings: JSON.stringify({ opus: "physical-included" }),
		});
		const ctx = makeCtx({ accounts: [excluded, included] });
		const meta = serverToolMeta({
			headers: new Headers({
				"x-better-ccflare-exclude-providers": excludedProvider,
			}),
		});

		try {
			await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
			expect.unreachable("expected local no-implementation terminal");
		} catch (error) {
			expect(error).toMatchObject({
				name: "ServerToolRoutingError",
				reason: "no_implementation",
			});
		}
		expect(excludedTuple).not.toHaveBeenCalled();
		expect(includedTuple).toHaveBeenCalledTimes(1);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
		expect(
			meta.routingCandidateCatalog?.map(({ accountId }) => accountId),
		).toEqual([included.id]);
		expect(meta.serverToolCapabilitySummary).toEqual({
			structuralCandidateCount: 1,
			provenCandidateCount: 0,
			unsupportedCandidateCount: 0,
			unknownCandidateCount: 1,
			replayIneligibleCandidateCount: 0,
			temporarilyUnavailableProvenCandidateCount: 0,
			eligibleCandidateCount: 0,
		});
	});

	for (const firstTailDecision of ["unsupported", "unknown"] as const) {
		it(`queues only the proven exact fallback after an ${firstTailDecision} capacity tail`, async () => {
			const providerName = `u4-capacity-tail-${firstTailDecision}`;
			const tupleContexts: CapabilityProviderContext[] = [];
			installCapabilityProvider({
				name: providerName,
				onTuple: (context) => tupleContexts.push(context),
				decision: (_context, tuple) => {
					if (tuple.model !== "claude-opus-4-8") {
						return provenDecision(_context, tuple);
					}
					return firstTailDecision === "unsupported"
						? {
								decision: "unsupported",
								proof: proofFor(tuple, "unsupported"),
							}
						: { decision: "unknown", reason: "no_exact_proof" };
				},
			});
			const account = makeAccount({
				id: `capacity-tail-${firstTailDecision}`,
				provider: providerName,
				model_mappings: JSON.stringify({
					fable: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-5"],
					opus: "must-not-remap-opus",
					sonnet: "must-not-remap-sonnet",
				}),
			});
			cacheUsage(account.id, {
				spend: { enabled: false },
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
						scope: {
							model: { id: null, display_name: "Fable" },
							surface: null,
						},
					},
				],
			});
			const ctx = makeCtx({ accounts: [account] });
			const meta = serverToolMeta();

			const result = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-fable-5",
			);

			const firstTailId = `capacity-deferred:${account.id}:claude-opus-4-8`;
			const provenTailId = `capacity-deferred:${account.id}:claude-sonnet-4-5`;
			expect(result).toEqual([]);
			expect(ctx.strategy.select).toHaveBeenCalledWith([account], meta);
			expect(getCapacityDeferredModelRoutes(meta)).toMatchObject([
				{
					account,
					candidateId: provenTailId,
					model: "claude-sonnet-4-5",
					fallbackRank: 1,
				},
			]);
			expect(
				meta.routingCandidateCatalog?.map((candidate) => ({
					candidateId: candidate.candidateId,
					decision: candidate.serverToolCapability?.decision,
					physicalModel: candidate.serverToolCapability?.physicalModel,
				})),
			).toEqual([
				{
					candidateId: `account:${account.id}`,
					decision: "proven",
					physicalModel: "claude-fable-5",
				},
				{
					candidateId: firstTailId,
					decision: firstTailDecision,
					physicalModel: "claude-opus-4-8",
				},
				{
					candidateId: provenTailId,
					decision: "proven",
					physicalModel: "claude-sonnet-4-5",
				},
			]);
			expect(meta.serverToolCapabilitySummary).toEqual({
				structuralCandidateCount: 3,
				provenCandidateCount: 2,
				unsupportedCandidateCount: firstTailDecision === "unsupported" ? 1 : 0,
				unknownCandidateCount: firstTailDecision === "unknown" ? 1 : 0,
				replayIneligibleCandidateCount: 0,
				temporarilyUnavailableProvenCandidateCount: 1,
				eligibleCandidateCount: 1,
			});
			expect(tupleContexts.map(({ physicalModel }) => physicalModel)).toEqual([
				"claude-fable-5",
				"claude-opus-4-8",
				"claude-sonnet-4-5",
			]);
		});
	}

	it("filters higher-priority and sticky incapable candidates before strategy ordering", async () => {
		const providerName = "u4-normal-provider";
		installCapabilityProvider({
			name: providerName,
			decision: (_context, tuple) =>
				tuple.candidateId.includes("incapable")
					? {
							decision: "unsupported",
							proof: proofFor(tuple, "unsupported"),
						}
					: provenDecision(_context, tuple),
		});
		const incapable = makeAccount({
			id: "incapable",
			provider: providerName,
			priority: 0,
			model_mappings: JSON.stringify({ opus: "physical-incapable" }),
		});
		const capable = makeAccount({
			id: "capable",
			provider: providerName,
			priority: 1,
			model_mappings: JSON.stringify({ opus: "physical-capable" }),
		});
		const ctx = makeCtx({ accounts: [incapable, capable] });
		ctx.strategy.select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(accounts).toEqual([capable]);
			expect(
				meta.routingCandidates?.map(({ candidateId }) => candidateId),
			).toEqual(["account:capable"]);
			return accounts;
		});
		const meta = serverToolMeta({
			affinityOwnerSnapshot: {
				candidateId: "account:incapable",
				accountId: incapable.id,
			},
		});

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result).toEqual([capable]);
		expect(meta.hardExcludedAccountIds).toBeNull();
		expect(
			meta.routingCandidateCatalog?.map((candidate) => ({
				candidateId: candidate.candidateId,
				decision: candidate.serverToolCapability?.decision,
				physicalModel: candidate.serverToolCapability?.physicalModel,
			})),
		).toEqual([
			{
				candidateId: "account:incapable",
				decision: "unsupported",
				physicalModel: "physical-incapable",
			},
			{
				candidateId: "account:capable",
				decision: "proven",
				physicalModel: "physical-capable",
			},
		]);
		expect(meta.serverToolCapabilitySummary).toEqual({
			structuralCandidateCount: 2,
			provenCandidateCount: 1,
			unsupportedCandidateCount: 1,
			unknownCandidateCount: 0,
			replayIneligibleCandidateCount: 0,
			temporarilyUnavailableProvenCandidateCount: 0,
			eligibleCandidateCount: 1,
		});
		const proof = meta.routingCandidates?.[0]?.serverToolCapability;
		expect(proof?.proofKey).toBeString();
		expect(proof?.inputReplayMode).toEqual([]);
		expect(proof?.outputReplayMode).toEqual(["native-Anthropic"]);
		expect(Object.isFrozen(proof)).toBe(true);
		expect(Object.isFrozen(proof?.outputReplayMode)).toBe(true);
	});

	it("lets a proven expired overage pause reach SessionStrategy auto-resume", async () => {
		const previous = installCapabilityProvider({
			name: "anthropic",
			decision: provenDecision,
		});
		try {
			const account = makeAccount({
				id: "normal-overage-resume",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: Date.now() - 5_000,
				rate_limited_until: Date.now() - 5_000,
				model_mappings: JSON.stringify({ opus: "physical-overage" }),
			});
			const ctx = makeCtx({ accounts: [account] });
			const { resumeAccount } = useSessionStrategy(ctx);
			const meta = serverToolMeta();

			const result = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-opus-4-8",
			);

			expect(resumeAccount).toHaveBeenCalledTimes(1);
			expect(resumeAccount).toHaveBeenCalledWith(account.id);
			expect(account.paused).toBe(false);
			expect(result).toEqual([account]);
			expect(
				meta.routingCandidates?.map(
					({ candidateId, serverToolCapability }) => ({
						candidateId,
						decision: serverToolCapability?.decision,
						proofKey: serverToolCapability?.proofKey,
					}),
				),
			).toEqual([
				{
					candidateId: `account:${account.id}`,
					decision: "proven",
					proofKey: expect.any(String),
				},
			]);
			expect(meta.serverToolCapabilitySummary).toMatchObject({
				provenCandidateCount: 1,
				temporarilyUnavailableProvenCandidateCount: 0,
				eligibleCandidateCount: 1,
			});
		} finally {
			if (previous) registerProvider(previous);
		}
	});

	it("does not publish a clear capacity fallback for a proven non-resumable pause", async () => {
		const previous = installCapabilityProvider({
			name: "anthropic",
			decision: provenDecision,
		});
		try {
			const account = makeAccount({
				id: "capacity-manual-no-resume",
				paused: true,
				pause_reason: "manual",
				auto_fallback_enabled: true,
				rate_limit_reset: Date.now() - 5_000,
				rate_limited_until: Date.now() - 5_000,
				model_mappings: JSON.stringify({
					fable: ["claude-fable-5", "claude-opus-4-8"],
				}),
			});
			cacheUsage(account.id, blockedFableCapacity());
			const ctx = makeCtx({ accounts: [account] });
			const { resumeAccount } = useSessionStrategy(ctx);
			const meta = serverToolMeta();

			await expect(
				selectAccountsForRequest(meta, ctx, "claude-fable-5"),
			).rejects.toMatchObject({
				name: "ServerToolRoutingError",
				reason: "temporary_unavailable",
			});
			expect(resumeAccount).not.toHaveBeenCalled();
			expect(account.paused).toBe(true);
			expect(getCapacityDeferredModelRoutes(meta)).toEqual([]);
			expect(meta.routingCandidates).toEqual([]);
			expect(
				meta.routingCandidateCatalog?.map(({ candidateId }) => candidateId),
			).toEqual([`account:${account.id}`]);
			expect(meta.serverToolCapabilitySummary).toMatchObject({
				structuralCandidateCount: 1,
				provenCandidateCount: 1,
				temporarilyUnavailableProvenCandidateCount: 1,
				eligibleCandidateCount: 0,
			});
		} finally {
			if (previous) registerProvider(previous);
		}
	});

	it("resumes a reset-qualified paused account before publishing its clear capacity fallback", async () => {
		const previous = installCapabilityProvider({
			name: "anthropic",
			decision: provenDecision,
		});
		try {
			const account = makeAccount({
				id: "capacity-overage-resume",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: Date.now() - 5_000,
				rate_limited_until: Date.now() - 5_000,
				model_mappings: JSON.stringify({
					fable: ["claude-fable-5", "claude-opus-4-8"],
				}),
			});
			cacheUsage(account.id, blockedFableCapacity());
			const ctx = makeCtx({ accounts: [account] });
			const { resumeAccount } = useSessionStrategy(ctx);
			const meta = serverToolMeta();

			const result = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-fable-5",
			);

			expect(resumeAccount).toHaveBeenCalledTimes(1);
			expect(resumeAccount).toHaveBeenCalledWith(account.id);
			expect(account.paused).toBe(false);
			expect(result).toEqual([]);
			expect(getCapacityDeferredModelRoutes(meta)).toMatchObject([
				{
					account,
					candidateId: `capacity-deferred:${account.id}:claude-opus-4-8`,
					model: "claude-opus-4-8",
					fallbackRank: 0,
				},
			]);
			expect(meta.routingCandidates).toEqual([]);
			expect(
				meta.routingCandidateCatalog?.map(({ candidateId }) => candidateId),
			).toEqual([
				`account:${account.id}`,
				`capacity-deferred:${account.id}:claude-opus-4-8`,
			]);
			expect(meta.serverToolCapabilitySummary).toMatchObject({
				structuralCandidateCount: 2,
				provenCandidateCount: 2,
				temporarilyUnavailableProvenCandidateCount: 1,
				eligibleCandidateCount: 1,
			});
		} finally {
			if (previous) registerProvider(previous);
		}
	});

	it("auto-resumes a proven rate-limit-window account across duplicate combo slots without losing sidecars", async () => {
		const previous = installCapabilityProvider({
			name: "anthropic",
			decision: provenDecision,
		});
		try {
			const account = makeAccount({
				id: "combo-rate-window-resume",
				paused: true,
				pause_reason: "rate_limit_window",
				auto_fallback_enabled: true,
				rate_limit_reset: Date.now() - 5_000,
				rate_limited_until: Date.now() - 5_000,
				model_mappings: JSON.stringify({
					"claude-opus-4-8": "physical-combo-a",
					"claude-opus-4-5": "physical-combo-b",
				}),
			});
			const combo = makeCombo([
				{
					id: "resume-slot-a",
					combo_id: "combo-1",
					account_id: account.id,
					model: "claude-opus-4-8",
					priority: 0,
					enabled: true,
				},
				{
					id: "resume-slot-b",
					combo_id: "combo-1",
					account_id: account.id,
					model: "claude-opus-4-5",
					priority: 1,
					enabled: true,
				},
			]);
			const ctx = makeCtx({ accounts: [account], activeCombo: combo });
			const { resumeAccount } = useSessionStrategy(ctx);
			const meta = serverToolMeta();

			const result = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-opus-4-8",
			);

			expect(resumeAccount).toHaveBeenCalledTimes(1);
			expect(account.paused).toBe(false);
			expect(result).toEqual([account, account]);
			expect(
				meta.routingCandidates?.map(
					({ candidateId, serverToolCapability }) => ({
						candidateId,
						decision: serverToolCapability?.decision,
						proofKey: serverToolCapability?.proofKey,
					}),
				),
			).toEqual([
				{
					candidateId: "combo:combo-1:slot:resume-slot-a",
					decision: "proven",
					proofKey: expect.any(String),
				},
				{
					candidateId: "combo:combo-1:slot:resume-slot-b",
					decision: "proven",
					proofKey: expect.any(String),
				},
			]);
			expect(getComboSlotInfo(meta)?.slots).toEqual([
				{ accountId: account.id, modelOverride: "claude-opus-4-8" },
				{ accountId: account.id, modelOverride: "claude-opus-4-5" },
			]);
			expect(meta.serverToolCapabilitySummary).toMatchObject({
				structuralCandidateCount: 2,
				provenCandidateCount: 2,
				eligibleCandidateCount: 2,
			});
		} finally {
			if (previous) registerProvider(previous);
		}
	});

	for (const pauseReason of ["manual", "failure_threshold"] as const) {
		it(`keeps a proven ${pauseReason} pause unavailable without attempting resume`, async () => {
			const previous = installCapabilityProvider({
				name: "anthropic",
				decision: provenDecision,
			});
			try {
				const account = makeAccount({
					id: `non-resumable-${pauseReason}`,
					paused: true,
					pause_reason: pauseReason,
					auto_fallback_enabled: true,
					rate_limit_reset: Date.now() - 5_000,
					rate_limited_until: Date.now() - 5_000,
					model_mappings: JSON.stringify({ opus: "physical-control" }),
				});
				const ctx = makeCtx({ accounts: [account] });
				const { resumeAccount } = useSessionStrategy(ctx);
				const meta = serverToolMeta();

				await expect(
					selectAccountsForRequest(meta, ctx, "claude-opus-4-8"),
				).rejects.toMatchObject({
					name: "ServerToolRoutingError",
					reason: "temporary_unavailable",
				});
				expect(resumeAccount).not.toHaveBeenCalled();
				expect(account.paused).toBe(true);
				expect(meta.routingCandidates).toEqual([]);
				expect(meta.serverToolCapabilitySummary).toMatchObject({
					provenCandidateCount: 1,
					temporarilyUnavailableProvenCandidateCount: 1,
					eligibleCandidateCount: 0,
				});
			} finally {
				if (previous) registerProvider(previous);
			}
		});
	}

	it("never lets an incapable reset-qualified candidate reach resume and keeps the capable proof aligned", async () => {
		const previous = installCapabilityProvider({
			name: "anthropic",
			decision: (_context, tuple) =>
				tuple.candidateId.includes("incapable-reset")
					? {
							decision: "unsupported",
							proof: proofFor(tuple, "unsupported"),
						}
					: provenDecision(_context, tuple),
		});
		try {
			const incapable = makeAccount({
				id: "incapable-reset",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: Date.now() - 5_000,
				rate_limited_until: Date.now() - 5_000,
				model_mappings: JSON.stringify({ opus: "physical-incapable" }),
			});
			const capable = makeAccount({
				id: "capable-control",
				priority: 1,
				model_mappings: JSON.stringify({ opus: "physical-capable" }),
			});
			const ctx = makeCtx({ accounts: [incapable, capable] });
			const { resumeAccount } = useSessionStrategy(ctx);
			const meta = serverToolMeta();

			const result = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-opus-4-8",
			);

			expect(resumeAccount).not.toHaveBeenCalled();
			expect(incapable.paused).toBe(true);
			expect(result).toEqual([capable]);
			expect(
				meta.routingCandidateCatalog?.map(
					({ candidateId, serverToolCapability }) => ({
						candidateId,
						decision: serverToolCapability?.decision,
					}),
				),
			).toEqual([
				{ candidateId: `account:${incapable.id}`, decision: "unsupported" },
				{ candidateId: `account:${capable.id}`, decision: "proven" },
			]);
			expect(meta.routingCandidates).toHaveLength(1);
			expect(meta.routingCandidates?.[0]).toMatchObject({
				candidateId: `account:${capable.id}`,
				accountId: capable.id,
				serverToolCapability: {
					decision: "proven",
					proofKey: expect.any(String),
				},
			});
		} finally {
			if (previous) registerProvider(previous);
		}
	});

	it("fails malformed, mismatched, thenable, and throwing resolver results closed", async () => {
		const badCases = [
			"proof-decision-mismatch",
			"proof-tuple-mismatch",
			"thenable",
			"throwing",
		] as const;
		const accounts = badCases.map((kind, priority) => {
			const providerName = `u4-invalid-resolver-${kind}`;
			installCapabilityProvider({
				name: providerName,
				decision: (_context, tuple) => {
					if (kind === "throwing") throw new Error("resolver failed");
					if (kind === "proof-decision-mismatch") {
						return {
							decision: "proven",
							proof: proofFor(tuple, "unsupported"),
						};
					}
					if (kind === "proof-tuple-mismatch") {
						return {
							decision: "proven",
							proof: proofFor(
								{ ...tuple, model: `${tuple.model}-different` },
								"proven",
							),
						};
					}
					return provenDecision(_context, tuple);
				},
			});
			if (kind === "thenable") {
				const provider = getProvider(providerName);
				if (provider) {
					provider.resolveServerToolCapability = (() =>
						Promise.resolve({
							decision: "unknown",
							reason: "no_exact_proof",
						})) as unknown as NonNullable<
						Provider["resolveServerToolCapability"]
					>;
				}
			}
			return makeAccount({
				id: `invalid-${kind}`,
				provider: providerName,
				priority,
				model_mappings: JSON.stringify({ opus: `physical-${kind}` }),
			});
		});
		const capableProvider = "u4-valid-resolver";
		installCapabilityProvider({
			name: capableProvider,
			decision: provenDecision,
		});
		const capable = makeAccount({
			id: "valid-resolver",
			provider: capableProvider,
			priority: 99,
			model_mappings: JSON.stringify({ opus: "physical-valid" }),
		});
		const ctx = makeCtx({ accounts: [...accounts, capable] });
		ctx.strategy.select = mock((strategyAccounts: Account[]) => {
			expect(strategyAccounts).toEqual([capable]);
			return strategyAccounts;
		});
		const meta = serverToolMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result).toEqual([capable]);
		expect(
			meta.routingCandidateCatalog
				?.slice(0, badCases.length)
				.map((candidate) => candidate.serverToolCapability),
		).toEqual(
			badCases.map(() =>
				expect.objectContaining({
					decision: "unknown",
					reason: "invalid_resolver_result",
					proofKey: null,
				}),
			),
		);
		expect(meta.serverToolCapabilitySummary).toMatchObject({
			structuralCandidateCount: 5,
			unknownCandidateCount: 4,
			provenCandidateCount: 1,
			eligibleCandidateCount: 1,
		});
	});

	it("keeps duplicate combo slots and exact physical-model proofs aligned after filtering", async () => {
		const providerName = "u4-combo-provider";
		const tupleContexts: CapabilityProviderContext[] = [];
		installCapabilityProvider({
			name: providerName,
			onTuple: (context) => tupleContexts.push(context),
			decision: (_context, tuple) =>
				tuple.model === "physical-blocked"
					? {
							decision: "unsupported",
							proof: proofFor(tuple, "unsupported"),
						}
					: provenDecision(_context, tuple),
		});
		const duplicate = makeAccount({
			id: "duplicate-account",
			provider: providerName,
			model_mappings: JSON.stringify({
				"claude-opus-4-8": "physical-blocked",
				"claude-opus-4-5": "physical-allowed",
			}),
		});
		const other = makeAccount({
			id: "other-account",
			provider: providerName,
			model_mappings: JSON.stringify({
				"claude-opus-4-1": "physical-other",
			}),
		});
		const combo = makeCombo([
			{
				id: "slot-duplicate-blocked",
				combo_id: "combo-1",
				account_id: duplicate.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-duplicate-allowed",
				combo_id: "combo-1",
				account_id: duplicate.id,
				model: "claude-opus-4-5",
				priority: 1,
				enabled: true,
			},
			{
				id: "slot-other",
				combo_id: "combo-1",
				account_id: other.id,
				model: "claude-opus-4-1",
				priority: 2,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [duplicate, other], activeCombo: combo });
		ctx.strategy.select = mock((accounts: Account[], meta: RequestMeta) => {
			expect(accounts.map(({ id }) => id)).toEqual([duplicate.id, other.id]);
			expect(
				meta.routingCandidates?.map(({ comboSlotId }) => comboSlotId),
			).toEqual(["slot-duplicate-allowed", "slot-other"]);
			meta.routingCandidates = [...(meta.routingCandidates ?? [])].reverse();
			return [...accounts].reverse();
		});
		const meta = serverToolMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result.map(({ id }) => id)).toEqual([other.id, duplicate.id]);
		expect(meta.hardExcludedAccountIds).toBeNull();
		expect(
			meta.routingCandidateCatalog?.map(({ comboSlotId }) => comboSlotId),
		).toEqual([
			"slot-duplicate-blocked",
			"slot-duplicate-allowed",
			"slot-other",
		]);
		expect(
			meta.routingCandidates?.map(({ comboSlotId }) => comboSlotId),
		).toEqual(["slot-other", "slot-duplicate-allowed"]);
		expect(getComboSlotInfo(meta)?.slots).toEqual([
			{ accountId: other.id, modelOverride: "claude-opus-4-1" },
			{ accountId: duplicate.id, modelOverride: "claude-opus-4-5" },
		]);
		expect(
			tupleContexts.map(({ candidateId, physicalModel }) => ({
				candidateId,
				physicalModel,
			})),
		).toEqual([
			{
				candidateId: "combo:combo-1:slot:slot-duplicate-blocked",
				physicalModel: "physical-blocked",
			},
			{
				candidateId: "combo:combo-1:slot:slot-duplicate-allowed",
				physicalModel: "physical-allowed",
			},
			{
				candidateId: "combo:combo-1:slot:slot-other",
				physicalModel: "physical-other",
			},
		]);
		expect(meta.serverToolCapabilitySummary).toMatchObject({
			structuralCandidateCount: 3,
			provenCandidateCount: 2,
			unsupportedCandidateCount: 1,
			eligibleCandidateCount: 2,
		});
	});

	it("continues from a capability-empty combo into the allowed normal structural pool", async () => {
		const providerName = "u4-combo-session-fallback";
		installCapabilityProvider({
			name: providerName,
			decision: (_context, tuple) =>
				tuple.candidateId.includes("combo-incapable")
					? {
							decision: "unsupported",
							proof: proofFor(tuple, "unsupported"),
						}
					: provenDecision(_context, tuple),
		});
		const comboIncappable = makeAccount({
			id: "combo-incapable",
			provider: providerName,
			model_mappings: JSON.stringify({ opus: "physical-combo-incapable" }),
		});
		const normalCapable = makeAccount({
			id: "normal-capable",
			provider: providerName,
			model_mappings: JSON.stringify({ opus: "physical-normal-capable" }),
		});
		const combo = makeCombo([
			{
				id: "combo-incapable",
				combo_id: "combo-1",
				account_id: comboIncappable.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [comboIncappable, normalCapable],
			activeCombo: combo,
		});
		ctx.strategy.select = mock((accounts: Account[]) => {
			expect(accounts).toEqual([normalCapable]);
			return accounts;
		});
		const meta = serverToolMeta();

		const result = await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");

		expect(result).toEqual([normalCapable]);
		expect(
			meta.routingCandidateCatalog?.map(({ candidateId }) => candidateId),
		).toEqual([
			"combo:combo-1:slot:combo-incapable",
			"account:combo-incapable",
			"account:normal-capable",
		]);
		expect(
			meta.routingCandidates?.map(({ candidateId }) => candidateId),
		).toEqual(["account:normal-capable"]);
		expect(meta.serverToolCapabilitySummary).toMatchObject({
			structuralCandidateCount: 3,
			unsupportedCandidateCount: 2,
			provenCandidateCount: 1,
			eligibleCandidateCount: 1,
		});
	});

	it("fails capability-empty combo selection locally when session fallback is disabled", async () => {
		process.env.CCFLARE_DISABLE_COMBO_SESSION_FALLBACK = "1";
		const providerName = "u4-combo-no-session-fallback";
		installCapabilityProvider({
			name: providerName,
			decision: (_context, tuple) => ({
				decision: "unsupported",
				proof: proofFor(tuple, "unsupported"),
			}),
		});
		const incapable = makeAccount({
			id: "combo-only-incapable",
			provider: providerName,
			model_mappings: JSON.stringify({ opus: "physical-incapable" }),
		});
		const combo = makeCombo([
			{
				id: "combo-only-incapable",
				combo_id: "combo-1",
				account_id: incapable.id,
				model: "claude-opus-4-8",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = makeCtx({ accounts: [incapable], activeCombo: combo });
		const meta = serverToolMeta();

		try {
			await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
			expect.unreachable("expected capability-specific combo failure");
		} catch (error) {
			expect(error).toMatchObject({
				name: "ServerToolRoutingError",
				reason: "no_implementation",
			});
		}
		expect(ctx.strategy.select).not.toHaveBeenCalled();
		expect(meta.serverToolCapabilitySummary).toMatchObject({
			structuralCandidateCount: 1,
			unsupportedCandidateCount: 1,
			eligibleCandidateCount: 0,
		});
	});

	for (const forcedCase of [
		{ kind: "unsupported", expectedDecision: "unsupported" },
		{ kind: "unknown", expectedDecision: "unknown" },
		{ kind: "proxy-replay", expectedDecision: "proven" },
	] as const) {
		it(`fails a forced ${forcedCase.kind} tuple closed without semantic hard exclusion`, async () => {
			const providerName = `u4-force-${forcedCase.kind}`;
			installCapabilityProvider({
				name: providerName,
				decision: (_context, tuple) => {
					if (forcedCase.kind === "unknown") {
						return { decision: "unknown", reason: "no_exact_proof" };
					}
					if (forcedCase.kind === "unsupported") {
						return {
							decision: "unsupported",
							proof: proofFor(tuple, "unsupported"),
						};
					}
					return provenDecision(_context, tuple);
				},
			});
			const forced = makeAccount({
				id: `forced-${forcedCase.kind}`,
				provider: providerName,
				model_mappings: JSON.stringify({
					opus:
						forcedCase.kind === "proxy-replay"
							? "physical-proxy-replay"
							: `physical-${forcedCase.kind}`,
				}),
			});
			const substitute = makeAccount({ id: "force-substitute" });
			const ctx = makeCtx({ accounts: [forced, substitute] });
			ctx.serverToolReplay = {
				status: "disabled",
			} as ProxyContext["serverToolReplay"];
			const meta = serverToolMeta({
				headers: new Headers({
					"x-better-ccflare-account-id": forced.id,
				}),
			});

			try {
				await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
				expect.unreachable("expected forced capability failure");
			} catch (error) {
				expect(error).toMatchObject({
					name: "ServerToolRoutingError",
					reason: "forced_incapable",
					accountId: forced.id,
				});
			}
			expect(meta.hardExcludedAccountIds).toBeNull();
			expect(
				meta.routingCandidateCatalog?.[0]?.serverToolCapability,
			).toMatchObject({
				decision: forcedCase.expectedDecision,
			});
			if (forcedCase.kind === "proxy-replay") {
				expect(
					meta.routingCandidateCatalog?.[0]?.serverToolCapability
						?.replayRuntimeStatus,
				).toBe("output_unavailable");
			}
		});
	}

	it("does not let an incapable degraded owner re-enter the eligible pool", async () => {
		const previous = installCapabilityProvider({
			name: "anthropic",
			decision: (_context, tuple) =>
				tuple.candidateId === "account:degraded-owner"
					? {
							decision: "unsupported",
							proof: proofFor(tuple, "unsupported"),
						}
					: provenDecision(_context, tuple),
		});
		try {
			const owner = makeAccount({
				id: "degraded-owner",
				priority: 0,
				model_mappings: JSON.stringify({ opus: "physical-owner" }),
			});
			const fallback = makeAccount({
				id: "degraded-fallback",
				priority: 1,
				model_mappings: JSON.stringify({ opus: "physical-fallback" }),
			});
			const ownerSnapshot = {
				candidateId: "account:degraded-owner",
				accountId: owner.id,
			};
			const ctx = makeCtx({ accounts: [owner, fallback] });
			ctx.strategy = {
				select: mock((accounts: Account[]) => accounts),
				snapshotAffinityOwner: mock(() => ownerSnapshot),
			} as unknown as ProxyContext["strategy"];
			ctx.degradedOwnerOverlay = new DegradedOwnerOverlay();
			ctx.degradedOwnerShadowOverlay = new DegradedOwnerOverlay();
			ctx.anthropicDegradedMode = {
				config: { mode: "enforce" },
			} as ProxyContext["anthropicDegradedMode"];
			const meta = serverToolMeta({ clientSessionId: "degraded-capability" });
			const inspection: AnthropicDegradedRouteInspection = {
				cohortKey: "capability-cohort" as AnthropicDegradedCohortKey,
				state: "open",
				detail: { state: "open", nextProbeAt: 0 },
			};

			const result = await selectAccountsForRequest(
				meta,
				ctx,
				"claude-opus-4-8",
				{
					degradedOwner: { inspection, requestKind: "large" },
				},
			);

			expect(result).toEqual([fallback]);
			expect(meta.routingCandidates?.map(({ accountId }) => accountId)).toEqual(
				[fallback.id],
			);
			expect(meta.affinityOwnerDirective).toBeNull();
			expect(meta.hardExcludedAccountIds).toBeNull();
		} finally {
			if (previous) registerProvider(previous);
		}
	});

	it("distinguishes a proven but temporarily unavailable candidate from no implementation", async () => {
		const providerName = "u4-temporary-provider";
		installCapabilityProvider({
			name: providerName,
			decision: provenDecision,
		});
		const paused = makeAccount({
			id: "temporarily-unavailable",
			provider: providerName,
			paused: true,
			model_mappings: JSON.stringify({ opus: "physical-temporary" }),
		});
		const ctx = makeCtx({ accounts: [paused] });
		const meta = serverToolMeta();

		try {
			await selectAccountsForRequest(meta, ctx, "claude-opus-4-8");
			expect.unreachable("expected temporary capability pool failure");
		} catch (error) {
			expect(error).toMatchObject({
				name: "ServerToolRoutingError",
				reason: "temporary_unavailable",
			});
		}
		expect(meta.serverToolCapabilitySummary).toEqual({
			structuralCandidateCount: 1,
			provenCandidateCount: 1,
			unsupportedCandidateCount: 0,
			unknownCandidateCount: 0,
			replayIneligibleCandidateCount: 0,
			temporarilyUnavailableProvenCandidateCount: 1,
			eligibleCandidateCount: 0,
		});
		expect(
			meta.routingCandidateCatalog?.[0]?.serverToolCapability,
		).toMatchObject({
			decision: "proven",
			proofKey: expect.any(String),
		});
		expect(meta.routingCandidates).toEqual([]);
		expect(meta.hardExcludedAccountIds).toBeNull();
	});
});

describe("selectAccountsForRequest — pool-floor alarm on the force-route path", () => {
	it("alarms when capacity excludes the only force-routed candidate", async () => {
		// Regression fence. The force-route path never builds a candidate catalog,
		// so it leaves routingCandidateCatalog/routingCandidates null. Deriving the
		// alarm's pool sizes from meta therefore reported an unknown pool, and
		// buildPoolFloorEvent bails on an unknown pool — so the alarm silently
		// never fired on the one path that actually produces route_unavailable.
		const forced = makeAccount({
			id: "acc-force-poolfloor",
			name: "forced-capacity",
		});
		const ctx = makeCtx({ accounts: [forced] });
		cacheUsage(forced.id, {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
					scope: {
						model: { id: null, display_name: "Fable" },
						surface: null,
					},
				},
			],
		});
		const meta = makeRequestMeta({
			id: "req-force-poolfloor",
			headers: new Headers({ "x-better-ccflare-account-id": forced.id }),
		});

		// A lane string unique to this test: the alarm throttles per (lane,
		// severity) in module-level state, so a shared model name would make this
		// assertion depend on which other tests ran first.
		const lane = "claude-fable-5-poolfloor-fence";
		const errors = spyOn(Logger.prototype, "error").mockImplementation(
			() => {},
		);
		try {
			await expect(
				selectAccountsForRequest(meta, ctx, lane),
			).rejects.toBeInstanceOf(ForceRouteUnavailableError);

			const alarm = errors.mock.calls.find(
				(call) =>
					typeof call[0] === "string" && call[0].includes("Routing pool floor"),
			);
			expect(alarm).toBeDefined();
			expect(alarm?.[1]).toMatchObject({
				severity: "floor",
				lane,
				candidatesBefore: 1,
				candidatesAfter: 0,
			});
		} finally {
			errors.mockRestore();
		}
	});
});

// ── U5 canary contract: AE7 priority ordering and KTD9 429 classification ────
//
// ALL fixtures in this describe block are CONSTRUCTED, not observed from live
// traffic. The account configurations mirror the U4 Vercel catch-all recipe
// (priority 100, GLM model mappings) and a representative higher-priority
// preferred account.

describe("U5 canary: AE7 higher-priority account selected over Vercel catch-all (constructed)", () => {
	function makeVercelAccount(): Account {
		return makeAccount({
			id: "vercel-catchall",
			name: "vercel-catchall",
			provider: "openai-compatible",
			api_key: "vrsc-constructed-key",
			refresh_token: null,
			access_token: null,
			expires_at: null,
			priority: 100,
			custom_endpoint: "https://ai-gateway.vercel.sh/v1",
			// Every Claude family the U4 recipe documents, so AE7's "not selected
			// for any Claude family" claim is exercised over the same set an
			// operator would actually configure.
			model_mappings: JSON.stringify({
				fable: ["zai/glm-5.2-fast", "zai/glm-5.2"],
				opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
				sonnet: ["zai/glm-5.2-fast", "zai/glm-5.2"],
				haiku: ["zai/glm-5.2-fast", "zai/glm-5.2"],
			}),
		});
	}

	function makePreferredAccount(family: string): Account {
		return makeAccount({
			id: `preferred-${family}`,
			name: `preferred-${family}`,
			provider: "anthropic",
			priority: 30,
		});
	}

	it.each([
		["claude-fable-5", "fable"],
		["claude-opus-4-8", "opus"],
		["claude-sonnet-4-5", "sonnet"],
		["claude-haiku-4-5", "haiku"],
	] as const)("selects the higher-priority account before the Vercel catch-all for %s", async (model, family) => {
		const preferred = makePreferredAccount(family);
		const vercel = makeVercelAccount();
		const ctx = makeCtx({ accounts: [vercel, preferred] });
		useSessionStrategy(ctx);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			model,
		);

		// The preferred account (priority 30) must come before Vercel
		// (priority 100, the platform max)
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0]?.id).toBe(preferred.id);
		// Vercel is present but not first
		const vercelIdx = result.findIndex((a) => a.id === vercel.id);
		if (vercelIdx >= 0) {
			expect(vercelIdx).toBeGreaterThan(0);
		}
	});

	it("does not select the Vercel catch-all first when a higher-priority account is eligible", async () => {
		const preferred = makePreferredAccount("opus");
		const vercel = makeVercelAccount();
		const ctx = makeCtx({ accounts: [vercel, preferred] });
		useSessionStrategy(ctx);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-4-8",
		);

		expect(result[0]?.id).not.toBe(vercel.id);
		expect(result[0]?.id).toBe(preferred.id);
	});
});

describe("U5 canary: KTD9 Vercel 429 is model-scoped, not an account bench (constructed)", () => {
	// KTD9: parseRateLimit reports no rate limit for compatible accounts, so a
	// Vercel 429 continues to behave as a model-unavailable signal rather than
	// benching the account. This test pins that classification by asserting the
	// OpenAI-compatible provider's parseRateLimit returns isRateLimited:false
	// even for a 429 response — which is what keeps a Vercel 429 model-scoped.
	//
	// CONSTRUCTED fixture: the 429 response shape is built from documented
	// OpenAI-compatible error shapes. No live 429 was observed (KTD7), so this
	// test records explicitly that the 429 fixture was constructed rather than
	// observed, and that no billing-exhaustion evidence was carried.
	it("OpenAI-compatible parseRateLimit returns isRateLimited:false for a constructed Vercel 429", async () => {
		const { OpenAICompatibleProvider } = await import(
			"@better-ccflare/providers"
		);
		const provider = new OpenAICompatibleProvider();

		// CONSTRUCTED 429 fixture — no billing-exhaustion evidence was observed.
		// A Vercel AI Gateway 429 is built from the documented OpenAI-compatible
		// error shape. The response carries no anthropic-ratelimit-unified-* or
		// billing-exhaustion headers because Vercel's compatible surface does not
		// emit Anthropic-native rate-limit metadata.
		const response = new Response(
			JSON.stringify({
				error: {
					type: "rate_limit_error",
					code: "rate_limit_exceeded",
					message: "Rate limit exceeded for this model",
				},
			}),
			{
				status: 429,
				headers: {
					"content-type": "application/json",
					"x-ratelimit-remaining-requests": "0",
					"retry-after": "60",
				},
			},
		);

		const rateLimit = provider.parseRateLimit(response);

		// KTD9: always false — the 429 does not bench the account
		expect(rateLimit.isRateLimited).toBe(false);
		// The 429 is left to the model-fallback / model-unavailable path
		// (isModelUnavailableError returns true for 429), which treats it as
		// model-scoped rather than account-wide.
	});

	it("a constructed Vercel 429 without billing-exhaustion evidence does not bench the account", async () => {
		// KTD9: Because parseRateLimit returns isRateLimited:false, a Vercel 429
		// is classified as model-scoped (isModelUnavailableError returns true for
		// 429) and the account is not benched. This test verifies the chain:
		// parseRateLimit(false) → 429 enters model-fallback, not account cooldown.
		const { isModelUnavailableError } = await import("../proxy-operations");
		const { OpenAICompatibleProvider } = await import(
			"@better-ccflare/providers"
		);
		const provider = new OpenAICompatibleProvider();

		const response = new Response(
			JSON.stringify({
				error: {
					type: "rate_limit_error",
					message: "Rate limit exceeded",
				},
			}),
			{
				status: 429,
				headers: { "content-type": "application/json" },
			},
		);

		// parseRateLimit does not bench the account
		expect(provider.parseRateLimit(response).isRateLimited).toBe(false);
		// But isModelUnavailableError classifies the 429 as model-scoped,
		// so it enters the model-fallback loop (try next model, not bench account)
		expect(await isModelUnavailableError(response)).toBe(true);
	});
});
