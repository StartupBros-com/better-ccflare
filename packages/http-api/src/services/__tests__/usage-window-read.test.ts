import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseOperations as DatabaseOperationsType } from "@better-ccflare/database";

const temp = mkdtempSync(join(tmpdir(), "ccflare-window-read-"));
process.env.DATABASE_URL = "";
process.env.BETTER_CCFLARE_DB_PATH = join(temp, "isolated.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(temp, "config.json");
const { DatabaseOperations } = await import("@better-ccflare/database");
const { readUsageWindows } = await import("../usage-window-read");

describe("shared usage window read", () => {
	let db: DatabaseOperationsType;
	beforeEach(async () => {
		db = new DatabaseOperations(":memory:", { walMode: false });
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
				["fixture", "private fixture", "anthropic", 100],
			);
	});
	afterEach(async () => {
		await db.dispose();
	});
	afterAll(() => {
		rmSync(temp, { recursive: true, force: true });
	});

	it("bounds recent closed history in SQL and leaves an overdue open row unclosed", async () => {
		for (let i = 0; i < 12; i++) {
			const row = await db.openUsageWindow({
				accountId: "fixture",
				windowKey: "seven_day",
				startedAt: 100 + i * 100,
				resetsAt: 200 + i * 100,
				grantType: "natural",
			});
			await db.closeUsageWindow(row.id, {
				closedAt: row.resetsAt,
				valueUsd: i,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				requestCount: 0,
				modelBreakdown: null,
				unpricedTokens: 0,
				projectionVersion: "fixture",
			});
		}
		await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt: 1300,
			resetsAt: 1400,
			grantType: "first_observed",
		});
		const result = await readUsageWindows(db, "fixture", "seven_day", 8, 1500, {
			bounded: true,
			activeOnly: true,
			accountCreatedAt: 100,
		});
		expect(result.windows).toHaveLength(8);
		expect(
			await db.listUsageWindows({
				accountId: "fixture",
				windowKey: "seven_day",
				closedOnly: true,
				limit: 2,
			}),
		).toHaveLength(2);
		expect(result.windows.map((w) => w.valueUsd)).toEqual([
			11, 10, 9, 8, 7, 6, 5, 4,
		]);
		expect(result.openWindow).toBeNull();
		expect(
			(await db.getOpenUsageWindow("fixture", "seven_day"))?.closedAt,
		).toBeNull();
	});

	it("uses canonical live valuation and keeps private overdue-window behavior", async () => {
		const startedAt = Date.parse("2026-09-01T00:00:00Z");
		await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt,
			resetsAt: startedAt + 7000,
			grantType: "natural",
		});
		await db
			.getAdapter()
			.run(
				`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, model, billing_type, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens) VALUES ('fixture-request', ?, 'POST', '/v1/messages', 'fixture', 200, 1, 'gpt-5.6-terra', 'plan', 1000000, 0, 0, 0)`,
				[startedAt + 1000],
			);
		const live = await readUsageWindows(
			db,
			"fixture",
			"seven_day",
			8,
			startedAt + 2000,
			{ bounded: true, activeOnly: true, accountCreatedAt: 100 },
		);
		expect(live.openWindow?.valueSoFarUsd).toBe(2);
		expect(live.openWindow?.unpricedTokens).toBe(0);
		const privateResult = await readUsageWindows(
			db,
			"fixture",
			"seven_day",
			8,
			startedAt + 8000,
		);
		expect(privateResult.openWindow?.valueSoFarUsd).toBe(2);
		const publicResult = await readUsageWindows(
			db,
			"fixture",
			"seven_day",
			8,
			startedAt + 8000,
			{ bounded: true, activeOnly: true },
		);
		expect(publicResult.openWindow).toBeNull();
	});

	it("suppresses ambiguous backdated first observations across account generations", async () => {
		const row = await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt: 50,
			resetsAt: 2000,
			grantType: "first_observed",
		});
		const options = { bounded: true, activeOnly: true, accountCreatedAt: 100 };
		expect(
			(await readUsageWindows(db, "fixture", "seven_day", 8, 1000, options))
				.openWindow,
		).toBeNull();
		await db.closeUsageWindow(row.id, {
			closedAt: 1500,
			valueUsd: 1,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			modelBreakdown: null,
			unpricedTokens: 0,
			projectionVersion: "fixture",
		});
		expect(
			(await readUsageWindows(db, "fixture", "seven_day", 8, 1600, options))
				.windows,
		).toEqual([]);
		expect(
			(await readUsageWindows(db, "fixture", "seven_day", 8, 1600)).windows,
		).toHaveLength(1);
	});

	it("suppresses future open rows and returns empty absent history", async () => {
		expect(
			await readUsageWindows(db, "fixture", "seven_day", 8, 1500, {
				bounded: true,
				activeOnly: true,
			}),
		).toEqual({ windows: [], openWindow: null });
		await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt: 2000,
			resetsAt: 3000,
			grantType: "natural",
		});
		expect(
			(
				await readUsageWindows(db, "fixture", "seven_day", 8, 1500, {
					bounded: true,
					activeOnly: true,
				})
			).openWindow,
		).toBeNull();
		await expect(db.listUsageWindows({ limit: 0 })).rejects.toThrow("limit");
		await expect(db.listUsageWindows({ limit: 201 })).rejects.toThrow("limit");
	});
});
