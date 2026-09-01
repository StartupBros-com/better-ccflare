import { describe, expect, test } from "bun:test";
import {
	BUNDLED_MODELS_AS_OF,
	CLAUDE_MODEL_IDS,
	getAllowedModelsMessage,
	getConfiguredModelMapping,
	getEndpointUrl,
	getModelDisplayName,
	getModelFamily,
	getModelList,
	getModelMappings,
	getModelShortName,
	getStrictClaudeModelFamily,
	isFamilyAliasModel,
	isValidClaudeModel,
	LATEST_FABLE_MODEL,
	LATEST_MODEL_BY_FAMILY,
	MAX_MODEL_MAPPING_CANDIDATES,
	mapModelName,
	parseCustomEndpointData,
	parseModelMappings,
	resolveCompatibleEndpoint,
	resolveFamilyAliasModel,
	resolveStoredPolicyAliasModel,
	ValidationError,
	validatePriority,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import { validateModelMappings } from "./validation";

const candidateModels = (count: number) =>
	Array.from({ length: count }, (_, index) => `physical-model-${index + 1}`);

describe("Fable 5.1 registry metadata", () => {
	test("registers Fable 5.1 while preserving the explicit Fable 5 legacy pin", () => {
		expect(CLAUDE_MODEL_IDS.FABLE_5_1).toBe("claude-fable-5-1");
		expect(CLAUDE_MODEL_IDS.FABLE_5).toBe("claude-fable-5");
		expect(getModelDisplayName(CLAUDE_MODEL_IDS.FABLE_5_1)).toBe(
			"Claude Fable 5.1",
		);
		expect(getModelShortName(CLAUDE_MODEL_IDS.FABLE_5_1)).toBe(
			"claude-fable-5.1",
		);
		expect(BUNDLED_MODELS_AS_OF).toBe("2026-09-01");
	});

	test("advances bare Fable aliases without rewriting concrete legacy pins", () => {
		expect(LATEST_FABLE_MODEL).toBe(CLAUDE_MODEL_IDS.FABLE_5_1);
		expect(LATEST_MODEL_BY_FAMILY.fable).toBe(CLAUDE_MODEL_IDS.FABLE_5_1);
		expect(resolveFamilyAliasModel("fable", "fable")).toBe(
			CLAUDE_MODEL_IDS.FABLE_5_1,
		);
		expect(resolveFamilyAliasModel(CLAUDE_MODEL_IDS.FABLE_5, "fable")).toBe(
			CLAUDE_MODEL_IDS.FABLE_5,
		);
	});
});

describe("Model Mapping", () => {
	test("distinguishes an explicit mapping from ordinary pass-through", () => {
		const account = {
			id: "test",
			name: "mapped",
			provider: "openai-compatible",
			model_mappings: JSON.stringify({
				"claude-opus-special": "physical-exact",
				opus: ["physical-family", "physical-fallback"],
			}),
			model_fallbacks: null,
			custom_endpoint: null,
		} as Account;

		expect(getConfiguredModelMapping("claude-opus-special", account)).toEqual({
			models: ["physical-exact"],
			match: "exact",
		});
		expect(getConfiguredModelMapping("claude-opus-current", account)).toEqual({
			models: ["physical-family", "physical-fallback"],
			match: "family",
		});
		expect(getConfiguredModelMapping("claude-fable-5", account)).toBeNull();
	});

	test("parseModelMappings handles valid JSON", () => {
		const mappings = JSON.stringify({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});

		const result = parseModelMappings(mappings);
		expect(result).toEqual({
			sonnet: "gpt-4",
			opus: "gpt-4-turbo",
			haiku: "gpt-3.5-turbo",
		});
	});

	test("parseModelMappings handles invalid JSON", () => {
		const result = parseModelMappings("invalid-json");
		expect(result).toBeNull();
	});

	test("parseModelMappings handles null/empty", () => {
		expect(parseModelMappings(null)).toBeNull();
		expect(parseModelMappings("")).toBeNull();
	});

	test("parseCustomEndpointData preserves its string-only public runtime contract", () => {
		expect(
			parseCustomEndpointData(
				JSON.stringify({
					endpoint: "https://example.invalid",
					modelMappings: {
						sonnet: ["physical-primary", "physical-fallback"],
						opus: "physical-opus",
					},
				}),
			),
		).toEqual({
			endpoint: "https://example.invalid",
			modelMappings: {
				sonnet: "physical-primary",
				opus: "physical-opus",
			},
		});
	});

	test("validateModelMappings accepts exactly 16 candidates", () => {
		expect(
			validateModelMappings(
				{ sonnet: candidateModels(MAX_MODEL_MAPPING_CANDIDATES) },
				"modelMappings",
			),
		).toEqual({ sonnet: candidateModels(MAX_MODEL_MAPPING_CANDIDATES) });
	});

	test("validateModelMappings rejects a 17th candidate with field and key context", () => {
		let error: unknown;
		try {
			validateModelMappings(
				{ sonnet: candidateModels(MAX_MODEL_MAPPING_CANDIDATES + 1) },
				"modelMappings",
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).field).toBe("modelMappings.sonnet");
		expect((error as ValidationError).message).toBe(
			`modelMappings value for key 'sonnet' must contain at most ${MAX_MODEL_MAPPING_CANDIDATES} candidates`,
		);
	});

	test("parseModelMappings rejects persisted arrays above the candidate limit", () => {
		expect(
			parseModelMappings(JSON.stringify({ sonnet: candidateModels(17) })),
		).toBeNull();
	});

	test("ignores oversized environment and legacy custom-endpoint mappings", () => {
		const previous = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
		process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = JSON.stringify({
			sonnet: candidateModels(17),
		});
		try {
			const account = {
				id: "runtime-defense",
				name: "runtime-defense",
				model_mappings: null,
				model_fallbacks: null,
				custom_endpoint: JSON.stringify({
					endpoint: "https://example.invalid",
					modelMappings: { opus: candidateModels(17) },
				}),
			} as Account;

			expect(getModelMappings(account)).toEqual({});
			expect(getModelList("claude-sonnet-4-5", account)).toBeNull();
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
			} else {
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = previous;
			}
		}
	});

	test("retains bounded custom-endpoint candidates for internal routing", () => {
		const account = {
			id: "legacy-candidates",
			name: "legacy-candidates",
			model_mappings: null,
			model_fallbacks: null,
			custom_endpoint: JSON.stringify({
				endpoint: "https://example.invalid",
				modelMappings: {
					sonnet: ["physical-primary", "physical-fallback"],
				},
			}),
		} as Account;

		expect(getModelList("claude-sonnet-4-5", account)).toEqual([
			"physical-primary",
			"physical-fallback",
		]);
	});

	test("does not append deprecated model_fallbacks beyond the candidate limit", () => {
		const account = {
			id: "bounded-fallback",
			name: "bounded-fallback",
			model_mappings: JSON.stringify({ sonnet: candidateModels(16) }),
			model_fallbacks: JSON.stringify({ sonnet: "overflow-fallback" }),
			custom_endpoint: null,
		} as Account;

		expect(getModelList("claude-sonnet-4-5", account)).toEqual(
			candidateModels(16),
		);
	});

	test("ignores persisted model_fallbacks values that are arrays or non-strings", () => {
		for (const invalidFallback of [["fallback"], 42]) {
			const account = {
				id: "invalid-fallback",
				name: "invalid-fallback",
				model_mappings: JSON.stringify({ sonnet: "primary" }),
				model_fallbacks: JSON.stringify({ sonnet: invalidFallback }),
				custom_endpoint: null,
			} as Account;

			expect(getModelList("claude-sonnet-4-5", account)).toEqual(["primary"]);
		}
	});

	test("mapModelName uses direct pattern matching", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "gpt-4",
				opus: "gpt-4-turbo",
				haiku: "gpt-3.5-turbo",
			}),
			custom_endpoint: null,
		};

		// Test direct pattern matching with realistic mappings
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount); // Current
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount); // Current
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount); // Current

		// Future model versions - demonstrating future-proof behavior
		const result4 = mapModelName("claude-sonnet-4-6-20251129", mockAccount); // Future version
		const result5 = mapModelName("claude-haiku-4-6-20251101", mockAccount); // Future version
		const result6 = mapModelName("claude-opus-4-5-20251105", mockAccount); // Future version

		// Current models
		expect(result1).toBe("gpt-4"); // Matches "sonnet"
		expect(result2).toBe("gpt-3.5-turbo"); // Matches "haiku"
		expect(result3).toBe("gpt-4-turbo"); // Matches "opus"

		// Future models - should still work without any code changes
		expect(result4).toBe("gpt-4"); // Still matches "sonnet"
		expect(result5).toBe("gpt-3.5-turbo"); // Still matches "haiku"
		expect(result6).toBe("gpt-4-turbo"); // Still matches "opus"
	});

	test("real database mappings work correctly", () => {
		// Test with real mappings from the database
		const openrouterMappings =
			'{"opus":"z-ai/glm-4.5-air:free","sonnet":"z-ai/glm-4.5-air:free","haiku":"z-ai/glm-4.5-air:free"}';

		const mockAccount: Account = {
			id: "test",
			name: "openrouter-test",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: openrouterMappings,
			custom_endpoint: null,
		};

		// Test real client model names
		const sonnetRequest = "claude-sonnet-4-5-20250929";
		const haikuRequest = "claude-haiku-4-5-20251001";
		const opusRequest = "claude-opus-4-1-20250805";

		// These should be mapped using the direct pattern matching logic
		const sonnetMapped = mapModelName(sonnetRequest, mockAccount);
		const haikuMapped = mapModelName(haikuRequest, mockAccount);
		const opusMapped = mapModelName(opusRequest, mockAccount);

		expect(sonnetMapped).toBe("z-ai/glm-4.5-air:free"); // matches "sonnet"
		expect(haikuMapped).toBe("z-ai/glm-4.5-air:free"); // matches "haiku"
		expect(opusMapped).toBe("z-ai/glm-4.5-air:free"); // matches "opus"

		// Test future model versions work
		const futureSonnet = mapModelName(
			"claude-sonnet-5-0-20251201",
			mockAccount,
		);
		expect(futureSonnet).toBe("z-ai/glm-4.5-air:free"); // still matches "sonnet"
	});

	test("mapModelName passes through original model when no mappings configured", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: null, // No custom mappings
			custom_endpoint: null,
		};

		// Should return the original model name unchanged
		const result1 = mapModelName("claude-sonnet-4-5-20250929", mockAccount);
		const result2 = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const result3 = mapModelName("claude-opus-4-1-20250805", mockAccount);

		expect(result1).toBe("claude-sonnet-4-5-20250929");
		expect(result2).toBe("claude-haiku-4-5-20251001");
		expect(result3).toBe("claude-opus-4-1-20250805");
	});

	test("mapModelName handles case insensitive pattern matching correctly", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "lowercase-gpt-4",
				opus: "lowercase-gpt-4-turbo",
				haiku: "lowercase-gpt-3.5",
			}),
			custom_endpoint: null,
		};

		// Should match using case-insensitive pattern matching
		const sonnetResult = mapModelName(
			"claude-sonnet-4-5-20250929",
			mockAccount,
		);
		const haikuResult = mapModelName("claude-haiku-4-5-20251001", mockAccount);
		const opusResult = mapModelName("claude-opus-4-1-20250805", mockAccount);

		// Should match the lowercase mappings due to case-insensitive pattern matching
		expect(sonnetResult).toBe("lowercase-gpt-4");
		expect(haikuResult).toBe("lowercase-gpt-3.5");
		expect(opusResult).toBe("lowercase-gpt-4-turbo");
	});

	test("mapModelName passes through unmapped model when only sonnet is configured (regression: no implicit sonnet catch-all)", () => {
		// Regression test: previously, if an account had a sonnet mapping but no haiku mapping,
		// requesting a haiku model would silently remap it to the sonnet target.
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				sonnet: "claude-sonnet-4-6", // Only sonnet is mapped; haiku is NOT
			}),
			custom_endpoint: null,
		};

		// Sonnet should be mapped
		expect(mapModelName("claude-sonnet-4-5", mockAccount)).toBe(
			"claude-sonnet-4-6",
		);

		// Haiku has no mapping — must pass through unchanged, NOT remap to sonnet target
		expect(mapModelName("claude-haiku-4-5", mockAccount)).toBe(
			"claude-haiku-4-5",
		);

		// Opus has no mapping — must also pass through unchanged
		expect(mapModelName("claude-opus-4-5", mockAccount)).toBe(
			"claude-opus-4-5",
		);
	});
});

