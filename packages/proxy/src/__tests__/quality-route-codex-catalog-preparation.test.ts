import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { QualityConversation } from "@better-ccflare/database";
import { captureAutoRequestRequirements } from "@better-ccflare/providers";
import type { Account, QualityRoutingPolicy } from "@better-ccflare/types";
import {
	CATALOG_REFRESH_INTERVAL_MS,
	clearCodexModelCacheForAccount,
	clearCodexModelCacheForTests,
	ensureCodexModelDefaults,
	getCodexAutoCatalogEvidence,
	getCodexModels,
	getKnownOrSharedCodexModels,
	validateCodexAutoCatalogCredentials,
} from "../codex-model-catalog";
import {
	clearPendingRotation,
	getPendingRotation,
	recordPendingRotation,
} from "../handlers/pending-rotation-registry";
import type { ProxyContext } from "../handlers/proxy-types";
import { evaluateQualityRouteAdmission } from "../handlers/quality-route-admission";
import * as tokenManager from "../handlers/token-manager";
import { resetModelCatalogForTest } from "../model-catalog";
import { compileQualityCandidates } from "../quality-route-candidates";
import * as preparation from "../quality-route-catalog-preparation";

const prepare = preparation.prepareQualityCatalogs;
const intent = { kind: "main", preference: "auto" } as const;
const originalFetch = globalThis.fetch;
let now = 1_000_000;
let clock: ReturnType<typeof spyOn>;
let accounts: Map<string, Account>;
let calls: {
	url: URL;
	authorization: string | null;
	signal: AbortSignal | null;
}[];
let unexpected: string[];
let metadata: (call: (typeof calls)[number]) => Promise<Response>;

