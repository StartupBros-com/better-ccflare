/**
 * Verifies that `configureSqlite()` validates numeric/enum config values
 * before interpolating them into PRAGMA statements.
 *
 * Background: `busyTimeoutMs`, `cacheSize`, `synchronous`, `mmapSize`, and
 * `pageSize` were previously interpolated directly into `db.run(\`PRAGMA ... =
 * ${value}\`)` calls with no validation. `DatabaseConfig` is populated from
 * operator-supplied runtime config (env vars / config file), so a malformed
 * value (non-numeric string, injected SQL fragment, etc.) would flow straight
 * into a SQL statement. Aikido flagged this as a SQL-injection sink; this
 * fix rejects non-integer / non-enum values before they reach `db.run()`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";

function makeTempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-pragma-test-"));
	return path.join(dir, "test.db");
}

describe("configureSqlite: input validation", () => {
	it("rejects a non-integer busyTimeoutMs", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				busyTimeoutMs: "5000; DROP TABLE accounts;--",
			});
		}).toThrow();
	});

	it("rejects a negative busyTimeoutMs", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), { busyTimeoutMs: -1 });
		}).toThrow();
	});

	it("rejects a non-integer cacheSize", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				cacheSize: "2000 OR 1=1",
			});
		}).toThrow();
	});

	it("rejects an unrecognized synchronous mode", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				synchronous: "FULL; PRAGMA foreign_keys = OFF;--",
			});
		}).toThrow();
	});

	it("rejects a negative mmapSize", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), { mmapSize: -1 });
		}).toThrow();
	});

	it("rejects a non-integer pageSize", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				pageSize: 4096.5,
			});
		}).toThrow();
	});

	it("still accepts valid values for all validated fields", async () => {
		const dbOps = new DatabaseOperations(makeTempDbPath(), {
			busyTimeoutMs: 5000,
			cacheSize: -2000,
			synchronous: "NORMAL",
			mmapSize: 16 * 1024 * 1024,
			pageSize: 4096,
		});
		try {
			const { synchronous } = dbOps
				.getDatabase()
				.query("PRAGMA synchronous")
				.get() as { synchronous: number };
			// SQLite reports synchronous as an integer (NORMAL = 1).
			expect(synchronous).toBe(1);
		} finally {
			await dbOps.close();
		}
	});
});
