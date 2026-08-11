/**
 * SQLite ↔ PostgreSQL schema parity tests.
 *
 * This repo maintains two independent migration implementations —
 * `migrations.ts` (SQLite) and `migrations-pg.ts` (PostgreSQL) — that must
 * stay in lockstep (see repo CLAUDE.md, "Database Migrations — Port to
 * PostgreSQL"). A column or table added to one and forgotten on the other
 * silently breaks whichever backend was missed (e.g. the `strategies` table
 * gap found in a manual audit). This file closes that gap with an automated
 * check that runs everywhere (no live database required) plus an optional
 * live-PostgreSQL smoke test.
 *
 * Approach:
 *  - SQLite inventory: ground truth, obtained by running `ensureSchema()` +
 *    `runMigrations()` against a real in-memory `bun:sqlite` database and
 *    introspecting `sqlite_master` / `PRAGMA table_info`.
 *  - PostgreSQL inventory: no live PG server is available in this dev/CI
 *    environment, so `migrations-pg.ts` is read as source text and its
 *    `CREATE TABLE IF NOT EXISTS` blocks (from both `ensureSchemaPg` and the
 *    upgrade-safety re-creates inside `runMigrationsPg`) plus the
 *    `columnsToAdd` array are parsed for table/column names. This mirrors
 *    the existing static-parity pattern already used for the attribution
 *    source columns at the bottom of `migrations.test.ts`.
 *
 * Only column *names* are compared, never types — SQLite is dynamically
 * typed and PostgreSQL isn't, so e.g. `INTEGER` vs `BIGINT` is an expected,
 * intentional divergence, not a parity bug.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CacheFlightCohortSealReceipt,
	CacheFlightKeepalivePolicySnapshot,
	TurnEvidence,
} from "@better-ccflare/core";
import { ensureSchema, runMigrations } from "./migrations";
import { runMigrationsPg } from "./migrations-pg";

const PG_SOURCE_PATH = path.join(__dirname, "migrations-pg.ts");

/**
 * Tables that are intentionally present on one backend only, or whose
 * columns are known/justified to diverge. Empty by design — parity should
 * be exact after the audit that motivated this test. Add an entry here
 * (with a comment explaining why) only if a genuine, deliberate divergence
 * is discovered; do not use this as an escape hatch for an accidental gap.
 */
const KNOWN_TABLE_EXCEPTIONS: ReadonlySet<string> = new Set();

/** table -> set of column names known/justified to exist on one side only. */
const KNOWN_COLUMN_EXCEPTIONS: Readonly<Record<string, ReadonlySet<string>>> =
	{};

// ---------------------------------------------------------------------------
// SQLite inventory (ground truth via real execution)
// ---------------------------------------------------------------------------

interface SchemaInventory {
	/** table name -> set of column names */
	tables: Map<string, Set<string>>;
}

function buildSqliteInventory(): SchemaInventory {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);

		const tableRows = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
			)
			.all() as Array<{ name: string }>;

		const tables = new Map<string, Set<string>>();
		for (const { name } of tableRows) {
			const columns = (
				db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
					name: string;
				}>
			).map((c) => c.name);
			tables.set(name, new Set(columns));
		}
		return { tables };
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// PostgreSQL inventory (static source-text extraction)
// ---------------------------------------------------------------------------

/**
 * Given source text and the index right after an opening `(`, find the
 * index of its matching closing `)` — balances nested parens so a
 * `FOREIGN KEY (col) REFERENCES other(id)` inside the body doesn't
 * terminate the scan early.
 */
function findMatchingParen(source: string, openParenIndex: number): number {
	let depth = 1;
	let i = openParenIndex + 1;
	while (i < source.length && depth > 0) {
		if (source[i] === "(") depth++;
		else if (source[i] === ")") depth--;
		i++;
	}
	return i - 1;
}

/**
 * Extract column names from a `CREATE TABLE (...)` body. Splits on
 * top-level commas (depth 0, outside parens) and takes the first
 * whitespace-delimited token of each clause as the column name, skipping
 * clauses that are table-level constraints (FOREIGN KEY, PRIMARY KEY,
 * UNIQUE, CHECK) rather than column definitions.
 */
