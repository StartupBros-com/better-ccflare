/**
 * Regression coverage for proactive OAuth refresh eligibility.
 *
 * The proactive xAI/Qwen and Codex paths run on every scheduler heartbeat,
 * independently from the guarded usage-window probe path. Paused accounts must
 * not enter these token-refresh queries: a terminal refresh token otherwise
 * retries forever, while a manual pause unexpectedly keeps contacting upstream.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { BunSqlAdapter } from "../../../database/src/adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../../database/src/migrations";

interface RefreshProvider {
	refreshToken(account: { id: string }): Promise<{
		accessToken: string;
		expiresAt: number;
		refreshToken: string;
	}>;
}

const providers = new Map<string, RefreshProvider>();
mock.module("@better-ccflare/providers", () => ({
	fetchUsageData: mock(async () => ({ data: null, retryAfterMs: null })),
	getProvider: (name: string) => providers.get(name),
}));
mock.module("../handlers", () => ({
	getValidAccessToken: mock(async () => null),
	pauseAccountForReauthIfInvalidGrant: mock(async () => false),
}));

interface AccountSeed {
	id: string;
	provider: "codex" | "xai";
	paused: number;
	pauseReason: string | null;
}

function seedAccount(db: Database, seed: AccountSeed): void {
	db.run(
		`INSERT INTO accounts (
			id, name, provider, refresh_token, access_token, expires_at,
			created_at, paused, pause_reason
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			seed.id,
			seed.id,
			seed.provider,
			`refresh-${seed.id}`,
			seed.paused ? null : `access-${seed.id}`,
			seed.paused ? null : Date.now() + 1_000,
			Date.now(),
			seed.paused,
			seed.pauseReason,
		],
	);
}

async function makeScheduler(sqliteDb: Database) {
	const adapter = new BunSqlAdapter(sqliteDb);
	const proxyContext = {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
		dbOps: { pauseAccountIfActive: mock(async () => false) },
	};
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		adapter as never,
		proxyContext as never,
	) as unknown as {
		checkAndRefreshOpenAICompatibleOAuthTokens(): Promise<void>;
		checkAndRefreshCodexTokens(): Promise<void>;
	};
}

describe("AutoRefreshScheduler proactive OAuth refresh pause exclusion", () => {
	it("skips terminally and manually paused accounts while refreshing active accounts", async () => {
		providers.clear();
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		for (const provider of ["xai", "codex"] as const) {
			seedAccount(db, {
				id: `${provider}-oauth-invalid`,
				provider,
				paused: 1,
				pauseReason: "oauth_invalid_grant",
			});
			seedAccount(db, {
				id: `${provider}-manual`,
				provider,
				paused: 1,
				pauseReason: "manual",
			});
			seedAccount(db, {
				id: `${provider}-active`,
				provider,
				paused: 0,
				pauseReason: null,
			});
		}

		const refreshAttempts: string[] = [];
		const refreshToken = mock(async (account: { id: string }) => {
			refreshAttempts.push(account.id);
			if (!account.id.endsWith("-active")) {
				throw new Error("paused account must not be refreshed");
			}
			return {
				accessToken: `new-access-${account.id}`,
				expiresAt: Date.now() + 3_600_000,
				refreshToken: `new-refresh-${account.id}`,
			};
		});
		providers.set("xai", { refreshToken });
		providers.set("codex", { refreshToken });

		const scheduler = await makeScheduler(db);
		for (let tick = 0; tick < 2; tick++) {
			await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();
			await scheduler.checkAndRefreshCodexTokens();
		}

		expect(
			refreshAttempts.filter((id) => id.includes("oauth-invalid")),
		).toEqual([]);
		expect(refreshAttempts.filter((id) => id.includes("manual"))).toEqual([]);
		expect(
			refreshAttempts.filter((id) => id.endsWith("-active")).sort(),
		).toEqual(["codex-active", "xai-active"]);

		db.close();
	});
});
