import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import {
	createAccountResumeHandler,
	createAccountsListHandler,
} from "../accounts";

// Mock the usage fetcher functions directly
const mockUsageCache = {
	cache: new Map(),
	polling: new Map(),
	tokenProviders: new Map(),
	providerTypes: new Map(),
	customEndpoints: new Map(),

	get: (accountId: string) => {
		const cached = mockUsageCache.cache.get(accountId);
		return cached ? cached.data : null;
	},

	getAge: (accountId: string) => {
		const cached = mockUsageCache.cache.get(accountId);
		return cached ? Date.now() - cached.timestamp : null;
	},

	set: (accountId: string, data: unknown) => {
		mockUsageCache.cache.set(accountId, { data, timestamp: Date.now() });
	},

	delete: (accountId: string) => {
		mockUsageCache.cache.delete(accountId);
	},

	refreshNow: async (_accountId: string) => true,

	clear: () => {
		mockUsageCache.cache.clear();
		mockUsageCache.polling.clear();
		mockUsageCache.tokenProviders.clear();
	},
};

const mockFetchUsageData = {
	five_hour: { utilization: 50, resets_at: null },
	seven_day: { utilization: 70, resets_at: null },
	seven_day_oauth_apps: { utilization: 60, resets_at: null },
	seven_day_opus: { utilization: 80, resets_at: null },
};

const mockGetRepresentativeUtilization = (
	usageData?: typeof mockFetchUsageData | null,
) => {
	if (!usageData) return 70;
	const utils = Object.values(usageData)
		.filter(
			(v): v is { utilization: number } =>
				v != null && typeof v.utilization === "number",
		)
		.map((v) => v.utilization);
	return utils.length > 0 ? Math.max(...utils) : 70;
};
const mockGetRepresentativeWindow = () => "seven_day";

const mockLog = {
	info: () => {},
	warn: () => {},
	debug: () => {},
	error: () => {},
};

const mockClearAccountRefreshCache = (_accountId: string) => {
	// Mock implementation
};

const mockCliCommands = {
	removeAccount: () => ({ success: true, message: "Account removed" }),
	pauseAccount: () => ({ success: true, message: "Account paused" }),
	resumeAccount: () => ({ success: true, message: "Account resumed" }),
};

const mockDbOps = {
	getDatabase: () => mockDatabase,
	updateAccountPriority: () => {},
	renameAccount: () => {},
	setAutoFallbackEnabled: () => {},
	forceResetAccountRateLimit: () => true,
};

// Mock Database instance
const mockDatabase = {
	query: () => mockQuery,
	run: () => {},
	// biome-ignore lint/suspicious/noExplicitAny: partial mock whose `run` is reassigned per-test with varying signatures; no single interface fits all
} as any;

const mockQuery = {
	all: () => [],
	get: () => null,
};

// Mock response helpers
// biome-ignore lint/suspicious/noExplicitAny: test fixture accepts arbitrarily-shaped response payloads across call sites
const mockJsonResponse = (data: any) => ({
	ok: true,
	json: async () => data,
	status: 200,
	headers: new Headers(),
});

// biome-ignore lint/suspicious/noExplicitAny: test fixture accepts arbitrarily-shaped error payloads and reads error.status
const mockErrorResponse = (error: any) => ({
	ok: false,
	json: async () => error,
	status: error.status || 400,
	headers: new Headers(),
});

