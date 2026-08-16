import { describe, expect, test } from "bun:test";
import { findCodexSseFrameLines } from "./provider";

/**
 * findCodexSseFrameLines reads the canonical two-line LF frame with indexOf
 * instead of splitting it, because a Codex `data:` line can approach the 4MiB
 * transport cap and this runs once per frame on the streaming hot path.
 *
 * The reference implementation below is the exact code the fast path replaced:
 * two independent `.find()` scans over `split(/\r?\n/)`. Every test here pins
 * the optimized function to that reference, so a frame shape that stops taking
 * the fast path must still produce the identical result.
 */
function referenceFindLines(eventText: string): {
	eventLine: string | undefined;
	dataLine: string | undefined;
} {
	return {
		eventLine: eventText.split(/\r?\n/).find((l) => l.startsWith("event:")),
		dataLine: eventText.split(/\r?\n/).find((l) => l.startsWith("data:")),
	};
}

function expectMatchesReference(eventText: string, label: string) {
	expect(findCodexSseFrameLines(eventText), label).toEqual(
		referenceFindLines(eventText),
	);
}

describe("findCodexSseFrameLines", () => {
	test("reads the canonical two-line LF frame", () => {
		const result = findCodexSseFrameLines('event: delta\ndata: {"a":1}');
		expect(result.eventLine).toBe("event: delta");
		expect(result.dataLine).toBe('data: {"a":1}');
	});

	test("matches the space-less prefix form used by Codex", () => {
		// Unlike the OpenAI Responses adapter's parser, the prefixes here carry
		// no trailing space, so `data:{...}` must still match.
		const result = findCodexSseFrameLines('event:delta\ndata:{"a":1}');
		expect(result.eventLine).toBe("event:delta");
		expect(result.dataLine).toBe('data:{"a":1}');
	});

	test("accepts either line order", () => {
		const result = findCodexSseFrameLines('data: {"a":1}\nevent: delta');
		expect(result.eventLine).toBe("event: delta");
		expect(result.dataLine).toBe('data: {"a":1}');
	});

	test("keeps FIRST-match-wins semantics, not last", () => {
		// The replaced code used .find(), so the earliest matching line wins.
		// The adapter's parser deliberately differs (last wins) — these two must
		// not be unified without changing behaviour.
		expect(findCodexSseFrameLines("data: a\ndata: b").dataLine).toBe("data: a");
		expect(findCodexSseFrameLines("event: a\nevent: b").eventLine).toBe(
			"event: a",
		);
	});

	test("reports a missing line as undefined", () => {
		expect(findCodexSseFrameLines("data: only").eventLine).toBeUndefined();
		expect(findCodexSseFrameLines("event: only").dataLine).toBeUndefined();
		expect(findCodexSseFrameLines("").eventLine).toBeUndefined();
		expect(findCodexSseFrameLines("").dataLine).toBeUndefined();
	});

	test("does not match a prefix that is not at the start of the line", () => {
		expectMatchesReference("  event: pad\n  data: pad", "leading whitespace");
		expect(
			findCodexSseFrameLines("  event: pad\ndata: y").eventLine,
		).toBeUndefined();
	});

	test.each([
		["canonical LF", 'event: delta\ndata: {"a":1}'],
		["space-less", 'event:delta\ndata:{"a":1}'],
		["reversed order", 'data: {"a":1}\nevent: delta'],
		["CRLF framing", 'event: delta\r\ndata: {"a":1}'],
		["CRLF with trailing break", 'event: delta\r\ndata: {"a":1}\r\n'],
		["trailing LF", 'event: delta\ndata: {"a":1}\n'],
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
		["blank first line", "\ndata: x"],
		["DONE sentinel", "event: done\ndata: [DONE]"],
		["escaped newlines in JSON", 'event: j\ndata: {"a":"b\\nc"}'],
		["unicode payload", "event: emoji\ndata: 😀 café"],
		["near-prefix decoys", "eventx: a\ndataz: b"],
	])("matches the reference scan for %s", (label, frame) => {
		expectMatchesReference(frame, label);
	});

	test("matches the reference scan across randomized frame assemblies", () => {
		// Deterministic LCG so a failure is reproducible.
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
		];
		let seed = 0x51f3a7c;
		const rnd = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};

		for (let i = 0; i < 20_000; i++) {
			const n = 1 + Math.floor(rnd() * 7);
			let frame = "";
			for (let j = 0; j < n; j++) {
				frame += tokens[Math.floor(rnd() * tokens.length)];
			}
			const actual = findCodexSseFrameLines(frame);
			const expected = referenceFindLines(frame);
			if (
				actual.eventLine !== expected.eventLine ||
				actual.dataLine !== expected.dataLine
			) {
				throw new Error(
					`divergence for ${JSON.stringify(frame)}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
				);
			}
		}
	});

	test("a large data line is returned intact", () => {
		// The case the fast path exists for: splitting this frame would walk and
		// re-slice the whole payload just to find two fields.
		const payload = `data: ${"y".repeat(200_000)}`;
		const result = findCodexSseFrameLines(`event: big\n${payload}`);
		expect(result.eventLine).toBe("event: big");
		expect(result.dataLine).toBe(payload);
	});
});
