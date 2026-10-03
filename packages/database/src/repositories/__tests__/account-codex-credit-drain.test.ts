/**
 * Data-layer tests for accounts.codex_credit_drain_enabled (issue #419).
 *
 * Uses the real SQLite schema (ensureSchema + runMigrations) so the column
 * default, the repository SELECT lists, the setter, and the type mappers are
 * exercised together.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Initialise @better-ccflare/core before types (circular import ordering).
import "@better-ccflare/core";
import { toAccount, toAccountResponse } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { AccountRepository } from "../account.repository";

function insertAccount(db: Database, id: string, provider = "codex"): void {
	db.run(
		`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
		[id, id, provider, Date.now()],
	);
}

describe("codex_credit_drain_enabled data layer", () => {
	let db: Database;
	let repo: AccountRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new AccountRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("defaults to off for new accounts", async () => {
		insertAccount(db, "a1");
		const acct = await repo.findById("a1");
		expect(acct?.codex_credit_drain_enabled).toBe(false);
	});

	it("round-trips through setCodexCreditDrainEnabled via findById and findAll", async () => {
		insertAccount(db, "a1");
		insertAccount(db, "a2");

		await repo.setCodexCreditDrainEnabled("a1", true);
		expect((await repo.findById("a1"))?.codex_credit_drain_enabled).toBe(true);
		expect((await repo.findById("a2"))?.codex_credit_drain_enabled).toBe(false);

		const all = await repo.findAll();
		expect(all.find((a) => a.id === "a1")?.codex_credit_drain_enabled).toBe(
			true,
		);
		expect(all.find((a) => a.id === "a2")?.codex_credit_drain_enabled).toBe(
			false,
		);

		await repo.setCodexCreditDrainEnabled("a1", false);
		expect((await repo.findById("a1"))?.codex_credit_drain_enabled).toBe(false);
	});

	it("toAccount coerces the row value and treats absent as off", () => {
		const base = {
			id: "x",
			name: "x",
			provider: "codex",
			created_at: 1,
			request_count: 0,
			total_requests: 0,
			session_request_count: 0,
		} as never;
		expect(toAccount(base).codex_credit_drain_enabled).toBe(false);
		expect(
			toAccount({ ...(base as object), codex_credit_drain_enabled: 1 } as never)
				.codex_credit_drain_enabled,
		).toBe(true);
		expect(
			toAccount({ ...(base as object), codex_credit_drain_enabled: 0 } as never)
				.codex_credit_drain_enabled,
		).toBe(false);
	});

	it("toAccountResponse exposes codexCreditDrainEnabled", () => {
		const base = {
			id: "x",
			name: "x",
			provider: "codex",
			created_at: 1,
			request_count: 0,
			total_requests: 0,
			session_request_count: 0,
		} as never;
		const on = toAccount({
			...(base as object),
			codex_credit_drain_enabled: 1,
		} as never);
		expect(toAccountResponse(on).codexCreditDrainEnabled).toBe(true);
		expect(toAccountResponse(toAccount(base)).codexCreditDrainEnabled).toBe(
			false,
		);
	});
});
