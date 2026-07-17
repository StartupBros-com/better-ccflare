/**
 * Tests for AccountRepository.resumeUnlessPausedForReason (U8 OAuth
 * control-plane hotfix, R23).
 *
 * This is the shared chokepoint guard used by both the public Resume
 * endpoint/CLI and the usage poller's temporary resume: it must refuse to
 * clear a pause whose reason matches the blocked reason (oauth_invalid_grant
 * in production), while resuming everything else exactly like the old
 * unconditional resume() did.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Same pattern as account-pause-reason.test.ts / account-reauth-pause.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT DEFAULT '',
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			priority INTEGER DEFAULT 0,
			auto_fallback_enabled INTEGER DEFAULT 0,
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT,
			pause_reason TEXT
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new AccountRepository(adapter);
	return { db, repo };
}

function insertAccount(
	db: Database,
	id: string,
	opts: { paused?: number; pauseReason?: string | null } = {},
): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, paused, pause_reason) VALUES (?, ?, ?, ?, ?)`,
		[id, id, Date.now(), opts.paused ?? 0, opts.pauseReason ?? null],
	);
}

interface RawAccount {
	paused: number;
	pause_reason: string | null;
}

function getAccount(db: Database, id: string): RawAccount {
	return db
		.query<RawAccount, [string]>(
			"SELECT paused, pause_reason FROM accounts WHERE id = ?",
		)
		.get(id) as RawAccount;
}

describe("AccountRepository — resumeUnlessPausedForReason", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("resumes an account paused for an unrelated (e.g. manual) reason", async () => {
		insertAccount(db, "acc-1", { paused: 1, pauseReason: "manual" });

		const result = await repo.resumeUnlessPausedForReason(
			"acc-1",
			"oauth_invalid_grant",
		);

		expect(result).toEqual({ resumed: true, pauseReason: null });
		const row = getAccount(db, "acc-1");
		expect(row.paused).toBe(0);
		expect(row.pause_reason).toBeNull();
	});

	it("refuses to resume an account paused for the blocked reason", async () => {
		insertAccount(db, "acc-2", {
			paused: 1,
			pauseReason: "oauth_invalid_grant",
		});

		const result = await repo.resumeUnlessPausedForReason(
			"acc-2",
			"oauth_invalid_grant",
		);

		expect(result).toEqual({
			resumed: false,
			pauseReason: "oauth_invalid_grant",
		});
		const row = getAccount(db, "acc-2");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("oauth_invalid_grant");
	});

	it("is a no-op (not resumed) on an account that isn't paused", async () => {
		insertAccount(db, "acc-3");

		const result = await repo.resumeUnlessPausedForReason(
			"acc-3",
			"oauth_invalid_grant",
		);

		expect(result).toEqual({ resumed: false, pauseReason: null });
	});

	it("resumes a legacy row paused with a NULL reason (never blocks on missing reason)", async () => {
		insertAccount(db, "acc-4", { paused: 1, pauseReason: null });

		const result = await repo.resumeUnlessPausedForReason(
			"acc-4",
			"oauth_invalid_grant",
		);

		expect(result).toEqual({ resumed: true, pauseReason: null });
		const row = getAccount(db, "acc-4");
		expect(row.paused).toBe(0);
	});
});
