import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { TurnEvidence } from "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
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

function iso(ms: number): string {
	return new Date(ms).toISOString();
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
			"cache_flight_recorder_tombstones",
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
		expect(
			statements.some((sql) =>
				sql.includes(
					"CREATE TABLE IF NOT EXISTS cache_flight_recorder_tombstones",
				),
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
		expect(
			statements.some((sql) =>
				sql.includes(
					"CREATE TABLE IF NOT EXISTS cache_flight_recorder_tombstones",
				),
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

	it("sums a coalesced droppedCount into dropped_events in one call", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("recorder-safe-id", turn(1), 1_000);
		await repo.markIncomplete("recorder-safe-id", {
			dropped: true,
			droppedCount: 3,
			at: 1_100,
		});

		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 3,
			incomplete: 1,
		});

		// A second coalesced call accumulates on top of the first.
		await repo.markIncomplete("recorder-safe-id", {
			dropped: true,
			droppedCount: 2,
			at: 1_200,
		});
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 5,
			incomplete: 1,
		});
		db.close();
	});

	it("distinguishes bounded expired tombstones from never-observed IDs", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("old-id", turn(1), 1_000);
		// turn(1)'s default timestamp is derived from its sequence, not from
		// recordedAt, so it must be overridden here to actually be recent:
		// otherwise it collides with old-id's stale turn timestamp and would
		// incorrectly trip the turn-granularity expiry predicate below.
		await repo.appendTurn("new-id", turn(1, { timestamp: iso(5_000) }), 5_000);
		await repo.markIncomplete("new-id", { dropped: true, at: 5_100 });

		expect(await repo.expireOlderThan(3_000, 7_000)).toBe(1);
		expect(await repo.lookupTimeline("old-id")).toEqual({ status: "expired" });
		expect(await repo.lookupTimeline("never-seen-id")).toEqual({
			status: "not_found",
		});
		const tombstoneColumns = db
			.query("PRAGMA table_info(cache_flight_recorder_tombstones)")
			.all() as Array<{ name: string }>;
		expect(tombstoneColumns.map((column) => column.name)).toEqual([
			"recorder_conversation_id",
			"expires_at",
		]);
		const oldTurns = db
			.query(
				"SELECT COUNT(*) AS count FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?",
			)
			.get("old-id") as { count: number };
		expect(oldTurns.count).toBe(0);
		expect(await repo.lookupTimeline("new-id")).toMatchObject({
			status: "found",
		});
		expect(await repo.countRetained()).toBe(1);
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 1,
			incomplete: 1,
		});

		expect(await repo.expireTombstonesOlderThan(7_001)).toBe(1);
		expect(await repo.lookupTimeline("old-id")).toEqual({
			status: "not_found",
		});
		db.close();
	});

	it("removes stale tombstones when an expired ID is recreated", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("recreated-id", turn(1), 1_000);
		await repo.expireOlderThan(2_000, 7_000);
		expect(await repo.lookupTimeline("recreated-id")).toEqual({
			status: "expired",
		});

		await repo.appendTurn("recreated-id", turn(2), 3_000);
		expect(await repo.lookupTimeline("recreated-id")).toMatchObject({
			status: "found",
		});
		const tombstone = db
			.query(
				"SELECT recorder_conversation_id FROM cache_flight_recorder_tombstones WHERE recorder_conversation_id = ?",
			)
			.get("recreated-id");
		expect(tombstone).toBeNull();
		db.close();
	});

	it("rolls back tombstones when timeline deletion fails", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("atomic-id", turn(1), 1_000);
		db.exec(`CREATE TRIGGER reject_recorder_delete
			BEFORE DELETE ON cache_flight_recorder_conversations
			BEGIN SELECT RAISE(ABORT, 'reject delete'); END`);

		await expect(repo.expireOlderThan(2_000, 7_000)).rejects.toThrow();
		expect(await repo.lookupTimeline("atomic-id")).toMatchObject({
			status: "found",
		});
		const tombstone = db
			.query(
				"SELECT recorder_conversation_id FROM cache_flight_recorder_tombstones WHERE recorder_conversation_id = ?",
			)
			.get("atomic-id");
		expect(tombstone).toBeNull();
		db.close();
	});

	it("prunes stale turns from an active conversation and marks the truncation boundary with an explicit gap", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"mixed-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
		);
		await repo.appendTurn(
			"mixed-id",
			turn(1, { timestamp: iso(2_000) }),
			2_000,
		);
		await repo.appendTurn(
			"mixed-id",
			turn(2, { timestamp: iso(10_000) }),
			10_000,
		);

		const expired = await repo.expireOlderThan(5_000, 20_000);
		expect(expired).toBe(0);

		const lookup = await repo.lookupTimeline("mixed-id");
		expect(lookup.status).toBe("found");
		if (lookup.status !== "found") throw new Error("expected found");
		expect(lookup.timeline.turns).toHaveLength(1);
		expect(lookup.timeline.turns[0]).toMatchObject({
			sequence: 2,
			timestamp: iso(10_000),
			gapBefore: true,
		});
		expect(await repo.countRetained()).toBe(1);
		db.close();
	});

	it("expires an active conversation whose entire timeline predates the cutoff despite a recent updated_at", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"stale-turns-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
		);
		// Touch the conversation recently without recording a fresh turn (e.g.
		// a dropped-event marker), so updated_at is recent but every turn on
		// the timeline is stale: no retained-window evidence survives.
		await repo.markIncomplete("stale-turns-id", { at: 10_000 });

		const expired = await repo.expireOlderThan(5_000, 20_000);
		expect(expired).toBe(1);
		expect(await repo.lookupTimeline("stale-turns-id")).toEqual({
			status: "expired",
		});
		expect(await repo.countRetained()).toBe(0);
		db.close();
	});

	it("leaves a recently touched zero-turn conversation untouched by turn-granularity retention", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.markIncomplete("zero-turns-id", { at: 10_000 });

		const expired = await repo.expireOlderThan(5_000, 20_000);
		expect(expired).toBe(0);
		expect(await repo.lookupTimeline("zero-turns-id")).toMatchObject({
			status: "found",
			timeline: { turns: [] },
		});
		expect(await repo.countRetained()).toBe(1);
		db.close();
	});

	it("continues sequence allocation after truncation without reusing freed sequences", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"resume-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
		);
		await repo.appendTurn(
			"resume-id",
			turn(1, { timestamp: iso(2_000) }),
			2_000,
		);
		await repo.appendTurn(
			"resume-id",
			turn(2, { timestamp: iso(10_000) }),
			10_000,
		);

		await repo.expireOlderThan(5_000, 20_000);
		// Sequences 0 and 1 were pruned by truncation; surviving max is 2.

		await repo.appendTurn(
			"resume-id",
			turn(3, { timestamp: iso(11_000) }),
			11_000,
		);
		const timeline = await repo.loadTimeline("resume-id");
		const sequences = timeline?.turns.map((t) => t.sequence) ?? [];
		expect(sequences).toEqual([2, 3]);
		db.close();
	});

	it("rolls back turn truncation and gap marking when deleting stale turns fails", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"trunc-atomic-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
		);
		await repo.appendTurn(
			"trunc-atomic-id",
			turn(1, { timestamp: iso(10_000) }),
			10_000,
		);
		db.exec(`CREATE TRIGGER reject_recorder_turn_delete
			BEFORE DELETE ON cache_flight_recorder_turns
			BEGIN SELECT RAISE(ABORT, 'reject turn delete'); END`);

		await expect(repo.expireOlderThan(5_000, 20_000)).rejects.toThrow();

		const timeline = await repo.loadTimeline("trunc-atomic-id");
		expect(timeline?.turns).toHaveLength(2);
		expect(timeline?.turns.every((t) => !t.gapBefore)).toBe(true);
		const tombstone = db
			.query(
				"SELECT recorder_conversation_id FROM cache_flight_recorder_tombstones WHERE recorder_conversation_id = ?",
			)
			.get("trunc-atomic-id");
		expect(tombstone).toBeNull();
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

// DatabaseOperations facade coverage is exercised by the U5 matrix and CLI
// command suites via the repository adapter path. Those suites avoid importing
// database-operations.ts here so they do not require generated inline worker
// artifacts that are absent from this worktree base.
