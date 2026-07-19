import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @better-ccflare/core to initialise before @better-ccflare/types resolves its
// circular dependency (types/agent.ts → core → core/strategy.ts → types/StrategyName).
// Without this the enum is undefined when strategy.ts runs. Same pattern as stats-session-cost.test.ts.
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

function makeDb(): { db: Database; repo: AccountRepository } {
	const db = new Database(":memory:");

	// Minimal schema — includes the new audit columns that the migration will add
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
			rate_limited_reason TEXT,
			rate_limited_at INTEGER,
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
			pause_reason TEXT,
			consecutive_rate_limits INTEGER DEFAULT 0
		)
	`);

	const adapter = new BunSqlAdapter(db);
	const repo = new AccountRepository(adapter);
	return { db, repo };
}

function insertAccount(db: Database, id: string): void {
	db.run(`INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)`, [
		id,
		id,
		Date.now(),
	]);
}

interface RawRateLimitAudit {
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
}

function getAudit(db: Database, id: string): RawRateLimitAudit {
	return db
		.query<RawRateLimitAudit, [string]>(
			"SELECT rate_limited_until, rate_limited_reason, rate_limited_at FROM accounts WHERE id = ?",
		)
		.get(id) as RawRateLimitAudit;
}

describe("AccountRepository — setRateLimited with reason audit (issue #178)", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("setRateLimited(id, until, reason)", () => {
		it("stores rate_limited_until when called with a reason", async () => {
			insertAccount(db, "acc-1");
			const until = Date.now() + 5 * 60 * 60 * 1000;

			await repo.setRateLimited("acc-1", until, "upstream_429_with_reset");

			const row = getAudit(db, "acc-1");
			expect(row.rate_limited_until).toBe(until);
		});

		it("stores rate_limited_reason when reason='upstream_429_with_reset'", async () => {
			insertAccount(db, "acc-2");
			const until = Date.now() + 30 * 60 * 1000;

			await repo.setRateLimited("acc-2", until, "upstream_429_with_reset");

			const row = getAudit(db, "acc-2");
			expect(row.rate_limited_reason).toBe("upstream_429_with_reset");
		});

		it("stores rate_limited_reason when reason='upstream_429_no_reset_default_5h'", async () => {
			insertAccount(db, "acc-3");
			const until = Date.now() + 5 * 60 * 60 * 1000;

			await repo.setRateLimited(
				"acc-3",
				until,
				"upstream_429_no_reset_default_5h",
			);

			const row = getAudit(db, "acc-3");
			expect(row.rate_limited_reason).toBe("upstream_429_no_reset_default_5h");
		});

		it("stores rate_limited_reason when reason='model_fallback_429'", async () => {
			insertAccount(db, "acc-4");
			const until = Date.now() + 60 * 60 * 1000;

			await repo.setRateLimited("acc-4", until, "model_fallback_429");

			const row = getAudit(db, "acc-4");
			expect(row.rate_limited_reason).toBe("model_fallback_429");
		});

		it("stores rate_limited_reason when reason='all_models_exhausted_429'", async () => {
			insertAccount(db, "acc-5");
			const until = Date.now() + 60 * 60 * 1000;

			await repo.setRateLimited("acc-5", until, "all_models_exhausted_429");

			const row = getAudit(db, "acc-5");
			expect(row.rate_limited_reason).toBe("all_models_exhausted_429");
		});

		it("stores rate_limited_at approximately equal to Date.now()", async () => {
			insertAccount(db, "acc-6");
			const until = Date.now() + 5 * 60 * 60 * 1000;
			const before = Date.now();

			await repo.setRateLimited("acc-6", until, "upstream_429_with_reset");

			const after = Date.now();
			const row = getAudit(db, "acc-6");
			expect(row.rate_limited_at).not.toBeNull();
			expect(row.rate_limited_at!).toBeGreaterThanOrEqual(before);
			expect(row.rate_limited_at!).toBeLessThanOrEqual(after + 100);
		});

		it("overwrites previous reason when rate-limited again", async () => {
			insertAccount(db, "acc-7");
			const until1 = Date.now() + 30 * 60 * 1000;
			await repo.setRateLimited("acc-7", until1, "upstream_429_with_reset");

			const until2 = Date.now() + 5 * 60 * 60 * 1000;
			await repo.setRateLimited("acc-7", until2, "model_fallback_429");

			const row = getAudit(db, "acc-7");
			expect(row.rate_limited_until).toBe(until2);
			expect(row.rate_limited_reason).toBe("model_fallback_429");
		});
	});
});

interface RawConsecutiveAudit extends RawRateLimitAudit {
	consecutive_rate_limits: number;
}

function getFullAudit(db: Database, id: string): RawConsecutiveAudit {
	return db
		.query<RawConsecutiveAudit, [string]>(
			"SELECT rate_limited_until, rate_limited_reason, rate_limited_at, consecutive_rate_limits FROM accounts WHERE id = ?",
		)
		.get(id) as RawConsecutiveAudit;
}

describe("AccountRepository - clearRateLimitState", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("clears every persisted cooldown, audit, metadata, and backoff field", async () => {
		insertAccount(db, "acc-force-reset");
		db.run(
			`UPDATE accounts
			 SET rate_limited_until = ?,
			     rate_limited_reason = ?,
			     rate_limited_at = ?,
			     rate_limit_reset = ?,
			     rate_limit_status = ?,
			     rate_limit_remaining = ?,
			     consecutive_rate_limits = ?
			 WHERE id = ?`,
			[
				Date.now() + 60_000,
				"model_fallback_429",
				Date.now(),
				Date.now() + 60_000,
				"rate_limited",
				0,
				4,
				"acc-force-reset",
			],
		);

		const changes = await repo.clearRateLimitState("acc-force-reset");
		const row = db
			.query<
				{
					rate_limited_until: number | null;
					rate_limited_reason: string | null;
					rate_limited_at: number | null;
					rate_limit_reset: number | null;
					rate_limit_status: string | null;
					rate_limit_remaining: number | null;
					consecutive_rate_limits: number;
				},
				[string]
			>(
				`SELECT rate_limited_until,
				        rate_limited_reason,
				        rate_limited_at,
				        rate_limit_reset,
				        rate_limit_status,
				        rate_limit_remaining,
				        consecutive_rate_limits
				 FROM accounts
				 WHERE id = ?`,
			)
			.get("acc-force-reset");

		expect(changes).toBe(1);
		expect(row).toEqual({
			rate_limited_until: null,
			rate_limited_reason: null,
			rate_limited_at: null,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			consecutive_rate_limits: 0,
		});
	});
});

describe("AccountRepository - markAccountRateLimited MAX-style clamp under concurrent writers", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	it("applies the first-ever write unconditionally (until was NULL)", async () => {
		insertAccount(db, "acc-clamp-1");
		const until = Date.now() + 1000;

		const count = await repo.markAccountRateLimited(
			"acc-clamp-1",
			until,
			"xai_capacity_402",
		);

		const row = getFullAudit(db, "acc-clamp-1");
		expect(row.rate_limited_until).toBe(until);
		expect(row.rate_limited_reason).toBe("xai_capacity_402");
		expect(count).toBe(1);
		expect(row.consecutive_rate_limits).toBe(1);
	});

	it("always increments consecutive_rate_limits regardless of clamp outcome", async () => {
		insertAccount(db, "acc-clamp-2");
		const now = Date.now();

		await repo.markAccountRateLimited(
			"acc-clamp-2",
			now + 10_000,
			"xai_capacity_402",
		);
		// Later call with a SMALLER until (would be discarded by the clamp).
		const count = await repo.markAccountRateLimited(
			"acc-clamp-2",
			now + 1_000,
			"xai_capacity_402",
		);

		expect(count).toBe(2);
		const row = getFullAudit(db, "acc-clamp-2");
		expect(row.consecutive_rate_limits).toBe(2);
	});

	it("retains the later deadline when a stale write with an earlier until arrives after", async () => {
		insertAccount(db, "acc-clamp-3");
		const now = Date.now();
		const laterUntil = now + 10_000;
		const earlierUntil = now + 1_000;

		// Write the far-future deadline first...
		await repo.markAccountRateLimited(
			"acc-clamp-3",
			laterUntil,
			"xai_capacity_402",
		);
		// ...then a stale/delayed concurrent writer arrives with a SHORTER
		// deadline. The clamp must not shorten the already-persisted cooldown.
		await repo.markAccountRateLimited(
			"acc-clamp-3",
			earlierUntil,
			"xai_capacity_402",
		);

		const row = getFullAudit(db, "acc-clamp-3");
		expect(row.rate_limited_until).toBe(laterUntil);
	});

	it("advances the deadline when a genuinely later until arrives", async () => {
		insertAccount(db, "acc-clamp-4");
		const now = Date.now();
		const earlierUntil = now + 1_000;
		const laterUntil = now + 10_000;

		await repo.markAccountRateLimited(
			"acc-clamp-4",
			earlierUntil,
			"xai_capacity_402",
		);
		await repo.markAccountRateLimited(
			"acc-clamp-4",
			laterUntil,
			"xai_capacity_402",
		);

		const row = getFullAudit(db, "acc-clamp-4");
		expect(row.rate_limited_until).toBe(laterUntil);
	});

	it("pairs the retained reason with the retained (winning) deadline, not the discarded write's reason", async () => {
		insertAccount(db, "acc-clamp-5");
		const now = Date.now();
		const laterUntil = now + 10_000;
		const earlierUntil = now + 1_000;

		await repo.markAccountRateLimited(
			"acc-clamp-5",
			laterUntil,
			"xai_capacity_402",
		);
		// Stale writer carries a DIFFERENT reason paired with its (losing) shorter until.
		await repo.markAccountRateLimited(
			"acc-clamp-5",
			earlierUntil,
			"upstream_429_with_reset",
		);

		const row = getFullAudit(db, "acc-clamp-5");
		expect(row.rate_limited_until).toBe(laterUntil);
		// The reason must stay paired with the deadline that actually won the
		// clamp (xai_capacity_402), never overwritten by the discarded write.
		expect(row.rate_limited_reason).toBe("xai_capacity_402");
	});

	it("updates the reason together with the deadline when the new write wins", async () => {
		insertAccount(db, "acc-clamp-6");
		const now = Date.now();
		const earlierUntil = now + 1_000;
		const laterUntil = now + 10_000;

		await repo.markAccountRateLimited(
			"acc-clamp-6",
			earlierUntil,
			"upstream_429_with_reset",
		);
		await repo.markAccountRateLimited(
			"acc-clamp-6",
			laterUntil,
			"xai_capacity_402",
		);

		const row = getFullAudit(db, "acc-clamp-6");
		expect(row.rate_limited_until).toBe(laterUntil);
		expect(row.rate_limited_reason).toBe("xai_capacity_402");
	});

	it("returns the authoritative persisted consecutive_rate_limits count", async () => {
		insertAccount(db, "acc-clamp-7");
		const now = Date.now();

		await repo.markAccountRateLimited(
			"acc-clamp-7",
			now + 1_000,
			"xai_capacity_402",
		);
		await repo.markAccountRateLimited(
			"acc-clamp-7",
			now + 2_000,
			"xai_capacity_402",
		);
		const thirdCount = await repo.markAccountRateLimited(
			"acc-clamp-7",
			now + 3_000,
			"xai_capacity_402",
		);

		expect(thirdCount).toBe(3);
	});
});
