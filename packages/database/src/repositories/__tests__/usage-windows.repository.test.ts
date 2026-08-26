import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { UsageWindowsRepository } from "../usage-windows.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function makeRepo(db: Database): UsageWindowsRepository {
	return new UsageWindowsRepository(new BunSqlAdapter(db));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("usage_windows schema", () => {
	it("creates the usage_windows table", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='usage_windows'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("usage_windows");
		db.close();
	});

	it("creates the unique idempotent-backfill index", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_windows_unique'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("idx_usage_windows_unique");
		db.close();
	});

	it("creates the closed_at lookup index", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_windows_closed'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("idx_usage_windows_closed");
		db.close();
	});
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("UsageWindowsRepository", () => {
	describe("openWindow / getOpenWindow", () => {
		it("opens a new window with the given grant type and zeroed peak utilization", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			expect(window.accountId).toBe("acc1");
			expect(window.windowKey).toBe("five_hour");
			expect(window.startedAt).toBe(1000);
			expect(window.resetsAt).toBe(6000);
			expect(window.closedAt).toBeNull();
			expect(window.grantType).toBe("natural");
			expect(window.peakUtilization).toBe(0);
			expect(window.first100At).toBeNull();
			expect(window.valueUsd).toBeNull();
			db.close();
		});

		it("is idempotent on (account_id, window_key, resets_at): a second open returns the same row", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const first = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			const second = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "early_reset",
			});
			// Losing insert is discarded; the surviving row keeps the original id
			// and grant_type from the first open.
			expect(second.id).toBe(first.id);
			expect(second.grantType).toBe("natural");
		});

		it("getOpenWindow returns null when no open window exists", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const result = await repo.getOpenWindow("acc1", "five_hour");
			expect(result).toBeNull();
			db.close();
		});

		it("getOpenWindow finds the open window and ignores closed ones", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const closed = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.closeWindow(closed.id, {
				closedAt: 6000,
				valueUsd: 1.5,
				inputTokens: null,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				outputTokens: null,
				requestCount: null,
				modelBreakdown: null,
				unpricedTokens: null,
				projectionVersion: null,
			});
			const open = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 6000,
				resetsAt: 11000,
				grantType: "natural",
			});
			const result = await repo.getOpenWindow("acc1", "five_hour");
			expect(result?.id).toBe(open.id);
			db.close();
		});
	});

	describe("recordUtilization", () => {
		it("raises peak_utilization only when the new reading is higher", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.recordUtilization(window.id, 40, 1500);
			let current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.peakUtilization).toBe(40);

			// Lower reading does not regress the peak.
			await repo.recordUtilization(window.id, 20, 2000);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.peakUtilization).toBe(40);

			// Higher reading raises it again.
			await repo.recordUtilization(window.id, 75, 2500);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.peakUtilization).toBe(75);
			db.close();
		});

		it("sets first_100_at exactly once, on the first reading >= 100", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.recordUtilization(window.id, 60, 1500);
			let current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.first100At).toBeNull();

			await repo.recordUtilization(window.id, 100, 2000);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.first100At).toBe(2000);
			expect(current?.peakUtilization).toBe(100);

			// A later reading (even another >=100 one) must not move first_100_at.
			await repo.recordUtilization(window.id, 105, 3000);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.first100At).toBe(2000);
			expect(current?.peakUtilization).toBe(105);
			db.close();
		});
	});

	describe("closeWindow", () => {
		it("round-trips closedAt and aggregates", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			const closed = await repo.closeWindow(window.id, {
				closedAt: 6000,
				valueUsd: 12.34,
				inputTokens: 1000,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 50,
				outputTokens: 500,
				requestCount: 7,
				modelBreakdown: { "claude-opus-4": { requests: 7 } },
				unpricedTokens: 0,
				projectionVersion: "v1",
			});
			expect(closed).toBe(true);

			const rows = await repo.listWindows({ accountId: "acc1" });
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row.closedAt).toBe(6000);
			expect(row.valueUsd).toBe(12.34);
			expect(row.inputTokens).toBe(1000);
			expect(row.cacheReadInputTokens).toBe(200);
			expect(row.cacheCreationInputTokens).toBe(50);
			expect(row.outputTokens).toBe(500);
			expect(row.requestCount).toBe(7);
			expect(row.modelBreakdown).toEqual({ "claude-opus-4": { requests: 7 } });
			expect(row.unpricedTokens).toBe(0);
			expect(row.projectionVersion).toBe("v1");
			db.close();
		});

		it("returns false and does not overwrite an already-closed window", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.closeWindow(window.id, {
				closedAt: 6000,
				valueUsd: 1,
				inputTokens: null,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				outputTokens: null,
				requestCount: null,
				modelBreakdown: null,
				unpricedTokens: null,
				projectionVersion: null,
			});
			const secondClose = await repo.closeWindow(window.id, {
				closedAt: 9999,
				valueUsd: 999,
				inputTokens: null,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				outputTokens: null,
				requestCount: null,
				modelBreakdown: null,
				unpricedTokens: null,
				projectionVersion: null,
			});
			expect(secondClose).toBe(false);

			const rows = await repo.listWindows({ accountId: "acc1" });
			expect(rows[0].closedAt).toBe(6000);
			expect(rows[0].valueUsd).toBe(1);
			db.close();
		});
	});

	describe("listWindows", () => {
		it("filters by accountId and windowKey, ordered by resets_at desc", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 11000,
				resetsAt: 16000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "seven_day",
				startedAt: 1000,
				resetsAt: 20000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc2",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});

			const rows = await repo.listWindows({
				accountId: "acc1",
				windowKey: "five_hour",
			});
			expect(rows.map((r) => r.resetsAt)).toEqual([16000, 6000]);
			expect(rows.every((r) => r.accountId === "acc1")).toBe(true);
			db.close();
		});

		it("filters by sinceMs and lists across all accounts when accountId omitted", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc2",
				windowKey: "five_hour",
				startedAt: 11000,
				resetsAt: 16000,
				grantType: "natural",
			});

			const rows = await repo.listWindows({ sinceMs: 10000 });
			expect(rows).toHaveLength(1);
			expect(rows[0].accountId).toBe("acc2");
			db.close();
		});
	});
});

