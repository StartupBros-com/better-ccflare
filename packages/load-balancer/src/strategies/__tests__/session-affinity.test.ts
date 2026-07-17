import { beforeEach, describe, expect, it } from "bun:test";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
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
	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
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

	it("assigns a new client an account and sticks it there (sticky)", () => {
		const accounts = [
			makeAccount({ id: "x" }),
			makeAccount({ id: "y" }),
			makeAccount({ id: "z" }),
		];

		const first = strategy.select(accounts, metaFor("client-1"));
		const assigned = first[0].id;

		// Subsequent selects with the same client id must keep returning the
		// same account first, even though util/recency would otherwise rotate.
		for (let i = 0; i < 5; i++) {
			const next = strategy.select(accounts, metaFor("client-1"));
			expect(next[0].id).toBe(assigned);
		}
	});

	it("spreads two different clients onto different accounts", () => {
		// Two equal accounts (priority 0, util 0). The recency penalty must push
		// the second new client onto the other account.
		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];

		const a = strategy.select(accounts, metaFor("client-a"))[0].id;
		const b = strategy.select(accounts, metaFor("client-b"))[0].id;

		expect(a).not.toBe(b);
		expect(new Set([a, b])).toEqual(new Set(["x", "y"]));
	});

	it("keeps independent Fable and Opus owners for the same client session", () => {
		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];
		const fableMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
		} as RequestMeta;
		const opusMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:opus",
		} as RequestMeta;

		const fableOwner = strategy.select(accounts, fableMeta)[0].id;
		const opusOwner = strategy.select(accounts, opusMeta)[0].id;

		expect(opusOwner).not.toBe(fableOwner);
		expect(strategy.select(accounts, fableMeta)[0].id).toBe(fableOwner);
		expect(strategy.select(accounts, opusMeta)[0].id).toBe(opusOwner);
	});

	it("replaces a sticky lower-priority owner when a better tier becomes routable", () => {
		const low = makeAccount({ id: "low", priority: 1 });
		const high = makeAccount({ id: "high", priority: 0 });
		const laneMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:opus",
		} as RequestMeta;

		expect(strategy.select([low], laneMeta)[0].id).toBe("low");
		expect(strategy.select([low, high], laneMeta)[0].id).toBe("high");
		// The better-tier owner replaces the old mapping; making the two accounts
		// equal later must not resurrect the displaced lower-tier owner.
		expect(
			strategy.select(
				[low, makeAccount({ id: "high", priority: 1 })],
				laneMeta,
			)[0].id,
		).toBe("high");

		const highExcluded = {
			...laneMeta,
			hardExcludedAccountIds: new Set(["high"]),
		} as RequestMeta;
		expect(strategy.select([low, high], highExcluded)[0].id).toBe("low");
	});

	it("preserves a temporarily excluded owner only when its tier is strictly better", () => {
		const x = makeAccount({ id: "x", priority: 0 });
		const y = makeAccount({ id: "y", priority: 1 });
		const laneMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
		} as RequestMeta;

		expect(strategy.select([x], laneMeta)[0].id).toBe("x");
		expect(
			strategy.select([y], {
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
			} as RequestMeta)[0].id,
		).toBe("y");
		expect(strategy.select([x, y], laneMeta)[0].id).toBe("x");
	});

	it("remaps an unavailable equal-tier owner instead of snapping back", () => {
		const x = makeAccount({ id: "x", priority: 0 });
		const y = makeAccount({ id: "y", priority: 0 });
		const laneMeta = {
			...metaFor("equal-tier-client"),
			affinityLaneKey: "equal-tier-client:anthropic:fable",
		} as RequestMeta;

		expect(strategy.select([x], laneMeta)[0].id).toBe("x");
		expect(
			strategy.select([x, y], {
				...laneMeta,
				hardExcludedAccountIds: new Set(["x"]),
			} as RequestMeta)[0].id,
		).toBe("y");
		expect(strategy.select([x, y], laneMeta)[0].id).toBe("y");
	});

	it("remaps an unavailable worse-tier owner", () => {
		const worse = makeAccount({ id: "worse", priority: 1 });
		const better = makeAccount({ id: "better", priority: 0 });
		const laneMeta = {
			...metaFor("worse-tier-client"),
			affinityLaneKey: "worse-tier-client:anthropic:opus",
		} as RequestMeta;

		expect(strategy.select([worse], laneMeta)[0].id).toBe("worse");
		expect(
			strategy.select([worse, better], {
				...laneMeta,
				hardExcludedAccountIds: new Set(["worse"]),
			} as RequestMeta)[0].id,
		).toBe("better");
		expect(strategy.select([worse, better], laneMeta)[0].id).toBe("better");
	});

	it("does not create affinity when every account is hard-excluded", () => {
		const requestMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
			hardExcludedAccountIds: new Set(["x"]),
		} as RequestMeta;

		expect(strategy.select([makeAccount({ id: "x" })], requestMeta)).toEqual(
			[],
		);
		expect(strategy.affinityEntries).toBe(0);
	});

	it("replaces a sticky owner when comparable pressure outclasses it", () => {
		const cold = makeAccount({ id: "cold" });
		const critical = makeAccount({ id: "critical" });
		const baseMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:fable",
		} as RequestMeta;

		expect(strategy.select([cold], baseMeta)[0].id).toBe("cold");
		const pressureMeta = {
			...baseMeta,
			quotaPressureByAccountId: new Map([
				["cold", { band: "cold", comparisonKey: "same" }],
				["critical", { band: "critical", comparisonKey: "same" }],
			]),
		} as RequestMeta;
		expect(strategy.select([cold, critical], pressureMeta)[0].id).toBe(
			"critical",
		);
		expect(
			strategy.select([cold, critical], {
				...baseMeta,
				quotaPressureByAccountId: new Map([
					["cold", { band: "steady", comparisonKey: "same" }],
					["critical", { band: "steady", comparisonKey: "same" }],
				]),
			} as RequestMeta)[0].id,
		).toBe("critical");

		expect(
			strategy.select([cold, critical], {
				...pressureMeta,
				hardExcludedAccountIds: new Set(["critical"]),
			} as RequestMeta)[0].id,
		).toBe("cold");
	});

	it("temporarily fails over from a better-tier owner and snaps back", () => {
		const x = makeAccount({ id: "x", priority: 0 });
		const y = makeAccount({ id: "y", priority: 1 });
		store.setUtil("x", 0);
		store.setUtil("y", 0);

		// Pin client-1 to whichever account it gets (force it to x via util).
		store.setUtil("x", 0);
		store.setUtil("y", 50);
		const assigned = strategy.select([x, y], metaFor("client-1"))[0].id;
		expect(assigned).toBe("x");

		// x becomes rate-limited.
		const xDown = makeAccount({
			id: "x",
			rate_limited_until: Date.now() + 60_000,
		});
		const failover = strategy.select([xDown, y], metaFor("client-1"));
		// Must route to an available account (y), not the down one.
		expect(failover[0].id).toBe("y");
		expect(failover.every((a) => a.id !== "x")).toBe(true);

		// x recovers → client snaps back to x (mapping was never deleted).
		const recovered = strategy.select(
			[makeAccount({ id: "x" }), y],
			metaFor("client-1"),
		);
		expect(recovered[0].id).toBe("x");
	});

	it("falls back to least-used when no clientSessionId is present", () => {
		store.setUtil("low", 10);
		store.setUtil("high", 90);
		const accounts = [makeAccount({ id: "high" }), makeAccount({ id: "low" })];

		const ordered = strategy.select(accounts, metaFor(null));
		expect(ordered[0].id).toBe("low");
		expect(ordered.map((a) => a.id).sort()).toEqual(["high", "low"]);
	});

	it("GCs an expired affinity mapping and reassigns", () => {
		// Tiny TTL so the mapping expires between selects.
		const ttlStrategy = new SessionAffinityStrategy(1);
		ttlStrategy.initialize(store);

		const accounts = [makeAccount({ id: "x" }), makeAccount({ id: "y" })];

		const first = ttlStrategy.select(accounts, metaFor("client-1"))[0].id;

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

		const second = ttlStrategy.select(accounts, metaFor("client-1"))[0].id;
		expect(second).toBe(other);
	});

	it("returns [] when all accounts are unavailable", () => {
		const accounts = [
			makeAccount({ id: "p1", paused: true }),
			makeAccount({ id: "rl1", rate_limited_until: Date.now() + 60_000 }),
		];
		expect(strategy.select(accounts, metaFor("client-1"))).toEqual([]);
	});

	it("spreads concurrent failovers across backups instead of piling onto one", () => {
		// Pin two clients to the SAME account x (it's the only account at
		// assignment time), then bring x down with two equal healthy backups.
		const x = makeAccount({ id: "x" });
		strategy.select([x], metaFor("c1"));
		strategy.select([x], metaFor("c2"));

		const xDown = makeAccount({
			id: "x",
			rate_limited_until: Date.now() + 60_000,
		});
		const y = makeAccount({ id: "y" });
		const z = makeAccount({ id: "z" });
		store.setUtil("y", 0);
		store.setUtil("z", 0);

		const f1 = strategy.select([xDown, y, z], metaFor("c1"))[0].id;
		const f2 = strategy.select([xDown, y, z], metaFor("c2"))[0].id;

		// Both fail off the down account, and onto DIFFERENT backups — the
		// failover path now marks lastPickedAt, so the second failover is steered
		// off the first's pick. Pre-fix both converged on the same backup.
		expect(f1).not.toBe("x");
		expect(f2).not.toBe("x");
		expect(f1).not.toBe(f2);
		expect(new Set([f1, f2])).toEqual(new Set(["y", "z"]));
	});

	it("caps the affinity map under a flood of unique client ids", () => {
		const cap = 5;
		const capped = new SessionAffinityStrategy(60_000, cap);
		capped.initialize(store);
		const x = makeAccount({ id: "x" });

		// Far more distinct client ids than the cap (simulates adversarial /
		// buggy callers sending many metadata.user_id values).
		for (let i = 0; i < cap * 4; i++) {
			capped.select([x], metaFor(`client-${i}`));
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
	it("does not own xAI cache affinity inside the generic session strategy", () => {
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
		const first = strategy.select(accounts, convoMeta)[0].id;
		const second = strategy.select(accounts, {
			...metaFor(null),
			cacheAffinityKey: "ccflare-xai-convo-1",
			xaiCacheNativeActive: true,
			xaiCacheEligibleAccountIds: new Set(["a", "b"]),
		} as RequestMeta)[0].id;
		expect(second).not.toBe(first);
	});
});
