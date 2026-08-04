/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	getSupportedReasoningEfforts,
	isGpt56SolModel,
	resolveReasoningEffort,
	validateReasoningEffort,
} from "./reasoning";

describe("reasoning effort support", () => {
	it("exposes supported Claude and Codex effort matrices", () => {
		expect(getSupportedReasoningEfforts("claude-sonnet-4-6")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("claude-haiku-4-5")).toEqual([
			"low",
			"medium",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.3-codex")).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.4-mini")).toEqual([
			"low",
			"medium",
		]);
	});

	it("supports max only at the GPT-5.6 model boundary", () => {
		for (const model of ["gpt-5.6", "gpt-5.6-sol", "openai/gpt-5.6-preview"]) {
			expect(getSupportedReasoningEfforts(model)).toContain("max");
		}

		for (const model of ["gpt-5.60", "gpt-5.6preview", "gpt-5.5"]) {
			expect(getSupportedReasoningEfforts(model)).not.toContain("max");
		}
	});

	it("detects provider-prefixed GPT-5.6 Sol names without matching lookalikes", () => {
		for (const model of [
			"gpt-5.6-sol",
			"  openai/gpt-5.6-sol  ",
			"azure/openai/gpt-5.6-sol-preview",
		]) {
			expect(isGpt56SolModel(model)).toBe(true);
		}

		for (const model of [
			"gpt-5.6-terra",
			"gpt-5.6-solar",
			"openai/gpt-5.6-solstice",
			"gpt-5.60-sol",
		]) {
			expect(isGpt56SolModel(model)).toBe(false);
		}
	});

	it("accepts valid reasoning effort for supported Claude and Codex models", () => {
		expect(
			validateReasoningEffort("xhigh", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toBe("xhigh");
	});

	it("downgrades unsupported effort to nearest lower supported level", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "gpt-5.4-mini",
		});
		expect(resolved.effort).toBe("medium");
		expect(resolved.downgrades).toEqual([
			{
				model: "gpt-5.4-mini",
				from: "xhigh",
				to: "medium",
			},
		]);
	});

	it("rejects unsupported reasoning effort values", () => {
		expect(() =>
			validateReasoningEffort("extreme", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("keeps ultra invalid for GPT-5.6", () => {
		expect(() =>
			validateReasoningEffort("ultra", {
				targetModel: "gpt-5.6-sol",
			}),
		).toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("passes through effort unchanged when target model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "unknown-model-xyz",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});

	it("passes through effort unchanged when source model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-future-model-99",
			targetModel: "gpt-5.3-codex",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});
});
