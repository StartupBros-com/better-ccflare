import {
	BUFFER_SIZES,
	SseFrameBuffer,
	SseLimitError,
	type StreamResourceLimitKind,
} from "@better-ccflare/core";

const DEFAULT_MAX_FRAME_BYTES = BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES;
const DEFAULT_MAX_BUFFER_BYTES = BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES;
const MAX_SAFE_ERROR_TYPE_LENGTH = 64;
const SAFE_ERROR_TYPE = /^[A-Za-z0-9._:-]+$/;

const KNOWN_ANTHROPIC_EVENTS = new Set([
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
	"ping",
	"error",
]);

export type AnthropicStreamOutcomeStatus =
	| "completed"
	| "midstream_error"
	| "incomplete_eof";

export type AnthropicStreamParseState =
	| "clean"
	| "malformed"
	| "limit_exceeded";

export type AnthropicTerminalEvidence =
	| "none"
	| "message_stop"
	| "error_event"
	| "error_and_message_stop";

export interface AnthropicStreamOutcomeTrackerOptions {
	/** Maximum encoded byte size of one complete SSE frame. */
	maxFrameBytes?: number;
	/** Maximum encoded byte size retained while awaiting an SSE delimiter. */
	maxBufferBytes?: number;
}

/**
 * Privacy-safe protocol evidence for a native Anthropic Messages SSE stream.
 * No response payload text or upstream error message is retained.
 */
export interface AnthropicStreamOutcome {
	status: AnthropicStreamOutcomeStatus;
	terminalEvidence: AnthropicTerminalEvidence;
	parseState: AnthropicStreamParseState;
	limitKind?: Extract<StreamResourceLimitKind, "sse_frame" | "sse_tail">;
	errorType?: string;
	messageStopSeen: boolean;
	errorEventSeen: boolean;
	truncatedTailSeen: boolean;
	chunkCount: number;
	rawByteCount: number;
	frameCount: number;
	eventCount: number;
	commentFrameCount: number;
	pingEventCount: number;
	unknownEventCount: number;
	malformedEventCount: number;
	messageStopCount: number;
	errorEventCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function saturatingAdd(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function safeErrorType(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_SAFE_ERROR_TYPE_LENGTH ||
		!SAFE_ERROR_TYPE.test(value)
	) {
		return "unknown_error";
	}
	return value;
}

/**
 * Incrementally observes native Anthropic SSE bytes for terminal protocol
 * evidence. Parsing and resource-limit failures are converted into outcome
 * metadata: push() and finish() never surface them into the client stream.
 */
export class AnthropicStreamOutcomeTracker {
	private readonly frames: SseFrameBuffer;
	private finishedOutcome: AnthropicStreamOutcome | undefined;
	private parserDisabled = false;
	private malformedSeen = false;
	private limitKind:
		| Extract<StreamResourceLimitKind, "sse_frame" | "sse_tail">
		| undefined;
	private errorType: string | undefined;
	private messageStopSeen = false;
	private errorEventSeen = false;
	private truncatedTailSeen = false;
	private chunkCount = 0;
	private rawByteCount = 0;
	private frameCount = 0;
	private eventCount = 0;
	private commentFrameCount = 0;
	private pingEventCount = 0;
	private unknownEventCount = 0;
	private malformedEventCount = 0;
	private messageStopCount = 0;
	private errorEventCount = 0;

	constructor(options: AnthropicStreamOutcomeTrackerOptions = {}) {
		this.frames = new SseFrameBuffer({
			maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
			maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
		});
	}

	push(chunk: Uint8Array): void {
		if (this.finishedOutcome) return;

		this.chunkCount = saturatingAdd(this.chunkCount, 1);
		this.rawByteCount = saturatingAdd(this.rawByteCount, chunk.byteLength);
		if (this.parserDisabled) return;

		try {
			for (const frame of this.frames.push(chunk)) this.inspectFrame(frame);
		} catch (error) {
			this.captureParserFailure(error);
		}
	}

