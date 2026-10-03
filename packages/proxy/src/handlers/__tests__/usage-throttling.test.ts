import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	compareQuotaPressure,
	createUsageThrottledResponse,
	evaluateAutoCapacity,
	evaluateHardCapacity,
	getUsageThrottleStatus,
	getUsageThrottleUntil,
	getWeeklyQuotaPressure,
} from "../usage-throttling";

describe("mandatory Auto capacity and spend", () => {
	const now = 1000;
	const opts = {
		accountId: "a",
		line: "claude-fable" as const,
		provider: "anthropic" as const,
		requestModel: "claude-fable-5-1",
		observedAt: now,
		now,
		spendGrants: [],
	};
	const weekly = { kind: "weekly_all", percent: 60, resets_at: 10000 };
	const fable = {
		kind: "weekly_scoped",
		percent: 120,
		resets_at: 10000,
		scope: { model: { display_name: "Fable" } },
	};
	it("blocks Fable only, independent of optional switches and without a 50% cutoff", () => {
		const data = { limits: [weekly, fable], spend: { enabled: false } };
		expect(evaluateAutoCapacity(data, opts)).toMatchObject({
			status: "reject",
			reason: "subscription-exhausted",
		});
		expect(
			evaluateAutoCapacity(data, { ...opts, requestModel: "claude-opus-5-5" })
				.status,
		).toBe("admit");
	});
	it("admits Sonnet and Opus with nonbinding shared headroom while only Fable binds", () => {
		const resets_at = new Date(now + 60000).toISOString();
		const data = {
			limits: [
				{ kind: "session", percent: 8, resets_at, is_active: false },
				{ ...weekly, percent: 28, resets_at, is_active: false },
				{ ...fable, percent: 100, resets_at, is_active: true },
			],
			five_hour: { utilization: 8, resets_at },
			seven_day: { utilization: 28, resets_at },
			spend: { enabled: false },
		};
		expect(evaluateAutoCapacity(data, opts)).toEqual({
			status: "reject",
			reason: "subscription-exhausted",
		});
		for (const requestModel of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
			expect(evaluateAutoCapacity(data, { ...opts, requestModel })).toEqual({
				status: "admit",
			});
		}
	});
	it("does not resurrect inactive generic mirrors or call malformed evidence exhaustion", () => {
		const data = {
			limits: [
				{ ...weekly, percent: 100, is_active: false },
				{ ...fable, percent: 10 },
			],
			seven_day: { utilization: 100, resets_at: 10000 },
			spend: { enabled: false },
		};
		expect(evaluateAutoCapacity(data, opts).status).toBe("unknown");
		expect(
			evaluateAutoCapacity(
				{ ...data, limits: [{ ...weekly, percent: -1 }] },
				opts,
			).status,
		).toBe("unknown");
	});
	it("requires valid future-reset inactive shared headroom and preserves independent blockers", () => {
		for (const invalid of [
			{ percent: 100 },
			{ percent: 120 },
			{ percent: -1 },
			{ percent: null },
			{ percent: Number.NaN },
			{ resets_at: null },
			{ resets_at: "invalid" },
			{ resets_at: now },
			{ resets_at: now - 1 },
		]) {
			const inactive = { ...weekly, is_active: false, ...invalid };
			for (const utilization of [10, 100]) {
				const data = {
					limits: [inactive],
					seven_day: { utilization, resets_at: 10000 },
					spend: { enabled: false },
				};
				expect(evaluateAutoCapacity(data, opts)).toEqual({
					status: "unknown",
					reason: "capacity-evidence-unknown",
				});
				expect(
					evaluateAutoCapacity(
						{
							...data,
							limits: [inactive, { ...weekly, percent: 100, is_active: true }],
						},
						opts,
					),
				).toEqual({
					status: "reject",
					reason: "provider-capacity-exhausted",
				});
				expect(
					evaluateAutoCapacity(
						{ ...data, limits: [inactive, { ...fable, is_active: true }] },
						opts,
					),
				).toEqual({
					status: "reject",
					reason: "subscription-exhausted",
				});
			}
		}
	});
	it("nonbinding headroom cannot bypass freshness, active validity or spending checks", () => {
		const data = {
			limits: [{ ...weekly, is_active: false }],
			spend: { enabled: false },
		};
		for (const observedAt of [now - 180000, now + 1]) {
			expect(evaluateAutoCapacity(data, { ...opts, observedAt }).status).toBe(
				"unknown",
			);
		}
		expect(
			evaluateAutoCapacity({ ...data, spend: { enabled: true } }, opts),
		).toEqual({ status: "unknown", reason: "spend-not-authorized" });
		expect(
			evaluateAutoCapacity(
				{
					...data,
					limits: [...data.limits, { ...weekly, percent: -1, is_active: true }],
				},
				opts,
			).status,
		).toBe("unknown");
		expect(
			evaluateAutoCapacity(
				{
					...data,
					limits: [
						...data.limits,
						{ ...weekly, percent: 100, is_active: true },
					],
				},
				opts,
			),
		).toEqual({ status: "reject", reason: "provider-capacity-exhausted" });
	});
	it("requires permission AND availability, and grants cannot override a hard account blocker", () => {
		const grant = {
			accountId: "a",
			line: "claude-fable" as const,
			authorization: "operator-approved" as const,
			scope: "outside-subscription" as const,
		};
		for (const enabled of [true, undefined]) {
			const data = { limits: [weekly, fable], spend: { enabled, percent: 10 } };
			expect(evaluateAutoCapacity(data, opts)).toMatchObject({
				status: "reject",
				reason: "spend-not-authorized",
			});
			expect(
				evaluateAutoCapacity(data, { ...opts, spendGrants: [grant] }).status,
			).toBe(enabled ? "admit" : "unknown");
		}
		expect(
			evaluateAutoCapacity(
				{ limits: [{ ...weekly, percent: 100 }], spend: { enabled: true } },
				{ ...opts, spendGrants: [grant] },
			),
		).toMatchObject({
			status: "reject",
			reason: "provider-capacity-exhausted",
		});
	});
	it("does not use an old disabled billing mirror to prove free execution", () => {
		expect(
			evaluateAutoCapacity(
				{
					limits: [weekly],
					spend: { enabled: null },
					extra_usage: { is_enabled: false },
				},
				opts,
			),
		).toMatchObject({ status: "unknown", reason: "spend-not-authorized" });
	});
	it("does not equate provider billing enablement or an operator grant with paid capacity", () => {
		const granted = {
			...opts,
			spendGrants: [
				{
					accountId: "a",
					line: "claude-fable" as const,
					authorization: "operator-approved" as const,
					scope: "outside-subscription" as const,
				},
			],
		};
		expect(
			evaluateAutoCapacity(
				{ limits: [weekly, fable], spend: { enabled: true } },
				granted,
			),
		).toEqual({ status: "unknown", reason: "billing-evidence-unknown" });
		expect(
			evaluateAutoCapacity(
				{ limits: [weekly, fable], spend: { enabled: true, percent: 110 } },
				granted,
			),
		).toEqual({ status: "reject", reason: "provider-capacity-exhausted" });
	});
	it("keeps independently valid blockers despite duplicate invalid rows; rejects stale/future/reset proof as unknown", () => {
		const data = {
			limits: [weekly, fable, { ...fable, percent: -1 }],
			spend: { enabled: false },
		};
		expect(evaluateAutoCapacity(data, opts).status).toBe("reject");
		for (const observedAt of [-500000, 1001])
			expect(evaluateAutoCapacity(data, { ...opts, observedAt }).status).toBe(
				"unknown",
			);
		expect(
			evaluateAutoCapacity(
				{ ...data, limits: [{ ...weekly, resets_at: now }] },
				opts,
			).status,
		).toBe("unknown");
	});
});

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Codex Account",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
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
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

