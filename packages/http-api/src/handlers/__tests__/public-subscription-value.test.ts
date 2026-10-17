import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const handler = createPublicSubscriptionValueHandler(context, {
	getConfig: () => config,
	now: () => now,
});

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
});
afterAll(async () => {
	await db.close();
	rmSync(scratch, { recursive: true, force: true });
});

describe("public subscription value read projection", () => {
	it("keeps configuration access failures generic", async () => {
		const failing = createPublicSubscriptionValueHandler(context, {
			getConfig: () => {
				throw new Error("private configuration failure");
			},
		});
		const result = await failing();
		expect(result.status).toBe(503);
		expect(await result.json()).toEqual({ error: "Unavailable" });
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
			expect(account).toHaveBeenCalledTimes(2);
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
	it("does not retain cached data after account replacement or same-generation history deletion", async () => {
		await db.openUsageWindow({
			accountId: mapping.accountId,
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 2000,
			grantType: "natural",
		});
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).not.toBeNull();
		await db.getAdapter().run("DELETE FROM usage_windows");
		expect(
			(await (await handler()).json()).subscriptions[0].current,
		).toBeNull();
		await db
			.getAdapter()
			.run("UPDATE accounts SET created_at = 101 WHERE id = ?", [
				mapping.accountId,
			]);
		expect((await handler()).status).toBe(503);
	});
});
