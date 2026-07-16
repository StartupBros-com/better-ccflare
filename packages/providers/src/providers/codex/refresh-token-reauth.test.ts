/**
 * Codex OAuth token refresh must throw a typed OAuthRefreshTokenError when the
 * token endpoint reports `refresh_token_reused` (Codex uses rotating refresh
 * tokens; reuse of a stale one is terminal and requires re-authentication),
 * and a plain Error for other/transient refresh failures.
 */

import { describe, expect, it } from "bun:test";
import { OAuthRefreshTokenError } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { CodexProvider } from "./provider";

function mockFetchOnce(response: {
	ok: boolean;
	status: number;
	statusText: string;
	json: () => Promise<unknown>;
}) {
	const originalFetch = globalThis.fetch;
	const fullResponse = { ...response, headers: new Headers() };
	globalThis.fetch = (async () => fullResponse) as never;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt-original",
		access_token: null,
		expires_at: null,
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
		auto_refresh_enabled: true,
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

describe("CodexProvider.refreshToken — invalid_grant detection", () => {
	it("throws OAuthRefreshTokenError for refresh_token_reused", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			json: async () => ({
				error: "refresh_token_reused",
				error_description: "Refresh token was already used",
			}),
		});
		try {
			const provider = new CodexProvider();
			const account = makeAccount();
			await expect(
				provider.refreshToken(account, "test-client"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		} finally {
			restore();
		}
	});

	it("carries the account id on the typed error", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			json: async () => ({ error: "refresh_token_reused" }),
		});
		try {
			const provider = new CodexProvider();
			const account = makeAccount({ id: "acc-codex-xyz" });
			try {
				await provider.refreshToken(account, "test-client");
				throw new Error("expected refreshToken to throw");
			} catch (err) {
				expect(err).toBeInstanceOf(OAuthRefreshTokenError);
				expect((err as OAuthRefreshTokenError).accountId).toBe("acc-codex-xyz");
			}
		} finally {
			restore();
		}
	});

	it("throws a plain Error (not OAuthRefreshTokenError) for a transient/other failure", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({ error: "server_error" }),
		});
		try {
			const provider = new CodexProvider();
			const account = makeAccount();
			let caught: unknown;
			try {
				await provider.refreshToken(account, "test-client");
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(Error);
			expect(caught).not.toBeInstanceOf(OAuthRefreshTokenError);
		} finally {
			restore();
		}
	});
});