describe("getUsageThrottleUntil", () => {
	it("returns a future resume time when Codex usage is ahead of the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 80, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).not.toBeNull();
		expect(throttleUntil).toBeGreaterThan(now);
	});

	it("does not throttle when usage is below the pacing line", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 30 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 10, resets_at: resetAt },
				seven_day: { utilization: 5, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBeNull();
	});

	it("does not double-count anthropic-like usage as Alibaba usage", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = now + 2 * 24 * 60 * 60 * 1000;

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 10,
					resets_at: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
				},
				weekly: { percentUsed: 95, resetAt },
				monthly: {
					percentUsed: 10,
					resetAt: now + 20 * 24 * 60 * 60 * 1000,
				},
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBeNull();
	});

	it("can throttle weekly usage independently from the 5-hour window", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const throttleStatus = getUsageThrottleStatus(
			{
				five_hour: {
					utilization: 10,
					resets_at: new Date(now + 30 * 60 * 1000).toISOString(),
				},
				seven_day: {
					utilization: 95,
					resets_at: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
				},
			},
			{ fiveHourEnabled: false, weeklyEnabled: true },
			now,
		);

		expect(throttleStatus.throttledWindows).toEqual(["seven_day"]);
		expect(throttleStatus.throttleUntil).not.toBeNull();
	});

	it("caps throttleUntil at the window reset when utilization exceeds 100%", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 60 * 60 * 1000).toISOString();

		const throttleUntil = getUsageThrottleUntil(
			{
				five_hour: { utilization: 120, resets_at: resetAt },
				seven_day: { utilization: 10, resets_at: null },
			},
			{ fiveHourEnabled: true, weeklyEnabled: true },
			now,
		);

		expect(throttleUntil).toBe(new Date(resetAt).getTime());
	});
});

