// Re-export core errors that are available
export {
	OAuthError,
	ProviderError,
	RateLimitError,
	ServiceUnavailableError,
	TokenRefreshError,
	ValidationError,
} from "@better-ccflare/core";

// Error type constants
export const ERROR_TYPES = {
	NETWORK: "network",
	AUTH: "auth",
	RATE_LIMIT: "rate-limit",
	VALIDATION: "validation",
	SERVER: "server",
	UNKNOWN: "unknown",
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];

// HTTP error class for API responses
export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "HttpError";
	}
}

// Common HTTP error factories
export const BadRequest = (message: string, details?: unknown) =>
	new HttpError(400, message, details);

export const Unauthorized = (message: string, details?: unknown) =>
	new HttpError(401, message, details);

export const Forbidden = (message: string, details?: unknown) =>
	new HttpError(403, message, details);

export const NotFound = (message: string, details?: unknown) =>
	new HttpError(404, message, details);

export const Conflict = (message: string, details?: unknown) =>
	new HttpError(409, message, details);

export const UnprocessableEntity = (message: string, details?: unknown) =>
	new HttpError(422, message, details);

export const TooManyRequests = (message: string, details?: unknown) =>
	new HttpError(429, message, details);

export const InternalServerError = (message: string, details?: unknown) =>
	new HttpError(500, message, details);

export const BadGateway = (message: string, details?: unknown) =>
	new HttpError(502, message, details);

export const ServiceUnavailable = (message: string, details?: unknown) =>
	new HttpError(503, message, details);

export const GatewayTimeout = (message: string, details?: unknown) =>
	new HttpError(504, message, details);

// Ordered by classification precedence; the first matching group wins.
const ERROR_MESSAGE_PATTERNS = [
	[
		ERROR_TYPES.NETWORK,
		["network", "fetch failed", "connection", "econnrefused"],
	],
	[ERROR_TYPES.AUTH, ["unauthorized", "authentication", "401", "token"]],
	[ERROR_TYPES.RATE_LIMIT, ["rate limit", "too many requests", "429"]],
	[ERROR_TYPES.VALIDATION, ["validation", "invalid", "bad request"]],
	[ERROR_TYPES.SERVER, ["server error", "500", "502", "503", "504"]],
] as const;

// Error type detection
export function getErrorType(error: unknown): ErrorType {
	if (error instanceof HttpError) {
		if (error.status === 401) return ERROR_TYPES.AUTH;
		if (error.status === 429) return ERROR_TYPES.RATE_LIMIT;
		if (error.status >= 400 && error.status < 500)
			return ERROR_TYPES.VALIDATION;
		if (error.status >= 500) return ERROR_TYPES.SERVER;
	}

	if (error instanceof Error) {
		const message = error.message.toLowerCase();

		for (const [type, patterns] of ERROR_MESSAGE_PATTERNS) {
			if (patterns.some((pattern) => message.includes(pattern))) {
				return type;
			}
		}
	}

	return ERROR_TYPES.UNKNOWN;
}

// Error type checkers
export const isNetworkError = (error: unknown): boolean =>
	getErrorType(error) === ERROR_TYPES.NETWORK;

export const isAuthError = (error: unknown): boolean =>
	getErrorType(error) === ERROR_TYPES.AUTH;

export const isRateLimitError = (error: unknown): boolean =>
	getErrorType(error) === ERROR_TYPES.RATE_LIMIT;

export const isValidationError = (error: unknown): boolean =>
	getErrorType(error) === ERROR_TYPES.VALIDATION;

export const isServerError = (error: unknown): boolean =>
	getErrorType(error) === ERROR_TYPES.SERVER;

// Default error messages
const DEFAULT_ERROR_MESSAGES: Record<ErrorType, string> = {
	[ERROR_TYPES.NETWORK]:
		"Network error. Please check your connection and try again.",
	[ERROR_TYPES.AUTH]: "Authentication failed. Please sign in again.",
	[ERROR_TYPES.RATE_LIMIT]: "Too many requests. Please try again later.",
	[ERROR_TYPES.VALIDATION]: "Invalid request. Please check your input.",
	[ERROR_TYPES.SERVER]: "Server error. Please try again later.",
	[ERROR_TYPES.UNKNOWN]: "An unexpected error occurred.",
};

// Error formatting options
export interface ErrorFormatterOptions {
	defaultMessage?: string;
	errorMap?: Record<string, string>;
	includeDetails?: boolean;
}

// Format error for user display
export function formatError(
	error: unknown,
	options: ErrorFormatterOptions = {},
): string {
	const {
		defaultMessage = DEFAULT_ERROR_MESSAGES[ERROR_TYPES.UNKNOWN],
		errorMap = {},
		includeDetails = false,
	} = options;

	// Handle null/undefined
	if (error == null) {
		return defaultMessage;
	}

	// Handle Error instances
	if (error instanceof Error) {
		const message = error.message;

		// Check error map for custom messages
		for (const [key, value] of Object.entries(errorMap)) {
			if (message.includes(key)) {
				return value;
			}
		}

		// Get error type and use default message if appropriate
		const errorType = getErrorType(error);
		const defaultTypeMessage = DEFAULT_ERROR_MESSAGES[errorType];

		// For known error types, prefer the default message unless includeDetails is true
		if (errorType !== ERROR_TYPES.UNKNOWN && !includeDetails) {
			return defaultTypeMessage;
		}

		// Return the actual error message
		return message;
	}

	// Handle string errors
	if (typeof error === "string") {
		return error;
	}

	// Handle objects with message property
	if (typeof error === "object" && error !== null && "message" in error) {
		return String(error.message);
	}

	// Fallback
	return defaultMessage;
}

// Parse HTTP response error
export async function parseHttpError(response: Response): Promise<HttpError> {
	let message = `HTTP ${response.status}: ${response.statusText}`;
	let details: unknown;

	try {
		const contentType = response.headers.get("content-type");
		if (contentType?.includes("application/json")) {
			const data = await response.json();
			if (data.error) {
				message =
					typeof data.error === "string"
						? data.error
						: data.error.message || message;
				details = data.error;
			} else if (data.message) {
				message = data.message;
				details = data;
			}
		} else {
			const text = await response.text();
			if (text) {
				message = text;
			}
		}
	} catch {
		// Ignore parsing errors
	}

	return new HttpError(response.status, message, details);
}
