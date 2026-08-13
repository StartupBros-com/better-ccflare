/**
 * Anthropic OAuth token refresh must throw a typed OAuthRefreshTokenError when
 * the token endpoint rejects the refresh token (invalid_grant and friends),
 * regardless of HTTP status code — Anthropic returns HTTP 400 for invalid_grant,
 * not 401 — so detection cannot be gated on status.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
	MAX_OAUTH_ERROR_INPUT_LENGTH,
	OAuthRefreshTokenError,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "../provider";

function mockFetchOnce(response: {
	ok: boolean;
	status: number;
	statusText: string;
	text: () => Promise<string>;
	headers?: HeadersInit;
}) {
	const originalFetch = globalThis.fetch;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(new TextEncoder().encode(await response.text()));
			controller.close();
		},
	});
	const fullResponse = {
		...response,
		headers: new Headers(response.headers),
		body,
	};
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
	it("never emits OAuth refresh-token material through debug diagnostics", async () => {
		const refreshToken = "oauth-refresh-secret-SENTINEL-do-not-log-0123456789";
		const debugCalls: unknown[][] = [];
		const debug = spyOn(Logger.prototype, "debug").mockImplementation(
			(message, data) => debugCalls.push([message, data]),
		);
		const restoreFetch = mockFetchOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: async () => "Internal Server Error",
			headers: {
				"content-type": "text/plain",
				"retry-after": "7",
				"set-cookie": "oauth-secret-cookie=do-not-log",
				authorization: "Bearer oauth-secret-header",
			},
		});

		try {
			const provider = new AnthropicProvider();
			await expect(
				provider.refreshToken(
					makeAccount({ refresh_token: refreshToken }),
					"test-client",
				),
			).rejects.toBeInstanceOf(Error);

			const diagnostics = JSON.stringify(debugCalls);
			expect(diagnostics).not.toContain(refreshToken);
			expect(diagnostics).not.toContain("oauth-refresh-secret-SENTINEL");
			expect(diagnostics).not.toContain("oauth-secret-cookie");
			expect(diagnostics).not.toContain("oauth-secret-header");
			expect(diagnostics).toContain("contentType");
			expect(diagnostics).toContain("retryAfter");
		} finally {
			debug.mockRestore();
			restoreFetch();
		}
	});

	it("does not interpolate an untrusted HTTP status text into debug diagnostics", async () => {
		const statusText = "provider-status\ncredential-like=oauth-secret\r\n";
		const debugCalls: unknown[][] = [];
		const debug = spyOn(Logger.prototype, "debug").mockImplementation(
			(message, data) => debugCalls.push([message, data]),
		);
		const restoreFetch = mockFetchOnce({
			ok: false,
			status: 503,
			statusText,
			text: async () => "temporarily unavailable",
			headers: { "content-type": "text/plain" },
		});

		try {
			const provider = new AnthropicProvider();
			await expect(
				provider.refreshToken(makeAccount(), "test-client"),
			).rejects.toBeInstanceOf(Error);

			const diagnostics = JSON.stringify(debugCalls);
			expect(diagnostics).not.toContain(statusText);
			expect(diagnostics).not.toContain("credential-like=oauth-secret");
			expect(diagnostics).toContain("Response status: 503");
		} finally {
			debug.mockRestore();
			restoreFetch();
		}
	});

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

	it("rejects an oversized successful token payload before accepting it", async () => {
		const payload = `${JSON.stringify({
			access_token: "new-access-token",
			expires_in: 3600,
		})}${" ".repeat(MAX_OAUTH_ERROR_INPUT_LENGTH)}trailing-data`;
		const restore = mockFetchOnce({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => payload,
		});
		try {
			const provider = new AnthropicProvider();
			await expect(
				provider.refreshToken(makeAccount(), "test-client"),
			).rejects.toThrow(/exceeded/);
		} finally {
			restore();
		}
	});

	it("rejects a successful response that omits the access token", async () => {
		const restore = mockFetchOnce({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => JSON.stringify({ expires_in: 3600 }),
		});
		try {
			const provider = new AnthropicProvider();
			await expect(
				provider.refreshToken(makeAccount(), "test-client"),
			).rejects.toThrow(/did not include an access token/);
		} finally {
			restore();
		}
	});
});
