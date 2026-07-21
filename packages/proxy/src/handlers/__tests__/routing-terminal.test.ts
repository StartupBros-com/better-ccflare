import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { RoutingCapacityContext } from "../account-selector";
import type { RequestRateLimitOutcome } from "../rate-limit-scope";
import {
	createModelPoolExhaustedResponse,
	createRoutingTerminalResponse,
	filterRequestCompatibleAccounts,
	mergeTerminalAccountState,
} from "../routing-terminal";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "account-1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh",
		access_token: "access",
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

function familyCapacityContext(
	blockedUntil: number | null,
): RoutingCapacityContext {
	return {
		effectiveModel: "claude-fable-4-5",
		effectiveModelFamily: "fable",
		blockedUntil,
		exclusions: [
			{
				accountId: "account-1",
				accountName: "account-1",
				model: "claude-fable-4-5",
				modelFamily: "fable",
				source: "normal",
				comboSlotId: null,
				comboSlotOrdinal: null,
				blockedUntil,
				exclusions: [
					{
						source: "usage_snapshot",
						scope: "family",
						window: "seven_day_fable",
						windowKind: "weekly_scoped",
						modelFamily: "fable",
						utilization: 100,
						resetAtMs: blockedUntil,
						evidenceExpiresAt: blockedUntil ?? 0,
					},
				],
			},
		],
	};
}

function accountCapacityContext(
	blockedUntil: number,
	resetAtMs: number | null = blockedUntil,
): RoutingCapacityContext {
	return {
		effectiveModel: "claude-opus-4-1",
		effectiveModelFamily: "opus",
		blockedUntil,
		exclusions: [
			{
				accountId: "account-1",
				accountName: "account-1",
				model: "claude-opus-4-1",
				modelFamily: "opus",
				source: "normal",
				comboSlotId: null,
				comboSlotOrdinal: null,
				blockedUntil,
				exclusions: [
					{
						source: "usage_snapshot",
						scope: "account",
						window: "five_hour",
						windowKind: "session",
						modelFamily: null,
						utilization: 100,
						resetAtMs,
						evidenceExpiresAt: blockedUntil,
					},
				],
			},
		],
	};
}

function mixedFamilyCapacityContext(
	now: number,
	routes: readonly {
		accountId: string;
		resetAtMs: number | null;
	}[],
): RoutingCapacityContext {
	const exclusions = routes.map(({ accountId, resetAtMs }) => {
		const evidenceExpiresAt =
			typeof resetAtMs === "number" &&
			Number.isFinite(resetAtMs) &&
			resetAtMs > now
				? resetAtMs
				: now + 5 * 60_000;
		return {
			accountId,
			accountName: accountId,
			model: "claude-fable-4-5",
			modelFamily: "fable",
			source: "normal" as const,
			comboSlotId: null,
			comboSlotOrdinal: null,
			blockedUntil: evidenceExpiresAt,
			exclusions: [
				{
					source: "usage_snapshot" as const,
					scope: "family" as const,
					window: "seven_day_fable",
					windowKind: "weekly_scoped" as const,
					modelFamily: "fable",
					utilization: 100,
					resetAtMs,
					evidenceExpiresAt,
				},
			],
		};
	});
	return {
		effectiveModel: "claude-fable-4-5",
		effectiveModelFamily: "fable",
		exclusions,
		blockedUntil: Math.min(
			...exclusions.map((candidate) => candidate.blockedUntil ?? Infinity),
		),
	};
}

async function body(response: Response) {
	return (await response.json()) as {
		type: string;
		error: Record<string, unknown>;
	};
}

