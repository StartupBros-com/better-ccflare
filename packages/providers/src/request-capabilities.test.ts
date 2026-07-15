import { describe, expect, it } from "bun:test";
import {
	decideContextAdmission,
	estimateAnthropicAdmissionTokens,
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

	it("preserves legacy Unicode advisory estimates", () => {
		const emoji = estimateAnthropicRequestTokens({
			messages: [{ role: "user", content: "😀".repeat(30) }],
		});
		expect(emoji.tokens).toBe(22);
	});

	it("always returns a nonnegative integer for malformed input", () => {
		for (const value of [undefined, null, -1, Number.NaN]) {
			const estimate = estimateAnthropicRequestTokens(value);
			expect(estimate.tokens).toBeGreaterThanOrEqual(0);
			expect(Number.isInteger(estimate.tokens)).toBeTrue();
		}
	});
});

describe("estimateAnthropicAdmissionTokens", () => {
	it("counts the full request envelope, including roles and block framing", () => {
		const contentOnly = "hello";
		const request = {
			model: "claude-sonnet",
			max_tokens: 100,
			messages: [
				{ role: "user", content: [{ type: "text", text: contentOnly }] },
			],
		};
		const estimate = estimateAnthropicAdmissionTokens(request);
		expect(estimate.tokens).toBeGreaterThan(Math.ceil(contentOnly.length / 3));
		expect(estimate.method).toBe("request-envelope-bytes");
		expect(estimate.confidence).toBe("low");
	});

	it("accounts for empty and many content blocks", () => {
		const empty = estimateAnthropicAdmissionTokens({
			messages: [{ role: "user", content: [] }],
		});
		const many = estimateAnthropicAdmissionTokens({
			messages: [
				{
					role: "user",
					content: Array.from({ length: 50 }, () => ({
						type: "text",
						text: "",
					})),
				},
			],
		});
		expect(empty.tokens).toBeGreaterThan(0);
		expect(many.tokens).toBeGreaterThan(empty.tokens * 5);
	});

	it("includes tool schemas and code-heavy ASCII conservatively", () => {
		const plain = estimateAnthropicAdmissionTokens({
			messages: [{ role: "user", content: "a".repeat(300) }],
		});
		const code = estimateAnthropicAdmissionTokens({
			messages: [
				{ role: "user", content: "const x = foo?.bar ?? [];\n".repeat(30) },
			],
			tools: [
				{
					name: "lookup",
					description: "find a value",
					input_schema: {
						type: "object",
						properties: { query: { type: "string", enum: ["a", "b"] } },
						required: ["query"],
					},
				},
			],
		});
		expect(code.tokens).toBeGreaterThan(plain.tokens * 2);
	});

	it("uses materially more conservative UTF-8 estimates for emoji and CJK", () => {
		const ascii = estimateAnthropicAdmissionTokens({
			messages: [{ role: "user", content: "a".repeat(30) }],
		});
		const emoji = estimateAnthropicAdmissionTokens({
			messages: [{ role: "user", content: "😀".repeat(30) }],
		});
		const cjk = estimateAnthropicAdmissionTokens({
			messages: [{ role: "user", content: "漢".repeat(30) }],
		});
		expect(emoji.tokens).toBeGreaterThan(ascii.tokens * 2);
		expect(cjk.tokens).toBeGreaterThan(ascii.tokens * 1.5);
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
