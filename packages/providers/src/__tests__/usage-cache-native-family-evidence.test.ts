import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const now = 1_800_000_000_000;
const accountId = "offline-native-family-evidence";
const realNow = Date.now;
beforeEach(() => {
	Date.now = () => now;
});
afterEach(() => {
	Date.now = realNow;
	usageCache.delete(accountId);
});

describe("native family rejection provenance", () => {
	it("round trips authoritative evidence separately from exact-model state", () => {
		usageCache.markModelScopedExhausted(
			accountId,
			"claude-fable-5",
			null,
			now + 60000,
		);
		usageCache.markFamilyScopedExhausted(
			accountId,
			"claude-fable-5",
			now + 60000,
			{ reason: "matching_scoped_limit", authoritativeNativeRejection: true },
		);
		expect(
			usageCache.getFamilyScopedExhaustion(accountId, "claude-fable-5", now),
		).toMatchObject({
			family: "fable",
			evidence: {
				reason: "matching_scoped_limit",
				authoritativeNativeRejection: true,
			},
		});
		expect(
			usageCache.getModelScopedExhaustion(
				accountId,
				"claude-fable-5",
				null,
				now,
			),
		).toEqual({ exhausted: true, markedAt: now, expiresAt: now + 60000 });
	});
	it("legacy calls retain exact response shape and never inherit old trusted evidence", () => {
		usageCache.markFamilyScopedExhausted(
			accountId,
			"claude-fable-5",
			now + 60000,
			{ reason: "matching_scoped_limit", authoritativeNativeRejection: true },
		);
		usageCache.markFamilyScopedExhausted(
			accountId,
			"claude-fable-5",
			now + 60000,
		);
		expect(
			usageCache.getFamilyScopedExhaustion(accountId, "claude-fable-5", now),
		).toEqual({
			exhausted: true,
			family: "fable",
			markedAt: now,
			expiresAt: now + 60000,
		});
	});
});
