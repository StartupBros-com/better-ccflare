import { describe, expect, it } from "bun:test";
import type { AffinityOwnerSnapshot } from "@better-ccflare/types";
import type { AnthropicDegradedCohortKey } from "../anthropic-degraded-mode";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";

const owner: AffinityOwnerSnapshot = {
	candidateId: "account:owner",
	accountId: "owner",
};
const cohortKey = "cohort-a" as AnthropicDegradedCohortKey;

describe("DegradedOwnerOverlay", () => {
	it("retains the capture-once owner for a matching protected cohort", () => {
		const overlay = new DegradedOwnerOverlay();

		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "open",
				requestKind: "large",
				owner,
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner });

		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "probing",
				requestKind: "large",
				owner: {
					candidateId: "account:temporary-fallback",
					accountId: "temporary-fallback",
				},
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner });
	});

	it("promotes the first pre-quorum owner instead of a later fallback", () => {
		const overlay = new DegradedOwnerOverlay();
		expect(
			overlay.retainQualifyingOwner({
				laneKey: "lane-a",
				cohortKey,
				owner,
			}),
		).toBe(true);

		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "open",
				requestKind: "large",
				owner: {
					candidateId: "account:fallback",
					accountId: "fallback",
				},
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner });
	});

	it("refreshes qualifying evidence lifetime without replacing its first owner", () => {
		let now = 0;
		const overlay = new DegradedOwnerOverlay({
			evidenceWindowMs: 100,
			now: () => now,
		});
		overlay.retainQualifyingOwner({
			laneKey: "lane-a",
			cohortKey,
			owner,
		});

		now = 99;
		overlay.retainQualifyingOwner({
			laneKey: "lane-a",
			cohortKey,
			owner: {
				candidateId: "account:fallback",
				accountId: "fallback",
			},
		});
		now = 150;

		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "open",
				requestKind: "large",
				owner: null,
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner });
	});

	it("defers an ownerless protected large request but not a small request", () => {
		const overlay = new DegradedOwnerOverlay();
		const input = {
			laneKey: "lane-ownerless",
			cohortKey,
			state: "open" as const,
			owner: null,
			enforced: true,
		};

		expect(
			overlay.materializeDirective({ ...input, requestKind: "large" }),
		).toEqual({ kind: "defer-owner-assignment" });
		expect(
			overlay.materializeDirective({ ...input, requestKind: "small" }),
		).toBeNull();
		expect(
			overlay.materializeDirective({
				...input,
				requestKind: "large",
				enforced: false,
			}),
		).toBeNull();
	});

	it("retains through recovery plus hold-down, then snaps back to baseline", () => {
		let now = 1_000;
		const overlay = new DegradedOwnerOverlay({
			holdDownMs: 100,
			now: () => now,
		});

		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "recovering",
				requestKind: "large",
				owner,
				enforced: true,
				recoveringUntil: 1_050,
			}),
		).toEqual({ kind: "retain-owner", owner });

		now = 1_149;
		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "closed",
				requestKind: "small",
				owner,
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner });

		now = 1_150;
		expect(
			overlay.materializeDirective({
				laneKey: "lane-a",
				cohortKey,
				state: "closed",
				requestKind: "small",
				owner,
				enforced: true,
			}),
		).toBeNull();
	});

	it("stays bounded and never evicts an active protected owner", () => {
		const overlay = new DegradedOwnerOverlay({ maxEntries: 1 });
		overlay.materializeDirective({
			laneKey: "protected",
			cohortKey,
			state: "open",
			requestKind: "large",
			owner,
			enforced: true,
		});

		expect(
			overlay.retainQualifyingOwner({
				laneKey: "new-evidence",
				cohortKey: "cohort-b" as AnthropicDegradedCohortKey,
				owner: {
					candidateId: "account:b",
					accountId: "b",
				},
			}),
		).toBe(false);
		expect(overlay.size).toBe(1);
		expect(overlay.droppedEntries).toBe(1);

		overlay.clear();
		expect(overlay.size).toBe(0);
	});

	it("retains a captured owner ephemerally when protected state fills capacity", () => {
		const overlay = new DegradedOwnerOverlay({ maxEntries: 1 });
		overlay.materializeDirective({
			laneKey: "protected",
			cohortKey,
			state: "open",
			requestKind: "large",
			owner,
			enforced: true,
		});
		const currentOwner = {
			candidateId: "account:current",
			accountId: "current",
		};

		expect(
			overlay.materializeDirective({
				laneKey: "current-lane",
				cohortKey: "cohort-current" as AnthropicDegradedCohortKey,
				state: "open",
				requestKind: "large",
				owner: currentOwner,
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner: currentOwner });
		expect(overlay.size).toBe(1);
		expect(overlay.droppedEntries).toBe(1);
	});

	it("never evicts a live hold-down owner under evidence pressure", () => {
		let now = 1_000;
		const overlay = new DegradedOwnerOverlay({
			maxEntries: 1,
			holdDownMs: 100,
			now: () => now,
		});
		overlay.materializeDirective({
			laneKey: "hold-down-lane",
			cohortKey,
			state: "recovering",
			requestKind: "large",
			owner,
			enforced: true,
			recoveringUntil: 1_100,
		});

		now = 1_050;
		expect(
			overlay.retainQualifyingOwner({
				laneKey: "new-evidence",
				cohortKey: "cohort-pressure" as AnthropicDegradedCohortKey,
				owner: {
					candidateId: "account:pressure",
					accountId: "pressure",
				},
			}),
		).toBe(false);
		expect(
			overlay.materializeDirective({
				laneKey: "hold-down-lane",
				cohortKey,
				state: "closed",
				requestKind: "small",
				owner: null,
				enforced: true,
			}),
		).toEqual({ kind: "retain-owner", owner });
		expect(overlay.size).toBe(1);
		expect(overlay.droppedEntries).toBe(1);
	});

	it("updates indexed evidence recency before evicting at strict capacity", () => {
		let now = 0;
		const overlay = new DegradedOwnerOverlay({
			maxEntries: 2,
			evidenceWindowMs: 100,
			now: () => now,
		});
		const retain = (
			laneKey: string,
			key: AnthropicDegradedCohortKey,
			accountId: string,
		) =>
			overlay.retainQualifyingOwner({
				laneKey,
				cohortKey: key,
				owner: {
					candidateId: `account:${accountId}`,
					accountId,
				},
			});

		expect(retain("lane-a", cohortKey, "a")).toBe(true);
		now = 1;
		expect(
			retain("lane-b", "cohort-b" as AnthropicDegradedCohortKey, "b"),
		).toBe(true);
		now = 2;
		expect(retain("lane-a", cohortKey, "replacement-a")).toBe(true);
		now = 3;
		expect(
			retain("lane-c", "cohort-c" as AnthropicDegradedCohortKey, "c"),
		).toBe(true);

		expect(
			overlay.peekRetainedOwner(
				"lane-b",
				"cohort-b" as AnthropicDegradedCohortKey,
			),
		).toBeNull();
		expect(overlay.peekRetainedOwner("lane-a", cohortKey)).toEqual({
			candidateId: "account:a",
			accountId: "a",
		});
		expect(overlay.size).toBe(2);
	});

	it("preserves insertion-order eviction when a fake clock ties evidence", () => {
		const overlay = new DegradedOwnerOverlay({
			maxEntries: 2,
			now: () => 0,
		});
		const retain = (
			laneKey: string,
			key: AnthropicDegradedCohortKey,
			accountId: string,
		) =>
			overlay.retainQualifyingOwner({
				laneKey,
				cohortKey: key,
				owner: {
					candidateId: `account:${accountId}`,
					accountId,
				},
			});

		expect(
			retain("lane-z", "cohort-z" as AnthropicDegradedCohortKey, "z"),
		).toBe(true);
		expect(
			retain("lane-a", "cohort-a" as AnthropicDegradedCohortKey, "a"),
		).toBe(true);
		expect(
			retain("lane-m", "cohort-m" as AnthropicDegradedCohortKey, "m"),
		).toBe(true);

		expect(
			overlay.peekRetainedOwner(
				"lane-z",
				"cohort-z" as AnthropicDegradedCohortKey,
			),
		).toBeNull();
		expect(
			overlay.peekRetainedOwner(
				"lane-a",
				"cohort-a" as AnthropicDegradedCohortKey,
			),
		).not.toBeNull();
		expect(overlay.size).toBe(2);
	});

	it("does not resurrect expired evidence during cohort recovery retention", () => {
		let now = 0;
		const overlay = new DegradedOwnerOverlay({
			evidenceWindowMs: 10,
			holdDownMs: 100,
			now: () => now,
		});
		overlay.retainQualifyingOwner({
			laneKey: "expired-lane",
			cohortKey,
			owner,
		});

		now = 10;
		overlay.retainAfterRecovery(cohortKey, 20);

		expect(overlay.peekRetainedOwner("expired-lane", cohortKey)).toBeNull();
		expect(overlay.size).toBe(0);
	});

	it("avoids full-map routing sweeps while bounded maintenance drains due entries", () => {
		let now = 0;
		const retainedEntries = 1_024;
		const overlay = new DegradedOwnerOverlay({
			maxEntries: retainedEntries + 1,
			evidenceWindowMs: 10,
			now: () => now,
		});

		for (let index = 0; index < retainedEntries; index += 1) {
			expect(
				overlay.retainQualifyingOwner({
					laneKey: `lane-${index}`,
					cohortKey: `cohort-${index}` as AnthropicDegradedCohortKey,
					owner: {
						candidateId: `account:${index}`,
						accountId: `${index}`,
					},
				}),
			).toBe(true);
		}

		const entries = (overlay as unknown as { entries: Map<string, unknown> })
			.entries;
		const originalIterator = entries[Symbol.iterator].bind(entries);
		let visitedEntries = 0;
		Object.defineProperty(entries, Symbol.iterator, {
			configurable: true,
			value: () => {
				const iterator = originalIterator();
				return {
					next: () => {
						const result = iterator.next();
						if (!result.done) visitedEntries += 1;
						return result;
					},
					[Symbol.iterator]() {
						return this;
					},
				};
			},
		});

		expect(
			overlay.materializeDirective({
				laneKey: `lane-${retainedEntries - 1}`,
				cohortKey:
					`cohort-${retainedEntries - 1}` as AnthropicDegradedCohortKey,
				state: "open",
				requestKind: "large",
				owner: null,
				enforced: true,
			}),
		).toEqual({
			kind: "retain-owner",
			owner: {
				candidateId: `account:${retainedEntries - 1}`,
				accountId: `${retainedEntries - 1}`,
			},
		});
		expect(visitedEntries).toBeLessThan(32);

		now = 11;
		for (let index = 0; index < retainedEntries; index += 1) {
			overlay.materializeDirective({
				laneKey: "ordinary-traffic",
				cohortKey: "ordinary-cohort" as AnthropicDegradedCohortKey,
				state: "closed",
				requestKind: "small",
				owner: null,
				enforced: true,
			});
		}

		expect(entries.size).toBe(1);
		expect(visitedEntries).toBeLessThan(32);
	});
});
