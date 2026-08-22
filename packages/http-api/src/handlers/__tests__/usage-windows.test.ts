import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createUsageWindowsHandler } from "../usage-windows";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT_ID = "acct-1";

async function insertAccount(
	dbOps: DatabaseOperations,
	id: string,
	opts: { name?: string; provider?: string } = {},
): Promise<void> {
	await dbOps
		.getAdapter()
		.run(
			`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
			[id, opts.name ?? id, opts.provider ?? "anthropic", Date.now()],
		);
}

/** Mirrors the seedRequest helper in
 * packages/http-api/src/services/__tests__/usage-window-ledger.test.ts —
 * same shape, same plan-billed /v1/messages defaults, so both suites seed
 * `aggregateTokensByModel`'s input identically. */
async function seedRequest(
	dbOps: DatabaseOperations,
	opts: {
		id: string;
		timestamp: number;
		model: string;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
		accountId?: string;
		path?: string;
		billingType?: string;
	},
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			model, billing_type, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens
		) VALUES (?, ?, 'POST', ?, ?, 200, 1, ?, ?, ?, ?, ?, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.path ?? "/v1/messages",
			opts.accountId ?? ACCOUNT_ID,
			opts.model,
			opts.billingType ?? "plan",
			opts.inputTokens ?? 0,
			opts.cacheReadInputTokens ?? 0,
			opts.cacheCreationInputTokens ?? 0,
			opts.outputTokens ?? 0,
		],
	);
}

describe("createUsageWindowsHandler", () => {
	let dbOps: DatabaseOperations;
	let context: APIContext;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		context = { dbOps } as unknown as APIContext;
	});

	afterEach(async () => {
		await dbOps.dispose();
	});

	it("lists closed windows ordered by resets_at desc and respects limit", async () => {
		await insertAccount(dbOps, ACCOUNT_ID, { name: "Acc One" });
		const base = Date.parse("2026-08-01T00:00:00Z");

		for (let i = 0; i < 3; i++) {
			const startedAt = base + i * 7 * DAY_MS;
			const resetsAt = startedAt + 7 * DAY_MS;
			const opened = await dbOps.openUsageWindow({
				accountId: ACCOUNT_ID,
				windowKey: "seven_day",
				startedAt,
				resetsAt,
				grantType: "natural",
			});
			await dbOps.closeUsageWindow(opened.id, {
				closedAt: resetsAt,
				valueUsd: i + 1,
				inputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				requestCount: 0,
				modelBreakdown: null,
				unpricedTokens: 0,
				projectionVersion: "v-test",
			});
		}

		const handler = createUsageWindowsHandler(context);
		const res = await handler(
			new URLSearchParams(`account=${ACCOUNT_ID}&limit=2`),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			windows: { resetsAt: number; valueUsd: number | null }[];
			openWindow: unknown;
		};
		// 3 windows exist; limit=2 keeps only the 2 most recent (highest resets_at).
		expect(body.windows).toHaveLength(2);
		expect(body.windows[0].valueUsd).toBe(3);
		expect(body.windows[1].valueUsd).toBe(2);
		expect(body.windows[0].resetsAt).toBeGreaterThan(body.windows[1].resetsAt);
		expect(body.openWindow).toBeNull();
	});

	it("computes valueSoFarUsd, utilization and ageHours for the open window live from seeded requests", async () => {
		await insertAccount(dbOps, ACCOUNT_ID);
		const startedAt = Date.now() - 2 * HOUR_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: startedAt + 7 * DAY_MS,
			grantType: "natural",
		});
		await dbOps.recordUsageWindowUtilization(opened.id, 45, startedAt + 1_000);

		// gpt-5.6-terra list rates: input 2.0/M, cacheRead 0.2/M, output 12.0/M.
		await seedRequest(dbOps, {
			id: "req-a",
			timestamp: startedAt + 1_000,
			model: "gpt-5.6-terra",
			inputTokens: 1_000_000, // -> 2.0
		});
		await seedRequest(dbOps, {
			id: "req-b",
			timestamp: startedAt + 2_000,
			model: "gpt-5.6-terra",
			outputTokens: 500_000, // -> 6.0
		});
		// Expected valueSoFarUsd = 2.0 + 6.0 = 8.0

		const handler = createUsageWindowsHandler(context);
		const res = await handler(new URLSearchParams(`account=${ACCOUNT_ID}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			openWindow: {
				valueSoFarUsd: number;
				utilization: number;
				ageHours: number;
				closedAt: number | null;
			} | null;
			windows: unknown[];
		};
		expect(body.windows).toEqual([]);
		expect(body.openWindow).not.toBeNull();
		expect(body.openWindow?.valueSoFarUsd).toBeCloseTo(8.0, 10);
		expect(body.openWindow?.utilization).toBe(45);
		expect(body.openWindow?.ageHours).toBeCloseTo(2, 1);
		expect(body.openWindow?.closedAt).toBeNull();
	});

	it("parses model_breakdown to JSON, keeping an unpriced model's valueUsd null", async () => {
		await insertAccount(dbOps, ACCOUNT_ID);
		const startedAt = Date.parse("2026-08-10T00:00:00Z");
		const closedAt = startedAt + 7 * DAY_MS;
		const opened = await dbOps.openUsageWindow({
			accountId: ACCOUNT_ID,
			windowKey: "seven_day",
			startedAt,
			resetsAt: closedAt,
			grantType: "natural",
		});
		const modelBreakdown = {
			"gpt-5.6-terra": {
				requestCount: 2,
				inputTokens: 1_000_000,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 500_000,
				valueUsd: 8.0,
			},
			"unknown-model-zzz": {
				requestCount: 1,
				inputTokens: 300,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 0,
				outputTokens: 75,
				valueUsd: null,
			},
		};
		await dbOps.closeUsageWindow(opened.id, {
			closedAt,
			valueUsd: 8.0,
			inputTokens: 1_000_300,
			cacheReadInputTokens: 20,
			cacheCreationInputTokens: 0,
			outputTokens: 500_075,
			requestCount: 3,
			modelBreakdown,
			unpricedTokens: 395,
			projectionVersion: "v-test",
		});

		const handler = createUsageWindowsHandler(context);
		const res = await handler(new URLSearchParams(`account=${ACCOUNT_ID}`));
		const body = (await res.json()) as {
			windows: {
				modelBreakdown: Record<string, { valueUsd: number | null }>;
				unpricedTokens: number;
			}[];
		};
		expect(body.windows).toHaveLength(1);
		expect(body.windows[0].unpricedTokens).toBe(395);
		expect(
			body.windows[0].modelBreakdown["gpt-5.6-terra"].valueUsd,
		).toBeCloseTo(8.0, 10);
		expect(
			body.windows[0].modelBreakdown["unknown-model-zzz"].valueUsd,
		).toBeNull();
	});

	it("returns every account with at least one usage_windows row for account=all, skipping accounts with none", async () => {
		await insertAccount(dbOps, "acct-with-windows", { name: "Has Windows" });
		await insertAccount(dbOps, "acct-empty", { name: "No Windows" });

		const startedAt = Date.parse("2026-08-05T00:00:00Z");
		const opened = await dbOps.openUsageWindow({
			accountId: "acct-with-windows",
			windowKey: "seven_day",
			startedAt,
			resetsAt: startedAt + 7 * DAY_MS,
			grantType: "natural",
		});
		await dbOps.closeUsageWindow(opened.id, {
			closedAt: startedAt + 7 * DAY_MS,
			valueUsd: 5,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			modelBreakdown: null,
			unpricedTokens: 0,
			projectionVersion: "v-test",
		});

		const handler = createUsageWindowsHandler(context);
		const res = await handler(new URLSearchParams("account=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accounts: {
				accountId: string;
				accountName: string;
				provider: string;
			}[];
		};
		expect(body.accounts).toHaveLength(1);
		expect(body.accounts[0].accountId).toBe("acct-with-windows");
		expect(body.accounts[0].accountName).toBe("Has Windows");
		expect(body.accounts[0].provider).toBe("anthropic");
	});

	it("defaults to fleet mode when the account param is omitted entirely", async () => {
		const handler = createUsageWindowsHandler(context);
		const res = await handler(new URLSearchParams(""));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { accounts: unknown[] };
		expect(body.accounts).toEqual([]);
	});

	it("returns 404 for an unknown account id", async () => {
		const handler = createUsageWindowsHandler(context);
		const res = await handler(new URLSearchParams("account=does-not-exist"));
		expect(res.status).toBe(404);
	});

	it("returns 400 for a non-numeric limit", async () => {
		await insertAccount(dbOps, ACCOUNT_ID);
		const handler = createUsageWindowsHandler(context);
		const res = await handler(
			new URLSearchParams(`account=${ACCOUNT_ID}&limit=abc`),
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a limit of 0", async () => {
		await insertAccount(dbOps, ACCOUNT_ID);
		const handler = createUsageWindowsHandler(context);
		const res = await handler(
			new URLSearchParams(`account=${ACCOUNT_ID}&limit=0`),
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a limit above the maximum", async () => {
		await insertAccount(dbOps, ACCOUNT_ID);
		const handler = createUsageWindowsHandler(context);
		const res = await handler(
			new URLSearchParams(`account=${ACCOUNT_ID}&limit=201`),
		);
		expect(res.status).toBe(400);
	});
});
