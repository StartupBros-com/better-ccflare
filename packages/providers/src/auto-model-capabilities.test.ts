import { describe, expect, it, spyOn } from "bun:test";
import {
	createAutoCatalogEvidence,
	normalizeAutoModelCapabilities,
	resolveAutoModelTargets,
} from "./auto-model-capabilities";

describe("account-local approved line evidence", () => {
	const caps = normalizeAutoModelCapabilities("codex", {
		context_window: 272000,
		max_context_window: 872000,
		max_output_tokens: 32000,
		input_modalities: ["text"],
	});
	const models = [
		"gpt-6.1-sol",
		"gpt-6-astra",
		"gpt-5.6-sol",
		"gpt-99-unknown",
	].map((id) => ({ id, capabilities: caps }));
	it("resolves named lines independent of catalog order and keeps exact predecessors", () => {
		const catalog = createAutoCatalogEvidence({
			accountId: "a",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			provider: "codex",
			source: "live",
			models,
		});
		const sol = resolveAutoModelTargets(catalog, "gpt-sol", "gpt-5.6-sol");
		expect(sol.current?.physicalModel).toBe("gpt-6.1-sol");
		expect(sol.stored?.physicalModel).toBe("gpt-5.6-sol");
		expect(
			resolveAutoModelTargets(catalog, "gpt-astra").current?.physicalModel,
		).toBe("gpt-6-astra");
		expect(
			resolveAutoModelTargets(catalog, "claude-sonnet").current,
		).toBeNull();
		expect(sol.current?.catalogRevision).toBe(catalog.revision);
		expect(sol.current?.capabilityRevision).toBe(caps.revision);
		expect(Object.isFrozen(sol.current)).toBe(true);
	});
	it("rejects borrowed entitlement and unknown lines, and revisions ignore catalog rank", () => {
		expect(
			createAutoCatalogEvidence({
				accountId: "b",
				fetchedAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				provider: "codex",
				source: "shared",
				models,
			}),
		).toBeNull();
		const first = createAutoCatalogEvidence({
			accountId: "a",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			provider: "codex",
			source: "live",
			models,
		});
		const reordered = createAutoCatalogEvidence({
			accountId: "a",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			provider: "codex",
			source: "cached",
			models: [...models].reverse(),
		});
		expect(first?.revision).toBe(reordered?.revision);
		const unknown = createAutoCatalogEvidence({
			accountId: "a",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			provider: "codex",
			source: "live",
			models: [{ id: "gpt-99-astra", capabilities: caps }],
		});
		expect(resolveAutoModelTargets(unknown, "gpt-astra").current).toBeNull();
		const mutable = { ...caps, inputModalities: ["text"] };
		const frozen = createAutoCatalogEvidence({
			accountId: "a",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			provider: "codex",
			source: "live",
			models: [{ id: "gpt-6-astra", capabilities: mutable }],
		});
		mutable.inputModalities.push("image");
		expect(frozen?.models[0].capabilities?.inputModalities).toEqual(["text"]);
		const other = createAutoCatalogEvidence({
			accountId: "b",
			fetchedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			provider: "codex",
			source: "live",
			models,
		});
		expect(first?.revision).not.toBe(other?.revision);
	});
});

