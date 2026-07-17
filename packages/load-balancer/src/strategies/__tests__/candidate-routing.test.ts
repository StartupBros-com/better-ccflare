import { describe, expect, it } from "bun:test";
import {
	LeastUsedStrategy,
	SessionAffinityStrategy,
	SessionStrategy,
} from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	RoutingCandidateMetadata,
	StrategyStore,
} from "@better-ccflare/types";

function account(id: string, priority = 0): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh",
		access_token: "access",
		expires_at: Date.now() + 60_000,
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
		priority,
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
	};
}

function candidate(
	candidateId: string,
	accountId: string,
	tier: number,
	ordinal: number,
	band?: "cold" | "critical",
): RoutingCandidateMetadata {
	return {
		candidateId,
		accountId,
		tier,
		ordinal,
		comboSlotId: candidateId,
		modelOverride: `model-${candidateId}`,
		quotaPressure: band
			? { band, comparisonKey: "same-subscription-window" }
			: null,
	};
}

function meta(
	routingCandidates: RoutingCandidateMetadata[],
	lane = "lane",
): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "client",
		affinityLaneKey: lane,
		routingCandidates,
		routingCandidateCatalog: routingCandidates,
	} as RequestMeta;
}

const store: StrategyStore = {
	resetAccountSession() {},
	async resumeAccount() {
		return { resumed: true, pauseReason: null };
	},
	getAccountUtilization() {
		return 0;
	},
};

describe("atomic strategy candidates", () => {
	it("LeastUsedStrategy orders candidate metadata with duplicate accounts", async () => {
		const strategy = new LeastUsedStrategy();
		strategy.initialize(store);
		const shared = account("shared", 99);
		const requestMeta = meta([
			candidate("slot-cold", "shared", 0, 0, "cold"),
			candidate("slot-critical", "shared", 0, 1, "critical"),
		]);

		const ordered = await strategy.select([shared, shared], requestMeta);

		expect(ordered).toEqual([shared, shared]);
		expect(
			requestMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["slot-critical", "slot-cold"]);
	});

	it("SessionStrategy uses candidate tiers and keeps metadata aligned", async () => {
		const strategy = new SessionStrategy();
		strategy.initialize(store);
		const highAccountPriority = account("account-a", 50);
		const lowAccountPriority = account("account-b", 0);
		const requestMeta = meta([
			candidate("slot-a", "account-a", 0, 0),
			candidate("slot-b", "account-b", 10, 1),
		]);

		const ordered = await strategy.select(
			[highAccountPriority, lowAccountPriority],
			requestMeta,
		);

		expect(ordered.map((item) => item.id)).toEqual(["account-a", "account-b"]);
		expect(
			requestMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["slot-a", "slot-b"]);
	});

	it("SessionAffinityStrategy sticks to candidate identity for duplicate-account slots", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		const shared = account("shared");
		const firstMeta = meta([
			candidate("slot-a", "shared", 0, 0),
			candidate("slot-b", "shared", 0, 1),
		]);
		await strategy.select([shared, shared], firstMeta);
		expect(firstMeta.routingCandidates?.[0]?.candidateId).toBe("slot-a");

		const reorderedMeta = meta(
			[
				candidate("slot-b", "shared", 0, 1),
				candidate("slot-a", "shared", 0, 0),
			],
			"lane",
		);
		await strategy.select([shared, shared], reorderedMeta);

		expect(
			reorderedMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["slot-a", "slot-b"]);
	});

	it("SessionAffinityStrategy preempts on candidate pressure and retains the new owner", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		const cold = account("cold");
		const hot = account("hot");
		await strategy.select(
			[cold],
			meta([candidate("cold-slot", "cold", 0, 0, "cold")]),
		);

		const pressured = meta([
			candidate("cold-slot", "cold", 0, 0, "cold"),
			candidate("hot-slot", "hot", 0, 1, "critical"),
		]);
		expect((await strategy.select([cold, hot], pressured))[0]?.id).toBe("hot");
		expect(pressured.routingCandidates?.[0]?.candidateId).toBe("hot-slot");

		const equalized = meta([
			candidate("cold-slot", "cold", 0, 0),
			candidate("hot-slot", "hot", 0, 1),
		]);
		expect((await strategy.select([cold, hot], equalized))[0]?.id).toBe("hot");
	});

	it("SessionAffinityStrategy preserves a missing better-tier candidate for snapback", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		const preferred = account("preferred");
		const fallback = account("fallback");
		const catalog = [
			candidate("preferred-slot", "preferred", 0, 0),
			candidate("fallback-slot", "fallback", 10, 1),
		];
		await strategy.select([preferred, fallback], meta(catalog));

		const failoverMeta = meta([catalog[1] as RoutingCandidateMetadata]);
		failoverMeta.routingCandidateCatalog = catalog;
		expect((await strategy.select([fallback], failoverMeta))[0]?.id).toBe(
			"fallback",
		);

		const recoveredMeta = meta(catalog);
		expect(
			(await strategy.select([preferred, fallback], recoveredMeta))[0]?.id,
		).toBe("preferred");
		expect(recoveredMeta.routingCandidates?.[0]?.candidateId).toBe(
			"preferred-slot",
		);
	});
});
