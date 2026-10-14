/**
 * Anthropic SSE helpers for the advisor-emulation interceptor.
 *
 * Reuse note: anthropic-sse-frame-classifier.ts only classifies a single
 * already-split frame (and deliberately discards payloads), and
 * claude-code-ping-compat.ts / anthropic-stream-outcome.ts are byte-window
 * rewriters/trackers that never reconstruct content blocks. None keeps each
 * frame's raw bytes next to its parsed JSON, which unmodified-frame
 * passthrough needs, so this module owns a small parser, encoder and block
 * accumulator.
 */
import type { AnthropicBlock } from "./types";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const NL = 0x0a;
const CR = 0x0d;

export interface SseFrame {
	/** The frame exactly as received, including its terminating blank line. */
	raw: Uint8Array;
	/** Last `event:` field, if any. */
	event?: string;
	/** Parsed `data:` payload; undefined when absent or not valid JSON. */
	json?: unknown;
}

function parseFrame(raw: Uint8Array): SseFrame {
	const text = decoder.decode(raw);
	let event: string | undefined;
	const data: string[] = [];
	for (const line of text.split(/\r\n|\n|\r/)) {
		if (line === "" || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	const frame: SseFrame = { raw };
	if (event !== undefined) frame.event = event;
	if (data.length > 0) {
		try {
			frame.json = JSON.parse(data.join("\n"));
		} catch {
			// non-JSON data stays unparsed; the raw bytes still forward.
		}
	}
	return frame;
}

/** Incremental frame splitter. A frame ends at a blank line (LF or CRLF). */
export class SseFrameParser {
	private pending: Uint8Array = new Uint8Array(0);
	/** Scan position inside `pending`; everything before it holds no blank line. */
	private scanned = 0;

	push(chunk: Uint8Array): SseFrame[] {
		if (chunk.length === 0) return [];
		if (this.pending.length === 0) {
			this.pending = chunk;
		} else {
			const merged = new Uint8Array(this.pending.length + chunk.length);
			merged.set(this.pending, 0);
			merged.set(chunk, this.pending.length);
			this.pending = merged;
		}
		const frames: SseFrame[] = [];
		let frameStart = 0;
		let lineStart = this.scanned > 0 ? this.scanned : 0;
		// Resume at the start of the unfinished line, never mid-line, so a
		// CRLF split across chunks is still seen whole.
		for (let i = lineStart; i < this.pending.length; i++) {
			if (this.pending[i] !== NL) continue;
			let lineEnd = i;
			if (lineEnd > lineStart && this.pending[lineEnd - 1] === CR) lineEnd--;
			const blank = lineEnd === lineStart;
			lineStart = i + 1;
			if (blank) {
				frames.push(parseFrame(this.pending.slice(frameStart, i + 1)));
				frameStart = i + 1;
			}
		}
		this.pending =
			frameStart === 0 ? this.pending : this.pending.slice(frameStart);
		this.scanned = lineStart - frameStart;
		return frames;
	}

	/** Remaining bytes of an unterminated frame (upstream ended mid-frame). */
	flush(): SseFrame[] {
		if (this.pending.length === 0) return [];
		const frame = parseFrame(this.pending);
		this.pending = new Uint8Array(0);
		this.scanned = 0;
		return [frame];
	}
}

export function encodeSseFrame(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

interface PendingBlock {
	block: Record<string, unknown> & { type: string };
	json: string;
	hasJson: boolean;
}

/** Rebuilds Anthropic content blocks from content_block_* events. */
export class AnthropicBlockAccumulator {
	private blocks = new Map<number, PendingBlock>();

	start(index: number, block: unknown): void {
		if (typeof block !== "object" || block === null) return;
		const copy = structuredClone(block) as PendingBlock["block"];
		if (typeof copy.type !== "string") return;
		this.blocks.set(index, { block: copy, json: "", hasJson: false });
	}

	delta(index: number, delta: unknown): void {
		const entry = this.blocks.get(index);
		if (!entry || typeof delta !== "object" || delta === null) return;
		const d = delta as Record<string, unknown>;
		const b = entry.block;
		switch (d.type) {
			case "text_delta":
				if (typeof d.text === "string") {
					b.text = `${typeof b.text === "string" ? b.text : ""}${d.text}`;
				}
				break;
			case "thinking_delta":
				if (typeof d.thinking === "string") {
					b.thinking = `${typeof b.thinking === "string" ? b.thinking : ""}${d.thinking}`;
				}
				break;
			case "signature_delta":
				if (typeof d.signature === "string") {
					b.signature = `${typeof b.signature === "string" ? b.signature : ""}${d.signature}`;
				}
				break;
			case "input_json_delta":
				if (typeof d.partial_json === "string") {
					entry.json += d.partial_json;
					entry.hasJson = true;
				}
				break;
			default:
				break;
		}
	}

	/** Current state of a block without closing it. */
	peek(index: number): AnthropicBlock | undefined {
		const entry = this.blocks.get(index);
		if (!entry) return undefined;
		const out = { ...entry.block };
		if (entry.hasJson) {
			try {
				out.input = JSON.parse(entry.json);
			} catch {
				// partial JSON of an unfinished block: keep what start declared.
			}
		}
		return out;
	}

	stop(index: number): AnthropicBlock | undefined {
		const block = this.peek(index);
		this.blocks.delete(index);
		return block;
	}
}
