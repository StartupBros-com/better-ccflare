import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { isAccountAvailable } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { Account, AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

describe("GET /api/accounts canonical reauthentication state", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
	});

	afterEach(() => {
		sqlite.close();
	});

	it("derives reauthentication from oauth_invalid_grant even when the compatibility flag is false", async () => {
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, pause_reason, requires_reauth
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"account-1",
				"Account 1",
				"anthropic",
				"refresh-token",
				"access-token",
				Date.now() + 3_600_000,
				Date.now(),
				1,
				"oauth_invalid_grant",
				0,
			],
		);

		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
		};
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const strategy = {
			peek: (accounts: Account[]) =>
				accounts.find((account) => isAccountAvailable(account))?.id ?? null,
		};
		const handler = createAccountsListHandler(
			dbOps as never,
			config,
			() => strategy as never,
		);

		const response = await handler();
		const accounts = (await response.json()) as AccountResponse[];

		expect(accounts[0]?.requiresReauth).toBe(true);
		expect(accounts[0]?.pauseReason).toBe("oauth_invalid_grant");
		expect(accounts[0]?.isPrimary).toBe(false);
	});

	it("does not let a stale compatibility flag create an independent terminal state", async () => {
		// A historical/upstream writer may leave requires_reauth=1 without the
		// canonical oauth_invalid_grant pause. That stale bit must neither surface
		// as terminal auth state nor remove an otherwise healthy account from
		// routing.
		const baseTs = Date.now();
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, pause_reason, requires_reauth, priority
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"stale-flag",
				"Stale flag",
				"anthropic",
				"refresh-token",
				"access-token",
				baseTs + 3_600_000,
				baseTs,
				0,
				null,
				1,
				100,
			],
		);
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, pause_reason, requires_reauth, priority
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"healthy",
				"Healthy",
				"anthropic",
				"refresh-token",
				"access-token",
				baseTs + 3_600_000,
				baseTs,
				0,
				null,
				0,
				50,
			],
		);

		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
		};
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const strategy = {
			peek: (accounts: Account[]) =>
				accounts.find((account) => isAccountAvailable(account))?.id ?? null,
		};
		const handler = createAccountsListHandler(
			dbOps as never,
			config,
			() => strategy as never,
		);

		const response = await handler();
		const accounts = (await response.json()) as AccountResponse[];
		const stale = accounts.find((a) => a.id === "stale-flag");
		const healthy = accounts.find((a) => a.id === "healthy");

		expect(stale?.requiresReauth).toBe(false);
		expect(stale?.pauseReason).toBeNull();
		expect(stale?.isPrimary).toBe(true);
		expect(healthy?.isPrimary).toBe(false);
	});
});
