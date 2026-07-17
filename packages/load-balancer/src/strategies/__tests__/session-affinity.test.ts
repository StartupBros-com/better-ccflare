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

	it("replaces a sticky lower-priority owner when a better tier becomes routable", async () => {
		const low = makeAccount({ id: "low", priority: 1 });
		const high = makeAccount({ id: "high", priority: 0 });
		const laneMeta = {
			...metaFor("same-client"),
			affinityLaneKey: "same-client:anthropic:opus",
		} as RequestMeta;

		expect((await strategy.select([low], laneMeta))[0].id).toBe("low");
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

			expect((await strategy.select([low], laneMeta))[0].id).toBe("low");
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

			// Initial assignment lands on the only available (worse-tier) account.
			expect((await flappy.select([low], laneMeta))[0].id).toBe("low");

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

			// Session A upgrades, then its new owner fails fast: suppression is
			// armed for session A only.
			expect((await flappy.select([low], flappingMeta))[0].id).toBe("low");
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
			expect((await flappy.select([low], otherMeta))[0].id).toBe("low");
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

			expect((await flappy.select([low], laneMeta))[0].id).toBe("low");
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
