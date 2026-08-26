import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearAllProbeBackoff,
	PROBE_BACKOFF_PENALTY_THRESHOLD_MS,
	setProbeBackoff,
} from "@better-ccflare/core";
import { SessionDrainSoonestStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	ResumeResult,
	RoutingCandidateMetadata,
	StrategyStore,
} from "@better-ccflare/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "test",
		access_token: "test",
		expires_at: Date.now() + 3_600_000,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

class MockStrategyStore implements StrategyStore {
	readonly utilizationMap = new Map<string, number | null>();
	readonly weeklyResetMap = new Map<string, number | null>();

	resetAccountSession(_accountId: string, _timestamp: number): void {}

	resumeAccount(_accountId: string): ResumeResult {
		return { resumed: true, pauseReason: null };
	}

	getAccountUtilization(accountId: string, _provider: string): number | null {
		return this.utilizationMap.get(accountId) ?? null;
	}

	getAccountWeeklyReset(accountId: string, _provider: string): number | null {
		return this.weeklyResetMap.get(accountId) ?? null;
	}

	setUtilization(accountId: string, value: number | null): void {
		this.utilizationMap.set(accountId, value);
	}

	setWeeklyReset(accountId: string, value: number | null): void {
		this.weeklyResetMap.set(accountId, value);
	}
}

function makeMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: crypto.randomUUID(),
		headers: new Headers(),
		path: "/v1/messages",
		method: "POST",
		timestamp: Date.now(),
		...overrides,
	};
}

