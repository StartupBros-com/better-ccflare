import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "./providers/anthropic/provider";
import { CodexProvider } from "./providers/codex/provider";
import { QwenProvider } from "./providers/qwen/provider";
import { XaiProvider } from "./providers/xai/provider";
import {
	decideContextAdmission,
	deriveComboRouteClass,
	estimateAnthropicAdmissionTokens,
	estimateAnthropicRequestTokens,
	resolveAccountLogicalModelCapability,
	resolveModelContextCapability,
} from "./request-capabilities";
import type { Provider } from "./types";

const routingAccount = (overrides: Partial<Account> = {}): Account =>
	({
		id: "account-1",
		name: "routing account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "oauth-refresh",
		access_token: "oauth-access",
		billing_type: null,
		priority: 0,
		model_mappings: null,
		model_fallbacks: null,
		custom_endpoint: null,
		...overrides,
	}) as Account;

const anthropicCapabilityProvider = new AnthropicProvider();
const capabilityProviders = new Map<string, Provider>([
	["anthropic", anthropicCapabilityProvider],
	["claude-console-api", anthropicCapabilityProvider],
	["codex", new CodexProvider()],
	["qwen", new QwenProvider()],
	["xai", new XaiProvider()],
]);
const getTestCapabilityProvider = (name: string): Provider | undefined =>
	capabilityProviders.get(name);