describe("model-aware limits[] throttling (Phase 2a)", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	// A weekly window that started ~1h ago -> any utilization is over the pacing line.
	const weekReset = new Date(
		NOW + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();

	const scoped = (percent: number, displayName = "Fable") =>
		({
			limits: [
				{
					kind: "weekly_scoped",
					percent,
					resets_at: weekReset,
					scope: {
						model: { id: null, display_name: displayName },
						surface: null,
					},
				},
			],
		}) as never;

	it("reads weekly_scoped from limits[] and throttles it (scopedMode 'all')", () => {
		const status = getUsageThrottleStatus(scoped(50), settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("seven_day_fable");
		expect(status.throttleUntil).not.toBeNull();
	});

	it("throttles a scoped Fable cap only for the matching request family (match mode)", () => {
		expect(
			getUsageThrottleUntil(scoped(50), settings, NOW, {
				requestModel: "claude-fable-5",
				scopedMode: "match",
			}),
		).not.toBeNull();
		// An Opus request over the same account is NOT throttled by the Fable cap.
		expect(
			getUsageThrottleUntil(scoped(50), settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).toBeNull();
	});

	it("skips scoped windows when the request model is unknown/combo (null) in match mode", () => {
		expect(
			getUsageThrottleUntil(scoped(50), settings, NOW, {
				requestModel: null,
				scopedMode: "match",
			}),
		).toBeNull();
	});

	it("throttles weekly_all regardless of the request model", () => {
		const data = {
			limits: [
				{ kind: "weekly_all", percent: 50, resets_at: weekReset, scope: null },
			],
		} as never;
		expect(
			getUsageThrottleUntil(data, settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).not.toBeNull();
	});

	it("throttles a dynamic seven_day_<slug> window (isWindowThrottlingEnabled default)", () => {
		const status = getUsageThrottleStatus(
			scoped(50, "Fable 4.5"),
			settings,
			NOW,
			{ scopedMode: "all" },
		);
		expect(status.throttledWindows).toContain("seven_day_fable_4_5");
	});

	it("prefers limits[] for the windows it carries (weekly_all -> seven_day)", () => {
		const data = {
			five_hour: { utilization: 5, resets_at: weekReset },
			seven_day: { utilization: 5, resets_at: weekReset },
			limits: [
				{ kind: "weekly_all", percent: 50, resets_at: weekReset, scope: null },
			],
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		// seven_day comes from the limits[] weekly_all (50%, over pace).
		expect(status.throttledWindows).toContain("seven_day");
		// the low flat five_hour (5%) is below pace, so it is not throttled.
		expect(status.throttledWindows).not.toContain("five_hour");
	});
});

describe("review fixes (codex/grok/fable)", () => {
	const NOW = Date.UTC(2026, 3, 28, 12, 0, 0);
	const settings = { fiveHourEnabled: true, weeklyEnabled: true };
	const weekReset = new Date(
		NOW + 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();
	const fiveReset = new Date(
		NOW + 5 * 60 * 60 * 1000 - 60 * 60 * 1000,
	).toISOString();

	it("falls back to flat windows when limits[] is present but empty", () => {
		const data = {
			limits: [],
			five_hour: { utilization: 50, resets_at: fiveReset },
			seven_day: { utilization: 50, resets_at: weekReset },
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("five_hour");
	});

	it("falls back to flat windows when every limits[] entry has null percent", () => {
		const data = {
			limits: [
				{ kind: "session", percent: null, resets_at: fiveReset, scope: null },
				{
					kind: "weekly_all",
					percent: null,
					resets_at: weekReset,
					scope: null,
				},
			],
			five_hour: { utilization: 50, resets_at: fiveReset },
			seven_day: { utilization: 50, resets_at: weekReset },
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		expect(status.throttledWindows).toContain("five_hour");
	});

	it("does NOT throttle a scoped cap with an unmapped model family in match mode", () => {
		// "Mystery" contains no fable/opus/sonnet/haiku -> modelFamily undefined.
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 50,
					resets_at: weekReset,
					scope: {
						model: { id: null, display_name: "Mystery" },
						surface: null,
					},
				},
			],
		} as never;
		// match mode with any model -> scoped skipped (cannot attribute) -> no throttle.
		expect(
			getUsageThrottleUntil(data, settings, NOW, {
				requestModel: "claude-opus-4-8",
				scopedMode: "match",
			}),
		).toBeNull();
		// all mode (display) still surfaces the cap.
		expect(
			getUsageThrottleStatus(data, settings, NOW, { scopedMode: "all" })
				.throttledWindows,
		).toContain("seven_day_mystery");
	});

	it("does not double-count five_hour when limits[] session and flat five_hour both exist", () => {
		const data = {
			five_hour: { utilization: 90, resets_at: fiveReset },
			limits: [
				{ kind: "session", percent: 90, resets_at: fiveReset, scope: null },
			],
		} as never;
		const status = getUsageThrottleStatus(data, settings, NOW, {
			scopedMode: "all",
		});
		// five_hour comes from the limits[] session; the flat five_hour is NOT re-added.
		expect(
			status.throttledWindows.filter((w) => w === "five_hour"),
		).toHaveLength(1);
	});

	it("still evaluates the flat account cap when limits[] carries only a scoped row (Greptile hybrid)", () => {
		// limits[] has ONLY a per-model Fable cap; the flat five_hour account cap is
		// exhausted and NOT represented in limits[].
		const data = {
			five_hour: { utilization: 95, resets_at: fiveReset },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 50,
					resets_at: weekReset,
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
				},
			],
		} as never;
		// A Sonnet request: the Fable scoped cap is skipped (family mismatch), but
		// the exhausted flat five_hour ACCOUNT cap must still throttle.
		expect(
			getUsageThrottleUntil(data, settings, NOW, {
				requestModel: "claude-sonnet-4-5",
				scopedMode: "match",
			}),
		).not.toBeNull();
	});
});

describe("always-on hard capacity", () => {
	const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
	const OBSERVED_AT = NOW - 30_000;
	const futureReset = new Date(NOW + 60 * 60 * 1000).toISOString();

	it("blocks every model for an exhausted session or weekly-all window", () => {
		for (const kind of ["session", "weekly_all"] as const) {
			const result = evaluateHardCapacity(
				{
					limits: [{ kind, percent: 100, resets_at: futureReset, scope: null }],
				} as never,
				{
					requestModel: "claude-opus-4-8",
					observedAt: OBSERVED_AT,
					now: NOW,
				},
			);

			expect(result.eligible).toBe(false);
			expect(result.exclusions).toHaveLength(1);
			expect(result.exclusions[0]?.scope).toBe("account");
		}
	});

	it("blocks only the matching family for an exhausted scoped window", () => {
		const data = {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: futureReset,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never;

		const fable = evaluateHardCapacity(data, {
			requestModel: "claude-fable-5",
			observedAt: OBSERVED_AT,
			provider: "anthropic",
			now: NOW,
		});
		const opus = evaluateHardCapacity(data, {
			requestModel: "claude-opus-4-8",
			observedAt: OBSERVED_AT,
			provider: "anthropic",
			now: NOW,
		});

		expect(fable.eligible).toBe(false);
		expect(fable.exclusions[0]).toMatchObject({
			scope: "family",
			modelFamily: "fable",
		});
		expect(opus).toMatchObject({ eligible: true, exclusions: [] });
	});

	it("fails open for Anthropic scoped caps when overage is enabled or unknown", () => {
		const limit = {
			kind: "weekly_scoped",
			percent: 100,
			resets_at: futureReset,
			scope: { model: { display_name: "Fable" } },
		};
		for (const data of [
			{ spend: { enabled: true }, limits: [limit] },
			{ limits: [limit] },
		]) {
			expect(
				evaluateHardCapacity(data as never, {
					requestModel: "claude-fable-5",
					observedAt: OBSERVED_AT,
					provider: "anthropic",
					now: NOW,
				}),
			).toMatchObject({ eligible: true, exclusions: [] });
		}
	});

	it("fails open unless every raw row for the family proves exhaustion", () => {
		const data = {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: futureReset,
					scope: { model: { display_name: "Fable" } },
				},
				{
					kind: "weekly_scoped",
					percent: null,
					resets_at: null,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never;

		expect(
			evaluateHardCapacity(data, {
				requestModel: "claude-fable-5",
				observedAt: OBSERVED_AT,
				provider: "anthropic",
				now: NOW,
			}),
		).toMatchObject({ eligible: true, exclusions: [] });
	});

	it("fails open when one of several scoped surfaces still has capacity", () => {
		const data = {
			spend: { enabled: false },
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: futureReset,
					scope: { model: { display_name: "Fable" } },
				},
				{
					kind: "weekly_scoped",
					percent: 75,
					resets_at: futureReset,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never;

		expect(
			evaluateHardCapacity(data, {
				requestModel: "claude-fable-5",
				observedAt: OBSERVED_AT,
				provider: "anthropic",
				now: NOW,
			}),
		).toMatchObject({ eligible: true, exclusions: [] });
	});

	it("fails open for unrelated and unknown scoped families", () => {
		const limits = [
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: futureReset,
				scope: { model: { display_name: "Fable" } },
			},
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: futureReset,
				scope: { model: { display_name: "Mystery Model" } },
			},
		];

		expect(
			evaluateHardCapacity({ limits } as never, {
				requestModel: "claude-opus-4-8",
				observedAt: OBSERVED_AT,
				now: NOW,
			}),
		).toMatchObject({ eligible: true, exclusions: [] });
	});

	it("ignores resets in the past", () => {
		const result = evaluateHardCapacity(
			{
				limits: [
					{
						kind: "weekly_all",
						percent: 100,
						resets_at: new Date(NOW - 1).toISOString(),
						scope: null,
					},
				],
			} as never,
			{
				requestModel: "claude-opus-4-8",
				observedAt: OBSERVED_AT,
				now: NOW,
			},
		);

		expect(result).toMatchObject({ eligible: true, exclusions: [] });
	});

	it("bounds reset-less exhaustion by snapshot freshness", () => {
		const data = {
			limits: [
				{ kind: "weekly_all", percent: 100, resets_at: null, scope: null },
			],
		} as never;
		const options = {
			requestModel: "claude-opus-4-8",
			observedAt: NOW,
			snapshotFreshnessMs: 180_000,
		};

		expect(
			evaluateHardCapacity(data, { ...options, now: NOW + 179_999 }),
		).toMatchObject({ eligible: false, snapshotFresh: true });
		expect(
			evaluateHardCapacity(data, { ...options, now: NOW + 180_000 }),
		).toMatchObject({ eligible: true, snapshotFresh: false });
	});

	it("ignores inactive account-wide and model-scoped limit rows", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 100,
					resets_at: futureReset,
					is_active: false,
					scope: null,
				},
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: futureReset,
					is_active: false,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never;

		expect(
			evaluateHardCapacity(data, {
				requestModel: "claude-fable-5",
				observedAt: OBSERVED_AT,
				now: NOW,
			}),
		).toMatchObject({ eligible: true, exclusions: [] });
		expect(
			getWeeklyQuotaPressure(data, {
				requestModel: "claude-fable-5",
				observedAt: OBSERVED_AT,
				provider: "anthropic",
				billingClass: "oauth-subscription",
				now: NOW,
			}),
		).toBeNull();
	});
});

describe("model-relevant weekly quota pressure", () => {
	const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
	const baseOptions = {
		requestModel: "claude-fable-5",
		observedAt: NOW,
		provider: "codex",
		billingClass: "max",
		now: NOW,
	};

	function pressureAt(rate: number) {
		return getWeeklyQuotaPressure(
			{
				limits: [
					{
						kind: "weekly_scoped",
						percent: 100 - rate,
						resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
						scope: { model: { display_name: "Fable" } },
					},
				],
			} as never,
			baseOptions,
		);
	}

	it("uses a matching weekly-scoped window ahead of weekly-all and session", () => {
		const pressure = getWeeklyQuotaPressure(
			{
				limits: [
					{
						kind: "session",
						percent: 1,
						resets_at: new Date(NOW + 5 * 60 * 1000).toISOString(),
						scope: null,
					},
					{
						kind: "weekly_all",
						percent: 99,
						resets_at: new Date(NOW + 100 * 60 * 60 * 1000).toISOString(),
						scope: null,
					},
					{
						kind: "weekly_scoped",
						percent: 80,
						resets_at: new Date(NOW + 5 * 60 * 60 * 1000).toISOString(),
						scope: { model: { display_name: "Fable" } },
					},
				],
			} as never,
			baseOptions,
		);

		expect(pressure).toMatchObject({
			windowKind: "weekly_scoped",
			modelFamily: "fable",
			requiredBurnRate: 4,
			band: "critical",
			comparator: {
				provider: "codex",
				billingClass: "max",
				windowKind: "weekly_scoped",
			},
		});
	});

	it("falls back to weekly-all when no matching scoped window exists", () => {
		const pressure = getWeeklyQuotaPressure(
			{
				limits: [
					{
						kind: "weekly_all",
						percent: 98,
						resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
						scope: null,
					},
				],
			} as never,
			baseOptions,
		);

		expect(pressure).toMatchObject({
			windowKind: "weekly_all",
			requiredBurnRate: 2,
			band: "urgent",
		});
	});

	it("assigns the fixed pressure bands at their exact lower boundaries", () => {
		expect(pressureAt(4)?.band).toBe("critical");
		expect(pressureAt(2)?.band).toBe("urgent");
		expect(pressureAt(1)?.band).toBe("hot");
		expect(pressureAt(0.5)?.band).toBe("warm");
		expect(pressureAt(0.25)?.band).toBe("steady");
		expect(pressureAt(0.2)?.band).toBe("cold");
	});

	it("returns no pressure for stale snapshots, past resets, or exhausted lanes", () => {
		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 100,
					resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
					scope: null,
				},
			],
		} as never;
		expect(getWeeklyQuotaPressure(data, baseOptions)).toBeNull();
		expect(
			getWeeklyQuotaPressure(data, {
				...baseOptions,
				observedAt: NOW - 180_001,
				snapshotFreshnessMs: 180_000,
			}),
		).toBeNull();
		expect(
			getWeeklyQuotaPressure(
				{
					limits: [
						{
							kind: "weekly_all",
							percent: 50,
							resets_at: new Date(NOW - 1).toISOString(),
							scope: null,
						},
					],
				} as never,
				baseOptions,
			),
		).toBeNull();
	});

	it("compares only matching provider, billing class, and weekly window kind", () => {
		const critical = pressureAt(4);
		const urgent = pressureAt(2);
		expect(compareQuotaPressure(critical, urgent)).toBe(1);
		expect(compareQuotaPressure(urgent, critical)).toBe(-1);
		expect(compareQuotaPressure(critical, pressureAt(5))).toBe(0);

		const data = {
			limits: [
				{
					kind: "weekly_all",
					percent: 96,
					resets_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
					scope: null,
				},
			],
		} as never;
		const otherWindow = getWeeklyQuotaPressure(data, baseOptions);
		const otherProvider = getWeeklyQuotaPressure(data, {
			...baseOptions,
			provider: "anthropic",
		});
		const otherBilling = getWeeklyQuotaPressure(data, {
			...baseOptions,
			billingClass: "pro",
		});
		const unknownBilling = getWeeklyQuotaPressure(data, {
			...baseOptions,
			billingClass: null,
		});

		expect(compareQuotaPressure(critical, otherWindow)).toBeNull();
		expect(compareQuotaPressure(otherWindow, otherProvider)).toBeNull();
		expect(compareQuotaPressure(otherWindow, otherBilling)).toBeNull();
		expect(compareQuotaPressure(unknownBilling, unknownBilling)).toBeNull();
	});
});

