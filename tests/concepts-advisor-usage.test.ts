import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

function advisorUsageSection(): string {
	const concepts = readFileSync(join(repositoryRoot, "CONCEPTS.md"), "utf8");
	const start = concepts.indexOf("### Advisor usage\n");
	expect(start).toBeGreaterThanOrEqual(0);
	const end = concepts.indexOf("\n### ", start + 1);
	return concepts.slice(start, end === -1 ? undefined : end);
}

describe("CONCEPTS.md advisor usage", () => {
	test("pro-gate round 1 P2: an unpriced advisor model is documented as billing-incomplete", () => {
		// usage-collector.ts marks a row billing-incomplete whenever an advisor model
		// has no known price, because cost_usd then omits real advisor spend (pinned by
		// "keeps the executor cost and marks billing incomplete when the advisor model is
		// unpriced" in usage-collector-lifecycle.test.ts). The glossary sentence for that
		// case must carry the same signal, or the partial cost reads as authoritative.
		const sentences = advisorUsageSection()
			.replace(/\s+/g, " ")
			.split(/(?<=\.)\s+/);
		const unpriced = sentences.filter((sentence) =>
			/no known price|unknown price/i.test(sentence),
		);

		expect(unpriced).toHaveLength(1);
		const [sentence] = unpriced;
		expect(sentence).toMatch(/billing-incomplete/i);
		expect(sentence).toMatch(/keeps its tokens/i);
		expect(sentence).toMatch(/no estimated cost/i);
	});
});
