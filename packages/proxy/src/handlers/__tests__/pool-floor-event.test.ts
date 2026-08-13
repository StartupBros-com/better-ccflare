import { describe, expect, it } from "bun:test";
import type {
	RoutingCapacityBlocker,
	RoutingCapacityCandidateExclusion,
} from "../account-selector";
import {
	buildPoolFloorEvent,
	emitPoolFloorEvent,
	MAX_POOL_FLOOR_ACCOUNTS,
	MAX_POOL_FLOOR_THROTTLE_KEYS,
	poolFloorApproachingThreshold,
	shouldEmitPoolFloorEvent,
} from "../pool-floor-event";

const NOW = 1_700_000_000_000;

function blocker(
	overrides: Partial<RoutingCapacityBlocker> = {},
): RoutingCapacityBlocker {
	return {
		source: "usage_snapshot",
		scope: "account",
		window: "seven_day",
		windowKind: "weekly_all",
		modelFamily: null,
		utilization: 100,
		resetAtMs: NOW + 3_600_000,
		evidenceExpiresAt: NOW + 180_000,
		...overrides,
	};
}

function exclusion(
	overrides: Partial<RoutingCapacityCandidateExclusion> = {},
): RoutingCapacityCandidateExclusion {
	return {
		accountId: "acc1",
		accountName: "Account One",
		model: "claude-sonnet-4-5",
		modelFamily: "sonnet",
		source: "normal",
		comboSlotId: null,
		comboSlotOrdinal: null,
		blockedUntil: NOW + 3_600_000,
		exclusions: [blocker()],
		...overrides,
	};
}

