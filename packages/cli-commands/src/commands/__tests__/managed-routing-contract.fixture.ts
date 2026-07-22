import type {
	AccountResponse,
	AccountRoutingOverview,
	ComboFamily,
	ComboRoutingAvailabilityReason,
} from "@better-ccflare/types";

type EffectiveView = AccountRoutingOverview["effective"][number];
type EffectiveMember = EffectiveView["resolution"]["members"][number];
type MembershipDecision = EffectiveView["resolution"]["decisions"][number];

export const CONTRACT_ACCOUNT_IDS = {
	anthropicHealthy: "anthropic-oauth-healthy",
	anthropicPaused: "anthropic-oauth-paused",
	anthropicLimited: "anthropic-oauth-limited",
	anthropicReauth: "anthropic-oauth-reauth",
	codexManual: "codex-manual-fallback",
	xaiManual: "xai-manual-fallback",
	nonNativeSupported: "openrouter-managed-supported",
	nonNativeUnknown: "omniroute-capability-unknown",
	zeroMembership: "local-zero-membership",
} as const;

function account(
	id: string,
	provider: string,
	priority: number,
	overrides: Partial<AccountResponse> = {},
): AccountResponse {
	return {
		id,
		name: `Fixture ${id}`,
		provider,
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2026-07-22T00:00:00.000Z",
		paused: false,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "Active",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "fixture",
		priority,
		autoFallbackEnabled: true,
		autoRefreshEnabled: true,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: provider === "anthropic" || provider === "codex",
		billingType:
			provider === "anthropic" || provider === "codex" ? "plan" : "api",
		sessionStats: null,
		isPrimary: priority === 0,
		...overrides,
	};
}

export const managedRoutingContractAccounts: AccountResponse[] = [
	account(CONTRACT_ACCOUNT_IDS.anthropicHealthy, "anthropic", 0),
	account(CONTRACT_ACCOUNT_IDS.anthropicPaused, "anthropic", 1, {
		paused: true,
		pauseReason: "manual",
	}),
	account(CONTRACT_ACCOUNT_IDS.anthropicLimited, "anthropic", 2, {
		rateLimitStatus: "Rate limited",
		rateLimitedUntil: 1_800_000_000_000,
		rateLimitedReason: "model_scoped_429",
		rateLimitedAt: 1_799_999_000_000,
	}),
	account(CONTRACT_ACCOUNT_IDS.anthropicReauth, "anthropic", 3, {
		requiresReauth: true,
		tokenStatus: "expired",
	}),
	account(CONTRACT_ACCOUNT_IDS.codexManual, "codex", 20),
	account(CONTRACT_ACCOUNT_IDS.xaiManual, "xai", 30),
	account(CONTRACT_ACCOUNT_IDS.nonNativeSupported, "openrouter", 4, {
		rateLimitStatus: "Rate limited",
		rateLimitedUntil: 1_800_000_000_000,
		rateLimitedReason: "upstream_429_with_reset",
		rateLimitedAt: 1_799_999_000_000,
	}),
	account(CONTRACT_ACCOUNT_IDS.nonNativeUnknown, "omniroute", 5),
	account(CONTRACT_ACCOUNT_IDS.zeroMembership, "ollama", 99),
];

function member(input: {
	accountId: string;
	family: ComboFamily;
	logicalModel: string;
	tier: number;
	source: "manual" | "managed";
	availability?: ComboRoutingAvailabilityReason;
	slotId?: string;
	ruleId?: string;
}): EffectiveMember {
	const comboId = `combo-${input.family}`;
	const slotId =
		input.source === "manual"
			? (input.slotId ?? `slot-${input.accountId}`)
			: null;
	const ruleId =
		input.source === "managed"
			? (input.ruleId ?? `rule-${input.family}`)
			: null;
	const availability = input.availability ?? "available";
	return {
		id:
			input.source === "manual"
				? `combo:${comboId}:slot:${slotId}`
				: `combo:${comboId}:managed:${input.family}:rule:${ruleId}:account:${input.accountId}`,
		account_id: input.accountId,
		combo_id: comboId,
		family: input.family,
		included: true,
		logical_model: input.logicalModel,
		tier: input.tier,
		source: input.source,
		reason: "included",
		slot_id: slotId,
		rule_id: ruleId,
		availability: {
			available: availability === "available",
			reason: availability,
		},
		identity_provisional: false,
	};
}

function includedDecision(value: EffectiveMember): MembershipDecision {
	const { id: _id, ...decision } = value;
	return decision;
}

function rejectedDecision(input: {
	accountId: string;
	family: ComboFamily;
	reason: "excluded" | "unknown";
	logicalModel: string | null;
	tier: number | null;
	availability?: ComboRoutingAvailabilityReason;
	ruleId?: string;
}): MembershipDecision {
	const availability = input.availability ?? "available";
	return {
		account_id: input.accountId,
		combo_id: `combo-${input.family}`,
		family: input.family,
		included: false,
		logical_model: input.logicalModel,
		tier: input.tier,
		source: null,
		reason: input.reason,
		slot_id: null,
		rule_id: input.ruleId ?? `rule-${input.family}`,
		availability: {
			available: availability === "available",
			reason: availability,
		},
		identity_provisional: false,
	};
}

