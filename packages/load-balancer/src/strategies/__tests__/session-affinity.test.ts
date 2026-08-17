import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import { Logger, logBus } from "@better-ccflare/logger";
import type {
	Account,
	LogEvent,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a",
		name: "a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "r",
		access_token: "t",
		expires_at: Date.now() + 3_600_000,
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
		...overrides,
	};
}

class MockStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];
	utilization: Map<string, number | null> = new Map();

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}
	async resumeAccount(
		accountId: string,
	): Promise<{ resumed: boolean; pauseReason: string | null }> {
		this.resumeCalls.push(accountId);
		return { resumed: true, pauseReason: null };
	}
	// Mirror the StrategyStore signature exactly (accountId, provider) so the
	// mock can't silently diverge from the contract — provider is unused here.
	getAccountUtilization(accountId: string, _provider?: string): number | null {
		return this.utilization.has(accountId)
			? (this.utilization.get(accountId) ?? null)
			: null;
	}
	setUtil(accountId: string, value: number | null): void {
		this.utilization.set(accountId, value);
	}
}

function metaFor(clientSessionId?: string | null): RequestMeta {
	return {
		id: "req",
		headers: new Headers(),
		timestamp: Date.now(),
		clientSessionId: clientSessionId ?? null,
	} as unknown as RequestMeta;
}

