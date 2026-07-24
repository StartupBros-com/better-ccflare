import { describe, expect, it } from "bun:test";
import { LATEST_MODEL_BY_FAMILY } from "@better-ccflare/core";
import { formatPolicyModel } from "./family-routing";

describe("formatPolicyModel", () => {
	it("resolves a bare family alias to its concrete latest model", () => {
		expect(formatPolicyModel("opus", "opus")).toBe(
			`opus → ${LATEST_MODEL_BY_FAMILY.opus}`,
		);
	});

	it("derives the family from the value itself when family is not supplied", () => {
		expect(formatPolicyModel("sonnet")).toBe(
			`sonnet → ${LATEST_MODEL_BY_FAMILY.sonnet}`,
		);
	});

	it("is case- and whitespace-tolerant when deriving an alias's own family", () => {
		expect(formatPolicyModel("  Haiku  ")).toBe(
			`Haiku → ${LATEST_MODEL_BY_FAMILY.haiku}`,
		);
	});

	it("returns a concrete model id unchanged", () => {
		expect(formatPolicyModel("claude-opus-4-8", "opus")).toBe(
			"claude-opus-4-8",
		);
		expect(formatPolicyModel("claude-opus-4-8")).toBe("claude-opus-4-8");
	});

	it("returns a custom vendor model id unchanged even though it is not a known alias", () => {
		expect(formatPolicyModel("vendor/claude-opus-preview", "opus")).toBe(
			"vendor/claude-opus-preview",
		);
	});
});
