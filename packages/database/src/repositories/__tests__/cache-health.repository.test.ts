import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import {
	CacheHealthRepository,
	cacheHealthBucketQuery,
} from "../cache-health.repository";
import { RequestRepository } from "../request.repository";
import {
	CACHE_TEST_TIME,
	cacheHealthRepositoryContract,
	cacheHealthRetentionContract,
	cacheTestAlert,
	cacheTestState,
	seedCacheAccount,
	seedCacheRequest,
} from "./cache-health-contract";

describe("cache health repository (SQLite)", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let repo: CacheHealthRepository;
	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
		adapter = new BunSqlAdapter(db);
		repo = new CacheHealthRepository(adapter);
	});
	afterEach(() => db.close());

	it("normalizes accounting and atomically fences duplicate evaluators and generations", async () => {
		await cacheHealthRepositoryContract(adapter);
	});

	it("upgrades a pre-feature schema repeatedly without changing alerts", async () => {
		db.run("DROP TABLE cache_health_state");
		for (const column of [
			"account_generation",
			"cache_health_native",
			"internal_origin",
		])
			db.run(`ALTER TABLE requests DROP COLUMN ${column}`);
		runMigrations(db);
		runMigrations(db);
		await seedCacheAccount(adapter);
		expect(await repo.commit(0, cacheTestState(), [cacheTestAlert()])).toBe(
			true,
		);
		expect(await repo.loadStates(CACHE_TEST_TIME)).toHaveLength(1);
		await cacheHealthRetentionContract(adapter);
		const fresh = new Database(":memory:");
		try {
			ensureSchema(fresh);
			expect(fresh.query("SELECT * FROM cache_health_state").all()).toEqual([]);
			expect(
				fresh
					.query(
						"SELECT internal_origin, account_generation, cache_health_native FROM requests",
					)
					.all(),
			).toEqual([]);
			await cacheHealthRetentionContract(new BunSqlAdapter(fresh));
		} finally {
			fresh.close();
		}
	});

	it("preserves NULL versus invalid measurements and only tolerates protocol-specific missing writes", async () => {
		await seedCacheAccount(adapter);
		await seedCacheRequest(adapter, "anthropic-missing-write", {
			routed_provider: "anthropic",
			cache_creation_input_tokens: null,
		});
		await seedCacheRequest(adapter, "text", { input_tokens: "broken" });
		await seedCacheRequest(adapter, "fraction", { input_tokens: 0.5 });
		await seedCacheRequest(adapter, "impossible-inclusive", {
			input_tokens: null,
			prompt_tokens: 8000,
		});
		const rows = await repo.fetchBuckets(
			CACHE_TEST_TIME,
			CACHE_TEST_TIME + 600_000,
		);
		expect(rows.find((r) => r.scope.provider === "anthropic")).toMatchObject({
			missing: 1,
			measured: 0,
			eligible: 1,
		});
		expect(rows.find((r) => r.scope.provider === "codex")).toMatchObject({
			invalid: 3,
			measured: 0,
			eligible: 3,
		});
	});

	it("does not let unsafe sums or malformed inclusive counters become reuse", async () => {
		await seedCacheAccount(adapter);
		await seedCacheRequest(adapter, "large-a", {
			input_tokens: Number.MAX_SAFE_INTEGER,
			cache_read_input_tokens: 0,
		});
		await seedCacheRequest(adapter, "large-b", {
			input_tokens: Number.MAX_SAFE_INTEGER,
			cache_read_input_tokens: 0,
		});
		const [row] = await repo.fetchBuckets(
			CACHE_TEST_TIME,
			CACHE_TEST_TIME + 600_000,
		);
		expect(row.totalsValid).toBe(false);
		for (const value of [
			row.inputTokens,
			row.cacheReadTokens,
			row.cacheWriteTokens,
		])
			expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
	});

	it("uses request-time provider/model/generation, with bounded legacy fallbacks", async () => {
		await seedCacheAccount(adapter);
		await seedCacheRequest(adapter, "legacy-route", {
			model: null,
			cache_health_native: null,
		});
		await seedCacheRequest(adapter, "legacy-rewrite", {
			model: null,
			routed_model: null,
		});
		await seedCacheRequest(adapter, "unknown-model", {
			model: null,
			routed_model: null,
			applied_model: null,
		});
		await adapter.run(
			"UPDATE accounts SET provider = 'ollama' WHERE id = 'cache-a'",
		);
		const rows = await repo.fetchBuckets(
			CACHE_TEST_TIME,
			CACHE_TEST_TIME + 600_000,
		);
		expect(rows.map((r) => r.scope.model).sort()).toEqual([
			"rewrite",
			"route-target",
		]);
		expect(rows.every((r) => r.scope.provider === "codex")).toBe(true);
		await adapter.run("DELETE FROM accounts WHERE id = 'cache-a'");
		expect(
			await repo.fetchBuckets(CACHE_TEST_TIME, CACHE_TEST_TIME + 600_000),
		).toEqual([]);
	});

	it("does not infer a generation from completion time for legacy or delayed writes", async () => {
		await seedCacheAccount(adapter, "cache-a", CACHE_TEST_TIME - 100);
		await seedCacheRequest(adapter, "unfenced-legacy", {
			account_generation: null,
			response_time_ms: 1,
		});
		await seedCacheRequest(adapter, "old-in-flight", {
			account_generation: 1,
			response_time_ms: 1,
		});
		expect(
			await repo.fetchBuckets(CACHE_TEST_TIME, CACHE_TEST_TIME + 600_000),
		).toEqual([]);
	});

	it("stores authenticated accounting metadata without losing it on a legacy re-save", async () => {
		await seedCacheAccount(adapter);
		const requests = new RequestRepository(adapter);
		const data = {
			id: "saved",
			method: "POST",
			path: "/v1/responses",
			accountUsed: "cache-a",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 1,
			failoverAttempts: 0,
			usage: {
				model: "observed",
				inputTokens: 1000,
				cacheReadInputTokens: 9000,
			},
		};
		await requests.save({
			...data,
			accounting: {
				accountGeneration: 1,
				provider: "codex",
				nativeCache: true,
				internal: true,
			},
		});
		await requests.save(data);
		await adapter.run("UPDATE requests SET timestamp = ? WHERE id = 'saved'", [
			CACHE_TEST_TIME,
		]);
		const [row] = await repo.fetchBuckets(
			CACHE_TEST_TIME,
			CACHE_TEST_TIME + 600_000,
		);
		expect(row).toMatchObject({ internal: 1, eligible: 0, measured: 0 });
	});

	it("keeps successful completions with no usage in their attempted physical-model scope", async () => {
		await seedCacheAccount(adapter);
		await new RequestRepository(adapter).save({
			id: "no-usage",
			method: "POST",
			path: "/v1/messages",
			accountUsed: "cache-a",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 1,
			failoverAttempts: 0,
			accounting: {
				accountGeneration: 1,
				provider: "codex",
				model: "attempted",
				nativeCache: true,
				internal: false,
			},
		});
		await adapter.run(
			"UPDATE requests SET timestamp = ? WHERE id = 'no-usage'",
			[CACHE_TEST_TIME],
		);
		expect(
			(await repo.fetchBuckets(CACHE_TEST_TIME, CACHE_TEST_TIME + 600_000))[0],
		).toMatchObject({
			scope: { model: "attempted" },
			eligible: 1,
			missing: 1,
			measured: 0,
		});
	});

	it("bounds scans and retains active incidents over downtime", async () => {
		await seedCacheAccount(adapter);
		await repo.commit(0, cacheTestState(), []);
		expect(await repo.loadStates(CACHE_TEST_TIME + 48 * 60 * 60_000)).toEqual([
			cacheTestState(),
		]);
		await expect(repo.fetchBuckets(0, 2 * 24 * 60 * 60_000)).rejects.toThrow();
		const plan = db
			.query(`EXPLAIN QUERY PLAN ${cacheHealthBucketQuery(true)}`)
			.all(CACHE_TEST_TIME, CACHE_TEST_TIME + 600_000) as { detail: string }[];
		expect(
			plan.some((p) =>
				/SEARCH r USING INDEX idx_requests_.*timestamp/.test(p.detail),
			),
		).toBe(true);
	});

	it("rolls back the entire transition on a database failure during alert insertion", async () => {
		await seedCacheAccount(adapter);
		db.run(
			"CREATE TRIGGER reject_cache_alert BEFORE INSERT ON alerts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
		);
		await expect(
			repo.commit(0, cacheTestState(), [cacheTestAlert()]),
		).rejects.toThrow("fixture failure");
		expect(await repo.loadStates(CACHE_TEST_TIME)).toEqual([]);
	});

	it("expires unclassified snapshots before loading so later observations can create state", async () => {
		await seedCacheAccount(adapter);
		const unclassified = cacheTestState();
		unclassified.scope.provider = "openai-compatible";
		unclassified.enrolled = false;
		unclassified.reuse = {
			sequence: 0,
			incident: null,
			bad: null,
			recovery: null,
		};
		await repo.commit(0, unclassified, []);
		const later = CACHE_TEST_TIME + 48 * 60 * 60_000;
		expect(await repo.loadStates(later)).toEqual([]);
		expect(
			await repo.commit(0, { ...unclassified, lastBucketEnd: later }, []),
		).toBe(true);
		expect((await repo.loadStates(later))[0].enrolled).toBe(false);
	});
});
