import { afterEach, describe, expect, it } from "bun:test";
import {
	getCodexSubscriptionFacts,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { mapWhamUsageResponse } from "../../../../providers/src/providers/codex/api-usage";
import type { ProxyContext } from "../proxy-types";
import { processProxyResponse } from "../response-processor";
import { evaluateAutoCapacity } from "../usage-throttling";

const originalFetch = globalThis.fetch;
const accountId = "codex-subscription-proof-test";
const token = "fake-subscription-token";
const now = Date.now();
function payload() {
	return {
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: null as unknown,
			secondary_window: {
				used_percent: 55,
				reset_at: Math.floor(now / 1000) + 3600,
			},
		},
		credits: { has_credits: false, unlimited: false, balance: "0" } as Record<
			string,
			unknown
		>,
	};
}
async function poll(body: unknown) {
	globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
	await new Promise<void>((resolve) => {
		usageCache.startPolling(
			accountId,
			token,
			"codex",
			60_000,
			undefined,
			undefined,
			undefined,
			() => resolve(),
		);
	});
	const snapshot = usageCache.getSnapshot(accountId);
	if (!snapshot) throw new Error("poll did not publish a snapshot");
	return snapshot;
}
function weeklyHeaders() {
	return new Headers({
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-used-percent": "55",
		"x-codex-secondary-reset-at": String(
			payload().rate_limit.secondary_window.reset_at,
		),
	});
}
async function processLiveHeaders(headers: Headers) {
	const account = {
		id: accountId,
		name: "synthetic-codex-account",
		provider: "codex",
		access_token: token,
		rate_limited_until: null,
		rate_limited_at: null,
	} as Account;
	const ctx = {
		provider: {
			name: "codex",
			parseRateLimit: () => ({ isRateLimited: false }),
		},
		config: { getCodexFiveHourWindowEnabled: () => false },
		// Persistence jobs are outside this seam. Cache ingestion happens in
		// the real response processor, synchronously before these queued jobs.
		asyncWriter: { enqueue: () => {} },
		dbOps: { resetAccountSession: async () => {} },
	} as unknown as ProxyContext;
	expect(
		await processProxyResponse(new Response(null, { headers }), account, ctx),
	).toBe(false);
	const snapshot = usageCache.getSnapshot(accountId);
	if (!snapshot) throw new Error("response headers did not publish a snapshot");
	return snapshot;
}
function decision(
	snapshot: ReturnType<typeof usageCache.getSnapshot>,
	overrides = {},
) {
	return evaluateAutoCapacity(snapshot?.data, {
		accountId,
		provider: "codex",
		line: "gpt-astra",
		requestModel: "gpt-6-astra",
		observedAt: snapshot?.observedAt ?? 0,
		spendGrants: [],
		...overrides,
	} as Parameters<typeof evaluateAutoCapacity>[1]);
}
afterEach(() => {
	usageCache.stopPolling(accountId);
	usageCache.delete(accountId);
	globalThis.fetch = originalFetch;
});
describe("Codex subscription-only source evidence (fake metadata transport)", () => {
	it("admits explicit zero credits and a live weekly window without a grant", async () => {
		const snapshot = await poll(payload());
		expect(decision(snapshot)).toEqual({ status: "admit" });
		const facts = getCodexSubscriptionFacts(
			snapshot.data,
			accountId,
			Date.now(),
			180_000,
			token,
		);
		expect(facts).toMatchObject({
			allowed: true,
			limitReached: false,
			hasCredits: false,
			unlimited: false,
			balance: 0,
			primary: { presence: "null" },
			secondary: { presence: "window", utilization: 55 },
		});
		expect(Object.isFrozen(facts)).toBe(true);
		expect(Object.isFrozen(facts?.secondary)).toBe(true);
		const json = JSON.stringify(snapshot);
		expect(json).not.toContain(token);
		expect(json).not.toContain("fingerprint");
		expect(json).not.toContain("isCurrent");
	});
	it("retains subscription admission after identical live weekly-only response headers", async () => {
		const owned = await poll(payload());
		expect(decision(owned)).toEqual({ status: "admit" });

		const current = await processLiveHeaders(weeklyHeaders());
		expect(current.data).not.toBe(owned.data);
		expect(current.data.seven_day).toEqual({
			utilization: 55,
			resets_at: new Date(
				payload().rate_limit.secondary_window.reset_at * 1000,
			).toISOString(),
		});
		// Retention must not grant raw ownership to a replaced or passive object.
		expect(
			getCodexSubscriptionFacts(
				owned.data,
				accountId,
				Date.now(),
				180_000,
				token,
			),
		).toBeNull();
		expect(
			getCodexSubscriptionFacts(
				current.data,
				accountId,
				Date.now(),
				180_000,
				token,
			),
		).toBeNull();
		expect(decision(current)).toEqual({ status: "admit" });
	});
	it("live headers preserve all four polling-only display extras without exporting authority", async () => {
		const owned = await poll({
			...payload(),
			plan_type: "pro",
			code_review_rate_limit: {
				primary_window: {
					used_percent: 7,
					reset_at: payload().rate_limit.secondary_window.reset_at,
				},
			},
		});
		const current = await processLiveHeaders(weeklyHeaders());
		for (const key of [
			"plan_type",
			"credits_balance",
			"code_review_used_percent",
			"code_review_resets_at",
		] as const) {
			expect(owned.data[key]).toBeDefined();
			expect(current.data[key]).toEqual(owned.data[key]);
		}
		expect(current.data.codex_subscription).toBeUndefined();
		expect(decision(current).status).toBe("admit");
	});
	it("passive timestamps never renew the original 179999/180000ms boundary", async () => {
		const realNow = Date.now;
		let clock = now;
		Date.now = () => clock;
		try {
			await poll(payload());
			clock += 179_999;
			const fresh = await processLiveHeaders(weeklyHeaders());
			expect(decision(fresh).status).toBe("admit");
			clock += 1;
			const expired = await processLiveHeaders(weeklyHeaders());
			expect(expired.observedAt).toBe(clock);
			expect(decision(expired).status).not.toBe("admit");
		} finally {
			Date.now = realNow;
		}
	});
	it("later passive resets cannot extend the original poll window", async () => {
		const realNow = Date.now;
		let clock = now;
		Date.now = () => clock;
		try {
			const body = payload();
			body.rate_limit.secondary_window.reset_at = Math.floor(now / 1000) + 30;
			await poll(body);
			clock += 31_000;
			expect(
				decision(await processLiveHeaders(weeklyHeaders())).status,
			).not.toBe("admit");
		} finally {
			Date.now = realNow;
		}
	});
	it.each([
		"exhausted",
		"malformed",
		"unsupported",
		"new-five-hour",
	])("%s passive contradiction stays revoked until another poll", async (kind) => {
		await poll(payload());
		const headers = weeklyHeaders();
		if (kind === "exhausted" || kind === "malformed") {
			headers.set(
				"x-codex-secondary-used-percent",
				kind === "exhausted" ? "100" : "garbage",
			);
		} else {
			headers.set(
				"x-codex-primary-window-minutes",
				kind === "unsupported" ? "1440" : "300",
			);
			headers.set("x-codex-primary-used-percent", "100");
			headers.set(
				"x-codex-primary-reset-at",
				String(payload().rate_limit.secondary_window.reset_at),
			);
		}
		expect(decision(await processLiveHeaders(headers)).status).not.toBe(
			"admit",
		);
		expect(decision(await processLiveHeaders(weeklyHeaders())).status).not.toBe(
			"admit",
		);
		expect(await usageCache.refreshNow(accountId)).toBe(true);
		expect(decision(await processLiveHeaders(weeklyHeaders())).status).toBe(
			"admit",
		);
	});
	it("an out-of-range passive reset cannot recover through benign headers", async () => {
		await poll(payload());
		const headers = weeklyHeaders();
		headers.set("x-codex-secondary-reset-at", "1e100");
		expect(decision(await processLiveHeaders(headers)).status).not.toBe(
			"admit",
		);
		expect(decision(await processLiveHeaders(weeklyHeaders())).status).not.toBe(
			"admit",
		);
	});
	it("retained evidence binds account and actual token but selection may omit it", async () => {
		const owned = await poll(payload());
		const current = await processLiveHeaders(weeklyHeaders());
		expect(decision(current).status).toBe("admit");
		expect(decision(current, { accessToken: token }).status).toBe("admit");
		for (const accessToken of [null, "", "wrong"]) {
			expect(decision(current, { accessToken }).status).not.toBe("admit");
		}
		expect(decision(current, { accountId: "wrong" }).status).not.toBe("admit");
		expect(decision(owned).status).not.toBe("admit");
		expect(
			decision({ ...current, data: structuredClone(current.data) }).status,
		).not.toBe("admit");
		const evidence = usageCache.getCodexAdmissionEvidence(
			accountId,
			current.data,
			Date.now(),
			180_000,
			token,
		);
		expect(Object.isFrozen(evidence?.data)).toBe(true);
		expect(Object.isFrozen(evidence?.facts.secondary)).toBe(true);
		expect(JSON.stringify(evidence)).not.toContain(token);
		expect(JSON.stringify(evidence)).not.toContain("fingerprint");
	});
	it.each([
		"clone",
		"original",
		"delete",
		"clear",
		"stop",
		"restart",
		"expiry",
	])("%s revokes retained passive authority", async (kind) => {
		const owned = await poll(payload());
		const current = await processLiveHeaders(weeklyHeaders());
		expect(decision(current).status).toBe("admit");
		if (kind === "clone")
			usageCache.set(accountId, structuredClone(current.data));
		if (kind === "original") usageCache.set(accountId, owned.data);
		if (kind === "delete") usageCache.delete(accountId);
		if (kind === "clear") usageCache.clear();
		if (kind === "stop") usageCache.stopPolling(accountId);
		if (kind === "expiry") usageCache.cleanupStaleEntries(-1);
		if (kind === "restart") {
			usageCache.startPolling(accountId, "new-token", "codex", 60_000);
			await usageCache.refreshNow(accountId);
			expect(
				decision(usageCache.getSnapshot(accountId), { accessToken: token })
					.status,
			).not.toBe("admit");
		}
		expect(decision(current).status).not.toBe("admit");
		if (kind !== "restart")
			expect(
				decision(await processLiveHeaders(weeklyHeaders())).status,
			).not.toBe("admit");
	});
	it("a live passive update fences late refresh publication and callbacks", async () => {
		let snapshots = 0;
		let resets = 0;
		let restored = 0;
		globalThis.fetch = (async () => Response.json(payload())) as typeof fetch;
		usageCache.startPolling(
			accountId,
			token,
			"codex",
			60_000,
			undefined,
			() => resets++,
			() => restored++,
			() => snapshots++,
		);
		expect(await usageCache.refreshNow(accountId)).toBe(true);
		expect(snapshots).toBe(1);
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		globalThis.fetch = (async () => {
			started.resolve();
			return response.promise;
		}) as typeof fetch;
		const pending = usageCache.refreshNow(accountId);
		await started.promise;
		const current = await processLiveHeaders(weeklyHeaders());
		response.resolve(
			Response.json({
				...payload(),
				credits: { has_credits: true, unlimited: false, balance: 50 },
			}),
		);
		expect(await pending).toBe(false);
		expect(snapshots).toBe(1);
		expect(resets).toBe(0);
		expect(restored).toBe(0);
		expect(usageCache.getSnapshot(accountId)?.data).toBe(current.data);
		expect(decision(current, { accessToken: token }).status).toBe("admit");
	});
	it("unsupported-only headers revoke proof even when display parsing returns null", async () => {
		await poll(payload());
		await processLiveHeaders(
			new Headers({
				"x-codex-primary-window-minutes": "1440",
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-reset-at": String(
					payload().rate_limit.secondary_window.reset_at,
				),
			}),
		);
		expect(decision(usageCache.getSnapshot(accountId)).status).not.toBe(
			"admit",
		);
		expect(decision(await processLiveHeaders(weeklyHeaders())).status).not.toBe(
			"admit",
		);
	});
	it("live passive headers alone cannot mint subscription ownership", async () => {
		globalThis.fetch = (async () => {
			throw new Error("passive response processing must not fetch metadata");
		}) as typeof fetch;
		expect(usageCache.getSnapshot(accountId)).toBeNull();
		const current = await processLiveHeaders(weeklyHeaders());
		expect(current.data.seven_day?.utilization).toBe(55);
		expect(
			getCodexSubscriptionFacts(
				current.data,
				accountId,
				Date.now(),
				180_000,
				token,
			),
		).toBeNull();
		expect(decision(current).status).not.toBe("admit");
	});
	it.each([
		"malformed weekly percentage",
		"unsupported exhausted daily window",
		"newly explicit exhausted five-hour window",
	])("live headers with %s cannot benefit from retained proof", async (kind) => {
		const owned = await poll(payload());
		expect(decision(owned)).toEqual({ status: "admit" });
		const headers = weeklyHeaders();
		if (kind === "malformed weekly percentage") {
			headers.set("x-codex-secondary-used-percent", "garbage");
		} else {
			headers.set(
				"x-codex-primary-window-minutes",
				kind === "unsupported exhausted daily window" ? "1440" : "300",
			);
			headers.set("x-codex-primary-used-percent", "100");
			headers.set(
				"x-codex-primary-reset-at",
				String(payload().rate_limit.secondary_window.reset_at),
			);
		}
		const current = await processLiveHeaders(headers);
		expect(current.data).not.toBe(owned.data);
		expect(decision(current).status).not.toBe("admit");
	});
	it("decoding and manually caching real-shaped JSON cannot mint source proof", () => {
		const body = payload();
		const data = mapWhamUsageResponse({
			...body,
			rate_limit: { ...body.rate_limit, primary_window: null },
		});
		if (!data) throw new Error("expected display data");
		usageCache.set(accountId, data);
		expect(decision(usageCache.getSnapshot(accountId)).status).not.toBe(
			"admit",
		);
	});
	it("explicitly null quota windows still require at least one live window", async () => {
		const body = payload();
		Object.assign(body.rate_limit, { secondary_window: null });
		expect(decision(await poll(body)).status).not.toBe("admit");
	});
	it.each([
		{ has_credits: true, unlimited: false, balance: 0 },
		{ has_credits: false, unlimited: true, balance: 0 },
		{ has_credits: false, unlimited: false, balance: 1 },
		{ has_credits: false, unlimited: false, balance: null },
		{ has_credits: false, unlimited: false },
		{ balance: 0 },
		{ has_credits: false, unlimited: false, balance: "bad" },
	])("blocks unavailable or contradictory billing facts %j", async (credits) => {
		const body = payload();
		body.credits = credits;
		expect(decision(await poll(body)).status).not.toBe("admit");
	});
	it.each([
		undefined,
		{},
		{ used_percent: 0, reset_at: null },
		{ used_percent: null, reset_at: Math.floor(now / 1000) + 3600 },
	])("does not omit non-null primary %j", async (primary) => {
		const body = payload();
		body.rate_limit.primary_window = primary;
		expect(decision(await poll(body)).status).not.toBe("admit");
	});
	it.each([
		false,
		null,
		undefined,
	])("requires positively allowed %j", async (allowed) => {
		const body = payload();
		Object.assign(body.rate_limit, { allowed });
		expect(decision(await poll(body)).status).not.toBe("admit");
	});
	it("does not discard additional limits", async () => {
		expect(
			decision(
				await poll({
					...payload(),
					additional_rate_limits: [{ limit_reached: true }],
				}),
			).status,
		).not.toBe("admit");
	});
	const roomy = () => ({
		limit_name: "codex_other",
		metered_feature: "codex_other",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 88, limit_window_seconds: 1800 },
		},
	});
	it.each([
		["null", null],
		["an empty array", []],
		["one entry with room", [roomy()]],
		[
			"entries with null windows",
			[
				{
					...roomy(),
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: null,
					},
				},
			],
		],
	])("additional limits %s do not veto Auto capacity", async (_n, value) => {
		expect(
			decision(await poll({ ...payload(), additional_rate_limits: value }))
				.status,
		).toBe("admit");
	});
	it.each([
		[
			"limit_reached true",
			[{ ...roomy(), rate_limit: { allowed: true, limit_reached: true } }],
		],
		[
			"allowed false",
			[{ ...roomy(), rate_limit: { allowed: false, limit_reached: false } }],
		],
		["rate_limit null", [{ ...roomy(), rate_limit: null }]],
		["rate_limit absent", [{ limit_name: "x", metered_feature: "x" }]],
		[
			"window at 100",
			[
				{
					...roomy(),
					rate_limit: {
						allowed: true,
						limit_reached: false,
						secondary_window: { used_percent: 100 },
					},
				},
			],
		],
		["limit_reached absent", [{ ...roomy(), rate_limit: { allowed: true } }]],
		[
			"a negative used_percent",
			[
				{
					...roomy(),
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: -1 },
					},
				},
			],
		],
		[
			"a string used_percent",
			[
				{
					...roomy(),
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: "50" },
					},
				},
			],
		],
		[
			"a non-object window",
			[
				{
					...roomy(),
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: "x",
					},
				},
			],
		],
		["a non-string limit_name", [{ ...roomy(), limit_name: 5 }]],
		[
			"metered_feature absent",
			[{ limit_name: "codex_other", rate_limit: roomy().rate_limit }],
		],
		["malformed entry {}", [{}]],
		["one roomy and one malformed entry", [roomy(), {}]],
		["a non-array object", { limit_reached: false }],
		["a string", "none"],
	])("additional limits %s stay unknown", async (_n, value) => {
		expect(
			decision(await poll({ ...payload(), additional_rate_limits: value }))
				.status,
		).not.toBe("admit");
	});
	it("does not admit expired windows", async () => {
		const body = payload();
		body.rate_limit.secondary_window.reset_at = 1;
		expect(decision(await poll(body)).status).not.toBe("admit");
	});
	it("rejects copied JSON and the wrong account or actual token", async () => {
		const snapshot = await poll(payload());
		expect(decision(snapshot).status).toBe("admit");
		expect(
			decision({ ...snapshot, data: structuredClone(snapshot.data) }).status,
		).not.toBe("admit");
		expect(decision(snapshot, { accountId: "wrong" }).status).not.toBe("admit");
		expect(decision(snapshot, { accessToken: "wrong" }).status).not.toBe(
			"admit",
		);
		expect(decision(snapshot, { accessToken: token }).status).toBe("admit");
	});
	it("does not renew proof through passive replacement or replay", async () => {
		const snapshot = await poll(payload());
		usageCache.set(accountId, structuredClone(snapshot.data));
		expect(decision(usageCache.getSnapshot(accountId)).status).not.toBe(
			"admit",
		);
		usageCache.set(accountId, snapshot.data);
		expect(decision(usageCache.getSnapshot(accountId)).status).not.toBe(
			"admit",
		);
	});
	it("revokes captured proof on teardown and recreation", async () => {
		const old = await poll(payload());
		usageCache.stopPolling(accountId);
		expect(decision(old).status).not.toBe("admit");
		await poll(payload());
		expect(decision(old).status).not.toBe("admit");
	});
	it("keeps a late fetch loser from issuing replacement registration proof", async () => {
		let finish!: (value: Response) => void;
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})) as typeof fetch;
		usageCache.startPolling(accountId, "old-token", "codex", 60_000);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(typeof finish).toBe("function");
		usageCache.stopPolling(accountId);
		const current = await poll(payload());
		finish(Response.json(payload()));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(usageCache.getSnapshot(accountId)?.data).toBe(current.data);
		expect(decision(current, { accessToken: token }).status).toBe("admit");
		expect(decision(current, { accessToken: "old-token" }).status).not.toBe(
			"admit",
		);
	});
	it.each([
		"header",
		"delete",
		"cleanup",
		"get",
		"getAge",
		"token",
	])("discards a delayed poll superseded by %s and allows a later poll", async (intervention) => {
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		const credential = Promise.withResolvers<string>();
		const writeDuringAcquisition =
			intervention === "header" || intervention === "token";
		const exhaustedData = {
			seven_day: {
				utilization: 100,
				resets_at: new Date(now + 600_000).toISOString(),
			},
		};
		// Deletion/expiry must be the only invalidation while the poll is pending.
		if (!writeDuringAcquisition) usageCache.set(accountId, exhaustedData);
		let resets = 0;
		let restored = 0;
		let snapshots = 0;
		globalThis.fetch = (async () => {
			started.resolve();
			return response.promise;
		}) as typeof fetch;
		usageCache.startPolling(
			accountId,
			intervention === "token" ? () => credential.promise : token,
			"codex",
			60_000,
			undefined,
			() => resets++,
			() => restored++,
			() => snapshots++,
		);
		const pending = usageCache.refreshNow(accountId);
		if (intervention !== "token") await started.promise;
		// A newer exhausted header must remain authoritative even though the
		// older metadata reply advertises a later reset and spare capacity.
		if (writeDuringAcquisition) usageCache.set(accountId, exhaustedData);
		const newer = usageCache.getSnapshot(accountId);
		expect(decision(newer, { accessToken: token }).status).toBe("reject");
		if (intervention === "delete") usageCache.delete(accountId);
		if (intervention === "cleanup") usageCache.cleanupStaleEntries(-1);
		if (intervention === "get" || intervention === "getAge") {
			const realNow = Date.now;
			try {
				Date.now = () => realNow() + 24 * 3600_000;
				usageCache[intervention](accountId);
			} finally {
				Date.now = realNow;
			}
		}
		credential.resolve(token);
		response.resolve(Response.json(payload()));
		await pending;
		expect(
			decision(usageCache.getSnapshot(accountId), { accessToken: token })
				.status,
		).not.toBe("admit");
		expect(snapshots).toBe(0);
		expect(resets).toBe(0);
		expect(restored).toBe(0);
		if (intervention === "header" || intervention === "token") {
			expect(usageCache.getSnapshot(accountId)?.data).toBe(newer?.data);
		} else {
			expect(usageCache.getSnapshot(accountId)).toBeNull();
		}
		// A new acquisition after the intervening write can recover normally.
		globalThis.fetch = (async () => Response.json(payload())) as typeof fetch;
		expect(await usageCache.refreshNow(accountId)).toBe(true);
		const recovered = usageCache.getSnapshot(accountId);
		expect(decision(recovered, { accessToken: token }).status).toBe("admit");
		expect(decision(recovered, { accessToken: "wrong" }).status).not.toBe(
			"admit",
		);
		expect(snapshots).toBe(1);
	});
	it("a successful metadata response with no windows revokes earlier headroom", async () => {
		const earlier = await poll(payload());
		expect(decision(earlier).status).toBe("admit");
		globalThis.fetch = (async () =>
			Response.json({
				rate_limit: {
					allowed: false,
					limit_reached: true,
					primary_window: null,
					secondary_window: null,
				},
				credits: payload().credits,
			})) as typeof fetch;
		expect(await usageCache.refreshNow(accountId)).toBe(true);
		const exhausted = usageCache.getSnapshot(accountId);
		expect(exhausted?.data).not.toBe(earlier.data);
		expect(exhausted?.data.codex_subscription).toMatchObject({
			allowed: false,
			limitReached: true,
		});
		expect(decision(exhausted).status).not.toBe("admit");
		expect(decision(earlier).status).not.toBe("admit");
	});
	it("an out-of-range reset must not retain a previous admissible observation", async () => {
		await poll(payload());
		const body = payload();
		body.rate_limit.secondary_window.reset_at = 1e100;
		globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
		await usageCache.refreshNow(accountId);
		expect(decision(usageCache.getSnapshot(accountId)).status).not.toBe(
			"admit",
		);
	});
	it("cache deletion revokes even a retained snapshot", async () => {
		const snapshot = await poll(payload());
		usageCache.delete(accountId);
		expect(decision(snapshot).status).not.toBe("admit");
	});
	it.each([
		"limit",
		"percent",
		"missing",
		"additional",
	])("a grant cannot override %s", async (kind) => {
		const body = payload();
		body.rate_limit.primary_window = {
			used_percent: 0,
			reset_at: Math.floor(now / 1000) + 3600,
		};
		if (kind === "limit") body.rate_limit.limit_reached = true;
		if (kind === "percent")
			Object.assign(body.rate_limit.secondary_window, {
				used_percent: "invalid",
			});
		if (kind === "missing") body.rate_limit.primary_window = undefined;
		const snapshot = await poll(
			kind === "additional" ? { ...body, additional_rate_limits: [{}] } : body,
		);
		const grants = [
			{
				accountId,
				line: "gpt-astra",
				authorization: "operator-approved",
				scope: "outside-subscription",
			},
		];
		expect(decision(snapshot, { spendGrants: grants }).status).not.toBe(
			"admit",
		);
		// Manual refresh/copy cannot erase negative normalized facts either.
		expect(
			decision(
				{ ...snapshot, data: structuredClone(snapshot.data) },
				{ spendGrants: grants },
			).status,
		).not.toBe("admit");
	});
	it("a newer generic exhausted header cannot be masked by an earlier poll", async () => {
		const snapshot = await poll(payload());
		usageCache.set(accountId, {
			...snapshot.data,
			limits: [{ kind: "weekly_all", percent: 100, resets_at: now + 3600_000 }],
		});
		expect(decision(usageCache.getSnapshot(accountId)).status).not.toBe(
			"admit",
		);
		expect(decision(snapshot).status).not.toBe("admit");
	});
	it("rejects stale and future source times despite fresh wrapper times", async () => {
		const snapshot = await poll(payload());
		const future = snapshot.observedAt + 180_001;
		expect(
			decision({ ...snapshot, observedAt: future }, { now: future }).status,
		).not.toBe("admit");
		expect(
			decision({ ...snapshot, observedAt: now - 10_000 }, { now: now - 10_000 })
				.status,
		).not.toBe("admit");
	});
	it("never admits a credit-drain account with spent windows on quality routes", async () => {
		const body = payload();
		Object.assign(body.rate_limit, {
			primary_window: {
				used_percent: 100,
				reset_at: Math.floor(now / 1000) + 3600,
			},
			secondary_window: {
				used_percent: 100,
				reset_at: Math.floor(now / 1000) + 3600,
			},
		});
		body.credits = { has_credits: true, unlimited: false, balance: "25" };
		const snapshot = await poll(body);
		// The drain evidence exists, yet Auto/quality admission ignores it.
		expect(
			usageCache.getCodexCreditEvidence(accountId, Date.now(), 180_000),
		).toBe(true);
		expect(decision(snapshot).status).not.toBe("admit");
	});
});