describe("buildPoolFloorEvent", () => {
	it("returns null when nothing was excluded", () => {
		// An empty pool with no capacity exclusions is a different failure (no
		// accounts configured, all paused); this alarm is only about capacity.
		expect(
			buildPoolFloorEvent({
				lane: "claude-sonnet-4-5",
				modelFamily: "sonnet",
				candidatesBefore: 0,
				candidatesAfter: 0,
				exclusions: [],
				now: NOW,
			}),
		).toBeNull();
	});

	it("returns null when the pool is comfortably above the floor", () => {
		expect(
			buildPoolFloorEvent({
				lane: "claude-sonnet-4-5",
				modelFamily: "sonnet",
				candidatesBefore: 5,
				candidatesAfter: 4,
				exclusions: [exclusion()],
				now: NOW,
			}),
		).toBeNull();
	});

	it("returns null when the surviving count is unknown", () => {
		// Claiming a floor without knowing the pool size would be a false alarm.
		expect(
			buildPoolFloorEvent({
				lane: null,
				modelFamily: null,
				candidatesBefore: null,
				candidatesAfter: null,
				exclusions: [exclusion()],
				now: NOW,
			}),
		).toBeNull();
	});

	it("reports a floor when capacity exclusions emptied the pool", () => {
		const event = buildPoolFloorEvent({
			lane: "claude-sonnet-4-5",
			modelFamily: "sonnet",
			candidatesBefore: 2,
			candidatesAfter: 0,
			exclusions: [
				exclusion(),
				exclusion({ accountId: "acc2", accountName: "Account Two" }),
			],
			now: NOW,
		});

		expect(event).not.toBeNull();
		expect(event?.severity).toBe("floor");
		expect(event?.lane).toBe("claude-sonnet-4-5");
		expect(event?.modelFamily).toBe("sonnet");
		expect(event?.candidatesBefore).toBe(2);
		expect(event?.candidatesAfter).toBe(0);
		expect(event?.excludedAccountCount).toBe(2);
	});

	it("reports an approaching floor while one candidate survives", () => {
		const event = buildPoolFloorEvent({
			lane: "claude-sonnet-4-5",
			modelFamily: "sonnet",
			candidatesBefore: 3,
			candidatesAfter: 1,
			exclusions: [exclusion()],
			now: NOW,
		});
		// The pre-outage signal: this is the #155 shape, where scope inversion
		// drains the pool one account at a time and nothing warns until it is 0.
		expect(event?.severity).toBe("approaching");
	});

	it("summarises blockers by scope, window and source with counts", () => {
		const event = buildPoolFloorEvent({
			lane: "claude-opus-4-5",
			modelFamily: "opus",
			candidatesBefore: 2,
			candidatesAfter: 0,
			exclusions: [
				exclusion({ exclusions: [blocker()] }),
				exclusion({
					accountId: "acc2",
					accountName: "Account Two",
					exclusions: [blocker()],
				}),
				exclusion({
					accountId: "acc3",
					accountName: "Account Three",
					exclusions: [
						blocker({
							scope: "family",
							window: "seven_day_opus",
							windowKind: "weekly_scoped",
							modelFamily: "opus",
						}),
					],
				}),
			],
			now: NOW,
		});

		expect(event?.blockers).toEqual([
			{
				scope: "account",
				window: "seven_day",
				windowKind: "weekly_all",
				source: "usage_snapshot",
				modelFamily: null,
				count: 2,
			},
			{
				scope: "family",
				window: "seven_day_opus",
				windowKind: "weekly_scoped",
				source: "usage_snapshot",
				modelFamily: "opus",
				count: 1,
			},
		]);
	});

	it("reports the earliest recovery and the soonest evidence expiry", () => {
		const event = buildPoolFloorEvent({
			lane: "claude-sonnet-4-5",
			modelFamily: "sonnet",
			candidatesBefore: 2,
			candidatesAfter: 0,
			exclusions: [
				exclusion({
					blockedUntil: NOW + 7_200_000,
					exclusions: [blocker({ evidenceExpiresAt: NOW + 300_000 })],
				}),
				exclusion({
					accountId: "acc2",
					accountName: "Account Two",
					blockedUntil: NOW + 1_800_000,
					exclusions: [blocker({ evidenceExpiresAt: NOW + 120_000 })],
				}),
			],
			now: NOW,
		});

		expect(event?.earliestRecoveryAtMs).toBe(NOW + 1_800_000);
		expect(event?.evidenceExpiresAtMs).toBe(NOW + 120_000);
	});

	it("ignores recoveries already in the past", () => {
		const event = buildPoolFloorEvent({
			lane: null,
			modelFamily: null,
			candidatesBefore: 1,
			candidatesAfter: 0,
			exclusions: [exclusion({ blockedUntil: NOW - 1000 })],
			now: NOW,
		});
		// A stale blockedUntil must not read as "recovers immediately".
		expect(event?.earliestRecoveryAtMs).toBeNull();
	});

	it("treats a null blockedUntil as an indefinite hold, not a recovery", () => {
		const event = buildPoolFloorEvent({
			lane: null,
			modelFamily: null,
			candidatesBefore: 1,
			candidatesAfter: 0,
			exclusions: [exclusion({ blockedUntil: null })],
			now: NOW,
		});
		expect(event?.earliestRecoveryAtMs).toBeNull();
	});

	it("caps the account list and reports how many were dropped", () => {
		const many = Array.from({ length: MAX_POOL_FLOOR_ACCOUNTS + 4 }, (_, i) =>
			exclusion({ accountId: `acc${i}`, accountName: `Account ${i}` }),
		);
		const event = buildPoolFloorEvent({
			lane: null,
			modelFamily: null,
			candidatesBefore: many.length,
			candidatesAfter: 0,
			exclusions: many,
			now: NOW,
		});

		expect(event?.excludedAccountCount).toBe(many.length);
		expect(event?.excludedAccounts).toHaveLength(MAX_POOL_FLOOR_ACCOUNTS);
		expect(event?.truncatedAccountCount).toBe(4);
	});

	it("counts one account once even when several of its models are excluded", () => {
		const event = buildPoolFloorEvent({
			lane: "claude-sonnet-4-5",
			modelFamily: "sonnet",
			candidatesBefore: 1,
			candidatesAfter: 0,
			exclusions: [
				exclusion({ model: "claude-sonnet-4-5" }),
				exclusion({ model: "claude-haiku-4-5" }),
			],
			now: NOW,
		});
		expect(event?.excludedAccountCount).toBe(1);
		expect(event?.excludedAccounts).toHaveLength(1);
		expect(event?.excludedAccounts[0].windows).toEqual(["seven_day"]);
	});

	it("carries no credentials, prompt content or request bodies", () => {
		const event = buildPoolFloorEvent({
			lane: "claude-sonnet-4-5",
			modelFamily: "sonnet",
			candidatesBefore: 1,
			candidatesAfter: 0,
			exclusions: [exclusion()],
			now: NOW,
		});
		const serialized = JSON.stringify(event);
		for (const forbidden of [
			"access_token",
			"refresh_token",
			"api_key",
			"authorization",
			"messages",
			"system",
		]) {
			expect(serialized.toLowerCase()).not.toContain(forbidden);
		}
	});
});

