/**
 * Regression test for issue #382 — the in-place 529 retry previously sent a
 * pre-cloned `transformedRequestForRetry` Request whose tee branch was never
 * read, retaining its native off-heap buffer. The retry must instead rebuild
 * its Request from a buffered body text.
 *
 * That buffered text now lives on the `outgoing` descriptor, the single source
 * of truth for the request in flight, so that a recovery which changed the
 * request (model fallback, cache-control strip, thinking-block filter) cannot
 * leave the replay holding a stale body.
 *
 * Static/structural check, same convention as the issue #354 test
 * (proxy-operations-529-parselimit-clones.test.ts) — proxy-operations.ts is
 * not imported directly because its transitive dependency chain loads
 * @better-ccflare/database, which can fail to initialise in worktrees where
 * `bun install` has not run.
 *
 * Run: bun test packages/proxy/src/handlers/__tests__/proxy-operations-529-retry-clone-regression.test.ts
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE_PATH = "packages/proxy/src/handlers/proxy-operations.ts";

function readSource(): string {
	return readFileSync(SOURCE_PATH, "utf-8");
}

describe("issue #382 — 529 in-place retry Request clone", () => {
	it("no longer contains the unread transformedRequestForRetry clone", () => {
		const source = readSource();
		expect(source).not.toMatch(/transformedRequestForRetry/);
	});

	it("rebuilds the retry Request from the buffered body text instead of a clone", () => {
		const source = readSource();
		expect(source).toMatch(/const adoptRetryTemplate = async/);
		expect(source).toMatch(/const bodyText = await request.text\(\)/);
		expect(source).toMatch(/body: bodyText \|\| undefined/);
		expect(source).not.toMatch(/retryTransformedTemplate = \w+\.clone\(\)/);
	});

	it("releases every bounded Codex retry drain reader and aborts only its registered transport", () => {
		const source = readSource();
		const drain = source.match(
			/const drainSupersededResponse = async \(discarded: Response\) => \{([\s\S]*?)\n\t\t\};/,
		)?.[1];

		expect(drain).toBeDefined();
		expect(drain).toMatch(/await drainReader\(body\.getReader\(\), \{/);
		expect(drain).toMatch(
			/transportAbort: getResponseDrainTransport\(discarded\)/,
		);
	});

	it("releases the precommit classification clone reader after an abort", () => {
		const source = readSource();
		const readJson = source.match(
			/async readJson\(response: Response\): Promise<unknown \| null> \{([\s\S]*?)\n\t\}/,
		)?.[1];

		expect(readJson).toBeDefined();
		expect(readJson).toMatch(/finally \{\s*reader\.releaseLock\(\);\s*\}/);
	});
});
