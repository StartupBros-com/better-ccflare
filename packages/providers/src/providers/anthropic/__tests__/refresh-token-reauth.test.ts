/**
 * Anthropic OAuth token refresh must throw a typed OAuthRefreshTokenError when
 * the token endpoint rejects the refresh token (invalid_grant and friends),
 * regardless of HTTP status code — Anthropic returns HTTP 400 for invalid_grant,
 * not 401 — so detection cannot be gated on status.
 */

import { describe, expect, it } from "bun:test";
import { OAuthRefreshTokenError } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "../provider";

function mockFetchOnce(response: {
	ok: boolean;
	status: number;
	statusText: string;
	text: () => Promise<string>;
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
		name: "test-account",
		provider: "anthropic",
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

describe("AnthropicProvider.refreshToken — invalid_grant detection", () => {
	it("throws OAuthRefreshTokenError for HTTP 400 invalid_grant (not gated on 401)", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			text: async () =>
				JSON.stringify({
					error: "invalid_grant",
					error_description: "Refresh token is invalid",
				}),
		});
		try {
			const provider = new AnthropicProvider();
			const account = makeAccount();
			await expect(
				provider.refreshToken(account, "test-client"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		} finally {
			restore();
		}
	});

	it("throws OAuthRefreshTokenError for HTTP 401 invalid_refresh_token", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: async () => JSON.stringify({ error: "invalid_refresh_token" }),
		});
		try {
			const provider = new AnthropicProvider();
			const account = makeAccount();
			await expect(
				provider.refreshToken(account, "test-client"),
			).rejects.toBeInstanceOf(OAuthRefreshTokenError);
		} finally {
			restore();
		}
	});

	it("throws a plain Error (not OAuthRefreshTokenError) for a transient 500", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: async () => "Internal Server Error",
		});
		try {
			const provider = new AnthropicProvider();
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

	it("carries the account id on the typed error", async () => {
		const restore = mockFetchOnce({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			text: async () => JSON.stringify({ error: "invalid_grant" }),
		});
		try {
			const provider = new AnthropicProvider();
			const account = makeAccount({ id: "acc-xyz" });
			try {
				await provider.refreshToken(account, "test-client");
				throw new Error("expected refreshToken to throw");
			} catch (err) {
				expect(err).toBeInstanceOf(OAuthRefreshTokenError);
				expect((err as OAuthRefreshTokenError).accountId).toBe("acc-xyz");
			}
		} finally {
			restore();
		}
	});
});