describe("shouldEmitPoolFloorEvent", () => {
	it("suppresses a repeat of the same lane and severity inside the window", () => {
		const state = new Map<string, number>();
		expect(shouldEmitPoolFloorEvent(state, "sonnet", "floor", NOW)).toBe(true);
		expect(shouldEmitPoolFloorEvent(state, "sonnet", "floor", NOW + 1000)).toBe(
			false,
		);
	});

	it("re-emits once the throttle window elapses", () => {
		const state = new Map<string, number>();
		shouldEmitPoolFloorEvent(state, "sonnet", "floor", NOW);
		expect(
			shouldEmitPoolFloorEvent(state, "sonnet", "floor", NOW + 60_001),
		).toBe(true);
	});

	it("does not let one lane's alarm silence another", () => {
		const state = new Map<string, number>();
		shouldEmitPoolFloorEvent(state, "sonnet", "floor", NOW);
		expect(shouldEmitPoolFloorEvent(state, "opus", "floor", NOW)).toBe(true);
	});

	it("does not let an approaching alarm silence a real floor", () => {
		const state = new Map<string, number>();
		shouldEmitPoolFloorEvent(state, "sonnet", "approaching", NOW);
		// Escalation must always get through — that is the alarm that matters.
		expect(shouldEmitPoolFloorEvent(state, "sonnet", "floor", NOW)).toBe(true);
	});

	it("stays bounded when a caller sends unbounded distinct lanes", () => {
		// `lane` is the effective model, which a client can vary freely. Without
		// a cap this map would grow for the life of the process.
		const state = new Map<string, number>();
		for (let i = 0; i < MAX_POOL_FLOOR_THROTTLE_KEYS * 4; i++) {
			shouldEmitPoolFloorEvent(state, `lane-${i}`, "floor", NOW);
		}
		expect(state.size).toBeLessThanOrEqual(MAX_POOL_FLOOR_THROTTLE_KEYS);
	});

	it("drops keys that are past the throttle window before evicting live ones", () => {
		const state = new Map<string, number>();
		for (let i = 0; i < MAX_POOL_FLOOR_THROTTLE_KEYS; i++) {
			shouldEmitPoolFloorEvent(state, `stale-${i}`, "floor", NOW);
		}
		// Every prior key is now outside the window, so admitting a new lane
		// should reclaim them rather than evict anything still suppressing.
		const later = NOW + 60_001;
		expect(shouldEmitPoolFloorEvent(state, "fresh", "floor", later)).toBe(true);
		expect(state.size).toBe(1);
	});

	it("still admits a new lane once the map is saturated", () => {
		// The cap must bound memory without ever costing an operator an alarm for
		// a lane that has not been seen before.
		const state = new Map<string, number>();
		for (let i = 0; i < MAX_POOL_FLOOR_THROTTLE_KEYS * 2; i++) {
			shouldEmitPoolFloorEvent(state, `lane-${i}`, "floor", NOW);
		}
		expect(
			shouldEmitPoolFloorEvent(state, "brand-new-lane", "floor", NOW),
		).toBe(true);
		expect(state.size).toBeLessThanOrEqual(MAX_POOL_FLOOR_THROTTLE_KEYS);
	});
});

describe("emitPoolFloorEvent", () => {
	function recorder() {
		const warns: Array<{ message: string; data?: unknown }> = [];
		const errors: Array<{ message: string; data?: unknown }> = [];
		return {
			warns,
			errors,
			logger: {
				warn: (message: string, data?: unknown) =>
					warns.push({ message, data }),
				error: (message: string, data?: unknown) =>
					errors.push({ message, data }),
			},
		};
	}

	const floorInput = {
		lane: "claude-sonnet-4-5",
		modelFamily: "sonnet",
		candidatesBefore: 2,
		candidatesAfter: 0,
		exclusions: [exclusion()],
		now: NOW,
	};

	it("logs an empty pool at error level", () => {
		const { logger, errors, warns } = recorder();
		const event = emitPoolFloorEvent(logger, new Map(), floorInput);
		expect(event?.severity).toBe("floor");
		expect(errors).toHaveLength(1);
		expect(warns).toHaveLength(0);
		expect(errors[0].data).toBe(event);
	});

	it("logs an approaching floor at warn level", () => {
		const { logger, errors, warns } = recorder();
		emitPoolFloorEvent(logger, new Map(), {
			...floorInput,
			candidatesAfter: 1,
		});
		expect(warns).toHaveLength(1);
		expect(errors).toHaveLength(0);
	});

	it("logs nothing when the condition does not apply", () => {
		const { logger, errors, warns } = recorder();
		const event = emitPoolFloorEvent(logger, new Map(), {
			...floorInput,
			exclusions: [],
		});
		expect(event).toBeNull();
		expect(errors).toHaveLength(0);
		expect(warns).toHaveLength(0);
	});

	it("logs once per lane inside the throttle window", () => {
		const { logger, errors } = recorder();
		const state = new Map<string, number>();
		emitPoolFloorEvent(logger, state, floorInput);
		emitPoolFloorEvent(logger, state, { ...floorInput, now: NOW + 1000 });
		expect(errors).toHaveLength(1);
	});

	it("never throws when the logger itself fails", () => {
		// Observability sits on the request path; it must not break routing.
		const hostile = {
			warn: () => {
				throw new Error("log sink down");
			},
			error: () => {
				throw new Error("log sink down");
			},
		};
		expect(() =>
			emitPoolFloorEvent(hostile, new Map(), floorInput),
		).not.toThrow();
		expect(emitPoolFloorEvent(hostile, new Map(), floorInput)).toBeNull();
	});
});

describe("poolFloorApproachingThreshold", () => {
	it("defaults to warning while a single candidate remains", () => {
		expect(poolFloorApproachingThreshold(undefined)).toBe(1);
		expect(poolFloorApproachingThreshold("")).toBe(1);
	});

	it("accepts an operator override", () => {
		expect(poolFloorApproachingThreshold("3")).toBe(3);
	});

	it("treats 0 as disabling the approaching tier", () => {
		expect(poolFloorApproachingThreshold("0")).toBe(0);
	});

	it("falls back to the default for a malformed or negative value", () => {
		expect(poolFloorApproachingThreshold("abc")).toBe(1);
		expect(poolFloorApproachingThreshold("-2")).toBe(1);
		expect(poolFloorApproachingThreshold("1.5")).toBe(1);
	});
});
