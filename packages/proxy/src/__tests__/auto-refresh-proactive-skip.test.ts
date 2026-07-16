/**
 * Regression test for the auto-refresh scheduler skipping proactive OAuth
 * token refresh when there are zero usage-window probe candidates.
 *
 * Bug: the early `return` on `accountsToRefresh.length === 0` sat ABOVE the
 * proactive OpenAI-compatible (qwen/xai) and Codex refresh calls, so
 * installs with no due usage-window probes never proactively refreshed
 * those tokens even though the code to do so exists.
 *
 * Fix shape (ported from SijanC147/better-ccflare@2ad55b78): convert the
 * early return into an `if (accountsToRefresh.length > 0) { ... }` block so
 * the proactive refresh calls always run on every scheduler tick.
 */
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { getProvider } from "@better-ccflare/providers";

// Spy on the real, already-registered Codex provider instance instead of
// mocking the whole @better-ccflare/providers module (which re-exports many
// unrelated symbols other test files rely on).
const codexProvider = getProvider("codex");
if (!codexProvider) {
	throw new Error("codex provider not registered");
}
const refreshTokenMock = spyOn(
	codexProvider,
	"refreshToken",
).mockImplementation(async () => ({
	accessToken: "new-access-token",
	expiresAt: Date.now() + 3600_000,
	refreshToken: "new-refresh-token",
}));

type QueryCall = { sql: string; params: unknown[] };

const CODEX_ACCOUNT_ROW = {
	id: "codex-account-1",
	name: "codex-account",
	provider: "codex",
	refresh_token: "refresh-token",
	access_token: "expiring-access-token",
	// Expires within the safety window (well before now + TOKEN_SAFETY_WINDOW_MS)
	expires_at: Date.now() + 1000,
	custom_endpoint: null,
};

// A usage-window probe candidate that survives the main SQL eligibility
// query (so `accounts.length > 0`) but is filtered out by
// shouldRefreshAccount (so `accountsToRefresh.length === 0`). This isolates
// the specific bug under test: the early return keyed on
// accountsToRefresh.length, not the unrelated accounts.length === 0 return
// further up.
const NOW = Date.now();
const ANTHROPIC_ACCOUNT_ROW = {
	id: "anthropic-account-1",
	name: "anthropic-account",
	provider: "anthropic",
	refresh_token: "refresh-token",
	access_token: "access-token",
	expires_at: NOW + 3600_000,
	rate_limit_reset: NOW + 3600_000, // future, unchanged window
	custom_endpoint: null,
	paused: 0,
	auto_pause_on_overage_enabled: 0,
	pause_reason: null,
};

function makeDb() {
	const queryCalls: QueryCall[] = [];
	return {
		query: mock(async (sql: string, ...params: unknown[]) => {
			queryCalls.push({ sql, params: params[0] as unknown[] });

			// Main eligibility query (anthropic/codex/zai usage-window probes):
			// return one account whose window hasn't renewed, so
			// accounts.length > 0 but accountsToRefresh.length === 0 after
			// shouldRefreshAccount filtering.
			if (
				sql.includes("rate_limit_reset") &&
				sql.includes("auto_refresh_enabled") &&
				sql.includes("FROM accounts")
			) {
				return [ANTHROPIC_ACCOUNT_ROW];
			}

			// Zai peak-hours query: no zai accounts.
			if (sql.includes("peak_hours_pause_enabled")) {
				return [];
			}

			// cleanupTracking query: keep the anthropic account "active" so its
			// preset lastRefreshResetTime tracking entry survives cleanup.
			if (
				sql.includes("SELECT id FROM accounts") &&
				sql.includes("auto_refresh_enabled")
			) {
				return [{ id: ANTHROPIC_ACCOUNT_ROW.id }];
			}

			// Proactive Codex token refresh query: one account needing refresh.
			if (sql.includes("provider = 'codex'") && sql.includes("refresh_token")) {
				return [CODEX_ACCOUNT_ROW];
			}

			// Proactive OpenAI-compatible (qwen/xai) refresh query: none.
			if (sql.includes("provider IN ('qwen', 'xai')")) {
				return [];
			}

			// Cleanup query (SELECT id FROM accounts ...)
			return [];
		}),
		run: mock(async () => {}),
		queryCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

describe("AutoRefreshScheduler — proactive refresh must not be skipped", () => {
	beforeEach(() => {
		refreshTokenMock.mockClear();
	});

	it("still proactively refreshes a Codex token when zero usage-window candidates exist", async () => {
		const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
		const db = makeDb();
		const scheduler = new AutoRefreshScheduler(
			db as never,
			makeProxyContext() as never,
		);

		// Mark the anthropic account as already refreshed for its current
		// window, so shouldRefreshAccount filters it out and
		// accountsToRefresh.length === 0 -- while accounts.length > 0.
		(
			scheduler as unknown as {
				lastRefreshResetTime: Map<string, number>;
			}
		).lastRefreshResetTime.set(
			ANTHROPIC_ACCOUNT_ROW.id,
			ANTHROPIC_ACCOUNT_ROW.rate_limit_reset,
		);

		await (
			scheduler as unknown as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();

		expect(refreshTokenMock).toHaveBeenCalledTimes(1);
	});
});
