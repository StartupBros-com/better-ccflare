/**
 * Tests for RequestRepository.aggregateTokensByModel — the requests-side
 * aggregation feeding the Window Value Ledger (issue #252, task P1.3). Rows
 * are inserted with raw SQL (not repo.save(), which stamps its own
 * Date.now() timestamp) so each test can pin an exact `timestamp` and
 * exercise the [fromMs, toMs) boundary precisely.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

interface SeedRow {
	id: string;
	timestamp: number;
	path?: string;
	billingType?: string | null;
	model?: string | null;
	accountId?: string;
	inputTokens?: number | null;
	cacheReadInputTokens?: number | null;
	cacheCreationInputTokens?: number | null;
	outputTokens?: number | null;
}

function seed(db: Database, row: SeedRow): void {
	db.run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			model, billing_type, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens
		) VALUES (?, ?, 'POST', ?, ?, 200, 1, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.timestamp,
			row.path ?? "/v1/messages",
			row.accountId ?? "acc1",
			row.model ?? "claude-sonnet-5",
			row.billingType === undefined ? "plan" : row.billingType,
			row.inputTokens === undefined ? 100 : row.inputTokens,
			row.cacheReadInputTokens === undefined ? 10 : row.cacheReadInputTokens,
			row.cacheCreationInputTokens === undefined
				? 5
				: row.cacheCreationInputTokens,
			row.outputTokens === undefined ? 50 : row.outputTokens,
		],
	);
}

describe("RequestRepository.aggregateTokensByModel", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	it("aggregates matching rows into a single per-model group", async () => {
		seed(db, { id: "r1", timestamp: 1000, model: "claude-sonnet-5" });
		seed(db, { id: "r2", timestamp: 2000, model: "claude-sonnet-5" });

		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		expect(rows).toEqual([
			{
				model: "claude-sonnet-5",
				requestCount: 2,
				inputTokens: 200,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 10,
				outputTokens: 100,
			},
		]);
	});

	it("groups distinct models into separate rows", async () => {
		seed(db, { id: "r1", timestamp: 1000, model: "claude-sonnet-5" });
		seed(db, { id: "r2", timestamp: 1000, model: "claude-opus-4" });

		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
		expect(Object.keys(byModel).sort()).toEqual([
			"claude-opus-4",
			"claude-sonnet-5",
		]);
		expect(byModel["claude-sonnet-5"].requestCount).toBe(1);
		expect(byModel["claude-opus-4"].requestCount).toBe(1);
	});

	it("excludes rows before fromMs and at/after toMs (half-open range)", async () => {
		seed(db, { id: "before", timestamp: 999 });
		seed(db, { id: "at-from", timestamp: 1000 });
		seed(db, { id: "inside", timestamp: 1500 });
		seed(db, { id: "at-to", timestamp: 2000 });
		seed(db, { id: "after", timestamp: 2001 });

		const rows = await repo.aggregateTokensByModel("acc1", 1000, 2000);
		expect(rows).toHaveLength(1);
		// at-from + inside only => 2 requests; at-to and after/before excluded.
		expect(rows[0].requestCount).toBe(2);
	});

	it("excludes /v1/messages/count_tokens (exact path equality, not prefix)", async () => {
		seed(db, { id: "messages", timestamp: 1000, path: "/v1/messages" });
		seed(db, {
			id: "count-tokens",
			timestamp: 1000,
			path: "/v1/messages/count_tokens",
		});

		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		expect(rows).toHaveLength(1);
		expect(rows[0].requestCount).toBe(1);
	});

	it("excludes non-plan billing_type rows", async () => {
		seed(db, { id: "plan", timestamp: 1000, billingType: "plan" });
		seed(db, { id: "api", timestamp: 1000, billingType: "api" });
		seed(db, { id: "null-billing", timestamp: 1000, billingType: null });

		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		expect(rows).toHaveLength(1);
		expect(rows[0].requestCount).toBe(1);
	});

	it("excludes rows for other accounts", async () => {
		seed(db, { id: "mine", timestamp: 1000, accountId: "acc1" });
		seed(db, { id: "theirs", timestamp: 1000, accountId: "acc2" });

		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		expect(rows).toHaveLength(1);
		expect(rows[0].requestCount).toBe(1);
	});

	it("treats NULL token columns as 0 rather than dropping the row or producing NULL sums", async () => {
		seed(db, {
			id: "nulls",
			timestamp: 1000,
			inputTokens: null,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
			outputTokens: null,
		});

		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		expect(rows).toEqual([
			{
				model: "claude-sonnet-5",
				requestCount: 1,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
			},
		]);
	});

	it("returns an empty array when nothing matches", async () => {
		const rows = await repo.aggregateTokensByModel("acc1", 0, 5000);
		expect(rows).toEqual([]);
	});
});