describe("Model Validation Utilities", () => {
	test("getModelFamily detects opus models", () => {
		expect(getModelFamily("claude-opus-4-6")).toBe("opus");
		expect(getModelFamily("claude-opus-4-20250514")).toBe("opus");
		expect(getModelFamily("CLAUDE-OPUS-5-0")).toBe("opus"); // case insensitive
	});

	test("getModelFamily detects sonnet models", () => {
		expect(getModelFamily("claude-sonnet-4-5-20250929")).toBe("sonnet");
		expect(getModelFamily("claude-sonnet-5-0")).toBe("sonnet");
	});

	test("getModelFamily detects haiku models", () => {
		expect(getModelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
		expect(getModelFamily("claude-haiku-5-0")).toBe("haiku");
	});

	test("getModelFamily detects fable models", () => {
		expect(getModelFamily("claude-fable-5")).toBe("fable");
		expect(getModelFamily("claude-fable-5-20260601")).toBe("fable");
		expect(getModelFamily("CLAUDE-FABLE-5")).toBe("fable"); // case insensitive
	});

	test("getModelFamily returns null for invalid models", () => {
		expect(getModelFamily("gpt-4")).toBeNull();
		expect(getModelFamily("invalid-model")).toBeNull();
		expect(getModelFamily("")).toBeNull();
	});

	test("getStrictClaudeModelFamily accepts only canonical logical Claude IDs", () => {
		expect(getStrictClaudeModelFamily("claude-fable-5")).toBe("fable");
		expect(getStrictClaudeModelFamily("CLAUDE-OPUS")).toBe("opus");
		expect(getStrictClaudeModelFamily("claude-haiku-4-5")).toBe("haiku");
		expect(getStrictClaudeModelFamily("claude-sonnet-5")).toBe("sonnet");
		for (const model of [
			"my-opus-experiment",
			"provider/claude-opus-5",
			"anthropic.claude-opus-5",
			"opus-custom",
			"an-arbitrary-opus-containing-string",
		]) {
			expect(getStrictClaudeModelFamily(model)).toBeNull();
		}
	});

	test("isValidClaudeModel accepts valid patterns", () => {
		expect(isValidClaudeModel("claude-opus-4-6")).toBe(true);
		expect(isValidClaudeModel("claude-sonnet-4-5-20250929")).toBe(true);
		expect(isValidClaudeModel("claude-haiku-4-5-20251001")).toBe(true);
		expect(isValidClaudeModel("claude-fable-5")).toBe(true);
		expect(isValidClaudeModel("claude-opus-5-0-future")).toBe(true); // future models
	});

	test("isValidClaudeModel rejects invalid patterns", () => {
		expect(isValidClaudeModel("gpt-4")).toBe(false);
		expect(isValidClaudeModel("invalid-model")).toBe(false);
		expect(isValidClaudeModel("")).toBe(false);
	});

	test("getAllowedModelsMessage returns user-friendly error", () => {
		const message = getAllowedModelsMessage();
		expect(message).toContain("opus");
		expect(message).toContain("sonnet");
		expect(message).toContain("haiku");
		expect(message).toContain("fable");
	});

	test("mapModelName maps fable family via family mapping", () => {
		const mockAccount: Account = {
			id: "test",
			name: "test-account",
			provider: "openai-compatible",
			api_key: "test-key",
			refresh_token: "",
			access_token: "",
			expires_at: null,
			created_at: Date.now(),
			request_count: 0,
			total_requests: 0,
			priority: 10,
			model_mappings: JSON.stringify({
				fable: "my-fable-model",
			}),
			custom_endpoint: null,
		} as Account;

		expect(mapModelName("claude-fable-5", mockAccount)).toBe("my-fable-model");
		// Unmapped families pass through unchanged
		expect(mapModelName("claude-opus-4-6", mockAccount)).toBe(
			"claude-opus-4-6",
		);
	});
});

describe("Family alias helpers", () => {
	test("isFamilyAliasModel matches the bare family word (trim + case-insensitive)", () => {
		expect(isFamilyAliasModel("opus", "opus")).toBe(true);
		expect(isFamilyAliasModel("OPUS", "opus")).toBe(true);
		expect(isFamilyAliasModel("  opus  ", "opus")).toBe(true);
		expect(isFamilyAliasModel("claude-opus-5", "opus")).toBe(false);
		expect(isFamilyAliasModel("sonnet", "opus")).toBe(false);
		expect(isFamilyAliasModel("", "opus")).toBe(false);
	});

	test("resolveFamilyAliasModel resolves a bare alias to the latest model in that family", () => {
		expect(resolveFamilyAliasModel("opus", "opus")).toBe(
			LATEST_MODEL_BY_FAMILY.opus,
		);
		expect(resolveFamilyAliasModel("  OPUS  ", "opus")).toBe(
			LATEST_MODEL_BY_FAMILY.opus,
		);
		expect(resolveFamilyAliasModel("sonnet", "sonnet")).toBe(
			LATEST_MODEL_BY_FAMILY.sonnet,
		);
		expect(resolveFamilyAliasModel("haiku", "haiku")).toBe(
			LATEST_MODEL_BY_FAMILY.haiku,
		);
		expect(resolveFamilyAliasModel("fable", "fable")).toBe(
			LATEST_MODEL_BY_FAMILY.fable,
		);
	});

	test("resolveFamilyAliasModel returns a concrete (non-matching-family) value trimmed but otherwise unchanged", () => {
		expect(resolveFamilyAliasModel("claude-opus-4-8", "opus")).toBe(
			"claude-opus-4-8",
		);
		expect(resolveFamilyAliasModel("  claude-opus-4-8  ", "opus")).toBe(
			"claude-opus-4-8",
		);
		// A different family's bare word is not an alias for this family — passed through trimmed.
		expect(resolveFamilyAliasModel("sonnet", "opus")).toBe("sonnet");
	});

	test("resolveStoredPolicyAliasModel resolves only exact bare supported aliases", () => {
		expect(resolveStoredPolicyAliasModel("  OPUS  ")).toBe(
			LATEST_MODEL_BY_FAMILY.opus,
		);
		expect(resolveStoredPolicyAliasModel("sonnet")).toBe(
			LATEST_MODEL_BY_FAMILY.sonnet,
		);
		expect(resolveStoredPolicyAliasModel("haiku")).toBe(
			LATEST_MODEL_BY_FAMILY.haiku,
		);
		expect(resolveStoredPolicyAliasModel("fable")).toBe(
			LATEST_MODEL_BY_FAMILY.fable,
		);
		for (const value of [
			"my-opus-experiment",
			"provider/claude-opus-5",
			"claude-opus-4-8",
		]) {
			expect(resolveStoredPolicyAliasModel(value)).toBe(value);
		}
	});
});

describe("getEndpointUrl — null when no endpoint (R3)", () => {
	const baseAccount: Account = {
		id: "test",
		name: "test-account",
		provider: "openai-compatible",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		api_key: null,
		custom_endpoint: null,
		rate_limited_until: null,
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limit_remaining: null,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
	} as Account;

	test("returns null when custom_endpoint is null", () => {
		expect(
			getEndpointUrl({ ...baseAccount, custom_endpoint: null }),
		).toBeNull();
	});

	test("returns null when custom_endpoint is undefined", () => {
		expect(
			getEndpointUrl({ ...baseAccount, custom_endpoint: undefined } as Account),
		).toBeNull();
	});

	test("returns null when custom_endpoint is empty string", () => {
		expect(getEndpointUrl({ ...baseAccount, custom_endpoint: "" })).toBeNull();
	});

	test("returns null when JSON blob has no endpoint field", () => {
		expect(
			getEndpointUrl({
				...baseAccount,
				custom_endpoint: JSON.stringify({ modelMappings: { opus: "gpt-4" } }),
			}),
		).toBeNull();
	});

	test("returns the endpoint for a plain string", () => {
		expect(
			getEndpointUrl({
				...baseAccount,
				custom_endpoint: "https://api.openrouter.ai/api/v1",
			}),
		).toBe("https://api.openrouter.ai/api/v1");
	});

	test("returns the endpoint from a JSON blob", () => {
		expect(
			getEndpointUrl({
				...baseAccount,
				custom_endpoint: JSON.stringify({
					endpoint: "https://api.openrouter.ai/api/v1",
				}),
			}),
		).toBe("https://api.openrouter.ai/api/v1");
	});

	test("returns the endpoint from a JSON blob with modelMappings", () => {
		expect(
			getEndpointUrl({
				...baseAccount,
				custom_endpoint: JSON.stringify({
					endpoint: "https://api.openrouter.ai/api/v1",
					modelMappings: { opus: "gpt-4" },
				}),
			}),
		).toBe("https://api.openrouter.ai/api/v1");
	});
});

describe("resolveCompatibleEndpoint — fail-closed (R3)", () => {
	const baseAccount: Account = {
		id: "test",
		name: "test-account",
		provider: "openai-compatible",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		api_key: null,
		custom_endpoint: null,
		rate_limited_until: null,
		rate_limit_status: null,
		rate_limit_reset: null,
		rate_limit_remaining: null,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
	} as Account;

	test("returns unavailable when custom_endpoint is null", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: null,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.endpoint).toBeUndefined();
		}
	});

	test("returns unavailable when custom_endpoint is empty string", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: "",
		});
		expect(result.ok).toBe(false);
	});

	test("returns unavailable when JSON blob has no endpoint field", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: JSON.stringify({ modelMappings: { opus: "gpt-4" } }),
		});
		expect(result.ok).toBe(false);
	});

	test("returns unavailable when the endpoint is not a valid URL", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: "not-a-url",
		});
		expect(result.ok).toBe(false);
	});

	test("returns a validated endpoint for a plain string", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: "https://api.openrouter.ai/api/v1",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.endpoint).toBe("https://api.openrouter.ai/api/v1");
		}
	});

	test("returns a validated endpoint from a JSON blob", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: JSON.stringify({
				endpoint: "https://api.openrouter.ai/api/v1",
			}),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.endpoint).toBe("https://api.openrouter.ai/api/v1");
		}
	});

	test("resolves a plain string and equivalent JSON blob identically", () => {
		const plain = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: "https://api.openrouter.ai/api/v1",
		});
		const json = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: JSON.stringify({
				endpoint: "https://api.openrouter.ai/api/v1",
			}),
		});
		expect(plain).toEqual(json);
	});

	test("strips a trailing slash from the endpoint", () => {
		const result = resolveCompatibleEndpoint({
			...baseAccount,
			custom_endpoint: "https://api.example.com/v1/",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.endpoint).toBe("https://api.example.com/v1");
		}
	});
});

