import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { normalizeProviderUsageWindows } from "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { UsageHistoryRepository } from "../usage-history.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

describe("usage_snapshots schema", () => {
	it("creates the usage_snapshots table", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='usage_snapshots'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("usage_snapshots");
		db.close();
	});

	it("creates the timestamp prune index", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_snapshots_ts'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("idx_usage_snapshots_ts");
		db.close();
	});

	it("defaults fresh and upgraded snapshot rows to active", () => {
		const fresh = makeDb();
		try {
			const freshColumn = fresh
				.prepare("PRAGMA table_info(usage_snapshots)")
				.all()
				.find((column: { name: string }) => column.name === "active") as
				| { notnull: number; dflt_value: string | null }
				| undefined;
			expect(freshColumn).toEqual(
				expect.objectContaining({ notnull: 1, dflt_value: "1" }),
			);
		} finally {
			fresh.close();
		}

		const upgraded = new Database(":memory:");
		try {
			upgraded.run(`
				CREATE TABLE usage_snapshots (
					account_id TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					window_key TEXT NOT NULL,
					utilization REAL NOT NULL,
					resets_at INTEGER
				)
			`);
			upgraded
				.prepare(
					`INSERT INTO usage_snapshots
						(account_id, timestamp, window_key, utilization, resets_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run("legacy-account", 1_000, "seven_day", 12, null);

			runMigrations(upgraded);
			const legacy = upgraded
				.prepare("SELECT active FROM usage_snapshots WHERE account_id = ?")
				.get("legacy-account") as { active: number };
			expect(legacy.active).toBe(1);
		} finally {
			upgraded.close();
		}
	});

	it("generates and backfills durable append order without relying on rowid", () => {
		const fresh = makeDb();
		try {
			const appendOrder = fresh
				.prepare("PRAGMA table_info(usage_snapshots)")
				.all()
				.find((column: { name: string }) => column.name === "append_order") as
				| { pk: number }
				| undefined;
			expect(appendOrder).toEqual(expect.objectContaining({ pk: 1 }));
			fresh
				.prepare(
					`INSERT INTO usage_snapshots
						(account_id, timestamp, window_key, utilization)
					 VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
				)
				.run("fresh", 1_000, "seven_day", 10, "fresh", 1_000, "seven_day", 20);
			expect(
				fresh
					.prepare(
						"SELECT append_order FROM usage_snapshots ORDER BY append_order",
					)
					.all(),
			).toEqual([{ append_order: 1 }, { append_order: 2 }]);
			expect(() =>
				fresh
					.prepare(
						`INSERT INTO usage_snapshots
							(append_order, account_id, timestamp, window_key, utilization)
						 VALUES (?, ?, ?, ?, ?)`,
					)
					.run(1, "fresh", 1_000, "seven_day", 30),
			).toThrow();
		} finally {
			fresh.close();
		}

		const upgraded = new Database(":memory:");
		try {
			upgraded.run(`
				CREATE TABLE usage_snapshots (
					account_id TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					window_key TEXT NOT NULL,
					utilization REAL NOT NULL,
					resets_at INTEGER,
					active INTEGER NOT NULL DEFAULT 1
				)
			`);
			upgraded
				.prepare(
					`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization)
					 VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
				)
				.run(
					"legacy",
					1_000,
					"seven_day",
					10,
					"legacy",
					1_000,
					"seven_day",
					20,
				);

			runMigrations(upgraded);
			expect(
				upgraded
					.prepare(
						"SELECT append_order FROM usage_snapshots ORDER BY append_order",
					)
					.all(),
			).toEqual([{ append_order: 1 }, { append_order: 2 }]);
			upgraded
				.prepare(
					`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization)
					 VALUES (?, ?, ?, ?)`,
				)
				.run("legacy", 1_000, "seven_day", 30);
			expect(
				upgraded
					.prepare(
						"SELECT append_order FROM usage_snapshots ORDER BY append_order",
					)
					.all(),
			).toEqual([
				{ append_order: 1 },
				{ append_order: 2 },
				{ append_order: 3 },
			]);
			// A second migration is a no-op, and AUTOINCREMENT does not reuse a
			// deleted key after the legacy-table rebuild.
			expect(() => runMigrations(upgraded)).not.toThrow();
			upgraded
				.prepare("DELETE FROM usage_snapshots WHERE append_order = ?")
				.run(3);
			upgraded
				.prepare(
					`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization)
					 VALUES (?, ?, ?, ?)`,
				)
				.run("legacy", 1_000, "seven_day", 40);
			expect(
				upgraded
					.prepare(
						"SELECT append_order FROM usage_snapshots ORDER BY append_order",
					)
					.all(),
			).toEqual([
				{ append_order: 1 },
				{ append_order: 2 },
				{ append_order: 4 },
			]);
			expect(
				upgraded
					.prepare(
						"SELECT COUNT(*) AS count FROM usage_snapshots WHERE append_order IS NULL",
					)
					.get(),
			).toEqual({ count: 0 });
		} finally {
			upgraded.close();
		}
	});
});

function makeRepo(db: Database): UsageHistoryRepository {
	return new UsageHistoryRepository(new BunSqlAdapter(db));
}

function canonicalWindows(usage: Record<string, unknown>) {
	return normalizeProviderUsageWindows(usage, "anthropic");
}

async function writeSnapshot(
	repo: UsageHistoryRepository,
	accountId: string,
	usage: Record<string, unknown>,
	now: number,
): Promise<void> {
	await repo.recordSnapshot(accountId, canonicalWindows(usage), now);
}

async function writeDbSnapshot(
	dbOps: DatabaseOperations,
	accountId: string,
	usage: Record<string, unknown>,
	now: number,
): Promise<void> {
	await dbOps.recordUsageSnapshot(accountId, canonicalWindows(usage), now);
}

describe("UsageHistoryRepository", () => {
	it("records one row per usage window", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{
				five_hour: { utilization: 10, resets_at: "2026-07-05T12:00:00Z" },
				seven_day: { utilization: 3, resets_at: null },
				extra_usage: {
					is_enabled: true,
					monthly_limit: 5,
					used_credits: 1,
					utilization: 20,
				},
			},
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		// extra_usage has no resets_at → not a window → excluded
		expect(rows.map((r) => r.windowKey).sort()).toEqual([
			"five_hour",
			"seven_day",
		]);
		const fiveH = rows.find((r) => r.windowKey === "five_hour");
		expect(fiveH?.utilization).toBe(10);
		expect(fiveH?.resetsAt).toBe(new Date("2026-07-05T12:00:00Z").getTime());
		// recordSnapshot emits one multi-row INSERT; the database supplies one
		// distinct append key per value tuple without repository-side allocation.
		expect(
			db
				.prepare(
					"SELECT append_order FROM usage_snapshots ORDER BY append_order ASC",
				)
				.all(),
		).toEqual([{ append_order: 1 }, { append_order: 2 }]);
		db.close();
	});

	it("rejects every window from a stale same-ID account generation", async () => {
		const db = makeDb();
		try {
			const repo = makeRepo(db);
			const accountId = "replaced-account";
			const originalCreatedAt = 1_000;
			const replacementCreatedAt = 2_000;
			db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
				accountId,
				"original",
				originalCreatedAt,
			]);
			db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
			db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
				accountId,
				"replacement",
				replacementCreatedAt,
			]);
			const windows = canonicalWindows({
				five_hour: { utilization: 10, resets_at: "2026-07-05T12:00:00Z" },
				seven_day: { utilization: 20, resets_at: "2026-07-12T12:00:00Z" },
			});

			await repo.recordSnapshot(accountId, windows, 3_000, originalCreatedAt);
			expect(await repo.getSeries({ accountId })).toEqual([]);

			await repo.recordSnapshot(
				accountId,
				windows,
				4_000,
				replacementCreatedAt,
			);
			expect(await repo.getSeries({ accountId })).toHaveLength(2);
		} finally {
			db.close();
		}
	});

	it("records limits[]-only payload (session/weekly_all/weekly_scoped, no flat windows)", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{
				limits: [
					{ kind: "session", percent: 42, resets_at: "2026-07-05T12:00:00Z" },
					{ kind: "weekly_all", percent: 7, resets_at: null },
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: null,
						scope: { model: { display_name: "Fable" } },
					},
				],
			},
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows.map((r) => r.windowKey).sort()).toEqual([
			"five_hour",
			"seven_day",
			"seven_day_fable",
		]);
		const fiveH = rows.find((r) => r.windowKey === "five_hour");
		expect(fiveH?.utilization).toBe(42);
		expect(fiveH?.resetsAt).toBe(new Date("2026-07-05T12:00:00Z").getTime());
		const fable = rows.find((r) => r.windowKey === "seven_day_fable");
		expect(fable?.utilization).toBe(100);
		db.close();
	});

	it("does not double-count a flat window already present in limits[]", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{
				five_hour: { utilization: 10, resets_at: null },
				limits: [{ kind: "session", percent: 99, resets_at: null }],
			},
			1000,
		);
		const rows = await repo.getSeries({
			accountId: "acc1",
			windowKey: "five_hour",
		});
		// Flat window wins; the limits[] session entry for the same key is skipped.
		expect(rows.length).toBe(1);
		expect(rows[0].utilization).toBe(10);
		db.close();
	});

	it("ignores limits[] entries with unknown kind or missing model name", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{
				limits: [
					{ kind: "overage", percent: 50, resets_at: null },
					{ kind: "weekly_scoped", percent: 80, resets_at: null, scope: {} },
				],
			},
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows).toEqual([]);
		db.close();
	});

	it("records every poll (no dedup) so flat windows stay a continuous series", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const usage = { five_hour: { utilization: 10, resets_at: null } };
		await writeSnapshot(repo, "acc1", usage, 1000);
		await writeSnapshot(repo, "acc1", usage, 2000); // same value → still stored
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 11, resets_at: null } },
			3000,
		);
		const rows = await repo.getSeries({
			accountId: "acc1",
			windowKey: "five_hour",
		});
		expect(rows.map((r) => r.utilization)).toEqual([10, 10, 11]);
		expect(rows.map((r) => r.timestamp)).toEqual([1000, 2000, 3000]);
		db.close();
	});

	it("drops a window whose explicit resets_at is malformed", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 5, resets_at: "not-a-date" } },
			1000,
		);
		// A malformed reset is rejected upstream by the canonical normalizer, so
		// the row never reaches history. Storing it as a null reset would make it
		// indistinguishable from a provider that legitimately has no cycle.
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows).toEqual([]);
		db.close();
	});

	it("keeps a window whose resets_at is explicitly absent", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 5, resets_at: null } },
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows).toHaveLength(1);
		expect(rows[0].resetsAt).toBeNull();
		db.close();
	});

	it("filters getSeries by time range and orders ascending", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 1, resets_at: null } },
			1000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 2, resets_at: null } },
			2000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 3, resets_at: null } },
			3000,
		);
		const rows = await repo.getSeries({
			accountId: "acc1",
			since: 1500,
			until: 2500,
		});
		expect(rows.map((r) => r.timestamp)).toEqual([2000]);
		db.close();
	});

	it("getLatestSnapshot returns the newest row for the window", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 11, resets_at: null } },
			1000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 22, resets_at: "2026-07-12T00:00:00Z" } },
			3000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 15, resets_at: null } },
			2000,
		);
		const latest = await repo.getLatestSnapshot("acc1", "seven_day");
		expect(latest?.timestamp).toBe(3000);
		expect(latest?.utilization).toBe(22);
		expect(latest?.resetsAt).toBe(new Date("2026-07-12T00:00:00Z").getTime());
		db.close();
	});

	it("treats a newest inactive snapshot as no live durable value while retaining raw history", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot(
			"acc1",
			[
				{
					windowKey: "seven_day",
					utilization: 20,
					resetsAtMs: null,
					scope: "account",
					modelFamily: null,
					active: true,
				},
			],
			1_000,
		);
		await repo.recordSnapshot(
			"acc1",
			[
				{
					windowKey: "seven_day",
					utilization: 80,
					resetsAtMs: null,
					scope: "account",
					modelFamily: null,
					active: false,
				},
			],
			2_000,
		);

		expect(await repo.getLatestSnapshot("acc1", "seven_day")).toBeNull();
		expect(
			(await repo.getSeries({ accountId: "acc1", windowKey: "seven_day" })).map(
				(row) => row.utilization,
			),
		).toEqual([20]);
		expect(
			(await repo.getRawSnapshots("acc1", "seven_day")).map(
				(row) => row.utilization,
			),
		).toEqual([20, 80]);
		db.close();
	});

	it("uses the later durable append order when snapshots share a timestamp", async () => {
		const db = makeDb();
		try {
			const repo = makeRepo(db);
			await repo.recordSnapshot(
				"acc1",
				[
					{
						windowKey: "seven_day",
						utilization: 20,
						resetsAtMs: null,
						scope: "account",
						modelFamily: null,
						active: true,
					},
				],
				1_000,
			);
			await repo.recordSnapshot(
				"acc1",
				[
					{
						windowKey: "seven_day",
						utilization: 80,
						resetsAtMs: null,
						scope: "account",
						modelFamily: null,
						active: true,
					},
				],
				1_000,
			);

			const appended = db
				.prepare(
					"SELECT append_order FROM usage_snapshots ORDER BY append_order ASC",
				)
				.all() as Array<{ append_order: number }>;
			expect(appended).toEqual([{ append_order: 1 }, { append_order: 2 }]);
			// The key remains logical data even if SQLite rewrites its storage layout.
			db.exec("VACUUM");

			expect(
				(await repo.getLatestSnapshot("acc1", "seven_day"))?.utilization,
			).toBe(80);
			expect(
				(
					await repo.getSeries({
						accountId: "acc1",
						windowKey: "seven_day",
					})
				).map((row) => row.utilization),
			).toEqual([20, 80]);
			expect(
				(await repo.getRawSnapshots("acc1", "seven_day")).map(
					(row) => row.utilization,
				),
			).toEqual([20, 80]);
			expect(
				(
					await repo.getFleetUsageHistory({
						accountIds: ["acc1"],
						windowKey: "seven_day",
					})
				).rows.map((row) => row.utilization),
			).toEqual([20, 80]);
		} finally {
			db.close();
		}
	});

	it("uses PostgreSQL append_order as the latest-snapshot append tie-break", async () => {
		let latestSql = "";
		const pgAdapter = {
			isSQLite: false,
			query: async <R>(sql: string): Promise<R[]> => {
				latestSql = sql;
				return [
					{
						account_id: "acc1",
						timestamp: 1_000,
						window_key: "seven_day",
						utilization: 80,
						resets_at: null,
						active: 1,
					},
				] as R[];
			},
		} as unknown as BunSqlAdapter;
		const repo = new UsageHistoryRepository(pgAdapter);

		expect(
			(await repo.getLatestSnapshot("acc1", "seven_day"))?.utilization,
		).toBe(80);
		expect(latestSql).toContain("ORDER BY timestamp DESC, append_order DESC");
		expect(latestSql).not.toContain("ctid");
	});

	it("uses append_order rather than physical row locations for PostgreSQL cleanup", async () => {
		let cleanupSql = "";
		const pgAdapter = {
			isSQLite: false,
			runWithChanges: async (sql: string): Promise<number> => {
				cleanupSql = sql;
				return 0;
			},
		} as unknown as BunSqlAdapter;
		const repo = new UsageHistoryRepository(pgAdapter);

		expect(await repo.deleteOlderThan(1_000)).toBe(0);
		expect(cleanupSql).toContain(
			"DELETE FROM usage_snapshots WHERE append_order IN",
		);
		expect(cleanupSql).not.toContain("ctid");
		expect(cleanupSql).not.toContain("rowid");
	});

	it("getLatestSnapshot isolates windows and accounts", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{
				five_hour: { utilization: 90, resets_at: null },
				seven_day: { utilization: 40, resets_at: null },
			},
			1000,
		);
		await writeSnapshot(
			repo,
			"acc2",
			{ seven_day: { utilization: 77, resets_at: null } },
			5000,
		);
		expect(
			(await repo.getLatestSnapshot("acc1", "seven_day"))?.utilization,
		).toBe(40);
		expect(
			(await repo.getLatestSnapshot("acc1", "five_hour"))?.utilization,
		).toBe(90);
		expect(
			(await repo.getLatestSnapshot("acc2", "seven_day"))?.utilization,
		).toBe(77);
		db.close();
	});

	it("getLatestSnapshot returns null when the window was never recorded", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 5, resets_at: null } },
			1000,
		);
		expect(await repo.getLatestSnapshot("acc1", "seven_day")).toBeNull();
		expect(await repo.getLatestSnapshot("missing", "five_hour")).toBeNull();
		db.close();
	});

	it("deleteOlderThan prunes by timestamp", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 1, resets_at: null } },
			1000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 2, resets_at: null } },
			5000,
		);
		const removed = await repo.deleteOlderThan(3000);
		expect(removed).toBe(1);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows.map((r) => r.timestamp)).toEqual([5000]);
		db.close();
	});
});

describe("UsageHistoryRepository.getRawSnapshots", () => {
	it("returns ordered snapshots for one account+window key, excluding other keys/accounts", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 10, resets_at: "2026-08-10T00:00:00Z" } },
			1000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 20, resets_at: "2026-08-10T00:00:00Z" } },
			2000,
		);
		// Different window key on the same account -> excluded.
		await writeSnapshot(
			repo,
			"acc1",
			{ five_hour: { utilization: 99, resets_at: null } },
			1500,
		);
		// Same window key on a different account -> excluded.
		await writeSnapshot(
			repo,
			"acc2",
			{ seven_day: { utilization: 50, resets_at: "2026-08-10T00:00:00Z" } },
			1200,
		);
		const rows = await repo.getRawSnapshots("acc1", "seven_day");
		expect(rows).toEqual([
			{
				timestampMs: 1000,
				utilization: 10,
				resetsAtMs: new Date("2026-08-10T00:00:00Z").getTime(),
			},
			{
				timestampMs: 2000,
				utilization: 20,
				resetsAtMs: new Date("2026-08-10T00:00:00Z").getTime(),
			},
		]);
		db.close();
	});

	it("filters by sinceMs", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 10, resets_at: "2026-08-10T00:00:00Z" } },
			1000,
		);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 20, resets_at: "2026-08-10T00:00:00Z" } },
			2000,
		);
		const rows = await repo.getRawSnapshots("acc1", "seven_day", 1500);
		expect(rows.map((r) => r.timestampMs)).toEqual([2000]);
		db.close();
	});

	it("defaults sinceMs to 0 (full history)", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await writeSnapshot(
			repo,
			"acc1",
			{ seven_day: { utilization: 10, resets_at: "2026-08-10T00:00:00Z" } },
			1000,
		);
		const rows = await repo.getRawSnapshots("acc1", "seven_day");
		expect(rows).toHaveLength(1);
		db.close();
	});

	it("returns an empty array for an account/key with no history", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const rows = await repo.getRawSnapshots("acc-none", "seven_day");
		expect(rows).toEqual([]);
		db.close();
	});
});

// ---------------------------------------------------------------------------
// Facade smoke test: exercise the usage-history methods through a real
// in-memory DatabaseOperations. Construction opens no background workers and
// touches no real path when given ":memory:", so it is safe in a unit test.
// ---------------------------------------------------------------------------

describe("DatabaseOperations usage-history facade", () => {
	it("round-trips a snapshot through recordUsageSnapshot / getUsageHistory", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ five_hour: { utilization: 42, resets_at: "2026-07-05T12:00:00Z" } },
				1000,
			);
			const rows = await dbOps.getUsageHistory({ accountId: "acc1" });
			expect(rows).toHaveLength(1);
			expect(rows[0].windowKey).toBe("five_hour");
			expect(rows[0].utilization).toBe(42);
			expect(rows[0].timestamp).toBe(1000);
			expect(rows[0].resetsAt).toBe(new Date("2026-07-05T12:00:00Z").getTime());
		} finally {
			await dbOps.dispose();
		}
	});

	it("getUsageHistory forwards windowKey/since/until to getSeries", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ five_hour: { utilization: 1, resets_at: null } },
				1000,
			);
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ five_hour: { utilization: 2, resets_at: null } },
				2000,
			);
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ seven_day: { utilization: 9, resets_at: null } },
				2000,
			);
			const rows = await dbOps.getUsageHistory({
				accountId: "acc1",
				windowKey: "five_hour",
				since: 1500,
				until: 2500,
			});
			expect(rows.map((r) => r.timestamp)).toEqual([2000]);
			expect(rows[0].windowKey).toBe("five_hour");
		} finally {
			await dbOps.dispose();
		}
	});

	it("getLatestUsageSnapshot returns the newest weekly row, or null", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			expect(
				await dbOps.getLatestUsageSnapshot("acc1", "seven_day"),
			).toBeNull();
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ seven_day: { utilization: 12, resets_at: null } },
				1000,
			);
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ seven_day: { utilization: 34, resets_at: null } },
				2000,
			);
			const latest = await dbOps.getLatestUsageSnapshot("acc1", "seven_day");
			expect(latest?.utilization).toBe(34);
			expect(latest?.timestamp).toBe(2000);
			expect(latest?.windowKey).toBe("seven_day");
		} finally {
			await dbOps.dispose();
		}
	});

	it("pruneUsageSnapshots deletes rows older than the cutoff and returns the count", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ five_hour: { utilization: 1, resets_at: null } },
				1000,
			);
			await writeDbSnapshot(
				dbOps,
				"acc1",
				{ five_hour: { utilization: 2, resets_at: null } },
				5000,
			);
			const removed = await dbOps.pruneUsageSnapshots(3000);
			expect(removed).toBe(1);
			const rows = await dbOps.getUsageHistory({ accountId: "acc1" });
			expect(rows.map((r) => r.timestamp)).toEqual([5000]);
		} finally {
			await dbOps.dispose();
		}
	});
});
