import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Account, QualityRoutingPolicy } from "@better-ccflare/types";
import * as codexCatalog from "../codex-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";
import * as modelCatalog from "../model-catalog";

// Combined native+Codex preparation for one Auto request: one queue in compile
// order across providers, one two-worker runner and one queue-inclusive budget.
// Metadata acquisition is mocked at the module boundary (scoped spies, restored
// in afterAll); no account, token or fetch is real.
const starts: string[] = [];
const calls: { accountId?: string; allowOAuth?: boolean }[] = [];
const ensures: { accountId: string; force: boolean }[] = [];
let discover: (accountId: string, signal: AbortSignal) => Promise<void>;
let ensureRun: (accountId: string) => Promise<void>;
const spies = [
	spyOn(codexCatalog, "getCodexAutoCatalogEvidence").mockImplementation(
		(() => null) as never,
	),
	spyOn(codexCatalog, "getPendingCodexCatalogAcquisition").mockImplementation(
		(() => undefined) as never,
	),
	spyOn(codexCatalog, "ensureCodexModelDefaults").mockImplementation(((
		account: Account,
		_ctx: unknown,
		_now: unknown,
		force: boolean,
	) => {
		starts.push(account.id);
		ensures.push({ accountId: account.id, force });
		return ensureRun(account.id);
	}) as never),
	spyOn(modelCatalog, "getNativeAutoCatalogEvidence").mockImplementation(
		(() => null) as never,
	),
	spyOn(modelCatalog, "getPendingNativeCatalogAcquisition").mockImplementation(
		(() => undefined) as never,
	),
	spyOn(modelCatalog, "fetchLiveModels").mockImplementation((async (
		_ctx: unknown,
		options: { accountId: string; allowOAuth?: boolean; signal: AbortSignal },
	) => {
		starts.push(options.accountId);
		calls.push({
			accountId: options.accountId,
			allowOAuth: options.allowOAuth,
		});
		await discover(options.accountId, options.signal);
		return [];
	}) as never),
];
afterAll(() => {
	for (const spy of spies) spy.mockRestore();
});

import {
	prepareCodexQualityCatalogs,
	prepareNativeQualityCatalogs,
	prepareQualityCatalogs,
} from "../quality-route-catalog-preparation";

