import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	type CacheFlightCohortSealReceipt,
	type CacheFlightKeepalivePolicySnapshot,
	type CacheFlightPersistedSeal,
	type CacheFlightSealDimension,
	PARTITION_DIMENSION_ORDER as CORE_PARTITION_DIMENSION_ORDER,
	SERVICE_DIMENSION_ORDER as CORE_SERVICE_DIMENSION_ORDER,
	type TurnEvidence,
} from "@better-ccflare/core";
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

const keepalivePolicy: CacheFlightKeepalivePolicySnapshot = {
	globalTtlMinutes: 20,
	xaiTtlMinutes: 20,
	effectiveXaiEnabled: true,
	effectiveXaiTtlMinutes: 20,
};

function sealReceipt(
	overrides: {
		epochId?: string;
		partitionId?: string;
		occurrenceId?: string | null;
		deploymentRevision?: string | null;
		serviceInstanceId?: string | null;
		processStartedAt?: string | null;
		nativeCacheState?: "enabled" | "disabled" | null;
		recorderState?: "enabled" | "disabled" | null;
		keepalive?: CacheFlightKeepalivePolicySnapshot | null;
		servingAccountScope?: string | null;
		routeModelEpoch?: string | null;
		serviceUnavailable?: CacheFlightSealDimension[];
		partitionUnavailable?: CacheFlightSealDimension[];
	} = {},
): CacheFlightCohortSealReceipt {
	const epochId = overrides.epochId ?? "epoch-safe-id";
	const partitionUnavailable = overrides.partitionUnavailable ?? [];
	const serviceUnavailable = overrides.serviceUnavailable ?? [];
	const unavailableDimensions = [
		...serviceUnavailable,
		...partitionUnavailable,
	];
	return {
		serviceEpoch: {
			id: epochId,
			occurrenceId:
				"occurrenceId" in overrides
					? (overrides.occurrenceId ?? null)
					: "occurrence-safe-id",
			sealContractVersion: 1,
			deploymentRevision:
				"deploymentRevision" in overrides
					? (overrides.deploymentRevision ?? null)
					: "deploy-safe-id",
			serviceInstanceId:
				"serviceInstanceId" in overrides
					? (overrides.serviceInstanceId ?? null)
					: "service-safe-id",
			processStartedAt:
				"processStartedAt" in overrides
					? (overrides.processStartedAt ?? null)
					: "2026-08-08T10:00:00.000Z",
			nativeCacheState:
				"nativeCacheState" in overrides
					? (overrides.nativeCacheState ?? null)
					: "enabled",
			recorderState:
				"recorderState" in overrides
					? (overrides.recorderState ?? null)
					: "enabled",
			keepalivePolicy:
				"keepalive" in overrides
					? (overrides.keepalive ?? null)
					: { ...keepalivePolicy },
			completeness: serviceUnavailable.length === 0 ? "complete" : "incomplete",
			unavailableDimensions: serviceUnavailable,
		},
		observationPartition: {
			id: overrides.partitionId ?? "partition-safe-id",
			serviceEpochId: epochId,
			servingAccountScope:
				"servingAccountScope" in overrides
					? (overrides.servingAccountScope ?? null)
					: "serving-scope-safe-id",
			routeModelEpoch:
				"routeModelEpoch" in overrides
					? (overrides.routeModelEpoch ?? null)
					: "route-model-safe-id",
			completeness:
				partitionUnavailable.length === 0 ? "complete" : "incomplete",
			unavailableDimensions: partitionUnavailable,
		},
		completeness:
			unavailableDimensions.length === 0 ? "complete" : "incomplete",
		unavailableDimensions,
	};
}

type LoadedTurnWithSeal = TurnEvidence & {
	seal?: CacheFlightPersistedSeal | null;
};