function account(id: string, overrides: Partial<Account> = {}): Account {
	return {
		id,
		name: id,
		provider: "codex",
		api_key: null,
		access_token: `synthetic-token-${id}`,
		refresh_token: `synthetic-refresh-${id}`,
		expires_at: 100_000_000,
		created_at: 1,
		priority: 0,
		paused: false,
		requires_reauth: false,
		rate_limited_until: null,
		custom_endpoint: null,
		...overrides,
	} as Account;
}
function policy(ids: string[]): QualityRoutingPolicy {
	return {
		version: 1,
		revision: "quality-policy-v1:codex-preparation-test",
		choices: [],
		fallbacks: [],
		spendGrants: [],
		assignments: [
			{ line: "gpt-astra", lane: "astra", priority: 0, upgrade: "exact-only" },
		],
		accounts: ids.map((accountId) => ({
			accountId,
			provider: "codex",
			lines: ["gpt-astra"],
			priority: 0,
		})),
		lanes: {
			opus: [],
			standard: [],
			lightweight: [],
			astra: ["gpt-astra"],
			fable: [],
		},
		mainLadders: { auto: ["astra"], opus: [], astra: ["astra"], fable: [] },
		workerLanes: {
			standard: [],
			lightweight: [],
			opus: [],
			astra: ["astra"],
			fable: [],
		},
	};
}
function context(p: QualityRoutingPolicy): ProxyContext {
	return {
		config: { getQualityRoutingPolicy: () => p },
		dbOps: { getAccount: async (id: string) => accounts.get(id) ?? null },
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
}
const options = () => ({
	signal: new AbortController().signal,
	allowOAuth: true,
});
const catalogResponse = () =>
	Response.json({
		models: [
			{
				slug: "gpt-6-astra",
				visibility: "list",
				context_window: 200_000,
				max_context_window: 200_000,
			},
		],
	});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function turns() {
	for (let n = 0; n < 40; n++) await Promise.resolve();
}
async function waitFor(predicate: () => boolean) {
	for (let n = 0; n < 100 && !predicate(); n++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	expect(predicate()).toBe(true);
}
function install(ids: string[]) {
	const values = ids.map((id, priority) => account(id, { priority }));
	for (const value of values) accounts.set(value.id, value);
	const p = policy(ids);
	return { values, p, ctx: context(p) };
}

beforeEach(() => {
	now = 1_000_000;
	clock = spyOn(Date, "now").mockImplementation(() => now);
	accounts = new Map();
	calls = [];
	unexpected = [];
	metadata = async () => catalogResponse();
	clearCodexModelCacheForTests();
	resetModelCatalogForTest();
	// Every network request is intercepted. No inference or real provider traffic
	// is permitted, even if production code accidentally takes a new path.
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (
			!(
				(url.origin === "https://chatgpt.com" &&
					url.pathname === "/backend-api/codex/models") ||
				(url.origin === "https://api.anthropic.com" &&
					url.pathname === "/v1/models")
			) ||
			(init?.method ?? "GET") !== "GET"
		) {
			unexpected.push(`${init?.method ?? "GET"} ${url}`);
			throw new Error(`Unexpected network request: ${unexpected.at(-1)}`);
		}
		const call = {
			url,
			authorization:
				new Headers(init?.headers).get("authorization") ??
				new Headers(init?.headers).get("x-api-key"),
			signal: init?.signal ?? null,
		};
		calls.push(call);
		return metadata(call);
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	clock.mockRestore();
	clearCodexModelCacheForTests();
	resetModelCatalogForTest();
	expect(unexpected).toEqual([]);
});

describe("Auto request-time owned Codex catalog preparation (real source, metadata only)", () => {
	test("awaits unchanged-content renewal after expiry before compiling the Auto candidate", async () => {
		const a = account("renew");
		accounts.set(a.id, a);
		const p = policy([a.id]);
		const ctx = context(p);
		await getCodexModels(a.id, ctx);
		const original = getCodexAutoCatalogEvidence(a.id);
		expect(original).not.toBeNull();
		now += CATALOG_REFRESH_INTERVAL_MS;
		const oldOrdering = compileQualityCandidates(p, intent, [a]);
		expect(oldOrdering.candidates).toHaveLength(0);
		expect(oldOrdering.skippedLanes).toEqual([
			{ lane: "astra", reasons: { "catalog-evidence-stale": 1 } },
		]);

		await prepare(ctx, p, intent, [a], options());
		const compiled = compileQualityCandidates(p, intent, [a]);
		expect(compiled.candidates).toHaveLength(1);
		const renewed = getCodexAutoCatalogEvidence(a.id);
		expect(renewed).not.toBe(original);
		expect(renewed?.revision).toBe(original?.revision);
		expect(renewed?.fetchedAt).toBe(now);
		expect(renewed?.expiresAt).toBe(now + CATALOG_REFRESH_INTERVAL_MS);
		expect(original?.expiresAt).toBe(now);
		expect(
			validateCodexAutoCatalogCredentials(renewed, {
				account: a,
				accessToken: a.access_token as string,
			}),
		).toBe(true);
		expect(compiled.candidates[0].target.physicalModel).toBe("gpt-6-astra");
		expect(calls).toHaveLength(2);
	});
});

describe("cold, warm and ordinary in-flight acquisition", () => {
	test("cold Auto preparation acquires first-hand evidence; fresh owned evidence avoids another metadata request", async () => {
		const { values, p, ctx } = install(["cold"]);
		expect(compileQualityCandidates(p, intent, values).candidates).toHaveLength(
			0,
		);
		await prepare(ctx, p, intent, values, options());
		expect(compileQualityCandidates(p, intent, values).candidates).toHaveLength(
			1,
		);
		const first = getCodexAutoCatalogEvidence("cold");
		await prepare(ctx, p, intent, values, options());
		expect(getCodexAutoCatalogEvidence("cold")).toBe(first);
		expect(calls).toHaveLength(1);
	});

	test.each([
		false,
		true,
	])("awaits existing ordinary ensure refresh, warm=%s, without duplicate metadata", async (warm) => {
		const { values, p, ctx } = install(["in-flight"]);
		if (warm) {
			await getCodexModels(values[0].id, ctx);
			now += CATALOG_REFRESH_INTERVAL_MS;
		}
		const response = deferred<Response>();
		metadata = () => response.promise;
		const ordinary = ensureCodexModelDefaults(values[0], ctx);
		await waitFor(() => calls.length === (warm ? 2 : 1));
		let completed = false;
		const work = prepare(ctx, p, intent, values, options()).then(() => {
			completed = true;
		});
		await turns();
		expect(completed).toBe(false);
		expect(calls).toHaveLength(warm ? 2 : 1);
		response.resolve(catalogResponse());
		await Promise.all([ordinary, work]);
		expect(compileQualityCandidates(p, intent, values).candidates).toHaveLength(
			1,
		);
		expect(calls).toHaveLength(warm ? 2 : 1);
	});

	test("an aborted waiter does not cancel another caller's ordinary in-flight metadata", async () => {
		const { values, p, ctx } = install(["ordinary"]);
		const response = deferred<Response>();
		metadata = () => response.promise;
		const ordinary = ensureCodexModelDefaults(values[0], ctx);
		await waitFor(() => calls.length === 1);
		const controller = new AbortController();
		const work = prepare(ctx, p, intent, values, {
			signal: controller.signal,
			allowOAuth: true,
		});
		await turns();
		controller.abort();
		await work;
		expect(calls[0].signal?.aborted).toBe(false);
		response.resolve(catalogResponse());
		await ordinary;
		expect(getCodexAutoCatalogEvidence("ordinary")).not.toBeNull();
	});

	test("two Auto requests share the same new acquisition", async () => {
		const { values, p, ctx } = install(["shared-flight"]);
		const response = deferred<Response>();
		metadata = () => response.promise;
		const first = prepare(ctx, p, intent, values, options());
		await waitFor(() => calls.length === 1);
		const second = prepare(ctx, p, intent, values, options());
		await turns();
		expect(calls).toHaveLength(1);
		response.resolve(catalogResponse());
		await Promise.all([first, second]);
		expect(compileQualityCandidates(p, intent, values).candidates).toHaveLength(
			1,
		);
		expect(calls).toHaveLength(1);
	});
});

describe("negative admission evidence", () => {
	test.each([
		401, 503,
	])("HTTP %s renewal does not extend original expiry or promote cached advice", async (status) => {
		const { values, p, ctx } = install(["failed"]);
		await getCodexModels("failed", ctx);
		const original = getCodexAutoCatalogEvidence("failed");
		now += CATALOG_REFRESH_INTERVAL_MS;
		metadata = async () => new Response("synthetic failure", { status });
		await prepare(ctx, p, intent, values, options());
		expect(calls).toHaveLength(2);
		expect(getCodexAutoCatalogEvidence("failed")).toBeNull();
		expect(getCodexAutoCatalogEvidence("failed", true)).toBe(original);
		expect(original?.expiresAt).toBe(now);
		expect(compileQualityCandidates(p, intent, values)).toMatchObject({
			candidates: [],
			skippedLanes: [
				{ lane: "astra", reasons: { "catalog-evidence-stale": 1 } },
			],
		});
	});

	test("another account's shared catalog never becomes Auto admission evidence after HTTP 401", async () => {
		const { values, p, ctx } = install(["owner", "borrower"]);
		await getCodexModels("owner", ctx);
		metadata = async () =>
			new Response("synthetic unauthorized", { status: 401 });
		await prepare(ctx, p, intent, [values[1]], options());
		expect(getKnownOrSharedCodexModels("borrower")).toMatchObject({
			source: "shared",
			borrowedFrom: "owner",
		});
		expect(getCodexAutoCatalogEvidence("borrower", true)).toBeNull();
		expect(compileQualityCandidates(p, intent, [values[1]])).toMatchObject({
			candidates: [],
			skippedLanes: [{ lane: "astra", reasons: { "evidence-missing": 1 } }],
		});
		expect(calls).toHaveLength(2);
	});

	test("renewal leaves missing capacity, no-spend authorization, exhaustion and availability gates intact", async () => {
		const { values, p, ctx } = install(["gated"]);
		await getCodexModels("gated", ctx);
		now += CATALOG_REFRESH_INTERVAL_MS;
		await prepare(ctx, p, intent, values, options());
		const catalog = getCodexAutoCatalogEvidence("gated");
		const candidate = compileQualityCandidates(p, intent, values).candidates[0];
		expect(candidate).toBeDefined();
		const finalBody = {
			model: "gpt-6-astra",
			messages: [{ role: "user", content: "synthetic local request" }],
			max_tokens: 1,
		};
		const input = {
			account: values[0],
			policy: p,
			selectedCredentials: {
				account: values[0],
				accessToken: values[0].access_token as string,
			},
			request: {
				catalog,
				target: candidate.evidence,
				requirements: captureAutoRequestRequirements(finalBody),
				finalBody,
			},
			usage: {
				accountId: "gated",
				provider: "codex",
				observedAt: now,
				data: {},
			},
		};
		expect(evaluateQualityRouteAdmission(input)).toEqual({
			status: "unknown",
			reason: "capacity-evidence-unknown",
		});
		expect(
			evaluateQualityRouteAdmission({
				...input,
				usage: {
					...input.usage,
					data: {
						limits: [
							{ kind: "weekly_all", percent: 10, resets_at: now + 60_000 },
						],
					},
				},
			}),
		).toEqual({ status: "unknown", reason: "spend-not-authorized" });
		expect(
			evaluateQualityRouteAdmission({
				...input,
				usage: {
					...input.usage,
					data: { codex_subscription: { allowed: false } },
				},
			}),
		).toEqual({ status: "reject", reason: "provider-capacity-exhausted" });
		expect(
			evaluateQualityRouteAdmission({
				...input,
				account: { ...values[0], paused: true },
			}),
		).toEqual({ status: "reject", reason: "account-unavailable" });
		expect(calls).toHaveLength(2);
	});
});

describe("eligibility and one native/Codex preparation budget", () => {
	test.each([
		["paused", { paused: true }],
		["reauth flag", { requires_reauth: true }],
		["reauth reason", { pause_reason: "oauth_invalid_grant" }],
		["rate limited", { rate_limited_until: 99_000_000 }],
		[
			"custom endpoint",
			{ custom_endpoint: "https://custom.invalid/responses" },
		],
	] as const)("skips %s accounts in both the snapshot and a queued account reload", async (_name, extra) => {
		const { values, p: base } = install(["first", "second", "queued"]);
		const skipped = account("skipped", extra);
		accounts.set(skipped.id, skipped);
		const p: QualityRoutingPolicy = {
			...base,
			accounts: [
				...base.accounts,
				{
					accountId: "skipped",
					provider: "codex",
					lines: ["gpt-astra"],
					priority: 0,
				},
			],
		};
		const ctx = context(p);
		const response = deferred<Response>();
		metadata = async () => {
			await response.promise;
			return catalogResponse();
		};
		const work = prepare(
			ctx,
			p,
			intent,
			[...values, skipped, account("unenrolled")],
			options(),
		);
		await waitFor(() => calls.length === 2);
		accounts.set("queued", { ...values[2], ...extra });
		response.resolve(catalogResponse());
		await work;
		expect(calls.map((call) => call.authorization)).toEqual([
			"Bearer synthetic-token-first",
			"Bearer synthetic-token-second",
		]);
		expect(getCodexAutoCatalogEvidence("queued", true)).toBeNull();
		expect(getCodexAutoCatalogEvidence("skipped", true)).toBeNull();
		expect(getCodexAutoCatalogEvidence("unenrolled", true)).toBeNull();
	});

	test("pre-abort and a disabled or replaced policy produce no metadata traffic", async () => {
		const { values, p, ctx } = install(["offline"]);
		const controller = new AbortController();
		controller.abort();
		await prepare(ctx, p, intent, values, {
			signal: controller.signal,
			allowOAuth: true,
		});
		ctx.config.getQualityRoutingPolicy = () => null;
		await prepare(ctx, p, intent, values, options());
		ctx.config.getQualityRoutingPolicy = () => ({
			...p,
			revision: "quality-policy-v1:replaced",
		});
		await prepare(ctx, p, intent, values, options());
		expect(calls).toHaveLength(0);
	});

	test("native and Codex share two workers rather than independent provider queues", async () => {
		const { values, p: base } = install(["codex-a", "codex-b"]);
		const native = account("native", {
			provider: "anthropic",
			api_key: "synthetic-native",
			access_token: null,
			refresh_token: null,
		});
		accounts.set(native.id, native);
		const p: QualityRoutingPolicy = {
			...base,
			mainLadders: { ...base.mainLadders, auto: ["opus", "astra"] },
			lanes: { ...base.lanes, opus: ["claude-opus"] },
			assignments: [
				...base.assignments,
				{
					line: "claude-opus",
					lane: "opus",
					priority: 0,
					upgrade: "exact-only",
				},
			],
			accounts: [
				...base.accounts,
				{
					accountId: native.id,
					provider: "anthropic",
					lines: ["claude-opus"],
					priority: 0,
				},
			],
		};
		const ctx = context(p);
		const releases: ReturnType<typeof deferred<void>>[] = [];
		let active = 0;
		let maximum = 0;
		metadata = async (call) => {
			active++;
			maximum = Math.max(maximum, active);
			const release = deferred<void>();
			releases.push(release);
			await release.promise;
			active--;
			return call.url.hostname === "api.anthropic.com"
				? Response.json({
						data: [{ id: "claude-opus-5-5", type: "model" }],
						has_more: false,
					})
				: catalogResponse();
		};
		const work = prepare(ctx, p, intent, [native, ...values], options());
		await waitFor(() => calls.length === 2);
		expect(calls.map((call) => call.url.hostname).toSorted()).toEqual([
			"api.anthropic.com",
			"chatgpt.com",
		]);
		expect(active).toBe(2);
		releases[0].resolve();
		await waitFor(() => calls.length === 3);
		expect(maximum).toBe(2);
		for (const release of releases) release.resolve();
		await work;
		expect(
			compileQualityCandidates(p, intent, [native, ...values]).candidates,
		).toHaveLength(3);
	});

	test.each([
		"database",
		"token",
	] as const)("the single ten-second deadline bounds stuck %s awaits and fences late continuation", async (stage) => {
		const { values, p, ctx } = install(["a", "b", "queued"]);
		const stalled = deferred<void>();
		const entered: string[] = [];
		let tokenSpy: ReturnType<typeof spyOn> | undefined;
		if (stage === "database") {
			ctx.dbOps.getAccount = async (id) => {
				entered.push(id);
				await stalled.promise;
				return accounts.get(id) ?? null;
			};
		} else {
			tokenSpy = spyOn(tokenManager, "getValidAccessToken").mockImplementation(
				async (selected) => {
					entered.push(selected.id);
					await stalled.promise;
					return selected.access_token as string;
				},
			);
		}
		const originalTimer = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
			delays.push(delay ?? 0);
			return originalTimer(handler, delay === 10_000 ? 5 : delay);
		}) as typeof setTimeout;
		try {
			await prepare(ctx, p, intent, values, options());
			expect(delays[0]).toBe(10_000);
			expect(entered).toEqual(["a", "b"]);
			expect(calls).toHaveLength(0);
			stalled.resolve();
			await turns();
			expect(calls).toHaveLength(0);
			expect(entered).not.toContain("queued");
			for (const a of values)
				expect(getCodexAutoCatalogEvidence(a.id, true)).toBeNull();
		} finally {
			stalled.resolve();
			await turns();
			globalThis.setTimeout = originalTimer;
			tokenSpy?.mockRestore();
		}
	});

	test("late metadata completion cannot publish or extend expired evidence after the ten-second deadline", async () => {
		const { values, p, ctx } = install(["late"]);
		await getCodexModels("late", ctx);
		const original = getCodexAutoCatalogEvidence("late");
		now += CATALOG_REFRESH_INTERVAL_MS;
		const response = deferred<Response>();
		metadata = () => response.promise; // Deliberately ignores AbortSignal.
		const originalTimer = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
			delays.push(delay ?? 0);
			return originalTimer(handler, delay === 10_000 ? 5 : delay);
		}) as typeof setTimeout;
		try {
			await prepare(ctx, p, intent, values, options());
			expect(calls).toHaveLength(2);
			expect(calls[1].signal?.aborted).toBe(true);
			expect(delays[0]).toBe(10_000);
			// The shared signal wins over the ordinary provider's longer safety timer.
			expect(calls[1].signal?.aborted).toBe(true);
			response.resolve(catalogResponse());
			await turns();
			expect(getCodexAutoCatalogEvidence("late", true)).toBe(original);
			expect(original?.expiresAt).toBe(now);
			expect(
				compileQualityCandidates(p, intent, values).candidates,
			).toHaveLength(0);
		} finally {
			response.resolve(catalogResponse());
			await turns();
			globalThis.setTimeout = originalTimer;
		}
	});
});

