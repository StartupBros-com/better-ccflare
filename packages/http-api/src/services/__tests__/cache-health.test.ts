import { describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type {
	CacheHealthBucket,
	CacheHealthState,
} from "@better-ccflare/types";
import {
	cacheHealthScopeKey,
	isNativeCacheHealthRoute,
} from "@better-ccflare/types";
import {
	advanceCacheHealth,
	aggregateProviderCacheBuckets,
	CACHE_HEALTH_DEFAULT_POLICY,
	cacheHealthQueryWindow,
	createCacheHealthState,
	isRedundantProviderCacheAlert,
} from "../cache-health";

const STEP = 600_000;
const BASE = 1_800_000_000_000;
const policy = CACHE_HEALTH_DEFAULT_POLICY;

function bucket(
	index: number,
	rate = 89,
	changes: Partial<CacheHealthBucket> = {},
): CacheHealthBucket {
	return {
		scope: {
			kind: "account",
			provider: "codex",
			model: "gpt-test",
			accountId: "a",
			accountGeneration: 1,
		},
		startMs: BASE + index * STEP,
		endMs: BASE + (index + 1) * STEP,
		contributors: [{ accountId: "a", accountGeneration: 1 }],
		native: true,
		eligible: 10,
		measured: 10,
		missing: 0,
		invalid: 0,
		zeroInput: 0,
		failed: 0,
		internal: 0,
		zeroHit: rate === 0 ? 10 : 0,
		inputTokens: 100_000 - rate * 1000,
		cacheReadTokens: rate * 1000,
		cacheWriteTokens: 0,
		totalsValid: true,
		...changes,
	};
}

function run(buckets: CacheHealthBucket[], initial?: CacheHealthState) {
	let state = initial ?? createCacheHealthState(buckets[0].scope);
	const alerts = [];
	for (const b of buckets) {
		const result = advanceCacheHealth(state, b, policy, b.endMs + 120_000);
		state = result.state;
		alerts.push(...result.alerts);
	}
	return { state, alerts };
}

describe("cache health policy", () => {
	it("uses collision-safe identities and recognizes native routes without pricing", () => {
		const scope = bucket(0).scope;
		expect(
			cacheHealthScopeKey({ ...scope, provider: "a:b", model: "c" }),
		).not.toBe(cacheHealthScopeKey({ ...scope, provider: "a", model: "b:c" }));
		for (const provider of ["anthropic", "codex"])
			expect(isNativeCacheHealthRoute(provider, false)).toBe(true);
		expect(isNativeCacheHealthRoute("xai", true)).toBe(true);
		expect(isNativeCacheHealthRoute("xai", false)).toBe(false);
		expect(isNativeCacheHealthRoute("openai-compatible", true)).toBe(false);
	});

	it("opens once after three distinct qualified buckets, using unrounded reuse", () => {
		expect(run([bucket(0, 90), bucket(1, 90), bucket(2, 90)]).alerts).toEqual(
			[],
		);
		const result = run([
			bucket(0, 89.999),
			bucket(1, 89.999),
			bucket(2, 89.999),
		]);
		expect(result.alerts.map((a) => a.type)).toEqual(["cache_efficiency_low"]);
		expect(result.alerts[0].evidence).toMatchObject({
			startMs: BASE,
			endMs: BASE + 3 * STEP,
			measured: 30,
			eligible: 30,
		});
		expect(result.alerts[0].reusePercent).toBeCloseTo(89.999);
		expect(advanceCacheHealth(result.state, bucket(2), policy).alerts).toEqual(
			[],
		);
	});

	it("idle gaps, low traffic, missing coverage and unsafe totals break only incomplete streaks", () => {
		for (const middle of [
			bucket(1, 0, { measured: 9 }),
			bucket(1, 0, { inputTokens: 99_999 }),
			bucket(1, 0, { eligible: 12 }),
			bucket(1, 0, { totalsValid: false }),
		]) {
			expect(run([bucket(0), middle, bucket(2), bucket(3)]).alerts).toEqual([]);
		}
		expect(run([bucket(0), bucket(2), bucket(3)]).alerts).toEqual([]);
		const opened = run([bucket(0), bucket(1), bucket(2)]);
		const idle = run(
			[bucket(9, 0, { eligible: 0, measured: 0 })],
			opened.state,
		);
		expect(idle.state.reuse.incident?.severity).toBe("warning");
		expect(idle.alerts).toEqual([]);
	});

	it("requires two earlier qualified healthy buckets within 24h for a critical collapse", () => {
		expect(run([bucket(0, 0)]).alerts).toEqual([]);
		expect(run([bucket(0, 92), bucket(1, 92), bucket(2, 50)]).alerts).toEqual(
			[],
		);
		expect(
			run([bucket(0, 92), bucket(1, 92), bucket(2, 49)]).alerts[0].type,
		).toBe("cache_efficiency_critical");
		expect(run([bucket(0, 92), bucket(1, 92), bucket(147, 0)]).alerts).toEqual(
			[],
		);
		expect(
			run([bucket(0, 92, { measured: 9 }), bucket(1, 92), bucket(2, 0)]).alerts,
		).toEqual([]);
	});

	it("escalates once, reminds only after six elapsed hours with new bad evidence, and recovers with hysteresis", () => {
		const opened = run([
			bucket(0, 95),
			bucket(1, 95),
			bucket(2),
			bucket(3),
			bucket(4),
			bucket(5, 40),
			bucket(6, 40),
		]);
		expect(opened.alerts.map((a) => a.phase)).toEqual(["opened", "escalated"]);
		expect(run([bucket(40, 40)], opened.state).alerts).toEqual([]);
		const reminded = run([bucket(41, 40)], opened.state);
		expect(reminded.alerts[0].phase).toBe("reminder");
		const recovered = run(
			[bucket(42, 92), bucket(43, 91), bucket(44, 92), bucket(45, 92)],
			reminded.state,
		);
		expect(recovered.alerts.map((a) => a.type)).toEqual([
			"cache_efficiency_recovered",
		]);
		expect(recovered.state.reuse.incident).toBeNull();
		expect(
			run([bucket(46), bucket(47), bucket(48)], recovered.state).alerts[0]
				.sequence,
		).toBe(2);
	});

	it("keeps telemetry and reuse incidents independent, including completely missing usage", () => {
		const missing = (i: number) =>
			bucket(i, 0, { measured: 0, missing: 10, inputTokens: 0 });
		expect(run([missing(0), missing(1), missing(2)]).alerts).toEqual([]);
		const opened = run([bucket(0, 95), missing(1), missing(2), missing(3)]);
		expect(opened.alerts.map((a) => a.type)).toEqual(["cache_telemetry_gap"]);
		expect(opened.alerts[0].coveragePercent).toBe(0);
		const both = run([bucket(4, 0), bucket(5, 0), bucket(6, 0)], opened.state);
		expect(both.alerts.map((a) => a.type)).toEqual([
			"cache_efficiency_recovered",
			"cache_efficiency_low",
		]);
		expect(both.state.reuse.incident).not.toBeNull();
		const small = run(
			[
				bucket(4, 95, { inputTokens: 1, cacheReadTokens: 9 }),
				bucket(5, 95, { inputTokens: 1, cacheReadTokens: 9 }),
			],
			opened.state,
		);
		expect(small.alerts[0].reason).toBe("telemetry");
	});

	it("pins telemetry boundaries, eligible sample floor, and reporting baseline", () => {
		const gap = (i: number, measured: number) =>
			bucket(i, 0, { eligible: 10, measured, missing: 10 - measured });
		expect(
			run([bucket(0, 95), gap(1, 8), gap(2, 8), gap(3, 8)]).alerts.some(
				(a) => a.reason === "telemetry",
			),
		).toBe(false);
		expect(
			run([bucket(0, 95), gap(1, 7), gap(2, 7), gap(3, 7)]).state.telemetry
				.incident,
		).not.toBeNull();
		expect(
			run([
				bucket(0, 95),
				gap(1, 7),
				gap(2, 7),
				bucket(3, 0, { eligible: 9, measured: 0 }),
				gap(4, 7),
			]).alerts,
		).toEqual([]);
	});

	it("configuration changes and account generations cannot stitch streaks", () => {
		const partial = run([bucket(0), bucket(1)]).state;
		expect(
			advanceCacheHealth(partial, bucket(2), {
				...policy,
				warningPercent: 89.5,
			}).alerts,
		).toEqual([]);
		expect(() =>
			advanceCacheHealth(
				partial,
				bucket(2, 0, { scope: { ...partial.scope, accountGeneration: 2 } }),
				policy,
			),
		).toThrow();
		const restored = JSON.parse(JSON.stringify(partial)) as CacheHealthState;
		expect(run([bucket(2)], restored).alerts[0].type).toBe(
			"cache_efficiency_low",
		);
	});

	it("enrolls unknown routes only after positive cache evidence and persists enrollment through zeros", () => {
		const unknown = (i: number, rate: number) =>
			bucket(i, rate, { native: false });
		expect(run([unknown(0, 0), unknown(1, 0), unknown(2, 0)]).alerts).toEqual(
			[],
		);
		expect(
			run([unknown(0, 1), unknown(1, 0), unknown(2, 0)]).alerts[0].type,
		).toBe("cache_efficiency_low");
		expect(
			run([bucket(0, 0), unknown(1, 0), unknown(2, 0), unknown(3, 0)]).alerts,
		).toEqual([]);
	});

	it("aggregates providers before sample floors and suppresses only exactly covered single-account evidence", () => {
		const a = bucket(0, 80, {
			eligible: 5,
			measured: 5,
			inputTokens: 10_000,
			cacheReadTokens: 40_000,
		});
		const b = {
			...a,
			scope: { ...a.scope, accountId: "b" },
			contributors: [{ accountId: "b", accountGeneration: 1 }],
		};
		const providers = aggregateProviderCacheBuckets([a, b]);
		expect(providers[0]).toMatchObject({
			measured: 10,
			inputTokens: 20_000,
			cacheReadTokens: 80_000,
		});
		const providerAlert = run(
			[0, 1, 2].map((i) => ({
				...providers[0],
				startMs: BASE + i * STEP,
				endMs: BASE + (i + 1) * STEP,
			})),
		).alerts[0];
		const accountAlert = run([bucket(0), bucket(1), bucket(2)]).alerts[0];
		expect(isRedundantProviderCacheAlert(providerAlert, [accountAlert])).toBe(
			false,
		);
		const single = run(
			[0, 1, 2].map((i) => aggregateProviderCacheBuckets([bucket(i)])[0]),
		).alerts[0];
		expect(isRedundantProviderCacheAlert(single, [accountAlert])).toBe(true);
		expect(
			isRedundantProviderCacheAlert(
				single,
				[],
				[run([bucket(0), bucket(1), bucket(2)]).state],
			),
		).toBe(true);
	});

	it("weights provider tokens and carries new enrollment forward through zero-hit buckets", () => {
		const unknown = [
			bucket(0, 95, { native: false }),
			bucket(1, 0, { native: false }),
		];
		expect(aggregateProviderCacheBuckets(unknown)).toHaveLength(2);
		const small = bucket(0, 0, { inputTokens: 10_000, cacheReadTokens: 0 });
		const large = bucket(0, 100, {
			inputTokens: 0,
			cacheReadTokens: 990_000,
			scope: { ...small.scope, accountId: "b" },
			contributors: [{ accountId: "b", accountGeneration: 1 }],
		});
		const weighted = aggregateProviderCacheBuckets([small, large])[0];
		expect(
			run(
				[0, 1, 2].map((i) => ({
					...weighted,
					startMs: BASE + i * STEP,
					endMs: BASE + (i + 1) * STEP,
				})),
			).alerts,
		).toEqual([]);
	});

	it("fences every generation contributing to a provider evidence window", () => {
		const buckets = [0, 1, 2].map(
			(i) =>
				aggregateProviderCacheBuckets([
					bucket(i, 89, {
						scope: { ...bucket(i).scope, accountId: `account-${i}` },
						contributors: [{ accountId: `account-${i}`, accountGeneration: 1 }],
					}),
				])[0],
		);
		const result = run(buckets);
		expect(result.alerts[0].evidence.contributors).toHaveLength(3);
		expect(result.state.contributors).toHaveLength(3);
	});

	it("does not count excluded-only accounts as additional provider traffic", () => {
		const excluded = bucket(0, 0, {
			eligible: 0,
			measured: 0,
			internal: 10,
			inputTokens: 0,
			scope: { ...bucket(0).scope, accountId: "synthetic" },
			contributors: [{ accountId: "synthetic", accountGeneration: 1 }],
		});
		const [provider] = aggregateProviderCacheBuckets([bucket(0), excluded]);
		expect(provider).toMatchObject({ eligible: 10, internal: 10 });
		expect(provider.contributors).toEqual([
			{ accountId: "a", accountGeneration: 1 },
		]);
		expect(aggregateProviderCacheBuckets([excluded])).toEqual([]);
	});

	it("limits startup to three settled buckets and rejects unsettled or stale replay", () => {
		expect(cacheHealthQueryWindow(BASE + 7 * STEP + 119_999)).toEqual({
			startMs: BASE + 3 * STEP,
			endMs: BASE + 6 * STEP,
		});
		expect(cacheHealthQueryWindow(BASE + 7 * STEP + 120_000)).toEqual({
			startMs: BASE + 4 * STEP,
			endMs: BASE + 7 * STEP,
		});
		const s = createCacheHealthState(bucket(0).scope);
		expect(advanceCacheHealth(s, bucket(0), policy, BASE + STEP).state).toEqual(
			s,
		);
		expect(
			advanceCacheHealth(s, bucket(0), policy, BASE + 100 * STEP).state,
		).toEqual(s);
	});
});
