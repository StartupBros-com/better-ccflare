#!/usr/bin/env bun
/**
 * Informational benchmark for the SSE resource-limit policies wired up in
 * Unit U2 (see packages/core/src/constants.ts BUFFER_SIZES and
 * packages/core/src/sse-frame-buffer.ts). Exercises both independent
 * translators that own an SseFrameBuffer:
 *
 *   - CodexProvider.processResponse (packages/providers/src/providers/codex/provider.ts):
 *     OpenAI Responses API SSE -> Anthropic-shaped SSE.
 *   - translateAnthropicStreamToResponses (packages/openai-responses-adapter/src/stream-translator.ts):
 *     Anthropic SSE -> OpenAI Responses API SSE.
 *
 * This script is purely informational: it prints a table of median
 * throughput and peak/settled heap per configuration and NEVER exits
 * non-zero because of a measured number, only on an actual crash. There is
 * no pass/fail threshold here; use bun:test suites for correctness gates.
 *
 * Run with: bun scripts/bench-sse-resource-limits.ts
 * (bare `bun` is fine: Bun.gc(true) does not require --expose-gc, unlike
 * Node's global gc(). If Bun.gc is ever unavailable for some reason, GC
 * passes are silently skipped rather than throwing.)
 *
 * The full matrix (translators x frame shapes x chunk shapes x concurrency
 * x waves) is intentionally large; override any dimension via env vars for
 * a quick smoke run, e.g.:
 *   BENCH_CONCURRENCY=1,12 BENCH_WAVES=1 BENCH_CHUNK_SHAPES=whole-frame \
 *     bun scripts/bench-sse-resource-limits.ts
 */

import { BUFFER_SIZES } from "@better-ccflare/core";
// Deep relative imports for both translators, rather than importing
// @better-ccflare/providers' or @better-ccflare/openai-responses-adapter's
// package index barrels:
//   - CodexProvider itself has no dependency on @better-ccflare/database,
//     but @better-ccflare/providers' index.ts barrel re-exports sibling
//     modules that transitively do, including the auto-generated
//     inline-integrity-check-worker (gitignored, built by `bun run build`,
//     and explicitly off-limits to read/edit per CLAUDE.md). Importing
//     CodexProvider directly from its own file avoids evaluating that
//     barrel at all, so this script runs without requiring a prior build.
//   - translateAnthropicStreamToResponses is an internal implementation
//     detail of @better-ccflare/openai-responses-adapter, not re-exported
//     from its package index (see src/index.ts) in the first place.
import { CodexProvider } from "../packages/providers/src/providers/codex/provider";
import { translateAnthropicStreamToResponses } from "../packages/openai-responses-adapter/src/stream-translator";

// ---------------------------------------------------------------------------
// GC helper: force a full synchronous collection where possible, no-op
// otherwise. Bun.gc(true) works without any CLI flag; this guard exists
// only so the script never throws if run under a non-Bun runtime.
// ---------------------------------------------------------------------------
function forceGc(): void {
	if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
		Bun.gc(true);
		return;
	}
	const maybeGc = (globalThis as { gc?: () => void }).gc;
	if (typeof maybeGc === "function") {
		maybeGc();
	}
}

function heapUsedMiB(): number {
	return process.memoryUsage().heapUsed / 1024 / 1024;
}

/**
 * Tick the event loop and force a GC repeatedly until heapUsed stops
 * changing (within a small tolerance) or maxIters is hit, then return the
 * settled reading in MiB. A single forceGc() immediately after
 * stream-heavy work is not sufficient for heapUsed to settle; see the
 * settleUntilStable rationale in stream-translator.test.ts. Uses the
 * forceGc() wrapper (not raw Bun.gc) so the script keeps degrading
 * gracefully off-Bun.
 */
async function settleHeapMiB(maxIters: number): Promise<number> {
	let last = -1;
	for (let i = 0; i < maxIters; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		forceGc();
		const cur = heapUsedMiB();
		if (last !== -1 && Math.abs(cur - last) < 0.25) {
			return cur;
		}
		last = cur;
	}
	return last;
}

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

