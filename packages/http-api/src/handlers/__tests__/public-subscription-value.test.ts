import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { APIContext } from "../../types";

const scratch = mkdtempSync(join(tmpdir(), "ccflare-public-value-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "isolated.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "isolated-config.json");
process.env.DATABASE_URL = "";
const { DatabaseOperations } = await import("@better-ccflare/database");
const { createPublicSubscriptionValueHandler } = await import(
	"../public-subscription-value"
);
const db = new DatabaseOperations(":memory:");
const mapping = {
	accountId: "private-account",
	accountCreatedAt: 100,
	id: "my-weekly",
	label: "Weekly subscription",
};
let config: string | undefined;
let now = 1000;
const context = { dbOps: db } as APIContext;
let handler: ReturnType<typeof createPublicSubscriptionValueHandler>;
let warn: ReturnType<typeof spyOn<Logger, "warn">>;
let info: ReturnType<typeof spyOn<Logger, "info">>;
let error: ReturnType<typeof spyOn<Logger, "error">>;

beforeEach(async () => {
	await db.getAdapter().run("DELETE FROM usage_windows");
	await db.getAdapter().run("DELETE FROM usage_snapshots");
	await db.getAdapter().run("DELETE FROM accounts");
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, 'SECRET LABEL', 'anthropic', ?)",
			[mapping.accountId, 100],
		);
	config = JSON.stringify([mapping]);
	now = 1000;
	handler = createPublicSubscriptionValueHandler(context, {
		getConfig: () => config,
		now: () => now,
	});
	warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
	info = spyOn(Logger.prototype, "info").mockImplementation(() => undefined);
	error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	warn.mockRestore();
	info.mockRestore();
	error.mockRestore();
});
afterAll(async () => {
	await db.close();
	rmSync(scratch, { recursive: true, force: true });
});

