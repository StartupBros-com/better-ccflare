/**
 * Verifies that `validateSqliteConfig()` (called from the
 * `DatabaseOperations` constructor, before `new Database(...)` opens the
 * handle and before any PRAGMA runs) rejects malformed numeric/enum config
 * values before they reach `configureSqlite()`'s `db.run()` calls.
 *
 * Background: `busyTimeoutMs`, `cacheSize`, `synchronous`, `mmapSize`, and
 * `pageSize` were previously interpolated directly into `db.run(\`PRAGMA ... =
 * ${value}\`)` calls with no validation. `DatabaseConfig` is populated from
 * operator-supplied runtime config (env vars / config file), so a malformed
 * value (non-numeric string, injected SQL fragment, etc.) would flow straight
 * into a SQL statement. Aikido flagged this as a SQL-injection sink; this
 * fix rejects non-integer / non-enum values before they reach `db.run()`.
 *
 * Every rejection test below asserts the specific message thrown by
 * `validateSqliteConfig()` (not just an unqualified `.toThrow()`) — several
 * of the malformed inputs (e.g. a raw SQL fragment as `cacheSize`) would
 * also fail downstream as a SQLite syntax error even with validation
 * deleted entirely, so an unqualified `.toThrow()` doesn't prove our
 * validation actually fired before `db.run()`.
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
		}).toThrow(/Invalid busyTimeoutMs/);
	});

	it("rejects a negative busyTimeoutMs", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), { busyTimeoutMs: -1 });
		}).toThrow(/Invalid busyTimeoutMs/);
	});

	it("rejects a busyTimeoutMs that overflows SQLite's signed 32-bit int32", () => {
		// Number.isInteger(2147483648) is true, but SQLite's busy_timeout takes
		// a signed 32-bit int — this value overflows to a non-positive timeout
		// that silently disables lock waiting.
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				busyTimeoutMs: 2147483648,
			});
		}).toThrow(/Invalid busyTimeoutMs/);
	});

	it("rejects a busyTimeoutMs above the 300000ms runtime-config ceiling", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), { busyTimeoutMs: 300001 });
		}).toThrow(/Invalid busyTimeoutMs/);
	});

	it("accepts a busyTimeoutMs at the 300000ms ceiling", async () => {
		const dbOps = new DatabaseOperations(makeTempDbPath(), {
			busyTimeoutMs: 300000,
		});
		await dbOps.close();
	});

	it("rejects a non-integer cacheSize", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				cacheSize: "2000 OR 1=1",
			});
		}).toThrow(/Invalid cacheSize/);
	});

	it("rejects an unrecognized synchronous mode", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				synchronous: "FULL; PRAGMA foreign_keys = OFF;--",
			});
		}).toThrow(/Invalid synchronous mode/);
	});

	it.each([
		["", ""],
		[null, "null"],
		[0, "0"],
	] as const)("rejects a falsy invalid synchronous value (%p) instead of silently defaulting to FULL", (value) => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				synchronous: value,
			});
		}).toThrow(/Invalid synchronous mode/);
	});

	it("rejects a negative mmapSize", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), { mmapSize: -1 });
		}).toThrow(/Invalid mmapSize/);
	});

	it("rejects a non-integer pageSize", () => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), {
				// @ts-expect-error - deliberately malformed input
				pageSize: 4096.5,
			});
		}).toThrow(/Invalid pageSize/);
	});

	it.each([
		0, 513, 4097,
	])("rejects an unsupported pageSize (%p)", (pageSize) => {
		expect(() => {
			new DatabaseOperations(makeTempDbPath(), { pageSize });
		}).toThrow(/Invalid pageSize/);
	});

	it.each([
		512, 4096, 65536,
	])("accepts a supported power-of-two pageSize (%p)", async (pageSize) => {
		const dbOps = new DatabaseOperations(makeTempDbPath(), { pageSize });
		await dbOps.close();
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

	it("does not leave a WAL-mode file or unclosed handle when config is invalid", async () => {
		const dbPath = makeTempDbPath();
		expect(() => {
			new DatabaseOperations(dbPath, { busyTimeoutMs: -1 });
		}).toThrow(/Invalid busyTimeoutMs/);

		// If validation ran before `new Database(...)`, the file was never
		// opened at all, so no WAL sidecar file exists.
		expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);

		// A subsequent valid open of the same path must succeed — proves the
		// invalid attempt didn't leave a lingering lock/handle on the file.
		const dbOps = new DatabaseOperations(dbPath, {});
		await dbOps.close();
	});
});
