/**
 * Regression test for issue #382 — the in-place 529 retry previously sent a
 * pre-cloned `transformedRequestForRetry` Request whose tee branch was never
 * read, retaining its native off-heap buffer. The retry must instead rebuild
 * its Request from the buffered `retryBodyText`.
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

	it("materializes the transformed outbound body through the shared consume-once replay", () => {
		const source = readSource();
		expect(source).toMatch(
			/materializeRequestForTransport\(\s*transformedRequest\s*,?\s*\)/,
		);
		expect(source).not.toMatch(/transformedRequest\.clone\(\)/);
	});

	it("does not retain a body-bearing retry Request or transformed template on success", () => {
		const source = readSource();
		expect(source).not.toMatch(/\bretryTransformedTemplate\b/);
		expect(source).not.toMatch(
			/const retryRequest = new Request\(transformedRequest\.url/,
		);
		expect(source).toMatch(/\bretryTransportReplay\b/);
	});

	it("forces models by consuming and rebuilding the transformed request", () => {
		const source = readSource();
		const forceModel = source.match(
			/export async function forceModelInTransformedRequest\([\s\S]*?\n\}/,
		)?.[0];

		expect(forceModel).toBeDefined();
		expect(forceModel).toMatch(/materializeRequestForTransport\(request\)/);
		expect(forceModel).not.toMatch(/request\.clone\(\)/);
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
