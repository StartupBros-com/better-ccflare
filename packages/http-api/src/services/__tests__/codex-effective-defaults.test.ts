import { afterEach, describe, expect, it } from "bun:test";
import { setForceAccountModel } from "@better-ccflare/core";
import {
	clearDerivedProviderModelDefaults,
	setDerivedAccountModelDefaults,
	setDerivedProviderWideModelDefaults,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import { resolveCodexRequestModel } from "@better-ccflare/providers/codex";
import type { Account } from "@better-ccflare/types";
import { resolveCodexAccountFamilyDefault } from "../codex-effective-defaults";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-codex",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		model_mappings: null,
		custom_endpoint: null,
		model_fallbacks: null,
		...overrides,
	} as Account;
}

const NONE_CATALOG = { source: "none" } as const;

// `resolveCodexAccountFamilyDefault`'s `effectiveModel` is always
// `resolveCodexRequestModel(family, account)` — the exact function request
// routing calls. Every test below re-derives its own expectation from that
// same function (never a hand-picked literal that could quietly drift from
// it) so a regression that reintroduces a second, disagreeing resolver fails
// here immediately.
afterEach(() => {
	clearDerivedProviderModelDefaults();
	setProviderModelDefaultOverrides({});
	setForceAccountModel(false);
});

describe("resolveCodexAccountFamilyDefault", () => {
	it("reports an account_mapping_pin when model_mappings sets the family", () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ opus: "gpt-5.3-codex-pinned" }),
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: NONE_CATALOG,
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "account_mapping_pin",
			pinned: true,
		});
		expect(result.effectiveModel).toBe("gpt-5.3-codex-pinned");
	});

	it("prefers a legacy custom_endpoint.modelMappings pin over model_mappings for the same family", () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ opus: "from-model-mappings" }),
			custom_endpoint: JSON.stringify({
				endpoint: "https://example.test",
				modelMappings: { opus: "from-custom-endpoint" },
			}),
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: NONE_CATALOG,
		});
		expect(result.source).toBe("custom_endpoint_mapping");
		expect(result.effectiveModel).toBe(
			resolveCodexRequestModel("opus", account),
		);
		expect(result.effectiveModel).toBe("from-custom-endpoint");
		expect(result.pinned).toBe(true);
	});

	it("reports a deprecated model_fallbacks source only when nothing else set the family", () => {
		const account = makeAccount({
			model_fallbacks: JSON.stringify({ opus: "fallback-model" }),
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: NONE_CATALOG,
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "model_fallbacks",
			pinned: true,
		});
		expect(result.effectiveModel).toBe("fallback-model");
	});

	it("does not let model_fallbacks override an existing model_mappings pin (matches request-time merge order)", () => {
		const account = makeAccount({
			model_mappings: JSON.stringify({ opus: "from-model-mappings" }),
			model_fallbacks: JSON.stringify({ opus: "should-not-win" }),
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: NONE_CATALOG,
		});
		expect(result.source).toBe("account_mapping_pin");
		expect(result.effectiveModel).toBe(
			resolveCodexRequestModel("opus", account),
		);
		expect(result.effectiveModel).toBe("from-model-mappings");
	});

	describe("environment mapping", () => {
		const originalEnv = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
		afterEach(() => {
			if (originalEnv === undefined) {
				delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
			} else {
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = originalEnv;
			}
		});

		it("reports an environment_mapping source when only the env var sets the family", () => {
			process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = JSON.stringify({
				opus: "from-env",
			});
			const account = makeAccount();
			const result = resolveCodexAccountFamilyDefault(account, "opus", {
				catalog: NONE_CATALOG,
			});
			expect(result).toEqual({
				family: "opus",
				effectiveModel: resolveCodexRequestModel("opus", account),
				source: "environment_mapping",
				pinned: true,
			});
			expect(result.effectiveModel).toBe("from-env");
		});
	});

	it("reports global_provider_override and flags the unmapped-account pin when no account-level mapping exists", () => {
		setProviderModelDefaultOverrides({
			codex: { opus: "operator-override-model" },
		});
		const account = makeAccount();
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			globalOverride: "operator-override-model",
			catalog: NONE_CATALOG,
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "global_provider_override",
			pinned: true,
			globalOverridePinsUnmappedAccount: true,
		});
		expect(result.effectiveModel).toBe("operator-override-model");
	});

	it("prefers an account-level pin over a global provider override", () => {
		setProviderModelDefaultOverrides({
			codex: { opus: "operator-override-model" },
		});
		const account = makeAccount({
			model_mappings: JSON.stringify({ opus: "account-pin" }),
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			globalOverride: "operator-override-model",
			catalog: NONE_CATALOG,
		});
		expect(result.source).toBe("account_mapping_pin");
		expect(result.effectiveModel).toBe(
			resolveCodexRequestModel("opus", account),
		);
		expect(result.effectiveModel).toBe("account-pin");
	});

	it("reports account_catalog as automatic when the account has its own listing and nothing pins it", () => {
		const account = makeAccount();
		setDerivedAccountModelDefaults("codex", account.id, {
			opus: "gpt-5.6-sol",
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: { source: "own" },
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "account_catalog",
			pinned: false,
		});
		expect(result.effectiveModel).toBe("gpt-5.6-sol");
	});

	it("reports provider_catalog_borrowed as automatic when only a shared listing exists", () => {
		const account = makeAccount();
		setDerivedProviderWideModelDefaults("codex", { opus: "gpt-5.6-sol" });
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: { source: "borrowed", borrowedFrom: "other-account" },
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "provider_catalog_borrowed",
			pinned: false,
		});
		expect(result.effectiveModel).toBe("gpt-5.6-sol");
	});

	it("reports compiled_default as automatic when there is no catalog evidence at all", () => {
		const account = makeAccount();
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: NONE_CATALOG,
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "compiled_default",
			pinned: false,
		});
		expect(result.effectiveModel).toBe("gpt-5.3-codex");
	});

	it("does not let an exact-model-id mapping key change the family-level report", () => {
		// "claude-opus-4-8" is an exact Anthropic model id, not the family key
		// "opus" — `getConfiguredModelMapping` only matches a family key when no
		// exact-id key exists, so this must fall through exactly as if
		// model_mappings were unset for this family.
		const account = makeAccount({
			model_mappings: JSON.stringify({
				"claude-opus-4-8": "should-not-apply",
			}),
		});
		const result = resolveCodexAccountFamilyDefault(account, "opus", {
			catalog: NONE_CATALOG,
		});
		expect(result).toEqual({
			family: "opus",
			effectiveModel: resolveCodexRequestModel("opus", account),
			source: "compiled_default",
			pinned: false,
		});
		expect(result.effectiveModel).not.toBe("should-not-apply");
		expect(result.effectiveModel).toBe("gpt-5.3-codex");
	});

	describe("force-account-model mode", () => {
		// In this mode `mapModelName` (which `resolveCodexRequestModel` calls
		// first) returns its input unchanged, so none of the four account-level
		// pins below are actually applied when routing a request — attribution
		// must agree and not claim one of them.
		afterEach(() => {
			setForceAccountModel(false);
		});

		it("does not report an account_mapping_pin that the routed request will not receive", () => {
			const account = makeAccount({
				model_mappings: JSON.stringify({ opus: "gpt-5.3-codex-pinned" }),
			});
			setForceAccountModel(true);
			const result = resolveCodexAccountFamilyDefault(account, "opus", {
				catalog: NONE_CATALOG,
			});
			expect(result.source).not.toBe("account_mapping_pin");
			expect(result.pinned).toBe(false);
			expect(result.source).toBe("compiled_default");
			expect(result.effectiveModel).toBe(
				resolveCodexRequestModel("opus", account),
			);
			expect(result.effectiveModel).not.toBe("gpt-5.3-codex-pinned");
		});

		it("does not report a custom_endpoint_mapping pin that the routed request will not receive", () => {
			const account = makeAccount({
				custom_endpoint: JSON.stringify({
					endpoint: "https://example.test",
					modelMappings: { opus: "from-custom-endpoint" },
				}),
			});
			setForceAccountModel(true);
			const result = resolveCodexAccountFamilyDefault(account, "opus", {
				catalog: NONE_CATALOG,
			});
			expect(result.source).not.toBe("custom_endpoint_mapping");
			expect(result.pinned).toBe(false);
			expect(result.effectiveModel).toBe(
				resolveCodexRequestModel("opus", account),
			);
			expect(result.effectiveModel).not.toBe("from-custom-endpoint");
		});

		it("does not report an environment_mapping pin that the routed request will not receive", () => {
			const originalEnv = process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
			process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = JSON.stringify({
				opus: "from-env",
			});
			const account = makeAccount();
			setForceAccountModel(true);
			try {
				const result = resolveCodexAccountFamilyDefault(account, "opus", {
					catalog: NONE_CATALOG,
				});
				expect(result.source).not.toBe("environment_mapping");
				expect(result.pinned).toBe(false);
				expect(result.effectiveModel).toBe(
					resolveCodexRequestModel("opus", account),
				);
				expect(result.effectiveModel).not.toBe("from-env");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS;
				} else {
					process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS = originalEnv;
				}
			}
		});

		it("does not report a model_fallbacks pin that the routed request will not receive", () => {
			const account = makeAccount({
				model_fallbacks: JSON.stringify({ opus: "fallback-model" }),
			});
			setForceAccountModel(true);
			const result = resolveCodexAccountFamilyDefault(account, "opus", {
				catalog: NONE_CATALOG,
			});
			expect(result.source).not.toBe("model_fallbacks");
			expect(result.pinned).toBe(false);
			expect(result.effectiveModel).toBe(
				resolveCodexRequestModel("opus", account),
			);
			expect(result.effectiveModel).not.toBe("fallback-model");
		});

		it("still reports global_provider_override in force mode, and it wins over an account-level pin that no longer applies", () => {
			// resolveProviderModelDefault (what the global-override/catalog/
			// compiled attribution — and resolveCodexRequestModel's own fallback
			// path — read) is not force-mode gated, so this must still apply even
			// though the account also has a model_mappings pin that force mode
			// now ignores.
			setProviderModelDefaultOverrides({
				codex: { opus: "operator-override-model" },
			});
			const account = makeAccount({
				model_mappings: JSON.stringify({
					opus: "account-pin-loses-in-force-mode",
				}),
			});
			setForceAccountModel(true);
			const result = resolveCodexAccountFamilyDefault(account, "opus", {
				globalOverride: "operator-override-model",
				catalog: NONE_CATALOG,
			});
			expect(result).toEqual({
				family: "opus",
				effectiveModel: resolveCodexRequestModel("opus", account),
				source: "global_provider_override",
				pinned: true,
				globalOverridePinsUnmappedAccount: true,
			});
			expect(result.effectiveModel).toBe("operator-override-model");
		});
	});
});