	finish(): AnthropicStreamOutcome {
		if (this.finishedOutcome) return this.finishedOutcome;

		if (!this.parserDisabled) {
			try {
				const tail = this.frames.flush();
				if (tail.length > 0) this.inspectTruncatedTail(tail);
			} catch (error) {
				this.captureParserFailure(error);
			}
		}

		// Any valid SSE error is authoritative even if a message_stop was seen
		// first. A clean message_stop still proves success when only the transport
		// later errors or is cancelled.
		const status: AnthropicStreamOutcomeStatus = this.errorEventSeen
			? "midstream_error"
			: this.messageStopSeen
				? "completed"
				: "incomplete_eof";
		const terminalEvidence: AnthropicTerminalEvidence =
			this.errorEventSeen && this.messageStopSeen
				? "error_and_message_stop"
				: this.errorEventSeen
					? "error_event"
					: this.messageStopSeen
						? "message_stop"
						: "none";
		const parseState: AnthropicStreamParseState = this.limitKind
			? "limit_exceeded"
			: this.malformedSeen
				? "malformed"
				: "clean";

		this.finishedOutcome = Object.freeze({
			status,
			terminalEvidence,
			parseState,
			...(this.limitKind ? { limitKind: this.limitKind } : {}),
			...(this.errorType ? { errorType: this.errorType } : {}),
			messageStopSeen: this.messageStopSeen,
			errorEventSeen: this.errorEventSeen,
			truncatedTailSeen: this.truncatedTailSeen,
			chunkCount: this.chunkCount,
			rawByteCount: this.rawByteCount,
			frameCount: this.frameCount,
			eventCount: this.eventCount,
			commentFrameCount: this.commentFrameCount,
			pingEventCount: this.pingEventCount,
			unknownEventCount: this.unknownEventCount,
			malformedEventCount: this.malformedEventCount,
			messageStopCount: this.messageStopCount,
			errorEventCount: this.errorEventCount,
		});
		return this.finishedOutcome;
	}

	private inspectTruncatedTail(tail: string): void {
		if (tail.trim().length === 0) return;

		// SSE dispatch requires a blank-line delimiter. A terminal-looking JSON
		// payload in an unterminated flush tail is diagnostics only and must never
		// become protocol evidence on EOF, cancellation, or transport failure.
		this.truncatedTailSeen = true;
		this.markMalformed();
	}

	private inspectFrame(frame: string): void {
		this.frameCount = saturatingAdd(this.frameCount, 1);

		let eventType: string | undefined;
		const dataLines: string[] = [];
		let commentSeen = false;
		let eventFieldSeen = false;

		for (const line of frame.split(/\r?\n/)) {
			if (line.startsWith(":")) {
				commentSeen = true;
				continue;
			}
			if (line.length === 0) continue;

			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);

			if (field === "event") {
				eventFieldSeen = true;
				eventType = value;
			} else if (field === "data") {
				dataLines.push(value);
			}
		}

		if (commentSeen && !eventFieldSeen && dataLines.length === 0) {
			this.commentFrameCount = saturatingAdd(this.commentFrameCount, 1);
			return;
		}
		if (!eventFieldSeen && dataLines.length === 0) return;

		this.eventCount = saturatingAdd(this.eventCount, 1);
		let parsed: unknown;
		let dataJsonParsed = false;
		let frameMalformed = false;
		const markFrameMalformed = (): void => {
			if (frameMalformed) return;
			frameMalformed = true;
			this.markMalformed();
		};
		if (dataLines.length > 0) {
			try {
				parsed = JSON.parse(dataLines.join("\n")) as unknown;
				dataJsonParsed = true;
			} catch {
				markFrameMalformed();
			}
		}

		const payloadType = isRecord(parsed) ? parsed.type : undefined;
		if (
			eventType !== undefined &&
			typeof payloadType === "string" &&
			eventType !== payloadType
		) {
			markFrameMalformed();
		}
		const resolvedType =
			eventType ?? (typeof payloadType === "string" ? payloadType : undefined);

		if (resolvedType === "message_stop") {
			const validMessageStop =
				dataLines.length > 0 &&
				dataJsonParsed &&
				isRecord(parsed) &&
				payloadType === "message_stop" &&
				(eventType === undefined || eventType === "message_stop");
			if (!validMessageStop) {
				markFrameMalformed();
				return;
			}
			this.messageStopSeen = true;
			this.messageStopCount = saturatingAdd(this.messageStopCount, 1);
			return;
		}

		if (resolvedType === "error") {
			this.errorEventSeen = true;
			this.errorEventCount = saturatingAdd(this.errorEventCount, 1);
			if (!this.errorType) {
				const nestedError = isRecord(parsed) ? parsed.error : undefined;
				this.errorType = safeErrorType(
					isRecord(nestedError) ? nestedError.type : undefined,
				);
			}
			return;
		}

		if (resolvedType === "ping") {
			this.pingEventCount = saturatingAdd(this.pingEventCount, 1);
			return;
		}

		if (!resolvedType || !KNOWN_ANTHROPIC_EVENTS.has(resolvedType)) {
			this.unknownEventCount = saturatingAdd(this.unknownEventCount, 1);
		}
	}

	private markMalformed(): void {
		this.malformedSeen = true;
		this.malformedEventCount = saturatingAdd(this.malformedEventCount, 1);
	}

	private captureParserFailure(error: unknown): void {
		this.parserDisabled = true;
		if (error instanceof SseLimitError) {
			this.limitKind = error.kind === "sse_tail" ? "sse_tail" : "sse_frame";
			return;
		}
		this.markMalformed();
	}
}
