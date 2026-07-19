import { BUFFER_SIZES, extractClaudeVersion } from "@better-ccflare/core";
import { isPotentialDownstreamAnthropicMessagesRequest } from "./anthropic-precommit-rescue";
import { classifyAnthropicSseFrame } from "./anthropic-sse-frame-classifier";

const EVENT_PING_PREFIX = new TextEncoder().encode("event: ");
const EVENT_FIELD_PREFIX = new TextEncoder().encode("event:");
const PING_VALUE = new TextEncoder().encode("ping");
const MESSAGE_VALUE = new TextEncoder().encode("message");
const MAX_FRAME_DELIMITER_BYTES = 4;
const MAX_PARSER_WINDOW_BYTES =
	Math.max(
		BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	) + MAX_FRAME_DELIMITER_BYTES;
const fatalDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

interface FrameDelimiter {
	start: number;
	end: number;
}

function findFrameDelimiter(
	bytes: Uint8Array,
	length: number,
	from: number,
): FrameDelimiter | null {
	for (let index = from; index < length; index++) {
		let afterFirstLine: number;
		if (bytes[index] === 0x0a) {
			afterFirstLine = index + 1;
		} else if (
			bytes[index] === 0x0d &&
			index + 1 < length &&
			bytes[index + 1] === 0x0a
		) {
			afterFirstLine = index + 2;
		} else {
			continue;
		}

		if (bytes[afterFirstLine] === 0x0a) {
			return { start: index, end: afterFirstLine + 1 };
		}
		if (
			bytes[afterFirstLine] === 0x0d &&
			afterFirstLine + 1 < length &&
			bytes[afterFirstLine + 1] === 0x0a
		) {
			return { start: index, end: afterFirstLine + 2 };
		}
	}
	return null;
}

function startsWithAt(
	bytes: Uint8Array,
	needle: Uint8Array,
	offset: number,
): boolean {
	if (offset + needle.byteLength > bytes.byteLength) return false;
	for (let index = 0; index < needle.byteLength; index++) {
		if (bytes[offset + index] !== needle[index]) return false;
	}
	return true;
}

function findEffectiveExactPingValue(frame: Uint8Array): number | null {
	let effectiveEventValue: number | null = null;
	let lineStart = 0;
	while (lineStart <= frame.byteLength) {
		let lineEnd = lineStart;
		while (lineEnd < frame.byteLength && frame[lineEnd] !== 0x0a) lineEnd++;
		const contentEnd =
			lineEnd > lineStart && frame[lineEnd - 1] === 0x0d
				? lineEnd - 1
				: lineEnd;
		if (
			contentEnd - lineStart ===
				EVENT_PING_PREFIX.byteLength + PING_VALUE.byteLength &&
			startsWithAt(frame, EVENT_PING_PREFIX, lineStart) &&
			startsWithAt(frame, PING_VALUE, lineStart + EVENT_PING_PREFIX.byteLength)
		) {
			effectiveEventValue = lineStart + EVENT_PING_PREFIX.byteLength;
		} else if (startsWithAt(frame, EVENT_FIELD_PREFIX, lineStart)) {
			// The last event field wins under SSE dispatch semantics. A later event
			// line must invalidate an earlier exact `event: ping` candidate.
			effectiveEventValue = null;
		}
		if (lineEnd >= frame.byteLength) break;
		lineStart = lineEnd + 1;
	}
	return effectiveEventValue;
}

function rewritePingFrame(frame: Uint8Array): Uint8Array | null {
	let decoded: string;
	try {
		decoded = fatalDecoder.decode(frame);
	} catch {
		return null;
	}
	const classification = classifyAnthropicSseFrame(decoded);
	if (
		classification.kind !== "keepalive" ||
		classification.validProtocolActivity !== true
	) {
		return null;
	}

	const pingValueOffset = findEffectiveExactPingValue(frame);
	if (pingValueOffset === null) return null;
	const rewritten = new Uint8Array(
		frame.byteLength - PING_VALUE.byteLength + MESSAGE_VALUE.byteLength,
	);
	rewritten.set(frame.subarray(0, pingValueOffset), 0);
	rewritten.set(MESSAGE_VALUE, pingValueOffset);
	rewritten.set(
		frame.subarray(pingValueOffset + PING_VALUE.byteLength),
		pingValueOffset + MESSAGE_VALUE.byteLength,
	);
	return rewritten;
}

class ClaudeCodePingFrameRewriter {
	private bytes = new Uint8Array(0);
	private length = 0;
	private scanOffset = 0;
	private disabled = false;

