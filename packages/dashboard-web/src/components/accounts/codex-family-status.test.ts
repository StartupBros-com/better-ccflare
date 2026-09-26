import { describe, expect, it } from "bun:test";
import type {
	CodexAccountCatalogStatus,
	CodexAccountFamilyDefault,
} from "../../lib/provider-model-defaults-api";
import { describeCodexFamilyStatus } from "./codex-family-status";

function family(
	overrides: Partial<CodexAccountFamilyDefault> = {},
): CodexAccountFamilyDefault {
	return {
		family: "opus",
		effectiveModel: "gpt-5.3-codex",
		source: "compiled_default",
		pinned: false,
		...overrides,
	};
}

const NONE_CATALOG: CodexAccountCatalogStatus = {
	source: "none",
	fetchedAt: null,
	stale: false,
};

describe("describeCodexFamilyStatus", () => {
	it("returns null when there is no family data (e.g. still loading)", () => {
		expect(describeCodexFamilyStatus(undefined, NONE_CATALOG)).toBeNull();
	});

	it("labels an account_mapping_pin as Pinned with the account-mapping source", () => {
		expect(
			describeCodexFamilyStatus(
				family({
					source: "account_mapping_pin",
					pinned: true,
					effectiveModel: "gpt-5.3-codex-pinned",
				}),
				NONE_CATALOG,
			),
		).toBe("Pinned — gpt-5.3-codex-pinned (account mapping)");
	});

	it("labels a global provider override as Pinned and names the unmapped-account reason", () => {
		expect(
			describeCodexFamilyStatus(
				family({
					source: "global_provider_override",
					pinned: true,
					effectiveModel: "operator-override-model",
					globalOverridePinsUnmappedAccount: true,
				}),
				NONE_CATALOG,
			),
		).toBe(
			"Pinned — operator-override-model (global provider override, no account-level mapping)",
		);
	});

	it("labels an automatic account_catalog default with a fresh-catalog suffix", () => {
		expect(
			describeCodexFamilyStatus(
				family({
					source: "account_catalog",
					pinned: false,
					effectiveModel: "gpt-5.6-sol",
				}),
				{ source: "own", fetchedAt: Date.now(), stale: false },
			),
		).toBe(
			"Automatic — current default gpt-5.6-sol (this account’s catalog, fresh)",
		);
	});

	it("labels an automatic provider_catalog_borrowed default as stale when the catalog is stale", () => {
		expect(
			describeCodexFamilyStatus(
				family({
					source: "provider_catalog_borrowed",
					pinned: false,
					effectiveModel: "gpt-5.6-sol",
				}),
				{
					source: "borrowed",
					fetchedAt: Date.now() - 999_999_999,
					stale: true,
					borrowedFrom: "other-account",
				},
			),
		).toBe(
			"Automatic — current default gpt-5.6-sol (shared catalog (borrowed), stale)",
		);
	});

	it("labels an automatic compiled_default with no catalog evidence and no freshness suffix", () => {
		expect(
			describeCodexFamilyStatus(
				family({ source: "compiled_default", pinned: false }),
				NONE_CATALOG,
			),
		).toBe("Automatic — current default gpt-5.3-codex (compiled default)");
	});

	it("falls back to a humanized raw source label for an unrecognized source value", () => {
		expect(
			describeCodexFamilyStatus(
				family({ source: "future_unknown_source", pinned: true }),
				NONE_CATALOG,
			),
		).toBe("Pinned — gpt-5.3-codex (future unknown source)");
	});
});