function extractColumnNames(body: string): string[] {
	const clauses: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of body) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			clauses.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) clauses.push(current);

	const tableLevelKeywords = new Set([
		"FOREIGN",
		"PRIMARY",
		"UNIQUE",
		"CHECK",
		"CONSTRAINT",
	]);

	const columns: string[] = [];
	for (const clause of clauses) {
		const trimmed = clause.trim();
		if (!trimmed) continue;
		const firstToken = trimmed.split(/\s+/)[0];
		if (tableLevelKeywords.has(firstToken.toUpperCase())) continue;
		columns.push(firstToken);
	}
	return columns;
}

/**
 * Parse all `CREATE TABLE IF NOT EXISTS <name> (...)` blocks from PG source
 * text, merging columns across repeated definitions of the same table name
 * (runMigrationsPg re-declares a handful of tables for upgrade-safety —
 * their column sets must be a subset of / consistent with ensureSchemaPg's).
 */
function parsePgCreateTables(source: string): Map<string, Set<string>> {
	const tables = new Map<string, Set<string>>();
	const headerRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = headerRe.exec(source)) !== null) {
		const tableName = match[1];
		const openParenIndex = match.index + match[0].length - 1;
		const closeParenIndex = findMatchingParen(source, openParenIndex);
		const body = source.slice(openParenIndex + 1, closeParenIndex);
		const columns = extractColumnNames(body);

		const existing = tables.get(tableName) ?? new Set<string>();
		for (const col of columns) existing.add(col);
		tables.set(tableName, existing);
	}
	return tables;
}

/**
 * Parse the `columnsToAdd: ColumnToAdd[] = [...]` array in runMigrationsPg
 * and return { table, column } pairs. Extracted from the `table:`/`column:`
 * fields directly rather than the `definition` string, matching the
 * `ColumnToAdd` interface shape used by `addColumnTolerant`.
 */
function parsePgColumnsToAdd(
	source: string,
): Array<{ table: string; column: string }> {
	const arrayMatch = source.match(
		/const columnsToAdd: ColumnToAdd\[\] = \[([\s\S]*?)\n\t\];/,
	);
	expect(arrayMatch).not.toBeNull();
	const arrayBody = arrayMatch?.[1] ?? "";

	const entries: Array<{ table: string; column: string }> = [];
	const entryRe = /table:\s*"([^"]+)",\s*\n\s*column:\s*"([^"]+)"/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = entryRe.exec(arrayBody)) !== null) {
		entries.push({ table: match[1], column: match[2] });
	}
	return entries;
}

