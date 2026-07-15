import { describe, expect, it } from "bun:test";
import {
	decideContextAdmission,
	estimateAnthropicRequestTokens,
	resolveModelContextCapability,
} from "./request-capabilities";

describe("resolveModelContextCapability", () => {
	it("resolves exact Codex models with raw and effective windows", () => {
		expect(resolveModelContextCapability("codex", "gpt-5.6-sol")).toEqual({
			provider: "codex",
			model: "gpt-5.6-sol",
			family: "gpt-5.6-sol",
			rawContextWindow: 372_000,
			effectiveContextWindow: 353_400,
			effectiveContextPercent: 95,
			match: "exact",
		});
		expect(
			resolveModelContextCapability("codex", "gpt-5.4")?.effectiveContextWindow,
		).toBe(258_400);
	});

	it("resolves dated variants by the longest family prefix", () => {
		expect(
			resolveModelContextCapability("codex", "gpt-5.6-sol-2026-05-13"),
		).toMatchObject({
			family: "gpt-5.6-sol",
			rawContextWindow: 372_000,
			effectiveContextWindow: 353_400,
			match: "prefix",
		});
	});

	it("returns unknown capacity as undefined", () => {
		expect(
			resolveModelContextCapability("codex", "future-model"),
		).toBeUndefined();
		expect(
			resolveModelContextCapability("other", "gpt-5.6-sol"),
		).toBeUndefined();
	});
});

describe("estimateAnthropicRequestTokens", () => {
	it("includes structured system, messages, tools, and schemas", () => {
		const request = {
			system: [{ type: "text", text: "system" }],
			messages: [
				{ role: "user", content: [{ type: "text", text: "hello" }] },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", name: "lookup", input: { q: "value" } },
					],
				},
			],
			tools: [
				{
					name: "lookup",
					description: "find value",
					input_schema: {
						type: "object",
						properties: { q: { type: "string" } },
					},
				},
			],
		};

		const result = estimateAnthropicRequestTokens(request);
		expect(result.tokens).toBeGreaterThan(0);
		expect(Number.isInteger(result.tokens)).toBeTrue();
		expect(result.method).toBe("prompt-material-chars");
		expect(result.confidence).toBe("low");
	});

	it("preserves ASCII chars-per-token parity for synthetic Codex estimates", () => {
		const request = {
			model: "claude-3-7-sonnet",
			messages: [{ role: "user", content: "hello" }],
		};
		expect(estimateAnthropicRequestTokens(request).tokens).toBe(4);
	});

	it("uses a materially more conservative UTF-8 estimate for emoji", () => {
		const ascii = estimateAnthropicRequestTokens({
			messages: [{ role: "user", content: "a".repeat(30) }],
		});
		const emoji = estimateAnthropicRequestTokens({
			messages: [{ role: "user", content: "😀".repeat(30) }],
		});
		expect(ascii.tokens).toBe(12);
		expect(emoji.tokens).toBe(63);
		expect(emoji.tokens).toBeGreaterThan(ascii.tokens * 5);
	});

	it("uses a materially more conservative UTF-8 estimate for CJK", () => {
		const ascii = estimateAnthropicRequestTokens({
			messages: [{ role: "user", content: "a".repeat(30) }],
		});
		const cjk = estimateAnthropicRequestTokens({
			messages: [{ role: "user", content: "漢".repeat(30) }],
		});
		expect(cjk.tokens).toBe(48);
		expect(cjk.tokens).toBeGreaterThan(ascii.tokens * 3);
	});

	it("always returns a nonnegative integer for malformed input", () => {
		for (const value of [undefined, null, -1, Number.NaN]) {
			const estimate = estimateAnthropicRequestTokens(value);
			expect(estimate.tokens).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(estimate.tokens)).toBeTrue();
		}
	});
});

describe("decideContextAdmission", () => {
	it("keeps output reservation explicit and accepts the safe boundary", () => {
		expect(
			decideContextAdmission({
				inputTokens: 300_000,
				effectiveContextWindow: 353_400,
				requestedMaxOutputTokens: 50_000,
				safetyReserveTokens: 3_400,
			}),
		).toEqual({
			status: "admit",
			inputTokens: 300_000,
			outputReserveTokens: 50_000,
			safetyReserveTokens: 3_400,
			occupiedTokens: 350_000,
			safeLimitTokens: 350_000,
			effectiveContextWindow: 353_400,
		});
	});

	it("rejects one token beyond the safe boundary with actual and limit", () => {
		const decision = decideContextAdmission({
			inputTokens: 300_001,
			effectiveContextWindow: 353_400,
			requestedMaxOutputTokens: 50_000,
			safetyReserveTokens: 3_400,
		});
		expect(decision.status).toBe("reject");
		expect(decision.occupiedTokens).toBe(350_001);
		expect(decision.safeLimitTokens).toBe(350_000);
	});

	it("returns unknown instead of rejecting unknown capacity", () => {
		expect(
			decideContextAdmission({
				inputTokens: 999_999,
				effectiveContextWindow: undefined,
				requestedMaxOutputTokens: 10_000,
				safetyReserveTokens: 1_000,
			}).status,
		).toBe("unknown");
	});

	it("clamps malformed values without double-subtracting effective capacity", () => {
		expect(
			decideContextAdmission({
				inputTokens: Number.NaN,
				effectiveContextWindow: 100,
				requestedMaxOutputTokens: -20,
				safetyReserveTokens: 10.9,
			}),
		).toMatchObject({
			status: "admit",
			inputTokens: 0,
			outputReserveTokens: 0,
			safetyReserveTokens: 10,
			occupiedTokens: 0,
			safeLimitTokens: 90,
		});
	});
});
