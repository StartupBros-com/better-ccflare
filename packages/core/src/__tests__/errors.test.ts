import { describe, expect, it } from "bun:test";
import {
	formatOAuthErrorMessage,
	getExactOAuthErrorCode,
	isExactInvalidGrantMessage,
	isInvalidGrantMessage,
	isStructuredInvalidGrant,
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
	ProviderError,
	ValidationError,
} from "../errors";

import {
	safeJsonParse,
	validateArray,
	validateEndpointUrl,
	validateObject,
} from "../validation";

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
		expect(isExactInvalidGrantMessage("invalid_grant")).toBe(true);
		expect(isExactInvalidGrantMessage("provider mentioned invalid_grant")).toBe(
			false,
		);
	});

	it("normalizes bounded whitespace and control characters for exact codes", () => {
		expect(isExactInvalidGrantMessage("\u0000  INVALID_GRANT\r\n")).toBe(true);
		expect(getExactOAuthErrorCode("\u0000  INVALID_GRANT\r\n")).toBe(
			"invalid_grant",
		);
		expect(getExactOAuthErrorCode("provider mentioned invalid_grant")).toBe("");
	});

	it("rejects oversized exact-code bodies before normalization", () => {
		const oversized = `${" ".repeat(64 * 1024)}invalid_grant`;
		expect(isExactInvalidGrantMessage(oversized)).toBe(false);
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
	it("carries the OAUTH_INVALID_GRANT code, accountId, and default reason", () => {
		const err = new OAuthRefreshTokenError("acct-1");
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("OAUTH_INVALID_GRANT");
		expect(err.statusCode).toBe(401);
		expect(err.accountId).toBe("acct-1");
		expect(err.oauthErrorCode).toBe("invalid_grant");
	});

	it("preserves a validated terminal OAuth machine code", () => {
		const err = new OAuthRefreshTokenError(
			"acct-1",
			"refresh token reused",
			"refresh_token_reused",
		);
		expect(err.oauthErrorCode).toBe("refresh_token_reused");
		expect(err.context).toMatchObject({
			accountId: "acct-1",
			oauthErrorCode: "refresh_token_reused",
		});
	});

	it("falls back when an unrecognized reason is supplied", () => {
		const err = new OAuthRefreshTokenError(
			"acct-1",
			"provider error",
			"untrusted_provider_text",
		);
		expect(err.oauthErrorCode).toBe("invalid_grant");
		expect(err.context).toMatchObject({ oauthErrorCode: "invalid_grant" });
	});
});

describe("PAUSE_REASON_NEEDS_REAUTH", () => {
	it("is the stable oauth_invalid_grant string", () => {
		expect(PAUSE_REASON_NEEDS_REAUTH).toBe("oauth_invalid_grant");
	});
});

describe("error cause preservation", () => {
	it("preserves a cause without changing AppError JSON or context", () => {
		const cause = new Error("private diagnostic");
		const validation = new ValidationError("invalid", "field", 42, { cause });
		const provider = new ProviderError(
			"upstream failed",
			"provider",
			502,
			{ attempt: 1 },
			{ cause },
		);
		for (const error of [validation, provider]) {
			expect(error.cause).toBe(cause);
			expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(
				false,
			);
			expect(error.toJSON()).not.toHaveProperty("cause");
			expect(JSON.stringify(error)).not.toContain("private diagnostic");
		}
		expect(validation.context).toEqual({ field: "field", value: 42 });
		expect(provider.context).toEqual({ provider: "provider", attempt: 1 });
		expect(new ValidationError("legacy").cause).toBeUndefined();
	});

	it("retains the exact child validation error when adding array or object context", () => {
		const cause = new ValidationError("bad child");
		const rejectChild = () => {
			throw cause;
		};
		for (const run of [
			() => validateArray([1], "items", { itemValidator: rejectChild }),
			() =>
				validateObject({ item: 1 }, "record", {
					schema: { item: rejectChild },
				}),
		]) {
			let caught: unknown;
			try {
				run();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ValidationError);
			expect((caught as Error).cause).toBe(cause);
		}
	});

	it("retains actual JSON and URL parser failures", () => {
		for (const [run, type] of [
			[() => safeJsonParse("{"), SyntaxError],
			[() => validateEndpointUrl("http://[invalid"), TypeError],
		] as const) {
			let caught: unknown;
			try {
				run();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ValidationError);
			expect((caught as Error).cause).toBeInstanceOf(type);
		}
	});
});