/**
 * Vercel AI Gateway catch-all recipe (U4).
 *
 * Documents the model-mapping and priority contract an operator must configure
 * for the Vercel catch-all lane. These tests guard the documented recipe so a
 * refactor that breaks the ordered GLM resolution or rejects priority 100 is
 * caught before the docs are trusted.
 */
describe("Vercel AI Gateway catch-all recipe (U4)", () => {
	// The documented recipe: every Claude family maps to GLM Fast first, then
	// standard GLM, within a single openai-compatible account.
	const vercelMappings = {
		fable: ["zai/glm-5.2-fast", "zai/glm-5.2"],
		opus: ["zai/glm-5.2-fast", "zai/glm-5.2"],
		sonnet: ["zai/glm-5.2-fast", "zai/glm-5.2"],
		haiku: ["zai/glm-5.2-fast", "zai/glm-5.2"],
	};

	const vercelAccount: Account = {
		id: "vercel-gateway",
		name: "vercel-gateway",
		provider: "openai-compatible",
		model_mappings: JSON.stringify(vercelMappings),
		model_fallbacks: null,
		custom_endpoint: JSON.stringify({
			endpoint: "https://ai-gateway.vercel.sh/v1",
		}),
		priority: 100,
	} as Account;

	test("an ordered-array family mapping resolves to GLM Fast first and standard GLM second", () => {
		expect(getModelList("claude-sonnet-5", vercelAccount)).toEqual([
			"zai/glm-5.2-fast",
			"zai/glm-5.2",
		]);
	});

	test("a single-string family mapping still resolves to that model", () => {
		const singleStringAccount: Account = {
			...vercelAccount,
			model_mappings: JSON.stringify({ sonnet: "zai/glm-5.2" }),
		} as Account;

		expect(getModelList("claude-sonnet-5", singleStringAccount)).toEqual([
			"zai/glm-5.2",
		]);
	});

	test("every Claude family in the documented recipe resolves to a GLM target", () => {
		for (const familyModel of Object.values(LATEST_MODEL_BY_FAMILY)) {
			const resolved = getModelList(familyModel, vercelAccount);
			expect(resolved).not.toBeNull();
			expect(resolved?.length).toBeGreaterThan(0);
			expect(resolved?.[0]).toMatch(/^zai\/glm-5\.2/);
		}
	});

	test("an account with no configured mapping forwards the requested model unchanged", () => {
		const unmappedAccount: Account = {
			id: "unmapped",
			name: "unmapped",
			provider: "openai-compatible",
			model_mappings: null,
			model_fallbacks: null,
			custom_endpoint: null,
		} as Account;

		expect(getModelList("claude-sonnet-5", unmappedAccount)).toBeNull();
	});

	test("the documented priority 100 is accepted by the shared priority validator", () => {
		expect(validatePriority(100)).toBe(100);
	});

	test("the documented endpoint resolves to the Vercel AI Gateway URL", () => {
		expect(getEndpointUrl(vercelAccount)).toBe(
			"https://ai-gateway.vercel.sh/v1",
		);
	});
});
