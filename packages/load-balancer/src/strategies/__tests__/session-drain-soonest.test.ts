import { beforeEach, describe, expect, it } from "bun:test";
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
});
