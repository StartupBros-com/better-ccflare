import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";

mock.module("../../utils/browser", () => ({
	openBrowser: async () => true,
}));

mock.module("@better-ccflare/providers/qwen", () => ({
	initiateDeviceFlow: async () => ({
		deviceCode: "device-code",
		userCode: "USER-CODE",
		verificationUri: "https://example.com/verify",
		verificationUriComplete: "https://example.com/verify?code=USER-CODE",
		interval: 1,
		pkce: { verifier: "verifier", challenge: "challenge" },
	}),
	pollForToken: async () => ({
		access_token: "access-token-reauth",
		refresh_token: "refresh-token-reauth",
		expires_in: 3600,
		resource_url: null,
	}),
}));

const { reauthenticateAccount } = await import("../account");

const config = {} as Config;

describe("CLI Qwen account re-authentication", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;

	beforeEach(() => {
		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		dbPath = join(tmpdir(), `test-qwen-cli-${suffix}.db`);
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		DatabaseFactory.reset();
		for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
			if (existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("stamps refresh_token_issued_at when re-authenticating via the device flow", async () => {
		const accountId = crypto.randomUUID();
		const originalIssuedAt = Date.now() - 60_000;

		await dbOps.getAdapter().run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority,
				custom_endpoint, refresh_token_issued_at, paused, pause_reason,
				requires_reauth
			) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, ?, 1, ?, 1)`,
			[
				accountId,
				"qwen-reauth",
				"qwen",
				"refresh-token-original",
				"access-token-original",
				Date.now() + 60_000,
				Date.now(),
				50,
				"https://example.com",
				originalIssuedAt,
				"oauth_invalid_grant",
			],
		);

		const before = Date.now();
		const result = await reauthenticateAccount(dbOps, config, "qwen-reauth");
		const after = Date.now();

		expect(result.success).toBe(true);

		const account = dbOps
			.getDatabase()
			.query<
				{
					access_token: string;
					refresh_token: string;
					refresh_token_issued_at: number;
					requires_reauth: number;
					paused: number;
					pause_reason: string | null;
				},
				[string]
			>(
				"SELECT access_token, refresh_token, refresh_token_issued_at, requires_reauth, paused, pause_reason FROM accounts WHERE name = ?",
			)
			.get("qwen-reauth");

		expect(account).toBeDefined();
		expect(account?.access_token).toBe("access-token-reauth");
		expect(account?.refresh_token).toBe("refresh-token-reauth");
		expect(account?.requires_reauth).toBe(0);
		expect(account?.paused).toBe(0);
		expect(account?.pause_reason).toBeNull();
		expect(account?.refresh_token_issued_at).toBeGreaterThanOrEqual(before);
		expect(account?.refresh_token_issued_at).toBeLessThanOrEqual(after);
		expect(account?.refresh_token_issued_at).toBeGreaterThan(originalIssuedAt);
	});

	it("preserves a manual pause after successful device-flow reauth", async () => {
		const accountId = crypto.randomUUID();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority,
				custom_endpoint, paused, pause_reason, requires_reauth
			) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, 1)`,
			[
				accountId,
				"qwen-manual-pause",
				"qwen",
				"refresh-token-original",
				"access-token-original",
				Date.now() + 60_000,
				Date.now(),
				50,
				"https://example.com",
				"manual",
			],
		);

		const result = await reauthenticateAccount(
			dbOps,
			config,
			"qwen-manual-pause",
		);
		expect(result.success).toBe(true);

		const account = dbOps
			.getDatabase()
			.query<{ paused: number; pause_reason: string | null }, [string]>(
				"SELECT paused, pause_reason FROM accounts WHERE name = ?",
			)
			.get("qwen-manual-pause");

		expect(account?.paused).toBe(1);
		expect(account?.pause_reason).toBe("manual");
	});
});
