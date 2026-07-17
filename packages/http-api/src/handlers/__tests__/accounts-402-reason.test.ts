import { describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { createAccountsListHandler } from "../accounts";

describe("accounts API 402 cooldown reason", () => {
	it("exposes upstream_402_payment_required from persisted account state", async () => {
		const now = Date.now();
		const query = mock(async () => [
			{
				id: "payment-required-account",
				name: "Payment Required Account",
				provider: "openai-compatible",
				request_count: 1,
				total_requests: 2,
				last_used: null,
				created_at: now - 60_000,
				expires_at: null,
				rate_limited_until: now + 120_000,
				rate_limited_reason: "upstream_402_payment_required",
				rate_limited_at: now,
				rate_limit_reset: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				session_start: null,
				session_request_count: 0,
				refresh_token: "test-key",
				access_token: "test-key",
				paused: 0,
				priority: 0,
				token_valid: 0,
				rate_limited: 1,
				session_info: "-",
				auto_fallback_enabled: 0,
				auto_refresh_enabled: 0,
				auto_pause_on_overage_enabled: 0,
				peak_hours_pause_enabled: 0,
				custom_endpoint: "https://provider.test/v1",
				model_mappings: null,
				cross_region_mode: null,
				model_fallbacks: null,
				billing_type: null,
				pause_reason: null,
			},
		]);
		const dbOps = {
			getAdapter: () => ({ query }),
			getStatsRepository: () => ({
				getSessionStats: mock(async () => new Map()),
			}),
		} as unknown as DatabaseOperations;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;

		const response = await createAccountsListHandler(dbOps, config)();
		const payload = (await response.json()) as Array<{
			rateLimitedReason: string | null;
		}>;

		expect(response.status).toBe(200);
		expect(query).toHaveBeenCalledTimes(1);
		expect(payload[0]?.rateLimitedReason).toBe("upstream_402_payment_required");
	});
});
