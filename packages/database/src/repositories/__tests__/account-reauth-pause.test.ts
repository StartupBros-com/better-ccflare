/**
 * Tests for AccountRepository pause-for-reauth guard and reason-scoped resume
 * (OAuth invalid_grant fix).
 *
 * Verifies that:
 *  - pauseIfActive(id, reason)                     pauses only if currently active
 *  - pauseIfActive(id, reason, expectedRefreshToken) additionally requires the
 *    account to still hold that exact refresh token (guards a stale/in-flight
 *    refresh from re-pausing an account that was just re-authenticated)
 *  - resumeIfPausedWithReason(id, reason)           resumes only when paused for
 *    that specific reason, leaving other pause reasons untouched
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Same pattern as account-pause-reason.test.ts.
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
	opts: { paused?: number; refreshToken?: string } = {},
): void {
	db.run(
		`INSERT INTO accounts (id, name, created_at, paused, refresh_token) VALUES (?, ?, ?, ?, ?)`,
		[id, id, Date.now(), opts.paused ?? 0, opts.refreshToken ?? "rt-original"],
	);
}

interface RawAccount {
	paused: number;
	pause_reason: string | null;
	refresh_token: string;
}

function getAccount(db: Database, id: string): RawAccount {
	return db
		.query<RawAccount, [string]>(
			"SELECT paused, pause_reason, refresh_token FROM accounts WHERE id = ?",
		)
		.get(id) as RawAccount;
}

describe("AccountRepository — pauseIfActive", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("pauses an active account with the given reason and returns true", async () => {
		insertAccount(db, "acc-1");

		const paused = await repo.pauseIfActive("acc-1", "oauth_invalid_grant");

		expect(paused).toBe(true);
		const row = getAccount(db, "acc-1");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("oauth_invalid_grant");
	});

	it("does not overwrite an already-paused account's reason, returns false", async () => {
		insertAccount(db, "acc-2", { paused: 1 });
		db.run("UPDATE accounts SET pause_reason = 'manual' WHERE id = 'acc-2'");

		const paused = await repo.pauseIfActive("acc-2", "oauth_invalid_grant");

		expect(paused).toBe(false);
		const row = getAccount(db, "acc-2");
		expect(row.pause_reason).toBe("manual");
	});

	it("with expectedRefreshToken: pauses when the account still holds that token", async () => {
		insertAccount(db, "acc-3", { refreshToken: "rt-stale" });

		const paused = await repo.pauseIfActive(
			"acc-3",
			"oauth_invalid_grant",
			"rt-stale",
		);

		expect(paused).toBe(true);
		const row = getAccount(db, "acc-3");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("oauth_invalid_grant");
	});

	it("with expectedRefreshToken: does NOT pause when the token no longer matches (already re-authed)", async () => {
		insertAccount(db, "acc-4", { refreshToken: "rt-new-after-reauth" });

		const paused = await repo.pauseIfActive(
			"acc-4",
			"oauth_invalid_grant",
			"rt-stale-failing-refresh",
		);

		expect(paused).toBe(false);
		const row = getAccount(db, "acc-4");
		expect(row.paused).toBe(0);
		expect(row.pause_reason).toBeNull();
	});
});

describe("AccountRepository — resumeIfPausedWithReason", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("resumes an account paused with the matching reason and returns true", async () => {
		insertAccount(db, "acc-5", { paused: 1 });
		db.run(
			"UPDATE accounts SET pause_reason = 'oauth_invalid_grant' WHERE id = 'acc-5'",
		);

		const resumed = await repo.resumeIfPausedWithReason(
			"acc-5",
			"oauth_invalid_grant",
		);

		expect(resumed).toBe(true);
		const row = getAccount(db, "acc-5");
		expect(row.paused).toBe(0);
		expect(row.pause_reason).toBeNull();
	});

	it("does not resume an account paused for a different reason, returns false", async () => {
		insertAccount(db, "acc-6", { paused: 1 });
		db.run("UPDATE accounts SET pause_reason = 'manual' WHERE id = 'acc-6'");

		const resumed = await repo.resumeIfPausedWithReason(
			"acc-6",
			"oauth_invalid_grant",
		);

		expect(resumed).toBe(false);
		const row = getAccount(db, "acc-6");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("manual");
	});

	it("is a no-op on an account that isn't paused, returns false", async () => {
		insertAccount(db, "acc-7");

		const resumed = await repo.resumeIfPausedWithReason(
			"acc-7",
			"oauth_invalid_grant",
		);

		expect(resumed).toBe(false);
	});
});