function account(id: string, extra: Partial<Account> = {}): Account {
	return {
		id,
		provider: id.startsWith("n") ? "anthropic" : "codex",
		api_key: `synthetic-${id}`,
		created_at: 1,
		priority: 0,
		paused: false,
		...extra,
	} as Account;
}
// The native opus/standard lanes enrolled for `nativeIds`, then an astra lane
// carrying the Codex line enrolled for `codexIds`, on the auto ladder in that
// order: the compile order a combined queue must follow.
function mixedPolicy(
	nativeIds: string[],
	codexIds: string[],
): QualityRoutingPolicy {
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
			{ line: "gpt-astra", lane: "astra", priority: 0, upgrade: "exact-only" },
		],
		accounts: [
			...nativeIds.map((accountId) => ({
				accountId,
				provider: "anthropic" as const,
				lines: ["claude-opus", "claude-sonnet"],
				priority: 0,
			})),
			...codexIds.map((accountId) => ({
				accountId,
				provider: "codex" as const,
				lines: ["gpt-astra"],
				priority: 0,
			})),
		],
		lanes: {
			opus: ["claude-opus"],
			standard: ["claude-sonnet"],
			lightweight: [],
			astra: ["gpt-astra"],
			fable: [],
		},
		mainLadders: {
			auto: ["opus", "standard", "astra"],
			opus: ["opus"],
			astra: ["astra"],
			fable: [],
		},
		workerLanes: {
			standard: ["standard"],
			lightweight: [],
			opus: ["opus"],
			astra: ["astra"],
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
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const stall = () => new Promise<void>(() => {});
beforeEach(() => {
	starts.length = 0;
	calls.length = 0;
	ensures.length = 0;
	discover = async () => {};
	ensureRun = async () => {};
});

describe("combined quality catalog preparation (metadata mocks only)", () => {
	const p = mixedPolicy(["n1", "n2"], ["c1", "c2"]);
	const accounts = () => [
		account("n1"),
		account("n2"),
		account("c1"),
		account("c2"),
	];
	test("prepares native then Codex accounts in compile order with the caller's OAuth permission and unforced ensures", async () => {
		await prepareQualityCatalogs(context(p), p, intent, accounts(), {
			signal: new AbortController().signal,
			allowOAuth: true,
		});
		expect(starts).toEqual(["n1", "n2", "c1", "c2"]);
		expect(calls).toEqual([
			{ accountId: "n1", allowOAuth: true },
			{ accountId: "n2", allowOAuth: true },
		]);
		expect(ensures).toEqual([
			{ accountId: "c1", force: false },
			{ accountId: "c2", force: false },
		]);
	});
	test("OAuth stays denied by default for native discovery", async () => {
		await prepareQualityCatalogs(context(p), p, intent, accounts(), {
			signal: new AbortController().signal,
		});
		expect(calls.map((c) => c.allowOAuth)).toEqual([false, false]);
		expect(ensures).toHaveLength(2);
	});
	test("one runner across providers: at most two accounts in flight, and caller abort stops the rest", async () => {
		discover = stall;
		ensureRun = stall;
		const controller = new AbortController();
		const pending = prepareQualityCatalogs(context(p), p, intent, accounts(), {
			signal: controller.signal,
		});
		await settle();
		expect(starts).toEqual(["n1", "n2"]);
		expect(ensures).toHaveLength(0);
		controller.abort();
		await pending;
		expect(starts).toEqual(["n1", "n2"]);
	});
	test("a stalled native lookup does not hold the Codex accounts behind it", async () => {
		discover = (id) => (id === "n1" ? stall() : Promise.resolve());
		ensureRun = stall;
		const controller = new AbortController();
		const pending = prepareQualityCatalogs(context(p), p, intent, accounts(), {
			signal: controller.signal,
		});
		await settle(20);
		// n1 occupies one worker; the other drains n2, then c1, then stalls on it.
		expect(starts).toEqual(["n1", "n2", "c1"]);
		expect(ensures).toEqual([{ accountId: "c1", force: false }]);
		controller.abort();
		await pending;
		expect(starts).toEqual(["n1", "n2", "c1"]);
	});
	test("one ten-second budget covers both providers, including queued work", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
			delays.push(timeout ?? 0);
			return originalSetTimeout(handler, 5);
		}) as typeof setTimeout;
		try {
			discover = stall;
			ensureRun = stall;
			await prepareQualityCatalogs(context(p), p, intent, accounts(), {
				signal: new AbortController().signal,
			});
			expect(delays).toEqual([10_000]);
			expect(starts).toEqual(["n1", "n2"]);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});
	test("a policy change between accounts stops the queue for both providers", async () => {
		let current = p;
		const ctx = {
			config: { getQualityRoutingPolicy: () => current },
			dbOps: { getAccount: async (id: string) => account(id) },
		} as unknown as ProxyContext;
		// The second native lookup lands the change; neither Codex account starts.
		discover = async (id) => {
			if (id === "n2")
				current = { ...p, revision: "quality-policy-v1:changed" };
		};
		await prepareQualityCatalogs(ctx, p, intent, accounts(), {
			signal: new AbortController().signal,
		});
		expect(starts).toEqual(["n1", "n2"]);
		expect(ensures).toHaveLength(0);
	});
	test("a valid persisted Codex home is prepared before every native account", async () => {
		const homed = mixedPolicy(["n1", "n2"], ["c1", "h"]);
		const conversation = {
			revision: "r1",
			home: {
				intentRevision: "r1",
				target: {
					accountId: "h",
					provider: "codex",
					line: "gpt-astra",
					lane: "astra",
					physicalModel: "gpt-astra",
				},
			},
		} as never;
		await prepareQualityCatalogs(
			context(homed),
			homed,
			intent,
			[account("n1"), account("n2"), account("c1"), account("h")],
			{ signal: new AbortController().signal, conversation },
		);
		// The two workers dequeue the first two items together, so only the pair
		// is fixed; without promotion the home would start last.
		expect(starts.slice(0, 2).sort()).toEqual(["h", "n1"]);
		expect(starts.slice(2)).toEqual(["n2", "c1"]);
		expect(ensures).toEqual([
			{ accountId: "h", force: false },
			{ accountId: "c1", force: false },
		]);
		expect(calls.map((c) => c.accountId)).toEqual(["n1", "n2"]);
	});
	test("a home enrolled under the other provider is not promoted", async () => {
		const homed = mixedPolicy(["n1", "n2"], ["c1"]);
		const conversation = {
			revision: "r1",
			home: {
				intentRevision: "r1",
				target: {
					accountId: "c1",
					provider: "anthropic",
					line: "claude-opus",
					lane: "opus",
					physicalModel: "claude-opus",
				},
			},
		} as never;
		await prepareQualityCatalogs(
			context(homed),
			homed,
			intent,
			[account("n1"), account("n2"), account("c1")],
			{ signal: new AbortController().signal, conversation },
		);
		expect(starts).toEqual(["n1", "n2", "c1"]);
	});
	test("a ladder without a Codex lane prepares only native accounts", async () => {
		await prepareQualityCatalogs(
			context(p),
			p,
			{ kind: "main", preference: "opus" },
			accounts(),
			{ signal: new AbortController().signal },
		);
		expect(starts).toEqual(["n1", "n2"]);
		expect(ensures).toHaveLength(0);
	});
	describe("the standalone helpers keep their single-provider scope", () => {
		test("native preparation never ensures a Codex account", async () => {
			await prepareNativeQualityCatalogs(context(p), p, intent, accounts(), {
				signal: new AbortController().signal,
				allowOAuth: true,
			});
			expect(starts).toEqual(["n1", "n2"]);
			expect(ensures).toHaveLength(0);
		});
		test("Codex preparation never discovers a native account", async () => {
			await prepareCodexQualityCatalogs(context(p), p, intent, accounts(), {
				signal: new AbortController().signal,
			});
			expect(starts).toEqual(["c1", "c2"]);
			expect(calls).toHaveLength(0);
		});
	});
});
