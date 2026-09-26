import { describe, expect, it } from "bun:test";
import type { ProviderModelDefaultField } from "../../lib/provider-model-defaults-api";
import {
	providerFieldHint,
	providerFieldPlaceholder,
	providerFieldResetTitle,
} from "./provider-model-defaults-copy";

function field(
	overrides: Partial<ProviderModelDefaultField> = {},
): ProviderModelDefaultField {
	return {
		family: "opus",
		factory: "gpt-5.3-codex",
		override: null,
		effective: "gpt-5.3-codex",
		...overrides,
	};
}

describe("providerFieldPlaceholder", () => {
	it("shows the effective value, not the factory value, when they differ", () => {
		expect(
			providerFieldPlaceholder(
				field({ factory: "gpt-5.3-codex", effective: "gpt-5.6-sol" }),
			),
		).toBe("gpt-5.6-sol (current default)");
	});

	it("falls back to the factory value when effective is empty", () => {
		expect(
			providerFieldPlaceholder(
				field({ factory: "gpt-5.3-codex", effective: "" }),
			),
		).toBe("gpt-5.3-codex (current default)");
	});
});

describe("providerFieldHint", () => {
	it("shows the factory value as the current default when there is no saved override", () => {
		expect(
			providerFieldHint(
				field({
					factory: "gpt-5.3-codex",
					effective: "gpt-5.3-codex",
					override: null,
				}),
				false,
			),
		).toBe(
			"Current default: gpt-5.3-codex. Accounts with no mapping of their own follow their own catalog first; this is only the fallback.",
		);
	});

	// The draft was reset to empty (handleReset) but Save has not run yet, so
	// the server-reported `effective` still equals the saved override, not an
	// account's own catalog. Attributing it to "an account's own catalog" —
	// the bug this test guards — would be wrong: only a saved override can
	// make `effective` diverge from `factory` for this provider-wide field.
	it("names the saved override, not an account's catalog, when the draft was cleared but not yet saved", () => {
		expect(
			providerFieldHint(
				field({
					factory: "gpt-5.3-codex",
					effective: "gpt-5.6-sol",
					override: "gpt-5.6-sol",
				}),
				false,
			),
		).toBe(
			"Saved override still applies: gpt-5.6-sol. Save to let accounts with no mapping of their own follow their catalog again, falling back to gpt-5.3-codex.",
		);
	});

	// `effective === override` once a saved override exists. "Without this
	// override" must name `factory` — what the field reverts to — never
	// `effective`, which would just name the override back to itself.
	it("shows what a customized field would revert to — the factory value, never the override's own effective value", () => {
		expect(
			providerFieldHint(
				field({
					factory: "gpt-5.3-codex",
					effective: "gpt-5.6-sol",
					override: "gpt-5.6-sol",
				}),
				true,
			),
		).toBe("Customized. Without this override: gpt-5.3-codex.");
	});
});

describe("providerFieldResetTitle", () => {
	it("names the factory value when there is no saved override", () => {
		expect(
			providerFieldResetTitle(
				field({
					factory: "gpt-5.3-codex",
					effective: "gpt-5.3-codex",
					override: null,
				}),
			),
		).toBe(
			"Clear override (falls back to gpt-5.3-codex for accounts with no catalog of their own)",
		);
	});

	// Same bug as the hint: `effective === override` here, and the title must
	// still name `factory` — the value clearing actually reverts to — not the
	// override it is clearing.
	it("names the factory value, not the saved override's effective value, as what clearing reverts to", () => {
		expect(
			providerFieldResetTitle(
				field({
					factory: "gpt-5.3-codex",
					effective: "gpt-5.6-sol",
					override: "gpt-5.6-sol",
				}),
			),
		).toBe(
			"Clear override (falls back to gpt-5.3-codex for accounts with no catalog of their own)",
		);
	});
});