const opusMembers: EffectiveMember[] = [
	member({
		accountId: CONTRACT_ACCOUNT_IDS.anthropicHealthy,
		family: "opus",
		logicalModel: "claude-opus-4-8",
		tier: 0,
		source: "managed",
	}),
	member({
		accountId: CONTRACT_ACCOUNT_IDS.anthropicPaused,
		family: "opus",
		logicalModel: "claude-opus-4-8",
		tier: 1,
		source: "managed",
		availability: "paused",
	}),
	member({
		accountId: CONTRACT_ACCOUNT_IDS.nonNativeSupported,
		family: "opus",
		logicalModel: "claude-opus-4-8",
		tier: 4,
		source: "managed",
		availability: "rate_limited",
		ruleId: "rule-opus-openrouter",
	}),
	member({
		accountId: CONTRACT_ACCOUNT_IDS.codexManual,
		family: "opus",
		logicalModel: "gpt-5.6",
		tier: 20,
		source: "manual",
		slotId: "slot-opus-codex",
	}),
];

const fableMembers: EffectiveMember[] = [
	member({
		accountId: CONTRACT_ACCOUNT_IDS.anthropicHealthy,
		family: "fable",
		logicalModel: "claude-fable-5",
		tier: 0,
		source: "managed",
	}),
	member({
		accountId: CONTRACT_ACCOUNT_IDS.anthropicLimited,
		family: "fable",
		logicalModel: "claude-fable-5",
		tier: 2,
		source: "managed",
		availability: "model_exhausted",
	}),
	member({
		accountId: CONTRACT_ACCOUNT_IDS.anthropicReauth,
		family: "fable",
		logicalModel: "claude-fable-5",
		tier: 3,
		source: "managed",
		availability: "requires_reauth",
	}),
	member({
		accountId: CONTRACT_ACCOUNT_IDS.xaiManual,
		family: "fable",
		logicalModel: "grok-4-0709",
		tier: 30,
		source: "manual",
		slotId: "slot-fable-xai",
	}),
];

export const managedRoutingContractOverview: AccountRoutingOverview = {
	effective: [
		{
			family: "opus",
			policy: {
				assignment: {
					family: "opus",
					combo_id: "combo-opus",
					enabled: true,
					membership_mode: "managed",
					managed_model: "claude-opus-4-8",
				},
				combo: {
					id: "combo-opus",
					name: "Opus managed route",
					description: null,
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
				slots: [
					{
						id: "slot-opus-codex",
						combo_id: "combo-opus",
						account_id: CONTRACT_ACCOUNT_IDS.codexManual,
						model: "gpt-5.6",
						priority: 20,
						enabled: true,
					},
				],
				rules: [
					{
						id: "rule-opus",
						family: "opus",
						combo_id: "combo-opus",
						provider: "anthropic",
						route_class: "oauth-subscription",
						enabled: true,
						created_at: 1,
						updated_at: 1,
					},
					{
						id: "rule-opus-openrouter",
						family: "opus",
						combo_id: "combo-opus",
						provider: "openrouter",
						route_class: "api-key",
						enabled: true,
						created_at: 1,
						updated_at: 1,
					},
				],
				exclusions: [
					{
						id: "exclude-opus-reauth",
						family: "opus",
						combo_id: "combo-opus",
						account_id: CONTRACT_ACCOUNT_IDS.anthropicReauth,
						created_at: 1,
					},
				],
			},
			resolution: {
				family: "opus",
				combo_id: "combo-opus",
				active: true,
				reason: "included",
				members: opusMembers,
				decisions: [
					...opusMembers.map(includedDecision),
					rejectedDecision({
						accountId: CONTRACT_ACCOUNT_IDS.anthropicReauth,
						family: "opus",
						reason: "excluded",
						logicalModel: "claude-opus-4-8",
						tier: 3,
						availability: "requires_reauth",
					}),
					rejectedDecision({
						accountId: CONTRACT_ACCOUNT_IDS.nonNativeUnknown,
						family: "opus",
						reason: "unknown",
						logicalModel: "claude-opus-4-8",
						tier: 5,
					}),
				],
			},
		},
		{
			family: "fable",
			policy: {
				assignment: {
					family: "fable",
					combo_id: "combo-fable",
					enabled: true,
					membership_mode: "managed",
					managed_model: "claude-fable-5",
				},
				combo: {
					id: "combo-fable",
					name: "Fable managed route",
					description: null,
					enabled: true,
					created_at: 1,
					updated_at: 1,
				},
				slots: [
					{
						id: "slot-fable-xai",
						combo_id: "combo-fable",
						account_id: CONTRACT_ACCOUNT_IDS.xaiManual,
						model: "grok-4-0709",
						priority: 30,
						enabled: true,
					},
				],
				rules: [
					{
						id: "rule-fable",
						family: "fable",
						combo_id: "combo-fable",
						provider: "anthropic",
						route_class: "oauth-subscription",
						enabled: true,
						created_at: 1,
						updated_at: 1,
					},
				],
				exclusions: [],
			},
			resolution: {
				family: "fable",
				combo_id: "combo-fable",
				active: true,
				reason: "included",
				members: fableMembers,
				decisions: [
					...fableMembers.map(includedDecision),
					rejectedDecision({
						accountId: CONTRACT_ACCOUNT_IDS.nonNativeUnknown,
						family: "fable",
						reason: "unknown",
						logicalModel: "claude-fable-5",
						tier: 5,
					}),
				],
			},
		},
	],
	opportunities: [],
};
