import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { type RequestData, RequestRepository } from "../request.repository";

interface UsageRow {
	prompt_tokens: number | null;
	completion_tokens: number | null;
	total_tokens: number | null;
	cost_usd: number | null;
	input_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	output_tokens: number | null;
	output_tokens_per_second: number | null;
}

function request(id: string, usage?: RequestData["usage"]): RequestData {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 100,
		failoverAttempts: 0,
		usage,
	};
}

function readUsage(db: Database, id: string): UsageRow {
	return db
		.prepare(
			`SELECT prompt_tokens, completion_tokens, total_tokens, cost_usd,
				input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
				output_tokens, output_tokens_per_second
			 FROM requests WHERE id = ?`,
		)
		.get(id) as UsageRow;
}

describe("RequestRepository cache usage nullability", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db);
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("save preserves explicit numeric zeros while omitted cache values remain NULL", async () => {
		await repo.save(
			request("save-zero", {
				model: "claude-test",
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				tokensPerSecond: 0,
			}),
		);
		await repo.save(request("save-omitted", { model: "claude-test" }));

		expect(readUsage(db, "save-zero")).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cost_usd: 0,
			input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 0,
			output_tokens_per_second: 0,
		});
		expect(readUsage(db, "save-omitted")).toEqual({
			prompt_tokens: null,
			completion_tokens: null,
			total_tokens: null,
			cost_usd: null,
			input_tokens: null,
			cache_read_input_tokens: null,
			cache_creation_input_tokens: null,
			output_tokens: null,
			output_tokens_per_second: null,
		});
	});

	it("updateUsage can replace nonzero numeric values with zero", async () => {
		await repo.save(
			request("update-zero", {
				promptTokens: 11,
				completionTokens: 12,
				totalTokens: 23,
				costUsd: 1.25,
				inputTokens: 9,
				cacheReadInputTokens: 1,
				cacheCreationInputTokens: 2,
				outputTokens: 12,
				tokensPerSecond: 3.5,
			}),
		);

		await repo.updateUsage("update-zero", {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			tokensPerSecond: 0,
		});

		expect(readUsage(db, "update-zero")).toEqual({
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cost_usd: 0,
			input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 0,
			output_tokens_per_second: 0,
		});
	});

	it("keeps cache read and creation tri-state semantics during updateUsage", async () => {
		await repo.save(
			request("update-tristate", { cacheCreationInputTokens: 8 }),
		);

		await repo.updateUsage("update-tristate", {
			cacheReadInputTokens: 0,
		});

		let row = readUsage(db, "update-tristate");
		expect(row.cache_read_input_tokens).toBe(0);
		expect(row.cache_creation_input_tokens).toBe(8);

		await repo.updateUsage("update-tristate", {
			cacheReadInputTokens: 4,
			cacheCreationInputTokens: 0,
		});

		row = readUsage(db, "update-tristate");
		expect(row.cache_read_input_tokens).toBe(4);
		expect(row.cache_creation_input_tokens).toBe(0);
	});
});