function buildPgInventory(source: string): SchemaInventory {
	const tables = parsePgCreateTables(source);

	for (const { table, column } of parsePgColumnsToAdd(source)) {
		const existing = tables.get(table) ?? new Set<string>();
		existing.add(column);
		tables.set(table, existing);
	}

	return { tables };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SQLite <-> PostgreSQL migration schema parity (static)", () => {
	const pgSource = fs.readFileSync(PG_SOURCE_PATH, "utf8");
	const sqliteInventory = buildSqliteInventory();
	const pgInventory = buildPgInventory(pgSource);

	it("extracted a non-trivial inventory from both sides (sanity check)", () => {
		// Guards against a regex/extraction regression silently producing an
		// empty inventory, which would make every parity assertion below
		// vacuously true instead of actually checking anything.
		expect(sqliteInventory.tables.size).toBeGreaterThan(10);
		expect(pgInventory.tables.size).toBeGreaterThan(10);
		expect(sqliteInventory.tables.get("accounts")?.size ?? 0).toBeGreaterThan(
			10,
		);
		expect(pgInventory.tables.get("accounts")?.size ?? 0).toBeGreaterThan(10);
	});

	it("every SQLite table has a matching PostgreSQL table", () => {
		const missingOnPg = [...sqliteInventory.tables.keys()].filter(
			(table) =>
				!pgInventory.tables.has(table) && !KNOWN_TABLE_EXCEPTIONS.has(table),
		);
		expect(missingOnPg).toEqual([]);
	});

	it("every PostgreSQL table has a matching SQLite table", () => {
		const missingOnSqlite = [...pgInventory.tables.keys()].filter(
			(table) =>
				!sqliteInventory.tables.has(table) &&
				!KNOWN_TABLE_EXCEPTIONS.has(table),
		);
		expect(missingOnSqlite).toEqual([]);
	});

	it("every SQLite column has a matching PostgreSQL column (per table)", () => {
		const gaps: string[] = [];
		for (const [table, sqliteColumns] of sqliteInventory.tables) {
			if (KNOWN_TABLE_EXCEPTIONS.has(table)) continue;
			const pgColumns = pgInventory.tables.get(table);
			if (!pgColumns) continue; // reported by the table-parity test above
			const exceptions = KNOWN_COLUMN_EXCEPTIONS[table] ?? new Set();
			for (const col of sqliteColumns) {
				if (!pgColumns.has(col) && !exceptions.has(col)) {
					gaps.push(
						`${table}.${col} exists in SQLite but not in migrations-pg.ts`,
					);
				}
			}
		}
		expect(gaps).toEqual([]);
	});

	it("every PostgreSQL column has a matching SQLite column (per table)", () => {
		const gaps: string[] = [];
		for (const [table, pgColumns] of pgInventory.tables) {
			if (KNOWN_TABLE_EXCEPTIONS.has(table)) continue;
			const sqliteColumns = sqliteInventory.tables.get(table);
			if (!sqliteColumns) continue; // reported by the table-parity test above
			const exceptions = KNOWN_COLUMN_EXCEPTIONS[table] ?? new Set();
			for (const col of pgColumns) {
				if (!sqliteColumns.has(col) && !exceptions.has(col)) {
					gaps.push(
						`${table}.${col} exists in migrations-pg.ts but not in SQLite`,
					);
				}
			}
		}
		expect(gaps).toEqual([]);
	});

	it("spot check: strategies table is present on both backends", () => {
		expect(sqliteInventory.tables.has("strategies")).toBe(true);
		expect(pgInventory.tables.has("strategies")).toBe(true);
		expect(sqliteInventory.tables.get("strategies")).toEqual(
			new Set(["name", "config", "updated_at"]),
		);
		expect(pgInventory.tables.get("strategies")).toEqual(
			new Set(["name", "config", "updated_at"]),
		);
	});

	it("spot check: newly-ported performance indexes exist in migrations-pg.ts", () => {
		expect(pgSource).toContain("idx_requests_cleanup");
		expect(pgSource).toContain("idx_request_payloads_cleanup");
		expect(pgSource).toContain("idx_requests_summary_covering");
		expect(pgSource).toContain("idx_requests_analytics_covering");
	});

	it("spot check: cache flight cohort seal registry DDL and indexes are ported to PostgreSQL", () => {
		expect(pgSource).toContain(
			"CREATE TABLE IF NOT EXISTS cache_flight_recorder_service_epochs",
		);
		expect(pgSource).toContain(
			"CREATE TABLE IF NOT EXISTS cache_flight_recorder_partitions",
		);
		expect(pgSource).toContain(
			"ALTER TABLE cache_flight_recorder_turns ADD COLUMN observation_partition_id TEXT",
		);
		expect(pgSource).toContain(
			"REFERENCES cache_flight_recorder_service_epochs(id)",
		);
		expect(pgSource).toContain(
			"REFERENCES cache_flight_recorder_partitions(id)",
		);
		expect(pgSource).toContain("idx_cache_flight_recorder_turns_partition");
		expect(pgSource).toContain("idx_cache_flight_recorder_partitions_epoch");
		expect(pgSource).toContain("idx_cache_flight_recorder_turns_cleanup");
	});

	it("creates cache flight seal registry tables before adding the legacy turn foreign key", async () => {
		const statements: string[] = [];
		let observationPartitionColumnAdded = false;
		const legacyLikeAdapter = {
			unsafe: async (sql: string) => {
				const normalized = sql.replace(/\s+/g, " ").trim();
				if (
					normalized.includes("CREATE INDEX") &&
					normalized.includes("cache_flight_recorder_turns") &&
					normalized.includes("observation_partition_id") &&
					!observationPartitionColumnAdded
				) {
					throw new Error(
						"turn observation_partition_id index was created before the legacy column ALTER",
					);
				}
				statements.push(normalized);
				if (
					normalized.includes(
						"ALTER TABLE cache_flight_recorder_turns ADD COLUMN observation_partition_id TEXT REFERENCES cache_flight_recorder_partitions(id)",
					)
				) {
					observationPartitionColumnAdded = true;
				}
				return [];
			},
			get: async <T>(
				sql: string,
				params?: readonly unknown[],
			): Promise<T | null> => {
				if (sql.includes("information_schema.columns")) {
					const [table, column] = params ?? [];
					return {
						exists:
							table === "cache_flight_recorder_turns" &&
							column === "observation_partition_id"
								? 0
								: 1,
					} as T;
				}
				if (sql.includes("pg_indexes")) {
					return { exists: 1 } as T;
				}
				return null;
			},
			query: async () => [],
			run: async () => {},
			runWithChanges: async () => 0,
		};

		await runMigrationsPg(legacyLikeAdapter as never);

		const serviceEpochCreateIndex = statements.findIndex((sql) =>
			sql.includes(
				"CREATE TABLE IF NOT EXISTS cache_flight_recorder_service_epochs",
			),
		);
		const partitionCreateIndex = statements.findIndex((sql) =>
			sql.includes(
				"CREATE TABLE IF NOT EXISTS cache_flight_recorder_partitions",
			),
		);
		const turnReferenceAlterIndex = statements.findIndex((sql) =>
			sql.includes(
				"ALTER TABLE cache_flight_recorder_turns ADD COLUMN observation_partition_id TEXT REFERENCES cache_flight_recorder_partitions(id)",
			),
		);

		expect(serviceEpochCreateIndex).toBeGreaterThanOrEqual(0);
		expect(partitionCreateIndex).toBeGreaterThanOrEqual(0);
		expect(turnReferenceAlterIndex).toBeGreaterThanOrEqual(0);
		expect(serviceEpochCreateIndex).toBeLessThan(turnReferenceAlterIndex);
		expect(partitionCreateIndex).toBeLessThan(turnReferenceAlterIndex);

		const turnPartitionIndex = statements.findIndex((sql) =>
			sql.includes(
				"CREATE INDEX IF NOT EXISTS idx_cache_flight_recorder_turns_partition",
			),
		);
		const turnCleanupIndex = statements.findIndex((sql) =>
			sql.includes(
				"CREATE INDEX IF NOT EXISTS idx_cache_flight_recorder_turns_cleanup",
			),
		);
		expect(turnPartitionIndex).toBeGreaterThan(turnReferenceAlterIndex);
		expect(turnCleanupIndex).toBeGreaterThan(turnReferenceAlterIndex);
	});
});

