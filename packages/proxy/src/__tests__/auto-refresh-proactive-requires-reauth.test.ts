import { afterEach, describe, expect, it, mock } from "bun:test";
import { type AuthFailureEvt, authFailureEvents } from "@better-ccflare/core";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// These tests drive the REAL xAI/Codex providers (via row.provider) and mock
// global.fetch to return an OAuth error, so the whole provider→scheduler detection
// chain is exercised without mock.module (which leaks across proxy test files).

interface ProactiveRow {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	custom_endpoint: string | null;
	created_at?: number | string;
}

function makeDb(queryRows: ProactiveRow[]) {
	const rows = queryRows.map((row) => ({
		...row,
		created_at: row.created_at ?? 101,
	}));
	const runCalls: Array<[string, unknown[]]> = [];
	const queries: string[] = [];
	const flagCalls: Array<[string, string, number]> = [];
	const persistCalls: Array<
		[string, string, string, number, string | undefined, number]
	> = [];
	const db = {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async (sql: string) => {
			queries.push(sql);
			return rows;
		}),
	};
	const dbOps = {
		getAccount: mock(
			async (accountId: string): Promise<Record<string, unknown> | null> => {
				const row = rows.find((candidate) => candidate.id === accountId);
				return row ? { ...row, created_at: Number(row.created_at) } : null;
			},
		),
		// flagIfDefinitiveAuthFailure persists requires_reauth via this CAS
		// helper — return true so the write reports as "landed" (matches the
		// real UPDATE ... WHERE refresh_token = ? matching the row's current
		// token in these fixtures).
		flagRequiresReauthIfTokenMatches: mock(
			async (
				accountId: string,
				expectedRefreshToken: string,
				expectedCreatedAt: number,
			) => {
				flagCalls.push([accountId, expectedRefreshToken, expectedCreatedAt]);
				return true;
			},
		),
		// The proactive persist paths route their token-rotation CAS write
		// through this helper too — return true so it reports as "landed"
		// (these tests only exercise the failure path, so it's never asserted
		// on directly, but must resolve for the success branch to log cleanly).
		updateAccountTokensIfRefreshTokenMatches: mock(
			async (
				accountId: string,
				expectedRefreshToken: string,
				accessToken: string,
				expiresAt: number,
				refreshToken: string | undefined,
				expectedCreatedAt: number,
			) => {
				persistCalls.push([
					accountId,
					expectedRefreshToken,
					accessToken,
					expiresAt,
					refreshToken,
					expectedCreatedAt,
				]);
				return true;
			},
		),
		updateAccountTokensIfRefreshTokenAbsent: mock(async () => true),
	};
	return { db, dbOps, runCalls, flagCalls, persistCalls, queries };
}

function makeScheduler(db: unknown, dbOps: unknown) {
	return new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			dbOps,
		} as never,
	) as unknown as {
		checkAndRefreshOpenAICompatibleOAuthTokens(): Promise<void>;
		checkAndRefreshCodexTokens(): Promise<void>;
	};
}

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
});

describe("AutoRefreshScheduler proactive refresh — requires_reauth guard", () => {
	it("excludes flagged accounts from the OpenAI-compatible eligibility query", async () => {
		const { db, dbOps, queries } = makeDb([]);
		const scheduler = makeScheduler(db, dbOps);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		const sql = queries.find((q) => q.includes("'qwen', 'xai'"));
		expect(sql).toBeDefined();
		expect(sql).toContain("COALESCE(requires_reauth, 0) = 0");
		expect(sql).toContain("created_at");
	});

	it("excludes flagged accounts from the Codex eligibility query", async () => {
		const { db, dbOps, queries } = makeDb([]);
		const scheduler = makeScheduler(db, dbOps);

		await scheduler.checkAndRefreshCodexTokens();

		const sql = queries.find((q) => q.includes("provider = 'codex'"));
		expect(sql).toBeDefined();
		expect(sql).toContain("COALESCE(requires_reauth, 0) = 0");
		expect(sql).toContain("created_at");
	});
});