function candidates(
	entries: Array<{ id: string; tier: number }>,
): RoutingCandidateMetadata[] {
	return entries.map(({ id, tier }, ordinal) => ({
		candidateId: `route:${id}`,
		accountId: id,
		tier,
		ordinal,
		comboSlotId: null,
		modelOverride: null,
		quotaPressure: null,
	}));
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("SessionDrainSoonestStrategy strict mode", () => {
	let strategy: SessionDrainSoonestStrategy;
	let store: MockStrategyStore;

	beforeEach(() => {
		clearAllProbeBackoff();
		strategy = new SessionDrainSoonestStrategy(undefined, "strict");
		store = new MockStrategyStore();
		strategy.initialize(store);
	});

	afterEach(() => {
		clearAllProbeBackoff();
	});

	it("ranks every request by the earliest weekly reset instead of retaining ordinary client affinity", async () => {
		const now = Date.now();
		const early = makeAccount({ id: "early", name: "early" });
		const late = makeAccount({ id: "late", name: "late" });
		const meta = makeMeta({ clientSessionId: "conversation" });
		store.setWeeklyReset("early", now + DAY);
		store.setWeeklyReset("late", now + 6 * DAY);

		expect((await strategy.select([late, early], meta))[0]?.id).toBe("early");

		store.setWeeklyReset("early", now + 6 * DAY);
		store.setWeeklyReset("late", now + DAY);
		expect((await strategy.select([late, early], meta))[0]?.id).toBe("late");
	});

	it("filters circuit-open routes without restoring ordinary affinity", async () => {
		const now = Date.now();
		const failed = makeAccount({ id: "failed", name: "failed" });
		const healthy = makeAccount({ id: "healthy", name: "healthy" });
		store.setWeeklyReset("failed", now + DAY);
		store.setWeeklyReset("healthy", now + 6 * DAY);
		const requestMeta = makeMeta({
			clientSessionId: "strict-circuit-client",
			routingCandidates: candidates([
				{ id: "failed", tier: 0 },
				{ id: "healthy", tier: 0 },
			]),
		});
		strategy.reportCandidateFailure(requestMeta, {
			candidateId: "route:failed",
			reason: "semantic_stream_stall",
			suppressForMs: 60_000,
		});

		const selected = await strategy.select([failed, healthy], requestMeta);

		expect(selected.map((account) => account.id)).toEqual(["healthy"]);
		expect(strategy.snapshotAffinityOwner(requestMeta)).toBeNull();
	});

	it("keeps structural route classes ahead of drain urgency", async () => {
		const now = Date.now();
		const preferred = makeAccount({ id: "preferred", name: "preferred" });
		const urgent = makeAccount({ id: "urgent", name: "urgent" });
		store.setWeeklyReset("preferred", now + 6 * DAY);
		store.setWeeklyReset("urgent", now + DAY);
		const meta = makeMeta({
			routingCandidates: candidates([
				{ id: "preferred", tier: 0 },
				{ id: "urgent", tier: 1 },
			]),
		});

		expect((await strategy.select([preferred, urgent], meta))[0]?.id).toBe(
			"preferred",
		);
	});

	it("reopens an expired session on the drain-earliest account", async () => {
		const now = Date.now();
		const agedOut = makeAccount({
			id: "aged-out",
			name: "aged-out",
			session_start: now - 6 * HOUR,
			session_request_count: 941,
		});
		const activeLater = makeAccount({
			id: "active-later",
			name: "active-later",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("aged-out", now + DAY);
		store.setWeeklyReset("active-later", now + 6 * DAY);
		const resetCalls: string[] = [];
		store.resetAccountSession = (accountId: string) => {
			resetCalls.push(accountId);
		};

		expect(
			(await strategy.select([activeLater, agedOut], makeMeta()))[0]?.id,
		).toBe("aged-out");
		expect(resetCalls).toEqual(["aged-out"]);
		expect(agedOut.session_start).toBeGreaterThanOrEqual(now);
		expect(agedOut.session_request_count).toBe(0);
	});

	it("prefers an active session when weekly resets are equally unknown", async () => {
		const now = Date.now();
		const incumbent = makeAccount({
			id: "incumbent",
			name: "incumbent",
			session_start: now - HOUR,
		});
		const idle = makeAccount({ id: "idle", name: "idle" });
		store.setUtilization("incumbent", 90);
		store.setUtilization("idle", 10);

		expect(strategy.peek([incumbent, idle])).toBe("incumbent");
		expect((await strategy.select([incumbent, idle], makeMeta()))[0]?.id).toBe(
			"incumbent",
		);
	});

	it("uses account id as the final deterministic tie-breaker", async () => {
		const now = Date.now();
		const a = makeAccount({
			id: "acc-a",
			name: "acc-a",
			session_start: now - 2 * HOUR,
		});
		const b = makeAccount({
			id: "acc-b",
			name: "acc-b",
			session_start: now - HOUR,
		});

		expect((await strategy.select([b, a], makeMeta()))[0]?.id).toBe("acc-a");
	});

	it("keeps peek and fresh select aligned", async () => {
		const now = Date.now();
		const early = makeAccount({ id: "early", name: "early" });
		const late = makeAccount({
			id: "late",
			name: "late",
			session_start: now - 5 * 60 * 1000,
		});
		store.setWeeklyReset("early", now + DAY);
		store.setWeeklyReset("late", now + 6 * DAY);

		expect(strategy.peek([late, early])).toBe("early");
		expect((await strategy.select([late, early], makeMeta()))[0]?.id).toBe(
			"early",
		);
	});

	it("starts a session when the selected account has none", async () => {
		const now = Date.now();
		const early = makeAccount({ id: "early", name: "early" });
		const late = makeAccount({
			id: "late",
			name: "late",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("early", now + DAY);
		store.setWeeklyReset("late", now + 6 * DAY);
		const calls: string[] = [];
		store.resetAccountSession = (accountId: string) => {
			calls.push(accountId);
		};

		await strategy.select([late, early], makeMeta());
		expect(calls).toEqual(["early"]);
	});

	it("uses account priority before utilization inside one structural class", async () => {
		const lowPriority = makeAccount({
			id: "low-priority",
			name: "low-priority",
			priority: 5,
		});
		const highPriority = makeAccount({
			id: "high-priority",
			name: "high-priority",
			priority: 0,
		});
		store.setUtilization("low-priority", 10);
		store.setUtilization("high-priority", 90);
		const meta = makeMeta({
			routingCandidates: candidates([
				{ id: "low-priority", tier: 0 },
				{ id: "high-priority", tier: 0 },
			]),
		});

		expect(
			(await strategy.select([lowPriority, highPriority], meta))[0]?.id,
		).toBe("high-priority");
	});

	it("uses lower utilization before account id after reset, activity, and priority tie", async () => {
		const higher = makeAccount({ id: "acc-a", name: "acc-a" });
		const lower = makeAccount({ id: "acc-z", name: "acc-z" });
		store.setUtilization("acc-a", 90);
		store.setUtilization("acc-z", 10);

		expect((await strategy.select([higher, lower], makeMeta()))[0]?.id).toBe(
			"acc-z",
		);
	});

	it("keeps ranking but suppresses session mutation for the bypass header", async () => {
		const now = Date.now();
		const agedOut = makeAccount({
			id: "aged-out",
			name: "aged-out",
			session_start: now - 6 * HOUR,
		});
		const later = makeAccount({
			id: "later",
			name: "later",
			session_start: now - 10 * 60 * 1000,
		});
		store.setWeeklyReset("aged-out", now + DAY);
		store.setWeeklyReset("later", now + 6 * DAY);
		const resetCalls: string[] = [];
		store.resetAccountSession = (accountId: string) => {
			resetCalls.push(accountId);
		};

		const selected = await strategy.select(
			[later, agedOut],
			makeMeta({
				headers: new Headers({
					"x-better-ccflare-bypass-session": "true",
				}),
			}),
		);

		expect(selected[0]?.id).toBe("aged-out");
		expect(resetCalls).toEqual([]);
		expect(agedOut.session_start).toBe(now - 6 * HOUR);
	});

	it("keeps an eligible auto-fallback first inside the same structural class", async () => {
		const now = Date.now();
		const fallback = makeAccount({
			id: "fallback",
			name: "fallback",
			auto_fallback_enabled: true,
			rate_limit_reset: now - 60_000,
		});
		const early = makeAccount({ id: "early", name: "early" });
		const late = makeAccount({ id: "late", name: "late" });
		store.setWeeklyReset("fallback", now + 6 * DAY);
		store.setWeeklyReset("early", now + DAY);
		store.setWeeklyReset("late", now + 3 * DAY);

		expect(
			(await strategy.select([late, early, fallback], makeMeta())).map(
				(account) => account.id,
			),
		).toEqual(["fallback", "early", "late"]);
	});

	it("penalizes a probe-backed-off account after structural policy ties", async () => {
		const now = Date.now();
		const backedOff = makeAccount({ id: "acc-a", name: "acc-a" });
		const healthy = makeAccount({ id: "acc-z", name: "acc-z" });
		store.setWeeklyReset("acc-a", now + DAY);
		store.setWeeklyReset("acc-z", now + DAY);
		setProbeBackoff(backedOff.id, now + PROBE_BACKOFF_PENALTY_THRESHOLD_MS);

		expect(
			(await strategy.select([backedOff, healthy], makeMeta()))[0]?.id,
		).toBe("acc-z");
	});
});
