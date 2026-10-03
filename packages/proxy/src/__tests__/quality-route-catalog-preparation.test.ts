import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Account, QualityRoutingPolicy } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";
import * as modelCatalog from "../model-catalog";

const fresh = new Map<string, { apiKey: string; createdAt: number }>();
const calls: {
	accountId?: string;
	allowOAuth?: boolean;
	signal?: AbortSignal;
	accountEligible?: (account: Account) => boolean;
}[] = [];
let discover: (signal: AbortSignal) => Promise<void>;
const pendingFor = new Map<string, Promise<void>>();
// Scoped spies, not mock.module: a module mock has no per-file isolation, so a
// synthetic model-catalog would leak into later files in the same process.
// Every replaced export is restored in afterAll; unrelated exports stay real.
const spies = [
	spyOn(modelCatalog, "getNativeAutoCatalogEvidence").mockImplementation(
		((id: string) => fresh.get(id) ?? null) as never,
	),
	spyOn(
		modelCatalog,
		"validateNativeAutoCatalogCredentials",
	).mockImplementation(
		((
			evidence: { apiKey: string; createdAt: number } | null,
			selected: { account: Account; accessToken: string },
		) =>
			evidence !== null &&
			fresh.get(selected.account.id) === evidence &&
			evidence.apiKey === selected.account.api_key &&
			evidence.createdAt === selected.account.created_at &&
			selected.accessToken === "") as never,
	),
	spyOn(modelCatalog, "getPendingNativeCatalogAcquisition").mockImplementation(
		((id: string) => pendingFor.get(id)) as never,
	),
	spyOn(modelCatalog, "fetchLiveModels").mockImplementation((async (
		_ctx: unknown,
		options: (typeof calls)[number],
	) => {
		calls.push(options);
		await discover(options.signal as AbortSignal);
		return [];
	}) as never),
];
afterAll(() => {
	for (const spy of spies) spy.mockRestore();
});

import { prepareNativeQualityCatalogs } from "../quality-route-catalog-preparation";

function account(id: string, extra: Partial<Account> = {}): Account {
	return {
		id,
		provider: "anthropic",
		api_key: `synthetic-${id}`,
		created_at: 1,
		priority: 0,
		paused: false,
		...extra,
	} as Account;
}
function policy(ids: string[]): QualityRoutingPolicy {
	return {
		version: 1,
		revision: "quality-policy-v1:test",
		choices: [],
		fallbacks: [],
		spendGrants: [],
		assignments: [
			{ line: "claude-opus", lane: "opus", priority: 0, upgrade: "exact-only" },
			{
				line: "claude-sonnet",
				lane: "standard",
				priority: 0,
				upgrade: "exact-only",
			},
		],
		accounts: ids.map((accountId) => ({
			accountId,
			provider: "anthropic",
			lines: ["claude-opus", "claude-sonnet"],
			priority: 0,
		})),
		lanes: {
			opus: ["claude-opus"],
			standard: ["claude-sonnet"],
			lightweight: [],
			astra: [],
			fable: [],
		},
		mainLadders: {
			auto: ["opus", "standard"],
			opus: ["opus"],
			astra: [],
			fable: [],
		},
		workerLanes: {
			standard: ["standard"],
			lightweight: [],
			opus: ["opus"],
			astra: [],
			fable: [],
		},
	};
}
function context(p: QualityRoutingPolicy) {
	return {
		config: { getQualityRoutingPolicy: () => p },
		dbOps: { getAccount: async (id: string) => account(id) },
	} as unknown as ProxyContext;
}
const intent = { kind: "main", preference: "auto" } as const;
const options = () => ({ signal: new AbortController().signal });
beforeEach(() => {
	fresh.clear();
	calls.length = 0;
	pendingFor.clear();
	discover = async () => {};
});

