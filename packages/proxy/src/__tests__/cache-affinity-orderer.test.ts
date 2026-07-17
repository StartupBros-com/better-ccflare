import { describe, expect, it } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { CacheAffinityOrderer } from "../cache-affinity-orderer";

function account(id: string, provider = "xai"): Account {
	return {
		id,
		name: id,
		provider,
		api_key: null,
		refresh_token: "r",
		access_token: "t",
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
		consecutive_rate_limits: 0,
	};
}

function meta(key: string): RequestMeta {
	return {
		id: "request",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		cacheAffinityKey: key,
		xaiCacheNativeActive: true,
		xaiCacheEligibleAccountIds: new Set(["xai-a", "xai-b"]),
	};
}

function candidate(
	candidateId: string,
	accountId: string,
	tier: number,
	ordinal: number,
	options: { comboSlotId?: string; modelOverride?: string } = {},
) {
	return {
		candidateId,
		accountId,
		tier,
		ordinal,
		comboSlotId: options.comboSlotId ?? null,
		modelOverride: options.modelOverride ?? null,
		quotaPressure: null,
	};
}

function candidateMeta(
	key: string,
	catalog: ReturnType<typeof candidate>[],
	current = catalog,
): RequestMeta {
	return Object.assign(meta(key), {
		routingCandidateCatalog: catalog,
		routingCandidates: current,
	});
}

