import { describe, expect, it } from "bun:test";
import {
	compileQualityRoutingPolicy,
	isApprovedQualitySuccessor,
} from "./quality-routing-policy";

// Literal operator approvals from the U1 packet, never catalog-derived fixtures.
function approvedInput() {
	return {
		version: 1,
		assignments: [
			{
				line: "claude-fable",
				lane: "fable",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "gpt-astra",
				lane: "astra",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "claude-opus",
				lane: "opus",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "gpt-sol",
				lane: "opus",
				priority: 1,
				upgrade: "same-line-supported",
			},
			{
				line: "claude-sonnet",
				lane: "standard",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "claude-haiku",
				lane: "lightweight",
				priority: 0,
				upgrade: "same-line-supported",
			},
		],
		accounts: [
			{
				accountId: "native",
				provider: "anthropic",
				lines: ["claude-fable", "claude-opus", "claude-sonnet", "claude-haiku"],
				priority: 0,
			},
			{
				accountId: "alternate",
				provider: "codex",
				lines: ["gpt-astra", "gpt-sol"],
				priority: 0,
			},
		],
		fallbacks: [
			{ from: "fable", to: "astra" },
			{ from: "astra", to: "opus" },
		],
		spendGrants: [],
	};
}

describe("approved quality policy", () => {
	it.each([
		undefined,
		{},
		"",
		"   ",
	])("disables absent or empty input %j", (input) => {
		expect(compileQualityRoutingPolicy(input)).toBeNull();
	});

	it.each(
		[
			null,
			true,
			false,
			1,
			[],
			"{}",
			"false",
			{ enabled: true },
			{ version: "1" },
		].map((input) => [input]),
	)("rejects malformed nonempty input %j", (input) => {
		expect(() => compileQualityRoutingPolicy(input)).toThrow(
			"quality_routing_policy",
		);
	});

	it("validates empty enrollment before disabling choices", () => {
		const input = approvedInput();
		input.accounts = [];
		expect(compileQualityRoutingPolicy(input)?.choices).toEqual([]);
		expect(() => compileQualityRoutingPolicy({ ...input, paid: true })).toThrow(
			"unknown field",
		);
	});

	it("rejects unknown and duplicate lines, role reassignment and guessed upgrades", () => {
		for (const changes of [
			{ line: "new-frontier" },
			{ lane: "standard" },
			{ upgrade: "catalog-rank" },
			{ priority: "0" },
			{ priority: -1 },
			{ priority: 0.5 },
			{ priority: Number.NaN },
			{ priority: Number.POSITIVE_INFINITY },
			{ provider: "any" },
		]) {
			const input = approvedInput();
			const assignments = [
				{ ...input.assignments[0], ...changes },
				...input.assignments.slice(1),
			];
			expect(() =>
				compileQualityRoutingPolicy({ ...input, assignments }),
			).toThrow("quality_routing_policy");
		}
		const input = approvedInput();
		input.assignments[5] = { ...input.assignments[0] };
		expect(() => compileQualityRoutingPolicy(input)).toThrow("duplicate");
	});

	it("requires bounded explicit account IDs and provider-matching line enrollment", () => {
		for (const changes of [
			{ accountId: "" },
			{ accountId: "*" },
			{ accountId: "x".repeat(129) },
			{ accountId: 7 },
			{ provider: "openrouter" },
			{ provider: "codex" },
			{ lines: ["unknown"] },
			{ lines: ["claude-fable", "claude-fable"] },
			{ lines: [] },
			{ lines: "claude-fable" },
			{ priority: true },
			{ overageEnabled: true },
			{ spendGrant: true },
		]) {
			const input = approvedInput();
			expect(() =>
				compileQualityRoutingPolicy({
					...input,
					accounts: [{ ...input.accounts[0], ...changes }],
				}),
			).toThrow("quality_routing_policy");
		}
		const input = approvedInput();
		input.accounts.push({ ...input.accounts[0], accountId: " native " });
		expect(() => compileQualityRoutingPolicy(input)).toThrow("duplicate");
	});

	it("rejects enrollment in a known line without an approved assignment", () => {
		const input = approvedInput();
		input.assignments = input.assignments.filter(
			(item) => item.line !== "gpt-sol",
		);
		expect(() => compileQualityRoutingPolicy(input)).toThrow("unapproved line");
	});

	it("rejects cycles, duplicate edges, missing edges and worker escalation", () => {
		for (const fallbacks of [
			[{ from: "fable", to: "fable" }],
			[
				{ from: "fable", to: "astra" },
				{ from: "astra", to: "fable" },
			],
			[{ from: "standard", to: "fable" }],
			[
				{ from: "astra", to: "opus" },
				{ from: "astra", to: "opus" },
			],
			[{ from: "fable", to: "opus" }],
			[],
		]) {
			expect(() =>
				compileQualityRoutingPolicy({ ...approvedInput(), fallbacks }),
			).toThrow("fallback");
		}
	});

	it("requires a separate affirmative account-and-line spend authorization", () => {
		const input = approvedInput();
		const grant = {
			accountId: "alternate",
			line: "gpt-sol",
			authorization: "operator-approved",
			scope: "outside-subscription",
		} as const;
		expect(compileQualityRoutingPolicy(input)?.spendGrants).toEqual([]);
		expect(
			compileQualityRoutingPolicy({ ...input, spendGrants: [grant] })
				?.spendGrants,
		).toEqual([grant]);
		for (const changes of [
			{ accountId: "unenrolled" },
			{ accountId: "*" },
			{ line: "claude-opus" },
			{ authorization: true },
			{ authorization: "provider-enabled" },
			{ scope: "all-providers" },
			{ unlimited: true },
			{ line: "*" },
		]) {
			expect(() =>
				compileQualityRoutingPolicy({
					...input,
					spendGrants: [{ ...grant, ...changes }],
				}),
			).toThrow("quality_routing_policy");
		}
		expect(() =>
			compileQualityRoutingPolicy({ ...input, spendGrants: [grant, grant] }),
		).toThrow("duplicate");
	});

	it("rejects missing fields, wrong containers and oversized inputs", () => {
		for (const key of [
			"version",
			"assignments",
			"accounts",
			"fallbacks",
			"spendGrants",
		]) {
			const input: Record<string, unknown> = approvedInput();
			delete input[key];
			expect(() => compileQualityRoutingPolicy(input)).toThrow(
				"quality_routing_policy",
			);
		}
		for (const key of ["assignments", "accounts", "fallbacks", "spendGrants"]) {
			for (const value of [null, {}, false, "", [null], [true], [1]]) {
				expect(() =>
					compileQualityRoutingPolicy({ ...approvedInput(), [key]: value }),
				).toThrow("quality_routing_policy");
			}
		}
		expect(() =>
			compileQualityRoutingPolicy({
				...approvedInput(),
				accounts: Array.from({ length: 257 }, (_, index) => ({
					accountId: `a-${index}`,
					provider: "codex",
					lines: ["gpt-sol"],
					priority: 0,
				})),
			}),
		).toThrow("at most 256");
	});

	it("compiles the exact main suffixes and isolated worker roles", () => {
		const policy = compileQualityRoutingPolicy(approvedInput());
		expect(policy?.mainLadders).toEqual({
			auto: ["fable", "astra", "opus"],
			fable: ["fable", "astra", "opus"],
			astra: ["astra", "opus"],
			opus: ["opus"],
		});
		expect(policy?.workerLanes).toEqual({
			standard: ["standard"],
			lightweight: ["lightweight"],
			fable: ["fable"],
			astra: ["astra"],
			opus: ["opus"],
		});
		expect(policy?.lanes).toEqual({
			fable: ["claude-fable"],
			astra: ["gpt-astra"],
			opus: ["claude-opus", "gpt-sol"],
			standard: ["claude-sonnet"],
			lightweight: ["claude-haiku"],
		});
		expect(policy?.choices.map((choice) => choice.publicModelId)).toEqual([
			"claude-bccf-quality-auto",
			"claude-bccf-quality-fable",
			"claude-bccf-quality-astra",
			"claude-bccf-quality-opus",
		]);
	});

	it("canonicalizes unordered approvals without changing quality or the revision", () => {
		const input = approvedInput();
		const reversed = {
			spendGrants: [],
			fallbacks: [...input.fallbacks].reverse(),
			accounts: input.accounts
				.map((account) => ({ ...account, lines: [...account.lines].reverse() }))
				.reverse(),
			assignments: [...input.assignments].reverse(),
			version: 1,
		};
		expect(compileQualityRoutingPolicy(reversed)).toEqual(
			compileQualityRoutingPolicy(input),
		);
		expect(compileQualityRoutingPolicy(input)?.revision).toMatch(
			/^quality-policy-v1:[a-f0-9]{64}$/,
		);
	});

	it("changes the revision for effective priorities, assignments, upgrades and grants", () => {
		const input = approvedInput();
		const original = compileQualityRoutingPolicy(input);
		const prioritized = approvedInput();
		prioritized.assignments[3].priority = 0;
		prioritized.assignments[2].priority = 1;
		const enrolled = approvedInput();
		enrolled.accounts[0].priority = 1;
		const fixed = approvedInput();
		fixed.assignments[3].upgrade = "exact-only";
		const restricted = approvedInput();
		restricted.accounts[1].lines = ["gpt-astra"];
		restricted.assignments = restricted.assignments.filter(
			(item) => item.line !== "gpt-sol",
		);
		for (const changed of [
			prioritized,
			enrolled,
			fixed,
			restricted,
			{
				...input,
				spendGrants: [
					{
						accountId: "alternate",
						line: "gpt-sol",
						authorization: "operator-approved",
						scope: "outside-subscription",
					},
				],
			},
		]) {
			expect(compileQualityRoutingPolicy(changed)?.revision).not.toBe(
				original?.revision,
			);
		}
		expect(compileQualityRoutingPolicy(prioritized)?.lanes.opus).toEqual([
			"gpt-sol",
			"claude-opus",
		]);
		expect(compileQualityRoutingPolicy(prioritized)?.mainLadders.astra).toEqual(
			["astra", "opus"],
		);
	});

	it("copies and deeply freezes policy data without mutating caller state", () => {
		const input = approvedInput();
		const before = structuredClone(input);
		const policy = compileQualityRoutingPolicy(input);
		expect(input).toEqual(before);
		expect(Object.isFrozen(input)).toBe(false);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy?.accounts[0].lines)).toBe(true);
		expect(Object.isFrozen(policy?.mainLadders.auto)).toBe(true);
		input.accounts[0].lines.length = 0;
		expect(
			policy?.accounts.find((account) => account.accountId === "native")?.lines,
		).toEqual(["claude-fable", "claude-haiku", "claude-opus", "claude-sonnet"]);
	});

	it("approves same-line successors only with supported evidence on the exact enrolled account", () => {
		const policy = compileQualityRoutingPolicy(approvedInput());
		if (!policy) throw new Error("Expected an approved policy");
		const target = {
			accountId: "alternate",
			line: "gpt-sol" as const,
			predecessorModel: "sol-old",
			successorModel: "sol-new",
		};
		const evidence = {
			...target,
			provider: "codex" as const,
			source: "provider-catalog" as const,
			catalogRevision: "catalog-2",
			evidenceRef: "entry-17",
			supported: true,
		};
		expect(isApprovedQualitySuccessor(policy, target, evidence)).toBe(true);
		expect(
			isApprovedQualitySuccessor(policy, target, {
				...evidence,
				source: "authoritative-release",
			}),
		).toBe(true);
		for (const unapproved of [
			undefined,
			null,
			{},
			{ ...evidence, accountId: "other-account" },
			{ ...evidence, line: "gpt-astra" },
			{ ...evidence, provider: "anthropic" },
			{ ...evidence, supported: false },
			{ ...evidence, supported: "true" },
			{ ...evidence, source: "catalog-rank" },
			{ ...evidence, predecessorModel: "other-old" },
			{ ...evidence, successorModel: "other-new" },
			{ ...evidence, evidenceRef: "" },
			{ ...evidence, catalogRevision: "" },
		]) {
			expect(isApprovedQualitySuccessor(policy, target, unapproved)).toBe(
				false,
			);
		}
		const input = approvedInput();
		input.assignments[3].upgrade = "exact-only";
		const fixedPolicy = compileQualityRoutingPolicy(input);
		if (!fixedPolicy) throw new Error("Expected an approved policy");
		expect(isApprovedQualitySuccessor(fixedPolicy, target, evidence)).toBe(
			false,
		);
		expect(
			isApprovedQualitySuccessor(
				policy,
				{ ...target, accountId: "not-enrolled" },
				{ ...evidence, accountId: "not-enrolled" },
			),
		).toBe(false);
		expect(
			isApprovedQualitySuccessor(
				policy,
				{ ...target, line: "unknown" } as unknown as typeof target,
				{ ...evidence, line: "unknown" },
			),
		).toBe(false);
	});

	it("a promoted Sol successor changes neither Astra's lane nor approval revision", () => {
		const policy = compileQualityRoutingPolicy(approvedInput());
		if (!policy) throw new Error("Expected an approved policy");
		const revision = policy.revision;
		const target = {
			accountId: "alternate",
			line: "gpt-sol" as const,
			predecessorModel: "gpt-sol-generation-1",
			successorModel: "gpt-sol-generation-2",
		};
		const evidence = {
			...target,
			provider: "codex" as const,
			source: "provider-catalog" as const,
			catalogRevision: "new-order-sol-before-astra",
			evidenceRef: "sol-same-line",
			supported: true,
		};
		expect(isApprovedQualitySuccessor(policy, target, evidence)).toBe(true);
		expect(policy.lanes.astra).toEqual(["gpt-astra"]);
		expect(policy.lanes.standard).toEqual(["claude-sonnet"]);
		expect(policy.lanes.opus).toEqual(["claude-opus", "gpt-sol"]);
		expect(policy.revision).toBe(revision);
	});
});
