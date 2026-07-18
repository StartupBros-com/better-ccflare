const MAX_SAFE_ERROR_TYPE_LENGTH = 64;
const SAFE_ERROR_TYPE = /^[A-Za-z0-9._:-]+$/;

export const ANTHROPIC_TRANSIENT_SSE_ERROR_TYPES = [
	"overloaded_error",
	"rate_limit_error",
	"api_error",
] as const;

export type AnthropicTransientSseErrorType =
	(typeof ANTHROPIC_TRANSIENT_SSE_ERROR_TYPES)[number];

const transientErrorTypes = new Set<string>(
	ANTHROPIC_TRANSIENT_SSE_ERROR_TYPES,
);

export type AnthropicSseFrameKind =
	| "keepalive"
	| "structural"
	| "meaningful"
	| "terminal_delta"
	| "message_stop"
	| "error"
	| "malformed"
	| "unknown";

export interface AnthropicSseFrameClassification {
	kind: AnthropicSseFrameKind;
	/** Sanitized nested `error.type`; upstream messages are never retained. */
	errorType?: string;
	transientErrorType?: AnthropicTransientSseErrorType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function safeErrorType(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_SAFE_ERROR_TYPE_LENGTH ||
		!SAFE_ERROR_TYPE.test(value)
	) {
		return undefined;
	}
	return value;
}

function classifyContentDelta(
	parsed: Record<string, unknown>,
): AnthropicSseFrameKind {
	if (!isRecord(parsed.delta)) return "malformed";
	const deltaType =
		typeof parsed.delta.type === "string" ? parsed.delta.type : undefined;
	if (!deltaType) return "malformed";

	switch (deltaType) {
		case "text_delta":
			return typeof parsed.delta.text === "string" &&
				parsed.delta.text.length > 0
				? "meaningful"
				: "structural";
		case "thinking_delta":
			return typeof parsed.delta.thinking === "string" &&
				parsed.delta.thinking.length > 0
				? "meaningful"
				: "structural";
		case "input_json_delta":
			return typeof parsed.delta.partial_json === "string" &&
				parsed.delta.partial_json.length > 0
				? "meaningful"
				: "structural";
		default: {
			// Future content delta types are a conservative commitment/progress
			// boundary when they carry any non-empty field. This avoids timing out a
			// valid protocol extension merely because the proxy predates it.
			const hasContent = Object.entries(parsed.delta).some(
				([key, value]) =>
					key !== "type" &&
					value !== null &&
					value !== undefined &&
					(typeof value !== "string" || value.length > 0),
			);
			return hasContent ? "meaningful" : "structural";
		}
	}
}

/**
 * Classify one already-bounded Anthropic SSE frame without retaining payload
 * text. Callers own byte/frame limits through their incremental frame buffer.
 */
export function classifyAnthropicSseFrame(
	rawFrame: string,
): AnthropicSseFrameClassification {
	let eventType: string | undefined;
	const dataLines: string[] = [];
	let hasProtocolField = false;

	for (const line of rawFrame.split(/\r?\n/)) {
		if (line.length === 0 || line.startsWith(":")) continue;

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		if (field === "event") {
			hasProtocolField = true;
			eventType = value;
		} else if (field === "data") {
			hasProtocolField = true;
			dataLines.push(value);
		}
	}

	if (!hasProtocolField) {
		const keepaliveOnly = rawFrame
			.split(/\r?\n/)
			.every((line) => line.length === 0 || line.startsWith(":"));
		return { kind: keepaliveOnly ? "keepalive" : "malformed" };
	}
	if (dataLines.length === 0) {
		return { kind: "malformed" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(dataLines.join("\n")) as unknown;
	} catch {
		return { kind: "malformed" };
	}
	if (!isRecord(parsed)) return { kind: "malformed" };

	const dataType = typeof parsed.type === "string" ? parsed.type : undefined;
	if (!dataType || (eventType !== undefined && eventType !== dataType)) {
		return { kind: "malformed" };
	}
	const resolvedType = eventType ?? dataType;

	switch (resolvedType) {
		case "ping":
			return { kind: "keepalive" };
		case "content_block_start":
		case "content_block_stop":
			return { kind: "structural" };
		case "message_start": {
			const message = isRecord(parsed.message) ? parsed.message : undefined;
			return {
				kind:
					message?.stop_reason !== null && message?.stop_reason !== undefined
						? "terminal_delta"
						: "structural",
			};
		}
		case "message_delta":
			return {
				kind:
					isRecord(parsed.delta) &&
					parsed.delta.stop_reason !== null &&
					parsed.delta.stop_reason !== undefined
						? "terminal_delta"
						: "structural",
			};
		case "content_block_delta":
			return { kind: classifyContentDelta(parsed) };
		case "message_stop":
			return { kind: "message_stop" };
		case "error": {
			const nestedError = isRecord(parsed.error) ? parsed.error : undefined;
			if (
				!nestedError ||
				typeof nestedError.type !== "string" ||
				nestedError.type.length === 0
			) {
				return { kind: "malformed" };
			}
			const errorType = safeErrorType(nestedError?.type);
			const transientErrorType =
				errorType && transientErrorTypes.has(errorType)
					? (errorType as AnthropicTransientSseErrorType)
					: undefined;
			return {
				kind: "error",
				...(errorType ? { errorType } : {}),
				...(transientErrorType ? { transientErrorType } : {}),
			};
		}
		default:
			return { kind: "unknown" };
	}
}
