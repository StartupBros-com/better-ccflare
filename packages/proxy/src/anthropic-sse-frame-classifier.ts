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

export const ANTHROPIC_SSE_FRAME_KINDS = [
	"keepalive",
	"structural",
	"meaningful",
	"terminal_delta",
	"message_stop",
	"error",
	"malformed",
	"unknown",
] as const;

export type AnthropicSseFrameKind = (typeof ANTHROPIC_SSE_FRAME_KINDS)[number];

/** Fixed-key, saturating counters safe to attach to structured logs. */
export type AnthropicSseFrameKindCounts = Record<AnthropicSseFrameKind, number>;

export function createAnthropicSseFrameKindCounts(): AnthropicSseFrameKindCounts {
	return {
		keepalive: 0,
		structural: 0,
		meaningful: 0,
		terminal_delta: 0,
		message_stop: 0,
		error: 0,
		malformed: 0,
		unknown: 0,
	};
}

export function incrementAnthropicSseFrameKindCount(
	counts: AnthropicSseFrameKindCounts,
	kind: AnthropicSseFrameKind,
): void {
	counts[kind] = Math.min(Number.MAX_SAFE_INTEGER, counts[kind] + 1);
}

export interface AnthropicSseFrameClassification {
	kind: AnthropicSseFrameKind;
	/** True only for a complete, parsed Anthropic protocol event. */
	validProtocolActivity?: true;
	/** Sanitized nested `error.type`; upstream messages are never retained. */
	errorType?: string;
	transientErrorType?: AnthropicTransientSseErrorType;
	/** Sanitized boolean only; no upstream error text leaves the classifier. */
	contextOverflow?: true;
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
		case "signature_delta":
			// Anthropic emits this integrity signature immediately before the
			// thinking block stops. With `display=omitted`, Opus can emit an empty
			// thinking delta followed only by this metadata, so it proves protocol
			// activity but not client-visible/commit-worthy model progress.
			return "structural";
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
			return { kind: "keepalive", validProtocolActivity: true };
		case "content_block_start":
			return isRecord(parsed.content_block)
				? { kind: "structural", validProtocolActivity: true }
				: { kind: "malformed" };
		case "content_block_stop":
			return { kind: "structural", validProtocolActivity: true };
		case "message_start": {
			const message = isRecord(parsed.message) ? parsed.message : undefined;
			if (!message) return { kind: "malformed" };
			return {
				kind:
					message.stop_reason !== null && message.stop_reason !== undefined
						? "terminal_delta"
						: "structural",
				validProtocolActivity: true,
			};
		}
		case "message_delta": {
			if (!isRecord(parsed.delta)) return { kind: "malformed" };
			return {
				kind:
					parsed.delta.stop_reason !== null &&
					parsed.delta.stop_reason !== undefined
						? "terminal_delta"
						: "structural",
				validProtocolActivity: true,
			};
		}
		case "content_block_delta": {
			const kind = classifyContentDelta(parsed);
			return kind === "malformed"
				? { kind }
				: { kind, validProtocolActivity: true };
		}
		case "message_stop":
			return { kind: "message_stop", validProtocolActivity: true };
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
			const errorCode = safeErrorType(nestedError.code);
			const contextOverflow =
				errorCode?.toLowerCase() === "context_length_exceeded" ||
				(typeof nestedError.message === "string" &&
					/^Prompt is too long\. Codex reported:/i.test(nestedError.message));
			return {
				kind: "error",
				validProtocolActivity: true,
				...(errorType ? { errorType } : {}),
				...(transientErrorType ? { transientErrorType } : {}),
				...(contextOverflow ? { contextOverflow: true as const } : {}),
			};
		}
		default:
			return { kind: "unknown", validProtocolActivity: true };
	}
}