// ---------------------------------------------------------------------------
// Live PostgreSQL smoke test — only runs when a real PG server is reachable.
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

describe("PostgreSQL live test safety gate", () => {
	it("only permits disposable loopback database URLs whose database name includes test", () => {
		expect(
			isSafeDisposableLoopbackTestPgUrl(
				"postgres://user:pass@127.0.0.1:5432/better_ccflare_test",
			),
		).toBe(true);
		expect(
			isSafeDisposableLoopbackTestPgUrl(
				"postgres://user:pass@localhost/better_ccflare",
			),
		).toBe(false);
		expect(
			isSafeDisposableLoopbackTestPgUrl(
				"postgres://user:pass@db.internal/better_ccflare_test",
			),
		).toBe(false);
		expect(isSafeDisposableLoopbackTestPgUrl(undefined)).toBe(false);
	});
});

const livePgAvailable = isSafeDisposableLoopbackTestPgUrl(
	process.env.DATABASE_URL,
);

describe.skipIf(!livePgAvailable)(
	"PostgreSQL migrations (live, requires DATABASE_URL)",
	() => {
		it("ensureSchemaPg + runMigrationsPg complete without throwing and create expected objects", async () => {
			const { SQL } = await import("bun");
			const { BunSqlAdapter } = await import("./adapters/bun-sql-adapter");
			const { ensureSchemaPg, runMigrationsPg } = await import(
				"./migrations-pg"
			);

			// biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!livePgAvailable)
			const databaseUrl = process.env.DATABASE_URL!;
			const sqlClient = new SQL({ url: databaseUrl });
			const adapter = new BunSqlAdapter(sqlClient, false);

			try {
				await expect(ensureSchemaPg(adapter)).resolves.toBeUndefined();
				await expect(runMigrationsPg(adapter)).resolves.toBeUndefined();

				// Spot check: strategies table (the audit fix under test) exists
				// with the expected columns.
				const strategiesCols = await adapter.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns WHERE table_name = 'strategies'`,
				);
				const strategiesColNames = strategiesCols.map((c) => c.column_name);
				expect(strategiesColNames).toContain("name");
				expect(strategiesColNames).toContain("config");
				expect(strategiesColNames).toContain("updated_at");

				// Spot check: newly-ported performance indexes exist.
				const cleanupIndex = await adapter.get<{ exists: number }>(
					`SELECT COUNT(*) AS exists FROM pg_indexes WHERE indexname = 'idx_requests_cleanup'`,
				);
				expect(cleanupIndex?.exists ?? 0).toBeGreaterThan(0);

				const analyticsCoveringIndex = await adapter.get<{ exists: number }>(
					`SELECT COUNT(*) AS exists FROM pg_indexes WHERE indexname = 'idx_requests_analytics_covering'`,
				);
				expect(analyticsCoveringIndex?.exists ?? 0).toBeGreaterThan(0);

				// Spot check: the account-name-sanitization / API-key-storage
				// migrations ran without throwing (already asserted above via
				// runMigrationsPg resolving) — seed a bad-name account and a
				// legacy-key account beforehand isn't needed for this smoke
				// test since a fresh schema has no rows to sanitize/migrate;
				// this just confirms the full migration path completes clean
				// against a real server.
			} finally {
				await adapter.close();
			}
		});

		it("merges duplicate-account credentials from a single consistent row, not independently per column", async () => {
			// Regression test for a bug where collapseAccountDuplicatesPreservingStatePg
			// computed refresh_token/refresh_token_issued_at, access_token, and
			// expires_at via three INDEPENDENTLY-filtered subqueries. Each could
			// pick a DIFFERENT duplicate row, producing a mismatched credential
			// pair (e.g. a fresh refresh_token paired with a stale/unrelated
			// access_token) that fails at the provider. The fix reads all four
			// fields from the SAME freshest-row-with-a-refresh-token, mirroring
			// the SQLite helper's single nested `WHERE rowid = (SELECT rowid ...)`
			// structure.
			const { SQL } = await import("bun");
			const { BunSqlAdapter } = await import("./adapters/bun-sql-adapter");
			const {
				ensureSchemaPg,
				runMigrationsPg,
				collapseAccountDuplicatesPreservingStatePg,
			} = await import("./migrations-pg");

			// biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!livePgAvailable)
			const databaseUrl = process.env.DATABASE_URL!;
			const sqlClient = new SQL({ url: databaseUrl });
			const adapter = new BunSqlAdapter(sqlClient, false);

			try {
				await ensureSchemaPg(adapter);
				await runMigrationsPg(adapter);

				// runMigrationsPg only (re-)runs the collapse the first time
				// idx_accounts_unique_name_provider_endpoint is missing (see
				// the `if (uniqueAccountsIndexExists... === 0)` guard) — once
				// it exists, the whole block, collapse included, is a no-op.
				// Rather than fight that guard (dropping the index would
				// also let the duplicate insert below race a concurrent
				// re-create), call the collapse function directly — it's
				// the unit under test for this regression, and it's already
				// exported for exactly this purpose.
				const now = Date.now();

				// "newer" has the freshest refresh_token/refresh_token_issued_at
				// (so it's the row the fix must source ALL credential fields
				// from) but a NULL access_token/expires_at — e.g. a token that
				// was just refreshed but not yet exchanged.
				await adapter.unsafe(
					`INSERT INTO accounts
					   (id, name, provider, custom_endpoint, refresh_token, refresh_token_issued_at,
					    access_token, expires_at, created_at, last_used)
					 VALUES ($1, $2, $3, NULL, $4, $5, NULL, NULL, $6, $7)`,
					[
						"pg-dedup-newer",
						"pg-dedup-cred-test",
						"anthropic",
						"r-new",
						now,
						now - 10_000,
						now,
					],
				);
				// "older" has a stale refresh_token/refresh_token_issued_at but
				// a non-NULL access_token/expires_at. Pre-fix, the independent
				// per-column subqueries would pull access_token/expires_at from
				// THIS row (the only row with non-NULL values for those columns)
				// while refresh_token comes from "newer" — a mismatched pair.
				await adapter.unsafe(
					`INSERT INTO accounts
					   (id, name, provider, custom_endpoint, refresh_token, refresh_token_issued_at,
					    access_token, expires_at, created_at, last_used)
					 VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9)`,
					[
						"pg-dedup-older",
						"pg-dedup-cred-test",
						"anthropic",
						"r-old",
						now - 50_000,
						"a-old-stale-token",
						now + 999_999,
						now - 20_000,
						now - 50_000,
					],
				);

				// Directly invoke the collapse (see the note above on why —
				// runMigrationsPg's own retriggering of it is gated on the
				// UNIQUE index not existing yet, which is no longer true
				// after the ensureSchemaPg/runMigrationsPg call above).
				await collapseAccountDuplicatesPreservingStatePg(adapter);

				const rows = await adapter.query<{
					id: string;
					refresh_token: string | null;
					access_token: string | null;
					expires_at: string | number | null;
					refresh_token_issued_at: string | number | null;
				}>(
					`SELECT id, refresh_token, access_token, expires_at, refresh_token_issued_at
					 FROM accounts WHERE name = $1`,
					["pg-dedup-cred-test"],
				);

				// Dedup must have collapsed the two duplicates into one row.
				expect(rows).toHaveLength(1);
				const survivor = rows[0];

				// The freshest row ("newer") is the one with the freshest
				// refresh_token, so its refresh_token wins.
				expect(survivor?.refresh_token).toBe("r-new");
				// access_token and expires_at must come from that SAME row
				// ("newer"), i.e. stay NULL — NOT get backfilled from
				// "older"'s unrelated access_token/expires_at.
				expect(survivor?.access_token).toBeNull();
				expect(survivor?.expires_at).toBeNull();
			} finally {
				// Clean up so a re-run of this test (or others sharing the
				// database) doesn't see a stale duplicate-free leftover row.
				await adapter.unsafe(`DELETE FROM accounts WHERE name = $1`, [
					"pg-dedup-cred-test",
				]);
				await adapter.close();
			}
		});

		it("round trips sealed cache flight recorder rows, rejects immutable conflicts, and cleans orphaned registries", async () => {
			const { SQL } = await import("bun");
			const { BunSqlAdapter } = await import("./adapters/bun-sql-adapter");
			const { ensureSchemaPg, runMigrationsPg } = await import(
				"./migrations-pg"
			);
			const { CacheFlightRecorderRepository } = await import(
				"./repositories/cache-flight-recorder.repository"
			);

			// biome-ignore lint/style/noNonNullAssertion: guarded by describe.skipIf(!livePgAvailable)
			const databaseUrl = process.env.DATABASE_URL!;
			const sqlClient = new SQL({ url: databaseUrl });
			const adapter = new BunSqlAdapter(sqlClient, false);

			const runId = `u3-live-${Date.now()}`;
			const recorderConversationId = `${runId}-conversation`;
			const epochId = `${runId}-epoch`;
			const partitionId = `${runId}-partition`;
			const keepalivePolicy: CacheFlightKeepalivePolicySnapshot = {
				globalTtlMinutes: 20,
				xaiTtlMinutes: 20,
				effectiveXaiEnabled: true,
				effectiveXaiTtlMinutes: 20,
			};
			const receipt: CacheFlightCohortSealReceipt = {
				serviceEpoch: {
					id: epochId,
					occurrenceId: `${runId}-occurrence`,
					sealContractVersion: 1,
					deploymentRevision: `${runId}-deploy`,
					serviceInstanceId: `${runId}-service`,
					processStartedAt: "2026-08-08T10:00:00.000Z",
					nativeCacheState: "enabled",
					recorderState: "enabled",
					keepalivePolicy,
					completeness: "complete",
					unavailableDimensions: [],
				},
				observationPartition: {
					id: partitionId,
					serviceEpochId: epochId,
					servingAccountScope: `${runId}-serving`,
					routeModelEpoch: `${runId}-route`,
					completeness: "complete",
					unavailableDimensions: [],
				},
				completeness: "complete",
				unavailableDimensions: [],
			};
			const makeTurn = (timestampMs: number): TurnEvidence => ({
				sequence: 0,
				timestamp: new Date(timestampMs).toISOString(),
				identityFingerprint: `${runId}-identity`,
				servingAccountId: `${runId}-account`,
				prefixFingerprint: `${runId}-prefix`,
				cacheOutcome: "hit",
				inputTokens: 100,
				cachedTokens: 80,
				completeness: "complete",
				unavailableDimensions: [],
			});
			const countWhere = async (
				table: string,
				column: string,
				value: string,
			): Promise<number> => {
				const row = await adapter.get<{ count: number | string }>(
					`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
					[value],
				);
				return Number(row?.count ?? 0);
			};

			try {
				await expect(ensureSchemaPg(adapter)).resolves.toBeUndefined();
				await expect(runMigrationsPg(adapter)).resolves.toBeUndefined();

				const repo = new CacheFlightRecorderRepository(adapter);
				await repo.appendTurn(
					recorderConversationId,
					makeTurn(1_000),
					1_000,
					receipt,
				);

				const loaded = await repo.loadTimeline(recorderConversationId);
				expect(loaded?.turns).toHaveLength(1);
				expect(loaded?.turns[0]?.seal).toEqual(receipt);
				expect(loaded?.turns[0]?.seal?.completeness).toBe("complete");
				expect(
					await countWhere(
						"cache_flight_recorder_service_epochs",
						"id",
						epochId,
					),
				).toBe(1);
				expect(
					await countWhere(
						"cache_flight_recorder_partitions",
						"id",
						partitionId,
					),
				).toBe(1);

				const conflictingReceipt: CacheFlightCohortSealReceipt = {
					...receipt,
					serviceEpoch: {
						...receipt.serviceEpoch,
						deploymentRevision: `${runId}-conflict`,
					},
				};
				await expect(
					repo.appendTurn(
						recorderConversationId,
						makeTurn(1_500),
						1_500,
						conflictingReceipt,
					),
				).rejects.toThrow("immutable cache flight service epoch");
				expect(
					await countWhere(
						"cache_flight_recorder_turns",
						"recorder_conversation_id",
						recorderConversationId,
					),
				).toBe(1);

				await expect(repo.expireOlderThan(2_000, 3_000)).resolves.toBe(1);
				expect(await repo.loadTimeline(recorderConversationId)).toBeNull();
				expect(
					await countWhere(
						"cache_flight_recorder_partitions",
						"id",
						partitionId,
					),
				).toBe(0);
				expect(
					await countWhere(
						"cache_flight_recorder_service_epochs",
						"id",
						epochId,
					),
				).toBe(0);
			} finally {
				await adapter.unsafe(
					`DELETE FROM cache_flight_recorder_conversations
					 WHERE recorder_conversation_id = ?`,
					[recorderConversationId],
				);
				await adapter.unsafe(
					`DELETE FROM cache_flight_recorder_tombstones
					 WHERE recorder_conversation_id = ?`,
					[recorderConversationId],
				);
				await adapter.unsafe(
					`DELETE FROM cache_flight_recorder_partitions WHERE id = ?`,
					[partitionId],
				);
				await adapter.unsafe(
					`DELETE FROM cache_flight_recorder_service_epochs WHERE id = ?`,
					[epochId],
				);
				await adapter.close();
			}
		});
	},
);