describe("account lifecycle and credential ownership", () => {
	test("deletion during acquisition cannot repopulate owned evidence", async () => {
		const { values, p, ctx } = install(["deleted"]);
		const response = deferred<Response>();
		metadata = () => response.promise;
		const work = prepare(ctx, p, intent, values, options());
		await waitFor(() => calls.length === 1);
		accounts.delete("deleted");
		clearCodexModelCacheForAccount("deleted");
		response.resolve(catalogResponse());
		await work;
		expect(getCodexAutoCatalogEvidence("deleted", true)).toBeNull();
	});

	test("same-ID recreation invalidates old ownership and requires the replacement's own acquisition", async () => {
		const { values, p, ctx } = install(["recreated"]);
		await prepare(ctx, p, intent, values, options());
		const original = getCodexAutoCatalogEvidence("recreated");
		clearCodexModelCacheForAccount("recreated");
		const replacement = { ...values[0], created_at: 2 };
		accounts.set("recreated", replacement);
		expect(
			validateCodexAutoCatalogCredentials(original, {
				account: replacement,
				accessToken: replacement.access_token as string,
			}),
		).toBe(false);
		await prepare(ctx, p, intent, [replacement], options());
		const renewed = getCodexAutoCatalogEvidence("recreated");
		expect(renewed).not.toBe(original);
		expect(
			validateCodexAutoCatalogCredentials(renewed, {
				account: replacement,
				accessToken: replacement.access_token as string,
			}),
		).toBe(true);
		expect(
			validateCodexAutoCatalogCredentials(original, {
				account: replacement,
				accessToken: replacement.access_token as string,
			}),
		).toBe(false);
		expect(calls).toHaveLength(2);
	});

	test("fresh evidence owned by the old token is reacquired with the selected replacement token", async () => {
		const { values, p, ctx } = install(["rotation"]);
		await getCodexModels("rotation", ctx);
		const original = getCodexAutoCatalogEvidence("rotation");
		const replacement = { ...values[0], access_token: "synthetic-replacement" };
		accounts.set("rotation", replacement);
		await prepare(ctx, p, intent, [replacement], options());
		const renewed = getCodexAutoCatalogEvidence("rotation");
		expect(calls.map((call) => call.authorization)).toEqual([
			"Bearer synthetic-token-rotation",
			"Bearer synthetic-replacement",
		]);
		expect(
			validateCodexAutoCatalogCredentials(original, {
				account: replacement,
				accessToken: "synthetic-replacement",
			}),
		).toBe(false);
		expect(
			validateCodexAutoCatalogCredentials(renewed, {
				account: replacement,
				accessToken: "synthetic-replacement",
			}),
		).toBe(true);
		expect(
			validateCodexAutoCatalogCredentials(renewed && { ...renewed }, {
				account: replacement,
				accessToken: "synthetic-replacement",
			}),
		).toBe(false);
	});

	test("a failed replacement-token refresh retires the old token's evidence", async () => {
		const { values, p, ctx } = install(["rotation-failed"]);
		await getCodexModels("rotation-failed", ctx);
		accounts.set("rotation-failed", {
			...values[0],
			access_token: "synthetic-replacement",
		});
		metadata = async () =>
			new Response("synthetic unauthorized", { status: 401 });
		await prepare(
			ctx,
			p,
			intent,
			[accounts.get("rotation-failed") as Account],
			options(),
		);
		expect(getCodexAutoCatalogEvidence("rotation-failed", true)).toBeNull();
		expect(compileQualityCandidates(p, intent, values).candidates).toHaveLength(
			0,
		);
		expect(calls).toHaveLength(2);
	});

	test("an endpoint change while metadata is pending cannot publish owned admission evidence", async () => {
		const { values, p, ctx } = install(["endpoint"]);
		const response = deferred<Response>();
		metadata = () => response.promise;
		const work = prepare(ctx, p, intent, values, options());
		await waitFor(() => calls.length === 1);
		const replacement = {
			...values[0],
			custom_endpoint: "https://custom.invalid/responses",
		};
		accounts.set("endpoint", replacement);
		response.resolve(catalogResponse());
		await work;
		expect(
			validateCodexAutoCatalogCredentials(
				getCodexAutoCatalogEvidence("endpoint"),
				{
					account: replacement,
					accessToken: replacement.access_token as string,
				},
			),
		).toBe(false);
		expect(calls).toHaveLength(1);
	});
});

