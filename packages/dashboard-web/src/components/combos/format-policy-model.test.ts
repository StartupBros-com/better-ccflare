import { describe, expect, it } from "bun:test";
import { LATEST_MODEL_BY_FAMILY } from "@better-ccflare/core";
import { formatPolicyModel, resolvePolicyModelAlias } from "./family-routing";

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

describe("resolvePolicyModelAlias", () => {
	it("identifies a bare family alias and resolves it to the concrete latest model", () => {
		expect(resolvePolicyModelAlias("opus", "opus")).toEqual({
			isAlias: true,
			trimmed: "opus",
			resolved: LATEST_MODEL_BY_FAMILY.opus,
		});
	});

	it("derives the family from the value itself when family is not supplied", () => {
		expect(resolvePolicyModelAlias("sonnet")).toEqual({
			isAlias: true,
			trimmed: "sonnet",
			resolved: LATEST_MODEL_BY_FAMILY.sonnet,
		});
	});

	it("trims whitespace before matching", () => {
		expect(resolvePolicyModelAlias("  haiku  ")).toEqual({
			isAlias: true,
			trimmed: "haiku",
			resolved: LATEST_MODEL_BY_FAMILY.haiku,
		});
	});

	it("reports non-alias for a concrete model id, even one that substring-matches a family", () => {
		expect(resolvePolicyModelAlias("claude-opus-4-8", "opus")).toEqual({
			isAlias: false,
			trimmed: "claude-opus-4-8",
		});
	});

	it("reports non-alias for a custom vendor model id that is not a known alias", () => {
		expect(
			resolvePolicyModelAlias("vendor/claude-opus-preview", "opus"),
		).toEqual({
			isAlias: false,
			trimmed: "vendor/claude-opus-preview",
		});
	});

	it("is the sole resolution step consumed by both formatPolicyModel and every alias-aware caller", () => {
		// formatPolicyModel must be derivable purely from this resolution plus
		// its own presentation — pins the single-source-of-truth contract so a
		// future edit can't let the two drift back out of sync.
		for (const [value, family] of [
			["opus", "opus"],
			["sonnet", undefined],
			["claude-opus-4-8", "opus"],
		] as const) {
			const resolution = resolvePolicyModelAlias(value, family);
			const expected = resolution.isAlias
				? `${resolution.trimmed} → ${resolution.resolved}`
				: value;
			expect(formatPolicyModel(value, family)).toBe(expected);
		}
	});
});
