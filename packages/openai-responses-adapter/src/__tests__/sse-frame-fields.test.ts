import { describe, expect, test } from "bun:test";
import { parseSseFrameFields } from "../stream-translator";

/**
 * `parseSseFrameFields` reads the canonical two-line LF frame with `indexOf`
 * instead of splitting it, because an SSE `data:` line can approach the 4MiB
 * transport cap and this runs once per frame on the streaming hot path.
 *
 * `referenceParse` below is the exact scanner the fast path replaced, copied
 * verbatim from the pre-change `processSseFrame`. Every test pins the optimized
 * function to it, so any frame shape that stops taking the fast path must still
 * produce an identical result. If the fast path is ever widened, these tests are
 * what prove the widening did not change how a frame is read.
 *
 * The Codex provider has a sibling suite (`sse-frame-lines.test.ts`) doing the
 * same job for a parser with deliberately DIFFERENT semantics: no trailing
 * space on the prefixes, and first-match-wins instead of last. Keep both green.
 */
function referenceParse(rawEvent: string): {
	eventType: string;
	dataStr: string;
} {
	let eventType = "";
	let dataStr = "";
	for (const line of rawEvent.split(/\r?\n/)) {
		if (line.startsWith("event: ")) {
			eventType = line.slice(7).trim();
		} else if (line.startsWith("data: ")) {
			dataStr = line.slice(6).trim();
		}
	}
	return { eventType, dataStr };
}

function expectMatchesReference(rawEvent: string, label: string) {
	expect(parseSseFrameFields(rawEvent), label).toEqual(
		referenceParse(rawEvent),
	);
}

describe("parseSseFrameFields", () => {
	test("reads the canonical two-line LF frame", () => {
		expect(parseSseFrameFields('event: delta\ndata: {"a":1}')).toEqual({
			eventType: "delta",
			dataStr: '{"a":1}',
		});
	});

	test("requires the trailing space in the prefix", () => {
		// Unlike the Codex parser, a space-less `data:{...}` is NOT a data line
		// here. This asymmetry is deliberate; see the module comment.
		expect(parseSseFrameFields('event:delta\ndata:{"a":1}')).toEqual({
			eventType: "",
			dataStr: "",
		});
	});

	test("accepts either line order", () => {
		expect(parseSseFrameFields('data: {"a":1}\nevent: delta')).toEqual({
			eventType: "delta",
			dataStr: '{"a":1}',
		});
	});

	test("keeps LAST-match-wins semantics, not first", () => {
		// The scanner this replaced was a loop that overwrote on each match, so
		// the latest matching line wins. The Codex parser deliberately does the
		// opposite (first wins) — these two must not be unified. Both frames
		// below hold exactly one bare LF, so both take the FAST path; the
		// reference comparison proves the fallback agrees.
		expect(parseSseFrameFields("data: a\ndata: b").dataStr).toBe("b");
		expect(parseSseFrameFields("event: a\nevent: b").eventType).toBe("b");
		expectMatchesReference("data: a\ndata: b", "duplicate data lines");
		expectMatchesReference("event: a\nevent: b", "duplicate event lines");
	});

	test("reports a missing field as an empty string", () => {
		expect(parseSseFrameFields("data: only").eventType).toBe("");
		expect(parseSseFrameFields("event: only").dataStr).toBe("");
		expect(parseSseFrameFields("")).toEqual({ eventType: "", dataStr: "" });
	});

	test.each([
		["canonical LF", 'event: delta\ndata: {"a":1}'],
		["space-less prefixes", 'event:delta\ndata:{"a":1}'],
		["reversed order", 'data: {"a":1}\nevent: delta'],
		["CRLF framing", 'event: delta\r\ndata: {"a":1}'],
		["CRLF with trailing break", 'event: delta\r\ndata: {"a":1}\r\n'],
		["trailing LF", 'event: delta\ndata: {"a":1}\n'],
		["leading LF", '\ndata: {"a":1}'],
		["leading id line", 'id: 7\nevent: delta\ndata: {"a":1}'],
		["comment line", ': keep-alive\nevent: delta\ndata: {"a":1}'],
		["multi-line data", "event: delta\ndata: one\ndata: two"],
		["duplicate event lines", "event: a\nevent: b\ndata: x"],
		["no newline at all", "data: single"],
		["empty string", ""],
		["whitespace only", "   "],
		["bare LF", "\n"],
		["bare CR", "\r"],
		["CR inside a line", "event: a\rb\ndata: x"],
		["DONE sentinel", "event: done\ndata: [DONE]"],
		["escaped newlines in JSON", 'event: j\ndata: {"a":"b\\nc"}'],
		["unicode payload", "event: emoji\ndata: 😀 café"],
		["near-prefix decoys", "eventx: a\ndataz: b"],
		["leading whitespace defeats the prefix", "  event: pad\ndata: y"],
	])("matches the reference scanner for %s", (label, frame) => {
		expectMatchesReference(frame, label);
	});

	test("matches the reference scanner across 400,000 randomized frames", () => {
		// Deterministic LCG: a divergence is reproducible from the seed, and the
		// thrown error names the exact frame. Token alphabet is chosen to stress
		// the guard — prefix spacing, CR placement, and LF count around the
		// one-bare-LF boundary that decides fast path vs fallback.
		const tokens = [
			"event: ",
			"data: ",
			"event:",
			"data:",
			"\n",
			"\r\n",
			"\r",
			" ",
			"x",
			"{}",
			"",
			"id: 1",
			": c",
			"\t",
			"café",
			"[DONE]",
			"eventx:",
			"\n\n",
		];
		let seed = 0x2f6e2b1;
		const rnd = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};

		let fastPathTaken = 0;
		for (let i = 0; i < 400_000; i++) {
			const n = 1 + Math.floor(rnd() * 7);
			let frame = "";
			for (let j = 0; j < n; j++) {
				frame += tokens[Math.floor(rnd() * tokens.length)];
			}
			const actual = parseSseFrameFields(frame);
			const expected = referenceParse(frame);
			if (
				actual.eventType !== expected.eventType ||
				actual.dataStr !== expected.dataStr
			) {
				throw new Error(
					`divergence for ${JSON.stringify(frame)}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
				);
			}
			const f = frame.indexOf("\n");
			if (
				f !== -1 &&
				frame.indexOf("\n", f + 1) === -1 &&
				(f === 0 || frame.charCodeAt(f - 1) !== 13)
			) {
				fastPathTaken++;
			}
		}
		// Guard against a corpus that silently stops reaching the optimized
		// branch: without this, a change that disabled the fast path entirely
		// would still pass every assertion above.
		expect(fastPathTaken).toBeGreaterThan(1000);
	});

	test("a large data line is returned intact", () => {
		const payload = "y".repeat(200_000);
		const result = parseSseFrameFields(`event: big\ndata: ${payload}`);
		expect(result.eventType).toBe("big");
		expect(result.dataStr).toBe(payload);
	});
});
