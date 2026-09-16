import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SessionDrainSoonestStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh",
		access_token: "access",
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
	readonly resetCalls: string[] = [];
	readonly resumeCalls: string[] = [];
	readonly utilization = new Map<string, number | null>();
	readonly weeklyResets = new Map<string, number | null>();

	resetAccountSession(accountId: string): void {
		this.resetCalls.push(accountId);
	}

	async resumeAccount(accountId: string) {
		this.resumeCalls.push(accountId);
		return { resumed: true, pauseReason: null };
	}

	getAccountUtilization(accountId: string): number | null {
		return this.utilization.get(accountId) ?? null;
	}

	getAccountWeeklyReset(accountId: string): number | null {
		return this.weeklyResets.get(accountId) ?? null;
	}
}

function meta(clientSessionId?: string): RequestMeta {
	return {
		id: "request",
		headers: new Headers(),
		timestamp: Date.now(),
		clientSessionId: clientSessionId ?? null,
	} as RequestMeta;
}

describe("SessionDrainSoonestStrategy", () => {
	let store: MockStore;
	let strategy: SessionDrainSoonestStrategy;

	beforeEach(() => {
		store = new MockStore();
		strategy = new SessionDrainSoonestStrategy();
		strategy.initialize(store);
	});

	it("ranks a fresh client assignment by the earliest future weekly reset", async () => {
		const now = Date.now();
		const later = makeAccount({ id: "later", priority: 0 });
		const sooner = makeAccount({ id: "sooner", priority: 0 });
		store.weeklyResets.set("later", now + 5 * 60 * 60 * 1000);
		store.weeklyResets.set("sooner", now + 60 * 60 * 1000);

		const ordered = await strategy.select([later, sooner], meta("client-1"));

		expect(ordered.map((account) => account.id)).toEqual(["sooner", "later"]);
	});

	it("uses the all-model weekly reset for same-class Codex accounts", async () => {
		const now = Date.now();
		const later = makeAccount({ id: "codex-later", provider: "codex" });
		const sooner = makeAccount({ id: "codex-sooner", provider: "codex" });
		store.weeklyResets.set("codex-later", now + 5 * 60 * 60 * 1000);
		store.weeklyResets.set("codex-sooner", now + 60 * 60 * 1000);

		const ordered = await strategy.select([later, sooner], meta());

		expect(ordered.map((account) => account.id)).toEqual([
			"codex-sooner",
			"codex-later",
		]);
	});

	it("keeps unknown or stale resets behind known future resets", async () => {
		const now = Date.now();
		const known = makeAccount({ id: "known", priority: 0 });
		const stale = makeAccount({ id: "stale", priority: 0 });
		store.weeklyResets.set("known", now + 60 * 60 * 1000);
		store.weeklyResets.set("stale", now - 1);

		const ordered = await strategy.select([stale, known], meta("client-1"));

		expect(ordered.map((account) => account.id)).toEqual(["known", "stale"]);
	});

	it("preserves per-client affinity after the first selection", async () => {
		const now = Date.now();
		const first = makeAccount({ id: "first" });
		const second = makeAccount({ id: "second" });
		store.weeklyResets.set("first", now + 60 * 60 * 1000);
		store.weeklyResets.set("second", now + 2 * 60 * 60 * 1000);

		const firstPick = await strategy.select([first, second], meta("client-1"));
		store.weeklyResets.set("second", now + 1_000);
		const secondPick = await strategy.select([second, first], meta("client-1"));

		expect(firstPick[0]?.id).toBe("first");
		expect(secondPick[0]?.id).toBe("first");
	});

	it("inherits routing health from the shared session-affinity path", async () => {
		const owner = makeAccount({ id: "owner", priority: 5 });
		const better = makeAccount({ id: "better", priority: 0 });

		expect((await strategy.select([owner], meta("health-client")))[0]?.id).toBe(
			"owner",
		);
		expect(
			(await strategy.select([owner, better], meta("health-client")))[0]?.id,
		).toBe("owner");
		expect(strategy.getRoutingHealth()).toEqual({
			affinityEntries: 1,
			routeSuppressionEntries: 0,
			routeSuppressionGcSweeps: 1,
			transitions: {
				atHomeProtections: 1,
				outclassRemaps: { crossTier: 0, sameTier: 0 },
				failoverRemaps: 0,
				snapbackPreservations: 0,
			},
		});
	});

	it("uses weekly reset ordering without a client session id", async () => {
		const now = Date.now();
		const later = makeAccount({ id: "later", priority: 0 });
		const sooner = makeAccount({ id: "sooner", priority: 0 });
		store.weeklyResets.set("later", now + 5 * 60 * 60 * 1000);
		store.weeklyResets.set("sooner", now + 60 * 60 * 1000);

		const ordered = await strategy.select([later, sooner], meta());

		expect(ordered[0]?.id).toBe("sooner");
		expect(strategy.snapshotAffinityOwner(meta())).toBeNull();
	});

	it("breaks reset ties by utilization after priority", async () => {
		const now = Date.now();
		const high = makeAccount({ id: "high", priority: 0 });
		const low = makeAccount({ id: "low", priority: 0 });
		const reset = now + 60 * 60 * 1000;
		store.weeklyResets.set("high", reset);
		store.weeklyResets.set("low", reset);
		store.utilization.set("high", 80);
		store.utilization.set("low", 20);

		const ordered = await strategy.select([high, low], meta());

		expect(ordered[0]?.id).toBe("low");
	});

	it("uses account priority before utilization within one route class", async () => {
		const now = Date.now();
		const preferred = makeAccount({ id: "preferred", priority: 0 });
		const lower = makeAccount({ id: "lower", priority: 1 });
		const reset = now + 60 * 60 * 1000;
		store.weeklyResets.set("preferred", reset);
		store.weeklyResets.set("lower", reset);
		store.utilization.set("preferred", 90);
		store.utilization.set("lower", 10);
		const requestMeta = {
			...meta(),
			routingCandidates: [
				{
					candidateId: "preferred-route",
					accountId: "preferred",
					tier: 0,
					ordinal: 0,
					comboSlotId: null,
					modelOverride: null,
					quotaPressure: null,
				},
				{
					candidateId: "lower-route",
					accountId: "lower",
					tier: 0,
					ordinal: 1,
					comboSlotId: null,
					modelOverride: null,
					quotaPressure: null,
				},
			],
		} as RequestMeta;

		const ordered = await strategy.select([preferred, lower], requestMeta);

		expect(ordered[0]?.id).toBe("preferred");
	});

	it("keeps a better structural route class ahead of an earlier reset", async () => {
		const now = Date.now();
		const preferred = makeAccount({ id: "preferred", priority: 0 });
		const urgent = makeAccount({ id: "urgent", priority: 0 });
		store.weeklyResets.set("preferred", now + 5 * 60 * 60 * 1000);
		store.weeklyResets.set("urgent", now + 1_000);
		const requestMeta = {
			...meta(),
			routingCandidates: [
				{
					candidateId: "preferred-route",
					accountId: "preferred",
					tier: 0,
					ordinal: 0,
					comboSlotId: null,
					modelOverride: null,
					quotaPressure: null,
				},
				{
					candidateId: "urgent-route",
					accountId: "urgent",
					tier: 1,
					ordinal: 1,
					comboSlotId: null,
					modelOverride: null,
					quotaPressure: null,
				},
			],
		} as RequestMeta;

		const ordered = await strategy.select([preferred, urgent], requestMeta);

		expect(ordered[0]?.id).toBe("preferred");
	});

	it("uses drain ranking when a sticky owner is unavailable, without dropping affinity", async () => {
		const now = Date.now();
		const owner = makeAccount({ id: "owner" });
		const fallback = makeAccount({ id: "fallback" });
		store.weeklyResets.set("owner", now + 60 * 60 * 1000);
		store.weeklyResets.set("fallback", now + 2 * 60 * 60 * 1000);
		await strategy.select([owner, fallback], meta("client-1"));

		const unavailableOwner = makeAccount({
			id: "owner",
			rate_limited_until: now + 60_000,
		});
		const ordered = await strategy.select(
			[unavailableOwner, fallback],
			meta("client-1"),
		);

		expect(ordered[0]?.id).toBe("fallback");
		expect(strategy.snapshotAffinityOwner(meta("client-1"))?.accountId).toBe(
			"fallback",
		);
	});

	it("keeps an active lane owner even when another account resets sooner", async () => {
		const now = Date.now();
		const owner = makeAccount({ id: "owner" });
		const sooner = makeAccount({ id: "sooner" });
		store.weeklyResets.set("owner", now + 5 * 60 * 60 * 1000);
		store.weeklyResets.set("sooner", now + 1_000);

		await strategy.select([owner], meta("client-2"));
		const activeOwner = makeAccount({ id: "owner" });
		const activeOrdered = await strategy.select(
			[sooner, activeOwner],
			meta("client-2"),
		);
		expect(activeOrdered[0]?.id).toBe("owner");
	});

	it("keeps exact candidate identity for reordered combo-like duplicate entries", async () => {
		const now = Date.now();
		const shared = makeAccount({ id: "shared" });
		const requestMeta = {
			...meta(),
			routingCandidates: [
				{
					candidateId: "shared:early",
					accountId: "shared",
					tier: 0,
					ordinal: 0,
					comboSlotId: "early",
					modelOverride: "model-a",
					quotaPressure: {
						band: "cold",
						comparisonKey: "same-window",
					},
				},
				{
					candidateId: "shared:late",
					accountId: "shared",
					tier: 0,
					ordinal: 1,
					comboSlotId: "late",
					modelOverride: "model-b",
					quotaPressure: {
						band: "hot",
						comparisonKey: "same-window",
					},
				},
			],
		} as RequestMeta;
		store.weeklyResets.set("shared", now + 60 * 60 * 1000);

		const ordered = await strategy.select([shared, shared], requestMeta);

		expect(ordered).toHaveLength(2);
		expect(
			requestMeta.routingCandidates?.map((candidate) => candidate.candidateId),
		).toEqual(["shared:late", "shared:early"]);
	});

	it("keeps peek and fresh select aligned", async () => {
		const now = Date.now();
		const later = makeAccount({ id: "later", priority: 0 });
		const sooner = makeAccount({ id: "sooner", priority: 0 });
		store.weeklyResets.set("later", now + 5 * 60 * 60 * 1000);
		store.weeklyResets.set("sooner", now + 60 * 60 * 1000);

		expect(strategy.peek([later, sooner])).toBe("sooner");
		expect((await strategy.select([later, sooner], meta()))[0]?.id).toBe(
			"sooner",
		);
	});

	it("keeps default SessionAffinityStrategy behavior unchanged", async () => {
		const noReset = makeAccount({ id: "no-reset", priority: 0 });
		const priorityWinner = makeAccount({ id: "priority-winner", priority: 1 });
		const ordered = await strategy.select(
			[priorityWinner, noReset],
			meta("client-1"),
		);
		expect(ordered[0]?.id).toBe("no-reset");
	});

	describe("warm Codex session ownership", () => {
		const pressureMeta = (clientSessionId = "warm-client"): RequestMeta => ({
			...meta(clientSessionId),
			quotaPressureByAccountId: new Map([
				["owner", { band: "cold", comparisonKey: "weekly" }],
				["urgent", { band: "critical", comparisonKey: "weekly" }],
			]),
		});

		it("keeps an existing owner across burn bands while new sessions use quota ranking", async () => {
			const owner = makeAccount({ id: "owner", provider: "codex" });
			const urgent = makeAccount({ id: "urgent", provider: "codex" });
			await strategy.select([owner], meta("warm-client"));

			expect((await strategy.select([urgent, owner], pressureMeta()))[0]).toBe(
				owner,
			);
			expect(
				(await strategy.select([owner, urgent], pressureMeta("new-client")))[0],
			).toBe(urgent);
			expect(
				strategy.snapshotAffinityOwner(meta("warm-client"))?.accountId,
			).toBe(owner.id);
			expect(
				strategy.getRoutingHealth().transitions.outclassRemaps.sameTier,
			).toBe(0);
		});

		it.each([
			["strict Codex", "codex", "strict"],
			["sticky Anthropic", "anthropic", "sticky"],
		] as const)("preserves %s pressure remapping", async (_name, provider, mode) => {
			const legacy = new SessionDrainSoonestStrategy(undefined, mode);
			legacy.initialize(store);
			const owner = makeAccount({ id: "owner", provider });
			const urgent = makeAccount({ id: "urgent", provider });
			await legacy.select([owner], meta("warm-client"));
			expect((await legacy.select([owner, urgent], pressureMeta()))[0]).toBe(
				urgent,
			);
		});

		it("keeps a warmed temporary fallback across burn bands and still snaps back to its better tier", async () => {
			const primary = makeAccount({
				id: "primary",
				provider: "codex",
				priority: 0,
			});
			const owner = makeAccount({
				id: "owner",
				provider: "codex",
				priority: 1,
			});
			const urgent = makeAccount({
				id: "urgent",
				provider: "codex",
				priority: 1,
			});
			await strategy.select([primary, owner], meta("warm-client"));
			const primaryDown = {
				...primary,
				rate_limited_until: Date.now() + 60_000,
			};
			expect(
				(await strategy.select([primaryDown, owner], meta("warm-client")))[0],
			).toBe(owner);
			expect(
				(
					await strategy.select([primaryDown, urgent, owner], pressureMeta())
				)[0],
			).toBe(owner);
			expect(
				(await strategy.select([primary, urgent, owner], pressureMeta()))[0],
			).toBe(primary);
		});

		it.each([
			false,
			true,
		])("does not probe a pressure-only competitor ahead of a warm owner (temporary fallback: %s)", async (temporaryFallback) => {
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			try {
				const clocked = new SessionDrainSoonestStrategy();
				clocked.initialize(store);
				const owner = makeAccount({
					id: "owner",
					provider: "codex",
					priority: 1,
				});
				const urgent = makeAccount({
					id: "urgent",
					provider: "codex",
					priority: 1,
				});
				const primary = makeAccount({
					id: "primary",
					provider: "codex",
					priority: 0,
				});
				if (temporaryFallback) {
					await clocked.select([primary, owner], meta("warm-client"));
					primary.rate_limited_until = now + 60_000;
				}
				const accounts = temporaryFallback
					? [primary, owner, urgent]
					: [owner, urgent];
				await clocked.select(
					temporaryFallback ? [primary, owner] : [owner],
					meta("warm-client"),
				);
				clocked.reportCandidateFailure(meta("warm-client"), {
					candidateId: "account:urgent",
					reason: "semantic_stream_stall",
					suppressForMs: 100,
				});
				now += 100;
				expect((await clocked.select(accounts, pressureMeta()))[0]).toBe(owner);
				// Declining this unused probe must not consume its single-flight lease.
				clocked.reportCandidateFailure(meta("warm-client"), {
					candidateId: "account:owner",
					reason: "semantic_stream_stall",
					suppressForMs: 100,
				});
				expect((await clocked.select(accounts, pressureMeta()))[0]).toBe(
					urgent,
				);
			} finally {
				clock.mockRestore();
			}
		});

		it("still probes a recovered better tier ahead of a Codex fallback", async () => {
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			try {
				const clocked = new SessionDrainSoonestStrategy();
				clocked.initialize(store);
				const primary = makeAccount({
					id: "primary",
					provider: "codex",
					priority: 0,
				});
				const owner = makeAccount({
					id: "owner",
					provider: "codex",
					priority: 1,
				});
				await clocked.select([primary, owner], meta("warm-client"));
				clocked.reportCandidateFailure(meta("warm-client"), {
					candidateId: "account:primary",
					reason: "semantic_stream_stall",
					suppressForMs: 100,
				});
				expect(
					(await clocked.select([primary, owner], meta("warm-client")))[0],
				).toBe(owner);
				now += 100;
				expect(
					(await clocked.select([primary, owner], meta("warm-client")))[0],
				).toBe(primary);
			} finally {
				clock.mockRestore();
			}
		});

		it.each([
			false,
			true,
		])("preserves better fallback-rung recovery (circuit recovery: %s)", async (circuitRecovery) => {
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			try {
				const clocked = new SessionDrainSoonestStrategy();
				clocked.initialize(store);
				const shared = makeAccount({ id: "shared", provider: "codex" });
				const requested = {
					candidateId: "shared:requested",
					accountId: shared.id,
					tier: 0,
					ordinal: 0,
					comboSlotId: null,
					modelOverride: "gpt-6-astra",
					quotaPressure: null,
					routeFallbackRung: "profile_requested_model" as const,
				};
				const fallback = {
					...requested,
					candidateId: "shared:root",
					ordinal: 1,
					modelOverride: "gpt-5.6-sol",
					routeFallbackRung: "profile_root_model" as const,
				};
				if (circuitRecovery) {
					await clocked.select([shared], {
						...meta("warm-client"),
						routingCandidates: [requested],
					});
					clocked.reportCandidateFailure(meta("warm-client"), {
						candidateId: requested.candidateId,
						reason: "semantic_stream_stall",
						suppressForMs: 100,
					});
				}
				await clocked.select([shared], {
					...meta("warm-client"),
					routingCandidates: [fallback],
				});
				now += 100;
				const recovered = {
					...meta("warm-client"),
					routingCandidates: [fallback, requested],
				};
				await clocked.select([shared, shared], recovered);
				expect(recovered.routingCandidates[0]?.candidateId).toBe(
					requested.candidateId,
				);
			} finally {
				clock.mockRestore();
			}
		});

		it("still upgrades a temporary Codex fallback when a better tier is available", async () => {
			const primary = makeAccount({
				id: "primary",
				provider: "codex",
				priority: 0,
			});
			const owner = makeAccount({
				id: "owner",
				provider: "codex",
				priority: 2,
			});
			const better = makeAccount({
				id: "better",
				provider: "codex",
				priority: 1,
			});
			await strategy.select([primary, owner], meta("warm-client"));
			primary.rate_limited_until = Date.now() + 60_000;
			expect(
				(await strategy.select([primary, owner], meta("warm-client")))[0],
			).toBe(owner);
			expect(
				(
					await strategy.select([primary, owner, better], meta("warm-client"))
				)[0],
			).toBe(better);
		});

		it("preserves exact warm combo slot identity when sibling slots have higher pressure", async () => {
			const shared = makeAccount({ id: "shared", provider: "codex" });
			const owner = {
				candidateId: "shared:astra",
				accountId: shared.id,
				tier: 0,
				ordinal: 0,
				comboSlotId: "astra",
				modelOverride: "gpt-6-astra",
				quotaPressure: { band: "cold" as const, comparisonKey: "weekly" },
			};
			const sibling = {
				...owner,
				candidateId: "shared:sol",
				ordinal: 1,
				comboSlotId: "sol",
				modelOverride: "gpt-5.6-sol",
				quotaPressure: { band: "critical" as const, comparisonKey: "weekly" },
			};
			await strategy.select([shared], {
				...meta("warm-client"),
				routingCandidates: [owner],
			});
			const followup = {
				...meta("warm-client"),
				routingCandidates: [sibling, owner],
			};
			await strategy.select([shared, shared], followup);
			expect(
				followup.routingCandidates.map((candidate) => candidate.candidateId),
			).toEqual([owner.candidateId, sibling.candidateId]);
			expect(followup.routingCandidates[0]?.modelOverride).toBe("gpt-6-astra");
		});

		it.each([
			"paused",
			"rate-limited",
			"capacity-excluded",
			"circuit-open",
			"removed",
		])("fails over from an owner that is %s", async (reason) => {
			const owner = makeAccount({ id: "owner", provider: "codex" });
			const urgent = makeAccount({ id: "urgent", provider: "codex" });
			await strategy.select([owner], meta("warm-client"));
			const request = pressureMeta();
			if (reason === "paused") owner.paused = true;
			if (reason === "rate-limited")
				owner.rate_limited_until = Date.now() + 60_000;
			// The request planner marks exhausted capacity as a hard exclusion.
			if (reason === "capacity-excluded")
				request.hardExcludedAccountIds = new Set([owner.id]);
			if (reason === "circuit-open")
				strategy.reportCandidateFailure(request, {
					candidateId: "account:owner",
					reason: "semantic_stream_stall",
					suppressForMs: 60_000,
				});
			expect(
				(
					await strategy.select(
						reason === "removed" ? [urgent] : [owner, urgent],
						request,
					)
				)[0],
			).toBe(urgent);
			expect(
				strategy.snapshotAffinityOwner(meta("warm-client"))?.accountId,
			).toBe(urgent.id);
		});
	});

	describe("codex upstream window reset preserves warm affinity", () => {
		it("retains the healthy owner and resets its accounting after rollover", async () => {
			const now = Date.now();
			const requestMeta = meta("codex-window-client");
			const rolledOver = makeAccount({
				id: "codex-rolled",
				name: "codex-rolled",
				provider: "codex",
				session_start: now - 60 * 60 * 1000,
				session_request_count: 40,
				rate_limit_reset: now + 60 * 60 * 1000,
			});
			const drainsSooner = makeAccount({
				id: "codex-drains-sooner",
				name: "codex-drains-sooner",
				provider: "codex",
			});
			store.weeklyResets.set("codex-drains-sooner", now + 30 * 60 * 1000);
			store.weeklyResets.set("codex-rolled", now + 5 * 24 * 60 * 60 * 1000);
			await strategy.select([rolledOver], requestMeta);
			rolledOver.rate_limit_reset = now - 2000;

			const result = await strategy.select(
				[rolledOver, drainsSooner],
				requestMeta,
			);

			expect(result[0]).toBe(rolledOver);
			expect(store.resetCalls).toContain(rolledOver.id);
			expect(rolledOver.session_request_count).toBe(0);
			expect(rolledOver.session_start).toBeGreaterThanOrEqual(now);
			expect(strategy.peek([rolledOver, drainsSooner])).toBe(
				"codex-drains-sooner",
			);
		});

		it("keeps strict Codex drain placement after a window rollover", async () => {
			const strict = new SessionDrainSoonestStrategy(undefined, "strict");
			strict.initialize(store);
			const now = Date.now();
			const previous = makeAccount({
				id: "previous",
				provider: "codex",
				session_start: now - 60 * 60 * 1000,
				rate_limit_reset: now + 60_000,
			});
			const sooner = makeAccount({ id: "sooner", provider: "codex" });
			await strict.select([previous], meta("strict-window-client"));
			previous.rate_limit_reset = now - 2000;
			store.weeklyResets.set(previous.id, now + 5 * 24 * 60 * 60 * 1000);
			store.weeklyResets.set(sooner.id, now + 30 * 60 * 1000);
			expect(
				(
					await strict.select([previous, sooner], meta("strict-window-client"))
				)[0],
			).toBe(sooner);
			expect(
				strict.snapshotAffinityOwner(meta("strict-window-client")),
			).toBeNull();
		});

		it("resets a rolled-over affinity owner when it is the only candidate", async () => {
			const now = Date.now();
			const sessionStart = now - 60 * 60 * 1000;
			const requestMeta = meta("codex-only-client");
			const account = makeAccount({
				id: "codex-only",
				name: "codex-only",
				provider: "codex",
				session_start: sessionStart,
				session_request_count: 40,
				rate_limit_reset: now + 60 * 60 * 1000,
			});
			await strategy.select([account], requestMeta);
			account.rate_limit_reset = now - 2000;

			const result = await strategy.select([account], requestMeta);

			expect(result[0]).toBe(account);
			expect(store.resetCalls).toContain(account.id);
			expect(account.session_start).toBeGreaterThan(sessionStart);
			expect(account.session_request_count).toBe(0);
		});

		it("keeps the affinity owner while the reported window is still open", async () => {
			const now = Date.now();
			const sessionStart = now - 60 * 60 * 1000;
			const requestMeta = meta("codex-window-client");
			const active = makeAccount({
				id: "codex-open",
				name: "codex-open",
				provider: "codex",
				session_start: sessionStart,
				session_request_count: 40,
				rate_limit_reset: now + 60 * 60 * 1000,
			});
			const drainsSooner = makeAccount({
				id: "codex-drains-sooner",
				name: "codex-drains-sooner",
				provider: "codex",
			});
			store.weeklyResets.set("codex-drains-sooner", now + 30 * 60 * 1000);
			await strategy.select([active], requestMeta);

			const result = await strategy.select([active, drainsSooner], requestMeta);

			expect(result[0]).toBe(active);
			expect(store.resetCalls).not.toContain(active.id);
			expect(active.session_start).toBe(sessionStart);
		});
	});
});