describe("routing terminal responses", () => {
	it("advertises finite route-circuit recovery without claiming whole-pool exhaustion", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const retryAt = now + 30_001;
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount(), makeAccount({ id: "account-2" })],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
			routeCircuitRecoveryHint: {
				allCandidatesOpen: true,
				candidateCount: 2,
				probeLeased: true,
				retryAt,
				reason: "semantic_stream_stall",
			},
		});

		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBe("31");
		expect(terminal.response.headers.get("x-better-ccflare-route-status")).toBe(
			"circuit-open",
		);
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("route_unavailable");
		expect(parsed.error.next_available_at).toBe(
			new Date(retryAt).toISOString(),
		);
		expect(parsed.error.route_circuit).toEqual({
			all_candidates_open: true,
			candidate_count: 2,
			probe_leased: true,
			reason: "semantic_stream_stall",
		});
	});

	it("returns retryable model_pool_exhausted for finite model-only capacity", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const next = now + 60_001;
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount()],
			capacityContext: familyCapacityContext(next),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("model_pool_exhausted");
		expect(terminal.response.status).toBe(503);
		expect(terminal.response.headers.get("retry-after")).toBe("61");
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(
			terminal.response.headers.get("x-better-ccflare-recovery-scope"),
		).toBe("model");
		const parsed = await body(terminal.response);
		expect(parsed.type).toBe("error");
		expect(parsed.error.type).toBe("service_unavailable");
		expect(parsed.error.code).toBe("model_pool_exhausted");
		expect(parsed.error.model).toBe("claude-fable-4-5");
		expect(parsed.error.family).toBe("fable");
		expect(parsed.error.next_available_at).toBe(new Date(next).toISOString());
	});

	it("keeps unknown, past, and non-finite model recovery unmarked", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		for (const availableAt of [
			null,
			now - 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			const response = createModelPoolExhaustedResponse({
				capacityContext: null,
				rateLimitOutcomes: [
					{
						accountId: "account-1",
						status: 429,
						scope: "model",
						family: "fable",
						attemptedModel: "claude-fable-4-5",
						reason: "matching_scoped_limit",
						availableAt,
					},
				],
				now,
			});

			expect(response.headers.get("retry-after")).toBeNull();
			expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
			const parsed = await body(response);
			expect(parsed.error.code).toBe("model_pool_exhausted");
			expect("next_available_at" in parsed.error).toBe(false);
		}
	});

	it("omits an unknown model recovery instead of fabricating Retry-After", async () => {
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount()],
			capacityContext: familyCapacityContext(null),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
		});

		const parsed = await body(terminal.response);
		expect("next_available_at" in parsed.error).toBe(false);
		expect(terminal.response.headers.get("retry-after")).toBeNull();
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
	});

	it("returns model_pool_exhausted when every attempted failure was model-lane scoped", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const outcomes: RequestRateLimitOutcome[] = [
			{
				accountId: "account-1",
				status: 429,
				scope: "family",
				family: "fable",
				attemptedModel: "claude-fable-4-5",
				reason: "matching_scoped_limit",
				availableAt: now + 90_000,
			},
			{
				accountId: "account-2",
				status: 429,
				scope: "model",
				family: "fable",
				attemptedModel: "claude-fable-4-5",
				reason: "out_of_credits",
				availableAt: now + 120_000,
			},
		];
		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [
				makeAccount(),
				makeAccount({ id: "account-2", name: "account-2" }),
			],
			capacityContext: familyCapacityContext(null),
			rateLimitOutcomes: outcomes,
			upstreamAttempts: 2,
			now,
		});

		expect(terminal.kind).toBe("model_pool_exhausted");
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("model_pool_exhausted");
		expect(parsed.error.next_available_at).toBe(
			new Date(now + 90_000).toISOString(),
		);
		expect(terminal.response.headers.get("retry-after")).toBe("90");
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(
			terminal.response.headers.get("x-better-ccflare-recovery-scope"),
		).toBe("model");
	});

	it("does not call mixed or incomplete attempted failures model exhaustion", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [makeAccount()],
			capacityContext: familyCapacityContext(null),
			rateLimitOutcomes: [
				{
					accountId: "account-1",
					status: 429,
					scope: "family",
					family: "fable",
					attemptedModel: "claude-fable-4-5",
					reason: "matching_scoped_limit",
					availableAt: now + 90_000,
				},
			],
			upstreamAttempts: 2,
			now,
		});

		expect(terminal.kind).toBe("route_unavailable");
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("route_unavailable");
		expect(parsed.error.attempted_routes).toBe(2);
	});

	it("aggregates complete finite global and family recovery from attempted routes", async () => {
		const now = Date.UTC(2026, 6, 20, 12);
		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [
				makeAccount({
					id: "primary",
					name: "primary",
					rate_limited_until: now + 60_000,
					rate_limited_reason: "upstream_429_with_reset",
				}),
				makeAccount({ id: "secondary", name: "secondary" }),
			],
			capacityContext: null,
			rateLimitOutcomes: [
				{
					accountId: "primary",
					status: 429,
					scope: "account",
					family: "fable",
					attemptedModel: "claude-fable-4-5",
					reason: "hard_response_signal",
					availableAt: now + 60_000,
				},
				{
					accountId: "secondary",
					status: 429,
					scope: "family",
					family: "fable",
					attemptedModel: "claude-fable-4-5",
					reason: "matching_scoped_limit",
					availableAt: now + 120_000,
				},
			],
			upstreamAttempts: 2,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("60");
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
	});

	it.each([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["expired", Date.UTC(2026, 6, 20, 12) - 1],
	])("keeps mixed attempted recovery non-retryable when a model reset is %s", async (_label, invalidRecovery) => {
		const now = Date.UTC(2026, 6, 20, 12);
		const terminal = createRoutingTerminalResponse({
			source: "attempts",
			accounts: [
				makeAccount({
					id: "primary",
					name: "primary",
					rate_limited_until: now + 60_000,
					rate_limited_reason: "upstream_429_with_reset",
				}),
				makeAccount({ id: "secondary", name: "secondary" }),
			],
			capacityContext: null,
			rateLimitOutcomes: [
				{
					accountId: "primary",
					status: 429,
					scope: "account",
					family: "fable",
					attemptedModel: "claude-fable-4-5",
					reason: "hard_response_signal",
					availableAt: now + 60_000,
				},
				{
					accountId: "secondary",
					status: 429,
					scope: "family",
					family: "fable",
					attemptedModel: "claude-fable-4-5",
					reason: "matching_scoped_limit",
					availableAt: invalidRecovery,
				},
			],
			upstreamAttempts: 2,
			now,
		});

		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBeNull();
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("route_unavailable");
	});

	it("marks a finite unpaused global cooldown as retryable pool exhaustion", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const next = now + 3_600_000;
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({
					rate_limited_until: next,
					rate_limited_reason: "upstream_429_with_reset",
				}),
			],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("3600");
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(
			terminal.response.headers.get("x-better-ccflare-recovery-scope"),
		).toBe("pool");
		const parsed = await body(terminal.response);
		expect(parsed.error.type).toBe("pool_exhausted");
		expect(parsed.error.code).toBe("pool_exhausted");
		expect(parsed.error.next_available_at).toBe(new Date(next).toISOString());
	});

	it("marks a pool exhausted purely by xai_capacity_402 cooldowns as retryable pool exhaustion (R5-R10)", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const next = now + 3_600_000;
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({
					provider: "xai",
					rate_limited_until: next,
					rate_limited_reason: "xai_capacity_402",
				}),
			],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("3600");
		const parsed = await body(terminal.response);
		expect(parsed.error.type).toBe("pool_exhausted");
		expect(parsed.error.code).toBe("pool_exhausted");
		expect(parsed.error.next_available_at).toBe(new Date(next).toISOString());
		const accounts = parsed.error.accounts as Array<{
			name: string;
			reason: string;
		}>;
		expect(accounts).toEqual([
			{
				name: "account-1",
				reason: "rate_limited",
				available_at: new Date(next).toISOString(),
			},
		]);
	});

	it("accepts complete account-wide snapshot recovery as pool exhaustion", () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount()],
			capacityContext: accountCapacityContext(now + 120_000),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("120");
	});

	it("waits for the latest simultaneous provider reset, not evidence expiry", () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const baseContext = accountCapacityContext(now + 30_000, now + 120_000);
		const candidate = baseContext.exclusions[0];
		if (!candidate) throw new Error("expected capacity candidate");
		const context: RoutingCapacityContext = {
			...baseContext,
			exclusions: [
				{
					...candidate,
					exclusions: [
						...candidate.exclusions,
						{
							source: "usage_snapshot",
							scope: "account",
							window: "seven_day",
							windowKind: "weekly_all",
							modelFamily: null,
							utilization: 100,
							resetAtMs: now + 300_000,
							evidenceExpiresAt: now + 30_000,
						},
					],
				},
			],
		};
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount()],
			capacityContext: context,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("300");
	});

	it("does not treat resetless account-capacity evidence expiry as recovery", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount()],
			// blockedUntil is the snapshot freshness expiry, not a provider reset.
			capacityContext: accountCapacityContext(now + 120_000, null),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBeNull();
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("route_unavailable");
	});

	it("returns route_unavailable for empty, manual, and incomplete pools", async () => {
		const now = Date.UTC(2026, 6, 17, 12);
		for (const accounts of [
			[],
			[makeAccount({ paused: true, pause_reason: "manual" })],
			[
				makeAccount({
					rate_limited_until: now + 60_000,
					rate_limited_reason: null,
				}),
			],
			[
				makeAccount({
					rate_limited_until: now + 60_000,
					rate_limited_reason: "model_scoped_429",
				}),
			],
		]) {
			const terminal = createRoutingTerminalResponse({
				source: "selection",
				accounts,
				capacityContext: null,
				rateLimitOutcomes: [],
				upstreamAttempts: 0,
				now,
			});
			expect(terminal.kind).toBe("route_unavailable");
			expect(terminal.response.headers.get("retry-after")).toBeNull();
			expect(
				terminal.response.headers.get("x-better-ccflare-pool-status"),
			).toBeNull();
			const parsed = await body(terminal.response);
			expect(parsed.error.code).toBe("route_unavailable");
		}
	});

	it("ignores family capacity evidence that belongs only to a manually paused account", async () => {
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [makeAccount({ paused: true, pause_reason: "manual" })],
			capacityContext: familyCapacityContext(Date.now() + 60_000),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
		});

		expect(terminal.kind).toBe("route_unavailable");
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("route_unavailable");
	});

	it("allows an unpaused family-blocked route plus a manual sibling to be model-only", () => {
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount(),
				makeAccount({
					id: "manual-sibling",
					paused: true,
					pause_reason: "manual",
				}),
			],
			capacityContext: familyCapacityContext(Date.now() + 60_000),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
		});

		expect(terminal.kind).toBe("model_pool_exhausted");
	});

	it("aggregates complete mixed unpaused model inventory", () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount(),
				makeAccount({
					id: "global-sibling",
					rate_limited_until: now + 30_000,
					rate_limited_reason: "upstream_429_with_reset",
				}),
			],
			capacityContext: familyCapacityContext(now + 60_000),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("30");
	});

	it("aggregates finite recovery across mixed global and family-blocked routes", async () => {
		const now = Date.UTC(2026, 6, 20, 12);
		const primaryRecovery = now + 60_000;
		const secondaryRecovery = now + 120_000;
		const tertiaryRecovery = now + 180_000;
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({
					id: "primary",
					name: "primary",
					rate_limited_until: primaryRecovery,
					rate_limited_reason: "upstream_429_with_reset",
				}),
				makeAccount({ id: "secondary", name: "secondary" }),
				makeAccount({ id: "tertiary", name: "tertiary" }),
			],
			capacityContext: mixedFamilyCapacityContext(now, [
				{ accountId: "secondary", resetAtMs: secondaryRecovery },
				{ accountId: "tertiary", resetAtMs: tertiaryRecovery },
			]),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("60");
		expect(terminal.response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("pool_exhausted");
		expect(parsed.error.next_available_at).toBe(
			new Date(primaryRecovery).toISOString(),
		);
		expect(parsed.error.accounts).toEqual([
			{
				name: "primary",
				reason: "rate_limited",
				available_at: new Date(primaryRecovery).toISOString(),
			},
			{
				name: "secondary",
				reason: "capacity_exhausted",
				available_at: new Date(secondaryRecovery).toISOString(),
			},
			{
				name: "tertiary",
				reason: "capacity_exhausted",
				available_at: new Date(tertiaryRecovery).toISOString(),
			},
		]);
	});

	it("waits for both the account cooldown and model-lane blocker on the same route", async () => {
		const now = Date.UTC(2026, 6, 20, 12);
		const routeRecovery = now + 120_000;
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({
					rate_limited_until: now + 60_000,
					rate_limited_reason: "upstream_429_with_reset",
				}),
			],
			capacityContext: mixedFamilyCapacityContext(now, [
				{ accountId: "account-1", resetAtMs: routeRecovery },
			]),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("120");
		const parsed = await body(terminal.response);
		expect(parsed.error.next_available_at).toBe(
			new Date(routeRecovery).toISOString(),
		);
	});

	it.each([
		null,
		Number.NaN,
	])("keeps mixed recovery non-retryable when one family reset is unknown (%p)", async (unknownReset) => {
		const now = Date.UTC(2026, 6, 20, 12);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({
					id: "primary",
					name: "primary",
					rate_limited_until: now + 60_000,
					rate_limited_reason: "upstream_429_with_reset",
				}),
				makeAccount({ id: "secondary", name: "secondary" }),
				makeAccount({ id: "tertiary", name: "tertiary" }),
			],
			capacityContext: mixedFamilyCapacityContext(now, [
				{ accountId: "secondary", resetAtMs: now + 120_000 },
				{ accountId: "tertiary", resetAtMs: unknownReset },
			]),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBeNull();
		expect(
			terminal.response.headers.get("x-better-ccflare-pool-status"),
		).toBeNull();
		const parsed = await body(terminal.response);
		expect(parsed.error.code).toBe("route_unavailable");
	});

	it("keeps manually paused accounts non-retryable unless another route has finite automatic recovery", () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({ id: "manual", paused: true, pause_reason: "manual" }),
				makeAccount({
					id: "automatic",
					rate_limited_until: now + 30_000,
					rate_limited_reason: "upstream_529_overloaded_with_reset",
				}),
			],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("pool_exhausted");
		expect(terminal.response.headers.get("retry-after")).toBe("30");
	});

	it("does not mark the whole pool retryable when an unpaused route has unexplained availability", () => {
		const now = Date.UTC(2026, 6, 17, 12);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [
				makeAccount({
					id: "known-global",
					rate_limited_until: now + 30_000,
					rate_limited_reason: "upstream_429_with_reset",
				}),
				makeAccount({ id: "unexplained" }),
			],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now,
		});

		expect(terminal.kind).toBe("route_unavailable");
		expect(terminal.response.headers.get("retry-after")).toBeNull();
	});
});