describe("Auto evidence freshness", () => {
	const input = {
		accountId: "freshness",
		provider: "codex" as const,
		source: "live" as const,
		models: [{ id: "gpt-6-astra" }],
		fetchedAt: 1_000_000,
		expiresAt: 1_060_000,
	};
	it("expires retained snapshots at the boundary without renewing on reads", () => {
		const clock = spyOn(Date, "now").mockReturnValue(input.fetchedAt);
		try {
			const evidence = createAutoCatalogEvidence(input);
			expect(evidence?.fetchedAt).toBe(input.fetchedAt);
			expect(evidence?.expiresAt).toBe(input.expiresAt);
			clock.mockReturnValue(input.expiresAt - 1);
			expect(
				resolveAutoModelTargets(evidence, "gpt-astra").current,
			).not.toBeNull();
			expect(
				resolveAutoModelTargets(evidence, "gpt-astra").current,
			).not.toBeNull();
			expect(evidence?.fetchedAt).toBe(input.fetchedAt);
			clock.mockReturnValue(input.expiresAt);
			expect(createAutoCatalogEvidence(input)).toBeNull();
			expect(
				resolveAutoModelTargets(evidence, "gpt-astra", "gpt-6-astra"),
			).toEqual({ current: null, stored: null });
			const renewed = createAutoCatalogEvidence({
				...input,
				fetchedAt: input.expiresAt,
				expiresAt: input.expiresAt + 60_000,
			});
			expect(renewed?.revision).toBe(evidence?.revision);
			expect(renewed).not.toBe(evidence);
			expect(
				resolveAutoModelTargets(renewed, "gpt-astra").current,
			).not.toBeNull();
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		NaN,
		Infinity,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
		1_000_001,
	])("rejects invalid or future acquisition time %s", (fetchedAt) => {
		const clock = spyOn(Date, "now").mockReturnValue(input.fetchedAt);
		try {
			expect(createAutoCatalogEvidence({ ...input, fetchedAt })).toBeNull();
			const valid = createAutoCatalogEvidence(input);
			if (!valid) throw new Error("expected fresh evidence");
			expect(
				resolveAutoModelTargets({ ...valid, fetchedAt }, "gpt-astra").current,
			).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		NaN,
		Infinity,
		-1,
		1.5,
		1_000_000,
		1_000_000 + 15 * 60_000 + 1,
	])("rejects invalid, elapsed or overlong expiry %s", (expiresAt) => {
		const clock = spyOn(Date, "now").mockReturnValue(input.fetchedAt);
		try {
			expect(createAutoCatalogEvidence({ ...input, expiresAt })).toBeNull();
			const valid = createAutoCatalogEvidence(input);
			if (!valid) throw new Error("expected fresh evidence");
			expect(
				resolveAutoModelTargets({ ...valid, expiresAt }, "gpt-astra").current,
			).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});
});

describe("exact-model capability normalization", () => {
	it("does not accept contradictory capacity fields", () => {
		const result = normalizeAutoModelCapabilities("codex", {
			context_window: 872000,
			max_context_window: 272000,
		});
		expect(result.contextWindow).toBeNull();
		expect(result.maxContextWindow).toBeNull();
	});
	it.each([
		0,
		-1,
		1.5,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		"128000",
		null,
	])("keeps malformed capacities unknown (%s)", (value) => {
		const result = normalizeAutoModelCapabilities("codex", {
			context_window: value,
			max_context_window: value,
			max_output_tokens: value,
		});
		expect(result.contextWindow).toBeNull();
		expect(result.maxContextWindow).toBeNull();
		expect(result.maxOutputTokens).toBeNull();
	});
	it.each([
		0,
		-1,
		101,
		NaN,
		Infinity,
		"95",
	])("rejects invalid usable percentages (%s)", (value) => {
		expect(
			normalizeAutoModelCapabilities("codex", {
				effective_context_window_percent: value,
			}).effectiveContextPercent,
		).toBeNull();
	});
	it.each(
		[[], ["text", 5], ["text", "unknown"], "image"].map((value) => ({ value })),
	)("does not guess malformed modalities (%s)", ({ value }) => {
		expect(
			normalizeAutoModelCapabilities("codex", { input_modalities: value })
				.inputModalities,
		).toBeNull();
	});
	it("retains native exact facts, boundaries and immutable semantic revisions", () => {
		const raw = {
			max_input_tokens: 1000000,
			max_tokens: 128000,
			capabilities: {
				image_input: { supported: true },
				tool_choice: { supported: false },
			},
		};
		const first = normalizeAutoModelCapabilities("anthropic", raw);
		expect(first.contextWindow).toBe(1000000);
		expect(first.maxOutputTokens).toBe(128000);
		expect(first.nativeCapabilities).toEqual(raw.capabilities);
		expect(
			normalizeAutoModelCapabilities("anthropic", {
				...raw,
				display_name: "renamed",
			}).revision,
		).toBe(first.revision);
		expect(
			normalizeAutoModelCapabilities("anthropic", { ...raw, max_tokens: 64000 })
				.revision,
		).not.toBe(first.revision);
		raw.capabilities.image_input.supported = false;
		expect(first.nativeCapabilities).toEqual({
			image_input: { supported: true },
			tool_choice: { supported: false },
		});
		expect(
			normalizeAutoModelCapabilities("codex", {
				max_output_tokens: Number.MAX_SAFE_INTEGER,
			}).maxOutputTokens,
		).toBe(Number.MAX_SAFE_INTEGER);
	});
	it("preserves sourced capacity, modalities and tool evidence without inventing output", () => {
		const capability = normalizeAutoModelCapabilities("codex", {
			context_window: 272000,
			max_context_window: 872000,
			effective_context_window_percent: 95,
			input_modalities: ["text", "image"],
			tool_mode: "function",
			supports_search_tool: true,
			experimental_supported_tools: ["web_search"],
		});
		expect(capability.contextWindow).toBe(272000);
		expect(capability.maxContextWindow).toBe(872000);
		expect(capability.effectiveContextPercent).toBe(95);
		expect(capability.maxOutputTokens).toBeNull();
		expect(capability.inputModalities).toEqual(["text", "image"]);
		expect(capability.toolEvidence).toEqual({
			tool_mode: "function",
			supports_search_tool: true,
			experimental_supported_tools: ["web_search"],
		});
		expect(Object.isFrozen(capability)).toBe(true);
		expect(Object.isFrozen(capability.inputModalities)).toBe(true);
	});
});