describe("state changes across awaited revalidation", () => {
	test.each([
		"paused",
		"rotated",
		"recreated",
		"endpoint",
	] as const)("a %s row replacement during the last pre-fetch token await cannot send stale metadata credentials", async (change) => {
		const { values, p, ctx } = install(["await-race"]);
		const token = deferred<string>();
		let resolutions = 0;
		const tokenSpy = spyOn(
			tokenManager,
			"getValidAccessToken",
		).mockImplementation(async (selected) => {
			resolutions++;
			// Initial ownership resolution/revalidation, then the acquisition's
			// token resolution/revalidation. Stall the last await before fetch.
			return resolutions === 4
				? token.promise
				: (selected.access_token as string);
		});
		const work = prepare(ctx, p, intent, values, options());
		try {
			await waitFor(() => resolutions === 4);
			const extra: Partial<Account> =
				change === "paused"
					? { paused: true }
					: change === "rotated"
						? { access_token: "synthetic-new-token" }
						: change === "recreated"
							? { created_at: 2 }
							: { custom_endpoint: "https://custom.invalid/responses" };
			accounts.set("await-race", { ...values[0], ...extra });
			token.resolve(values[0].access_token as string);
			await work;
			expect(calls).toHaveLength(0);
			expect(getCodexAutoCatalogEvidence("await-race", true)).toBeNull();
		} finally {
			token.resolve(values[0].access_token as string);
			await work;
			tokenSpy.mockRestore();
		}
	});

	test("a paused row replacement during post-response token revalidation cannot publish a renewed catalog", async () => {
		const { values, p, ctx } = install(["publication-race"]);
		const token = deferred<string>();
		let resolutions = 0;
		const tokenSpy = spyOn(
			tokenManager,
			"getValidAccessToken",
		).mockImplementation(async (selected) => {
			resolutions++;
			return resolutions === 5
				? token.promise
				: (selected.access_token as string);
		});
		const work = prepare(ctx, p, intent, values, options());
		try {
			await waitFor(() => resolutions === 5);
			expect(calls).toHaveLength(1);
			accounts.set("publication-race", { ...values[0], paused: true });
			token.resolve(values[0].access_token as string);
			await work;
			expect(getCodexAutoCatalogEvidence("publication-race", true)).toBeNull();
		} finally {
			token.resolve(values[0].access_token as string);
			await work;
			tokenSpy.mockRestore();
		}
	});

	test("policy replacement while two accounts are pending prevents queued metadata and late publication", async () => {
		const { values, p, ctx } = install(["first", "second", "queued"]);
		const response = deferred<void>();
		metadata = async () => {
			await response.promise;
			return catalogResponse();
		};
		const work = prepare(ctx, p, intent, values, options());
		await waitFor(() => calls.length === 2);
		ctx.config.getQualityRoutingPolicy = () => ({
			...p,
			revision: "quality-policy-v1:removed",
			accounts: [],
		});
		response.resolve();
		await work;
		expect(calls).toHaveLength(2);
		for (const a of values)
			expect(getCodexAutoCatalogEvidence(a.id, true)).toBeNull();
	});

	test("explicit offline mode and omitted OAuth permission never acquire a Codex catalog", async () => {
		const { values, p, ctx } = install(["offline-mode"]);
		const previous = process.env.BETTER_CCFLARE_MODELS_OFFLINE;
		try {
			process.env.BETTER_CCFLARE_MODELS_OFFLINE = "1";
			await prepare(ctx, p, intent, values, options());
			delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
			await prepare(ctx, p, intent, values, {
				signal: new AbortController().signal,
			});
			expect(calls).toHaveLength(0);
		} finally {
			if (previous === undefined)
				delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
			else process.env.BETTER_CCFLARE_MODELS_OFFLINE = previous;
		}
	});
});