describe("Accounts Handler - Dashboard Usage Data Integration", () => {
	const CACHE_FRESHNESS_THRESHOLD_MS = 90000; // 90 seconds

	const originalGetAge = mockUsageCache.getAge;

	beforeEach(() => {
		mockUsageCache.clear();
		mockUsageCache.getAge = originalGetAge;
		mockDatabase.run = () => {};
		mockQuery.all = () => [];
	});

	describe("Proactive Usage Data Fetching", () => {
		it("should fetch usage data for Claude CLI OAuth accounts but not API key accounts", async () => {
			// Setup: Create accounts handler with mocked dependencies
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			// Mock database response with mixed account types
			const allAccounts = [
				{
					id: "oauth-account-1",
					name: "Claude OAuth Account 1",
					provider: "anthropic",
					access_token: "sk-ant-test-1",
					refresh_token: "refresh-token-1", // Different from access token
				},
				{
					id: "api-account-1",
					name: "API Key Account",
					provider: "anthropic",
					access_token: "sk-api-key",
					refresh_token: "sk-api-key", // Same as access token = API key
				},
			];

			mockQuery.all = () =>
				allAccounts.map((account) => ({
					...account,
					request_count: 100,
					total_requests: 1000,
					last_used: Date.now() - 3600000,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				}));

			// Mock empty cache (no fresh data)
			mockUsageCache.getAge = () => null;

			// Track usageCache.set calls
			const setSpy = spyOn(mockUsageCache, "set");

			// Execute the handler
			const response = await accountsHandler();

			// Verify usage data was cached only for OAuth accounts (not API key account)
			expect(setSpy).toHaveBeenCalledWith(
				"oauth-account-1",
				mockFetchUsageData,
			);
			// Verify handler still returns data for both accounts
			expect(response.ok).toBe(true);
		});

		it("should skip fetching when cache data is fresh (< 90 seconds)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			// Mock database response with OAuth account
			const oauthAccount = {
				id: "oauth-account-1",
				name: "Claude OAuth Account",
				provider: "anthropic",
				access_token: "sk-ant-test",
				refresh_token: "refresh-token",
			};

			mockQuery.all = () => [
				{
					...oauthAccount,
					request_count: 100,
					total_requests: 1000,
					last_used: Date.now() - 3600000,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			// Mock fresh cache data (age = 30 seconds)
			mockUsageCache.getAge = () => 30000; // 30 seconds old

			// Execute the handler
			const response = await accountsHandler();

			// Verify handler still works with fresh cache
			expect(response.ok).toBe(true);
		});

		it("should fetch when cache data is stale (> 90 seconds)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			// Mock database response with OAuth account
			const oauthAccount = {
				id: "oauth-account-1",
				name: "Claude OAuth Account",
				provider: "anthropic",
				access_token: "sk-ant-test",
				refresh_token: "refresh-token",
			};

			mockQuery.all = () => [
				{
					...oauthAccount,
					request_count: 100,
					total_requests: 1000,
					last_used: Date.now() - 3600000,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			// Mock stale cache data (age = 120 seconds)
			mockUsageCache.getAge = () => 120000; // 120 seconds old

			// Track usageCache.set calls
			const setSpy = spyOn(mockUsageCache, "set");

			// Execute the handler
			const response = await accountsHandler();

			// Verify usage data was fetched and cached
			expect(setSpy).toHaveBeenCalledWith(
				"oauth-account-1",
				expect.any(Object),
			);
			expect(response.ok).toBe(true);
		});
	});

	describe("Stale rate_limited_until Clearing", () => {
		const originalGetAge = mockUsageCache.getAge;
		const originalDbRun = mockDatabase.run;

		afterEach(() => {
			mockUsageCache.getAge = originalGetAge;
			mockDatabase.run = originalDbRun;
			mockQuery.all = () => [];
		});

		function makeOAuthAccount(overrides: Record<string, unknown> = {}) {
			return {
				id: "oauth-account-1",
				name: "Claude OAuth Account",
				provider: "anthropic",
				access_token: "sk-ant-test",
				refresh_token: "refresh-token",
				request_count: 0,
				total_requests: 0,
				last_used: Date.now() - 3600000,
				created_at: Date.now() - 86400000,
				expires_at: Date.now() + 86400000,
				rate_limited_until: null,
				rate_limit_reset: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				session_start: null,
				session_request_count: 0,
				paused: 0,
				priority: 0,
				auto_fallback_enabled: 0,
				auto_refresh_enabled: 0,
				custom_endpoint: null,
				model_mappings: null,
				token_valid: 1,
				rate_limited: 0,
				session_info: null,
				...overrides,
			};
		}

		it("clears stale rate_limited_until when usage API shows < 100% and expiry is in the future", async () => {
			const accountsHandler = createMockAccountsListHandler(90000);
			const futureExpiry = Date.now() + 3 * 60 * 60 * 1000; // 3h from now

			mockQuery.all = () => [
				makeOAuthAccount({ rate_limited_until: futureExpiry, rate_limited: 1 }),
			];
			mockUsageCache.getAge = () => null; // stale — will fetch

			let clearSqlCalled = false;
			let clearSqlArgs: unknown[] = [];
			mockDatabase.run = (sql: string, args: unknown[]) => {
				if (
					sql === "UPDATE accounts SET rate_limited_until = NULL WHERE id = ?"
				) {
					clearSqlCalled = true;
					clearSqlArgs = args;
				}
			};

			const response = await accountsHandler();

			expect(clearSqlCalled).toBe(true);
			expect(clearSqlArgs).toEqual(["oauth-account-1"]);
			expect(response.ok).toBe(true);
			const body = await response.json();
			expect(body[0].rateLimitedUntil).toBeNull();
		});

		it("does NOT clear rate_limited_until when expiry is already in the past", async () => {
			const accountsHandler = createMockAccountsListHandler(90000);
			const pastExpiry = Date.now() - 1000; // already expired

			mockQuery.all = () => [
				makeOAuthAccount({ rate_limited_until: pastExpiry, rate_limited: 1 }),
			];
			mockUsageCache.getAge = () => null;

			let dbRunCalledWithClear = false;
			mockDatabase.run = (sql: string) => {
				if (
					sql === "UPDATE accounts SET rate_limited_until = NULL WHERE id = ?"
				) {
					dbRunCalledWithClear = true;
				}
			};

			const response = await accountsHandler();
			expect(dbRunCalledWithClear).toBe(false);
			expect(response.ok).toBe(true);
		});

		it("does NOT clear rate_limited_until when account has no rate limit set", async () => {
			const accountsHandler = createMockAccountsListHandler(90000);

			mockQuery.all = () => [makeOAuthAccount({ rate_limited_until: null })];
			mockUsageCache.getAge = () => null;

			let dbRunCalledWithClear = false;
			mockDatabase.run = (sql: string) => {
				if (
					sql === "UPDATE accounts SET rate_limited_until = NULL WHERE id = ?"
				) {
					dbRunCalledWithClear = true;
				}
			};

			const response = await accountsHandler();
			expect(dbRunCalledWithClear).toBe(false);
			expect(response.ok).toBe(true);
		});

		it("does NOT clear rate_limited_until when cache is fresh (no usage fetch)", async () => {
			const accountsHandler = createMockAccountsListHandler(90000);
			const futureExpiry = Date.now() + 3 * 60 * 60 * 1000;

			mockQuery.all = () => [
				makeOAuthAccount({ rate_limited_until: futureExpiry, rate_limited: 1 }),
			];
			mockUsageCache.getAge = () => 30000; // fresh — skips fetch entirely

			let dbRunCalledWithClear = false;
			mockDatabase.run = (sql: string) => {
				if (
					sql === "UPDATE accounts SET rate_limited_until = NULL WHERE id = ?"
				) {
					dbRunCalledWithClear = true;
				}
			};

			const response = await accountsHandler();
			expect(dbRunCalledWithClear).toBe(false);
			expect(response.ok).toBe(true);
		});

		it("does NOT clear rate_limited_until when utilization is >= 100 (account exhausted)", async () => {
			const exhaustedData = {
				five_hour: { utilization: 100, resets_at: null },
				seven_day: { utilization: 100, resets_at: null },
				seven_day_oauth_apps: { utilization: 100, resets_at: null },
				seven_day_opus: { utilization: 100, resets_at: null },
			};
			const accountsHandler = createMockAccountsListHandler(
				90000,
				exhaustedData,
			);
			const futureExpiry = Date.now() + 3 * 60 * 60 * 1000;

			mockQuery.all = () => [
				makeOAuthAccount({ rate_limited_until: futureExpiry, rate_limited: 1 }),
			];
			mockUsageCache.getAge = () => null; // stale — will fetch

			let dbRunCalledWithClear = false;
			mockDatabase.run = (sql: string) => {
				if (
					sql === "UPDATE accounts SET rate_limited_until = NULL WHERE id = ?"
				) {
					dbRunCalledWithClear = true;
				}
			};

			const response = await accountsHandler();
			expect(dbRunCalledWithClear).toBe(false);
			expect(response.ok).toBe(true);
		});
	});

	describe("Account Management Integration", () => {
		it("should clear usage cache when Anthropic account is removed", async () => {
			const removeHandler = createMockAccountRemoveHandler();

			// Setup: Account exists in database
			mockQuery.get = () => ({ id: "test-account-id" });

			// Mock successful removal
			mockCliCommands.removeAccount = () => ({
				success: true,
				message: "Account removed",
			});

			// Track usageCache.delete calls
			const deleteSpy = spyOn(mockUsageCache, "delete");

			// Mock request body with confirmation
			const mockRequest = {
				json: async () => ({ confirm: "test-account-name" }),
			} as Request;

			// Execute the handler
			const response = await removeHandler(mockRequest, "test-account-name");

			// Verify usage cache was cleared for the removed account
			expect(deleteSpy).toHaveBeenCalledWith("test-account-id");
			expect(response.ok).toBe(true);
		});

		it("should clear usage cache when Anthropic account tokens are reloaded", async () => {
			const reloadHandler = createMockAccountReloadHandler();

			// Setup: Anthropic account exists in database
			mockQuery.get = () => ({
				name: "test-account-name",
				provider: "anthropic",
			});

			// Track usageCache.delete calls
			const deleteSpy = spyOn(mockUsageCache, "delete");

			// Execute the handler
			const response = await reloadHandler({} as Request, "test-account-id");

			// Verify usage cache was cleared
			expect(deleteSpy).toHaveBeenCalledWith("test-account-id");
			expect(response.ok).toBe(true);
		});

		it("should not clear caches for non-Anthropic accounts during token reload", async () => {
			const reloadHandler = createMockAccountReloadHandler();

			// Setup: Non-Anthropic account exists
			mockQuery.get = () => ({
				name: "test-account-name",
				provider: "openai-compatible",
			});

			// Clear any previous calls
			mockUsageCache.delete.calls = [];

			// Execute the handler
			const response = await reloadHandler({} as Request, "test-account-id");

			// Verify response indicates error for non-Anthropic account
			expect(response.ok).toBe(false);
		});

		it("should include rateLimitedUntil in account list response", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);
			const futureTimestamp = Date.now() + 86400000; // 24 hours from now

			// Use fresh cache so the usage fetch is skipped — prevents stale-clear logic
			// from wiping rate_limited_until before the assertion.
			mockUsageCache.getAge = () => 30000;

			mockQuery.all = () => [
				{
					id: "locked-account-id",
					name: "Locked Account",
					provider: "anthropic",
					access_token: "sk-ant-test",
					refresh_token: "refresh-token",
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: futureTimestamp,
					rate_limit_reset: null,
					rate_limit_status: "allowed_warning",
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			const response = await accountsHandler();
			const payload = (await response.json()) as Array<{
				rateLimitedUntil: number | null;
			}>;

			expect(response.ok).toBe(true);
			expect(payload[0].rateLimitedUntil).toBe(futureTimestamp);
		});

		it("should include rateLimitedReason and rateLimitedAt in response for rate-limited accounts (issue #178)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);
			const futureTimestamp = Date.now() + 86400000;
			const rateLimitedAt = Date.now() - 60_000; // marked 1 minute ago

			// Use fresh cache so stale-clear logic does not wipe the rate limit state.
			mockUsageCache.getAge = () => 30000;

			mockQuery.all = () => [
				{
					id: "audit-account-id",
					name: "Audit Account",
					provider: "anthropic",
					access_token: "sk-ant-test",
					refresh_token: "refresh-token",
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: futureTimestamp,
					rate_limited_reason: "upstream_429_with_reset",
					rate_limited_at: rateLimitedAt,
					rate_limit_reset: null,
					rate_limit_status: "allowed_warning",
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			const response = await accountsHandler();
			const payload = (await response.json()) as Array<{
				rateLimitedUntil: number | null;
				rateLimitedReason: string | null;
				rateLimitedAt: number | null;
			}>;

			expect(response.ok).toBe(true);
			expect(payload[0].rateLimitedUntil).toBe(futureTimestamp);
			expect(payload[0].rateLimitedReason).toBe("upstream_429_with_reset");
			expect(payload[0].rateLimitedAt).toBe(rateLimitedAt);
		});

		it("should expose upstream_529_overloaded_with_reset reason via API (allowlist coverage)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);
			const futureTimestamp = Date.now() + 86400000;
			const rateLimitedAt = Date.now() - 30_000;

			mockUsageCache.getAge = () => 30000;

			mockQuery.all = () => [
				{
					id: "529-account-id",
					name: "529 Account",
					provider: "anthropic",
					access_token: "sk-ant-test",
					refresh_token: "refresh-token",
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: futureTimestamp,
					rate_limited_reason: "upstream_529_overloaded_with_reset",
					rate_limited_at: rateLimitedAt,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			const response = await accountsHandler();
			const payload = (await response.json()) as Array<{
				rateLimitedUntil: number | null;
				rateLimitedReason: string | null;
				rateLimitedAt: number | null;
			}>;

			expect(response.ok).toBe(true);
			expect(payload[0].rateLimitedReason).toBe(
				"upstream_529_overloaded_with_reset",
			);
			expect(payload[0].rateLimitedAt).toBe(rateLimitedAt);
		});

		it("should expose out_of_credits reason via API (allowlist coverage, issue #261)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);
			const rateLimitedAt = Date.now() - 30_000;

			mockUsageCache.getAge = () => 30000;

			mockQuery.all = () => [
				{
					id: "ooc-account-id",
					name: "Out of Credits Account",
					provider: "anthropic",
					access_token: "sk-ant-test",
					refresh_token: "refresh-token",
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					// out_of_credits is model-scoped — the account is not benched,
					// but the reason can still appear in persisted audit state.
					rate_limited_until: null,
					rate_limited_reason: "out_of_credits",
					rate_limited_at: rateLimitedAt,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			const response = await accountsHandler();
			const payload = (await response.json()) as Array<{
				rateLimitedReason: string | null;
				rateLimitedAt: number | null;
			}>;

			expect(response.ok).toBe(true);
			expect(payload[0].rateLimitedReason).toBe("out_of_credits");
			expect(payload[0].rateLimitedAt).toBe(rateLimitedAt);
		});

		it("should expose xai_capacity_402 reason via API (allowlist coverage, R5-R10)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);
			const futureTimestamp = Date.now() + 3600000;
			const rateLimitedAt = Date.now() - 30_000;

			mockUsageCache.getAge = () => 30000;

			mockQuery.all = () => [
				{
					id: "xai-402-account-id",
					name: "xAI Capacity Account",
					provider: "xai",
					access_token: null,
					refresh_token: "xai-api-key",
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: Date.now() - 86400000,
					expires_at: null,
					// XaiProvider.parseRateLimit classifies a native xAI 402
					// (Grok Build credits exhausted) with this typed reason
					// instead of a generic 429-shaped one.
					rate_limited_until: futureTimestamp,
					rate_limited_reason: "xai_capacity_402",
					rate_limited_at: rateLimitedAt,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			const response = await accountsHandler();
			const payload = (await response.json()) as Array<{
				rateLimitedReason: string | null;
				rateLimitedAt: number | null;
			}>;

			expect(response.ok).toBe(true);
			expect(payload[0].rateLimitedReason).toBe("xai_capacity_402");
			expect(payload[0].rateLimitedAt).toBe(rateLimitedAt);
		});

		it("should return null rateLimitedReason and rateLimitedAt for accounts that are not rate-limited (issue #178)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			mockUsageCache.getAge = () => 30000;

			mockQuery.all = () => [
				{
					id: "ok-account-id",
					name: "OK Account",
					provider: "anthropic",
					access_token: "sk-ant-test",
					refresh_token: "refresh-token",
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			const response = await accountsHandler();
			const payload = (await response.json()) as Array<{
				rateLimitedUntil: number | null;
				rateLimitedReason: string | null;
				rateLimitedAt: number | null;
			}>;

			expect(response.ok).toBe(true);
			expect(payload[0].rateLimitedReason).toBeNull();
			expect(payload[0].rateLimitedAt).toBeNull();
		});

		it("should return 404 when account is not found", async () => {
			const forceResetHandler = createMockAccountForceResetRateLimitHandler();
			mockQuery.get = () => undefined;

			const response = await forceResetHandler({} as Request, "nonexistent-id");
			expect(response.status).toBe(404);
		});

		it("should force reset rate-limit state and trigger immediate usage polling", async () => {
			const forceResetHandler = createMockAccountForceResetRateLimitHandler();

			mockQuery.get = () => ({
				id: "test-account-id",
				name: "test-account-name",
				provider: "anthropic",
				access_token: "test-token",
			});

			const refreshNowSpy = spyOn(mockUsageCache, "refreshNow");
			const forceResetSpy = spyOn(mockDbOps, "forceResetAccountRateLimit");

			const response = await forceResetHandler(
				{} as Request,
				"test-account-id",
			);
			const payload = (await response.json()) as {
				success: boolean;
				usagePollTriggered: boolean;
			};

			expect(forceResetSpy).toHaveBeenCalledWith("test-account-id");
			expect(refreshNowSpy).toHaveBeenCalledWith("test-account-id");
			expect(response.ok).toBe(true);
			expect(payload.success).toBe(true);
			expect(payload.usagePollTriggered).toBe(true);
		});

		it("should return usagePollTriggered false when usage poll fails", async () => {
			const forceResetHandler = createMockAccountForceResetRateLimitHandler();
			mockQuery.get = () => ({
				id: "test-id",
				name: "test",
				provider: "anthropic",
				access_token: "tok",
			});

			const refreshNowSpy = spyOn(
				mockUsageCache,
				"refreshNow",
			).mockImplementation(async () => false);
			const forceResetSpy = spyOn(mockDbOps, "forceResetAccountRateLimit");

			const response = await forceResetHandler({} as Request, "test-id");
			const payload = (await response.json()) as {
				success: boolean;
				usagePollTriggered: boolean;
			};

			expect(forceResetSpy).toHaveBeenCalledWith("test-id");
			expect(refreshNowSpy).toHaveBeenCalledWith("test-id");
			expect(response.ok).toBe(true);
			expect(payload.usagePollTriggered).toBe(false);
		});
	});
});

// Minimal shape of an account row as returned by the mocked SQL query below.
interface MockAccountRow {
	id: string;
	name: string;
	provider: string;
	access_token: string | null;
	refresh_token: string | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limited_at: number | null;
}

// Mock factory functions to create handlers with our mocked dependencies
function createMockAccountsListHandler(
	CACHE_FRESHNESS_THRESHOLD_MS: number,
	fetchData: typeof mockFetchUsageData = mockFetchUsageData,
) {
	return async (): Promise<Response> => {
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const accounts = mockQuery.all(
			now,
			now,
			now,
			sessionDuration,
		) as Array<MockAccountRow>;

		// Fetch usage data for all Claude CLI OAuth accounts
		const oauthAccounts = accounts.filter(
			(acc) =>
				acc.provider === "anthropic" &&
				acc.access_token &&
				acc.refresh_token &&
				acc.refresh_token !== acc.access_token, // Exclude API key accounts
		);

		// Fetch usage data in parallel for all OAuth accounts that don't have fresh cache data
		await Promise.all(
			oauthAccounts.map(async (account) => {
				// Check if we already have cached data and if it's still fresh
				const cacheAge = mockUsageCache.getAge(account.id);
				const isCacheFresh =
					cacheAge !== null && cacheAge < CACHE_FRESHNESS_THRESHOLD_MS;

				if (!isCacheFresh && account.access_token) {
					// Fetch usage data if cache is stale or missing
					try {
						const usageData = fetchData;
						if (usageData) {
							mockUsageCache.set(account.id, usageData);
							mockLog.debug(
								`Fetched usage data for ${account.name}: 5h=${usageData.five_hour.utilization}%, 7d=${usageData.seven_day.utilization}%`,
							);

							// If the usage API shows available capacity but the DB still has
							// rate_limited_until in the future, clear the stale state.
							const utilization = mockGetRepresentativeUtilization(usageData);
							const limitedUntil = account.rate_limited_until
								? Number(account.rate_limited_until)
								: null;
							if (
								utilization !== null &&
								utilization < 100 &&
								limitedUntil !== null &&
								limitedUntil > Date.now()
							) {
								await mockDatabase.run(
									"UPDATE accounts SET rate_limited_until = NULL WHERE id = ?",
									[account.id],
								);
								account.rate_limited_until = null;
								account.rate_limited = 0;
								mockLog.info(
									`Cleared stale rate_limited_until for ${account.name}: usage API shows ${utilization}% utilization`,
								);
							}
						}
					} catch (error) {
						mockLog.warn(
							`Failed to fetch usage data for account ${account.name}:`,
							error,
						);
					}
				}
			}),
		);

		const response = accounts.map((account) => {
			// Get usage data from cache
			const usageData = mockUsageCache.get(account.id);
			let usageUtilization: number | null = null;
			let usageWindow: string | null = null;

			if (account.provider === "anthropic" && usageData) {
				usageUtilization = mockGetRepresentativeUtilization(usageData);
				usageWindow = mockGetRepresentativeWindow();
			}

			return {
				id: account.id,
				name: account.name,
				provider: account.provider || "anthropic",
				usageUtilization,
				usageWindow,
				usageData,
				hasRefreshToken:
					!!account.refresh_token &&
					account.refresh_token !== account.access_token,
				rateLimitedUntil: account.rate_limited_until || null,
				rateLimitedReason: account.rate_limited_reason ?? null,
				rateLimitedAt: account.rate_limited_at ?? null,
			};
		});

		return mockJsonResponse(response);
	};
}

function createMockAccountRemoveHandler() {
	return async (req: Request, accountName: string): Promise<Response> => {
		try {
			const body = await req.json();

			if (body.confirm !== accountName) {
				return mockErrorResponse({
					status: 400,
					message: "Confirmation does not match",
				});
			}

			const result = mockCliCommands.removeAccount(mockDbOps, accountName);

			if (!result.success) {
				return mockErrorResponse({ status: 404, message: result.message });
			}

			// Find the account ID to clean up usage cache
			const account = mockQuery.get(accountName);

			if (account) {
				mockUsageCache.delete(account.id);
			}

			return mockJsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return mockErrorResponse(error);
		}
	};
}

function createMockAccountReloadHandler() {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = mockQuery.get(accountId);

			if (!account) {
				return mockErrorResponse({ status: 404, message: "Account not found" });
			}

			if (account.provider !== "anthropic") {
				return mockErrorResponse({
					status: 400,
					message: "Token reload is only available for Anthropic accounts",
				});
			}

			// Clear refresh cache and usage cache
			mockClearAccountRefreshCache(accountId);
			mockUsageCache.delete(accountId);

			mockLog.info(`Token reload triggered for account '${account.name}'`);

			return mockJsonResponse({
				success: true,
				message: `Token reload triggered for account '${account.name}'`,
			});
		} catch (error) {
			return mockErrorResponse(error);
		}
	};
}

function createMockAccountForceResetRateLimitHandler() {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = mockQuery.get(accountId);
			if (!account) {
				return mockErrorResponse({ status: 404, message: "Account not found" });
			}

			mockDbOps.forceResetAccountRateLimit(accountId);
			mockClearAccountRefreshCache(accountId);
			const usagePollTriggered = await mockUsageCache.refreshNow(accountId);

			return mockJsonResponse({
				success: true,
				message: `Rate limit state cleared for account '${account.name}'`,
				usagePollTriggered,
			});
		} catch (error) {
			return mockErrorResponse(error);
		}
	};
}

/**
 * OAuth control-plane hotfix (U8, R22-R23): unlike the hand-rolled mocks
 * above, these tests exercise the REAL createAccountsListHandler and
 * createAccountResumeHandler against a real DatabaseOperations instance
 * backed by a temp SQLite file, so a regression in the guard chain
 * (AccountRepository -> DatabaseOperations -> cli-commands -> HTTP handler)
 * actually fails these tests. No network/OAuth traffic; fixture rows only.
 */
describe("Accounts Handler - OAuth control-plane hotfix (U8)", () => {
	let tmpDir: string;
	let dbOps: DatabaseOperations;
	const config = {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
	} as unknown as Config;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccflare-oauth-hotfix-"));
		dbOps = new DatabaseOperations(path.join(tmpDir, "test.db"));
	});

	afterEach(async () => {
		await dbOps.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function insertAccount(
		id: string,
		opts: { paused?: boolean; pauseReason?: string | null } = {},
	): Promise<void> {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts
				(id, name, provider, refresh_token, access_token, expires_at, created_at, paused, pause_reason)
			 VALUES (?, ?, 'anthropic', 'rt-fixture', 'at-fixture', ?, ?, ?, ?)`,
			[
				id,
				id,
				Date.now() + 60 * 60 * 1000,
				Date.now(),
				opts.paused ? 1 : 0,
				opts.pauseReason ?? null,
			],
		);
	}

	async function getRow(
		id: string,
	): Promise<{ paused: number; pause_reason: string | null }> {
		const row = await dbOps
			.getAdapter()
			.get<{ paused: number; pause_reason: string | null }>(
				"SELECT paused, pause_reason FROM accounts WHERE id = ?",
				[id],
			);
		if (!row) throw new Error(`account ${id} not found`);
		return row;
	}

	it("R22: exposes pauseReason on every account in the list response", async () => {
		await insertAccount("acct-manual", {
			paused: true,
			pauseReason: "manual",
		});
		await insertAccount("acct-reauth", {
			paused: true,
			pauseReason: "oauth_invalid_grant",
		});
		await insertAccount("acct-active");

		const response = await createAccountsListHandler(dbOps, config)();
		const payload = (await response.json()) as Array<{
			id: string;
			pauseReason: string | null;
		}>;

		expect(response.status).toBe(200);
		const byId = new Map(payload.map((a) => [a.id, a.pauseReason]));
		expect(byId.get("acct-manual")).toBe("manual");
		expect(byId.get("acct-reauth")).toBe("oauth_invalid_grant");
		expect(byId.get("acct-active")).toBeNull();
	});

	it("R23: manual-pause resume works unchanged", async () => {
		await insertAccount("acct-manual-2", {
			paused: true,
			pauseReason: "manual",
		});

		const response = await createAccountResumeHandler(dbOps)(
			new Request("http://localhost/api/accounts/acct-manual-2/resume", {
				method: "POST",
			}),
			"acct-manual-2",
		);
		const payload = (await response.json()) as { success: boolean };

		expect(response.status).toBe(200);
		expect(payload.success).toBe(true);
		const row = await getRow("acct-manual-2");
		expect(row.paused).toBe(0);
		expect(row.pause_reason).toBeNull();
	});

	it("R23: terminal-pause Resume is refused with a typed reauthentication-required response", async () => {
		await insertAccount("acct-terminal", {
			paused: true,
			pauseReason: "oauth_invalid_grant",
		});

		const response = await createAccountResumeHandler(dbOps)(
			new Request("http://localhost/api/accounts/acct-terminal/resume", {
				method: "POST",
			}),
			"acct-terminal",
		);
		const payload = (await response.json()) as {
			error: string;
			details?: { code?: string; pauseReason?: string };
		};

		expect(response.status).toBe(400);
		expect(payload.details?.code).toBe("reauthentication_required");
		expect(payload.details?.pauseReason).toBe("oauth_invalid_grant");
		// The account must still be paused for the terminal reason: Resume must
		// never clear oauth_invalid_grant.
		const row = await getRow("acct-terminal");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("oauth_invalid_grant");
	});

	it("AE10: after successful reauthentication clears the terminal reason, the account auto-resumes and relists as unpaused", async () => {
		await insertAccount("acct-reauthed", {
			paused: true,
			pauseReason: "oauth_invalid_grant",
		});

		// Simulate the reauth flow's existing guarded auto-resume (unchanged by
		// U8 -- this is the ONLY legitimate exit from a terminal pause besides a
		// fresh differently-reasoned pause).
		const resumed = await dbOps.resumeAccountIfNeedsReauth("acct-reauthed");
		expect(resumed).toBe(true);

		const response = await createAccountsListHandler(dbOps, config)();
		const payload = (await response.json()) as Array<{
			id: string;
			paused: boolean;
			pauseReason: string | null;
		}>;
		const account = payload.find((a) => a.id === "acct-reauthed");

		expect(account?.paused).toBe(false);
		expect(account?.pauseReason).toBeNull();
	});
});
