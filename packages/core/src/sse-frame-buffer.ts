/**
 * Bounded SSE (server-sent events) frame buffer.
 *
 * Accumulates raw upstream bytes and extracts complete SSE frames (the text
 * between blank-line delimiters), guarding against unbounded memory growth
 * from either a single oversized frame or a delimiter that never arrives.
 */

/** Frame boundary: copied verbatim from the proven pattern in
 * packages/proxy/src/anthropic-terminal-recovery.ts. No intentional
 * divergence: a lone CR (without a following LF) is not treated as a line
 * ending, matching upstream. Only \n and \r\n line endings are recognized,
 * so the delimiter is an optional \r before each of two newlines. */
const FRAME_DELIMITER = /\r?\n\r?\n/;

const encoder = new TextEncoder();

export class SseLimitError extends Error {
	constructor(
		message: string,
		public readonly limitBytes: number,
		public readonly actualBytes: number,
	) {
		super(message);
		this.name = "SseLimitError";
	}
}

export interface SseFrameBufferOptions {
	/** Cap in bytes for a single extracted SSE frame (text between delimiters). */
	maxFrameBytes: number;
	/** Cap in bytes for the buffered tail while no delimiter has been seen yet. */
	maxBufferBytes: number;
}

export class SseFrameBuffer {
	/**
	 * Unconsumed buffered text, held as separate fragments rather than one
	 * string that gets reassigned (`buffer += decoded`) on every push(). A
	 * repeatedly-reassigned string forces the engine to re-flatten the whole
	 * accumulated text the next time it is sliced or matched against, which
	 * is what made accumulating an unterminated tail in small chunks
	 * quadratic: every push() paid a cost proportional to the *total*
	 * buffered size so far, not just the new chunk. Fragments are only
	 * joined into one string when a frame is actually extracted (bounded by
	 * that frame's size) or on flush(), never on the hot no-delimiter path.
	 */
	private parts: string[] = [];

	/**
	 * Last up to 3 characters of the current unconsumed tail (the suffix of
	 * `parts.join("")`, tracked incrementally so that join is never called
	 * just to compute it). FRAME_DELIMITER matches at most 4 characters
	 * (\r\n\r\n), so prepending these 3 to each new chunk before searching
	 * is enough to catch a delimiter split across push() calls without
	 * rescanning any previously-buffered content. `carry` can never itself
	 * contain a complete delimiter: if it did, the previous push() would
	 * have found and extracted it (a match anywhere in a string is also a
	 * match in that same string's superset), so a match spanning the
	 * carry/decoded boundary is always guaranteed to extend into `decoded`.
	 */
	private carry = "";

	private readonly decoder = new TextDecoder();
	private readonly maxFrameBytes: number;
	private readonly maxBufferBytes: number;

	/**
	 * Encoded byte length of the current unconsumed tail (equivalent to
	 * encoder.encode(parts.join("")).length), maintained incrementally
	 * instead of by re-encoding the whole buffer on every push(). Increased
	 * by the byte length of each newly decoded chunk (bounded by that
	 * chunk's size, not the accumulated buffer) and decreased by the byte
	 * length of each frame plus its delimiter once extracted.
	 */
	private tailBytes = 0;

	constructor(options: SseFrameBufferOptions) {
		this.maxFrameBytes = options.maxFrameBytes;
		this.maxBufferBytes = options.maxBufferBytes;
	}

	/**
	 * Feed a chunk of upstream bytes into the buffer and return any complete
	 * SSE frames now available, in order.
	 *
	 * Throws SseLimitError if any extracted frame exceeds maxFrameBytes, or if
	 * the remaining unterminated tail exceeds maxBufferBytes.
	 */
	push(chunk: Uint8Array): string[] {
		const decoded = this.decoder.decode(chunk, { stream: true });
		this.tailBytes += encoder.encode(decoded).length;

		// Bounded to at most 3 carried-over characters plus this chunk's
		// length, never the whole accumulated buffer.
		const searchText = this.carry + decoded;
		const carryLength = this.carry.length;

		const frames: string[] = [];
		let searchOffset = 0;
		let decodedConsumed = 0;

		let match = FRAME_DELIMITER.exec(searchText.slice(searchOffset));
		while (match) {
			const absIndex = searchOffset + match.index;
			const delimiterLength = match[0].length;
			const decodedFrameEnd = absIndex - carryLength;

			let frame: string;
			if (decodedFrameEnd >= 0) {
				// Delimiter starts within `decoded`; nothing from `carry`
				// (beyond what is already reflected in `parts`) is part of it.
				const decodedSlice = decoded.slice(decodedConsumed, decodedFrameEnd);
				frame =
					this.parts.length === 0
						? decodedSlice
						: this.parts.join("") + decodedSlice;
			} else {
				// Delimiter starts inside the carried-over tail from a
				// previous push(): materialize the buffered fragments once
				// to find the true cut point.
				const joined = this.parts.join("");
				frame = joined.slice(0, joined.length + decodedFrameEnd);
			}

			// CRITICAL: the cap check applies to every frame as it is
			// extracted, before it is returned to the caller. Checking only
			// the leftover tail (below) would miss a fully-terminated
			// oversized frame that arrived intact within a single push()
			// call, since after extracting it the remaining tail can be
			// small or empty.
			const frameBytes = encoder.encode(frame).length;
			if (frameBytes > this.maxFrameBytes) {
				throw new SseLimitError(
					`SSE frame of ${frameBytes} bytes exceeds the ${this.maxFrameBytes} byte cap`,
					this.maxFrameBytes,
					frameBytes,
				);
			}

			// Delimiter characters are all ASCII (\r / \n), so the matched
			// string's length equals its encoded byte length; no need to
			// re-encode it just to keep tailBytes accurate.
			this.tailBytes -= frameBytes + delimiterLength;
			frames.push(frame);
			this.parts = [];

			decodedConsumed = absIndex + delimiterLength - carryLength;
			searchOffset = absIndex + delimiterLength;
			match = FRAME_DELIMITER.exec(searchText.slice(searchOffset));
		}

		const remainder = decoded.slice(decodedConsumed);
		if (remainder.length > 0) {
			this.parts.push(remainder);
		}
		// See the `carry` field comment: this is last3(parts.join("")),
		// computed without ever joining `parts`.
		this.carry =
			frames.length > 0
				? remainder.slice(-3)
				: (this.carry + decoded).slice(-3);

		if (this.tailBytes > this.maxBufferBytes) {
			throw new SseLimitError(
				`Unterminated SSE buffer of ${this.tailBytes} bytes exceeds the ${this.maxBufferBytes} byte cap`,
				this.maxBufferBytes,
				this.tailBytes,
			);
		}

		return frames;
	}

	/**
	 * Return and clear any trailing partial content left in the buffer, e.g.
	 * at stream EOF. This content was never a complete frame, so the
	 * per-frame cap does not apply to it (the tail cap already bounded it on
	 * the most recent push()).
	 */
	flush(): string {
		const tail = this.decoder.decode();
		if (tail.length > 0) {
			this.parts.push(tail);
		}
		const remainder = this.parts.join("");
		this.parts = [];
		this.carry = "";
		this.tailBytes = 0;
		return remainder;
	}
}