describe("bounded preparation remains scoped to the approved route", () => {
	test("the legacy native helper stays native-only, and a worker without an approved Codex lane does not acquire Codex", async () => {
		const { values, p, ctx } = install(["route-scope"]);
		await preparation.prepareNativeQualityCatalogs(
			ctx,
			p,
			intent,
			values,
			options(),
		);
		await prepare(
			ctx,
			p,
			{ kind: "worker", role: "standard" },
			values,
			options(),
		);
		expect(calls).toHaveLength(0);
		await prepare(ctx, p, { kind: "worker", role: "astra" }, values, options());
		expect(calls).toHaveLength(1);
		expect(
			compileQualityCandidates(p, { kind: "worker", role: "astra" }, values)
				.candidates,
		).toHaveLength(1);
	});

	test("the absolute deadline includes time already spent queued", async () => {
		const { values, p, ctx } = install(["first", "second", "queued"]);
		const responses = deferred<void>();
		metadata = async () => {
			await responses.promise;
			return catalogResponse();
		};
		const work = prepare(ctx, p, intent, values, options());
		await waitFor(() => calls.length === 2);
		now += 10_000;
		responses.resolve();
		await work;
		expect(calls).toHaveLength(2);
		for (const a of values)
			expect(getCodexAutoCatalogEvidence(a.id, true)).toBeNull();
	});

	test("abort during delayed JSON parsing prevents publication even when the response ignores cancellation", async () => {
		const { values, p, ctx } = install(["late-json"]);
		const body = deferred<unknown>();
		const response = new Response("{}");
		const json = spyOn(response, "json").mockImplementation(() => body.promise);
		metadata = async () => response;
		const controller = new AbortController();
		const work = prepare(ctx, p, intent, values, {
			signal: controller.signal,
			allowOAuth: true,
		});
		try {
			await waitFor(() => json.mock.calls.length === 1);
			controller.abort();
			await work;
			body.resolve({ models: [{ slug: "gpt-6-astra" }] });
			await turns();
			expect(getCodexAutoCatalogEvidence("late-json", true)).toBeNull();
			expect(calls).toHaveLength(1);
		} finally {
			body.resolve({ models: [{ slug: "gpt-6-astra" }] });
			await turns();
			json.mockRestore();
		}
	});
});

