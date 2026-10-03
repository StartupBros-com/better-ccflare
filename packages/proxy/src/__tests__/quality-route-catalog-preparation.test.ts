import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Account, QualityRoutingPolicy } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers/proxy-types";

const fresh = new Map<string, { apiKey: string; createdAt: number }>();
const calls: {
	accountId?: string;
	allowOAuth?: boolean;
	signal?: AbortSignal;
}[] = [];
let discover: (signal: AbortSignal) => Promise<void>;
mock.module("../model-catalog", () => ({
	getNativeAutoCatalogEvidence: (id: string) => fresh.get(id) ?? null,
	validateNativeAutoCatalogCredentials: (
		evidence: { apiKey: string; createdAt: number } | null,
		selected: { account: Account; accessToken: string },
	) =>
		evidence !== null &&
		fresh.get(selected.account.id) === evidence &&
		evidence.apiKey === selected.account.api_key &&
		evidence.createdAt === selected.account.created_at &&
		selected.accessToken === "",
	fetchLiveModels: async (_ctx: unknown, options: (typeof calls)[number]) => {
		calls.push(options);
		await discover(options.signal as AbortSignal);
		return [];
	},
}));
const { prepareNativeQualityCatalogs } = await import(
	"../quality-route-catalog-preparation"
);

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
	discover = async () => {};
});

describe("native quality catalog preparation (metadata mocks only)", () => {
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
});