describe("SessionAffinityStrategy", () => {
	let store: MockStore;
	let strategy: SessionAffinityStrategy;

	beforeEach(() => {
		store = new MockStore();
		strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
	});

	it("assigns a new client an account and sticks it there (sticky)", async () => {
		const accounts = [
			makeAccount({ id: "x" }),
			makeAccount({ id: "y" }),
			makeAccount({ id: "z" }),
		];

		const first = await strategy.select(accounts, metaFor("client-1"));
		const assigned = first[0].id;

		// Subsequent selects with the same client id must keep returning the
		// same account first, even though util/recency would otherwise rotate.
		for (let i = 0; i < 5; i++) {
			const next = await strategy.select(accounts, metaFor("client-1"));
			expect(next[0].id).toBe(assigned);
		}
	});

	it("spreads two different clients onto different accounts", async () => {
		// Two equal accounts (priority 0, util 0). The recency penalty must push
		// the second new client onto the other account.
		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];

		const a = (await strategy.select(accounts, metaFor("client-a")))[0].id;
		const b = (await strategy.select(accounts, metaFor("client-b")))[0].id;

		expect(a).not.toBe(b);
		expect(new Set([a, b])).toEqual(new Set(["x", "y"]));
	});

	it("keeps independent Fable and Opus owners for the same client session", async () => {
		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];
		const fableMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
		} as RequestMeta;
		const opusMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:opus",
		} as RequestMeta;

		const fableOwner = (await strategy.select(accounts, fableMeta))[0].id;
		const opusOwner = (await strategy.select(accounts, opusMeta))[0].id;

		expect(opusOwner).not.toBe(fableOwner);
		expect((await strategy.select(accounts, fableMeta))[0].id).toBe(fableOwner);
		expect((await strategy.select(accounts, opusMeta))[0].id).toBe(opusOwner);
	});

	describe("authoritative owner directives", () => {
		it("captures candidate and backing account without mutating selection", async () => {
			const shared = makeAccount({ id: "shared" });
			const laneMeta = {
				...metaFor("snapshot-client"),
				affinityLaneKey: "snapshot-client:anthropic:opus",
				routingCandidates: [
					{
						candidateId: "combo:test:slot:owner",
						accountId: "shared",
						tier: 0,
						ordinal: 0,
						comboSlotId: "slot-owner",
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
				],
			} as RequestMeta;

			await strategy.select([shared], laneMeta);
			expect(strategy.snapshotAffinityOwner(laneMeta)).toEqual({
				candidateId: "combo:test:slot:owner",
				accountId: "shared",
			});
			expect((await strategy.select([shared], laneMeta))[0]?.id).toBe("shared");
		});

		it("keeps an unavailable equal-tier owner authoritative for snapback", async () => {
			const owner = makeAccount({ id: "owner", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 0 });
			const laneMeta = {
				...metaFor("retained-client"),
				affinityLaneKey: "retained-client:anthropic:opus",
			} as RequestMeta;
			await strategy.select([owner, fallback], laneMeta);
			const snapshot = strategy.snapshotAffinityOwner(laneMeta);
			expect(snapshot).toEqual({
				candidateId: "account:owner",
				accountId: "owner",
			});

			const ownerDown = makeAccount({
				id: owner.id,
				priority: owner.priority,
				rate_limited_until: Date.now() + 60_000,
			});
			const degradedMeta = {
				...laneMeta,
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: snapshot,
				},
			} as RequestMeta;
			expect(
				(await strategy.select([ownerDown, fallback], degradedMeta))[0]?.id,
			).toBe("fallback");
			expect(strategy.snapshotAffinityOwner(laneMeta)).toEqual(snapshot);
			expect(
				(await strategy.select([owner, fallback], degradedMeta))[0]?.id,
			).toBe("owner");
		});

		it("lets hard-invalid owners use current reassignment behavior", async () => {
			const owner = makeAccount({ id: "owner", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 0 });
			const laneMeta = {
				...metaFor("invalid-owner-client"),
				affinityLaneKey: "invalid-owner-client:anthropic:opus",
			} as RequestMeta;
			await strategy.select([owner, fallback], laneMeta);
			const snapshot = strategy.snapshotAffinityOwner(laneMeta);
			const invalidMeta = {
				...laneMeta,
				hardExcludedAccountIds: new Set([owner.id]),
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: snapshot,
				},
			} as RequestMeta;

			expect(
				(await strategy.select([owner, fallback], invalidMeta))[0]?.id,
			).toBe("fallback");
			expect(strategy.snapshotAffinityOwner(laneMeta)).toEqual({
				candidateId: "account:fallback",
				accountId: "fallback",
			});
		});

		it("defers ownerless affinity until an explicit terminal-success commit", async () => {
			const accounts = [
				makeAccount({ id: "selected" }),
				makeAccount({ id: "other" }),
			];
			const laneMeta = {
				...metaFor("ownerless-client"),
				affinityLaneKey: "ownerless-client:anthropic:opus",
				affinityOwnerDirective: {
					kind: "defer-owner-assignment",
				},
			} as RequestMeta;

			const selected = (await strategy.select(accounts, laneMeta))[0];
			expect(selected?.id).toBe("selected");
			expect(strategy.snapshotAffinityOwner(laneMeta)).toBeNull();
			expect(
				strategy.commitAffinityOwner(laneMeta, {
					candidateId: "account:selected",
					accountId: "selected",
				}),
			).toBe(true);
			expect(strategy.snapshotAffinityOwner(laneMeta)).toEqual({
				candidateId: "account:selected",
				accountId: "selected",
			});
		});

		it("leases an equal-tier half-open owner probe ahead of a healthy fallback", async () => {
			let now = 1_000;
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const owner = makeAccount({ id: "owner", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 0 });
			const laneMeta = {
				...metaFor("owner-probe-client"),
				affinityLaneKey: "owner-probe-client:anthropic:opus",
			} as RequestMeta;
			await clocked.select([owner, fallback], laneMeta);
			const snapshot = clocked.snapshotAffinityOwner(laneMeta);
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:owner",
				reason: "overloaded",
				suppressForMs: 100,
			});
			const retainedMeta = {
				...laneMeta,
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: snapshot,
				},
			} as RequestMeta;

			expect(
				(await clocked.select([owner, fallback], retainedMeta)).map(
					(account) => account.id,
				),
			).toEqual(["fallback"]);
			now += 100;
			expect(
				(await clocked.select([owner, fallback], { ...retainedMeta })).map(
					(account) => account.id,
				),
			).toEqual(["owner", "fallback"]);
		});
	});

	describe("lane-scoped candidate failure suppression", () => {
		it("leases two all-open account routes on sequential independent selects", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			const laneMeta = {
				...metaFor("sequential-probe-client"),
				affinityLaneKey: "sequential-probe-client:anthropic:opus",
			} as RequestMeta;

			for (const candidateId of ["account:primary", "account:fallback"]) {
				strategy.reportCandidateFailure(laneMeta, {
					candidateId,
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
			}

			const first = await strategy.select([primary, fallback], laneMeta);
			expect(first.map((account) => account.id)).toEqual(["primary"]);
			expect(strategy.getRouteCircuitRecoveryHint(laneMeta)).toMatchObject({
				allCandidatesOpen: true,
				candidateCount: 2,
				probeLeased: true,
				reason: "semantic_stream_stall",
			});

			// The first selection owns only primary. A separate client retry can lease
			// the independent fallback instead of being blocked lane-wide.
			const second = await strategy.select([primary, fallback], {
				...laneMeta,
			});
			expect(second.map((account) => account.id)).toEqual(["fallback"]);
			expect(
				await strategy.select([primary, fallback], { ...laneMeta }),
			).toEqual([]);
		});

		it("isolates concurrent half-open leases per exact candidate", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			const laneMeta = {
				...metaFor("concurrent-probe-client"),
				affinityLaneKey: "concurrent-probe-client:anthropic:opus",
			} as RequestMeta;

			for (const candidateId of ["account:primary", "account:fallback"]) {
				strategy.reportCandidateFailure(laneMeta, {
					candidateId,
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
			}

			const results = await Promise.all([
				strategy.select([primary, fallback], { ...laneMeta }),
				strategy.select([primary, fallback], { ...laneMeta }),
				strategy.select([primary, fallback], { ...laneMeta }),
			]);
			expect(
				results.map((result) => result.map((account) => account.id)),
			).toEqual([["primary"], ["fallback"], []]);
		});

		it("never logs caller-derived affinity values while preserving suppression and a single half-open probe", async () => {
			const secret = "session-secret/path?model=opus&beta=private";
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			const laneMeta = {
				...metaFor(secret),
				affinityLaneKey: `${secret}:anthropic:opus`,
			} as RequestMeta;
			const events: LogEvent[] = [];
			const capture = (event: LogEvent) => events.push(event);
			logBus.on("log", capture);

			try {
				expect(
					(await strategy.select([primary, fallback], laneMeta))[0].id,
				).toBe("primary");
				strategy.reportCandidateFailure(laneMeta, {
					candidateId: "account:primary",
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
				expect(
					(await strategy.select([primary, fallback], laneMeta))[0].id,
				).toBe("fallback");
				strategy.reportCandidateFailure(laneMeta, {
					candidateId: "account:fallback",
					reason: "semantic_stream_stall",
					suppressForMs: 120_000,
				});

				// With every candidate open, probe only the deterministic candidate
				// whose circuit expires first. Never leak the full failed ordering.
				expect(
					(await strategy.select([primary, fallback], laneMeta)).map(
						(account) => account.id,
					),
				).toEqual(["primary"]);
			} finally {
				logBus.off("log", capture);
			}

			expect(strategy.routeSuppressionEntries).toBe(2);
			expect(events.length).toBeGreaterThanOrEqual(3);
			expect(JSON.stringify(events)).not.toContain(secret);
		});

		it("temporarily omits the failed candidate for the same affinity lane", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			const laneMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
			} as RequestMeta;

			expect((await strategy.select([primary, fallback], laneMeta))[0].id).toBe(
				"primary",
			);

			strategy.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 60_000,
			});

			expect((await strategy.select([primary, fallback], laneMeta))[0].id).toBe(
				"fallback",
			);
		});

		it("does not suppress the failed candidate in another model lane", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			const opusMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
			} as RequestMeta;
			const fableMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:fable",
			} as RequestMeta;

			await strategy.select([primary, fallback], opusMeta);
			strategy.reportCandidateFailure(opusMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 60_000,
			});

			expect(
				(await strategy.select([primary, fallback], fableMeta))[0].id,
			).toBe("primary");
		});

		it("suppresses only the failed combo candidate when a sibling uses the same account", async () => {
			const shared = makeAccount({ id: "shared" });
			const laneMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
				routingCandidates: [
					{
						candidateId: "combo:c1:slot:primary",
						accountId: "shared",
						tier: 0,
						ordinal: 0,
						comboSlotId: "slot-primary",
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
					{
						candidateId: "combo:c1:slot:sibling",
						accountId: "shared",
						tier: 1,
						ordinal: 1,
						comboSlotId: "slot-sibling",
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
				],
			} as RequestMeta;

			await strategy.select([shared, shared], laneMeta);
			strategy.reportCandidateFailure(laneMeta, {
				candidateId: "combo:c1:slot:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 60_000,
			});
			await strategy.select([shared, shared], laneMeta);

			expect(laneMeta.routingCandidates?.[0]?.candidateId).toBe(
				"combo:c1:slot:sibling",
			);
		});

		it("single-flights an expired higher-priority probe ahead of a healthy fallback", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
			} as RequestMeta;

			await clocked.select([primary, fallback], laneMeta);
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["fallback"]);
			clocked.reportCandidateSuccess(laneMeta, {
				candidateId: "account:fallback",
			});

			now += 100;
			// The expired primary is strictly better than the healthy fallback. Its
			// single-flight probe must be the first executable attempt, with fallback
			// retained behind it so this same request can still recover.
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["primary", "fallback"]);
			// While that probe owns the lease, another request can still use the healthy
			// fallback but must not launch a second primary probe.
			expect(
				(await clocked.select([primary, fallback], { ...laneMeta })).map(
					(account) => account.id,
				),
			).toEqual(["fallback"]);

			// A failed probe reopens only the primary at base x2; fallback remains
			// executable both for this request and throughout the renewed backoff.
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			clocked.reportCandidateSuccess(laneMeta, {
				candidateId: "account:fallback",
			});
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["fallback"]);
			now += 199;
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["fallback"]);
			now += 1;
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["primary", "fallback"]);

			// Only a proven clean primary success closes its exact circuit. Normal
			// priority/sticky routing then resumes without waiting for retained-state GC.
			clocked.reportCandidateSuccess(laneMeta, {
				candidateId: "account:primary",
			});
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["primary", "fallback"]);
			expect(clocked.routeSuppressionEntries).toBe(0);
		});

		it("leases at most one deterministic half-open probe per candidate across concurrent selects", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
			} as RequestMeta;

			await clocked.select([primary, fallback], laneMeta);
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 30 * 60_000,
			});
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:fallback",
				reason: "semantic_stream_stall",
				suppressForMs: 60 * 60_000,
			});

			const results = await Promise.all([
				clocked.select([primary, fallback], { ...laneMeta }),
				clocked.select([primary, fallback], { ...laneMeta }),
				clocked.select([primary, fallback], { ...laneMeta }),
			]);
			expect(
				results.map((result) => result.map((account) => account.id)),
			).toEqual([["primary"], ["fallback"], []]);
			expect(
				await clocked.select([primary, fallback], { ...laneMeta }),
			).toEqual([]);

			// A lost request cannot hold the lane forever. The finite lease admits
			// one new probe after ten minutes, still without exposing the full pool.
			now += 10 * 60_000 - 1;
			expect(
				await clocked.select([primary, fallback], { ...laneMeta }),
			).toEqual([]);
			now += 1;
			expect(
				(await clocked.select([primary, fallback], { ...laneMeta })).map(
					(account) => account.id,
				),
			).toEqual(["primary"]);
		});

		it("does not phantom-lease an eligible probe behind a closed sticky route", async () => {
			const probeCandidate = makeAccount({ id: "probe-a", priority: 1 });
			const stickyCandidate = makeAccount({ id: "sticky-b", priority: 0 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("phantom-lease-client"),
				affinityLaneKey: "phantom-lease-client:anthropic:opus",
			} as RequestMeta;

			// Establish B as the sticky healthy owner, then let A's circuit reach its
			// half-open boundary while B remains closed and succeeds first.
			expect(
				(await clocked.select([probeCandidate, stickyCandidate], laneMeta))[0]
					?.id,
			).toBe(stickyCandidate.id);
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: `account:${probeCandidate.id}`,
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			now += 100;
			expect(
				(await clocked.select([probeCandidate, stickyCandidate], laneMeta))[0]
					?.id,
			).toBe(stickyCandidate.id);

			// Once B fails too, A must still be immediately leaseable because the
			// prior successful B selection never executed A. Only that executable
			// all-open selection may acquire the single-flight lease.
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: `account:${stickyCandidate.id}`,
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			expect(
				(await clocked.select([probeCandidate, stickyCandidate], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual([probeCandidate.id]);
			const concurrentRepeats = await Promise.all([
				clocked.select([probeCandidate, stickyCandidate], { ...laneMeta }),
				clocked.select([probeCandidate, stickyCandidate], { ...laneMeta }),
			]);
			expect(
				concurrentRepeats.map((result) => result.map((account) => account.id)),
			).toEqual([[stickyCandidate.id], []]);
		});

		it("does not lease an expired equal-class circuit behind a healthy sticky route", async () => {
			const probeCandidate = makeAccount({ id: "equal-probe", priority: 0 });
			const stickyCandidate = makeAccount({ id: "equal-sticky", priority: 0 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("equal-class-phantom-client"),
				affinityLaneKey: "equal-class-phantom-client:anthropic:opus",
			} as RequestMeta;

			// Establish the healthy equal-class candidate as owner. Expiry alone must
			// not let its sibling steal a probe ahead of that viable sticky route.
			expect(
				(await clocked.select([stickyCandidate, probeCandidate], laneMeta))[0]
					?.id,
			).toBe(stickyCandidate.id);
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: `account:${probeCandidate.id}`,
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			now += 100;
			expect(
				(await clocked.select([probeCandidate, stickyCandidate], laneMeta))[0]
					?.id,
			).toBe(stickyCandidate.id);

			// If the prior selection had phantom-leased the equal candidate, opening
			// the sticky owner now would leave the all-open lane empty for ten minutes.
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: `account:${stickyCandidate.id}`,
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			expect(
				(await clocked.select([probeCandidate, stickyCandidate], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual([probeCandidate.id]);
		});

		it("uses oldest failure as the deterministic tie-break for equal expiry", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("oldest-tie-client"),
				affinityLaneKey: "oldest-tie-client:anthropic:opus",
			} as RequestMeta;

			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 1_000,
			});
			now += 500;
			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:fallback",
				reason: "semantic_stream_stall",
				suppressForMs: 500,
			});

			expect(
				(await clocked.select([fallback, primary], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["primary"]);
		});

		it("a failed half-open probe reopens until the extended backoff expires", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("backoff-client"),
				affinityLaneKey: "backoff-client:anthropic:opus",
			} as RequestMeta;

			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			expect((await clocked.select([primary], laneMeta))[0]?.id).toBe(
				"primary",
			);

			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			expect(clocked.getRouteCircuitRecoveryHint(laneMeta)).toMatchObject({
				allCandidatesOpen: true,
				candidateCount: 1,
				probeLeased: false,
				retryAt: now + 200,
				reason: "semantic_stream_stall",
			});
			expect(await clocked.select([primary], laneMeta)).toEqual([]);
			now += 199;
			expect(await clocked.select([primary], laneMeta)).toEqual([]);
			now += 1;
			expect((await clocked.select([primary], laneMeta))[0]?.id).toBe(
				"primary",
			);
		});

		it("caps repeated-failure backoff at base x16 on the exact boundary", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("bounded-backoff-client"),
				affinityLaneKey: "bounded-backoff-client:anthropic:opus",
			} as RequestMeta;

			for (let attempt = 0; attempt < 8; attempt++) {
				clocked.reportCandidateFailure(laneMeta, {
					candidateId: "account:primary",
					reason: "semantic_stream_stall",
					suppressForMs: 100,
				});
			}

			now += 1_599;
			expect(await clocked.select([primary], laneMeta)).toEqual([]);
			now += 1;
			expect((await clocked.select([primary], laneMeta))[0]?.id).toBe(
				"primary",
			);
		});

		it("a proven success resets only the exact lane candidate", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("success-reset-client"),
				affinityLaneKey: "success-reset-client:anthropic:opus",
			} as RequestMeta;
			const siblingLaneMeta = {
				...metaFor("success-reset-client"),
				affinityLaneKey: "success-reset-client:anthropic:fable",
			} as RequestMeta;

			await clocked.select([primary], laneMeta);
			for (let attempt = 0; attempt < 2; attempt++) {
				clocked.reportCandidateFailure(laneMeta, {
					candidateId: "account:primary",
					reason: "semantic_stream_stall",
					suppressForMs: 100,
				});
			}
			clocked.reportCandidateFailure(siblingLaneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 60_000,
			});
			clocked.reportCandidateSuccess(laneMeta, {
				candidateId: "account:primary",
			});
			expect(clocked.getRouteCircuitRecoveryHint(laneMeta)).toMatchObject({
				allCandidatesOpen: false,
				candidateCount: 1,
				retryAt: null,
			});
			expect(clocked.routeSuppressionEntries).toBe(1);
			expect(
				(await clocked.select([primary, fallback], siblingLaneMeta))[0]?.id,
			).toBe("fallback");

			clocked.reportCandidateFailure(laneMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			now += 99;
			expect((await clocked.select([primary, fallback], laneMeta))[0]?.id).toBe(
				"fallback",
			);
			now += 1;
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["primary", "fallback"]);
			clocked.reportCandidateSuccess(laneMeta, {
				candidateId: "account:primary",
			});
			expect(
				(await clocked.select([primary, fallback], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual(["primary", "fallback"]);
			expect(clocked.routeSuppressionEntries).toBe(1);
		});

		it("keeps same-lane sibling candidate circuits independent on success", async () => {
			const shared = makeAccount({ id: "shared" });
			const laneMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
				routingCandidates: [
					{
						candidateId: "combo:c1:slot:primary",
						accountId: "shared",
						tier: 0,
						ordinal: 0,
						comboSlotId: "slot-primary",
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
					{
						candidateId: "combo:c1:slot:sibling",
						accountId: "shared",
						tier: 1,
						ordinal: 1,
						comboSlotId: "slot-sibling",
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
				],
			} as RequestMeta;

			for (const candidateId of [
				"combo:c1:slot:primary",
				"combo:c1:slot:sibling",
			]) {
				strategy.reportCandidateFailure(laneMeta, {
					candidateId,
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
			}
			strategy.reportCandidateSuccess(laneMeta, {
				candidateId: "combo:c1:slot:primary",
			});

			expect(strategy.routeSuppressionEntries).toBe(1);
			const result = await strategy.select([shared, shared], laneMeta);
			expect(result).toHaveLength(1);
			expect(
				laneMeta.routingCandidates?.map((candidate) => candidate.candidateId),
			).toEqual(["combo:c1:slot:primary"]);
		});

		it("leases probes independently across different affinity lanes", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const opusMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:opus",
			} as RequestMeta;
			const fableMeta = {
				...metaFor("same-client"),
				affinityLaneKey: "same-client:anthropic:fable",
			} as RequestMeta;

			for (const meta of [opusMeta, fableMeta]) {
				strategy.reportCandidateFailure(meta, {
					candidateId: "account:primary",
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
			}

			const [opusProbe, fableProbe] = await Promise.all([
				strategy.select([primary], opusMeta),
				strategy.select([primary], fableMeta),
			]);
			expect(opusProbe[0]?.id).toBe("primary");
			expect(fableProbe[0]?.id).toBe("primary");
			expect(await strategy.select([primary], opusMeta)).toEqual([]);
			expect(await strategy.select([primary], fableMeta)).toEqual([]);
		});

		it("does nothing when the request has no affinity key", async () => {
			const primary = makeAccount({ id: "primary", priority: 0 });
			const fallback = makeAccount({ id: "fallback", priority: 1 });
			const unscopedMeta = metaFor(null);

			strategy.reportCandidateFailure(unscopedMeta, {
				candidateId: "account:primary",
				reason: "semantic_stream_stall",
				suppressForMs: 60_000,
			});

			expect(strategy.routeSuppressionEntries).toBe(0);
			expect(
				(await strategy.select([primary, fallback], unscopedMeta))[0].id,
			).toBe("primary");
		});

		it("bounds retained suppression state", () => {
			const bounded = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				2,
			);
			for (let index = 0; index < 5; index++) {
				bounded.reportCandidateFailure(
					{
						...metaFor(`client-${index}`),
						affinityLaneKey: `client-${index}:anthropic:opus`,
					} as RequestMeta,
					{
						candidateId: `account:${index}`,
						reason: "semantic_stream_stall",
						suppressForMs: 60_000,
					},
				);
			}

			expect(bounded.routeSuppressionEntries).toBe(2);
		});

		it("amortizes circuit GC while preserving the 24-hour retention boundary", async () => {
			const account = makeAccount({ id: "gc-account" });
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			clocked.initialize(store);
			const laneMeta = {
				...metaFor("gc-client"),
				affinityLaneKey: "gc-client:anthropic:opus",
			} as RequestMeta;

			clocked.reportCandidateFailure(laneMeta, {
				candidateId: `account:${account.id}`,
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			expect(clocked.routeSuppressionGcSweeps).toBe(1);

			for (let request = 0; request < 100; request++) {
				await clocked.select([account], { ...laneMeta });
			}
			expect(clocked.routeSuppressionGcSweeps).toBe(1);

			now += 60_000 - 1;
			await clocked.select([account], laneMeta);
			expect(clocked.routeSuppressionGcSweeps).toBe(1);
			now += 1;
			await clocked.select([account], laneMeta);
			expect(clocked.routeSuppressionGcSweeps).toBe(2);

			// Use a separate instance so a deliberately recent periodic sweep cannot
			// defer observation of the exact retention threshold.
			const boundaryClocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				undefined,
				() => now,
			);
			boundaryClocked.initialize(store);
			boundaryClocked.reportCandidateFailure(laneMeta, {
				candidateId: `account:${account.id}`,
				reason: "semantic_stream_stall",
				suppressForMs: 100,
			});
			const boundaryReportedAt = now;
			now = boundaryReportedAt + 24 * 60 * 60 * 1000 - 1;
			expect(boundaryClocked.routeSuppressionEntries).toBe(1);
			now += 1;
			await boundaryClocked.select([account], laneMeta);
			expect(boundaryClocked.routeSuppressionEntries).toBe(0);
		});

		it("moves an updated circuit state to newest before O(1) oldest eviction", async () => {
			const a = makeAccount({ id: "eviction-a" });
			const b = makeAccount({ id: "eviction-b" });
			const c = makeAccount({ id: "eviction-c" });
			let now = Date.now();
			const bounded = new SessionAffinityStrategy(
				undefined,
				undefined,
				undefined,
				2,
				() => now,
			);
			bounded.initialize(store);
			const laneMeta = {
				...metaFor("eviction-client"),
				affinityLaneKey: "eviction-client:anthropic:opus",
			} as RequestMeta;
			const fail = (account: Account): void => {
				bounded.reportCandidateFailure(laneMeta, {
					candidateId: `account:${account.id}`,
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
				now += 1;
			};

			fail(a);
			fail(b);
			fail(a); // Refresh A: B is now the oldest reported state.
			fail(c); // Capacity eviction must remove B in insertion order.

			expect(bounded.routeSuppressionEntries).toBe(2);
			expect(
				(await bounded.select([a, b, c], laneMeta)).map(
					(account) => account.id,
				),
			).toEqual([b.id]);
		});
	});

	it("replaces a displaced fallback owner once a recovered better tier becomes routable", async () => {
		const low = makeAccount({ id: "low", priority: 1 });
		const high = makeAccount({ id: "high", priority: 0 });
		const laneMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:opus",
		} as RequestMeta;

		// high is CONFIGURED (present in the accounts array) but unavailable at
		// install time, so low installs as a genuine displaced fallback -- not
		// "at home" -- and remains eligible to upgrade once high recovers.
		const highDownAtInstall = makeAccount({
			id: "high",
			priority: 0,
			rate_limited_until: Date.now() + 60_000,
		});
		expect(
			(await strategy.select([low, highDownAtInstall], laneMeta))[0].id,
		).toBe("low");
		expect((await strategy.select([low, high], laneMeta))[0].id).toBe("high");
		// The better-tier owner replaces the old mapping; making the two accounts
		// equal later must not resurrect the displaced lower-tier owner.
		expect(
			(
				await strategy.select(
					[low, makeAccount({ id: "high", priority: 1 })],
					laneMeta,
				)
			)[0].id,
		).toBe("high");

		const highExcluded = {
			...laneMeta,
			hardExcludedAccountIds: new Set(["high"]),
		} as RequestMeta;
		expect((await strategy.select([low, high], highExcluded))[0].id).toBe(
			"low",
		);
	});

	describe("cross-tier outclass never remaps a healthy at-home owner", () => {
		it("keeps a healthy at-home owner sticky across a later cross-tier config change", async () => {
			const low = makeAccount({ id: "low", priority: 5 });
			const laneMeta = {
				...metaFor("config-change-client"),
				affinityLaneKey: "config-change-client:anthropic:opus",
			} as RequestMeta;

			// low is the only configured candidate at install time: it is
			// installed "at home" (no strictly better tier was configured).
			expect((await strategy.select([low], laneMeta))[0].id).toBe("low");

			// An operator adds a higher-priority account after the fact (or edits
			// priorities). This is a pure config change, not a recovery: the
			// healthy at-home owner must not be silently remapped mid-session.
			const high = makeAccount({ id: "high", priority: 0 });
			const afterConfigChange = await strategy.select([low, high], laneMeta);
			expect(afterConfigChange.map((a) => a.id)).toEqual(["low", "high"]);

			// Repeat to prove this is durable stickiness, not a one-shot grace.
			const again = await strategy.select([low, high], laneMeta);
			expect(again[0].id).toBe("low");
		});

		it("keeps a healthy at-home owner sticky through a pure priority edit", async () => {
			// A template, not a single reused RequestMeta: each select() call below
			// spreads a fresh copy so the strategy's own commitStrategyCandidateOrder
			// bookkeeping from one call (meta.routingCandidates) never leaks into the
			// next and masks the priority values this test is deliberately changing
			// -- exactly like a new incoming request would look after a live config
			// edit.
			const laneMetaTemplate = {
				...metaFor("priority-edit-client"),
				affinityLaneKey: "priority-edit-client:anthropic:opus",
			} as RequestMeta;
			const aInit = makeAccount({ id: "a", priority: 0 });
			const bInit = makeAccount({ id: "b", priority: 25 });

			// Both a and b are configured at install time; a wins on priority and
			// is installed at the best configured tier -- "at home".
			expect(
				(await strategy.select([aInit, bInit], { ...laneMetaTemplate }))[0].id,
			).toBe("a");

			// The operator edits priorities so a is now numerically worse than b.
			// Both accounts stay healthy throughout: this is a pure config change,
			// not a's owner failing or disappearing.
			const aEdited = makeAccount({ id: "a", priority: 30 });
			const bEdited = makeAccount({ id: "b", priority: 25 });
			expect(
				(await strategy.select([aEdited, bEdited], { ...laneMetaTemplate }))[0]
					.id,
			).toBe("a");
		});

		it("still fails an at-home owner over immediately when it becomes unavailable, and does not resurrect it once it is merely worse-tier", async () => {
			// See the priority-edit test above for why this is a template spread
			// fresh at each call rather than one reused RequestMeta.
			const laneMetaTemplate = {
				...metaFor("at-home-unavailable-client"),
				affinityLaneKey: "at-home-unavailable-client:anthropic:opus",
			} as RequestMeta;
			const aInit = makeAccount({ id: "a", priority: 0 });
			const bInit = makeAccount({ id: "b", priority: 25 });
			expect(
				(await strategy.select([aInit, bInit], { ...laneMetaTemplate }))[0].id,
			).toBe("a");

			// Same priority-edit config change as above: a (at-home) stays put.
			const aEdited = makeAccount({ id: "a", priority: 30 });
			const bEdited = makeAccount({ id: "b", priority: 25 });
			expect(
				(await strategy.select([aEdited, bEdited], { ...laneMetaTemplate }))[0]
					.id,
			).toBe("a");

			// a now becomes genuinely unavailable (rate-limited). Every existing
			// failover path is untouched by the at-home guard: the session must
			// fail over immediately.
			const aRateLimited = makeAccount({
				id: "a",
				priority: 30,
				rate_limited_until: Date.now() + 60_000,
			});
			expect(
				(
					await strategy.select([aRateLimited, bEdited], {
						...laneMetaTemplate,
					})
				)[0].id,
			).toBe("b");

			// a recovers, but it is now the worse tier (30 vs b's 25) -- not an
			// outclass candidate for b at all (b, installed at its own
			// best-configured tier of 25, is itself "at home"). The session simply
			// stays on b; nothing here exercises a snapback or an outclass remap.
			const aRecovered = makeAccount({ id: "a", priority: 30 });
			expect(
				(
					await strategy.select([aRecovered, bEdited], { ...laneMetaTemplate })
				)[0].id,
			).toBe("b");
		});

		it("still upgrades a displaced owner home once the better configured tier recovers (regression pin)", async () => {
			const low = makeAccount({ id: "low", priority: 5 });
			const highDown = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			const laneMeta = {
				...metaFor("displaced-recovery-client"),
				affinityLaneKey: "displaced-recovery-client:anthropic:opus",
			} as RequestMeta;

			// high is CONFIGURED (present in the accounts array) but unavailable
			// at install time: low installs as a genuine displaced fallback, not
			// "at home".
			expect((await strategy.select([low, highDown], laneMeta))[0].id).toBe(
				"low",
			);

			// high recovers: the displaced owner must still upgrade home, exactly
			// like today's behavior.
			const highRecovered = makeAccount({ id: "high", priority: 0 });
			expect(
				(await strategy.select([low, highRecovered], laneMeta))[0].id,
			).toBe("high");

			// Once remapped, the session stays on high even after low disappears.
			expect((await strategy.select([highRecovered], laneMeta))[0].id).toBe(
				"high",
			);
		});

		it("defaults a commitAffinityOwner install without a routing catalog to protected", async () => {
			const laneMeta = {
				...metaFor("commit-no-catalog-client"),
				affinityLaneKey: "commit-no-catalog-client:anthropic:opus",
			} as RequestMeta;
			const owner = makeAccount({ id: "owner", priority: 5 });

			expect(
				strategy.commitAffinityOwner(laneMeta, {
					candidateId: "account:owner",
					accountId: "owner",
				}),
			).toBe(true);

			// No routingCandidateCatalog was present on the committed meta, so the
			// conservative default treats the owner as installed at-home: a
			// later-appearing better tier must not remap it.
			const better = makeAccount({ id: "better", priority: 0 });
			const result = await strategy.select([owner, better], laneMeta);
			expect(result[0].id).toBe("owner");
		});

		it("commitAffinityOwner: an owner below the best CATALOG tier installs displaced and later upgrades (contrast with the no-catalog default above)", async () => {
			const laneMeta = {
				...metaFor("commit-catalog-client"),
				affinityLaneKey: "commit-catalog-client:anthropic:opus",
				routingCandidateCatalog: [
					{
						candidateId: "account:owner",
						accountId: "owner",
						tier: 1,
						ordinal: 0,
						comboSlotId: null,
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
					{
						candidateId: "account:better",
						accountId: "better",
						tier: 0,
						ordinal: 1,
						comboSlotId: null,
						modelOverride: "claude-opus-4-8",
						quotaPressure: null,
					},
				],
			} as RequestMeta;

			expect(
				strategy.commitAffinityOwner(laneMeta, {
					candidateId: "account:owner",
					accountId: "owner",
				}),
			).toBe(true);

			const owner = makeAccount({ id: "owner", priority: 5 });
			// better is CONFIGURED (present in the catalog at tier 0) but not yet
			// routable this request: owner is a genuine displaced fallback here,
			// unlike the catalog-absent conservative default above.
			const betterDown = makeAccount({
				id: "better",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect((await strategy.select([owner, betterDown], laneMeta))[0].id).toBe(
				"owner",
			);

			// better recovers: the displaced owner upgrades home.
			const betterRecovered = makeAccount({ id: "better", priority: 0 });
			expect(
				(await strategy.select([owner, betterRecovered], laneMeta))[0].id,
			).toBe("better");
		});
	});

	describe("at-home marker install-site regression coverage", () => {
		it("regression: a same-owner retain-owner refresh must NOT recompute the at-home marker mid-episode (critical fix pin)", async () => {
			const low = makeAccount({ id: "low", priority: 5 });
			const laneMeta = {
				...metaFor("retain-refresh-critical-client"),
				affinityLaneKey: "retain-refresh-critical-client:anthropic:opus",
			} as RequestMeta;

			// (a) low is the sole configured candidate at install time: it
			// installs "at home" (marker false).
			expect((await strategy.select([low], laneMeta))[0].id).toBe("low");
			const snapshot = strategy.snapshotAffinityOwner(laneMeta);
			expect(snapshot).toEqual({
				candidateId: "account:low",
				accountId: "low",
			});

			// (b) A retain-owner directive fires for the SAME owner (a same-owner
			// refresh -- e.g. a degraded-mode overlay in force for an unrelated
			// reason) while a strictly better-tier account is now
			// configured/healthy. The directive must keep low first, exactly as
			// it does today.
			const high = makeAccount({ id: "high", priority: 0 });
			const degradedMeta = {
				...laneMeta,
				affinityOwnerDirective: { kind: "retain-owner", owner: snapshot },
			} as RequestMeta;
			expect((await strategy.select([low, high], degradedMeta))[0].id).toBe(
				"low",
			);

			// (c) Drop the directive: with both accounts healthy, the at-home
			// owner MUST still be first. Pre-fix, the same-owner refresh in (b)
			// would have silently re-labelled low as displaced (a strictly
			// better tier was configured), and this ordinary cross-tier outclass
			// would have remapped the live session to high.
			expect((await strategy.select([low, high], laneMeta))[0].id).toBe("low");
		});

		it("retain-owner directive that installs a genuinely at-home new owner protects it from a later cross-tier outclass", async () => {
			const seed = makeAccount({ id: "seed", priority: 5 });
			const target = makeAccount({ id: "target", priority: 2 });
			const laneMeta = {
				...metaFor("retain-change-athome-client"),
				affinityLaneKey: "retain-change-athome-client:anthropic:opus",
			} as RequestMeta;

			// An existing mapping to a different owner (seed).
			expect((await strategy.select([seed], laneMeta))[0].id).toBe("seed");

			// The directive names a DIFFERENT owner (target). At this exact
			// moment target IS the best configured tier among [seed, target]:
			// this owner-change install must compute it as genuinely at-home,
			// not a hardcoded value.
			const directiveMeta = {
				...laneMeta,
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: { candidateId: "account:target", accountId: "target" },
				},
			} as RequestMeta;
			expect((await strategy.select([seed, target], directiveMeta))[0].id).toBe(
				"target",
			);

			// Drop the directive. A still-higher tier appearing afterwards must
			// NOT move target: it was correctly recomputed as at-home.
			const higher = makeAccount({ id: "higher", priority: 0 });
			expect(
				(await strategy.select([seed, target, higher], laneMeta))[0].id,
			).toBe("target");
		});

		it("retain-owner directive that installs a genuinely displaced new owner upgrades it home on recovery", async () => {
			const seed = makeAccount({ id: "seed", priority: 5 });
			const mid = makeAccount({ id: "mid", priority: 3 });
			const highDown = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			const laneMeta = {
				...metaFor("retain-change-displaced-client"),
				affinityLaneKey: "retain-change-displaced-client:anthropic:opus",
			} as RequestMeta;

			expect((await strategy.select([seed], laneMeta))[0].id).toBe("seed");

			// The directive names a DIFFERENT owner (mid) while a strictly
			// better tier (high) is configured but currently unroutable: a
			// genuine displaced install, not at-home.
			const directiveMeta = {
				...laneMeta,
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: { candidateId: "account:mid", accountId: "mid" },
				},
			} as RequestMeta;
			expect(
				(await strategy.select([seed, mid, highDown], directiveMeta))[0].id,
			).toBe("mid");

			// Drop the directive. high recovers: the displaced owner must still
			// upgrade home, exactly like a plain displaced fallback would.
			const highRecovered = makeAccount({ id: "high", priority: 0 });
			expect(
				(await strategy.select([seed, mid, highRecovered], laneMeta))[0].id,
			).toBe("high");
		});

		it("unavailable equal-tier remap installs a genuinely at-home new owner, protecting it from a later cross-tier outclass", async () => {
			const x = makeAccount({ id: "x", priority: 1 });
			const y = makeAccount({ id: "y", priority: 1 });
			const laneMeta = {
				...metaFor("unavailable-remap-athome-client"),
				affinityLaneKey: "unavailable-remap-athome-client:anthropic:opus",
			} as RequestMeta;

			expect((await strategy.select([x], laneMeta))[0].id).toBe("x");

			// x becomes unavailable; y (equal tier) is the only OTHER configured
			// candidate this request, so the remap makes y the sole configured
			// tier: genuinely at-home.
			const xDown = makeAccount({
				id: "x",
				priority: 1,
				rate_limited_until: Date.now() + 60_000,
			});
			expect((await strategy.select([xDown, y], laneMeta))[0].id).toBe("y");

			// A later cross-tier outclass must NOT move the freshly-remapped
			// at-home owner y.
			const higher = makeAccount({ id: "higher", priority: 0 });
			expect((await strategy.select([y, higher], laneMeta))[0].id).toBe("y");
		});

		it("unavailable equal-tier remap installs a genuinely displaced new owner, upgrading it once the better configured tier recovers", async () => {
			const x = makeAccount({ id: "x", priority: 1 });
			const laneMeta = {
				...metaFor("unavailable-remap-displaced-client"),
				affinityLaneKey: "unavailable-remap-displaced-client:anthropic:opus",
			} as RequestMeta;

			expect((await strategy.select([x], laneMeta))[0].id).toBe("x");

			// x becomes unavailable; y (equal tier) is the least-used pick, but a
			// strictly better tier z is ALSO configured for this request while
			// itself unroutable: the remap to y must be recorded as displaced.
			const xDown = makeAccount({
				id: "x",
				priority: 1,
				rate_limited_until: Date.now() + 60_000,
			});
			const y = makeAccount({ id: "y", priority: 1 });
			const zDown = makeAccount({
				id: "z",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect((await strategy.select([xDown, y, zDown], laneMeta))[0].id).toBe(
				"y",
			);

			// z recovers: y must still upgrade home, exactly like a genuine
			// displaced fallback -- proving the remap correctly recorded
			// "displaced", not a hardcoded default.
			const zRecovered = makeAccount({ id: "z", priority: 0 });
			expect((await strategy.select([y, zRecovered], laneMeta))[0].id).toBe(
				"z",
			);
		});

		it("outclass upgrade replacement marks the new owner at-home, protecting it from a subsequent priority edit", async () => {
			const low = makeAccount({ id: "low", priority: 5 });
			const highDown = makeAccount({
				id: "high",
				priority: 2,
				rate_limited_until: Date.now() + 60_000,
			});
			const laneMeta = {
				...metaFor("outclass-upgrade-athome-client"),
				affinityLaneKey: "outclass-upgrade-athome-client:anthropic:opus",
			} as RequestMeta;

			// low installs displaced (high is configured but down).
			expect((await strategy.select([low, highDown], laneMeta))[0].id).toBe(
				"low",
			);

			// high recovers: the displaced owner upgrades home.
			const highRecovered = makeAccount({ id: "high", priority: 2 });
			expect(
				(await strategy.select([low, highRecovered], laneMeta))[0].id,
			).toBe("high");

			// high is now installed AT the best configured tier -- at-home. A
			// later, even-better account must NOT move it.
			const evenHigher = makeAccount({ id: "evenHigher", priority: 0 });
			expect(
				(await strategy.select([low, highRecovered, evenHigher], laneMeta))[0]
					.id,
			).toBe("high");
		});

		it("logs at-home protection at info once per episode, then debug, and resets on an ordinary sticky hit", async () => {
			const low = makeAccount({ id: "low", priority: 5 });
			const laneMeta = {
				...metaFor("protection-log-client"),
				affinityLaneKey: "protection-log-client:anthropic:opus",
			} as RequestMeta;

			expect((await strategy.select([low], laneMeta))[0].id).toBe("low");

			const protectionMsg =
				"At-home route owner protected from cross-tier outclass";
			const infoSpy = spyOn(Logger.prototype, "info").mockImplementation(
				() => {},
			);
			const debugSpy = spyOn(Logger.prototype, "debug").mockImplementation(
				() => {},
			);
			try {
				const high = makeAccount({ id: "high", priority: 0 });

				// First cross-tier outclass of the episode: logs at INFO.
				await strategy.select([low, high], laneMeta);
				expect(
					infoSpy.mock.calls.some((call) => call[0] === protectionMsg),
				).toBe(true);
				expect(
					debugSpy.mock.calls.some((call) => call[0] === protectionMsg),
				).toBe(false);
				infoSpy.mockClear();
				debugSpy.mockClear();

				// Second cross-tier outclass, same episode: logs at DEBUG only.
				await strategy.select([low, high], laneMeta);
				expect(
					infoSpy.mock.calls.some((call) => call[0] === protectionMsg),
				).toBe(false);
				expect(
					debugSpy.mock.calls.some((call) => call[0] === protectionMsg),
				).toBe(true);
				infoSpy.mockClear();
				debugSpy.mockClear();

				// An ordinary sticky hit (no outclass pressure) ends the episode.
				expect((await strategy.select([low], laneMeta))[0].id).toBe("low");
				infoSpy.mockClear();
				debugSpy.mockClear();

				// The next cross-tier outclass after the reset logs at INFO again.
				await strategy.select([low, high], laneMeta);
				expect(
					infoSpy.mock.calls.some((call) => call[0] === protectionMsg),
				).toBe(true);
				expect(
					debugSpy.mock.calls.some((call) => call[0] === protectionMsg),
				).toBe(false);
			} finally {
				infoSpy.mockRestore();
				debugSpy.mockRestore();
			}
		});
	});

	it("preserves a temporarily excluded owner only when its tier is strictly better", async () => {
		const x = makeAccount({ id: "x", priority: 0 });
		const y = makeAccount({ id: "y", priority: 1 });
		const laneMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
		} as RequestMeta;

		expect((await strategy.select([x], laneMeta))[0].id).toBe("x");
		expect(
			(
				await strategy.select([y], {
					...laneMeta,
					routingCandidateCatalog: [
						{
							candidateId: "account:x",
							accountId: "x",
							tier: 0,
							ordinal: 0,
							comboSlotId: null,
							modelOverride: "claude-fable-5",
							quotaPressure: null,
						},
						{
							candidateId: "account:y",
							accountId: "y",
							tier: 1,
							ordinal: 1,
							comboSlotId: null,
							modelOverride: "claude-fable-5",
							quotaPressure: null,
						},
					],
				} as RequestMeta)
			)[0].id,
		).toBe("y");
		expect((await strategy.select([x, y], laneMeta))[0].id).toBe("x");
	});

	it("remaps an unavailable equal-tier owner instead of snapping back", async () => {
		const x = makeAccount({ id: "x", priority: 0 });
		const y = makeAccount({ id: "y", priority: 0 });
		const laneMeta = {
			...metaFor("equal-tier-client"),
			affinityLaneKey: "equal-tier-client:anthropic:fable",
		} as RequestMeta;

		expect((await strategy.select([x], laneMeta))[0].id).toBe("x");
		expect(
			(
				await strategy.select([x, y], {
					...laneMeta,
					hardExcludedAccountIds: new Set(["x"]),
				} as RequestMeta)
			)[0].id,
		).toBe("y");
		expect((await strategy.select([x, y], laneMeta))[0].id).toBe("y");
	});

	it("remaps an unavailable worse-tier owner", async () => {
		const worse = makeAccount({ id: "worse", priority: 1 });
		const better = makeAccount({ id: "better", priority: 0 });
		const laneMeta = {
			...metaFor("worse-tier-client"),
			affinityLaneKey: "worse-tier-client:anthropic:opus",
		} as RequestMeta;

		expect((await strategy.select([worse], laneMeta))[0].id).toBe("worse");
		expect(
			(
				await strategy.select([worse, better], {
					...laneMeta,
					hardExcludedAccountIds: new Set(["worse"]),
				} as RequestMeta)
			)[0].id,
		).toBe("better");
		expect((await strategy.select([worse, better], laneMeta))[0].id).toBe(
			"better",
		);
	});

	it("does not create affinity when every account is hard-excluded", async () => {
		const requestMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
			hardExcludedAccountIds: new Set(["x"]),
		} as RequestMeta;

		expect(
			await strategy.select([makeAccount({ id: "x" })], requestMeta),
		).toEqual([]);
		expect(strategy.affinityEntries).toBe(0);
	});

	it("replaces a sticky owner when comparable pressure outclasses it", async () => {
		const cold = makeAccount({ id: "cold" });
		const critical = makeAccount({ id: "critical" });
		const baseMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
		} as RequestMeta;

		expect((await strategy.select([cold], baseMeta))[0].id).toBe("cold");
		const pressureMeta = {
			...baseMeta,
			quotaPressureByAccountId: new Map([
				["cold", { band: "cold", comparisonKey: "same" }],
				["critical", { band: "critical", comparisonKey: "same" }],
			]),
		} as RequestMeta;
		expect((await strategy.select([cold, critical], pressureMeta))[0].id).toBe(
			"critical",
		);
		expect(
			(
				await strategy.select([cold, critical], {
					...baseMeta,
					quotaPressureByAccountId: new Map([
						["cold", { band: "steady", comparisonKey: "same" }],
						["critical", { band: "steady", comparisonKey: "same" }],
					]),
				} as RequestMeta)
			)[0].id,
		).toBe("critical");

		expect(
			(
				await strategy.select([cold, critical], {
					...pressureMeta,
					hardExcludedAccountIds: new Set(["critical"]),
				} as RequestMeta)
			)[0].id,
		).toBe("cold");
	});

	it("temporarily fails over from a better-tier owner and snaps back", async () => {
		const x = makeAccount({ id: "x", priority: 0 });
		const y = makeAccount({ id: "y", priority: 1 });
		store.setUtil("x", 0);
		store.setUtil("y", 0);

		// Pin client-1 to whichever account it gets (force it to x via util).
		store.setUtil("x", 0);
		store.setUtil("y", 50);
		const assigned = (await strategy.select([x, y], metaFor("client-1")))[0].id;
		expect(assigned).toBe("x");

		// x becomes rate-limited.
		const xDown = makeAccount({
			id: "x",
			rate_limited_until: Date.now() + 60_000,
		});
		const failover = await strategy.select([xDown, y], metaFor("client-1"));
		// Must route to an available account (y), not the down one.
		expect(failover[0].id).toBe("y");
		expect(failover.every((a) => a.id !== "x")).toBe(true);

		// x recovers → client snaps back to x (mapping was never deleted).
		const recovered = await strategy.select(
			[makeAccount({ id: "x" }), y],
			metaFor("client-1"),
		);
		expect(recovered[0].id).toBe("x");
	});

	it("keeps a temporary fallback sticky while preserving the better-tier owner for snapback", async () => {
		const primary = makeAccount({ id: "primary", priority: 0 });
		const fallbackA = makeAccount({ id: "fallback-a", priority: 1 });
		const fallbackB = makeAccount({ id: "fallback-b", priority: 1 });
		const laneMeta = {
			...metaFor("sticky-fallback-client"),
			affinityLaneKey: "sticky-fallback-client:anthropic:opus",
		} as RequestMeta;

		expect(
			(await strategy.select([primary, fallbackA, fallbackB], laneMeta))[0].id,
		).toBe("primary");

		const primaryDown = makeAccount({
			id: "primary",
			priority: 0,
			rate_limited_until: Date.now() + 60_000,
		});
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 50);
		expect(
			(await strategy.select([primaryDown, fallbackA, fallbackB], laneMeta))[0]
				.id,
		).toBe("fallback-a");

		// Least-used now strongly prefers B. The session must nevertheless keep
		// using A so its warmed prompt prefix survives the primary outage.
		store.setUtil(fallbackA.id, 99);
		store.setUtil(fallbackB.id, 0);
		expect(
			(
				await strategy.select([primaryDown, fallbackA, fallbackB], laneMeta)
			).map((account) => account.id),
		).toEqual(["fallback-a", "fallback-b"]);

		// The preferred owner remains separate and snaps back immediately once
		// it is safely routable again.
		expect(
			(await strategy.select([primary, fallbackA, fallbackB], laneMeta))[0].id,
		).toBe("primary");
	});

	it("replaces an eligible active fallback when a better tier appears and keeps the replacement sticky", async () => {
		const primary = makeAccount({ id: "primary", priority: 0 });
		const fallbackA = makeAccount({ id: "fallback-a", priority: 1 });
		const fallbackB = makeAccount({ id: "fallback-b", priority: 1 });
		const laneMeta = (): RequestMeta =>
			({
				...metaFor("fallback-tier-outclass-client"),
				affinityLaneKey: "fallback-tier-outclass-client:anthropic:opus",
			}) as RequestMeta;

		await strategy.select([primary, fallbackA, fallbackB], laneMeta());
		const primaryDown = makeAccount({
			id: primary.id,
			priority: 0,
			rate_limited_until: Date.now() + 60_000,
		});
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 50);
		expect(
			(
				await strategy.select([primaryDown, fallbackA, fallbackB], laneMeta())
			)[0].id,
		).toBe("fallback-a");

		// A remains eligible, but its lower routing tier now makes B authoritative.
		const fallbackAOutclassed = makeAccount({
			id: fallbackA.id,
			priority: 2,
		});
		expect(
			(
				await strategy.select(
					[primaryDown, fallbackAOutclassed, fallbackB],
					laneMeta(),
				)
			)[0].id,
		).toBe("fallback-b");

		// Once A rejoins B's class, least-used prefers A again. B must remain the
		// warmed fallback owner rather than oscillating back.
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 99);
		expect(
			(
				await strategy.select([primaryDown, fallbackA, fallbackB], laneMeta())
			)[0].id,
		).toBe("fallback-b");
	});

	it("replaces an eligible active fallback when comparable quota pressure outclasses it", async () => {
		const primary = makeAccount({ id: "primary", priority: 0 });
		const fallbackA = makeAccount({ id: "fallback-a", priority: 1 });
		const fallbackB = makeAccount({ id: "fallback-b", priority: 1 });
		const laneMeta = (): RequestMeta =>
			({
				...metaFor("fallback-pressure-outclass-client"),
				affinityLaneKey: "fallback-pressure-outclass-client:anthropic:fable",
			}) as RequestMeta;

		await strategy.select([primary, fallbackA, fallbackB], laneMeta());
		const primaryDown = makeAccount({
			id: primary.id,
			priority: 0,
			rate_limited_until: Date.now() + 60_000,
		});
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 50);
		const samePressureClass = (): RequestMeta =>
			({
				...laneMeta(),
				quotaPressureByAccountId: new Map([
					[fallbackA.id, { band: "steady", comparisonKey: "same" }],
					[fallbackB.id, { band: "steady", comparisonKey: "same" }],
				]),
			}) as RequestMeta;
		expect(
			(
				await strategy.select(
					[primaryDown, fallbackA, fallbackB],
					samePressureClass(),
				)
			)[0].id,
		).toBe("fallback-a");

		const outclassedPressure = (): RequestMeta =>
			({
				...laneMeta(),
				quotaPressureByAccountId: new Map([
					[fallbackA.id, { band: "cold", comparisonKey: "same" }],
					[fallbackB.id, { band: "critical", comparisonKey: "same" }],
				]),
			}) as RequestMeta;
		expect(
			(
				await strategy.select(
					[primaryDown, fallbackA, fallbackB],
					outclassedPressure(),
				)
			)[0].id,
		).toBe("fallback-b");

		// Returning to one pressure class must retain the warmed replacement even
		// when raw least-used utilization would choose A.
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 99);
		expect(
			(
				await strategy.select(
					[primaryDown, fallbackA, fallbackB],
					samePressureClass(),
				)
			)[0].id,
		).toBe("fallback-b");
	});

	it("replaces an active fallback when it becomes ineligible and sticks to the replacement", async () => {
		const primary = makeAccount({ id: "primary", priority: 0 });
		const fallbackA = makeAccount({ id: "fallback-a", priority: 1 });
		const fallbackB = makeAccount({ id: "fallback-b", priority: 1 });
		const laneMeta = {
			...metaFor("fallback-invalidation-client"),
			affinityLaneKey: "fallback-invalidation-client:anthropic:fable",
		} as RequestMeta;
		await strategy.select([primary, fallbackA, fallbackB], laneMeta);

		const primaryDown = makeAccount({
			id: "primary",
			priority: 0,
			rate_limited_until: Date.now() + 60_000,
		});
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 50);
		expect(
			(await strategy.select([primaryDown, fallbackA, fallbackB], laneMeta))[0]
				.id,
		).toBe("fallback-a");

		// Pausing A makes the old fallback illegal. It must be replaced, never
		// pinned through account-level unavailability.
		const fallbackAPaused = makeAccount({
			id: fallbackA.id,
			priority: 1,
			paused: true,
		});
		expect(
			(
				await strategy.select(
					[primaryDown, fallbackAPaused, fallbackB],
					laneMeta,
				)
			)[0].id,
		).toBe("fallback-b");

		// A recovers, but B is now request-scoped hard-excluded (for example, an
		// exhausted model lane), so ownership moves back to the only legal route.
		expect(
			(
				await strategy.select([primaryDown, fallbackA, fallbackB], {
					...laneMeta,
					hardExcludedAccountIds: new Set([fallbackB.id]),
				} as RequestMeta)
			)[0].id,
		).toBe("fallback-a");

		// Once both are eligible, least-used prefers B, but replacement A remains
		// the active fallback owner for this outage.
		store.setUtil(fallbackA.id, 99);
		store.setUtil(fallbackB.id, 0);
		expect(
			(await strategy.select([primaryDown, fallbackA, fallbackB], laneMeta))[0]
				.id,
		).toBe("fallback-a");
		expect(strategy.affinityEntries).toBe(1);
	});

	it("keeps the active fallback directly behind a half-open preferred-owner probe", async () => {
		let now = Date.now();
		const clocked = new SessionAffinityStrategy(
			undefined,
			undefined,
			undefined,
			undefined,
			() => now,
		);
		clocked.initialize(store);
		const primary = makeAccount({ id: "primary", priority: 0 });
		const fallbackA = makeAccount({ id: "fallback-a", priority: 1 });
		const fallbackB = makeAccount({ id: "fallback-b", priority: 1 });
		const laneMeta = {
			...metaFor("probe-fallback-client"),
			affinityLaneKey: "probe-fallback-client:anthropic:opus",
		} as RequestMeta;

		await clocked.select([primary, fallbackA, fallbackB], laneMeta);
		clocked.reportCandidateFailure(laneMeta, {
			candidateId: "account:primary",
			reason: "semantic_stream_stall",
			suppressForMs: 100,
		});
		store.setUtil(fallbackA.id, 0);
		store.setUtil(fallbackB.id, 50);
		expect(
			(await clocked.select([primary, fallbackA, fallbackB], laneMeta)).map(
				(account) => account.id,
			),
		).toEqual(["fallback-a", "fallback-b"]);

		store.setUtil(fallbackA.id, 99);
		store.setUtil(fallbackB.id, 0);
		now += 100;
		// The preferred probe still runs first, but if it fails this same request
		// immediately falls through to the warmed fallback A, not least-used B.
		expect(
			(await clocked.select([primary, fallbackA, fallbackB], laneMeta)).map(
				(account) => account.id,
			),
		).toEqual(["primary", "fallback-a", "fallback-b"]);
		// While the single-flight probe lease is held, concurrent turns continue
		// straight through the same warmed fallback.
		expect(
			(
				await clocked.select([primary, fallbackA, fallbackB], { ...laneMeta })
			).map((account) => account.id),
		).toEqual(["fallback-a", "fallback-b"]);
	});

	it("falls back to least-used when no clientSessionId is present", async () => {
		store.setUtil("low", 10);
		store.setUtil("high", 90);
		const accounts = [makeAccount({ id: "high" }), makeAccount({ id: "low" })];

		const ordered = await strategy.select(accounts, metaFor(null));
		expect(ordered[0].id).toBe("low");
		expect(ordered.map((a) => a.id).sort()).toEqual(["high", "low"]);
	});

	it("GCs an expired affinity mapping and reassigns", async () => {
		// Tiny TTL so the mapping expires between selects.
		const ttlStrategy = new SessionAffinityStrategy(1);
		ttlStrategy.initialize(store);

		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];

		const first = (await ttlStrategy.select(accounts, metaFor("client-1")))[0]
			.id;

		// Let the TTL elapse.
		const start = Date.now();
		while (Date.now() - start < 5) {
			/* busy-wait a few ms so now - assignedAt >= 1ms TTL */
		}

		// Make the *other* account strictly preferable so reassignment is
		// observable: if the old mapping were honoured we'd still get `first`.
		const other = first === "x" ? "y" : "x";
		store.setUtil(first, 90);
		store.setUtil(other, 0);

		const second = (await ttlStrategy.select(accounts, metaFor("client-1")))[0]
			.id;
		expect(second).toBe(other);
	});

	it("returns [] when all accounts are unavailable", async () => {
		const accounts = [
			makeAccount({ id: "p1", paused: true }),
			makeAccount({ id: "rl1", rate_limited_until: Date.now() + 60_000 }),
		];
		expect(await strategy.select(accounts, metaFor("client-1"))).toEqual([]);
	});

	it("spreads concurrent failovers across backups instead of piling onto one", async () => {
		// Pin two clients to the SAME account x (it's the only account at
		// assignment time), then bring x down with two equal healthy backups.
		const x = makeAccount({ id: "x" });
		await strategy.select([x], metaFor("c1"));
		await strategy.select([x], metaFor("c2"));

		const xDown = makeAccount({
			id: "x",
			rate_limited_until: Date.now() + 60_000,
		});
		const y = makeAccount({ id: "y" });
		const z = makeAccount({ id: "z" });
		store.setUtil("y", 0);
		store.setUtil("z", 0);

		const f1 = (await strategy.select([xDown, y, z], metaFor("c1")))[0].id;
		const f2 = (await strategy.select([xDown, y, z], metaFor("c2")))[0].id;

		// Both fail off the down account, and onto DIFFERENT backups — the
		// failover path now marks lastPickedAt, so the second failover is steered
		// off the first's pick. Pre-fix both converged on the same backup.
		expect(f1).not.toBe("x");
		expect(f2).not.toBe("x");
		expect(f1).not.toBe(f2);
		expect(new Set([f1, f2])).toEqual(new Set(["y", "z"]));
	});

	it("caps the affinity map under a flood of unique client ids", async () => {
		const cap = 5;
		const capped = new SessionAffinityStrategy(60_000, cap);
		capped.initialize(store);
		const x = makeAccount({ id: "x" });

		// Far more distinct client ids than the cap (simulates adversarial /
		// buggy callers sending many metadata.user_id values).
		for (let i = 0; i < cap * 4; i++) {
			await capped.select([x], metaFor(`client-${i}`));
		}

		expect(capped.affinityEntries).toBe(cap);
	});

	describe("peek", () => {
		it("returns the least-used available account id", () => {
			store.setUtil("low", 10);
			store.setUtil("high", 90);
			const accounts = [
				makeAccount({ id: "high" }),
				makeAccount({ id: "low" }),
			];
			expect(strategy.peek(accounts)).toBe("low");
		});

		it("returns null when no accounts are available", () => {
			expect(
				strategy.peek([
					makeAccount({ id: "p1", paused: true }),
					makeAccount({ id: "rl1", rate_limited_until: Date.now() + 60_000 }),
				]),
			).toBeNull();
		});
	});
	describe("anti-thrash suppression (R13)", () => {
		it("keeps AE5's deterministic first upgrade immediate", async () => {
			const low = makeAccount({ id: "low", priority: 1 });
			const high = makeAccount({ id: "high", priority: 0 });
			const laneMeta = {
				...metaFor("anti-thrash-first-upgrade"),
				affinityLaneKey: "anti-thrash-first-upgrade:anthropic:opus",
			} as RequestMeta;

			// high is CONFIGURED but unavailable at install time, so low installs
			// as a genuine displaced fallback (not "at home") and remains eligible
			// to upgrade.
			const highDownAtInstall = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect(
				(await strategy.select([low, highDownAtInstall], laneMeta))[0].id,
			).toBe("low");
			// The very first upgrade to a routable better tier is never suppressed.
			expect((await strategy.select([low, high], laneMeta))[0].id).toBe("high");
		});

		it("does not remap a flapping better-tier owner a second time inside the anti-thrash window, and resumes upgrades once it elapses", async () => {
			const windowMs = 40;
			const flappy = new SessionAffinityStrategy(
				undefined,
				undefined,
				windowMs,
			);
			flappy.initialize(store);

			const low = makeAccount({ id: "low", priority: 1 });
			const high = makeAccount({ id: "high", priority: 0 });
			const laneMeta = {
				...metaFor("flapping-client"),
				affinityLaneKey: "flapping-client:anthropic:opus",
			} as RequestMeta;

			// high is CONFIGURED but unavailable at install time, so low installs
			// as a genuine displaced fallback (not "at home") and remains
			// eligible for the deterministic first upgrade below.
			const highDownAtInstall = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect(
				(await flappy.select([low, highDownAtInstall], laneMeta))[0].id,
			).toBe("low");

			// The better tier becomes routable: deterministic first upgrade, immediate.
			expect((await flappy.select([low, high], laneMeta))[0].id).toBe("high");

			// The newly-upgraded owner fails inside the window: falls back to low
			// and arms suppression for the remainder of the window.
			const highDown = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect((await flappy.select([low, highDown], laneMeta))[0].id).toBe(
				"low",
			);

			// high "recovers" immediately, still well inside the window: must NOT
			// remap the session a second time.
			expect((await flappy.select([low, high], laneMeta))[0].id).toBe("low");
			expect((await flappy.select([low, high], laneMeta))[0].id).toBe("low");

			// Let the anti-thrash window elapse.
			const start = Date.now();
			while (Date.now() - start < windowMs + 20) {
				/* busy-wait past the anti-thrash window */
			}

			// Upgrade resumes once the window has passed.
			expect((await flappy.select([low, high], laneMeta))[0].id).toBe("high");
		});

		it("scopes suppression per-session, not globally", async () => {
			const windowMs = 60_000; // long enough this test's own timing can't race it
			const flappy = new SessionAffinityStrategy(
				undefined,
				undefined,
				windowMs,
			);
			flappy.initialize(store);

			const low = makeAccount({ id: "low", priority: 1 });
			const high = makeAccount({ id: "high", priority: 0 });
			const flappingMeta = {
				...metaFor("flapping-client-2"),
				affinityLaneKey: "flapping-client-2:anthropic:opus",
			} as RequestMeta;
			const otherMeta = {
				...metaFor("other-client-2"),
				affinityLaneKey: "other-client-2:anthropic:opus",
			} as RequestMeta;

			// high is CONFIGURED but unavailable at install time for both
			// sessions, so each installs low as a genuine displaced fallback (not
			// "at home") and remains eligible for its own first upgrade.
			const highDownAtInstall = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});

			// Session A upgrades, then its new owner fails fast: suppression is
			// armed for session A only.
			expect(
				(await flappy.select([low, highDownAtInstall], flappingMeta))[0].id,
			).toBe("low");
			expect((await flappy.select([low, high], flappingMeta))[0].id).toBe(
				"high",
			);
			const highDown = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect((await flappy.select([low, highDown], flappingMeta))[0].id).toBe(
				"low",
			);
			expect((await flappy.select([low, high], flappingMeta))[0].id).toBe(
				"low",
			);

			// Session B (a different client) still gets its own immediate upgrade
			// to the very same physical "high" account: suppression never leaked
			// across sessions.
			expect(
				(await flappy.select([low, highDownAtInstall], otherMeta))[0].id,
			).toBe("low");
			expect((await flappy.select([low, high], otherMeta))[0].id).toBe("high");
		});

		it("does not treat a request-scoped hard exclusion of the upgraded owner as anti-thrash flapping", async () => {
			const windowMs = 60_000;
			const flappy = new SessionAffinityStrategy(
				undefined,
				undefined,
				windowMs,
			);
			flappy.initialize(store);

			const low = makeAccount({ id: "low", priority: 1 });
			const high = makeAccount({ id: "high", priority: 0 });
			const laneMeta = {
				...metaFor("excluded-not-flapping-client"),
				affinityLaneKey: "excluded-not-flapping-client:anthropic:opus",
			} as RequestMeta;

			// high is CONFIGURED but unavailable at install time, so low installs
			// as a genuine displaced fallback (not "at home") and remains
			// eligible to upgrade.
			const highDownAtInstall = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: Date.now() + 60_000,
			});
			expect(
				(await flappy.select([low, highDownAtInstall], laneMeta))[0].id,
			).toBe("low");
			expect((await flappy.select([low, high], laneMeta))[0].id).toBe("high");

			// high is excluded for one request (e.g. model mismatch), not failing.
			expect(
				(
					await flappy.select([low, high], {
						...laneMeta,
						hardExcludedAccountIds: new Set(["high"]),
					} as RequestMeta)
				)[0].id,
			).toBe("low");

			// Since that wasn't a genuine failure, no suppression should have been
			// armed: high is immediately usable again next request.
			expect((await flappy.select([low, high], laneMeta))[0].id).toBe("high");
		});

		it("arms suppression for a combo route whose owner fast-fails, even though combo pre-filtering removes it from `accounts` before select() runs", async () => {
			// account-selector.ts's combo path always builds
			// routingCandidateCatalog from every enabled slot regardless of
			// availability, but it filters paused/rate-limited slots out of the
			// `accounts` array it passes to select() -- unlike normal routing,
			// where a failed account remains in `accounts` and is only excluded
			// by the strategy's own isAccountAvailable check. Fast-fail detection
			// must read structural eligibility from the catalog, not `accounts`.
			const windowMs = 40;
			const flappy = new SessionAffinityStrategy(
				undefined,
				undefined,
				windowMs,
			);
			flappy.initialize(store);

			const low = makeAccount({ id: "low", priority: 1 });
			const high = makeAccount({ id: "high", priority: 0 });
			const laneMeta = {
				...metaFor("combo-flapping-client"),
				affinityLaneKey: "combo-flapping-client:anthropic:opus",
			} as RequestMeta;
			const catalog = [
				{
					candidateId: "combo:c1:slot:low",
					accountId: "low",
					tier: 1,
					ordinal: 0,
					comboSlotId: "slot-low",
					modelOverride: "claude-opus-4-8",
					quotaPressure: null,
				},
				{
					candidateId: "combo:c1:slot:high",
					accountId: "high",
					tier: 0,
					ordinal: 1,
					comboSlotId: "slot-high",
					modelOverride: "claude-opus-4-8",
					quotaPressure: null,
				},
			];
			const comboMeta = (): RequestMeta =>
				({ ...laneMeta, routingCandidateCatalog: catalog }) as RequestMeta;

			// Initial assignment: high starts rate-limited and is pre-filtered
			// out of `accounts` by account-selector's combo path.
			expect((await flappy.select([low], comboMeta()))[0].id).toBe("low");

			// high recovers and is passed through: deterministic first upgrade.
			expect((await flappy.select([low, high], comboMeta()))[0].id).toBe(
				"high",
			);

			// high fails again inside the window. The combo pre-filter removes
			// it from `accounts` entirely -- it survives only in
			// routingCandidateCatalog.
			expect((await flappy.select([low], comboMeta()))[0].id).toBe("low");

			// high recovers a second time, still well inside the anti-thrash
			// window: must NOT remap the session a second time.
			expect((await flappy.select([low, high], comboMeta()))[0].id).toBe("low");
			expect((await flappy.select([low, high], comboMeta()))[0].id).toBe("low");

			// Let the anti-thrash window elapse.
			const start = Date.now();
			while (Date.now() - start < windowMs + 20) {
				/* busy-wait past the anti-thrash window */
			}

			// Upgrade resumes once the window has passed.
			expect((await flappy.select([low, high], comboMeta()))[0].id).toBe(
				"high",
			);
		});

		it("regression: retain-owner directive installing a DIFFERENT owner must not inherit the previous owner's upgradedAt -- its own later unavailability is preserved-for-snapback, not wrongly treated as a just-upgraded owner flapping (critical fix pin)", async () => {
			const windowMs = 1_000;
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				windowMs,
				undefined,
				() => now,
			);
			clocked.initialize(store);

			const low = makeAccount({ id: "low", priority: 2 });
			const mid = makeAccount({ id: "mid", priority: 1 });
			const high = makeAccount({ id: "high", priority: 0 });
			const laneMeta = {
				...metaFor("owner-swap-upgradedat-client"),
				affinityLaneKey: "owner-swap-upgradedat-client:anthropic:opus",
			} as RequestMeta;

			// Install low as a genuine displaced fallback (high is CONFIGURED but
			// down at install time).
			const highDown = makeAccount({
				id: "high",
				priority: 0,
				rate_limited_until: now + 60_000,
			});
			expect((await clocked.select([low, highDown], laneMeta))[0].id).toBe(
				"low",
			);

			// high recovers: a REAL R13 upgrade. mapping.upgradedAt is set to this
			// moment (T1).
			now += 10;
			expect((await clocked.select([low, high], laneMeta))[0].id).toBe("high");

			// A retain-owner directive fires for a DIFFERENT owner (mid), not
			// high. This is the exact ownerChanged branch the fix touches.
			now += 10;
			const directiveMeta = {
				...laneMeta,
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: { candidateId: "account:mid", accountId: "mid" },
				},
			} as RequestMeta;
			expect(
				(await clocked.select([low, mid, high], directiveMeta))[0].id,
			).toBe("mid");

			// Drop the directive. mid goes down shortly after -- well inside the
			// anti-thrash window measured from T1, which is what a buggy inherited
			// upgradedAt would still be armed against. mid was never actually
			// upgraded to via R13, so this must be ordinary preserve-for-snapback,
			// not a fast-fail-after-upgrade.
			now += 10;
			const midDown = makeAccount({
				id: "mid",
				priority: 1,
				rate_limited_until: now + 60_000,
			});
			expect((await clocked.select([low, midDown], laneMeta))[0].id).toBe(
				"low",
			);

			// mid recovers, still well inside the window. Correct behavior: mid
			// was preserved for snapback (never remapped away), so this is an
			// ordinary sticky hit and mid comes back immediately. A buggy inherited
			// upgradedAt would have made the prior step arm suppression and
			// permanently swap the mapping to low -- in which case this select
			// would wrongly stay on low instead of returning to mid.
			now += 10;
			expect((await clocked.select([low, mid], laneMeta))[0].id).toBe("mid");
		});

		it("regression: retain-owner directive installing a DIFFERENT owner must not inherit the previous owner's suppressUpgradesUntil -- a legitimate later upgrade for the new owner must not be spuriously withheld (critical fix pin)", async () => {
			const windowMs = 1_000;
			let now = Date.now();
			const clocked = new SessionAffinityStrategy(
				undefined,
				undefined,
				windowMs,
				undefined,
				() => now,
			);
			clocked.initialize(store);

			const low = makeAccount({ id: "low", priority: 3 });
			const mid = makeAccount({ id: "mid", priority: 2 });
			const high = makeAccount({ id: "high", priority: 1 });
			const top = makeAccount({ id: "top", priority: 0 });
			const laneMeta = {
				...metaFor("owner-swap-suppressuntil-client"),
				affinityLaneKey: "owner-swap-suppressuntil-client:anthropic:opus",
			} as RequestMeta;

			// Install low as a genuine displaced fallback (mid is CONFIGURED but
			// down at install time).
			const midDown = makeAccount({
				id: "mid",
				priority: 2,
				rate_limited_until: now + 60_000,
			});
			expect((await clocked.select([low, midDown], laneMeta))[0].id).toBe(
				"low",
			);

			// mid recovers: a REAL R13 upgrade.
			now += 10;
			expect((await clocked.select([low, mid], laneMeta))[0].id).toBe("mid");

			// mid genuinely fast-fails inside the anti-thrash window: this arms
			// mapping.suppressUpgradesUntil (T2) against mid and remaps to low.
			now += 10;
			const midDown2 = makeAccount({
				id: "mid",
				priority: 2,
				rate_limited_until: now + 60_000,
			});
			expect((await clocked.select([low, midDown2], laneMeta))[0].id).toBe(
				"low",
			);

			// A retain-owner directive now installs a BRAND-NEW owner, high --
			// unrelated to mid's flapping. top is CONFIGURED but down at this
			// exact moment, so high installs as a genuine displaced fallback (not
			// at-home), keeping it eligible to upgrade once top recovers.
			now += 10;
			const topDown = makeAccount({
				id: "top",
				priority: 0,
				rate_limited_until: now + 60_000,
			});
			const directiveMeta = {
				...laneMeta,
				affinityOwnerDirective: {
					kind: "retain-owner",
					owner: { candidateId: "account:high", accountId: "high" },
				},
			} as RequestMeta;
			expect(
				(await clocked.select([low, high, topDown], directiveMeta))[0].id,
			).toBe("high");

			// Drop the directive. top recovers -- a legitimate future upgrade for
			// the freshly-installed owner high, which never itself flapped. A
			// buggy inherited suppressUpgradesUntil (still armed from mid's
			// fast-fail, well inside the window) would spuriously withhold it.
			now += 10;
			expect((await clocked.select([low, high, top], laneMeta))[0].id).toBe(
				"top",
			);
		});
	});

	it("does not own xAI cache affinity inside the generic session strategy", async () => {
		const accounts = [
			makeAccount({ id: "a", provider: "xai" }),
			makeAccount({ id: "b", provider: "xai" }),
		];
		const convoMeta = {
			...metaFor(null),
			cacheAffinityKey: "ccflare-xai-convo-1",
			xaiCacheNativeActive: true,
			xaiCacheEligibleAccountIds: new Set(["a", "b"]),
		} as RequestMeta;
		const first = (await strategy.select(accounts, convoMeta))[0].id;
		const second = (
			await strategy.select(accounts, {
				...metaFor(null),
				cacheAffinityKey: "ccflare-xai-convo-1",
				xaiCacheNativeActive: true,
				xaiCacheEligibleAccountIds: new Set(["a", "b"]),
			} as RequestMeta)
		)[0].id;
		expect(second).not.toBe(first);
	});

	describe("non-optimistic auto-unpause (wouldAutoUnpause path)", () => {
		it("does not select or unpause an account when store.resumeAccount resolves resumed:false", async () => {
			// Eligible-looking for wouldAutoUnpause: paused, auto_fallback_enabled,
			// safe pause_reason, anthropic provider, elapsed rate_limit_reset. A
			// racy store (e.g. it lost the resume to a concurrent guard, or the
			// account was re-paused between the check and the write) reports
			// resumed:false. autoUnpauseElapsedAccounts must not optimistically
			// flip account.paused to false or select the account on this pass.
			const account = makeAccount({
				id: "racy",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: Date.now() - 5_000,
			});

			const racyStore: StrategyStore = {
				resetAccountSession() {},
				resumeAccount: async () => ({
					resumed: false,
					pauseReason: "overage",
				}),
			};
			strategy.initialize(racyStore);

			const result = await strategy.select([account], metaFor("client-racy"));

			expect(account.paused).toBe(true);
			expect(result.find((a) => a.id === "racy")).toBeUndefined();
		});
	});
});