describe("home/worker ordering and independent in-flight ownership", () => {
	test("an eligible expired Codex home is renewed before higher-priority accounts can occupy both workers", async () => {
		const { values, p, ctx } = install(["a", "b", "home"]);
		await getCodexModels("home", ctx);
		const target = compileQualityCandidates(p, intent, [values[2]])
			.candidates[0].target;
		const conversation = {
			revision: 1,
			home: { intentRevision: 1, target },
		} as QualityConversation;
		now += CATALOG_REFRESH_INTERVAL_MS;
		calls.length = 0;
		const response = deferred<void>();
		metadata = async () => {
			await response.promise;
			return catalogResponse();
		};
		const work = prepare(ctx, p, intent, values, {
			...options(),
			conversation,
		});
		await waitFor(() => calls.length === 2);
		expect(calls.map((call) => call.authorization)).toEqual([
			"Bearer synthetic-token-home",
			"Bearer synthetic-token-a",
		]);
		response.resolve();
		await work;
		expect(
			compileQualityCandidates(p, intent, values, conversation).candidates[0]
				.target.accountId,
		).toBe("home");
		expect(calls).toHaveLength(3);
	});

	test("standard workers prepare enrolled Sol accounts in policy order before their approved Astra fallback", async () => {
		const { values, p: base } = install(["astra", "sol-a", "sol-b"]);
		const p: QualityRoutingPolicy = {
			...base,
			workerFlagshipFallback: true,
			assignments: [
				...base.assignments,
				{
					line: "gpt-sol",
					lane: "standard",
					priority: 0,
					upgrade: "exact-only",
				},
			],
			accounts: [
				{
					accountId: "astra",
					provider: "codex",
					lines: ["gpt-astra"],
					priority: 0,
				},
				{
					accountId: "sol-a",
					provider: "codex",
					lines: ["gpt-sol"],
					priority: 1,
				},
				{
					accountId: "sol-b",
					provider: "codex",
					lines: ["gpt-sol"],
					priority: 0,
				},
			],
			lanes: { ...base.lanes, standard: ["gpt-sol"] },
			workerLanes: { ...base.workerLanes, standard: ["standard", "astra"] },
		};
		const ctx = context(p);
		metadata = async () =>
			Response.json({
				models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6.1-sol" }],
			});
		await prepare(
			ctx,
			p,
			{ kind: "worker", role: "standard" },
			values,
			options(),
		);
		expect(calls.map((call) => call.authorization)).toEqual([
			"Bearer synthetic-token-sol-b",
			"Bearer synthetic-token-sol-a",
			"Bearer synthetic-token-astra",
		]);
		expect(
			compileQualityCandidates(
				p,
				{ kind: "worker", role: "standard" },
				values,
			).candidates.map((candidate) => [
				candidate.target.accountId,
				candidate.target.line,
			]),
		).toEqual([
			["sol-b", "gpt-sol"],
			["sol-a", "gpt-sol"],
			["astra", "gpt-astra"],
		]);
	});

	test("fresh credential-owned evidence returns before an unrelated ordinary lookup finishes", async () => {
		const { values, p, ctx } = install(["owned"]);
		await getCodexModels("owned", ctx);
		const original = getCodexAutoCatalogEvidence("owned");
		const row = deferred<Account>();
		const otherContext = context(p);
		otherContext.dbOps.getAccount = () => row.promise;
		const ordinary = ensureCodexModelDefaults(
			values[0],
			otherContext,
			Date.now,
			true,
		);
		let completed = false;
		const work = prepare(ctx, p, intent, values, options()).then(() => {
			completed = true;
		});
		try {
			await waitFor(() => completed);
			expect(getCodexAutoCatalogEvidence("owned")).toBe(original);
			expect(calls).toHaveLength(1);
		} finally {
			row.resolve(values[0]);
			await Promise.all([ordinary, work]);
		}
	});

	test("a bounded Auto waiter does not cancel an ordinary refresh stuck resolving its token", async () => {
		const { values, p, ctx } = install(["ordinary-token"]);
		const otherContext = context(p);
		const token = deferred<string>();
		let entered = false;
		const tokenSpy = spyOn(
			tokenManager,
			"getValidAccessToken",
		).mockImplementation(async (selected, selectedContext) => {
			if (selectedContext === otherContext) {
				entered = true;
				return token.promise;
			}
			return selected.access_token as string;
		});
		const ordinary = ensureCodexModelDefaults(values[0], otherContext);
		const controller = new AbortController();
		let work: Promise<void> | undefined;
		try {
			await waitFor(() => entered);
			work = prepare(ctx, p, intent, values, {
				signal: controller.signal,
				allowOAuth: true,
			});
			await turns();
			controller.abort();
			await work;
			expect(calls).toHaveLength(0);
			token.resolve(values[0].access_token as string);
			await ordinary;
			expect(getCodexAutoCatalogEvidence("ordinary-token")).not.toBeNull();
			expect(calls).toHaveLength(1);
		} finally {
			token.resolve(values[0].access_token as string);
			await Promise.all([ordinary, work]);
			tokenSpy.mockRestore();
		}
	});
});

