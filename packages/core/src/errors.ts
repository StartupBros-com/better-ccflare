/**
 * Custom error classes for standardized error handling across the application
 */

import { MAX_OAUTH_ERROR_INPUT_LENGTH } from "./oauth-response";

/**
 * Base error class for all application errors
 */
export abstract class AppError extends Error {
	public readonly timestamp: Date;
	public readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode: number,
		context?: Record<string, unknown>,
	) {
		super(message);
		this.name = this.constructor.name;
		this.timestamp = new Date();
		this.context = context;
		Error.captureStackTrace(this, this.constructor);
	}

	toJSON() {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			statusCode: this.statusCode,
			timestamp: this.timestamp,
			context: this.context,
		};
	}
}

/**
 * Authentication and authorization errors
 */
export class AuthError extends AppError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "AUTH_ERROR", 401, context);
	}
}

export class TokenRefreshError extends AuthError {
	constructor(accountId: string, originalError?: Error) {
		super("Failed to refresh access token", {
			accountId,
			originalError: originalError?.message,
		});
	}
}

/**
 * Canonical `pause_reason` value for an account whose OAuth refresh token was
 * rejected by the provider (terminal, needs re-authentication, will not
 * self-heal). Auto-cleared by a successful reauth. Kept here so producers
 * (token refresh) and consumers (oauth-flow resume, HTTP API) agree on the
 * exact string.
 */
export const PAUSE_REASON_NEEDS_REAUTH = "oauth_invalid_grant";

/**
 * Canonical error `code` returned by the Resume endpoint/CLI when a resume
 * is refused because the account is paused for PAUSE_REASON_NEEDS_REAUTH
 * (R23). Kept here, next to PAUSE_REASON_NEEDS_REAUTH, so producers
 * (cli-commands account.ts's toggleAccountPause) and consumers (the
 * http-api resume handler, and any future client) agree on the exact
 * string instead of each hardcoding their own copy of the literal.
 */
export const REAUTHENTICATION_REQUIRED_CODE = "reauthentication_required";

/**
 * Terminal OAuth markers returned by a token endpoint when a refresh token has
 * been revoked, rotated, or invalidated. These are NOT retryable network
 * conditions, the only fix is re-authentication.
 */
const INVALID_GRANT_MARKERS = [
	"invalid_grant",
	"invalid_refresh_token",
	// Codex uses rotating refresh tokens; a reused/rotated token is terminal and
	// equally requires re-authentication.
	"refresh_token_reused",
	"refresh token not found or invalid",
	"oauth authentication is currently not supported",
] as const;

const MAX_OAUTH_ERROR_MESSAGE_LENGTH = 1024;
// Do not parse arbitrarily large provider error bodies. The response has
// already been bounded by the provider's fetch path where possible, but this
// helper is also called on caught/forwarded values from shared refresh code.

const INVALID_GRANT_CODES = new Set<string>(INVALID_GRANT_MARKERS);

function boundedOAuthText(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text.slice(0, MAX_OAUTH_ERROR_MESSAGE_LENGTH);
}