describe("native quality catalog preparation (metadata mocks only)", () => {
	test("every preparation fetch carries the one shared request-eligibility predicate", async () => {
		const p = policy(["cold", "stale", "mismatch"]);
		fresh.set("mismatch", { apiKey: "old-key", createdAt: 0 });
		await prepareNativeQualityCatalogs(
			context(p),
			p,
			intent,
			[account("cold"), account("stale"), account("mismatch")],
			{ ...options(), allowOAuth: true },
		);
		expect(calls.map((c) => c.accountId).toSorted()).toEqual([
			"cold",
			"mismatch",
			"stale",
		]);
		const predicate = calls[0].accountEligible;
		expect(typeof predicate).toBe("function");
		expect(calls.every((c) => c.accountEligible === predicate)).toBe(true);
		const check = predicate as (a: Account) => boolean;
		expect(check(account("ok"))).toBe(true);
		expect(check(account("paused", { paused: true }))).toBe(false);
		expect(
			check(account("limited", { rate_limited_until: Date.now() + 60_000 })),
		).toBe(false);
		expect(
			check(account("reauth", { pause_reason: "oauth_invalid_grant" })),
		).toBe(false);
		expect(check(account("flag", { requires_reauth: true }))).toBe(false);
		expect(
			check(account("custom", { custom_endpoint: "https://invalid.example" })),
		).toBe(false);
		expect(check(account("foreign", { provider: "codex" }))).toBe(false);
	});
	test.each([
		["rate-limited", { rate_limited_until: Date.now() + 60_000 }],
		["requires reauth", { requires_reauth: true }],
		["custom endpoint", { custom_endpoint: "https://invalid.example" }],
		["foreign", { provider: "codex" }],
	] as const)("the ownership shortcut uses the same predicate: a %s reload neither resolves tokens nor fetches", async (_label, extra) => {
		const p = policy(["a"]);
		fresh.set("a", { apiKey: "old-key", createdAt: 0 });
		const ctx = context(p);
		ctx.dbOps.getAccount = async () => account("a", extra as Partial<Account>);
		await prepareNativeQualityCatalogs(ctx, p, intent, [account("a")], {
			...options(),
			allowOAuth: true,
		});
		expect(calls).toHaveLength(0);
	});
	test("selects enrolled available native accounts once in stable priority order; OAuth denied by default", async () => {
		const p = policy([
			"b",
			"a",
			"paused",
			"reauth",
			"limited",
			"foreign",
			"custom",
		]);
		const accounts = [
			account("b", { priority: 2 }),
			account("a", { priority: 1 }),
			account("paused", { paused: true }),
			account("reauth", { pause_reason: "oauth_invalid_grant" }),
			account("limited", { rate_limited_until: Date.now() + 60_000 }),
			account("foreign", { provider: "codex" }),
			account("custom", { custom_endpoint: "https://invalid.example" }),
			account("unenrolled"),
		];
		await prepareNativeQualityCatalogs(
			context(p),
			p,
			intent,
			accounts,
			options(),
		);
		expect(calls.map((c) => c.accountId)).toEqual(["a", "b"]);
		expect(calls.every((c) => c.allowOAuth === false)).toBe(true);
	});
	test("worker role selects only matching approved assignments and forwards explicit OAuth choice", async () => {
		const base = policy(["opus", "standard"]);
		const p: QualityRoutingPolicy = {
			...base,
			accounts: [
				{ ...base.accounts[0], lines: ["claude-opus"] },
				{ ...base.accounts[1], lines: ["claude-sonnet"] },
			],
		};
		await prepareNativeQualityCatalogs(
			context(p),
			p,
			{ kind: "worker", role: "standard" },
			[account("opus"), account("standard")],
			{ ...options(), allowOAuth: true },
		);
		expect(calls.map((c) => c.accountId)).toEqual(["standard"]);
		expect(calls[0].allowOAuth).toBe(true);
		calls.length = 0;
		const mismatched = {
			...p,
			assignments: p.assignments.filter((a) => a.line !== "claude-sonnet"),
		};
		await prepareNativeQualityCatalogs(
			context(mismatched),
			mismatched,
			{ kind: "worker", role: "standard" },
			[account("standard")],
			options(),
		);
		expect(calls).toHaveLength(0);
	});
	test("fresh evidence and empty ladders are noops; cold evidence is fetched", async () => {
		const p = policy(["fresh", "cold"]);
		fresh.set("fresh", { apiKey: "synthetic-fresh", createdAt: 1 });
		await prepareNativeQualityCatalogs(
			context(p),
			p,
			intent,
			[account("fresh"), account("cold")],
			{ ...options(), allowOAuth: true },
		);
		expect(calls.map((c) => c.accountId)).toEqual(["cold"]);
		calls.length = 0;
		await prepareNativeQualityCatalogs(
			context(p),
			p,
			{ kind: "main", preference: "astra" },
			[account("cold")],
			options(),
		);
		expect(calls).toHaveLength(0);
	});
	test.each([
		"credential",
		"incarnation",
	])("fresh but unowned %s evidence is reacquired", async (change) => {
		const p = policy(["a"]);
		fresh.set("a", {
			apiKey: change === "credential" ? "old-key" : "synthetic-a",
			createdAt: change === "incarnation" ? 0 : 1,
		});
		await prepareNativeQualityCatalogs(context(p), p, intent, [account("a")], {
			...options(),
			allowOAuth: true,
		});
		expect(calls.map((c) => c.accountId)).toEqual(["a"]);
	});
	test("fresh evidence without OAuth permission does not start credential work", async () => {
		const p = policy(["a"]);
		fresh.set("a", { apiKey: "old-key", createdAt: 0 });
		const ctx = context(p);
		let reads = 0;
		ctx.dbOps.getAccount = async () => {
			reads++;
			return account("a");
		};
		await prepareNativeQualityCatalogs(
			ctx,
			p,
			intent,
			[account("a")],
			options(),
		);
		expect(reads).toBe(0);
		expect(calls).toHaveLength(0);
	});
	test("abort during fresh ownership lookup prevents subsequent token work and discovery", async () => {
		const p = policy(["a"]);
		fresh.set("a", { apiKey: "old-key", createdAt: 0 });
		const ctx = context(p);
		const abort = new AbortController();
		let release!: (value: Account) => void;
		ctx.dbOps.getAccount = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const pending = prepareNativeQualityCatalogs(
			ctx,
			p,
			intent,
			[account("a")],
			{
				signal: abort.signal,
				allowOAuth: true,
			},
		);
		abort.abort();
		await pending;
		let credentialReads = 0;
		const current = account("a");
		Object.defineProperty(current, "api_key", {
			get: () => {
				credentialReads++;
				return "key";
			},
		});
		release(current);
		await Promise.resolve();
		await Promise.resolve();
		expect(credentialReads).toBe(0);
		expect(calls).toHaveLength(0);
	});
	test("policy changes prevent queued work and initial revision mismatch is a noop", async () => {
		const p = policy(["a", "b", "c"]);
		let current = p;
		const ctx = {
			config: { getQualityRoutingPolicy: () => current },
		} as unknown as ProxyContext;
		discover = async () => {
			current = { ...p, revision: "quality-policy-v1:changed" };
		};
		await prepareNativeQualityCatalogs(
			ctx,
			p,
			intent,
			[account("a"), account("b"), account("c")],
			options(),
		);
		expect(calls.map((c) => c.accountId)).toEqual(["a"]);
		calls.length = 0;
		await prepareNativeQualityCatalogs(
			ctx,
			p,
			intent,
			[account("a")],
			options(),
		);
		expect(calls).toHaveLength(0);
	});
	test("concurrency is two and caller abort cancels both children and stops the queue", async () => {
		const p = policy(["a", "b", "c"]);
		const controller = new AbortController();
		discover = (signal) =>
			new Promise((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		const pending = prepareNativeQualityCatalogs(
			context(p),
			p,
			intent,
			[account("a"), account("b"), account("c")],
			{ signal: controller.signal },
		);
		await Promise.resolve();
		expect(calls).toHaveLength(2);
		controller.abort();
		await pending;
		expect(calls).toHaveLength(2);
		expect(calls.every((c) => c.signal?.aborted)).toBe(true);
		calls.length = 0;
		await prepareNativeQualityCatalogs(context(p), p, intent, [account("a")], {
			signal: controller.signal,
		});
		expect(calls).toHaveLength(0);
	});
	test("fetch rejection is best effort and queued evidence is rechecked", async () => {
		const p = policy(["a", "b", "c"]);
		discover = async () => {
			fresh.set("c", { apiKey: "synthetic-c", createdAt: 1 });
			throw new Error("unavailable");
		};
		await prepareNativeQualityCatalogs(
			context(p),
			p,
			intent,
			[account("a"), account("b"), account("c")],
			options(),
		);
		expect(calls.map((c) => c.accountId)).toEqual(["a", "b"]);
	});
	test("one ten-second deadline includes queued work, even if discovery ignores cancellation", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
			delays.push(timeout ?? 0);
			return originalSetTimeout(handler, 5);
		}) as typeof setTimeout;
		try {
			const p = policy(["a", "b", "c"]);
			discover = () => new Promise(() => {});
			await prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a"), account("b"), account("c")],
				options(),
			);
			expect(delays).toEqual([10_000]);
			expect(calls).toHaveLength(2);
			expect(calls.every((c) => c.signal?.aborted)).toBe(true);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});
	describe("owned evidence is authoritative over unrelated pending acquisitions", () => {
		// Bounded by wall time, never the 10s preparation deadline.
		const settlesWithin = async (run: Promise<void>, ms: number) =>
			Promise.race([
				run.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
			]);
		test("fresh credential-owned evidence returns promptly while an unrelated lookup is stuck", async () => {
			const p = policy(["a"]);
			const evidence = { apiKey: "synthetic-a", createdAt: 1 };
			fresh.set("a", evidence);
			// Stands in for an untargeted refresh stuck after selecting this account.
			pendingFor.set("a", new Promise<void>(() => {}));
			const controller = new AbortController();
			const run = prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{ signal: controller.signal, allowOAuth: true },
			);
			try {
				expect(await settlesWithin(run, 300)).toBe(true);
				expect(calls).toHaveLength(0);
				expect(modelCatalog.getNativeAutoCatalogEvidence("a")).toBe(evidence);
			} finally {
				controller.abort();
				await run;
			}
		});
		test("without OAuth permission existing evidence also returns without waiting", async () => {
			const p = policy(["a"]);
			fresh.set("a", { apiKey: "synthetic-a", createdAt: 1 });
			pendingFor.set("a", new Promise<void>(() => {}));
			const controller = new AbortController();
			const run = prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{ signal: controller.signal },
			);
			try {
				expect(await settlesWithin(run, 300)).toBe(true);
				expect(calls).toHaveLength(0);
			} finally {
				controller.abort();
				await run;
			}
		});
		test("unowned evidence still waits for the pending acquisition, rechecks, and does not duplicate the fetch", async () => {
			const p = policy(["a"]);
			fresh.set("a", { apiKey: "old-key", createdAt: 0 });
			let release!: () => void;
			pendingFor.set(
				"a",
				new Promise<void>((resolve) => {
					release = () => {
						pendingFor.delete("a");
						resolve();
					};
				}),
			);
			let done = false;
			const run = prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{ ...options(), allowOAuth: true },
			).then(() => {
				done = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(done).toBe(false);
			expect(calls).toHaveLength(0);
			fresh.set("a", { apiKey: "synthetic-a", createdAt: 1 });
			release();
			await run;
			expect(calls).toHaveLength(0);
		});
		test("missing evidence waits for the pending acquisition and fetches itself when it publishes nothing", async () => {
			const p = policy(["a"]);
			let release!: () => void;
			pendingFor.set(
				"a",
				new Promise<void>((resolve) => {
					release = () => {
						pendingFor.delete("a");
						resolve();
					};
				}),
			);
			const run = prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{ ...options(), allowOAuth: true },
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toHaveLength(0);
			release();
			await run;
			expect(calls.map((c) => c.accountId)).toEqual(["a"]);
		});
	});
	describe("persisted conversation home is acquired first", () => {
		type Home = {
			accountId?: string;
			provider?: string;
			line?: string;
			lane?: string;
			intentRevision?: string;
		};
		const conversation = (home: Home = {}) =>
			({
				revision: "r1",
				home: {
					intentRevision: home.intentRevision ?? "r1",
					target: {
						accountId: home.accountId ?? "h",
						provider: home.provider ?? "anthropic",
						line: home.line ?? "claude-opus",
						lane: home.lane ?? "opus",
						physicalModel: "synthetic-model",
					},
				},
			}) as never;
		const ranked = () => [
			account("a", { priority: 0 }),
			account("b", { priority: 1 }),
			account("h", { priority: 2 }),
		];
		// a and b stall until aborted; h publishes owned evidence at once.
		const stallAllButHome = () => {
			discover = (signal) => {
				const id = calls[calls.length - 1].accountId as string;
				if (id === "h") {
					fresh.set("h", { apiKey: "synthetic-h", createdAt: 1 });
					return Promise.resolve();
				}
				return new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			};
		};
		const run = async (
			p: QualityRoutingPolicy,
			accounts: Account[],
			conv: unknown,
			prepIntent: Parameters<typeof prepareNativeQualityCatalogs>[2] = intent,
		) => {
			const controller = new AbortController();
			const pending = prepareNativeQualityCatalogs(
				context(p),
				p,
				prepIntent,
				accounts,
				{
					signal: controller.signal,
					allowOAuth: true,
					conversation: conv,
				} as never,
			);
			await new Promise((resolve) => setTimeout(resolve, 30));
			controller.abort();
			await pending;
		};
		test("a valid home last in priority order is started first and gets owned evidence while higher-priority lookups stall", async () => {
			const p = policy(["a", "b", "h"]);
			stallAllButHome();
			await run(p, ranked(), conversation());
			expect(calls[0].accountId).toBe("h");
			expect(fresh.has("h")).toBe(true);
			expect(calls.map((c) => c.accountId).toSorted()).toEqual(["a", "b", "h"]);
		});
		test("a worker intent's descendant home gets the same treatment", async () => {
			const p = policy(["a", "b", "h"]);
			stallAllButHome();
			await run(
				p,
				ranked(),
				conversation({ line: "claude-sonnet", lane: "standard" }),
				{ kind: "worker", role: "standard" },
			);
			expect(calls[0].accountId).toBe("h");
			expect(fresh.has("h")).toBe(true);
		});
		test.each([
			["null conversation", () => null, () => ranked(), undefined],
			[
				"revision mismatch",
				() => conversation({ intentRevision: "r0" }),
				() => ranked(),
				undefined,
			],
			[
				"provider mismatch",
				() => conversation({ provider: "codex" }),
				() => ranked(),
				undefined,
			],
			[
				"out-of-lane home",
				() => conversation({ line: "claude-sonnet", lane: "standard" }),
				() => ranked(),
				{ kind: "main", preference: "opus" },
			],
			[
				"line not enrolled for the home account",
				() => conversation(),
				() => ranked(),
				"enroll-sonnet-only",
			],
			[
				"ineligible (paused) home account",
				() => conversation(),
				() => [
					account("a", { priority: 0 }),
					account("b", { priority: 1 }),
					account("h", { priority: 2, paused: true }),
				],
				undefined,
			],
		] as const)("%s is not promoted: normal order applies", async (_label, conv, accts, variant) => {
			let p = policy(["a", "b", "h"]);
			if (variant === "enroll-sonnet-only")
				p = {
					...p,
					accounts: p.accounts.map((e) =>
						e.accountId === "h" ? { ...e, lines: ["claude-sonnet"] } : e,
					),
				};
			stallAllButHome();
			await run(
				p,
				accts() as Account[],
				conv(),
				variant && typeof variant === "object"
					? (variant as typeof intent)
					: intent,
			);
			expect(calls.slice(0, 2).map((c) => c.accountId)).toEqual(["a", "b"]);
			expect(
				calls.map((c) => c.accountId).filter((id) => id === "h").length,
			).toBeLessThanOrEqual(1);
		});
	});
	describe("obsolete native catalog generation", () => {
		const obsolete = () =>
			new modelCatalog.NativeCatalogObsoleteGenerationError();
		test("waits for the newer acquisition and rechecks owned evidence instead of returning", async () => {
			const p = policy(["a"]);
			let release!: () => void;
			discover = async () => {
				pendingFor.set(
					"a",
					new Promise<void>((resolve) => {
						release = () => {
							pendingFor.delete("a");
							resolve();
						};
					}),
				);
				throw obsolete();
			};
			let done = false;
			const run = prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{ ...options(), allowOAuth: true },
			).then(() => {
				done = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(done).toBe(false);
			expect(calls).toHaveLength(1);
			fresh.set("a", { apiKey: "synthetic-a", createdAt: 1 });
			release();
			await run;
			expect(calls).toHaveLength(1);
		});
		test("a newer acquisition that settles without evidence leads the waiter to fetch itself", async () => {
			const p = policy(["a"]);
			let first = true;
			discover = async () => {
				if (!first) return;
				first = false;
				pendingFor.set("a", Promise.resolve());
				throw obsolete();
			};
			await prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{
					...options(),
					allowOAuth: true,
				},
			);
			expect(calls).toHaveLength(2);
		});
		test("the attempt cap bounds repeated obsolescence", async () => {
			const p = policy(["a"]);
			discover = async () => {
				throw obsolete();
			};
			await prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{
					...options(),
					allowOAuth: true,
				},
			);
			expect(calls).toHaveLength(3);
		});
		test("caller cancellation bounds a wait on a pending acquisition that never settles", async () => {
			const p = policy(["a"]);
			const controller = new AbortController();
			discover = async () => {
				pendingFor.set("a", new Promise<void>(() => {}));
				throw obsolete();
			};
			const run = prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{ signal: controller.signal, allowOAuth: true },
			);
			await new Promise((resolve) => setTimeout(resolve, 5));
			controller.abort();
			await run;
			expect(calls).toHaveLength(1);
		});
		test("non-obsolete errors return immediately without retrying", async () => {
			const p = policy(["a"]);
			discover = async () => {
				throw new Error("unavailable");
			};
			await prepareNativeQualityCatalogs(
				context(p),
				p,
				intent,
				[account("a")],
				{
					...options(),
					allowOAuth: true,
				},
			);
			expect(calls).toHaveLength(1);
		});
	});
});
