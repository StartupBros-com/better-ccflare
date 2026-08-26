import { afterEach, describe, expect, it, mock } from "bun:test";
import { clearAllProbeBackoff, isProbeBackedOff } from "@better-ccflare/core";
import {
	AUTO_REFRESH_PROMPTS,
	claimAutoRefreshPrompt,
	resetAutoRefreshPromptPoolForTests,
} from "../auto-refresh-prompt-pool";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";

type AccountRow = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
	created_at: number;
};

type TestableScheduler = AutoRefreshScheduler & {
	sendDummyMessage(row: AccountRow): Promise<boolean>;
	consecutiveFailures: Map<string, number>;
	uncountedProbeFailures: Map<string, { at: number; streak: number }>;
	lastRefreshResetTime: Map<string, number>;
	accountTokens: Map<string, object>;
	recordRefreshFailure(
		accountId: string,
		accountName: string,
		context: string,
		isCurrent?: () => Promise<boolean>,
		createdAt?: number | null,
	): Promise<void>;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "account-1",
		name: "account one",
		provider: "anthropic",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		created_at: 100,
		...overrides,
	};
}

async function makeScheduler(row: AccountRow) {
	const runs: Array<[string, unknown[]]> = [];
	const db = {
		get: mock(async () => ({ created_at: row.created_at })),
		run: mock(async (sql: string, params: unknown[]) => {
			runs.push([sql, params]);
		}),
		runWithChanges: mock(async () => 1),
		query: mock(async () => []),
	};
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	const scheduler = new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test" },
			refreshInFlight: new Map(),
			internalProbeSecret: "test",
			dbOps: {
				getAccount: mock(async (accountId: string) =>
					accountId === row.id ? { ...row } : null,
				),
				recordUsageSnapshot: mock(async () => {}),
				updateAccountTokensIfRefreshTokenMatches: mock(async () => true),
				updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
			},
		} as never,
	) as TestableScheduler;
	return { scheduler, db, runs };
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	clearAllProbeBackoff();
	resetAutoRefreshPromptPoolForTests();
});

