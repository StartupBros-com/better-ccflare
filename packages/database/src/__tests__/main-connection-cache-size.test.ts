import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "../database-operations";

describe("DatabaseOperations constructor fallback cacheSize", () => {
	let tmpDir: string;
	let dbPath: string;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-cache-size-test-"));
		dbPath = path.join(tmpDir, "test.db");
	});

	afterEach(async () => {
		await dbOps.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("applies a 256MB (-262144) page cache to the main connection when no dbConfig is supplied", async () => {
		dbOps = new DatabaseOperations(dbPath);
		const row = await dbOps
			.getAdapter()
			.get<{ cache_size: number }>("PRAGMA cache_size");
		expect(row?.cache_size).toBe(-262144);
	});
});