type FrameShape = "incident-110079b" | "near-4mib";
type ChunkShape = "whole-frame" | "64kib" | "256b" | "7b-pathological";
type Translator = "codex" | "responses-adapter";

const FRAME_SHAPE_BYTES: Record<FrameShape, number> = {
	// The exact largest complete frame observed in the field that motivated
	// raising the per-frame cap from 64KiB to 4MiB (see AE1 in both
	// provider.test.ts and stream-translator.test.ts).
	"incident-110079b": 110_079,
	// Just under the 4MiB transport frame / translated-output-total caps:
	// the largest legitimate single-block payload either translator is
	// expected to fully buffer and re-emit in one frame.
	"near-4mib": 4_000_000,
};

function sseLine(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}`;
}

/** Build a raw Codex (OpenAI Responses API) SSE body containing one padded
 * response.output_text.delta frame of exactly targetBytes for the delta
 * frame itself, wrapped in a minimal valid response.created/.../.completed
 * envelope so CodexProvider.processResponse translates it end to end. */
function buildCodexFixtureBody(targetBytes: number): Uint8Array {
	const buildDeltaFrame = (padding: string) =>
		sseLine("response.output_text.delta", { delta: padding });
	const baseBytes = encoder.encode(buildDeltaFrame("")).length;
	const padLength = Math.max(0, targetBytes - baseBytes);
	const deltaFrame = buildDeltaFrame("x".repeat(padLength));

	const events = [
		sseLine("response.created", {
			response: { id: "resp_bench", model: "gpt-5.4" },
		}),
		sseLine("response.output_item.added", {
			item: { type: "message" },
			output_index: 0,
		}),
		sseLine("response.content_part.added", { part: { type: "output_text" } }),
		deltaFrame,
		sseLine("response.output_item.done", {
			item: { type: "message" },
			output_index: 0,
		}),
		sseLine("response.completed", {
			response: {
				model: "gpt-5.4",
				usage: { input_tokens: 2, output_tokens: 1 },
			},
		}),
	];
	return encoder.encode(`${events.join("\n\n")}\n\n`);
}

/** Build a raw Anthropic SSE body containing one padded content_block_delta
 * text_delta frame of exactly targetBytes for the delta frame itself,
 * wrapped in a minimal valid message_start/.../message_stop envelope so
 * translateAnthropicStreamToResponses translates it end to end. */
function buildResponsesAdapterFixtureBody(targetBytes: number): Uint8Array {
	const buildDeltaFrame = (padding: string) =>
		sseLine("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: padding },
		});
	const baseBytes = encoder.encode(buildDeltaFrame("")).length;
	const padLength = Math.max(0, targetBytes - baseBytes);
	const deltaFrame = buildDeltaFrame("a".repeat(padLength));

	const events = [
		sseLine("message_start", {
			type: "message_start",
			message: { id: "msg_bench", usage: { input_tokens: 5, output_tokens: 0 } },
		}),
		sseLine("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		deltaFrame,
		sseLine("content_block_stop", { type: "content_block_stop", index: 0 }),
		sseLine("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 3 },
		}),
		sseLine("message_stop", { type: "message_stop" }),
	];
	return encoder.encode(`${events.join("\n\n")}\n\n`);
}

/** Split a fixture body into chunks matching one of the benchmarked network
 * chunking shapes. "whole-frame" returns the entire body as a single
 * chunk, simulating an upstream that flushes one write per response. */
function chunkBody(body: Uint8Array, shape: ChunkShape): Uint8Array[] {
	if (shape === "whole-frame") {
		return [body];
	}
	const chunkSize = shape === "64kib" ? 65_536 : shape === "256b" ? 256 : 7;
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < body.length; offset += chunkSize) {
		chunks.push(body.subarray(offset, offset + chunkSize));
	}
	return chunks;
}

function makeChunkedUpstream(chunks: Uint8Array[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}

// ---------------------------------------------------------------------------
// Translation runners
// ---------------------------------------------------------------------------

async function runCodexTranslation(chunks: Uint8Array[]): Promise<number> {
	const provider = new CodexProvider();
	const upstream = makeChunkedUpstream(chunks);
	const transformed = await provider.processResponse(upstream, null);
	const text = await transformed.text();
	return encoder.encode(text).length;
}

async function runResponsesAdapterTranslation(
	chunks: Uint8Array[],
): Promise<number> {
	const upstream = makeChunkedUpstream(chunks);
	const transformed = translateAnthropicStreamToResponses(
		upstream,
		"resp_bench",
		"claude-3-5-sonnet-20241022",
	);
	const text = await transformed.text();
	return encoder.encode(text).length;
}

async function runConcurrent(
	translator: Translator,
	chunks: Uint8Array[],
	concurrency: number,
): Promise<number> {
	const runner =
		translator === "codex"
			? runCodexTranslation
			: runResponsesAdapterTranslation;
	const results = await Promise.all(
		Array.from({ length: concurrency }, () => runner(chunks)),
	);
	return results.reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------
// Matrix + env var overrides
// ---------------------------------------------------------------------------

function parseListOverride<T extends string>(
	envVar: string,
	fallback: T[],
): T[] {
	const raw = process.env[envVar];
	if (!raw) return fallback;
	return raw.split(",").map((s) => s.trim()) as T[];
}

function parseIntListOverride(envVar: string, fallback: number[]): number[] {
	const raw = process.env[envVar];
	if (!raw) return fallback;
	return raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
}

const translators = parseListOverride<Translator>("BENCH_TRANSLATORS", [
	"codex",
	"responses-adapter",
]);
const frameShapes = parseListOverride<FrameShape>("BENCH_FRAME_SHAPES", [
	"incident-110079b",
	"near-4mib",
]);
const chunkShapes = parseListOverride<ChunkShape>("BENCH_CHUNK_SHAPES", [
	"whole-frame",
	"64kib",
	"256b",
	"7b-pathological",
]);
const concurrencyLevels = parseIntListOverride("BENCH_CONCURRENCY", [
	1, 12, 24,
]);
const waves = Number.parseInt(process.env.BENCH_WAVES ?? "3", 10);

// The pathological 7-byte chunk shape is skipped for the near-4MiB frame by
// default: ~571K chunks per stream at that granularity makes the full
// matrix impractically slow without adding any signal beyond what the
// 110,079-byte incident frame already demonstrates at that chunk size.
// Override BENCH_CHUNK_SHAPES/BENCH_FRAME_SHAPES explicitly to force it.
const SKIP_7B_ON_NEAR_4MIB = process.env.BENCH_FRAME_SHAPES === undefined;

interface Result {
	translator: Translator;
	frameShape: FrameShape;
	chunkShape: ChunkShape;
	concurrency: number;
	medianMs: number;
	medianThroughputMBs: number;
	peakHeapMiB: number;
	settledHeapMiB: number;
}

async function benchConfig(
	translator: Translator,
	frameShape: FrameShape,
	chunkShape: ChunkShape,
	concurrency: number,
): Promise<Result> {
	const body =
		translator === "codex"
			? buildCodexFixtureBody(FRAME_SHAPE_BYTES[frameShape])
			: buildResponsesAdapterFixtureBody(FRAME_SHAPE_BYTES[frameShape]);
	const chunks = chunkBody(body, chunkShape);
	const totalInputBytes = body.length * concurrency;

	const durationsMs: number[] = [];
	let peakHeapMiB = 0;
	let settledHeapMiB = 0;

	// Stabilized pre-config baseline so the heap columns report deltas
	// attributable to this config rather than absolute process heap, which
	// accumulates noise from every previously run config. Settled once per
	// config, not per wave, to keep the full matrix runtime sane.
	const baselineHeapMiB = await settleHeapMiB(10);

	for (let wave = 0; wave < waves; wave++) {
		forceGc();
		const start = performance.now();
		await runConcurrent(translator, chunks, concurrency);
		const elapsedMs = performance.now() - start;
		durationsMs.push(elapsedMs);
		peakHeapMiB = Math.max(peakHeapMiB, heapUsedMiB() - baselineHeapMiB);
		forceGc();
		settledHeapMiB = Math.max(settledHeapMiB, heapUsedMiB() - baselineHeapMiB);
	}

	durationsMs.sort((a, b) => a - b);
	const medianMs = durationsMs[Math.floor(durationsMs.length / 2)];
	const medianThroughputMBs =
		medianMs > 0 ? totalInputBytes / 1024 / 1024 / (medianMs / 1000) : 0;

	return {
		translator,
		frameShape,
		chunkShape,
		concurrency,
		medianMs,
		medianThroughputMBs,
		peakHeapMiB,
		settledHeapMiB,
	};
}

function printTable(results: Result[]): void {
	const headers = [
		"translator",
		"frame",
		"chunking",
		"concurrency",
		"median ms",
		"median MB/s",
		"peak heap delta MiB",
		"settled heap delta MiB",
	];
	const rows = results.map((r) => [
		r.translator,
		r.frameShape,
		r.chunkShape,
		String(r.concurrency),
		r.medianMs.toFixed(1),
		r.medianThroughputMBs.toFixed(1),
		r.peakHeapMiB.toFixed(1),
		r.settledHeapMiB.toFixed(1),
	]);
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((row) => row[i].length)),
	);
	const formatRow = (cells: string[]) =>
		cells.map((c, i) => c.padEnd(widths[i])).join("  ");
	console.log(formatRow(headers));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) {
		console.log(formatRow(row));
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log(
		"SSE resource-limit benchmark (informational only; no thresholds, never exits non-zero on measured numbers).",
	);
	console.log(
		`Policy caps in effect: SSE_TRANSPORT_FRAME_MAX_BYTES=${BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES}, ` +
			`SSE_TRANSPORT_TAIL_MAX_BYTES=${BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES}, ` +
			`TOOL_ARGUMENTS_PER_CALL_MAX_BYTES=${BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES}, ` +
			`TOOL_ARGUMENTS_TOTAL_MAX_BYTES=${BUFFER_SIZES.TOOL_ARGUMENTS_TOTAL_MAX_BYTES}, ` +
			`TRANSLATED_OUTPUT_TOTAL_MAX_BYTES=${BUFFER_SIZES.TRANSLATED_OUTPUT_TOTAL_MAX_BYTES}`,
	);
	console.log(
		`Matrix: translators=[${translators.join(",")}] frameShapes=[${frameShapes.join(",")}] ` +
			`chunkShapes=[${chunkShapes.join(",")}] concurrency=[${concurrencyLevels.join(",")}] waves=${waves}`,
	);
	console.log(
		"Note: peak/settled heap readings can vary run to run due to Bun/JSC GC scheduling around large " +
			"ReadableStream/TransformStream buffers under concurrency; this is a known runtime characteristic " +
			"(see the retry rationale in stream-translator.test.ts's bounded-memory suite), not something this " +
			"script attempts to gate on.",
	);
	console.log("");

	const results: Result[] = [];
	for (const translator of translators) {
		for (const frameShape of frameShapes) {
			for (const chunkShape of chunkShapes) {
				if (
					chunkShape === "7b-pathological" &&
					frameShape === "near-4mib" &&
					SKIP_7B_ON_NEAR_4MIB
				) {
					continue;
				}
				for (const concurrency of concurrencyLevels) {
					const result = await benchConfig(
						translator,
						frameShape,
						chunkShape,
						concurrency,
					);
					results.push(result);
				}
			}
		}
	}

	console.log("");
	printTable(results);
}

main().catch((err) => {
	// A genuine crash (bug in the harness itself) still surfaces with a
	// non-zero exit; that is distinct from "a measured number looked bad",
	// which this script never treats as a failure.
	console.error("Benchmark crashed:", err);
	process.exit(1);
});
