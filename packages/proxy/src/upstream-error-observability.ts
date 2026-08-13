/**
 * Privacy-safe, bounded metadata for an upstream error response.
 *
 * This module intentionally does not retain or return provider messages, body
 * text, headers, account names, or request content. It is used by the response
 * handler's diagnostic log path only; callers keep the original response bytes
 * and status untouched.
 */

export const MAX_UPSTREAM_ERROR_OBSERVATION_BYTES = 64 * 1024;

const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface UpstreamErrorTelemetry {
	errorType?: string;
	errorCode?: string;
	/** HTTP status received from the upstream transport. */
	upstreamStatus: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeType(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_ERROR_TYPE.test(value)
		? value
		: undefined;
}

function safeCode(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_ERROR_CODE.test(value)
		? value
		: undefined;
}

function boundedBodyText(body: string | Uint8Array): string | undefined {
	if (typeof body === "string") {
		const bytes = new TextEncoder().encode(body);
		if (bytes.byteLength > MAX_UPSTREAM_ERROR_OBSERVATION_BYTES)
			return undefined;
		return body;
	}
	if (body.byteLength > MAX_UPSTREAM_ERROR_OBSERVATION_BYTES) return undefined;
	try {
		return new TextDecoder().decode(body);
	} catch {
		return undefined;
	}
}

/**
 * Extract only safe categorical fields from a bounded JSON error envelope.
 *
 * A 403 always returns a status-only record, even when the body is empty or
 * non-JSON. This makes an authorization denial observable without guessing at
 * a provider code. Other statuses return null because this slice is scoped to
 * non-streaming 403 diagnostics.
 */
export function extractUpstreamErrorTelemetry(
	body: string | Uint8Array | null | undefined,
	upstreamStatus: number,
): UpstreamErrorTelemetry | null {
	if (upstreamStatus !== 403) return null;

	let errorType: string | undefined;
	let errorCode: string | undefined;
	const text = body == null ? undefined : boundedBodyText(body);
	if (text !== undefined) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (isRecord(parsed)) {
				// Anthropic/Codex error envelopes use { error: { ... } }; a few
				// OpenAI-compatible endpoints return the same fields at the root.
				const hasNestedError = isRecord(parsed.error);
				const nested: Record<string, unknown> = hasNestedError
					? (parsed.error as Record<string, unknown>)
					: parsed;
				errorType = safeType(nested.type);
				// A root `{type:"error"}` is the envelope discriminator, not a
				// useful provider error type. Do not turn that generic wrapper into
				// misleading telemetry when the nested object is absent.
				if (!hasNestedError && errorType === "error") errorType = undefined;
				errorCode = safeCode(nested.code);
			}
		} catch {
			// Status-only telemetry is still useful for a plain-text or malformed
			// provider denial. Never log a parse error or body prefix.
		}
	}

	return {
		...(errorType ? { errorType } : {}),
		...(errorCode ? { errorCode } : {}),
		upstreamStatus,
	};
}
