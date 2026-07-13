import { afterEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import { clearSession, recordServedAccount } from "@better-ccflare/proxy";
import type { Account } from "@better-ccflare/types";
import { AuthService } from "../../services/auth-service";
import { createSessionAccountHandler } from "../sessions";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "primary",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeDbOps(accounts: Account[]): DatabaseOperations {
	return {
		getAllAccounts: async () => accounts,
	} as unknown as DatabaseOperations;
}

function makeConfig(throttling = false): Config {
	return {
		getUsageThrottlingFiveHourEnabled: () => throttling,
		getUsageThrottlingWeeklyEnabled: () => throttling,
	} as unknown as Config;
}

type SessionAccountBody = {
	success: boolean;
	data: {
		status: "known" | "unknown";
		account?: {
			id: string;
			name: string;
			provider: string;
			paused: boolean;
			usageUtilization: number | null;
			usageWindow: string | null;
			usageResetMs: number | null;
			windows: Array<{
				window: string;
				utilization: number;
				resetMs: number | null;
			}>;
			rateLimitStatus: string;
			rateLimitedUntil: number | null;
			rateLimitReset: number | null;
			usageThrottledUntil: number | null;
			usageThrottledWindows: string[];
		};
	};
};

const SESSION = "sessions-test-session";
const ACCOUNT_ID = "acc-sessions-test";

afterEach(() => {
	clearSession(SESSION);
	usageCache.delete(ACCOUNT_ID);
});

describe("createSessionAccountHandler", () => {
	it("AE1: returns known with account name and usage for a mapped healthy account", async () => {
		const now = Date.now();
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 30,
				resets_at: new Date(now + 4 * 3600_000).toISOString(),
			},
			seven_day: {
				utilization: 10,
				resets_at: new Date(now + 6 * 86400_000).toISOString(),
			},
		});
		recordServedAccount(SESSION, ACCOUNT_ID);
		const account = makeAccount({ id: ACCOUNT_ID, name: "healthy-acct" });

		const handler = createSessionAccountHandler(
			makeDbOps([account]),
			makeConfig(),
		);
		const res = await handler(SESSION);
		expect(res.status).toBe(200);

		const body = (await res.json()) as SessionAccountBody;
		expect(body.success).toBe(true);
		expect(body.data.status).toBe("known");
		expect(body.data.account?.name).toBe("healthy-acct");
		expect(body.data.account?.usageUtilization).toBe(30);
		expect(body.data.account?.usageWindow).toBe("five_hour");
		// Representative window (five_hour, higher util) reset time resolves to its
		// resets_at epoch, not null.
		expect(body.data.account?.usageResetMs).toBeGreaterThan(now);
		expect(body.data.account?.paused).toBe(false);
		expect(body.data.account?.rateLimitStatus).toBe("OK");
		// Anthropic exposes BOTH its 5h and 7d limits independently.
		const w = body.data.account?.windows ?? [];
		expect(w.map((x) => x.window).sort()).toEqual(["five_hour", "seven_day"]);
		expect(w.find((x) => x.window === "five_hour")?.utilization).toBe(30);
		expect(w.find((x) => x.window === "seven_day")?.utilization).toBe(10);
		expect(w.find((x) => x.window === "five_hour")?.resetMs).toBeGreaterThan(
			now,
		);
	});

	it("composes usage provider-aware for a non-anthropic (zai) account", async () => {
		usageCache.set(ACCOUNT_ID, {
			time_limit: null,
			tokens_limit: { percentage: 55 },
		});
		recordServedAccount(SESSION, ACCOUNT_ID);
		const account = makeAccount({ id: ACCOUNT_ID, provider: "zai" });

		const handler = createSessionAccountHandler(
			makeDbOps([account]),
			makeConfig(),
		);
		const res = await handler(SESSION);
		const body = (await res.json()) as SessionAccountBody;

		expect(body.data.status).toBe("known");
		expect(body.data.account?.provider).toBe("zai");
		expect(body.data.account?.usageUtilization).toBe(55);
		// Provider-aware window: zai must resolve a window label, not null (the
		// regression getRepresentativeWindowForProvider fixes — plain
		// getRepresentativeWindow only recognizes anthropic/codex shapes).
		expect(body.data.account?.usageWindow).toBe("five_hour");
		// Single-window provider: exactly one limit window, its representative.
		expect(body.data.account?.windows).toEqual([
			{ window: "five_hour", utilization: 55, resetMs: null },
		]);
	});

	it("AE2: returns unknown for a session id that was never recorded", async () => {
		const handler = createSessionAccountHandler(
			makeDbOps([makeAccount()]),
			makeConfig(),
		);
		const res = await handler("never-recorded-session");
		expect(res.status).toBe(200);

		const body = (await res.json()) as SessionAccountBody;
		expect(body.data.status).toBe("unknown");
		expect(body.data.account).toBeUndefined();
	});

	it("AE3: reflects a rate-limited account", async () => {
		const until = Date.now() + 60 * 60 * 1000;
		recordServedAccount(SESSION, ACCOUNT_ID);
		const account = makeAccount({
			id: ACCOUNT_ID,
			rate_limited_until: until,
			rate_limited_reason: "upstream_429_with_reset",
		});

		const handler = createSessionAccountHandler(
			makeDbOps([account]),
			makeConfig(),
		);
		const res = await handler(SESSION);
		const body = (await res.json()) as SessionAccountBody;

		expect(body.data.status).toBe("known");
		expect(body.data.account?.rateLimitedUntil).toBe(until);
		expect(body.data.account?.rateLimitStatus.startsWith("Rate limited")).toBe(
			true,
		);
	});

	it("AE3: reflects a paused account", async () => {
		recordServedAccount(SESSION, ACCOUNT_ID);
		const account = makeAccount({ id: ACCOUNT_ID, paused: true });

		const handler = createSessionAccountHandler(
			makeDbOps([account]),
			makeConfig(),
		);
		const res = await handler(SESSION);
		const body = (await res.json()) as SessionAccountBody;

		expect(body.data.status).toBe("known");
		expect(body.data.account?.paused).toBe(true);
	});

	it("surfaces the usage-throttled state while paused and rate-limit fields stay clear", async () => {
		const now = Date.now();
		// A five-hour window ~3h in (resets in 2h) at 80% utilization runs ahead of
		// the linear pace, so the throttle governor holds it.
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 80,
				resets_at: new Date(now + 2 * 3600_000).toISOString(),
			},
			seven_day: { utilization: 10, resets_at: null },
		});
		recordServedAccount(SESSION, ACCOUNT_ID);
		const account = makeAccount({ id: ACCOUNT_ID });

		const handler = createSessionAccountHandler(
			makeDbOps([account]),
			makeConfig(true),
		);
		const res = await handler(SESSION);
		const body = (await res.json()) as SessionAccountBody;

		expect(body.data.status).toBe("known");
		expect(body.data.account?.usageThrottledUntil).not.toBeNull();
		expect(body.data.account?.usageThrottledWindows).toContain("five_hour");
		expect(body.data.account?.paused).toBe(false);
		expect(body.data.account?.rateLimitedUntil).toBeNull();
	});

	it("returns unknown when the mapping points at a since-deleted account", async () => {
		recordServedAccount(SESSION, "deleted-account-id");
		const handler = createSessionAccountHandler(
			makeDbOps([makeAccount({ id: "some-other-account" })]),
			makeConfig(),
		);
		const res = await handler(SESSION);
		expect(res.status).toBe(200);

		const body = (await res.json()) as SessionAccountBody;
		expect(body.data.status).toBe("unknown");
	});

	it("returns 400 for an empty or whitespace session id", async () => {
		const handler = createSessionAccountHandler(
			makeDbOps([makeAccount()]),
			makeConfig(),
		);
		expect((await handler("")).status).toBe(400);
		expect((await handler("   ")).status).toBe(400);
	});
});