describe("createUsageThrottledResponse", () => {
	it("returns HTTP 529 with Retry-After and an Anthropic-style overload body", async () => {
		const response = createUsageThrottledResponse([
			makeAccount({ name: "Codex A" }),
			makeAccount({ id: "acc-2", name: "Codex B" }),
		]);

		expect(response.status).toBe(529);
		expect(response.headers.get("Retry-After")).toBe("60");

		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toContain("Codex A");
		expect(body.error.message).toContain("Codex B");
	});
});

describe("Codex credit drain relaxation", () => {
	const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
	const OBSERVED_AT = NOW - 30_000;
	const reset = new Date(NOW + 60 * 60 * 1000).toISOString();
	const base = { requestModel: "gpt-6", observedAt: OBSERVED_AT, now: NOW };

	for (const window of ["seven_day", "five_hour"] as const) {
		const data = {
			five_hour: { utilization: 10, resets_at: reset },
			seven_day: { utilization: 10, resets_at: reset },
			[window]: { utilization: 100, resets_at: reset },
		} as never;
		it(`excludes a codex ${window} window at 100% by default`, () => {
			const result = evaluateHardCapacity(data, {
				...base,
				provider: "codex",
			});
			expect(result.eligible).toBe(false);
			expect(result.exclusions[0]?.scope).toBe("account");
		});
		it(`keeps a codex ${window} window at 100% eligible when creditDrainActive`, () => {
			const result = evaluateHardCapacity(data, {
				...base,
				provider: "codex",
				creditDrainActive: true,
			});
			expect(result.eligible).toBe(true);
			expect(result.exclusions).toEqual([]);
		});
		it(`ignores creditDrainActive for non-codex providers (${window})`, () => {
			for (const provider of ["anthropic", "xai", null]) {
				const result = evaluateHardCapacity(data, {
					...base,
					provider,
					creditDrainActive: true,
				});
				expect(result.eligible).toBe(false);
			}
		});
	}

	it("still excludes a spent weekly_scoped family under creditDrainActive", () => {
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: reset,
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as never;
		const result = evaluateHardCapacity(data, {
			requestModel: "claude-fable-5",
			observedAt: OBSERVED_AT,
			now: NOW,
			provider: "codex",
			creditDrainActive: true,
		});
		expect(result.exclusions.map((e) => e.scope)).toEqual(["family"]);
	});

	it("getUsageThrottleStatus skips only spent windows when creditDrainActive", () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const fiveHourReset = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		const weekReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		const data = {
			five_hour: { utilization: 100, resets_at: fiveHourReset },
			seven_day: { utilization: 90, resets_at: weekReset },
		} as never;
		const settings = { fiveHourEnabled: true, weeklyEnabled: true };
		expect(
			getUsageThrottleStatus(data, settings, now).throttledWindows,
		).toEqual(expect.arrayContaining(["five_hour", "seven_day"]));
		expect(
			getUsageThrottleStatus(data, settings, now, { creditDrainActive: true })
				.throttledWindows,
		).toEqual(["seven_day"]);
		expect(
			getUsageThrottleUntil(
				{ five_hour: { utilization: 100, resets_at: fiveHourReset } } as never,
				settings,
				now,
				{ creditDrainActive: true },
			),
		).toBeNull();
	});
});
