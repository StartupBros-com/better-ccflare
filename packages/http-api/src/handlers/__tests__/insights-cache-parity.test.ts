import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createCacheParityHandler } from "../insights";

describe("cache parity handler", () => {
	let db: Database;
	let context: APIContext;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		context = {
			db: adapter,
			config: {
				getCacheKeepaliveTtlMinutes: () => 0,
			} as APIContext["config"],
			dbOps: {
				getAdapter: () => adapter,
			} as unknown as APIContext["dbOps"],
			alertService: {} as APIContext["alertService"],
		};

		const now = Date.now();
		db.run(
			`INSERT INTO accounts (id, name, provider, created_at)
			 VALUES ('codex-a', 'codex-primary', 'codex', ?),
			        ('anthropic-a', 'anthropic-primary', 'anthropic', ?)`,
			[now, now],
		);
	});

	afterEach(() => db.close());

	function insertRequest(input: {
		id: string;
		timestamp: number;
		accountId: string;
		sessionId: string;
		model: string;
		appliedModel: string;
		inputTokens: number;
		cacheReadTokens: number;
	}): void {
		db.run(
			`INSERT INTO requests (
				id, timestamp, method, path, account_used, status_code, success,
				response_time_ms, failover_attempts, model, applied_model,
				input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
				client_session_id
			) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, ?, ?, ?, ?, 0, ?)`,
			[
				input.id,
				input.timestamp,
				input.accountId,
				input.model,
				input.appliedModel,
				input.inputTokens,
				input.cacheReadTokens,
				input.sessionId,
			],
		);
	}

	test("classifies logical turns, applied models, and account continuity", async () => {
		const now = Date.now();
		insertRequest({
			id: "codex-first",
			timestamp: now - 2_000,
			accountId: "codex-a",
			sessionId: "session-codex",
			model: "claude-sonnet-5-20260101",
			appliedModel: "gpt-5.6-sol-2026-08-19",
			inputTokens: 1_000,
			cacheReadTokens: 0,
		});
		insertRequest({
			id: "codex-follow",
			timestamp: now - 1_000,
			accountId: "codex-a",
			sessionId: "session-codex",
			model: "claude-sonnet-5-20260101",
			appliedModel: "gpt-5.6-sol-2026-08-19",
			inputTokens: 100,
			cacheReadTokens: 900,
		});
		insertRequest({
			id: "codex-custom",
			timestamp: now - 500,
			accountId: "codex-a",
			sessionId: "session-custom",
			model: "claude-sonnet-5-20260101",
			appliedModel: "private-customer-model-name",
			inputTokens: 100,
			cacheReadTokens: 900,
		});
		insertRequest({
			id: "codex-custom-follow",
			timestamp: now - 250,
			accountId: "codex-a",
			sessionId: "session-custom",
			model: "claude-sonnet-5-20260101",
			appliedModel: "private-customer-model-name",
			inputTokens: 100,
			cacheReadTokens: 900,
		});

		const response = await createCacheParityHandler(context)();
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.verdict).toBe("insufficient_evidence");
		expect(data.metricScopes.durable).toBe("logical_request_final_usage");
		const codex = data.windows.authoritative7d.providers.find(
			(item: { key: string }) => item.key === "codex",
		);
		expect(codex.firstObserved.measuredResponses).toBe(2);
		expect(codex.followUps.measuredResponses).toBe(2);
		expect(codex.followUps.weightedCacheReadPercent).toBe(90);
		expect(
			data.windows.authoritative7d.codexByPhysicalModel.map(
				(item: { key: string }) => item.key,
			),
		).toEqual(["gpt-5.6-sol", "other_or_custom"]);
		expect(data.windows.authoritative7d.codexByAccountContinuity).toEqual([
			expect.objectContaining({
				key: "same_account",
				metrics: expect.objectContaining({ measuredResponses: 2 }),
			}),
		]);
	});

	test("returns 500 when the parity query fails", async () => {
		const failingContext = {
			...context,
			dbOps: {
				getAdapter: () => ({
					query: async () => {
						throw new Error("boom");
					},
				}),
			} as unknown as APIContext["dbOps"],
		};
		const response = await createCacheParityHandler(failingContext)();
		expect(response.status).toBe(500);
	});
});