describe("AutoRefreshScheduler proactive refresh — CAS loser adoption", () => {
	for (const provider of ["xai", "codex"] as const) {
		it(`serves the authoritative DB token when ${provider} refresh persistence loses its CAS`, async () => {
			const id = `${provider}-cas-loser`;
			const { db, dbOps } = makeDb([
				{
					id,
					name: id,
					provider,
					refresh_token: "rt-old",
					access_token: "at-old",
					expires_at: 1,
					custom_endpoint: null,
				},
			]);
			dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => false);
			let releaseAuthoritativeRead: (() => void) | undefined;
			const authoritativeReadGate = new Promise<void>((resolve) => {
				releaseAuthoritativeRead = resolve;
			});
			dbOps.getAccount = mock(async () => {
				await authoritativeReadGate;
				return {
					created_at: 101,
					access_token: "authoritative-access",
					expires_at: Date.now() + 3_600_000,
				};
			});
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "losing-access",
							refresh_token: "losing-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			) as unknown as typeof fetch;

			const scheduler = makeScheduler(db, dbOps);
			const run =
				provider === "codex"
					? scheduler.checkAndRefreshCodexTokens()
					: scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();
			const inFlight = (
				scheduler as unknown as {
					proxyContext: { refreshInFlight: Map<string, Promise<string>> };
				}
			).proxyContext.refreshInFlight;
			for (let attempt = 0; attempt < 10 && !inFlight.has(id); attempt++) {
				await Promise.resolve();
			}
			const joined = inFlight.get(id);
			expect(joined).toBeDefined();
			releaseAuthoritativeRead?.();
			expect(await joined).toBe("authoritative-access");
			await run;
			expect(
				dbOps.updateAccountTokensIfRefreshTokenMatches,
			).toHaveBeenCalledWith(
				id,
				"rt-old",
				"losing-access",
				expect.any(Number),
				"losing-refresh",
				101,
			);
		});
	}

	it("rejects a CAS-losing scheduler promise when the authoritative token is unusable", async () => {
		const id = "codex-cas-loser-expired";
		const { db, dbOps } = makeDb([
			{
				id,
				name: id,
				provider: "codex",
				refresh_token: "rt-old",
				access_token: "at-old",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		dbOps.updateAccountTokensIfRefreshTokenMatches = mock(async () => false);
		dbOps.getAccount = mock(async () => ({
			created_at: 101,
			access_token: "expired-authoritative-access",
			expires_at: Date.now() - 1,
		}));
		global.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						access_token: "losing-access",
						refresh_token: "losing-refresh",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const scheduler = makeScheduler(db, dbOps);
		await scheduler.checkAndRefreshCodexTokens();
		expect(dbOps.getAccount).toHaveBeenCalledWith(id);
	});
});

describe("AutoRefreshScheduler proactive refresh — PostgreSQL generation rows", () => {
	for (const provider of ["qwen", "xai", "codex"] as const) {
		it(`persists ${provider} refreshes selected from a BIGINT-string generation`, async () => {
			const id = `${provider}-bigint-generation`;
			const { db, dbOps, persistCalls } = makeDb([
				{
					id,
					name: id,
					provider,
					refresh_token: "rt-old",
					access_token: "at-old",
					expires_at: 1,
					custom_endpoint: null,
					created_at: "101",
				},
			]);
			global.fetch = mock(
				async () =>
					new Response(
						JSON.stringify({
							access_token: "refreshed-access",
							refresh_token: "refreshed-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			) as unknown as typeof fetch;

			const scheduler = makeScheduler(db, dbOps);
			await (provider === "codex"
				? scheduler.checkAndRefreshCodexTokens()
				: scheduler.checkAndRefreshOpenAICompatibleOAuthTokens());

			expect(persistCalls).toHaveLength(1);
			expect(persistCalls[0]?.[5]).toBe(101);
		});
	}
});

describe("AutoRefreshScheduler proactive refresh — generation fence", () => {
	for (const provider of ["qwen", "xai", "codex"] as const) {
		it(`does not quarantine replacement generation B when ${provider} fails after A was selected`, async () => {
			const id = `${provider}-stale-generation`;
			const { db, dbOps, flagCalls, persistCalls } = makeDb([
				{
					id,
					name: id,
					provider,
					refresh_token: "refresh-a",
					access_token: "access-a",
					expires_at: 1,
					custom_endpoint: null,
					created_at: 101,
				},
			]);
			dbOps.getAccount = mock(async () => ({
				id,
				created_at: 202,
				refresh_token: "refresh-b",
				access_token: "access-b",
				expires_at: Date.now() + 3_600_000,
			}));
			global.fetch = mock(
				async () =>
					new Response(JSON.stringify({ error: "invalid_grant" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			) as unknown as typeof fetch;

			const scheduler = makeScheduler(db, dbOps);
			await (provider === "codex"
				? scheduler.checkAndRefreshCodexTokens()
				: scheduler.checkAndRefreshOpenAICompatibleOAuthTokens());

			expect(flagCalls).toHaveLength(0);
			expect(persistCalls).toHaveLength(0);
		});
	}
});

describe("AutoRefreshScheduler proactive refresh — definitive auth failure", () => {
	it("flags an xAI account whose proactive refresh returns invalid_grant and emits the event", async () => {
		const { db, dbOps, flagCalls } = makeDb([
			{
				id: "xai-dead",
				name: "xai-dead",
				provider: "xai",
				refresh_token: "rt",
				access_token: "at",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		global.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "Refresh token is invalid or has been revoked.",
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		const scheduler = makeScheduler(db, dbOps);
		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(flagCalls).toEqual([["xai-dead", "rt", 101]]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			accountId: "xai-dead",
			provider: "xai",
			reason: "invalid_grant",
		});
	});

	it("flags a Codex account whose proactive refresh returns refresh_token_reused", async () => {
		const { db, dbOps, flagCalls } = makeDb([
			{
				id: "codex-dead",
				name: "codex-dead",
				provider: "codex",
				refresh_token: "rt",
				access_token: "at",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		global.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "refresh_token_reused" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const emitted: AuthFailureEvt[] = [];
		authFailureEvents.once("event", (event) => emitted.push(event));

		const scheduler = makeScheduler(db, dbOps);
		await scheduler.checkAndRefreshCodexTokens();

		expect(flagCalls).toEqual([["codex-dead", "rt", 101]]);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.reason).toBe("refresh_token_reused");
	});

	it("does NOT flag a proactive refresh that fails with a transient network error", async () => {
		const { db, dbOps, flagCalls } = makeDb([
			{
				id: "codex-net",
				name: "codex-net",
				provider: "codex",
				refresh_token: "rt",
				access_token: "at",
				expires_at: 1,
				custom_endpoint: null,
			},
		]);
		// A 5xx with no OAuth error code — a transient upstream failure.
		global.fetch = mock(
			async () => new Response("Service Unavailable", { status: 503 }),
		) as unknown as typeof fetch;
		let emittedCount = 0;
		const listener = () => {
			emittedCount++;
		};
		authFailureEvents.on("event", listener);

		try {
			const scheduler = makeScheduler(db, dbOps);
			await scheduler.checkAndRefreshCodexTokens();
		} finally {
			authFailureEvents.off("event", listener);
		}

		expect(flagCalls).toHaveLength(0);
		expect(emittedCount).toBe(0);
	});
});
