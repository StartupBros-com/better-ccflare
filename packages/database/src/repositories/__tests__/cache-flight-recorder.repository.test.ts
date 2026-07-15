import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { TurnEvidence } from "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../../migrations-pg";
import { CacheFlightRecorderRepository } from "../cache-flight-recorder.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function turn(
	sequence: number,
	overrides: Partial<TurnEvidence> = {},
): TurnEvidence {
	return {
		sequence,
		timestamp: new Date(sequence * 1_000).toISOString(),
		identityFingerprint: "identity-fingerprint",
		servingAccountId: "account-safe-id",
		prefixFingerprint: "prefix-fingerprint",
		cacheOutcome: "hit",
		inputTokens: 100,
		cachedTokens: 80,
		completeness: "complete",
		unavailableDimensions: [],
		...overrides,
	};
}

describe("cache flight recorder schema", () => {
	it("creates dedicated conversation and turn tables", () => {
		const db = makeDb();
		const tables = db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cache_flight_recorder_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toEqual([
			"cache_flight_recorder_conversations",
			"cache_flight_recorder_turns",
		]);
		db.close();
	});

	it("creates PostgreSQL recorder tables on fresh installs and upgrades", async () => {
		const statements: string[] = [];
		const adapter = {
			unsafe: async (sql: string) => {
				statements.push(sql);
			},
			get: async <T>(sql: string): Promise<T | null> =>
				sql.includes("information_schema.columns")
					? ({ exists: 1 } as T)
					: null,
			run: async () => {},
		};

		await ensureSchemaPg(adapter as never);
		expect(
			statements.some((sql) =>
				sql.includes(
					"CREATE TABLE IF NOT EXISTS cache_flight_recorder_conversations",
				),
			),
		).toBe(true);
		expect(
			statements.some((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS cache_flight_recorder_turns"),
			),
		).toBe(true);

		statements.length = 0;
		await runMigrationsPg(adapter as never);
		expect(
			statements.some((sql) =>
				sql.includes(
					"CREATE TABLE IF NOT EXISTS cache_flight_recorder_conversations",
				),
			),
		).toBe(true);
		expect(
			statements.some((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS cache_flight_recorder_turns"),
			),
		).toBe(true);
	});
});

describe("CacheFlightRecorderRepository", () => {
	it("allocates deterministic append-only sequences at persistence", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("recorder-safe-id", turn(99), 2_000);
		await repo.appendTurn("recorder-safe-id", turn(99), 1_000);

		const timeline = await repo.loadTimeline("recorder-safe-id");
		expect(timeline).toEqual({
			recorderConversationId: "recorder-safe-id",
			createdAt: 2_000,
			updatedAt: 2_000,
			incomplete: false,
			droppedEvents: 0,
			turns: [
				{ ...turn(99), sequence: 0 },
				{ ...turn(99), sequence: 1 },
			],
		});
		expect(await repo.countRetained()).toBe(1);
		db.close();
	});

	it("preserves incomplete and explicit gap metadata", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const incomplete = turn(3, {
			completeness: "incomplete",
			unavailableDimensions: ["identity", "cache_outcome"],
			gapBefore: true,
			cacheOutcome: "unknown",
			cachedTokens: undefined,
		});
		const reloadedIncomplete = { ...incomplete, sequence: 0 };
		delete reloadedIncomplete.cachedTokens;
		await repo.appendTurn("recorder-safe-id", incomplete, 3_000);
		await repo.markIncomplete("recorder-safe-id", { dropped: true, at: 3_100 });

		expect(await repo.loadTimeline("recorder-safe-id")).toMatchObject({
			incomplete: true,
			droppedEvents: 1,
			turns: [reloadedIncomplete],
		});
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 1,
			incomplete: 1,
		});
		db.close();
	});

	it("expires only timelines older than the cutoff and reports expired separately", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("old-id", turn(1), 1_000);
		await repo.appendTurn("new-id", turn(1), 5_000);
		await repo.markIncomplete("new-id", { dropped: true, at: 5_100 });

		expect(await repo.expireOlderThan(3_000)).toBe(1);
		expect(await repo.loadTimeline("old-id")).toBeNull();
		const oldTurns = db
			.query(
				"SELECT COUNT(*) AS count FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?",
			)
			.get("old-id") as { count: number };
		expect(oldTurns.count).toBe(0);
		expect(await repo.loadTimeline("new-id")).not.toBeNull();
		expect(await repo.countRetained()).toBe(1);
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 1,
			incomplete: 1,
		});
		db.close();
	});

	it("rejects evidence objects with content-bearing or unsupported fields", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const unsafeTurn = {
			...turn(1),
			prompt: "private prompt content",
		} as TurnEvidence;

		await expect(
			repo.appendTurn("recorder-safe-id", unsafeTurn, 1_000),
		).rejects.toThrow("unsupported fields: prompt");
		expect(await repo.countRetained()).toBe(0);
		db.close();
	});

	it("rejects unbounded identifiers and non-allowlisted dimensions", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

		await expect(
			repo.appendTurn(`cfr_${"a".repeat(200)}`, turn(1), 1_000),
		).rejects.toThrow("bounded safe identifier");
		await expect(
			repo.appendTurn(
				"recorder-safe-id",
				turn(1, { unavailableDimensions: ["raw_prompt"] }),
				1_000,
			),
		).rejects.toThrow("dimensions must be allowlisted");
		expect(await repo.countRetained()).toBe(0);
		db.close();
	});

	it("stores only the privacy-safe evidence columns", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("recorder-safe-id", turn(1), 1_000);
		const columns = db
			.query("PRAGMA table_info(cache_flight_recorder_turns)")
			.all() as Array<{ name: string }>;
		const names = columns.map((column) => column.name);
		expect(names).not.toContain("prompt");
		expect(names).not.toContain("request_body");
		expect(names).not.toContain("response_body");
		expect(names).not.toContain("reasoning");
		expect(names).not.toContain("tool_payload");
		db.close();
	});
});

describe("DatabaseOperations cache flight recorder facade", () => {
	it("round-trips evidence and expires it", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await dbOps.appendCacheFlightRecorderTurn(
				"recorder-safe-id",
				turn(1),
				1_000,
			);
			expect(
				await dbOps.loadCacheFlightRecorderTimeline("recorder-safe-id"),
			).not.toBeNull();
			expect(await dbOps.expireCacheFlightRecorderTimelines(2_000)).toBe(1);
		} finally {
			await dbOps.dispose();
		}
	});
});