describe("request-compatible terminal inventory", () => {
	it("keeps dynamic providers but honors Responses adapter OAuth exclusions", () => {
		const accounts = [
			makeAccount({ id: "anthropic-oauth", provider: "anthropic" }),
			makeAccount({
				id: "anthropic-key",
				provider: "anthropic",
				refresh_token: null as never,
				api_key: "key",
			}),
			makeAccount({ id: "codex", provider: "codex" }),
		];
		const headers = new Headers({
			"x-better-ccflare-exclude-providers": "anthropic-oauth",
		});

		expect(
			filterRequestCompatibleAccounts(accounts, headers).map(
				(account) => account.id,
			),
		).toEqual(["anthropic-key", "codex"]);
	});
});

describe("terminal account refresh merge", () => {
	const observedAt = Date.UTC(2026, 6, 21, 12);

	it("retains a newer request-local cooldown over a stale refreshed row", () => {
		const local = makeAccount({
			rate_limited_at: observedAt,
			rate_limited_until: observedAt + 120_000,
			rate_limited_reason: "upstream_429_with_reset",
			consecutive_rate_limits: 4,
		});
		const refreshed = makeAccount({
			paused: true,
			pause_reason: "manual",
			rate_limited_at: null,
			rate_limited_until: null,
			rate_limited_reason: null,
			consecutive_rate_limits: 3,
		});

		const [merged] = mergeTerminalAccountState([refreshed], [local]);

		expect(merged).toMatchObject({
			paused: true,
			pause_reason: "manual",
			rate_limited_at: observedAt,
			rate_limited_until: observedAt + 120_000,
			rate_limited_reason: "upstream_429_with_reset",
			consecutive_rate_limits: 4,
		});
	});

	it("preserves a genuinely newer refreshed cooldown observation", () => {
		const local = makeAccount({
			rate_limited_at: observedAt,
			rate_limited_until: observedAt + 120_000,
			rate_limited_reason: "upstream_429_with_reset",
			consecutive_rate_limits: 4,
		});
		const refreshed = makeAccount({
			rate_limited_at: observedAt + 1,
			rate_limited_until: observedAt + 60_000,
			rate_limited_reason: "model_fallback_429",
			consecutive_rate_limits: 5,
		});

		expect(mergeTerminalAccountState([refreshed], [local])).toEqual([
			refreshed,
		]);
	});

	it.each([
		null,
		"model_fallback_429",
	] as const)("keeps a newer verified local deadline/reason atomic over an older longer refreshed deadline with reason %s", (refreshedReason) => {
		const local = makeAccount({
			rate_limited_at: observedAt,
			rate_limited_until: observedAt + 120_000,
			rate_limited_reason: "upstream_429_with_reset",
			consecutive_rate_limits: 4,
		});
		const refreshed = makeAccount({
			rate_limited_at: observedAt - 1,
			rate_limited_until: observedAt + 300_000,
			rate_limited_reason: refreshedReason,
			consecutive_rate_limits: 7,
		});

		const [merged] = mergeTerminalAccountState([refreshed], [local]);

		expect(merged).toMatchObject({
			rate_limited_at: observedAt,
			rate_limited_until: observedAt + 120_000,
			rate_limited_reason: "upstream_429_with_reset",
			consecutive_rate_limits: 7,
		});
	});

	it("does not resurrect a refreshed row removed by DB state or request compatibility", () => {
		const local = makeAccount({
			id: "codex-local",
			provider: "codex",
			rate_limited_at: observedAt,
			rate_limited_until: observedAt + 120_000,
			rate_limited_reason: "upstream_429_with_reset",
		});
		const refreshed = makeAccount({ id: local.id, provider: "codex" });
		const excluded = filterRequestCompatibleAccounts(
			[refreshed],
			new Headers({
				"x-better-ccflare-exclude-providers": "codex",
			}),
		);

		expect(mergeTerminalAccountState([], [local])).toEqual([]);
		expect(mergeTerminalAccountState(excluded, [local])).toEqual([]);
	});
});