// ---------------------------------------------------------------------------
// Facade smoke test: exercise the usage-windows methods through a real
// in-memory DatabaseOperations, mirroring the usage-history facade tests.
// DatabaseOperations treats DATABASE_URL as authoritative, even with an
// explicit :memory: path, so this SQLite-only smoke test cannot run live.
// ---------------------------------------------------------------------------

const databaseOperationsUsesPostgres = Boolean(
	process.env.DATABASE_URL?.startsWith("postgres://") ||
		process.env.DATABASE_URL?.startsWith("postgresql://"),
);

describe("DatabaseOperations usage-windows facade", () => {
	it.skipIf(databaseOperationsUsesPostgres)(
		"round-trips open / recordUtilization / close through the facade",
		async () => {
			const dbOps = new DatabaseOperations(":memory:", { walMode: false });
			try {
				const window = await dbOps.openUsageWindow({
					accountId: "acc1",
					windowKey: "five_hour",
					startedAt: 1000,
					resetsAt: 6000,
					grantType: "natural",
				});
				await dbOps.recordUsageWindowUtilization(window.id, 100, 2000);
				const open = await dbOps.getOpenUsageWindow("acc1", "five_hour");
				expect(open?.peakUtilization).toBe(100);
				expect(open?.first100At).toBe(2000);

				const closed = await dbOps.closeUsageWindow(window.id, {
					closedAt: 6000,
					valueUsd: 3.5,
					inputTokens: null,
					cacheReadInputTokens: null,
					cacheCreationInputTokens: null,
					outputTokens: null,
					requestCount: null,
					modelBreakdown: null,
					unpricedTokens: null,
					projectionVersion: null,
				});
				expect(closed).toBe(true);

				const rows = await dbOps.listUsageWindows({ accountId: "acc1" });
				expect(rows).toHaveLength(1);
				expect(rows[0].valueUsd).toBe(3.5);
			} finally {
				await dbOps.dispose();
			}
		},
	);
});

// ---------------------------------------------------------------------------
// Live PostgreSQL smoke test — only runs when a real PG server is reachable.
// Mirrors the DATABASE_URL-gated safety check in migrations-pg.test.ts
// (isSafeDisposableLoopbackTestPgUrl / describe.skipIf(!livePgAvailable)):
// loopback host + a database name containing "test" only.
// ---------------------------------------------------------------------------

function isSafeDisposableLoopbackTestPgUrl(value: string | undefined): boolean {
	if (!value) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		return false;
	}
	const host = url.hostname.toLowerCase();
	const loopback =
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "[::1]";
	const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
	return loopback && dbName.toLowerCase().includes("test");
}

