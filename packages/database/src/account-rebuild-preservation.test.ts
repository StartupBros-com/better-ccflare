import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";

function freshDatabase(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function requireRefreshTokenRebuild(db: Database): void {
	const row = db
		.query("SELECT sql FROM sqlite_master WHERE name = 'accounts'")
		.get() as { sql: string };
	db.run(
		row.sql
			.replace("CREATE TABLE accounts", "CREATE TABLE legacy_accounts")
			.replace("refresh_token TEXT", "refresh_token TEXT NOT NULL DEFAULT ''"),
	);
	db.run("DROP TABLE accounts");
	db.run("ALTER TABLE legacy_accounts RENAME TO accounts");
}

const preservedColumns = `id, request_transformer, last_manual_reauth_at,
 usage_pause_five_hour_threshold, usage_pause_weekly_threshold,
 usage_pause_five_hour_enabled, usage_pause_weekly_enabled,
 billing_type, refresh_token_issued_at, peak_hours_pause_enabled,
 rate_limited_reason, rate_limited_at, consecutive_rate_limits`;

test("fresh SQLite schema defines all usage-threshold columns before upgrades run", () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		db.run(
			"INSERT INTO accounts(id,name,created_at) VALUES('fresh','fresh',1)",
		);
		expect(
			db
				.query(`SELECT usage_pause_five_hour_threshold,usage_pause_weekly_threshold,
		 usage_pause_five_hour_enabled,usage_pause_weekly_enabled FROM accounts`)
				.get(),
		).toEqual({
			usage_pause_five_hour_threshold: null,
			usage_pause_weekly_threshold: null,
			usage_pause_five_hour_enabled: 0,
			usage_pause_weekly_enabled: 0,
		});
	} finally {
		db.close();
	}
});

for (const rebuild of ["refresh_token", "account_tier"] as const) {
	test(`${rebuild} rebuild preserves upgrade values, disabled thresholds and fork bookkeeping`, () => {
		const db = freshDatabase();
		try {
			if (rebuild === "refresh_token") requireRefreshTokenRebuild(db);
			else db.run("ALTER TABLE accounts ADD COLUMN account_tier TEXT");
			for (const enabled of [0, 1]) {
				db.run(
					`INSERT INTO accounts (${preservedColumns}, name, provider, created_at, refresh_token)
				 VALUES (?, 'max-tokens-to-max-completion-tokens', 12345, 75, 90, ?, ?,
				 'subscription', 23456, 1, 'upstream_429_with_reset', 34567, 4, ?, 'codex', 1, 'token')`,
					[`account-${enabled}`, enabled, 1 - enabled, `account-${enabled}`],
				);
			}
			const before = db
				.query(`SELECT ${preservedColumns} FROM accounts ORDER BY id`)
				.all();
			runMigrations(db);
			expect(
				db.query(`SELECT ${preservedColumns} FROM accounts ORDER BY id`).all(),
			).toEqual(before);
			runMigrations(db);
			expect(
				db.query(`SELECT ${preservedColumns} FROM accounts ORDER BY id`).all(),
			).toEqual(before);
		} finally {
			db.close();
		}
	});
}

test("refresh-token rebuild backfills only the missing threshold flag", () => {
	const db = freshDatabase();
	try {
		requireRefreshTokenRebuild(db);
		db.run("ALTER TABLE accounts DROP COLUMN usage_pause_weekly_enabled");
		db.run(`INSERT INTO accounts(id,name,provider,created_at,refresh_token,
		 usage_pause_five_hour_threshold,usage_pause_weekly_threshold,usage_pause_five_hour_enabled)
		 VALUES('partial','partial','codex',1,'token',70,80,0)`);
		runMigrations(db);
		expect(
			db
				.query(`SELECT usage_pause_five_hour_threshold,usage_pause_weekly_threshold,
		 usage_pause_five_hour_enabled,usage_pause_weekly_enabled FROM accounts`)
				.get(),
		).toEqual({
			usage_pause_five_hour_threshold: 70,
			usage_pause_weekly_threshold: 80,
			usage_pause_five_hour_enabled: 0,
			usage_pause_weekly_enabled: 1,
		});
	} finally {
		db.close();
	}
});

for (const manualReauth of [null, 12345]) {
	test(`dedup copies the selected credential row's manual reauth value (${manualReauth})`, () => {
		const db = freshDatabase();
		try {
			db.run("DROP INDEX idx_accounts_unique_name_provider_endpoint");
			db.run(`INSERT INTO accounts(id,name,provider,created_at,last_used,refresh_token,access_token,refresh_token_issued_at,last_manual_reauth_at)
			 VALUES ('survivor','duplicate','anthropic',1,300,'stale','old-access',100,99999)`);
			db.run(
				`INSERT INTO accounts(id,name,provider,created_at,last_used,refresh_token,access_token,refresh_token_issued_at,last_manual_reauth_at)
			 VALUES ('donor','duplicate','anthropic',1,100,'fresh','new-access',200,?)`,
				[manualReauth],
			);
			runMigrations(db);
			expect(
				db
					.query("SELECT id,refresh_token,last_manual_reauth_at FROM accounts")
					.all(),
			).toEqual([
				{
					id: "survivor",
					refresh_token: "fresh",
					last_manual_reauth_at: manualReauth,
				},
			]);
		} finally {
			db.close();
		}
	});
}
