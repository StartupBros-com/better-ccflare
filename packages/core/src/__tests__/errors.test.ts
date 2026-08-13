import { describe, expect, it } from "bun:test";
import {
	formatOAuthErrorMessage,
	isInvalidGrantMessage,
	isStructuredInvalidGrant,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
} from "../errors";

describe("formatOAuthErrorMessage", () => {
	it("extracts machine codes from nested provider error objects", () => {
		expect(
			formatOAuthErrorMessage({
				error: {
					code: "invalid_grant",
					message: "The refresh token has expired.",
				},
				request_id: "private-request-id",
			}),
		).toBe("invalid_grant: The refresh token has expired.");
	});

	it("parses JSON strings and ignores unrelated fields", () => {
		expect(
			formatOAuthErrorMessage(
				'{"error":{"error_code":"refresh_token_reused","detail":"rotate"},"token":"secret"}',
			),
		).toBe("refresh_token_reused: rotate");
		expect(formatOAuthErrorMessage({ status: 400, request_id: "id" })).toBe("");
	});

	it("accepts provider type as the machine-readable code", () => {
		expect(
			formatOAuthErrorMessage({
				error: { type: "invalid_grant", message: "expired" },
			}),
		).toBe("invalid_grant: expired");
	});

	it("bounds extracted text", () => {
		const message = "x".repeat(10_000);
		expect(
			formatOAuthErrorMessage({ error: { message } }).length,
		).toBeLessThanOrEqual(1024);
	});

	it("does not parse oversized JSON or preserve log control characters", () => {
		const oversized = `{"error":{"code":"invalid_grant","message":"${"x".repeat(70_000)}"}}`;
		expect(formatOAuthErrorMessage(oversized)).toBe("");
		expect(
			formatOAuthErrorMessage({
				error: { code: "invalid_grant", message: "line\r\nnext\u0000" },
			}),
		).toBe("invalid_grant: line next");
	});

	it("requires a machine code before treating a structured payload as terminal", () => {
		expect(
			isStructuredInvalidGrant({
				error: { message: "provider mentioned invalid_grant in prose" },
			}),
		).toBe(false);
		expect(isStructuredInvalidGrant({ error: { code: "invalid_grant" } })).toBe(
			true,
		);
	});
});

describe("isInvalidGrantMessage", () => {
	it("matches the terminal OAuth markers (case-insensitive)", () => {
		const positives = [
			"invalid_grant",
			'{"error":"invalid_grant","error_description":"..."}',
			"INVALID_GRANT",
			"invalid_refresh_token",
			"refresh_token_reused",
			"Refresh token not found or invalid",
			"refresh token NOT FOUND or invalid",
			"OAuth authentication is currently not supported",
		];
		for (const msg of positives) {
			expect(isInvalidGrantMessage(msg)).toBe(true);
		}
	});

	it("does not match transient / non-auth failures", () => {
		const negatives = [
			"Internal Server Error",
			"500",
			"fetch failed",
			"ETIMEDOUT",
			"rate limit exceeded",
			"Service Unavailable",
			"",
			null,
			undefined,
		];
		for (const msg of negatives) {
			expect(isInvalidGrantMessage(msg)).toBe(false);
		}
	});
});

describe("OAuthRefreshTokenError", () => {
	it("carries the OAUTH_INVALID_GRANT code and accountId", () => {
		const err = new OAuthRefreshTokenError("acct-1");
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("OAUTH_INVALID_GRANT");
		expect(err.statusCode).toBe(401);
		expect(err.accountId).toBe("acct-1");
	});
});

describe("PAUSE_REASON_NEEDS_REAUTH", () => {
	it("is the stable oauth_invalid_grant string", () => {
		expect(PAUSE_REASON_NEEDS_REAUTH).toBe("oauth_invalid_grant");
	});
});