const livePgAvailable = isSafeDisposableLoopbackTestPgUrl(
	process.env.DATABASE_URL,
);

describe.skipIf(!livePgAvailable)(
	"UsageWindowsRepository (live PostgreSQL, requires DATABASE_URL)",
	() => {
		it("round-trips open / recordUtilization / close against a real PG server", async () => {
			const { SQL } = await import("bun");
			const { randomUUID } = await import("node:crypto");
			const { ensureSchemaPg, runMigrationsPg } = await import(
				"../../migrations-pg"
			);

			// biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!livePgAvailable)
			const databaseUrl = process.env.DATABASE_URL!;
			const sqlClient = new SQL({ url: databaseUrl });
			const adapter = new BunSqlAdapter(sqlClient, false);
			// Scope this run to a private accountId so it can't collide with
			// rows left behind by a previous or concurrent run against the
			// same shared test database.
			const accountId = `usage-windows-test-${randomUUID()}`;

			try {
				await ensureSchemaPg(adapter);
				await runMigrationsPg(adapter);

				const repo = new UsageWindowsRepository(adapter);
				const opened = await repo.openWindow({
					accountId,
					windowKey: "five_hour",
					startedAt: 1000,
					resetsAt: 6000,
					grantType: "natural",
				});
				expect(opened.peakUtilization).toBe(0);

				// Idempotent re-open on the same unique key returns the same row.
				const reopened = await repo.openWindow({
					accountId,
					windowKey: "five_hour",
					startedAt: 1000,
					resetsAt: 6000,
					grantType: "early_reset",
				});
				expect(reopened.id).toBe(opened.id);
				expect(reopened.grantType).toBe("natural");

				await repo.recordUtilization(opened.id, 100, 2000);
				const open = await repo.getOpenWindow(accountId, "five_hour");
				expect(open?.peakUtilization).toBe(100);
				expect(open?.first100At).toBe(2000);

				const closed = await repo.closeWindow(opened.id, {
					closedAt: 6000,
					valueUsd: 2.75,
					inputTokens: 10,
					cacheReadInputTokens: null,
					cacheCreationInputTokens: null,
					outputTokens: null,
					requestCount: 1,
					modelBreakdown: { "claude-opus-4": { requests: 1 } },
					unpricedTokens: null,
					projectionVersion: "v1",
				});
				expect(closed).toBe(true);
				expect(await repo.getOpenWindow(accountId, "five_hour")).toBeNull();

				const rows = await repo.listWindows({ accountId });
				expect(rows).toHaveLength(1);
				expect(rows[0].valueUsd).toBe(2.75);
				expect(rows[0].modelBreakdown).toEqual({
					"claude-opus-4": { requests: 1 },
				});
			} finally {
				await adapter.run("DELETE FROM usage_windows WHERE account_id = ?", [
					accountId,
				]);
				await adapter.close();
			}
		});

		it("enforces expectedCreatedAt after a same-id account generation replacement", async () => {
			const { SQL } = await import("bun");
			const { randomUUID } = await import("node:crypto");
			const { ensureSchemaPg, runMigrationsPg } = await import(
				"../../migrations-pg"
			);

			// biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!livePgAvailable)
			const databaseUrl = process.env.DATABASE_URL!;
			const sqlClient = new SQL({ url: databaseUrl });
			const adapter = new BunSqlAdapter(sqlClient, false);
			const accountId = `usage-windows-generation-fence-${randomUUID()}`;
			const generationA = 100;
			const generationB = 200;
			const closeInput = {
				closedAt: 7_000,
				valueUsd: 1,
				inputTokens: 1,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				requestCount: 1,
				modelBreakdown: null,
				unpricedTokens: 0,
				projectionVersion: "v1",
			};

			try {
				await ensureSchemaPg(adapter);
				await runMigrationsPg(adapter);
				const repo = new UsageWindowsRepository(adapter);
				await adapter.run(
					"INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)",
					[accountId, "generation A", generationA],
				);
				const generationAWindow = await repo.openWindow(
					{
						accountId,
						windowKey: "seven_day",
						startedAt: 1_000,
						resetsAt: 7_000,
						grantType: "natural",
					},
					generationA,
				);
				expect(generationAWindow?.accountId).toBe(accountId);

				// PostgreSQL cascades the old window when generation A is deleted.
				// Open a B-owned row so stale A update/close attempts exercise their
				// generation predicates rather than merely targeting a deleted row.
				await adapter.run("DELETE FROM accounts WHERE id = ?", [accountId]);
				await adapter.run(
					"INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)",
					[accountId, "generation B", generationB],
				);

				expect(
					await repo.openWindow(
						{
							accountId,
							windowKey: "seven_day",
							startedAt: 7_000,
							resetsAt: 14_000,
							grantType: "natural",
						},
						generationA,
					),
				).toBeNull();
				const generationBWindow = await repo.openWindow(
					{
						accountId,
						windowKey: "seven_day",
						startedAt: 7_000,
						resetsAt: 14_000,
						grantType: "natural",
					},
					generationB,
				);
				if (!generationBWindow) {
					throw new Error("Generation B failed to open its usage window");
				}

				await repo.recordUtilization(
					generationBWindow.id,
					90,
					2_000,
					generationA,
				);
				expect(
					(await repo.getOpenWindow(accountId, "seven_day"))?.peakUtilization,
				).toBe(0);
				expect(
					await repo.closeWindow(generationBWindow.id, closeInput, generationA),
				).toBe(false);
				expect(
					(await repo.getOpenWindow(accountId, "seven_day"))?.closedAt,
				).toBeNull();

				await repo.recordUtilization(
					generationBWindow.id,
					90,
					2_000,
					generationB,
				);
				expect(
					(await repo.getOpenWindow(accountId, "seven_day"))?.peakUtilization,
				).toBe(90);
				expect(
					await repo.closeWindow(generationBWindow.id, closeInput, generationB),
				).toBe(true);
			} finally {
				try {
					await adapter.run("DELETE FROM usage_windows WHERE account_id = ?", [
						accountId,
					]);
				} finally {
					try {
						await adapter.run("DELETE FROM accounts WHERE id = ?", [accountId]);
					} finally {
						await adapter.close();
					}
				}
			}
		});
	},
);