function recorderRowCounts(db: Database): {
	conversations: number;
	turns: number;
	serviceEpochs: number;
	partitions: number;
} {
	const count = (table: string) =>
		(
			db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
				count: number;
			}
		).count;
	return {
		conversations: count("cache_flight_recorder_conversations"),
		turns: count("cache_flight_recorder_turns"),
		serviceEpochs: count("cache_flight_recorder_service_epochs"),
		partitions: count("cache_flight_recorder_partitions"),
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
			"cache_flight_recorder_partitions",
			"cache_flight_recorder_service_epochs",
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
			// Reports both column and index existence checks as satisfied so
			// runMigrationsPg's unique-index/dedup migration (unrelated to the
			// recorder tables this test exercises) is a no-op: its collapse
			// helper reads rows back via adapter.unsafe(), which this mock
			// doesn't model.
			get: async <T>(sql: string): Promise<T | null> =>
				sql.includes("information_schema.columns") || sql.includes("pg_indexes")
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
				{ ...turn(99), sequence: 0, seal: null },
				{ ...turn(99), sequence: 1, seal: null },
			],
		});
		expect(await repo.countRetained()).toBe(1);
		db.close();
	});

	it("persists and loads a sealed turn through immutable epoch and partition registries", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const receipt = sealReceipt();

		await repo.appendTurn("sealed-id", turn(1), 1_000, receipt);

		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			db
				.query(
					`SELECT observation_partition_id
					 FROM cache_flight_recorder_turns
					 WHERE recorder_conversation_id = ?`,
				)
				.get("sealed-id"),
		).toEqual({ observation_partition_id: "partition-safe-id" });

		const timeline = await repo.loadTimeline("sealed-id");
		const loadedTurns = timeline?.turns as LoadedTurnWithSeal[] | undefined;
		expect(loadedTurns?.[0]?.seal).toEqual(receipt);
		db.close();
	});

	it("reuses identical immutable registry IDs and rejects conflicting dimensions without appending a turn", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const receipt = sealReceipt();

		await repo.appendTurn("sealed-id", turn(1), 1_000, receipt);
		await repo.appendTurn("sealed-id", turn(2), 2_000, receipt);

		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);

		await expect(
			repo.appendTurn(
				"sealed-id",
				turn(3),
				3_000,
				sealReceipt({ deploymentRevision: "deploy-conflict" }),
			),
		).rejects.toThrow("immutable cache flight service epoch");

		const timeline = await repo.loadTimeline("sealed-id");
		expect(timeline?.updatedAt).toBe(2_000);
		expect(timeline?.turns).toHaveLength(2);
		expect(
			db
				.query(
					"SELECT deployment_revision FROM cache_flight_recorder_service_epochs WHERE id = ?",
				)
				.get("epoch-safe-id"),
		).toEqual({ deployment_revision: "deploy-safe-id" });
		db.close();
	});

	it("rolls back epoch, conversation, and turn writes when a registry statement fails", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		db.exec(`CREATE TRIGGER reject_partition_insert
			BEFORE INSERT ON cache_flight_recorder_partitions
			BEGIN SELECT RAISE(ABORT, 'reject partition insert'); END`);

		await expect(
			repo.appendTurn("atomic-seal-id", turn(1), 1_000, sealReceipt()),
		).rejects.toThrow("reject partition insert");

		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_conversations",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.query("SELECT COUNT(*) AS count FROM cache_flight_recorder_turns")
					.get() as { count: number }
			).count,
		).toBe(0);
		db.close();
	});

	it("loads historical null seals and corrupted registry references as fail-closed evidence", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("mixed-load-id", turn(1), 1_000);

		db.run("PRAGMA foreign_keys = OFF");
		db.prepare(`
			INSERT INTO cache_flight_recorder_turns (
				recorder_conversation_id, sequence, timestamp,
				identity_fingerprint, serving_account_id, prefix_fingerprint,
				cache_outcome, input_tokens, cached_tokens, completeness,
				unavailable_dimensions, gap_before, observation_partition_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"mixed-load-id",
			1,
			iso(2_000),
			"identity",
			"account",
			"prefix",
			"miss",
			100,
			0,
			"complete",
			"[]",
			0,
			"missing-partition",
		);
		db.run("PRAGMA foreign_keys = ON");

		const timeline = await repo.loadTimeline("mixed-load-id");
		const loadedTurns = timeline?.turns as LoadedTurnWithSeal[] | undefined;
		expect(loadedTurns?.[0]?.seal).toBeNull();
		expect(loadedTurns?.[1]?.seal).toMatchObject({
			serviceEpoch: {
				id: "unknown",
				completeness: "incomplete",
				unavailableDimensions: [
					"seal_contract_version",
					"deployment_revision",
					"service_instance",
					"process_started_at",
					"native_cache_state",
					"recorder_state",
					"keepalive_policy",
					"service_epoch_occurrence",
				],
			},
			observationPartition: {
				id: "unknown",
				serviceEpochId: "unknown",
				completeness: "incomplete",
				unavailableDimensions: ["serving_account_scope", "route_model_epoch"],
			},
			completeness: "incomplete",
			unavailableDimensions: [
				"seal_contract_version",
				"deployment_revision",
				"service_instance",
				"process_started_at",
				"native_cache_state",
				"recorder_state",
				"keepalive_policy",
				"service_epoch_occurrence",
				"serving_account_scope",
				"route_model_epoch",
				"seal_receipt",
			],
		});
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 0,
			incomplete: 0,
			sealed: 0,
			unsealed: 1,
			incompleteSeal: 1,
		});
		db.close();
	});

	it("allows multiple partitions under one epoch but rejects partition-to-epoch conflicts", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

		await repo.appendTurn("multi-partition-id", turn(1), 1_000, sealReceipt());
		await repo.appendTurn(
			"multi-partition-id",
			turn(2),
			2_000,
			sealReceipt({
				partitionId: "partition-two-safe-id",
				servingAccountScope: "serving-scope-two",
				routeModelEpoch: "route-model-two",
			}),
		);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(2);

		await expect(
			repo.appendTurn(
				"multi-partition-id",
				turn(3),
				3_000,
				sealReceipt({
					epochId: "other-epoch-safe-id",
					partitionId: "partition-safe-id",
				}),
			),
		).rejects.toThrow("immutable cache flight partition");
		expect((await repo.loadTimeline("multi-partition-id"))?.turns).toHaveLength(
			2,
		);
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
		const reloadedIncompleteWithSeal = {
			...reloadedIncomplete,
			seal: null,
		};
		await repo.appendTurn("recorder-safe-id", incomplete, 3_000);
		await repo.markIncomplete("recorder-safe-id", { dropped: true, at: 3_100 });

		expect(await repo.loadTimeline("recorder-safe-id")).toMatchObject({
			incomplete: true,
			droppedEvents: 1,
			turns: [reloadedIncompleteWithSeal],
		});
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 1,
			incomplete: 1,
			sealed: 0,
			unsealed: 1,
			incompleteSeal: 0,
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
			sealed: 0,
			unsealed: 1,
			incompleteSeal: 0,
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
			sealed: 0,
			unsealed: 1,
			incompleteSeal: 0,
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
			sealed: 0,
			unsealed: 1,
			incompleteSeal: 0,
		});

		expect(await repo.expireTombstonesOlderThan(7_001)).toBe(1);
		expect(await repo.lookupTimeline("old-id")).toEqual({
			status: "not_found",
		});
		db.close();
	});

	it("counts sealed, unsealed, and incomplete-seal turns while retained remains conversation-scoped", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

		await repo.appendTurn("sealed-count-id", turn(1), 1_000, sealReceipt());
		await repo.appendTurn("unsealed-count-id", turn(1), 1_000);
		await repo.appendTurn(
			"incomplete-count-id",
			turn(1),
			1_000,
			sealReceipt({
				partitionId: "incomplete-partition-safe-id",
				routeModelEpoch: null,
				partitionUnavailable: ["route_model_epoch"],
			}),
		);

		expect(await repo.countRetained()).toBe(3);
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 0,
			incomplete: 0,
			sealed: 1,
			unsealed: 1,
			incompleteSeal: 1,
		});

		await repo.expireOlderThan(2_000, 10_000);
		expect(await repo.countRetained()).toBe(0);
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 0,
			incomplete: 0,
			sealed: 0,
			unsealed: 0,
			incompleteSeal: 0,
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

	it("preserves referenced registries during partial contributor pruning and removes them after the final contributor expires", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const receipt = sealReceipt();
		await repo.appendTurn(
			"sealed-retention-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			receipt,
		);
		await repo.appendTurn(
			"sealed-retention-id",
			turn(1, { timestamp: iso(10_000) }),
			10_000,
			receipt,
		);

		expect(await repo.expireOlderThan(5_000, 20_000)).toBe(0);
		let timeline = await repo.loadTimeline("sealed-retention-id");
		const loadedTurns = timeline?.turns as LoadedTurnWithSeal[] | undefined;
		expect(loadedTurns).toHaveLength(1);
		expect(loadedTurns?.[0]).toMatchObject({
			sequence: 1,
			gapBefore: true,
		});
		expect(loadedTurns?.[0]?.seal).toEqual(receipt);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);

		expect(await repo.expireOlderThan(11_000, 20_000)).toBe(1);
		timeline = await repo.loadTimeline("sealed-retention-id");
		expect(timeline).toBeNull();
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		db.close();
	});

	it("protects a recently-created orphan registry row from a same-pass reap, then reaps it once it is older than the cutoff", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"orphan-guard-id",
			turn(1, { timestamp: iso(1_000) }),
			1_000,
			sealReceipt(),
		);

		// Simulate the race window directly: the registry rows become true
		// zero-turn orphans (their only referencing turn is gone) while their
		// created_at (1_000) is still within the current retention window.
		// A live append reusing this cached partition/epoch id would be in
		// exactly this state mid-transaction on PostgreSQL, where the
		// insert-or-verify batch and this cleanup run as separate
		// transactions (see bun-sql-adapter.ts runBatchWithChanges).
		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("orphan-guard-id");

		// cutoffTs (500) predates the registry rows' created_at (1_000): the
		// orphan cleanup must not reap them yet, even though they are
		// currently unreferenced.
		await repo.expireOlderThan(500, 10_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);

		// Once the cutoff advances past created_at (1_000), the same orphan
		// rows are still eligible and get reaped.
		await repo.expireOlderThan(2_000, 10_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		db.close();
	});

	it("keeps a partition alive across a retention pass when a live re-append refreshed last_verified_at, even though created_at predates the cutoff", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const receipt = sealReceipt();
		await repo.appendTurn(
			"reverify-partition-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			receipt,
		);
		// Re-append with the SAME immutable identity (identical receipt) much
		// later: the registry INSERTs no-op via ON CONFLICT DO NOTHING, but the
		// verify UPDATEs re-run and must refresh last_verified_at to 9_000 —
		// created_at (1_000) never changes, by design.
		await repo.appendTurn(
			"reverify-partition-id",
			turn(1, { timestamp: iso(9_000) }),
			9_000,
			receipt,
		);

		// Simulate the same race window as the orphan-guard test above, but
		// now on a long-lived registry row: force both turns away so the
		// registry rows look like zero-turn orphans.
		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("reverify-partition-id");

		// cutoffTs (5_000) is AFTER created_at (1_000) but BEFORE
		// last_verified_at (9_000). A created_at-only guard would reap this
		// row right now (this is the regression under test); the
		// last_verified_at guard must not, because the row was genuinely
		// re-verified live inside the current retention window.
		await repo.expireOlderThan(5_000, 20_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		db.close();
	});

	it("reaps a genuinely dead partition/epoch orphan whose last_verified_at (never refreshed by a second append) predates the cutoff", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"dead-orphan-pair-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			sealReceipt({
				epochId: "dead-pair-epoch-id",
				partitionId: "dead-pair-partition-id",
			}),
		);
		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("dead-orphan-pair-id");

		// Single append only: last_verified_at equals created_at (1_000),
		// never refreshed by a re-verify. A cutoff past that point must still
		// reap both registry rows.
		await repo.expireOlderThan(5_000, 20_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		db.close();
	});

	it("keeps a service epoch alive across a retention pass when a live re-append refreshed its own last_verified_at, even though created_at predates the cutoff", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		const receipt = sealReceipt({
			epochId: "reverify-epoch-id",
			partitionId: "reverify-epoch-partition-id",
		});
		await repo.appendTurn(
			"reverify-epoch-conv-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			receipt,
		);
		await repo.appendTurn(
			"reverify-epoch-conv-id",
			turn(1, { timestamp: iso(9_000) }),
			9_000,
			receipt,
		);

		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("reverify-epoch-conv-id");
		// Force the partition away directly (bypassing its own retention
		// guard) so the epoch's own last_verified_at — independent of the
		// partition surviving on its own merits — is what's under test here.
		db.query(`DELETE FROM cache_flight_recorder_partitions WHERE id = ?`).run(
			"reverify-epoch-partition-id",
		);

		await repo.expireOlderThan(5_000, 20_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		db.close();
	});

	it("reaps a genuinely dead service-epoch orphan whose last_verified_at (never refreshed) predates the cutoff, isolated from partition state", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"dead-epoch-conv-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			sealReceipt({
				epochId: "dead-epoch-only-id",
				partitionId: "dead-epoch-only-partition-id",
			}),
		);
		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("dead-epoch-conv-id");
		db.query(`DELETE FROM cache_flight_recorder_partitions WHERE id = ?`).run(
			"dead-epoch-only-partition-id",
		);

		await repo.expireOlderThan(5_000, 20_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		db.close();
	});

	it("reaps a genuinely dead partition/epoch orphan whose last_verified_at is NULL, falling back to its old created_at", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"null-verified-dead-pair-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			sealReceipt({
				epochId: "null-verified-dead-epoch-id",
				partitionId: "null-verified-dead-partition-id",
			}),
		);
		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("null-verified-dead-pair-id");

		// Simulate the nullable last_verified_at states expireOlderThan()
		// documents: the upgrade path ALTERs the column on before backfilling
		// it, the fresh-install schema leaves it nullable so a rolled-back
		// prior binary can still insert, and a mid-rolling-deploy instance on
		// the old binary can insert after a backfill already ran.
		db.query(
			`UPDATE cache_flight_recorder_partitions SET last_verified_at = NULL WHERE id = ?`,
		).run("null-verified-dead-partition-id");
		db.query(
			`UPDATE cache_flight_recorder_service_epochs SET last_verified_at = NULL WHERE id = ?`,
		).run("null-verified-dead-epoch-id");

		// cutoffTs (5_000) is past created_at (1_000). With last_verified_at
		// NULL, `NULL < cutoff` is NULL (never true), so without the
		// COALESCE(last_verified_at, created_at) fallback these rows would be
		// immortal despite having no referencing turns. This is the core
		// regression this test guards against.
		await repo.expireOlderThan(5_000, 20_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(0);
		db.close();
	});

	it("keeps a NULL last_verified_at partition/epoch orphan alive when its created_at fallback is still within the retention window", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"null-verified-recent-pair-id",
			turn(0, { timestamp: iso(9_000) }),
			9_000,
			sealReceipt({
				epochId: "null-verified-recent-epoch-id",
				partitionId: "null-verified-recent-partition-id",
			}),
		);
		db.query(
			`DELETE FROM cache_flight_recorder_turns WHERE recorder_conversation_id = ?`,
		).run("null-verified-recent-pair-id");
		db.query(
			`UPDATE cache_flight_recorder_partitions SET last_verified_at = NULL WHERE id = ?`,
		).run("null-verified-recent-partition-id");
		db.query(
			`UPDATE cache_flight_recorder_service_epochs SET last_verified_at = NULL WHERE id = ?`,
		).run("null-verified-recent-epoch-id");

		// cutoffTs (5_000) predates created_at (9_000): the COALESCE fallback
		// must use created_at as a real retention signal rather than treating
		// a NULL last_verified_at as "always eligible to reap", which would be
		// the opposite bug.
		await repo.expireOlderThan(5_000, 20_000);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
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

	it("rolls back contributor expiry, tombstone creation, and registry cleanup together", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"cleanup-atomic-id",
			turn(0, { timestamp: iso(1_000) }),
			1_000,
			sealReceipt(),
		);
		db.exec(`CREATE TRIGGER reject_partition_cleanup
			BEFORE DELETE ON cache_flight_recorder_partitions
			BEGIN SELECT RAISE(ABORT, 'reject partition cleanup'); END`);

		await expect(repo.expireOlderThan(5_000, 20_000)).rejects.toThrow(
			"reject partition cleanup",
		);

		expect(await repo.lookupTimeline("cleanup-atomic-id")).toMatchObject({
			status: "found",
		});
		expect(
			db
				.query(
					"SELECT recorder_conversation_id FROM cache_flight_recorder_tombstones WHERE recorder_conversation_id = ?",
				)
				.get("cleanup-atomic-id"),
		).toBeNull();
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_partitions",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS count FROM cache_flight_recorder_service_epochs",
					)
					.get() as { count: number }
			).count,
		).toBe(1);
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

	it("rejects unsafe, overlength, secret-shaped, and unsupported seal evidence without narrowing legacy turns", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

		await expect(
			repo.appendTurn(
				"recorder-safe-id",
				turn(1),
				1_000,
				sealReceipt({ serviceInstanceId: "sk-secret-shaped-value" }),
			),
		).rejects.toThrow("cache flight seal identifiers must be bounded and safe");
		await expect(
			repo.appendTurn("recorder-safe-id", turn(1), 1_000, {
				...sealReceipt({
					partitionId: `partition-${"a".repeat(200)}`,
				}),
				rawAccountId: "private-account",
			} as unknown as CacheFlightCohortSealReceipt),
		).rejects.toThrow("exact own-key set");
		await expect(
			repo.appendTurn(
				"recorder-safe-id",
				turn(1),
				1_000,
				sealReceipt({
					routeModelEpoch: null,
					partitionUnavailable: [],
				}),
			),
		).rejects.toThrow("unknown seal dimensions must be explicit");

		await repo.appendTurn("legacy-compatible-id", turn(1), 2_000);
		expect(await repo.countRetained()).toBe(1);
		db.close();
	});

	it("rejects seal receipts with missing exact-shape fields before writing any recorder rows", async () => {
		const cases: Array<{
			name: string;
			receipt: CacheFlightCohortSealReceipt;
		}> = [
			{
				name: "missing nullable service field",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as {
						serviceEpoch: Record<string, unknown>;
					};
					delete receipt.serviceEpoch.deploymentRevision;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
			{
				name: "missing partition field",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as {
						observationPartition: Record<string, unknown>;
					};
					delete receipt.observationPartition.servingAccountScope;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
			{
				name: "missing top-level field",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as Record<string, unknown>;
					delete receipt.unavailableDimensions;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
			{
				name: "missing keepalive field",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as {
						serviceEpoch: {
							keepalivePolicy: Record<string, unknown>;
						};
					};
					delete receipt.serviceEpoch.keepalivePolicy.xaiTtlMinutes;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

			await expect(
				repo.appendTurn("exact-shape-id", turn(1), 1_000, testCase.receipt),
				testCase.name,
			).rejects.toThrow("exact own-key set");
			expect(recorderRowCounts(db), testCase.name).toEqual({
				conversations: 0,
				turns: 0,
				serviceEpochs: 0,
				partitions: 0,
			});
			db.close();
		}
	});

	it("treats explicit null seal receipts as legacy unsealed appends", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

		await repo.appendTurn("explicit-null-id", turn(1), 1_000, null);

		expect(await repo.loadTimeline("explicit-null-id")).toEqual({
			recorderConversationId: "explicit-null-id",
			createdAt: 1_000,
			updatedAt: 1_000,
			incomplete: false,
			droppedEvents: 0,
			turns: [{ ...turn(1), sequence: 0, seal: null }],
		});
		expect(recorderRowCounts(db)).toEqual({
			conversations: 1,
			turns: 1,
			serviceEpochs: 0,
			partitions: 0,
		});
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 0,
			incomplete: 0,
			sealed: 0,
			unsealed: 1,
			incompleteSeal: 0,
		});
		db.close();
	});

	it("rejects non-object seal receipt shapes cleanly before writing recorder rows", async () => {
		const cases: Array<{
			name: string;
			receipt: CacheFlightCohortSealReceipt;
		}> = [
			{
				name: "array top-level receipt",
				receipt: [] as unknown as CacheFlightCohortSealReceipt,
			},
			{
				name: "primitive top-level receipt",
				receipt: "sealed" as unknown as CacheFlightCohortSealReceipt,
			},
			{
				name: "null service epoch",
				receipt: {
					...sealReceipt(),
					serviceEpoch: null,
				} as unknown as CacheFlightCohortSealReceipt,
			},
			{
				name: "array partition",
				receipt: {
					...sealReceipt(),
					observationPartition: [],
				} as unknown as CacheFlightCohortSealReceipt,
			},
			{
				name: "non-object keepalive",
				receipt: sealReceipt({
					keepalive: [] as unknown as CacheFlightKeepalivePolicySnapshot,
				}),
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

			await expect(
				repo.appendTurn("object-shape-id", turn(1), 1_000, testCase.receipt),
				testCase.name,
			).rejects.toThrow("exact own-key set");
			expect(recorderRowCounts(db), testCase.name).toEqual({
				conversations: 0,
				turns: 0,
				serviceEpochs: 0,
				partitions: 0,
			});
			db.close();
		}
	});

	it("rejects non-canonical keepalive policies before writing recorder rows", async () => {
		const cases: Array<{
			name: string;
			keepalive: CacheFlightKeepalivePolicySnapshot;
		}> = [
			{
				name: "enabled without an effective TTL",
				keepalive: {
					globalTtlMinutes: null,
					xaiTtlMinutes: null,
					effectiveXaiEnabled: true,
					effectiveXaiTtlMinutes: null,
				},
			},
			{
				name: "disabled with an effective TTL",
				keepalive: {
					globalTtlMinutes: null,
					xaiTtlMinutes: null,
					effectiveXaiEnabled: false,
					effectiveXaiTtlMinutes: 20,
				},
			},
			{
				name: "effective TTL ignores the xAI override",
				keepalive: {
					globalTtlMinutes: 20,
					xaiTtlMinutes: 10,
					effectiveXaiEnabled: true,
					effectiveXaiTtlMinutes: 20,
				},
			},
			{
				name: "global configured TTL is null with xAI override evidence",
				keepalive: {
					globalTtlMinutes: null,
					xaiTtlMinutes: 20,
					effectiveXaiEnabled: true,
					effectiveXaiTtlMinutes: 20,
				},
			},
			{
				name: "xAI configured TTL is null with global fallback evidence",
				keepalive: {
					globalTtlMinutes: 20,
					xaiTtlMinutes: null,
					effectiveXaiEnabled: true,
					effectiveXaiTtlMinutes: 20,
				},
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

			await expect(
				repo.appendTurn(
					"keepalive-semantic-id",
					turn(1),
					1_000,
					sealReceipt({ keepalive: testCase.keepalive }),
				),
				testCase.name,
			).rejects.toThrow("canonical v1 xAI derivation");
			expect(recorderRowCounts(db), testCase.name).toEqual({
				conversations: 0,
				turns: 0,
				serviceEpochs: 0,
				partitions: 0,
			});
			db.close();
		}
	});

	it("rejects present undefined seal identifiers before writing recorder rows", async () => {
		const cases: Array<{
			name: string;
			receipt: CacheFlightCohortSealReceipt;
		}> = [
			{
				name: "undefined service epoch id",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as {
						serviceEpoch: Record<string, unknown>;
						observationPartition: Record<string, unknown>;
					};
					receipt.serviceEpoch.id = undefined;
					receipt.observationPartition.serviceEpochId = undefined;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
			{
				name: "undefined partition service epoch id",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as {
						observationPartition: Record<string, unknown>;
					};
					receipt.observationPartition.serviceEpochId = undefined;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
			{
				name: "undefined nullable deployment revision",
				receipt: (() => {
					const receipt = sealReceipt() as unknown as {
						serviceEpoch: Record<string, unknown>;
					};
					receipt.serviceEpoch.deploymentRevision = undefined;
					return receipt as unknown as CacheFlightCohortSealReceipt;
				})(),
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

			await expect(
				repo.appendTurn("undefined-shape-id", turn(1), 1_000, testCase.receipt),
				testCase.name,
			).rejects.toThrow(
				"cache flight seal identifiers must be bounded and safe",
			);
			expect(recorderRowCounts(db), testCase.name).toEqual({
				conversations: 0,
				turns: 0,
				serviceEpochs: 0,
				partitions: 0,
			});
			db.close();
		}
	});

	it("rejects seal receipts whose declared completeness contradicts their own unavailable dimensions before writing any recorder rows", async () => {
		const cases: Array<{
			name: string;
			receipt: CacheFlightCohortSealReceipt;
			expectedMessage: string;
		}> = [
			{
				name: "service epoch completeness contradicts its unavailable dimensions",
				receipt: (() => {
					const receipt = sealReceipt();
					return {
						...receipt,
						serviceEpoch: {
							...receipt.serviceEpoch,
							completeness: "incomplete",
						},
					} as CacheFlightCohortSealReceipt;
				})(),
				expectedMessage:
					"cache flight service epoch completeness is inconsistent",
			},
			{
				name: "partition completeness contradicts its unavailable dimensions",
				receipt: (() => {
					const receipt = sealReceipt();
					return {
						...receipt,
						observationPartition: {
							...receipt.observationPartition,
							completeness: "incomplete",
						},
					} as CacheFlightCohortSealReceipt;
				})(),
				expectedMessage: "cache flight partition completeness is inconsistent",
			},
			{
				name: "seal receipt completeness contradicts its unavailable dimensions",
				receipt: (() => {
					const receipt = sealReceipt();
					return {
						...receipt,
						completeness: "incomplete",
					} as CacheFlightCohortSealReceipt;
				})(),
				expectedMessage: "cache flight seal completeness is inconsistent",
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));

			await expect(
				repo.appendTurn(
					"completeness-mismatch-id",
					turn(1),
					1_000,
					testCase.receipt,
				),
				testCase.name,
			).rejects.toThrow(testCase.expectedMessage);
			expect(recorderRowCounts(db), testCase.name).toEqual({
				conversations: 0,
				turns: 0,
				serviceEpochs: 0,
				partitions: 0,
			});
			db.close();
		}
	});

	// This repository keeps its own SERVICE_DIMENSION_ORDER / PARTITION_DIMENSION_ORDER
	// literal arrays (see module scope above) instead of importing
	// @better-ccflare/core's canonical order, because assertPrivacySafeSealReceipt
	// must not trust anything the proxy-side capture path computed — including
	// which order it used. That independence is deliberate, but it means the
	// two copies can silently drift. expectedServiceUnavailable/
	// expectedPartitionUnavailable recompute the expected unavailable-dimension
	// list from this repository's own order and then require the receipt's
	// declared list to match it *positionally* (assertExactUnavailable), so a
	// receipt whose declared dimensions are listed in core's canonical order is
	// accepted only if this repository's own order still agrees with core's,
	// and a receipt using any other order is rejected. That makes order
	// agreement directly observable through the public appendTurn API without
	// needing to export this repository's private order constants.
	it("keeps its own PARTITION_DIMENSION_ORDER positionally aligned with @better-ccflare/core's canonical order", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"partition-order-id",
			turn(1),
			1_000,
			sealReceipt({
				servingAccountScope: null,
				routeModelEpoch: null,
				partitionUnavailable: [...CORE_PARTITION_DIMENSION_ORDER],
			}),
		);
		const timeline = await repo.loadTimeline("partition-order-id");
		expect(
			(timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]?.seal
				?.observationPartition.unavailableDimensions,
		).toEqual([...CORE_PARTITION_DIMENSION_ORDER]);
		db.close();

		const db2 = makeDb();
		const repo2 = new CacheFlightRecorderRepository(new BunSqlAdapter(db2));
		await expect(
			repo2.appendTurn(
				"partition-order-id",
				turn(1),
				1_000,
				sealReceipt({
					servingAccountScope: null,
					routeModelEpoch: null,
					partitionUnavailable: [...CORE_PARTITION_DIMENSION_ORDER].reverse(),
				}),
			),
		).rejects.toThrow("unknown seal dimensions must be explicit");
		db2.close();
	});

	it("keeps its own SERVICE_DIMENSION_ORDER positionally aligned with @better-ccflare/core's canonical order", async () => {
		// seal_contract_version is excluded: an out-of-contract version throws
		// its own dedicated error before assertExactUnavailable ever runs, so
		// it can never appear as a declared-unavailable dimension in a receipt
		// that reaches the order check. The other seven service dimensions can
		// all be forced unavailable simultaneously, which is enough to pin
		// their full relative order.
		const reachableServiceOrder = CORE_SERVICE_DIMENSION_ORDER.filter(
			(dimension) => dimension !== "seal_contract_version",
		);
		const nulledFields = {
			deploymentRevision: null,
			serviceInstanceId: null,
			processStartedAt: null,
			nativeCacheState: null,
			recorderState: null,
			keepalive: null,
			occurrenceId: null,
		} as const;

		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn(
			"service-order-id",
			turn(1),
			1_000,
			sealReceipt({
				...nulledFields,
				serviceUnavailable: [...reachableServiceOrder],
			}),
		);
		const timeline = await repo.loadTimeline("service-order-id");
		expect(
			(timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]?.seal
				?.serviceEpoch.unavailableDimensions,
		).toEqual([...reachableServiceOrder]);
		db.close();

		const db2 = makeDb();
		const repo2 = new CacheFlightRecorderRepository(new BunSqlAdapter(db2));
		await expect(
			repo2.appendTurn(
				"service-order-id",
				turn(1),
				1_000,
				sealReceipt({
					...nulledFields,
					serviceUnavailable: [...reachableServiceOrder].reverse(),
				}),
			),
		).rejects.toThrow("unknown seal dimensions must be explicit");
		db2.close();
	});

	it("sanitizes corrupted stored seal identities and timestamps before projecting health", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("corrupt-health-id", turn(1), 1_000, sealReceipt());
		expect(await repo.countDroppedIncomplete()).toMatchObject({
			sealed: 1,
			unsealed: 0,
			incompleteSeal: 0,
		});

		db.run("PRAGMA foreign_keys = OFF");
		db.query(
			`UPDATE cache_flight_recorder_service_epochs
			 SET id = ?, process_started_at = ?
			 WHERE id = ?`,
		).run("sk-secret-epoch-token", "sk-secret-process-token", "epoch-safe-id");
		db.query(
			`UPDATE cache_flight_recorder_partitions
			 SET id = ?, service_epoch_id = ?
			 WHERE id = ?`,
		).run(
			"sk-secret-partition-token",
			"sk-secret-epoch-token",
			"partition-safe-id",
		);
		db.query(
			`UPDATE cache_flight_recorder_turns
			 SET observation_partition_id = ?
			 WHERE recorder_conversation_id = ?`,
		).run("sk-secret-partition-token", "corrupt-health-id");
		db.run("PRAGMA foreign_keys = ON");

		const timeline = await repo.loadTimeline("corrupt-health-id");
		const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
			?.seal;
		expect(JSON.stringify(seal)).not.toContain("sk-secret");
		expect(seal).toMatchObject({
			serviceEpoch: {
				id: "unknown",
				processStartedAt: null,
				completeness: "incomplete",
			},
			observationPartition: {
				id: "unknown",
				serviceEpochId: "unknown",
				completeness: "incomplete",
			},
			completeness: "incomplete",
		});
		expect(seal?.unavailableDimensions).toContain("process_started_at");
		expect(seal?.unavailableDimensions).toContain("seal_receipt");
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 0,
			incomplete: 0,
			sealed: 0,
			unsealed: 0,
			incompleteSeal: 1,
		});
		db.close();
	});

	it("projects non-canonical stored keepalive tuples as unavailable evidence", async () => {
		const cases: Array<{
			name: string;
			corrupt: (db: Database) => void;
		}> = [
			{
				name: "effective TTL mismatch",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_service_epochs
						 SET keepalive_effective_xai_ttl_minutes = ?
						 WHERE id = ?`,
					).run(10, "epoch-safe-id");
				},
			},
			{
				name: "global configured TTL changed to NULL",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_service_epochs
						 SET keepalive_global_ttl_minutes = NULL
						 WHERE id = ?`,
					).run("epoch-safe-id");
				},
			},
			{
				name: "xAI configured TTL changed to NULL",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_service_epochs
						 SET keepalive_xai_ttl_minutes = NULL
						 WHERE id = ?`,
					).run("epoch-safe-id");
				},
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
			await repo.appendTurn(
				"keepalive-health-id",
				turn(1),
				1_000,
				sealReceipt(),
			);
			expect(await repo.countDroppedIncomplete(), testCase.name).toMatchObject({
				sealed: 1,
				unsealed: 0,
				incompleteSeal: 0,
			});

			testCase.corrupt(db);

			const timeline = await repo.loadTimeline("keepalive-health-id");
			const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
				?.seal;
			expect(seal?.serviceEpoch.keepalivePolicy, testCase.name).toBeNull();
			expect(seal?.serviceEpoch.unavailableDimensions, testCase.name).toContain(
				"keepalive_policy",
			);
			expect(seal?.serviceEpoch.completeness, testCase.name).toBe("incomplete");
			expect(seal?.unavailableDimensions, testCase.name).toContain(
				"keepalive_policy",
			);
			expect(seal?.unavailableDimensions, testCase.name).toContain(
				"seal_receipt",
			);
			expect(seal?.completeness, testCase.name).toBe("incomplete");
			expect(await repo.countDroppedIncomplete(), testCase.name).toEqual({
				dropped: 0,
				incomplete: 0,
				sealed: 0,
				unsealed: 0,
				incompleteSeal: 1,
			});
			db.close();
		}
	});

	it("projects non-canonical stored timestamps as unavailable evidence", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("timestamp-health-id", turn(1), 1_000, sealReceipt());

		db.query(
			`UPDATE cache_flight_recorder_service_epochs
			 SET process_started_at = ?
			 WHERE id = ?`,
		).run("2026-08-08 10:00:00Z", "epoch-safe-id");

		const timeline = await repo.loadTimeline("timestamp-health-id");
		const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
			?.seal;
		expect(seal?.serviceEpoch.processStartedAt).toBeNull();
		expect(seal?.serviceEpoch.unavailableDimensions).toContain(
			"process_started_at",
		);
		expect(seal?.unavailableDimensions).toContain("seal_receipt");
		expect(seal?.completeness).toBe("incomplete");
		expect(await repo.countDroppedIncomplete()).toMatchObject({
			sealed: 0,
			incompleteSeal: 1,
		});
		db.close();
	});

	it("projects out-of-domain stored enum states as unavailable evidence", async () => {
		const cases: Array<{
			name: string;
			corrupt: (db: Database) => void;
			assertSeal: (seal: CacheFlightPersistedSeal | null | undefined) => void;
		}> = [
			{
				name: "native cache state outside {enabled, disabled, NULL}",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_service_epochs
						 SET native_cache_state = ?
						 WHERE id = ?`,
					).run("half-enabled", "epoch-safe-id");
				},
				assertSeal: (seal) => {
					expect(seal?.serviceEpoch.nativeCacheState).toBeNull();
					expect(seal?.serviceEpoch.unavailableDimensions).toContain(
						"native_cache_state",
					);
				},
			},
			{
				name: "recorder state outside {enabled, disabled, NULL}",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_service_epochs
						 SET recorder_state = ?
						 WHERE id = ?`,
					).run("half-enabled", "epoch-safe-id");
				},
				assertSeal: (seal) => {
					expect(seal?.serviceEpoch.recorderState).toBeNull();
					expect(seal?.serviceEpoch.unavailableDimensions).toContain(
						"recorder_state",
					);
				},
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
			await repo.appendTurn("state-health-id", turn(1), 1_000, sealReceipt());

			testCase.corrupt(db);

			const timeline = await repo.loadTimeline("state-health-id");
			const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
				?.seal;
			testCase.assertSeal(seal);
			expect(seal?.serviceEpoch.completeness, testCase.name).toBe("incomplete");
			expect(seal?.unavailableDimensions, testCase.name).toContain(
				"seal_receipt",
			);
			expect(seal?.completeness, testCase.name).toBe("incomplete");
			expect(await repo.countDroppedIncomplete(), testCase.name).toEqual({
				dropped: 0,
				incomplete: 0,
				sealed: 0,
				unsealed: 0,
				incompleteSeal: 1,
			});
			db.close();
		}
	});

	it("projects an out-of-domain stored keepalive boolean as unavailable evidence", async () => {
		const db = makeDb();
		const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
		await repo.appendTurn("boolean-health-id", turn(1), 1_000, sealReceipt());

		db.query(
			`UPDATE cache_flight_recorder_service_epochs
			 SET keepalive_effective_xai_enabled = ?
			 WHERE id = ?`,
		).run(2, "epoch-safe-id");

		const timeline = await repo.loadTimeline("boolean-health-id");
		const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
			?.seal;
		expect(seal?.serviceEpoch.keepalivePolicy).toBeNull();
		expect(seal?.serviceEpoch.unavailableDimensions).toContain(
			"keepalive_policy",
		);
		expect(seal?.serviceEpoch.completeness).toBe("incomplete");
		expect(seal?.unavailableDimensions).toContain("seal_receipt");
		expect(seal?.completeness).toBe("incomplete");
		expect(await repo.countDroppedIncomplete()).toEqual({
			dropped: 0,
			incomplete: 0,
			sealed: 0,
			unsealed: 0,
			incompleteSeal: 1,
		});
		db.close();
	});

	it("projects out-of-bounds stored keepalive TTLs as unavailable evidence", async () => {
		const cases: Array<{ name: string; value: number }> = [
			{ name: "negative TTL", value: -1 },
			{ name: "TTL above the one-year bound", value: 525_601 },
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
			await repo.appendTurn("ttl-health-id", turn(1), 1_000, sealReceipt());

			db.query(
				`UPDATE cache_flight_recorder_service_epochs
				 SET keepalive_global_ttl_minutes = ?
				 WHERE id = ?`,
			).run(testCase.value, "epoch-safe-id");

			const timeline = await repo.loadTimeline("ttl-health-id");
			const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
				?.seal;
			expect(seal?.serviceEpoch.keepalivePolicy, testCase.name).toBeNull();
			expect(seal?.serviceEpoch.unavailableDimensions, testCase.name).toContain(
				"keepalive_policy",
			);
			expect(seal?.serviceEpoch.completeness, testCase.name).toBe("incomplete");
			expect(seal?.unavailableDimensions, testCase.name).toContain(
				"seal_receipt",
			);
			expect(seal?.completeness, testCase.name).toBe("incomplete");
			db.close();
		}
	});

	it("projects stored completeness columns that disagree with their own unavailable-dimensions column as unavailable", async () => {
		const cases: Array<{
			name: string;
			corrupt: (db: Database) => void;
			assertSeal: (seal: CacheFlightPersistedSeal | null | undefined) => void;
		}> = [
			{
				name: "service epoch completeness vs its own unavailable_dimensions",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_service_epochs
						 SET completeness = ?
						 WHERE id = ?`,
					).run("incomplete", "epoch-safe-id");
				},
				assertSeal: (seal) => {
					expect(seal?.serviceEpoch.completeness).toBe("incomplete");
				},
			},
			{
				name: "partition completeness vs its own unavailable_dimensions",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_partitions
						 SET completeness = ?
						 WHERE id = ?`,
					).run("incomplete", "partition-safe-id");
				},
				assertSeal: (seal) => {
					expect(seal?.observationPartition.completeness).toBe("incomplete");
				},
			},
			{
				name: "seal completeness vs its own seal_unavailable_dimensions",
				corrupt: (db) => {
					db.query(
						`UPDATE cache_flight_recorder_partitions
						 SET seal_completeness = ?
						 WHERE id = ?`,
					).run("incomplete", "partition-safe-id");
				},
				assertSeal: (seal) => {
					// Sub-levels remain individually complete on their own
					// terms; only the top-level receipt is marked
					// unavailable, proving this contradiction is caught even
					// when neither sub-level's own gate would have caught it.
					expect(seal?.serviceEpoch.completeness).toBe("complete");
					expect(seal?.observationPartition.completeness).toBe("complete");
				},
			},
		];

		for (const testCase of cases) {
			const db = makeDb();
			const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
			await repo.appendTurn(
				"completeness-contradiction-id",
				turn(1),
				1_000,
				sealReceipt(),
			);

			testCase.corrupt(db);

			const timeline = await repo.loadTimeline("completeness-contradiction-id");
			const seal = (timeline?.turns as LoadedTurnWithSeal[] | undefined)?.[0]
				?.seal;
			testCase.assertSeal(seal);
			expect(seal?.unavailableDimensions, testCase.name).toContain(
				"seal_receipt",
			);
			expect(seal?.completeness, testCase.name).toBe("incomplete");
			expect(await repo.countDroppedIncomplete(), testCase.name).toEqual({
				dropped: 0,
				incomplete: 0,
				sealed: 0,
				unsealed: 0,
				incompleteSeal: 1,
			});
			db.close();
		}
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
