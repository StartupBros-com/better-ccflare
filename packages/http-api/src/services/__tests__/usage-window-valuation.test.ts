import { expect, test } from "bun:test";
import { parseModelRouteProfiles } from "@better-ccflare/proxy";
import { valueWindowAggregates } from "../usage-window-valuation";

test("configured physical aliases price and retain their original breakdown key", () => {
	const profiles = parseModelRouteProfiles(
		JSON.stringify([
			{
				id: "codex-pool-astra",
				displayName: "Astra",
				selection: "capability",
				logicalModel: "gpt-6-astra",
				expectedProvider: "codex",
				expectedPhysicalModel: "gpt-6-astra",
			},
		]),
	);
	const model = "claude-bccf-route-codex-pool-astra[1m]";
	const result = valueWindowAggregates(
		[
			{
				model,
				requestCount: 1,
				inputTokens: 1_000_000,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
			},
		],
		Date.parse("2026-10-18T00:00:00Z"),
		profiles,
	);
	expect(result.valueUsd).toBe(10);
	expect(result.unpricedTokens).toBe(0);
	expect(result.modelBreakdown[model]?.valueUsd).toBe(10);
});
test("unknown aliases remain visibly unpriced", () => {
	const result = valueWindowAggregates(
		[
			{
				model: "claude-bccf-route-missing",
				requestCount: 1,
				inputTokens: 123,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 7,
			},
		],
		Date.parse("2026-10-18T00:00:00Z"),
		[],
	);
	expect(result.unpricedTokens).toBe(130);
	expect(
		result.modelBreakdown["claude-bccf-route-missing"]?.valueUsd,
	).toBeNull();
});