describe("UsageWindowsRepository generation fences", () => {
	it("rejects stale-generation opens, utilization, and closes while permitting the replacement generation", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const accountId = "generation-fence-account";
		const generationA = 100;
		const generationB = 200;
		db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
			accountId,
			"generation A",
			generationA,
		]);
		const existing = await repo.openWindow({
			accountId,
			windowKey: "seven_day",
			startedAt: 1_000,
			resetsAt: 7_000,
			grantType: "natural",
		});

		db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
		db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
			accountId,
			"generation B",
			generationB,
		]);

		const staleOpen = await repo.openWindow(
			{
				accountId,
				windowKey: "seven_day",
				startedAt: 7_000,
				resetsAt: 14_000,
				grantType: "natural",
			},
			generationA,
		);
		expect(staleOpen).toBeNull();
		await repo.recordUtilization(existing.id, 90, 2_000, generationA);
		expect(
			(await repo.getOpenWindow(accountId, "seven_day"))?.peakUtilization,
		).toBe(0);
		expect(
			await repo.closeWindow(
				existing.id,
				{
					closedAt: 7_000,
					valueUsd: 1,
					inputTokens: 1,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					outputTokens: 0,
					requestCount: 1,
					modelBreakdown: null,
					unpricedTokens: 0,
					projectionVersion: "v1",
				},
				generationA,
			),
		).toBe(false);
		expect(
			(await repo.getOpenWindow(accountId, "seven_day"))?.closedAt,
		).toBeNull();

		await repo.recordUtilization(existing.id, 90, 2_000, generationB);
		expect(
			(await repo.getOpenWindow(accountId, "seven_day"))?.peakUtilization,
		).toBe(90);
		expect(
			await repo.closeWindow(
				existing.id,
				{
					closedAt: 7_000,
					valueUsd: 1,
					inputTokens: 1,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					outputTokens: 0,
					requestCount: 1,
					modelBreakdown: null,
					unpricedTokens: 0,
					projectionVersion: "v1",
				},
				generationB,
			),
		).toBe(true);
		const replacementOpen = await repo.openWindow(
			{
				accountId,
				windowKey: "seven_day",
				startedAt: 7_000,
				resetsAt: 14_000,
				grantType: "natural",
			},
			generationB,
		);
		expect(replacementOpen?.accountId).toBe(accountId);
		db.close();
	});
});