describe("managed routing capabilities", () => {
	it("derives provider defaults from blank, non-secret draft metadata", () => {
		for (const provider of ["anthropic", "codex", "qwen", "xai"]) {
			expect(
				deriveComboRouteClass(
					routingAccount({
						provider,
						refresh_token: "",
						access_token: null,
					}),
				),
			).toBe("oauth-subscription");
		}
		for (const provider of [
			"claude-console-api",
			"zai",
			"minimax",
			"anthropic-compatible",
			"openai-compatible",
			"nanogpt",
			"kilo",
			"openrouter",
			"alibaba-coding-plan",
			"ollama-cloud",
		]) {
			expect(
				deriveComboRouteClass(
					routingAccount({
						provider,
						refresh_token: "",
						access_token: null,
					}),
				),
			).toBe("api-key");
		}
		expect(deriveComboRouteClass(routingAccount({ provider: "ollama" }))).toBe(
			"local",
		);
		for (const provider of ["bedrock", "vertex-ai"]) {
			expect(deriveComboRouteClass(routingAccount({ provider }))).toBe(
				"cloud-credential",
			);
		}
		for (const provider of [
			"unknown",
			"console",
			"claude-oauth",
			"anthropic-oauth",
		]) {
			expect(deriveComboRouteClass(routingAccount({ provider }))).toBeNull();
		}
	});

	it("separates same-provider plan and paygo accounts by persisted billing type", () => {
		const authShapes = {
			none: { api_key: null, refresh_token: "", access_token: null },
			api: { api_key: "configured", refresh_token: "", access_token: null },
			oauth: {
				api_key: null,
				refresh_token: "configured",
				access_token: null,
			},
			mixed: {
				api_key: "configured",
				refresh_token: "configured",
				access_token: null,
			},
		} as const;
		const cases = [
			[null, "none", "api-key"],
			[null, "api", "api-key"],
			[null, "oauth", null],
			[null, "mixed", null],
			["plan", "none", "oauth-subscription"],
			["plan", "api", "oauth-subscription"],
			["plan", "oauth", null],
			["plan", "mixed", null],
			["api", "none", "api-key"],
			["api", "api", "api-key"],
			["api", "oauth", null],
			["api", "mixed", null],
		] as const;

		for (const [billingType, authShape, expected] of cases) {
			expect(
				deriveComboRouteClass(
					routingAccount({
						provider: "openai-compatible",
						billing_type: billingType,
						...authShapes[authShape],
					}),
				),
			).toBe(expected);
		}
	});

	it("uses only credential-presence shape for auto classification", () => {
		expect(
			deriveComboRouteClass(
				routingAccount({
					provider: "anthropic",
					api_key: null,
					refresh_token: "configured",
					access_token: null,
					billing_type: null,
				}),
			),
		).toBe("oauth-subscription");
		expect(
			deriveComboRouteClass(
				routingAccount({
					provider: "claude-console-api",
					api_key: "configured",
					refresh_token: "",
					access_token: null,
					billing_type: null,
				}),
			),
		).toBe("api-key");
	});

	it("fails closed for unknown billing and contradictory auth shapes", () => {
		for (const account of [
			routingAccount({
				provider: "openai-compatible",
				api_key: "configured",
				refresh_token: "",
				access_token: null,
				billing_type: "other",
			}),
			routingAccount({
				provider: "anthropic",
				api_key: "configured",
				refresh_token: "configured",
				access_token: null,
				billing_type: null,
			}),
			routingAccount({
				provider: "anthropic",
				api_key: "configured",
				refresh_token: "",
				access_token: null,
				billing_type: null,
			}),
			routingAccount({
				provider: "openai-compatible",
				api_key: null,
				refresh_token: "configured",
				access_token: null,
				billing_type: "plan",
			}),
			routingAccount({
				provider: "unknown",
				api_key: "configured",
				refresh_token: "",
				access_token: null,
				billing_type: "plan",
			}),
		]) {
			expect(deriveComboRouteClass(account)).toBeNull();
		}
	});

	it("keeps local and cloud credentials outside billing cohorts", () => {
		expect(
			deriveComboRouteClass(
				routingAccount({ provider: "ollama", billing_type: "plan" }),
			),
		).toBe("local");
		for (const provider of ["bedrock", "vertex-ai"]) {
			expect(
				deriveComboRouteClass(
					routingAccount({ provider, billing_type: "api" }),
				),
			).toBe("cloud-credential");
		}
	});

	it("uses native and provider defaults, including the console capability alias", () => {
		expect(
			resolveAccountLogicalModelCapability(
				routingAccount(),
				"claude-fable-5",
				getTestCapabilityProvider,
			),
		).toMatchObject({ status: "supported", provenance: "native_passthrough" });
		expect(
			resolveAccountLogicalModelCapability(
				routingAccount({ provider: "claude-console-api" }),
				"claude-fable-5",
				getTestCapabilityProvider,
			),
		).toMatchObject({ status: "supported", provenance: "native_passthrough" });
		expect(
			resolveAccountLogicalModelCapability(
				routingAccount({ provider: "codex" }),
				"claude-fable-5",
				getTestCapabilityProvider,
			),
		).toMatchObject({ status: "unsupported", provenance: "provider_default" });
		expect(
			resolveAccountLogicalModelCapability(
				routingAccount({ provider: "qwen" }),
				"claude-opus-4-8",
				getTestCapabilityProvider,
			),
		).toMatchObject({ status: "supported", provenance: "provider_default" });
		expect(
			resolveAccountLogicalModelCapability(
				routingAccount({ provider: "xai" }),
				"claude-fable-5",
				getTestCapabilityProvider,
			),
		).toMatchObject({ status: "supported", provenance: "provider_default" });
	});

	it("lets an explicit mapping override defaults but fails unknown providers closed", () => {
		const explicitlyMapped = routingAccount({
			provider: "qwen",
			model_mappings: JSON.stringify({ fable: "coder-model" }),
		});
		expect(
			resolveAccountLogicalModelCapability(
				explicitlyMapped,
				"claude-fable-5",
				getTestCapabilityProvider,
			),
		).toEqual({
			status: "supported",
			provenance: "explicit_account_mapping",
			reason: "included",
		});
		expect(
			resolveAccountLogicalModelCapability(
				routingAccount({
					provider: "unknown",
					model_mappings: JSON.stringify({ fable: "some-model" }),
				}),
				"claude-fable-5",
				getTestCapabilityProvider,
			),
		).toEqual({
			status: "unknown",
			provenance: "undeclared",
			reason: "unknown",
		});
	});
});

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
