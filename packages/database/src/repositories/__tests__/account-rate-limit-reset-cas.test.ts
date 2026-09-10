import "@better-ccflare/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { AccountRepository } from "../account.repository";

interface RawRateLimitRow {
	created_at: number;
	rate_limit_status: string | null;
	rate_limit_reset: number | null;
	rate_limit_reset_at: number | null;
}

describe("AccountRepository rate-limit reset CAS", () => {
	let db: Database;
	let repository: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run(`
			CREATE TABLE accounts (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				provider TEXT DEFAULT 'anthropic',
				created_at INTEGER NOT NULL,
				rate_limit_reset INTEGER,
				rate_limit_reset_at INTEGER,
				rate_limit_status TEXT,
				rate_limit_remaining INTEGER
			)
		`);
		repository = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => db.close());

	function insertAccount(
		id: string,
		reset: number | null,
		writtenAt: number | null,
		createdAt = 100,
	): void {
		db.run(
			`INSERT INTO accounts (id, name, created_at, rate_limit_status, rate_limit_reset, rate_limit_reset_at)
			 VALUES (?, ?, ?, 'rate_limited', ?, ?)`,
			[id, id, createdAt, reset, writtenAt],
		);
	}

	function getRaw(id: string): RawRateLimitRow {
		return db
			.query<RawRateLimitRow, [string]>(
				"SELECT created_at, rate_limit_status, rate_limit_reset, rate_limit_reset_at FROM accounts WHERE id = ?",
			)
			.get(id) as RawRateLimitRow;
	}

	it("clears an older matching write and nulls reset plus stamp together", async () => {
		insertAccount("stale", 20_000, 1_000);
		expect(
			await repository.clearStaleRateLimitReset("stale", 20_000, 2_000, 100),
		).toBe(true);
		expect(getRaw("stale")).toEqual({
			created_at: 100,
			rate_limit_status: "allowed",
			rate_limit_reset: null,
			rate_limit_reset_at: null,
		});
	});

	it.each([
		["newer value", 30_000, 1_000, 20_000, 2_000],
		["newer stamp with equal value", 20_000, 2_001, 20_000, 2_000],
		["same-millisecond stamp", 20_000, 2_000, 20_000, 2_000],
	] as const)("preserves a %s", async (_label, storedReset, storedAt, expectedReset, observedAt) => {
		insertAccount("race", storedReset, storedAt);
		expect(
			await repository.clearStaleRateLimitReset(
				"race",
				expectedReset,
				observedAt,
				100,
			),
		).toBe(false);
		expect(getRaw("race").rate_limit_reset).toBe(storedReset);
		expect(getRaw("race").rate_limit_reset_at).toBe(storedAt);
	});

	it("preserves a replacement account generation", async () => {
		insertAccount("replaced", 20_000, 1_000, 200);
		expect(
			await repository.clearStaleRateLimitReset("replaced", 20_000, 2_000, 100),
		).toBe(false);
		expect(getRaw("replaced").rate_limit_reset).toBe(20_000);
	});

	it("keeps legacy null stamps eligible for compatibility", async () => {
		insertAccount("legacy", 20_000, null);
		expect(
			await repository.clearStaleRateLimitReset("legacy", 20_000, 2_000, 100),
		).toBe(true);
		expect(getRaw("legacy").rate_limit_reset_at).toBeNull();
	});

	it("stamps non-null repository writes and nulls the stamp on clear", async () => {
		insertAccount("meta", null, null);
		const before = Date.now();
		await repository.updateRateLimitMeta("meta", "rate_limited", 99_999);
		const after = Date.now();
		const stamped = getRaw("meta");
		expect(stamped.rate_limit_reset).toBe(99_999);
		expect(stamped.rate_limit_reset_at).toBeGreaterThanOrEqual(before);
		expect(stamped.rate_limit_reset_at).toBeLessThanOrEqual(after);

		await repository.updateRateLimitMeta("meta", "allowed", null);
		expect(getRaw("meta").rate_limit_reset_at).toBeNull();
	});
});