describe("real token-manager pending rotations", () => {
	function rotationFixture(id: string) {
		const fixture = install([id]);
		accounts.set(id, { ...fixture.values[0], expires_at: now - 1 });
		// The real DB facade returns row copies. Token-manager updates to its
		// selected snapshot must not pretend the failed CAS persisted anything.
		fixture.ctx.dbOps.getAccount = async (accountId) => {
			const row = accounts.get(accountId);
			return row ? { ...row } : null;
		};
		fixture.ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = async () => {
			throw new Error("synthetic database persist outage");
		};
		return fixture;
	}
	async function recordRotation(
		a: Account,
		extra: Partial<Parameters<typeof recordPendingRotation>[1]> = {},
	) {
		await recordPendingRotation(a.id, {
			accessToken: "synthetic-pending-access",
			refreshToken: "synthetic-pending-refresh",
			attemptedRefreshToken: a.refresh_token as string,
			expiresAt: 100_000_000,
			createdAt: a.created_at,
			...extra,
		});
	}

	test("generation-owned unpersisted rotation renews expired evidence when the real token manager cannot persist its CAS", async () => {
		const { values, p, ctx } = rotationFixture("pending-renewal");
		await recordRotation(values[0]);
		try {
			await getCodexModels(values[0].id, ctx);
			const original = getCodexAutoCatalogEvidence(values[0].id);
			expect(original).not.toBeNull();
			expect(calls[0].authorization).toBe("Bearer synthetic-pending-access");
			now += CATALOG_REFRESH_INTERVAL_MS;
			expect(
				compileQualityCandidates(p, intent, values).candidates,
			).toHaveLength(0);
			await prepare(ctx, p, intent, values, options());
			const renewed = getCodexAutoCatalogEvidence(values[0].id);
			expect(calls.map((call) => call.authorization)).toEqual([
				"Bearer synthetic-pending-access",
				"Bearer synthetic-pending-access",
			]);
			expect(renewed).not.toBeNull();
			expect(renewed).not.toBe(original);
			expect(renewed?.revision).toBe(original?.revision);
			expect(renewed?.fetchedAt).toBe(now);
			expect(original?.expiresAt).toBe(now);
			expect(
				compileQualityCandidates(p, intent, values).candidates,
			).toHaveLength(1);
			expect(accounts.get(values[0].id)?.access_token).toBe(
				values[0].access_token,
			);
			expect(
				getPendingRotation(values[0].id, values[0].created_at)?.accessToken,
			).toBe("synthetic-pending-access");
			expect(
				validateCodexAutoCatalogCredentials(renewed, {
					account: values[0],
					accessToken: "synthetic-pending-access",
				}),
			).toBe(true);
			expect(
				validateCodexAutoCatalogCredentials(renewed, {
					account: values[0],
					accessToken: values[0].access_token as string,
				}),
			).toBe(false);
		} finally {
			clearPendingRotation(values[0].id);
		}
	});

	test("an obsolete pending refresh-token anchor cannot authorize metadata when failed persistence conceals a newer durable credential", async () => {
		const { values, p, ctx } = rotationFixture("pending-obsolete-anchor");
		await recordRotation(values[0]);
		accounts.set(values[0].id, {
			...(accounts.get(values[0].id) as Account),
			refresh_token: "synthetic-new-durable-refresh",
		});
		try {
			await prepare(ctx, p, intent, values, options());
			expect(calls).toHaveLength(0);
			expect(getCodexAutoCatalogEvidence(values[0].id, true)).toBeNull();
			expect(
				compileQualityCandidates(p, intent, values).candidates,
			).toHaveLength(0);
		} finally {
			clearPendingRotation(values[0].id);
		}
	});

	test("an outbox entry from another account generation cannot replace valid current durable credentials", async () => {
		const { values, p, ctx } = install(["pending-wrong-generation"]);
		await recordRotation(values[0], { createdAt: values[0].created_at - 1 });
		try {
			expect(
				getPendingRotation(values[0].id, values[0].created_at),
			).toBeUndefined();
			expect(
				await tokenManager.getValidAccessToken({ ...values[0] }, ctx),
			).toBe(values[0].access_token as string);
			await prepare(ctx, p, intent, values, options());
			expect(calls.map((call) => call.authorization)).toEqual([
				`Bearer ${values[0].access_token}`,
			]);
			const evidence = getCodexAutoCatalogEvidence(values[0].id);
			expect(
				validateCodexAutoCatalogCredentials(evidence, {
					account: values[0],
					accessToken: "synthetic-pending-access",
				}),
			).toBe(false);
			expect(
				validateCodexAutoCatalogCredentials(evidence, {
					account: values[0],
					accessToken: values[0].access_token as string,
				}),
			).toBe(true);
		} finally {
			clearPendingRotation(values[0].id);
		}
	});

	test("durable access-token replacement during a real failed-CAS await invalidates the formerly matching pending rotation", async () => {
		const { values, p, ctx } = rotationFixture("pending-durable-race");
		await recordRotation(values[0]);
		const persist = deferred<void>();
		let attempts = 0;
		ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = async () => {
			attempts++;
			if (attempts === 2) await persist.promise;
			throw new Error("synthetic database persist outage");
		};
		const work = prepare(ctx, p, intent, values, options());
		try {
			await waitFor(() => attempts === 2);
			accounts.set(values[0].id, {
				...(accounts.get(values[0].id) as Account),
				access_token: "synthetic-new-durable-access",
				expires_at: 100_000_000,
			});
			persist.resolve();
			await work;
			expect(calls).toHaveLength(0);
			expect(getCodexAutoCatalogEvidence(values[0].id, true)).toBeNull();
		} finally {
			persist.resolve();
			await work;
			clearPendingRotation(values[0].id);
		}
	});

	test("a successfully persisted generation-owned pending rotation still supports cold Auto acquisition", async () => {
		const { values, p, ctx } = rotationFixture("pending-persisted");
		await recordRotation(values[0]);
		ctx.dbOps.updateAccountTokensIfRefreshTokenMatches = async (
			id,
			expected,
			accessToken,
			expiresAt,
			refreshToken,
			createdAt,
		) => {
			const row = accounts.get(id);
			if (
				!row ||
				row.refresh_token !== expected ||
				row.created_at !== createdAt
			)
				return false;
			accounts.set(id, {
				...row,
				access_token: accessToken,
				expires_at: expiresAt,
				refresh_token: refreshToken ?? row.refresh_token,
			});
			return true;
		};
		try {
			await prepare(ctx, p, intent, values, options());
			expect(calls.map((call) => call.authorization)).toEqual([
				"Bearer synthetic-pending-access",
			]);
			expect(getCodexAutoCatalogEvidence(values[0].id)).not.toBeNull();
			expect(
				getPendingRotation(values[0].id, values[0].created_at),
			).toBeUndefined();
			expect(accounts.get(values[0].id)?.access_token).toBe(
				"synthetic-pending-access",
			);
		} finally {
			clearPendingRotation(values[0].id);
		}
	});
});
