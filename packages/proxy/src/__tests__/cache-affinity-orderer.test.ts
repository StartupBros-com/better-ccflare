import { describe, expect, it } from "bun:test";
import type {
	Account,
	RequestMeta,
	RoutingCandidateMetadata,
} from "@better-ccflare/types";
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
		requires_reauth: false,
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

function meta(
	key: string,
	eligibleAccountIds: readonly string[] = ["xai-a", "xai-b"],
): RequestMeta {
	return {
		id: "request",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		cacheAffinityKey: key,
		xaiCacheNativeActive: true,
		xaiCacheEligibleAccountIds: new Set(eligibleAccountIds),
	};
}

function candidate(
	candidateId: string,
	accountId: string,
	tier: number,
	ordinal: number,
	options: { comboSlotId?: string; modelOverride?: string } = {},
): RoutingCandidateMetadata {
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
	catalog: RoutingCandidateMetadata[],
	current = catalog,
): RequestMeta {
	return Object.assign(
		meta(key, [...new Set(catalog.map((entry) => entry.accountId))]),
		{
			routingCandidateCatalog: catalog,
			routingCandidates: current,
		},
	);
}

describe("CacheAffinityOrderer", () => {
	it("does not create ownership during selection", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");

		expect(orderer.order([a, b], meta("conversation"))).toEqual([a, b]);
		expect(orderer.order([b, a], meta("conversation"))).toEqual([b, a]);
	});

	it("keeps a confirmed owner across changing base-strategy order", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");
		const firstMeta = meta("conversation");

		orderer.order([a, b], firstMeta);
		orderer.recordSuccess(firstMeta, "account:xai-a", a.id);

		expect(orderer.order([b, a], meta("conversation"))).toEqual([a, b]);
	});

	it("preserves ineligible provider slots", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const codex = account("codex", "codex");
		const a = account("xai-a");
		const b = account("xai-b");
		const firstMeta = meta("conversation");

		orderer.order([a, b], firstMeta);
		orderer.recordSuccess(firstMeta, "account:xai-a", a.id);

		expect(
			orderer
				.order([codex, b, a], meta("conversation"))
				.map((entry) => entry.id),
		).toEqual(["codex", "xai-a", "xai-b"]);
	});

	it("retains an absent confirmed owner only for legal better-tier snapback", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const better = account("xai-a");
		const worse = account("xai-b");
		const catalog = [
			candidate("account:xai-a", better.id, 0, 0),
			candidate("account:xai-b", worse.id, 1, 1),
		];
		const firstMeta = candidateMeta("conversation", catalog);
		orderer.recordSuccess(firstMeta, "account:xai-a", better.id);

		expect(
			orderer.order(
				[worse],
				candidateMeta("conversation", catalog, [catalog[1]]),
			),
		).toEqual([worse]);

		const recoveredMeta = candidateMeta("conversation", catalog, [
			catalog[1],
			catalog[0],
		]);
		expect(orderer.order([worse, better], recoveredMeta)).toEqual([
			better,
			worse,
		]);
	});

	it("clears an absent equal-tier owner without assigning a replacement on selection", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");
		const catalog = [
			candidate("account:xai-a", a.id, 0, 0),
			candidate("account:xai-b", b.id, 0, 1),
		];
		orderer.recordSuccess(
			candidateMeta("conversation", catalog),
			"account:xai-a",
			a.id,
		);

		const onlyB = candidateMeta("conversation", catalog, [catalog[1]]);
		expect(orderer.order([b], onlyB)).toEqual([b]);

		const both = candidateMeta("conversation", catalog, [
			catalog[1],
			catalog[0],
		]);
		expect(orderer.order([b, a], both)).toEqual([b, a]);
	});

	it("lets a better tier lead but transfers ownership only after confirmed success", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const worse = account("xai-a");
		const better = account("xai-b");
		const catalog = [
			candidate("account:xai-b", better.id, 0, 0),
			candidate("account:xai-a", worse.id, 1, 1),
		];
		const initialMeta = candidateMeta("conversation", catalog, [catalog[1]]);
		orderer.recordSuccess(initialMeta, "account:xai-a", worse.id);

		const betterFirst = candidateMeta("conversation", catalog);
		expect(orderer.order([better, worse], betterFirst)).toEqual([
			better,
			worse,
		]);

		const equalCatalog = [
			candidate("account:xai-a", worse.id, 1, 0),
			candidate("account:xai-b", better.id, 1, 1),
		];
		expect(
			orderer.order(
				[worse, better],
				candidateMeta("conversation", equalCatalog),
			),
		).toEqual([worse, better]);

		orderer.recordSuccess(betterFirst, "account:xai-b", better.id);
		expect(
			orderer.order(
				[worse, better],
				candidateMeta("conversation", equalCatalog),
			),
		).toEqual([better, worse]);
	});

	it("never moves an owner ahead of a higher comparable pressure band", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const owner = account("xai-a");
		const urgent = account("xai-b");
		const firstMeta = meta("conversation");
		orderer.recordSuccess(firstMeta, "account:xai-a", owner.id);

		const pressured = meta("conversation");
		pressured.quotaPressureByAccountId = new Map([
			[owner.id, { band: "cold", comparisonKey: "xai:subscription:weekly" }],
			[
				urgent.id,
				{ band: "critical", comparisonKey: "xai:subscription:weekly" },
			],
		]);
		expect(orderer.order([urgent, owner], pressured)).toEqual([urgent, owner]);
	});

	it("tracks repeated-account combo slots by exact candidate identity", () => {
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
		const firstMeta = candidateMeta("combo-conversation", [opus, fable]);
		orderer.recordSuccess(firstMeta, "slot:opus", repeated.id);

		const reversed = candidateMeta(
			"combo-conversation",
			[opus, fable],
			[fable, opus],
		);
		const ordered = orderer.order([repeated, repeated], reversed);

		expect(ordered).toHaveLength(2);
		expect(
			reversed.routingCandidates?.map((entry) => [
				entry.candidateId,
				entry.modelOverride,
			]),
		).toEqual([
			["slot:opus", "claude-opus-4-8"],
			["slot:fable", "claude-fable-5"],
		]);
	});

	it("honors active anti-thrash suppression without changing ownership", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const fallback = account("xai-a");
		const flapping = account("xai-b");
		const catalog = [
			candidate("account:xai-a", fallback.id, 1, 0),
			candidate("account:xai-b", flapping.id, 0, 1),
		];
		orderer.recordSuccess(
			candidateMeta("conversation", catalog),
			"account:xai-b",
			flapping.id,
		);

		const suppressedMeta = candidateMeta("conversation", catalog);
		suppressedMeta.affinityUpgradeSuppressedCandidateId = "account:xai-b";
		expect(orderer.order([fallback, flapping], suppressedMeta)).toEqual([
			fallback,
			flapping,
		]);

		expect(
			orderer.order(
				[fallback, flapping],
				candidateMeta("conversation", catalog),
			),
		).toEqual([flapping, fallback]);
	});

	it("expires confirmed ownership without refreshing TTL on reads", () => {
		const orderer = new CacheAffinityOrderer(100);
		const a = account("xai-a");
		const b = account("xai-b");
		const realDateNow = Date.now;
		const startedAt = realDateNow();

		try {
			Date.now = () => startedAt;
			orderer.recordSuccess(meta("conversation"), "account:xai-a", a.id);
			Date.now = () => startedAt + 50;
			expect(orderer.order([b, a], meta("conversation"))).toEqual([a, b]);
			Date.now = () => startedAt + 101;
			expect(orderer.order([b, a], meta("conversation"))).toEqual([b, a]);
		} finally {
			Date.now = realDateNow;
		}
	});

	it("evicts the oldest confirmed owner when capacity is full", () => {
		const orderer = new CacheAffinityOrderer(60_000, 2);
		orderer.recordSuccess(meta("first"), "account:xai-a", "xai-a");
		orderer.recordSuccess(meta("second"), "account:xai-b", "xai-b");
		orderer.recordSuccess(meta("third"), "account:xai-a", "xai-a");

		const a = account("xai-a");
		const b = account("xai-b");
		expect(orderer.order([b, a], meta("first"))).toEqual([b, a]);
		expect(orderer.order([a, b], meta("second"))).toEqual([b, a]);
	});

	it("does nothing outside an active xAI cache-native route", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");
		const inactive = meta("conversation");
		inactive.xaiCacheNativeActive = false;

		orderer.recordSuccess(inactive, "account:xai-a", a.id);
		expect(orderer.order([b, a], inactive)).toEqual([b, a]);
	});
});