describe("session-account endpoint auth exemption", () => {
	const auth = new AuthService({} as unknown as DatabaseOperations);

	it("exempts exactly GET /api/sessions/:id/account (KTD-3)", () => {
		expect(auth.isStaticPathExempt("/api/sessions/abc123/account", "GET")).toBe(
			true,
		);
		// No method supplied still resolves to the GET exemption (back-compat).
		expect(auth.isStaticPathExempt("/api/sessions/abc123/account")).toBe(true);
	});

	it("does NOT exempt non-GET methods on the account route", () => {
		// Critical: a POST here would pass auth, fail to match the GET-only route,
		// and fall through to the upstream proxy — an unauthenticated bypass.
		expect(
			auth.isStaticPathExempt("/api/sessions/abc123/account", "POST"),
		).toBe(false);
		expect(
			auth.isStaticPathExempt("/api/sessions/abc123/account", "DELETE"),
		).toBe(false);
	});

	it("does NOT exempt structurally different /api/sessions/ paths", () => {
		// Extra segments (would not match the router's 5-segment route).
		expect(auth.isStaticPathExempt("/api/sessions/a/b/account", "GET")).toBe(
			false,
		);
		// A future write endpoint under the namespace must make its own decision.
		expect(auth.isStaticPathExempt("/api/sessions/abc123/pin", "GET")).toBe(
			false,
		);
		expect(auth.isStaticPathExempt("/api/sessions/", "GET")).toBe(false);
	});
});