	push(chunk: Uint8Array): Uint8Array[] {
		if (this.disabled || chunk.byteLength === 0) return [chunk];
		const output: Uint8Array[] = [];
		let chunkOffset = 0;
		while (chunkOffset < chunk.byteLength) {
			const appendLength = Math.min(
				chunk.byteLength - chunkOffset,
				MAX_PARSER_WINDOW_BYTES - this.length,
			);
			this.append(chunk.subarray(chunkOffset, chunkOffset + appendLength));
			chunkOffset += appendLength;

			this.drainCompleteFrames(output);
			if (this.disabled) {
				if (chunkOffset < chunk.byteLength) {
					output.push(chunk.subarray(chunkOffset));
				}
				return output;
			}

			// A transport chunk may contain arbitrarily many bounded frames. Drain
			// those frames before enforcing limits on the remaining unresolved
			// tail. The four-byte lookahead is enough to finish the longest SSE
			// delimiter for a frame at the exact frame limit, and it must remain
			// buffered across transport chunks because those are not SSE boundaries.
			if (
				this.length > BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES &&
				this.length === MAX_PARSER_WINDOW_BYTES
			) {
				output.push(this.bytes.slice(0, this.length));
				this.reset(true);
				if (chunkOffset < chunk.byteLength) {
					output.push(chunk.subarray(chunkOffset));
				}
				return output;
			}
		}
		return output;
	}

	private drainCompleteFrames(output: Uint8Array[]): void {
		let frameStart = 0;
		let delimiter = findFrameDelimiter(
			this.bytes,
			this.length,
			this.scanOffset,
		);
		while (delimiter) {
			const frameLength = delimiter.start - frameStart;
			if (frameLength > BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES) {
				output.push(this.bytes.slice(frameStart, this.length));
				this.reset(true);
				return;
			}

			const frame = this.bytes.subarray(frameStart, delimiter.start);
			const rewritten = rewritePingFrame(frame);
			if (rewritten) {
				const complete = new Uint8Array(
					rewritten.byteLength + delimiter.end - delimiter.start,
				);
				complete.set(rewritten, 0);
				complete.set(
					this.bytes.subarray(delimiter.start, delimiter.end),
					rewritten.byteLength,
				);
				output.push(complete);
			} else {
				output.push(this.bytes.slice(frameStart, delimiter.end));
			}

			frameStart = delimiter.end;
			delimiter = findFrameDelimiter(this.bytes, this.length, frameStart);
		}

		if (frameStart > 0) this.compact(frameStart);
		this.scanOffset = Math.max(0, this.length - 3);
	}

	flush(): Uint8Array | null {
		if (this.length === 0) return null;
		const tail = this.bytes.slice(0, this.length);
		this.reset(this.disabled);
		return tail;
	}

	failOpen(): Uint8Array | null {
		const pending = this.flush();
		this.disabled = true;
		return pending;
	}

	private append(chunk: Uint8Array): void {
		const required = this.length + chunk.byteLength;
		if (required > this.bytes.byteLength) {
			const capacity = Math.min(
				MAX_PARSER_WINDOW_BYTES,
				Math.max(1024, required, this.bytes.byteLength * 2),
			);
			const expanded = new Uint8Array(capacity);
			expanded.set(this.bytes.subarray(0, this.length));
			this.bytes = expanded;
		}
		this.bytes.set(chunk, this.length);
		this.length = required;
	}

	private compact(consumed: number): void {
		this.bytes.copyWithin(0, consumed, this.length);
		this.length -= consumed;
	}

	private reset(disabled: boolean): void {
		this.bytes = new Uint8Array(0);
		this.length = 0;
		this.scanOffset = 0;
		this.disabled = disabled;
	}
}

function isSuccessfulSse(response: Response): boolean {
	return (
		response.ok &&
		response.body !== null &&
		!response.body.locked &&
		response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream") === true
	);
}

/**
 * Adapt canonical Anthropic ping frames for Claude Code's custom-base stream
 * watchdog. The installed SDK drops named `ping` events before its async
 * iterator yields; a generic named `message` carrying the unchanged
 * `{type:"ping"}` JSON is yielded to the watchdog and ignored by the UI.
 *
 * This compatibility layer belongs at the outermost response boundary, after
 * routing, analytics, semantic liveness, and precommit rescue have all seen
 * the canonical Anthropic protocol.
 */
export function adaptAnthropicSsePingsForClaudeCode(
	request: Request,
	url: URL,
	response: Response,
): Response {
	if (
		!isPotentialDownstreamAnthropicMessagesRequest(request, url) ||
		extractClaudeVersion(request.headers.get("user-agent")) === null ||
		!isSuccessfulSse(response)
	) {
		return response;
	}

	const rewriter = new ClaudeCodePingFrameRewriter();
	const transformed = response.body?.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				try {
					for (const output of rewriter.push(chunk)) {
						controller.enqueue(output);
					}
				} catch {
					const pending = rewriter.failOpen();
					if (pending) controller.enqueue(pending);
				}
			},
			flush(controller) {
				const tail = rewriter.flush();
				if (tail) controller.enqueue(tail);
			},
		}),
	);
	if (!transformed) return response;

	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return new Response(transformed, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