function parseOAuthErrorValue(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (text.length > MAX_OAUTH_ERROR_INPUT_LENGTH) return "";
	if (!text.startsWith("{") && !text.startsWith("[")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Extract a bounded, machine-code-first message from an OAuth error payload.
 * OAuth implementations disagree about whether the error is a string, an
 * RFC-6749 object, or a nested provider object. Only well-known error fields
 * are admitted; stringifying an entire payload can lose codes or leak tokens.
 */
export function formatOAuthErrorMessage(input: unknown): string {
	const parsed = parseOAuthErrorValue(input);
	if (typeof parsed === "string") return boundedOAuthText(parsed);
	if (typeof parsed !== "object" || parsed === null) return "";

	const root = parsed as Record<string, unknown>;
	const nestedValue = parseOAuthErrorValue(root.error);
	const nested =
		typeof nestedValue === "object" && nestedValue !== null
			? (nestedValue as Record<string, unknown>)
			: undefined;
	const read = (...values: unknown[]): string => {
		for (const value of values) {
			const text = boundedOAuthText(value);
			if (text) return text;
		}
		return "";
	};

	const code = read(
		nested?.error_code,
		nested?.code,
		nested?.type,
		nested?.error,
		root.error_code,
		root.code,
		root.type,
		typeof nestedValue === "string" ? nestedValue : undefined,
		typeof root.error === "string" ? root.error : undefined,
	);
	const description = read(
		nested?.error_description,
		nested?.message,
		nested?.detail,
		nested?.description,
		root.error_description,
		root.message,
		root.detail,
		root.description,
	);

	return boundedOAuthText([code, description].filter(Boolean).join(": "));
}

/**
 * Return only a machine-readable terminal OAuth code from a structured
 * payload. Human descriptions are intentionally excluded from this helper so
 * an incidental mention of `invalid_grant` cannot quarantine an account.
 */
export function getOAuthErrorCode(input: unknown): string {
	const parsed = parseOAuthErrorValue(input);
	if (typeof parsed !== "object" || parsed === null) return "";
	const root = parsed as Record<string, unknown>;
	const nestedValue = parseOAuthErrorValue(root.error);
	const nested =
		typeof nestedValue === "object" && nestedValue !== null
			? (nestedValue as Record<string, unknown>)
			: undefined;
	const candidates = [
		nested?.error_code,
		nested?.code,
		nested?.type,
		root.error_code,
		root.code,
		root.type,
		typeof nestedValue === "string" ? nestedValue : undefined,
		typeof root.error === "string" ? root.error : undefined,
	];
	for (const candidate of candidates) {
		const code = boundedOAuthText(candidate).toLowerCase();
		if (INVALID_GRANT_CODES.has(code)) return code;
	}
	return "";
}

/** True only for an explicit structured terminal OAuth machine code. */
export function isStructuredInvalidGrant(input: unknown): boolean {
	return Boolean(getOAuthErrorCode(input));
}

/** True only when a non-JSON provider body is exactly a terminal OAuth code. */
export function isExactInvalidGrantMessage(input: unknown): boolean {
	if (typeof input !== "string") return false;
	if (input.length > MAX_OAUTH_ERROR_INPUT_LENGTH) return false;
	const normalized = input
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return INVALID_GRANT_CODES.has(normalized);
}

/**
 * Return the terminal OAuth marker only when a raw response is exactly one of
 * the known machine codes. This is intentionally separate from
 * `getOAuthErrorCode`, which only accepts structured payload fields; callers
 * must also prove that the response was not truncated before using this value.
 */
export function getExactOAuthErrorCode(input: unknown): string {
	if (!isExactInvalidGrantMessage(input)) return "";
	return (input as string)
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * True when an OAuth token-refresh error message/body indicates the refresh
 * token itself was rejected (terminal, needs reauth). Case-insensitive; pass
 * either the parsed error description or the raw response body, since some
 * providers return a non-JSON body that never reaches the parsed message.
 */
export function isInvalidGrantMessage(
	message: string | null | undefined,
): boolean {
	if (!message) return false;
	const lower = message.toLowerCase();
	return INVALID_GRANT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Thrown by a provider's `refreshToken` when the OAuth token endpoint rejects
 * the refresh token (e.g. HTTP 400/401 `invalid_grant`). Distinct, typed error
 * so callers can pause the account for re-auth instead of treating it as a
 * generic/transient refresh failure. Extends `AppError` directly (not
 * `AuthError`, which hardcodes the `AUTH_ERROR` code) to carry its own code.
 */
export class OAuthRefreshTokenError extends AppError {
	constructor(
		public readonly accountId: string,
		message = "OAuth refresh token rejected, re-authentication required",
	) {
		super(message, "OAUTH_INVALID_GRANT", 401, { accountId });
	}
}

/**
 * Rate limiting errors
 */
export class RateLimitError extends AppError {
	constructor(
		public readonly accountId: string,
		public readonly resetTime: number,
		public readonly remaining?: number,
	) {
		super("Rate limit exceeded", "RATE_LIMIT_ERROR", 429, {
			accountId,
			resetTime,
			remaining,
		});
	}
}

/**
 * Validation errors
 */
export class ValidationError extends AppError {
	constructor(
		message: string,
		public readonly field?: string,
		public readonly value?: unknown,
	) {
		super(message, "VALIDATION_ERROR", 400, { field, value });
	}
}

/**
 * Provider errors
 */
export class ProviderError extends AppError {
	constructor(
		message: string,
		public readonly provider: string,
		statusCode = 502,
		context?: Record<string, unknown>,
	) {
		super(message, "PROVIDER_ERROR", statusCode, { provider, ...context });
	}
}

export class OAuthError extends ProviderError {
	constructor(
		message: string,
		provider: string,
		public readonly oauthCode?: string,
	) {
		super(message, provider, 400, { oauthCode });
	}
}

/**
 * Service unavailable errors
 */
export class ServiceUnavailableError extends AppError {
	constructor(
		message: string,
		public readonly service?: string,
	) {
		super(message, "SERVICE_UNAVAILABLE", 503, { service });
	}
}

/**
 * Type guards
 */
export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

/**
 * Error logger that sanitizes sensitive data
 */
export function logError(
	error: unknown,
	logger: { error: (msg: string, ...args: unknown[]) => void },
): void {
	if (isAppError(error)) {
		// Sanitize sensitive context data
		const sanitizedContext = error.context
			? sanitizeErrorContext(error.context)
			: undefined;
		logger.error(`${error.name}: ${error.message}`, {
			code: error.code,
			statusCode: error.statusCode,
			context: sanitizedContext,
		});
	} else if (error instanceof Error) {
		logger.error(`Error: ${error.message}`, {
			name: error.name,
			stack: error.stack,
		});
	} else {
		logger.error("Unknown error", error);
	}
}

/**
 * Sanitize error context to remove sensitive data
 */
function sanitizeErrorContext(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	const sensitiveKeys = ["token", "password", "secret", "key", "authorization"];

	for (const [key, value] of Object.entries(context)) {
		const lowerKey = key.toLowerCase();
		if (sensitiveKeys.some((sensitive) => lowerKey.includes(sensitive))) {
			sanitized[key] = "[REDACTED]";
		} else if (typeof value === "object" && value !== null) {
			sanitized[key] = sanitizeErrorContext(value as Record<string, unknown>);
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}
