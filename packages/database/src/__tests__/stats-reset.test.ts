import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import type { DatabaseOperations as DatabaseOperationsType } from "../database-operations";
import { ensureSchema, runMigrations } from "../migrations";

// Keep this focused test independent of generated worker build artifacts.
mock.module("../inline-incremental-vacuum-worker", () => ({
	EMBEDDED_INCREMENTAL_VACUUM_WORKER_CODE: "",
}));
mock.module("../inline-vacuum-worker", () => ({
	EMBEDDED_VACUUM_WORKER_CODE: "",
}));
const { DatabaseOperations } = await import("../database-operations");

const RESET_STATEMENTS = [
	{ sql: "DELETE FROM requests" },
	{ sql: "DELETE FROM routing_attempts" },
	{ sql: "UPDATE accounts SET request_count = 0, session_request_count = 0" },
];

function operationsWithAdapter(adapter: BunSqlAdapter): DatabaseOperationsType {
	return Object.assign(Object.create(DatabaseOperations.prototype), {
		adapter,
	}) as DatabaseOperationsType;
}

describe("DatabaseOperations.resetStatistics", () => {
	let db: Database;

	afterEach(() => db?.close());

	it("sends the request, routing-attempt, and account-counter resets as one ordered atomic batch", async () => {
		const runBatchWithChanges = mock(async () => [1, 2, 3]);
		const dbOps = operationsWithAdapter({ runBatchWithChanges } as never);

		await dbOps.resetStatistics();

		expect(runBatchWithChanges).toHaveBeenCalledTimes(1);
		expect(runBatchWithChanges).toHaveBeenCalledWith(RESET_STATEMENTS);
	});

	it("rolls back the request delete when the middle routing-attempt delete fails on SQLite", async () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.exec(`
			INSERT INTO accounts (id, name, created_at, request_count, session_request_count)
			VALUES ('account-1', 'Account 1', 1, 9, 4);
			INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts)
			VALUES ('request-1', 1, 'POST', '/v1/messages', 1, 1, 0);
			INSERT INTO routing_attempts (
				id, parent_request_id, timestamp, provider, account_id, attempted_model,
				model_family, status_code, reason, scope, available_at, failover_attempts,
				physical_attempt, account_benched, route_suppressed, circuit_counted
			) VALUES (
				'attempt-1', 'request-1', 1, 'anthropic', 'account-1', NULL,
				NULL, 429, 'model_scoped_429', 'model', NULL, 0, NULL, 0, 1, 0
			);
			CREATE TRIGGER abort_routing_attempt_reset BEFORE DELETE ON routing_attempts
			BEGIN
				SELECT RAISE(ABORT, 'routing attempt reset blocked');
			END;
		`);
		const dbOps = operationsWithAdapter(new BunSqlAdapter(db));

		await expect(dbOps.resetStatistics()).rejects.toThrow(
			"routing attempt reset blocked",
		);
		expect(db.query("SELECT id FROM requests").all()).toEqual([
			{ id: "request-1" },
		]);
		expect(db.query("SELECT id FROM routing_attempts").all()).toEqual([
			{ id: "attempt-1" },
		]);
		expect(
			db
				.query<{ request_count: number; session_request_count: number }, []>(
					"SELECT request_count, session_request_count FROM accounts",
				)
				.get(),
		).toEqual({ request_count: 9, session_request_count: 4 });
	});
});