describe("public subscription value read projection", () => {
	it("serves cache hits without any database reads", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 100_000,
			grantType: "natural",
		});
		const methods = [
			"getLatestUsageSnapshot",
			"getOpenUsageWindow",
			"listUsageWindows",
			"getAccount",
			"aggregateTokensByModel",
		] as const;
		const reads = methods.map((method) => spyOn(db, method));
		try {
			expect((await handler()).status).toBe(200);
			for (const read of reads) {
				expect(read).toHaveBeenCalledTimes(1);
				read.mockClear();
			}
			now++;
			expect((await handler()).status).toBe(200);
			for (const read of reads) expect(read).not.toHaveBeenCalled();
		} finally {
			for (const read of reads) read.mockRestore();
		}
	});
	it("refreshes immediately when one valid config changes to another", async () => {
		expect((await (await handler()).json()).subscriptions[0].label).toBe(
			mapping.label,
		);
		config = JSON.stringify([{ ...mapping, label: "Changed label" }]);
		now++;
		const body = await (await handler()).json();
		expect(body.generatedAt).toBe(now);
		expect(body.subscriptions[0].label).toBe("Changed label");
		expect(info).toHaveBeenCalledTimes(2);
	});
	it("logs rejected config once per raw value and generation failures once per minute without exposing reasons", async () => {
		config = "PRIVATE invalid";
		for (let i = 0; i < 3; i++) {
			const result = await handler();
			expect(result.status).toBe(503);
			expect(await result.json()).toEqual({ error: "Unavailable" });
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).toContain("not_json");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
		config = JSON.stringify([{ ...mapping, accountCreatedAt: 101 }]);
		for (let i = 0; i < 3; i++) {
			const result = await handler();
			expect(result.status).toBe(503);
			expect(await result.json()).toEqual({ error: "Unavailable" });
		}
		expect(warn).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(warn.mock.calls)).toContain("generation_mismatch");
		expect(JSON.stringify(warn.mock.calls)).toContain(mapping.id);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(mapping.accountId);
		now += 60_000;
		expect((await handler()).status).toBe(503);
		expect(warn).toHaveBeenCalledTimes(3);
	});
	it("accepts snapshot and utilization writes while live valuation is suspended", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 2000,
			grantType: "natural",
		});
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const original = db.aggregateTokensByModel.bind(db);
		const read = spyOn(db, "aggregateTokensByModel").mockImplementation(
			async (...args) => {
				entered();
				await gate;
				return original(...args);
			},
		);
		try {
			const pending = handler();
			await started;
			await db
				.getAdapter()
				.run(
					"INSERT INTO usage_snapshots (account_id,timestamp,window_key,utilization,resets_at) VALUES (?, 950, 'seven_day', 10, 2000)",
					[mapping.accountId],
				);
			await db
				.getAdapter()
				.run(
					"UPDATE usage_windows SET peak_utilization = 10 WHERE account_id = ?",
					[mapping.accountId],
				);
			release();
			expect((await pending).status).toBe(200);
		} finally {
			release();
			read.mockRestore();
		}
	});
	it("checks account generation after live valuation has finished", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 2000,
			grantType: "natural",
		});
		const original = db.aggregateTokensByModel.bind(db);
		const read = spyOn(db, "aggregateTokensByModel").mockImplementation(
			async (...args) => {
				const result = await original(...args);
				await db.getAdapter().run("UPDATE accounts SET created_at = 101");
				return result;
			},
		);
		try {
			expect((await handler()).status).toBe(503);
		} finally {
			read.mockRestore();
		}
	});
	it("logs unexpected database failures with the error once per minute", async () => {
		const failure = new Error("database fixture failure");
		const read = spyOn(db, "getLatestUsageSnapshot").mockRejectedValue(failure);
		try {
			for (let i = 0; i < 2; i++) {
				const result = await handler();
				expect(result.status).toBe(503);
				expect(await result.json()).toEqual({ error: "Unavailable" });
			}
			expect(error).toHaveBeenCalledTimes(1);
			expect(error.mock.calls[0]?.[1]).toBe(failure);
		} finally {
			read.mockRestore();
		}
	});
	it("rejects a refresh that crosses reset and logs expired", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 1100,
			grantType: "natural",
		});
		const original = db.getAccount.bind(db);
		const read = spyOn(db, "getAccount").mockImplementation(async (...args) => {
			const result = await original(...args);
			now = 1100;
			return result;
		});
		try {
			expect((await handler()).status).toBe(503);
			expect(JSON.stringify(warn.mock.calls)).toContain("expired");
		} finally {
			read.mockRestore();
		}
	});
	it("does not close overdue or future open rows on reads", async () => {
		for (const [startedAt, resetsAt] of [
			[200, 900],
			[2000, 3000],
		] as const) {
			await db.getAdapter().run("DELETE FROM usage_windows");
			await db.openUsageWindow({
				accountId: mapping.accountId,
				windowKey: "seven_day",
				startedAt,
				resetsAt,
				grantType: "natural",
			});
			const isolated = createPublicSubscriptionValueHandler(context, {
				getConfig: () => config,
				now: () => now,
			});
			expect(
				(await (await isolated()).json()).subscriptions[0].current,
			).toBeNull();
			expect(
				(await db.getOpenUsageWindow(mapping.accountId, "seven_day"))?.closedAt,
			).toBeNull();
		}
	});
	it("omits ambiguous backdated first observations from both open and completed history", async () => {
		const row = await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 50,
			resetsAt: 2000,
			grantType: "first_observed",
		});
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).toBeNull();
		await db.closeUsageWindow(row.id, {
			closedAt: 900,
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
		now += 60_001;
		expect((await (await handler()).json()).subscriptions[0].completed).toEqual(
			[],
		);
		expect(
			await db.listUsageWindows({
				accountId: mapping.accountId,
				windowKey: "seven_day",
				closedOnly: true,
			}),
		).toHaveLength(1);
	});
	it("allows five seconds of completed clock skew and fails closed beyond it", async () => {
		await db
			.getAdapter()
			.run(
				"INSERT INTO usage_windows (id,account_id,window_key,started_at,resets_at,closed_at,grant_type,peak_utilization,value_usd,unpriced_tokens) VALUES ('skew', ?, 'seven_day', 200, 2000, 6000, 'natural', 0, 1, 0)",
				[mapping.accountId],
			);
		expect((await handler()).status).toBe(200);
		config = JSON.stringify([{ ...mapping, label: "Refresh" }]);
		await db.getAdapter().run("UPDATE usage_windows SET closed_at = 6001");
		expect((await handler()).status).toBe(503);
		expect(JSON.stringify(warn.mock.calls)).toContain("invalid_window");
	});
	it("keeps configuration access failures generic", async () => {
		const failure = new Error("private configuration failure");
		const failing = createPublicSubscriptionValueHandler(context, {
			getConfig: () => {
				throw failure;
			},
		});
		const result = await failing();
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({ error: "Unavailable" });
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[1]).toBe(failure);
	});
	it("logs entry indices and each distinct config only once, while disabled stays silent", async () => {
		config = undefined;
		expect((await handler()).status).toBe(404);
		expect(warn).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
		const invalid = JSON.stringify([{ ...mapping, label: "secret\u202e" }]);
		config = invalid;
		expect((await handler()).status).toBe(503);
		expect(warn.mock.calls[0]?.[1]).toEqual({ reason: "bad_label", index: 0 });
		config = JSON.stringify([mapping]);
		expect((await handler()).status).toBe(200);
		config = invalid;
		now += 60_001;
		expect((await handler()).status).toBe(503);
		config = JSON.stringify([mapping]);
		expect((await handler()).status).toBe(200);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
	});
	it("keeps clock failures generic and logged when the clock is invalid or throws", async () => {
		for (const value of [NaN, -1, 1.5]) {
			now = value;
			const result = await handler();
			expect(result.status).toBe(503);
			expect(await result.json()).toEqual({ error: "Unavailable" });
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toEqual({ reason: "clock" });
		const failure = new Error("clock failure");
		const brokenClock = createPublicSubscriptionValueHandler(context, {
			getConfig: () => config,
			now: () => {
				throw failure;
			},
		});
		expect((await brokenClock()).status).toBe(503);
		expect(error.mock.calls[0]?.[1]).toBe(failure);
	});
	it("preserves mapping order and makes any failing mapping fail the entire feed", async () => {
		const second = {
			...mapping,
			accountId: "second-private-account",
			id: "other-weekly",
			label: "Second",
		};
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, 'PRIVATE SECOND', 'anthropic', 100)",
				[second.accountId],
			);
		config = JSON.stringify([second, mapping]);
		const result = await handler();
		expect(result.status).toBe(200);
		expect(
			(await result.json()).subscriptions.map(
				(entry: { id: string }) => entry.id,
			),
		).toEqual([second.id, mapping.id]);
		config = JSON.stringify([second, { ...mapping, accountCreatedAt: 101 }]);
		const unavailable = await handler();
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({ error: "Unavailable" });
	});
	it("preserves source observation bounds and legacy numeric unknown coverage", async () => {
		await db
			.getAdapter()
			.run(
				"INSERT INTO usage_windows (id,account_id,window_key,started_at,resets_at,closed_at,grant_type,peak_utilization,value_usd) VALUES ('legacy', ?, 'seven_day', 200, 800, 800, 'natural', 0, 42)",
				[mapping.accountId],
			);
		for (const [observed, expected] of [
			[99, null],
			[100, 100],
			[6000, 6000],
			[6001, null],
			[100.5, null],
		] as const) {
			await db.getAdapter().run("DELETE FROM usage_snapshots");
			await db
				.getAdapter()
				.run(
					"INSERT INTO usage_snapshots (account_id,timestamp,window_key,utilization,resets_at) VALUES (?, ?, 'seven_day', 0, 2000)",
					[mapping.accountId, observed],
				);
			const isolated = createPublicSubscriptionValueHandler(context, {
				getConfig: () => config,
				now: () => now,
			});
			const result = await isolated();
			expect(result.status).toBe(200);
			const entry = (await result.json()).subscriptions[0];
			expect(entry.sourceObservedAt).toBe(expected);
			expect(entry.completed[0].valueUsd).toBe(42);
			expect(entry.completed[0].pricingCoverage).toBe("unknown");
		}
	});
	it("coalesces concurrent real reads and retains original generation time on cache hits", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 2000,
			grantType: "natural",
		});
		const aggregate = spyOn(db, "aggregateTokensByModel");
		const account = spyOn(db, "getAccount");
		try {
			const isolated = createPublicSubscriptionValueHandler(context, {
				getConfig: () => config,
				now: () => now,
			});
			const results = await Promise.all(
				Array.from({ length: 12 }, () => isolated()),
			);
			expect(results.every((result) => result.status === 200)).toBe(true);
			expect(aggregate).toHaveBeenCalledTimes(1);
			expect(account).toHaveBeenCalledTimes(1);
			now = 1050;
			expect((await (await isolated()).json()).generatedAt).toBe(1000);
			expect(aggregate).toHaveBeenCalledTimes(1);
		} finally {
			aggregate.mockRestore();
			account.mockRestore();
		}
	});
	it("rejects revocation or generation replacement while a real read is suspended", async () => {
		for (const revoke of [true, false]) {
			config = JSON.stringify([mapping]);
			await db.getAdapter().run("UPDATE accounts SET created_at = 100");
			let release!: () => void;
			let entered!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const original = db.getLatestUsageSnapshot.bind(db);
			const read = spyOn(db, "getLatestUsageSnapshot").mockImplementation(
				async (...args) => {
					entered();
					await gate;
					return original(...args);
				},
			);
			try {
				const isolated = createPublicSubscriptionValueHandler(context, {
					getConfig: () => config,
					now: () => now,
				});
				const pending = isolated();
				await started;
				if (revoke) config = undefined;
				else await db.getAdapter().run("UPDATE accounts SET created_at = 101");
				release();
				expect((await pending).status).toBe(503);
			} finally {
				release();
				read.mockRestore();
			}
		}
	});
	it("is opt in and gives generic errors for unavailable configuration or generations", async () => {
		config = undefined;
		expect((await handler()).status).toBe(404);
		config = "secret-invalid-config";
		const invalid = await handler();
		expect(invalid.status).toBe(503);
		expect(await invalid.text()).not.toContain("secret");
		config = JSON.stringify([{ ...mapping, accountCreatedAt: 101 }]);
		expect((await handler()).status).toBe(503);
	});
	it("emits exact public keys and empty history without private identifiers", async () => {
		const response = await handler();
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			valueBasis: "api_equivalent_usd",
			windowKey: "seven_day",
			generatedAt: 1000,
			subscriptions: [
				{
					id: "my-weekly",
					label: "Weekly subscription",
					sourceObservedAt: null,
					current: null,
					completed: [],
				},
			],
		});
	});
	it("uses canonical open zero, persisted completed values and actual observations", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 2000,
			grantType: "first_observed",
		});
		await db
			.getAdapter()
			.run(
				"INSERT INTO usage_snapshots (account_id,timestamp,window_key,utilization,resets_at) VALUES (?, 900, 'seven_day', 0, 2000)",
				[mapping.accountId],
			);
		const body = await (await handler()).json();
		expect(body.subscriptions[0].sourceObservedAt).toBe(900);
		expect(body.subscriptions[0].current).toEqual({
			startedAt: 200,
			resetsAt: 2000,
			closedAt: null,
			valueUsd: 0,
			pricingCoverage: "complete",
			partialFirstObservation: true,
		});
	});
	it("expires at reset, detects same-generation ledger clearing and revokes cached mapping", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 1100,
			grantType: "natural",
		});
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).not.toBeNull();
		now = 1100;
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).toBeNull();
		await db.getAdapter().run("DELETE FROM usage_windows");
		now += 60_001;
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).toBeNull();
		config = undefined;
		expect((await handler()).status).toBe(404);
	});
	it("publishes only eight newest completed windows and preserves partial and unknown zero", async () => {
		for (let index = 0; index < 10; index++) {
			await db
				.getAdapter()
				.run(
					"INSERT INTO usage_windows (id,account_id,window_key,started_at,resets_at,closed_at,grant_type,peak_utilization,value_usd,unpriced_tokens) VALUES (?, ?, 'seven_day', ?, ?, ?, 'natural', 0, ?, ?)",
					[
						`closed-${index}`,
						mapping.accountId,
						100 + index * 20,
						120 + index * 20,
						115 + index * 20,
						index === 9 ? 0 : index === 8 ? null : 42,
						index === 9 ? 10 : index === 8 ? null : 0,
					],
				);
		}
		const body = await (await handler()).json();
		const completed = body.subscriptions[0].completed;
		expect(completed).toHaveLength(8);
		expect(completed[0]).toEqual({
			startedAt: 280,
			resetsAt: 300,
			closedAt: 295,
			valueUsd: 0,
			pricingCoverage: "partial",
			partialFirstObservation: false,
		});
		expect(completed[1].pricingCoverage).toBe("unknown");
		expect(completed[1].valueUsd).toBeNull();
		expect(completed[2].valueUsd).toBe(42);
		expect(completed[2].pricingCoverage).toBe("complete");
	});
	it("bounds cached data after account replacement or same-generation history deletion by the TTL", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 1_000_000,
			grantType: "natural",
		});
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).not.toBeNull();
		await db.getAdapter().run("DELETE FROM usage_windows");
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).not.toBeNull();
		now += 60_001;
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).toBeNull();
		await db
			.getAdapter()
			.run("UPDATE accounts SET created_at = 101 WHERE id = ?", [
				mapping.accountId,
			]);
		expect((await handler()).status).toBe(200);
		now += 60_001;
		expect((await handler()).status).toBe(503);
	});
});