describe("AutoRefreshScheduler account-generation fences", () => {
	it("clearAccountTracking retires the probe token and clears every account-local group", () => {
		const scheduler = {
			clearAccountTracking: (
				AutoRefreshScheduler.prototype as unknown as {
					clearAccountTracking(accountId: string): void;
				}
			).clearAccountTracking,
			lastRefreshResetTime: new Map([["account-1", 10]]),
			consecutiveFailures: new Map([["account-1", 2]]),
			lastFailureProbeAt: new Map([["account-1", 3]]),
			uncountedProbeFailures: new Map([["account-1", { at: 4, streak: 5 }]]),
			accountTokens: new Map([["account-1", {}]]),
		};

		scheduler.clearAccountTracking("account-1");

		expect(scheduler.lastRefreshResetTime.has("account-1")).toBe(false);
		expect(scheduler.consecutiveFailures.has("account-1")).toBe(false);
		expect(scheduler.lastFailureProbeAt.has("account-1")).toBe(false);
		expect(scheduler.uncountedProbeFailures.has("account-1")).toBe(false);
		expect(scheduler.accountTokens.has("account-1")).toBe(false);
	});

	it("refreshes an expiring ordinary token for its current generation", async () => {
		const row = makeRow({ expires_at: Date.now() + 60_000 });
		const { scheduler, db } = await makeScheduler(row);
		db.get.mockImplementation(async () => ({
			created_at: String(row.created_at),
		}));
		const dbOps = (
			scheduler as unknown as {
				proxyContext: { dbOps: Record<string, ReturnType<typeof mock>> };
			}
		).proxyContext.dbOps;
		let requestCount = 0;
		globalThis.fetch = mock(async () => {
			requestCount += 1;
			if (requestCount === 1) return new Response("ok", { status: 200 });
			if (requestCount === 2) {
				return new Response(
					JSON.stringify({
						access_token: "refreshed-access-token",
						refresh_token: "rotated-refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		expect(await scheduler.sendDummyMessage(row)).toBe(true);
		expect(db.get).toHaveBeenCalledWith(
			"SELECT created_at FROM accounts WHERE id = ?",
			[row.id],
		);
		expect(dbOps.updateAccountTokensIfRefreshTokenMatches).toHaveBeenCalledWith(
			row.id,
			row.refresh_token,
			"refreshed-access-token",
			expect.any(Number),
			"rotated-refresh-token",
			row.created_at,
		);
	});

	it("does not create tracking for a row deleted before its probe starts", async () => {
		const row = makeRow();
		const { scheduler, db } = await makeScheduler(row);
		db.get.mockImplementation(async () => undefined);

		scheduler.clearAccountTracking(row.id);
		await scheduler.sendDummyMessage(row);

		expect(scheduler.accountTokens.has(row.id)).toBe(false);
	});

	it("rejects a same-ID replacement before sending a probe", async () => {
		const row = makeRow();
		const { scheduler, db } = await makeScheduler(row);
		const fetchMock = mock(async () => new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		db.get.mockImplementation(async () => ({ created_at: row.created_at + 1 }));

		expect(await scheduler.sendDummyMessage(row)).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(scheduler.accountTokens.has(row.id)).toBe(false);
	});

	it("releases a stale pre-fetch prompt claim without issuing a request", async () => {
		const row = makeRow();
		const { scheduler, db } = await makeScheduler(row);
		const fetchMock = mock(async () => new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		let currentnessChecks = 0;
		db.get.mockImplementation(async () => {
			currentnessChecks += 1;
			return {
				created_at:
					currentnessChecks === 3 ? row.created_at + 1 : row.created_at,
			};
		});
		const originalRandom = Math.random;
		Math.random = () => 0;
		try {
			expect(await scheduler.sendDummyMessage(row)).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(claimAutoRefreshPrompt()).toEqual({
				ok: true,
				index: 0,
				prompt: AUTO_REFRESH_PROMPTS[0],
			});
		} finally {
			Math.random = originalRandom;
		}
	});

	it("does not retain uncounted failure or probe backoff from a retired probe", async () => {
		const row = makeRow();
		const { scheduler } = await makeScheduler(row);
		const response = deferred<Response>();
		globalThis.fetch = mock(
			async () => response.promise,
		) as unknown as typeof fetch;

		const pending = scheduler.sendDummyMessage(row);
		await Promise.resolve();
		scheduler.clearAccountTracking(row.id);
		response.resolve(new Response("overloaded", { status: 529 }));
		await pending;

		expect(scheduler.uncountedProbeFailures.has(row.id)).toBe(false);
		expect(isProbeBackedOff(row.id)).toBe(false);
	});

	it("does not retain a counted failure from a retired probe", async () => {
		const row = makeRow();
		const { scheduler } = await makeScheduler(row);
		const response = deferred<Response>();
		globalThis.fetch = mock(
			async () => response.promise,
		) as unknown as typeof fetch;

		const pending = scheduler.sendDummyMessage(row);
		await Promise.resolve();
		scheduler.clearAccountTracking(row.id);
		response.resolve(new Response("failure", { status: 500 }));
		await pending;

		expect(scheduler.consecutiveFailures.has(row.id)).toBe(false);
	});

	it("does not write success state after a replacement retires the probe", async () => {
		const row = makeRow();
		const { scheduler, runs } = await makeScheduler(row);
		const body = deferred<string>();
		globalThis.fetch = mock(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							body.promise.then((text) => {
								controller.enqueue(new TextEncoder().encode(text));
								controller.close();
							});
						},
					}),
					{ status: 200 },
				),
		) as unknown as typeof fetch;

		const pending = scheduler.sendDummyMessage(row);
		await Promise.resolve();
		scheduler.clearAccountTracking(row.id);
		body.resolve("ok");
		await pending;

		expect(runs).toHaveLength(0);
		expect(scheduler.lastRefreshResetTime.has(row.id)).toBe(false);
	});

	it("does not auto-resume an overage-paused replacement after a stale probe", async () => {
		const row = makeRow({
			paused: 1,
			auto_pause_on_overage_enabled: 1,
			pause_reason: "overage",
		});
		const { scheduler, db, runs } = await makeScheduler(row);
		globalThis.fetch = mock(
			async () => new Response("ok", { status: 200 }),
		) as unknown as typeof fetch;
		let retired = false;
		db.run.mockImplementation(async (sql: string, params: unknown[]) => {
			runs.push([sql, params]);
			if (!retired && sql.includes("rate_limited_until = NULL")) {
				retired = true;
				scheduler.clearAccountTracking(row.id);
			}
		});

		await scheduler.sendDummyMessage(row);

		expect(retired).toBe(true);
		expect(
			runs.some(([sql]) => sql.includes("UPDATE accounts SET paused = 0")),
		).toBe(false);
	});

	it("does not let a stale failure-threshold write clear replacement failure state", async () => {
		const row = makeRow();
		const writeStarted = deferred<void>();
		const finishWrite = deferred<number>();
		const runs: Array<[string, unknown[]]> = [];
		const db = {
			get: mock(async () => ({ created_at: row.created_at })),
			run: mock(async () => {}),
			runWithChanges: mock(async (sql: string, params: unknown[]) => {
				runs.push([sql, params]);
				writeStarted.resolve();
				return finishWrite.promise;
			}),
			query: mock(async () => []),
		};
		const scheduler = new AutoRefreshScheduler(
			db as never,
			{
				runtime: { port: 8080, clientId: "test" },
				refreshInFlight: new Map(),
				internalProbeSecret: "test",
				dbOps: { recordUsageSnapshot: mock(async () => {}) },
			} as never,
		) as TestableScheduler;
		scheduler.consecutiveFailures.set(row.id, 4);
		const probeToken = {};
		scheduler.accountTokens.set(row.id, probeToken);
		const isCurrent = async () =>
			scheduler.accountTokens.get(row.id) === probeToken;

		const pending = scheduler.recordRefreshFailure(
			row.id,
			row.name,
			"(test)",
			isCurrent,
			row.created_at,
		);
		await writeStarted.promise;
		scheduler.clearAccountTracking(row.id);
		scheduler.consecutiveFailures.set(row.id, 2);
		finishWrite.resolve(1);
		await pending;

		expect(scheduler.consecutiveFailures.get(row.id)).toBe(2);
		expect(runs).toHaveLength(1);
		expect(runs[0][0]).toContain("created_at = ?");
		expect(runs[0][1]).toEqual([row.id, row.created_at]);
	});
});