describe("CacheAffinityOrderer", () => {
	it("keeps an owner across changing base-strategy order", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");

		expect(orderer.order([a, b], meta("conversation"))[0]?.id).toBe("xai-a");
		expect(orderer.order([b, a], meta("conversation"))[0]?.id).toBe("xai-a");
	});

	it("preserves ineligible provider slots", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const codex = account("codex", "codex");
		const a = account("xai-a");
		const b = account("xai-b");

		orderer.order([a, b], meta("conversation"));
		expect(
			orderer
				.order([codex, b, a], meta("conversation"))
				.map((candidate) => candidate.id),
		).toEqual(["codex", "xai-a", "xai-b"]);
	});

	it("preserves an unavailable owner only when its configured tier is strictly better", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");
		a.priority = 0;
		b.priority = 1;
		const catalog = [
			candidate("account:xai-a", a.id, 0, 0),
			candidate("account:xai-b", b.id, 1, 1),
		];

		orderer.order([a, b], candidateMeta("conversation", catalog));
		expect(
			orderer.order(
				[b],
				candidateMeta("conversation", catalog, [catalog[1]]),
			)[0]?.id,
		).toBe("xai-b");
		expect(
			orderer.order([a, b], candidateMeta("conversation", catalog))[0]?.id,
		).toBe("xai-a");
	});

	it("replaces an unavailable equal-tier owner instead of snapping back", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");
		const catalog = [
			candidate("account:xai-a", a.id, 0, 0),
			candidate("account:xai-b", b.id, 0, 1),
		];

		orderer.order([a], candidateMeta("conversation", catalog, [catalog[0]]));
		expect(
			orderer
				.order([b], candidateMeta("conversation", catalog, [catalog[1]]))
				.map((candidate) => candidate.id),
		).toEqual(["xai-b"]);

		expect(
			orderer
				.order([a, b], candidateMeta("conversation", catalog))
				.map((candidate) => candidate.id),
		).toEqual(["xai-b", "xai-a"]);
	});

	it("replaces an unavailable worse-tier owner", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const worse = account("xai-a");
		const better = account("xai-b");
		worse.priority = 1;
		better.priority = 0;
		const firstCatalog = [candidate("account:xai-a", worse.id, 1, 0)];
		orderer.order([worse], candidateMeta("conversation", firstCatalog));

		const catalog = [
			candidate("account:xai-b", better.id, 0, 0),
			candidate("account:xai-a", worse.id, 1, 1),
		];
		expect(
			orderer.order(
				[better],
				candidateMeta("conversation", catalog, [catalog[0]]),
			)[0]?.id,
		).toBe("xai-b");
		expect(
			orderer.order([better, worse], candidateMeta("conversation", catalog))[0]
				?.id,
		).toBe("xai-b");
		const equalCatalog = [
			candidate("account:xai-a", worse.id, 1, 0),
			candidate("account:xai-b", better.id, 1, 1),
		];
		expect(
			orderer.order(
				[worse, better],
				candidateMeta("conversation", equalCatalog),
			)[0]?.id,
		).toBe("xai-b");
	});

	it("replaces the current owner when a better tier recovers", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const worse = account("xai-a");
		const better = account("xai-b");
		worse.priority = 1;
		better.priority = 0;
		const firstCatalog = [candidate("account:xai-a", worse.id, 1, 0)];
		orderer.order([worse], candidateMeta("conversation", firstCatalog));

		const catalog = [
			candidate("account:xai-b", better.id, 0, 0),
			candidate("account:xai-a", worse.id, 1, 1),
		];
		expect(
			orderer.order([better, worse], candidateMeta("conversation", catalog))[0]
				?.id,
		).toBe("xai-b");
		const equalCatalog = [
			candidate("account:xai-a", worse.id, 1, 0),
			candidate("account:xai-b", better.id, 1, 1),
		];
		expect(
			orderer.order(
				[worse, better],
				candidateMeta("conversation", equalCatalog),
			)[0]?.id,
		).toBe("xai-b");
		// The recovered better owner is now the mapping and legally snaps back
		// across a temporary fallback to the worse configured tier.
		orderer.order(
			[worse],
			candidateMeta("conversation", catalog, [catalog[1]]),
		);
		expect(
			orderer.order([better, worse], candidateMeta("conversation", catalog))[0]
				?.id,
		).toBe("xai-b");
	});

	it("never moves an owner ahead of a higher comparable pressure band", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const owner = account("xai-a");
		const urgent = account("xai-b");
		orderer.order([owner, urgent], meta("conversation"));

		const pressured = meta("conversation");
		pressured.quotaPressureByAccountId = new Map([
			[
				owner.id,
				{ band: "cold", comparisonKey: "anthropic:subscription:weekly" },
			],
			[
				urgent.id,
				{
					band: "critical",
					comparisonKey: "anthropic:subscription:weekly",
				},
			],
		]);
		expect(
			orderer
				.order([urgent, owner], pressured)
				.map((candidate) => candidate.id),
		).toEqual(["xai-b", "xai-a"]);
	});

	it("tracks repeated-account combo slots by slot identity and reorders metadata atomically", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const repeated = account("xai-a");
		const opus = candidate("slot:opus", repeated.id, 0, 0, {
			comboSlotId: "slot-opus",
			modelOverride: "claude-opus-4-8",
		});
		const fable = candidate("slot:fable", repeated.id, 0, 1, {
			comboSlotId: "slot-fable",
			modelOverride: "claude-fable-5",
		});
		orderer.order(
			[repeated, repeated],
			candidateMeta("combo-conversation", [opus, fable]),
		);

		const reversed = candidateMeta(
			"combo-conversation",
			[opus, fable],
			[fable, opus],
		);
		const ordered = orderer.order([repeated, repeated], reversed);

		expect(ordered).toHaveLength(2);
		expect(
			(
				reversed as RequestMeta & {
					routingCandidates: Array<{
						candidateId: string;
						modelOverride: string;
					}>;
				}
			).routingCandidates.map((entry) => [
				entry.candidateId,
				entry.modelOverride,
			]),
		).toEqual([
			["slot:opus", "claude-opus-4-8"],
			["slot:fable", "claude-fable-5"],
		]);
	});

	it("does nothing outside an active xAI cache-native route", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");
		const inactive = meta("conversation");
		inactive.xaiCacheNativeActive = false;

		orderer.order([a, b], inactive);
		expect(orderer.order([b, a], inactive).map((entry) => entry.id)).toEqual([
			"xai-b",
			"xai-a",
		]);
	});
});
