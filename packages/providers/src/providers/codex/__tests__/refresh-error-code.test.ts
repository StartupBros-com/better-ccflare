import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	MAX_OAUTH_ERROR_INPUT_LENGTH,
	OAuthRefreshTokenError,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { CodexProvider } from "../provider";

function codexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "expired-access-token",
		expires_at: 1,
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
		requires_reauth: false,
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

describe("CodexProvider.refreshToken preserves the OAuth error code", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps invalid_grant when only error_description is human-readable", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "The refresh token has expired.",
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		expect(thrown?.message).toContain("invalid_grant");
	});

	it("carries the refresh_token_reused marker verbatim on token rotation reuse", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ error: "refresh_token_reused" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		let thrown: Error | null = null;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error as Error;
		}

		// The reused case must keep the machine marker so detection fires; the
		// friendly re-auth hint alone ("token was reused") would not match.
		expect(thrown?.message).toContain("refresh_token_reused");
	});

	it("does not classify refresh_token_reused from a truncated response", async () => {
		const provider = new CodexProvider();
		const prefix = JSON.stringify({
			error: "refresh_token_reused",
			error_description: "credential-like-description-must-not-leak",
		});
		const body = `${prefix}${" ".repeat(MAX_OAUTH_ERROR_INPUT_LENGTH - prefix.length)}trailing-data`;
		globalThis.fetch = mock(
			async () =>
				new Response(body, {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		let thrown: unknown;
		try {
			await provider.refreshToken(codexAccount(), "test-client");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(OAuthRefreshTokenError);
		expect((thrown as Error).message).not.toContain("refresh_token_reused");
		expect((thrown as Error).message).not.toContain(
			"credential-like-description-must-not-leak",
		);
	});

	it("classifies an exact non-JSON invalid_grant body as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(" \r\ninvalid_grant\u0000\t ", {
					status: 400,
					statusText: "Bad Request",
				}),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("classifies a nested structured invalid_grant response as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "invalid_grant",
							message: "The refresh token has expired.",
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("classifies a nested type-based invalid_grant response as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: { type: "invalid_grant", message: "expired" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.toBeInstanceOf(OAuthRefreshTokenError);
	});

	it("does not classify an incidental invalid_grant mention as terminal", async () => {
		const provider = new CodexProvider();
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						error: { message: "provider mentioned invalid_grant in prose" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		await expect(
			provider.refreshToken(codexAccount(), "test-client"),
		).rejects.not.toBeInstanceOf(OAuthRefreshTokenError);
	});
});
