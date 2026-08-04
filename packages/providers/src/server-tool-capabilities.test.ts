import { describe, expect, test } from "bun:test";

import {
	deriveServerToolRequirement,
	indexServerToolCapabilityProofs,
	resolveServerToolCapability,
	type ServerToolCapabilityProof,
	type ServerToolReplayAtom,
} from "./server-tool-capabilities";

function requireDefined<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) throw new Error(message);
	return value;
}

describe("deriveServerToolRequirement", () => {
	test("does not mistake an input-schema WebSearch function for a server tool", () => {
		expect(
			deriveServerToolRequirement({
				tools: [
					{
						name: "WebSearch",
						description:
							"A client function whose schema happens to look like search",
						input_schema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
			}),
		).toBeUndefined();
	});

	test("derives a frozen bounded requirement for the exact native variant in a mixed tool list", () => {
		const requirement = deriveServerToolRequirement({
			model: "claude-sonnet-4-5",
			tools: [
				{
					name: "lookup",
					description: "client function",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
					},
				},
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 3,
					allowed_domains: ["example.com"],
					user_location: {
						type: "approximate",
						country: "US",
						region: "FL",
						city: "Miami",
					},
				},
			],
		});

		expect(requirement).toMatchObject({
			revision: 1,
			declarations: [
				{
					type: "web_search_20250305",
					maxUses: 3,
					allowedDomains: ["example.com"],
					userLocation: {
						type: "approximate",
						country: "US",
						region: "FL",
						city: "Miami",
					},
				},
			],
			hasClientFunctions: true,
			replay: { input: [], output: [], requiresOutputReplay: true },
		});
		expect(typeof requirement?.profileId).toBe("string");
		expect(requirement?.profileId).toBe(
			deriveServerToolRequirement({
				tools: [
					{
						name: "different-client-function",
						input_schema: { type: "object" },
					},
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: 8,
						allowed_domains: ["different.example/path"],
						user_location: {
							type: "approximate",
							country: "CA",
							region: "ON",
							city: "Toronto",
						},
					},
				],
			})?.profileId,
		);
		expect(Object.isFrozen(requirement)).toBe(true);
		expect(Object.isFrozen(requirement?.declarations)).toBe(true);
		expect(JSON.stringify(requirement)).not.toContain("lookup");
		expect(JSON.stringify(requirement)).not.toContain("client function");
	});

	test("marks malformed exact declarations invalid without retaining opaque input", () => {
		expect(
			deriveServerToolRequirement({
				tools: [
					{ type: "web_search_20250305", name: "web_search", max_uses: 0 },
				],
			}),
		).toEqual({
			revision: 1,
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
			replay: { input: [], output: [], requiresOutputReplay: false },
		});
	});

	test("marks later native variants unsupported rather than treating them as the exact variant", () => {
		expect(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20260101", name: "web_search" }],
			}),
		).toEqual({
			revision: 1,
			unsupported: [{ type: "web_search_20260101" }],
			replay: { input: [], output: [], requiresOutputReplay: false },
		});
	});

	test("retains an unknown typed server declaration only as its unsupported type", () => {
		const requirement = deriveServerToolRequirement({
			tools: [
				{
					type: "computer_20250124",
					name: "computer",
					display_width_px: 1920,
					display_height_px: 1080,
					opaque_request_content: "must-not-be-retained",
				},
			],
		});

		expect(requirement).toMatchObject({
			revision: 1,
			unsupported: [{ type: "computer_20250124" }],
			replay: { input: [], output: [], requiresOutputReplay: false },
		});
		expect(requirement?.unsupported).toEqual([{ type: "computer_20250124" }]);
		expect(JSON.stringify(requirement)).not.toContain("must-not-be-retained");
		expect(JSON.stringify(requirement)).not.toContain("1920");
	});

	test("historical native and proxy-opaque blocks create replay obligations only", () => {
		const requirement = deriveServerToolRequirement({
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_1",
							name: "web_search",
							input: { query: "secret" },
						},
						{
							type: "web_search_tool_result",
							tool_use_id: "srvtoolu_1",
							content: [{ type: "web_search_result", title: "private" }],
						},
						{ type: "x_better_ccflare_server_tool", opaque: "ciphertext" },
					],
				},
			],
		});

		expect(requirement).toEqual({
			revision: 1,
			replay: {
				input: ["native-Anthropic"],
				output: ["native-Anthropic", "proxy-evidence-v1"],
				requiresOutputReplay: false,
			},
		});
		expect(Object.isFrozen(requirement?.replay.input)).toBe(true);
		expect(Object.isFrozen(requirement?.replay.output)).toBe(true);
		const inventedCombinedMode = ["native-Anthropic", "proxy-evidence-v1"].join(
			"+",
		);
		expect(JSON.stringify(requirement)).not.toContain(inventedCombinedMode);
	});

	test("preserves bounded domain paths and order while rejecting allow/block broadening", () => {
		const allowedDomains = [
			"example.com/docs/api",
			"api.example.com/v2/search",
			"example.com/*/articles",
		];
		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: allowedDomains,
					},
				],
			})?.declarations?.[0]?.allowedDomains,
		).toEqual(allowedDomains);

		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: ["example.com"],
						blocked_domains: ["example.com/private"],
					},
				],
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});

		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: Array.from(
							{ length: 11 },
							(_, index) => `host-${index}.example.com/path`,
						),
					},
				],
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});
	});

	test("accepts only ASCII bare hosts with optional paths in domain filters", () => {
		const invalidDomains = [
			"https://example.com/docs",
			"user@example.com/docs",
			"example.com@evil.test/docs",
			"example.com/docs?private=true",
			"example.com/docs#private",
			"*.example.com/docs",
			"exa mple.com/docs",
			"exämple.com/docs",
			"-example.com/docs",
			"example-.com/docs",
			"example..com/docs",
			".example.com/docs",
			"example.com./docs",
		];

		for (const domain of invalidDomains) {
			expect(
				deriveServerToolRequirement({
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							allowed_domains: [domain],
						},
					],
				}),
			).toMatchObject({
				invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
			});
		}

		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						blocked_domains: ["example.com/*/articles"],
					},
				],
			})?.declarations?.[0]?.blockedDomains,
		).toEqual(["example.com/*/articles"]);
	});

	test("rejects unknown location fields and preserves only admitted approximate location fields", () => {
		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						user_location: { type: "approximate" },
					},
				],
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});

		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						user_location: {
							type: "approximate",
							country: "US",
							region: "FL",
							precise_latitude: 25.7617,
						},
					},
				],
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});

		expect(
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						user_location: {
							type: "approximate",
							country: "US",
							region: "FL",
							city: "Miami",
						},
					},
				],
			})?.declarations?.[0]?.userLocation,
		).toEqual({
			type: "approximate",
			country: "US",
			region: "FL",
			city: "Miami",
		});
	});

	test("admits max_uses 1-8 only when web search is the sole hosted built-in", () => {
		for (const maxUses of [1, 8]) {
			expect(
				deriveServerToolRequirement({
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							max_uses: maxUses,
						},
					],
				})?.declarations?.[0]?.maxUses,
			).toBe(maxUses);
		}
		for (const maxUses of [0, 9]) {
			expect(
				deriveServerToolRequirement({
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							max_uses: maxUses,
						},
					],
				}),
			).toMatchObject({
				invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
			});
		}

		expect(
			deriveServerToolRequirement({
				tools: [
					{ type: "web_search_20250305", name: "web_search", max_uses: 3 },
					{ type: "web_search_20250305", name: "web_search" },
				],
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});
	});

	test("retains mixed client functions as one bit without retaining their registry", () => {
		const requirement = deriveServerToolRequirement({
			tools: [
				{
					name: "private_lookup_name",
					description: "private client function description",
					input_schema: {
						type: "object",
						properties: { private_query: { type: "string" } },
					},
				},
				{ type: "web_search_20250305", name: "web_search" },
			],
		});

		expect(requirement?.hasClientFunctions).toBe(true);
		const serialized = JSON.stringify(requirement);
		expect(serialized).not.toContain("private_lookup_name");
		expect(serialized).not.toContain("private client function description");
		expect(serialized).not.toContain("private_query");
	});

	test("admits absent or auto tool choice and rejects forced choice or explicit incompatible parallelism", () => {
		const absent = deriveServerToolRequirement({
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		});
		const automatic = deriveServerToolRequirement({
			tools: [{ type: "web_search_20250305", name: "web_search" }],
			tool_choice: { type: "auto" },
		});
		expect(absent?.profileId).toBe(automatic?.profileId);
		expect(typeof absent?.profileId).toBe("string");

		expect(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				tool_choice: { type: "tool", name: "web_search" },
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});
		expect(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				tool_choice: { type: "auto", disable_parallel_tool_use: true },
			}),
		).toMatchObject({
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
		});
	});

	test("uses stable low-cardinality profiles and distinct native versus proxy replay modes", () => {
		const first = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					allowed_domains: ["one.example/path"],
				},
			],
		});
		const second = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					allowed_domains: ["two.example/other"],
				},
			],
		});
		expect(first?.profileId).toBe(second?.profileId);
		expect(typeof first?.profileId).toBe("string");
		expect(first?.profileId ?? "").not.toContain("one.example");

		expect(
			deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
						],
					},
				],
			})?.replay,
		).toEqual({
			input: ["native-Anthropic"],
			output: [],
			requiresOutputReplay: false,
		});
		expect(
			deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "x_better_ccflare_server_tool", opaque: "ciphertext" },
						],
					},
				],
			})?.replay,
		).toEqual({
			input: [],
			output: ["proxy-evidence-v1"],
			requiresOutputReplay: false,
		});
	});

	test("requires output replay for every valid new declaration but not replay-only history", () => {
		const validDeclarations = [
			{ type: "web_search_20250305", name: "web_search" },
			{ type: "web_search_20250305", name: "web_search", max_uses: 3 },
			{
				type: "web_search_20250305",
				name: "web_search",
				allowed_domains: ["example.com/docs"],
			},
			{
				type: "web_search_20250305",
				name: "web_search",
				user_location: { type: "approximate", country: "US" },
			},
		];

		for (const declaration of validDeclarations) {
			const requirement = deriveServerToolRequirement({ tools: [declaration] });
			expect(requirement?.replay.input).toEqual([]);
			expect(requirement?.replay.output).toEqual([]);
			expect(requirement?.replay.requiresOutputReplay).toBe(true);
		}

		const replayOnly = deriveServerToolRequirement({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
						{
							type: "web_search_tool_result",
							tool_use_id: "srvtoolu_1",
							content: [],
						},
					],
				},
			],
		});
		expect(replayOnly?.declarations).toBeUndefined();
		expect(replayOnly?.replay).toEqual({
			input: ["native-Anthropic"],
			output: ["native-Anthropic"],
			requiresOutputReplay: false,
		});
	});

	test("keeps profile IDs stable across content values with the same admitted semantic shape", () => {
		const profileFor = (tool: Record<string, unknown>) =>
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search", ...tool }],
			})?.profileId;

		const allowedOne = profileFor({ allowed_domains: ["one.example/path"] });
		const allowedTwo = profileFor({
			allowed_domains: ["two.example/different-path"],
		});
		const maxOne = profileFor({ max_uses: 1 });
		const maxEight = profileFor({ max_uses: 8 });
		const countryOne = profileFor({
			user_location: { type: "approximate", country: "US" },
		});
		const countryTwo = profileFor({
			user_location: { type: "approximate", country: "CA" },
		});

		expect(typeof allowedOne).toBe("string");
		expect(allowedOne).toBe(allowedTwo);
		expect(maxOne).toBe(maxEight);
		expect(countryOne).toBe(countryTwo);
		expect([allowedOne, maxOne, countryOne].join("|")).not.toContain(
			"one.example",
		);
		expect([allowedOne, maxOne, countryOne].join("|")).not.toContain("US");
	});

	test("distinguishes allow, block, none, and bounded max-use profile shapes", () => {
		const profileFor = (tool: Record<string, unknown>) =>
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search", ...tool }],
			})?.profileId;

		const none = profileFor({});
		const allowed = profileFor({ allowed_domains: ["example.com/path"] });
		const blocked = profileFor({ blocked_domains: ["example.com/private"] });
		const boundedMaxUses = profileFor({ max_uses: 3 });

		expect(new Set([none, allowed, blocked, boundedMaxUses]).size).toBe(4);
	});

	test("distinguishes admitted location field shape", () => {
		const country = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					user_location: { type: "approximate", country: "US" },
				},
			],
		})?.profileId;
		const city = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					user_location: { type: "approximate", city: "Miami" },
				},
			],
		})?.profileId;

		expect(country).not.toBe(city);
	});

	test("distinguishes mixed-client presence", () => {
		const noClient = deriveServerToolRequirement({
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		})?.profileId;
		const mixedClient = deriveServerToolRequirement({
			tools: [
				{ name: "lookup", input_schema: { type: "object" } },
				{ type: "web_search_20250305", name: "web_search" },
			],
		})?.profileId;

		expect(noClient).not.toBe(mixedClient);
	});

	test("does not retain an attacker-controlled oversized tool type", () => {
		const attackerMarker = "private-attacker-tool-type";
		const attackerControlledType = `${attackerMarker}-${"x".repeat(32_000)}`;
		const requirement = deriveServerToolRequirement({
			tools: [{ type: attackerControlledType, name: "unknown" }],
		});

		expect(requirement?.unsupported?.length).toBe(1);
		expect(requirement?.unsupported?.[0]?.type).not.toContain(attackerMarker);
		const serialized = JSON.stringify(requirement);
		expect(serialized).not.toContain(attackerMarker);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_024);
	});

	test("caps retained issue records while still rejecting an unknown-tool flood", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: Array.from({ length: 512 }, (_, index) => ({
					type: `unknown_server_tool_${index}`,
					name: "unknown",
				})),
			}),
			"unknown-tool flood must produce a rejecting requirement",
		);

		expect(requirement?.unsupported?.length).toBeGreaterThan(0);
		expect(requirement?.unsupported?.length).toBeLessThanOrEqual(8);
		expect(
			resolveServerToolCapability(
				requirement,
				{
					candidateId: "flood-candidate",
					provider: "anthropic",
					authMode: "oauth",
					endpointClass: "anthropic_messages",
					model: "claude-sonnet-4-5",
					toolType: "web_search_20250305",
					profile: "default",
					inputReplay: [],
					outputReplay: [],
					providerContractRevision: "codex-responses-v1",
					replayDecoderRevision: "server-tool-replay-v1",
					requestTransport: "openai_responses",
					responseTransport: "openai_responses_sse",
				},
				indexServerToolCapabilityProofs([]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({ decision: "unknown", reason: "unsupported_requirement" });
	});

	test("deeply freezes requirements, replay, declarations, admitted values, and issue records", () => {
		const requirement = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					allowed_domains: ["example.com/docs"],
					user_location: { type: "approximate", country: "US", city: "Miami" },
				},
				{ type: "computer_20250124", name: "computer" },
			],
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
					],
				},
			],
		});
		const invalidRequirement = deriveServerToolRequirement({
			tools: [
				{ type: "web_search_20250305", name: "web_search", max_uses: 0 },
				{ type: "computer_20250124", name: "computer" },
			],
		});

		expect(Object.isFrozen(requirement)).toBe(true);
		expect(Object.isFrozen(requirement?.replay)).toBe(true);
		expect(Object.isFrozen(requirement?.declarations)).toBe(true);
		expect(Object.isFrozen(requirement?.declarations?.[0])).toBe(true);
		expect(
			Object.isFrozen(requirement?.declarations?.[0]?.allowedDomains),
		).toBe(true);
		expect(Object.isFrozen(requirement?.declarations?.[0]?.userLocation)).toBe(
			true,
		);
		expect(Object.isFrozen(requirement?.unsupported)).toBe(true);
		expect(Object.isFrozen(requirement?.unsupported?.[0])).toBe(true);
		expect(Object.isFrozen(invalidRequirement?.invalid)).toBe(true);
		expect(Object.isFrozen(invalidRequirement?.invalid?.[0])).toBe(true);
	});
});

describe("resolveServerToolCapability", () => {
	const requirement = requireDefined(
		deriveServerToolRequirement({
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		}),
		"valid web-search declaration must produce a requirement",
	);
	const declaration = requireDefined(
		requirement.declarations?.[0],
		"valid web-search requirement must retain its declaration",
	);
	const profileId = requireDefined(
		requirement.profileId,
		"valid web-search requirement must have a profile ID",
	);

	const tuple = {
		candidateId: "codex-account-1",
		provider: "codex",
		authMode: "oauth-subscription",
		endpointClass: "codex_responses",
		model: "gpt-5.6-sol",
		toolType: declaration.type,
		profile: profileId,
		inputReplay: requirement.replay.input,
		outputReplay: ["proxy-evidence-v1"],
		providerContractRevision: "codex-responses-v1",
		replayDecoderRevision: "server-tool-replay-v1",
		requestTransport: "openai_responses",
		responseTransport: "openai_responses_sse",
	} as const;

	const proof: ServerToolCapabilityProof = {
		revision: "proof-1",
		tuple,
		decision: "proven",
		provenance: "sanitized_fixture",
		owner: "providers/codex",
		verifiedAt: "2026-08-04T00:00:00.000Z",
		revalidateAfter: "2026-09-04T00:00:00.000Z",
		fixtureRevision: "fixture-1",
		contractRevision: "codex-web-search-v1",
		revalidationTriggers: [
			"tuple_change",
			"contract_change",
			"decoder_change",
			"observed_behavior_change",
		],
	};
	const proofIndex = indexServerToolCapabilityProofs([proof]);

	test("returns proven for an exact tuple with a current proof", () => {
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				proofIndex,
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({
			decision: "proven",
			proof,
		});
	});

	test("accepts either proxy-evidence or native-Anthropic output readiness on a first turn", () => {
		const nativeTuple = {
			...tuple,
			candidateId: "anthropic-account-1",
			provider: "anthropic",
			authMode: "oauth-subscription",
			endpointClass: "anthropic_messages",
			model: "claude-sonnet-4-5",
			outputReplay: ["native-Anthropic"],
			providerContractRevision: "anthropic-messages-20250305",
			replayDecoderRevision: "anthropic-native-v1",
			requestTransport: "anthropic_messages",
			responseTransport: "anthropic_sse",
		} as const;
		const nativeProof: ServerToolCapabilityProof = {
			...proof,
			revision: "proof-native-1",
			tuple: nativeTuple,
			provenance: "provider_documentation",
			owner: "providers/anthropic",
			fixtureRevision: "fixture-native-1",
			contractRevision: "anthropic-web-search-20250305",
		};

		expect(
			resolveServerToolCapability(
				requirement,
				nativeTuple,
				indexServerToolCapabilityProofs([nativeProof]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({ decision: "proven", proof: nativeProof });
		expect(
			resolveServerToolCapability(
				requirement,
				{ ...nativeTuple, outputReplay: [] },
				indexServerToolCapabilityProofs([]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({ decision: "unknown", reason: "requirement_mismatch" });
	});

	test("returns unsupported for an exact tuple with an unsupported proof", () => {
		const unsupported = {
			...proof,
			revision: "proof-2",
			decision: "unsupported" as const,
		};
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				indexServerToolCapabilityProofs([unsupported]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({
			decision: "unsupported",
			proof: unsupported,
		});
	});

	test("returns unknown for tuple drift, expired proof, and superseded proof", () => {
		expect(
			resolveServerToolCapability(
				requirement,
				{ ...tuple, model: "claude-opus-4-1" },
				proofIndex,
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({ decision: "unknown", reason: "no_exact_proof" });
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				proofIndex,
				"2026-10-05T00:00:00.000Z",
			),
		).toEqual({
			decision: "unknown",
			reason: "proof_expired",
		});
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				indexServerToolCapabilityProofs([
					{ ...proof, supersededBy: "proof-2" },
				]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({ decision: "unknown", reason: "proof_superseded" });
	});

	test("requires exact contract, profile, replay, transport, model, endpoint, and auth tuple equality", () => {
		const drifts = [
			{ providerContractRevision: "codex-responses-v2" },
			{ replayDecoderRevision: "server-tool-replay-v2" },
			{ requestTransport: "anthropic_messages" },
			{ responseTransport: "anthropic_sse" },
			{ model: "claude-opus-4-1" },
			{ normalizedEndpoint: "https://example.invalid/v1/responses" },
			{ endpointClass: "custom_responses" },
			{ authMode: "api_key" },
		];

		for (const drift of drifts) {
			expect(
				resolveServerToolCapability(
					requirement,
					{ ...tuple, ...drift },
					proofIndex,
					"2026-08-05T00:00:00.000Z",
				),
			).toEqual({
				decision: "unknown",
				reason: "no_exact_proof",
			});
		}
	});

	test("rejects incomplete proof lifecycle metadata until fixtures and revalidation policy are explicit", () => {
		const { fixtureRevision: _fixtureRevision, ...withoutFixture } = proof;
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				indexServerToolCapabilityProofs([withoutFixture]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({
			decision: "unknown",
			reason: "proof_incomplete",
		});

		const { revalidationTriggers: _revalidationTriggers, ...withoutTriggers } =
			proof;
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				indexServerToolCapabilityProofs([withoutTriggers]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({
			decision: "unknown",
			reason: "proof_incomplete",
		});
	});

	test("rejects tuples that are not canonically bound to the requirement", () => {
		const mismatches = [
			{ toolType: "web_search_20260101" },
			{ profile: `${requirement.profileId}-different` },
			{ outputReplay: [] },
		] as const;

		for (const mismatch of mismatches) {
			expect(
				resolveServerToolCapability(
					requirement,
					{ ...tuple, ...mismatch },
					proofIndex,
					"2026-08-05T00:00:00.000Z",
				),
			).toEqual({ decision: "unknown", reason: "requirement_mismatch" });
		}

		const historicalRequirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "web_search_tool_result",
								tool_use_id: "srvtoolu_1",
								content: [],
							},
						],
					},
				],
			}),
			"valid declaration with history must produce a requirement",
		);
		const historicalProfileId = requireDefined(
			historicalRequirement.profileId,
			"valid declaration with history must have a profile ID",
		);
		expect(historicalRequirement.replay.output).toEqual(["native-Anthropic"]);
		expect(
			resolveServerToolCapability(
				historicalRequirement,
				{
					...tuple,
					profile: historicalProfileId,
					inputReplay: historicalRequirement.replay.input,
					outputReplay: ["proxy-evidence-v1"],
				},
				indexServerToolCapabilityProofs([]),
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({ decision: "unknown", reason: "requirement_mismatch" });
	});

	test("accepts valid nonempty candidate input replay sets for an empty requirement", () => {
		const candidateInputReplaySets = [
			["native-Anthropic"],
			["proxy-evidence-v1"],
			["native-Anthropic", "proxy-evidence-v1"],
			["proxy-evidence-v1", "native-Anthropic"],
		] as const;
		const noProofs = indexServerToolCapabilityProofs([]);

		expect(requirement.replay.input).toEqual([]);
		for (const inputReplay of candidateInputReplaySets) {
			expect(
				resolveServerToolCapability(
					requirement,
					{ ...tuple, inputReplay },
					noProofs,
					"2026-08-05T00:00:00.000Z",
				),
			).toEqual({ decision: "unknown", reason: "no_exact_proof" });
		}
	});

	test("requires candidate replay modes to cover every historical output obligation", () => {
		const nativeHistory = requireDefined(
			deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "web_search_tool_result",
								tool_use_id: "srvtoolu_1",
								content: [],
							},
						],
					},
				],
			}),
			"native replay history must produce a requirement",
		);
		const mixedHistory = requireDefined(
			deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "web_search_tool_result",
								tool_use_id: "srvtoolu_1",
								content: [],
							},
							{
								type: "x_better_ccflare_server_tool",
								opaque: "ciphertext",
							},
						],
					},
				],
			}),
			"mixed replay history must produce a requirement",
		);
		const noProofs = indexServerToolCapabilityProofs([]);
		const decide = (
			replayRequirement: typeof nativeHistory,
			outputReplay: readonly ServerToolReplayAtom[],
		) =>
			resolveServerToolCapability(
				replayRequirement,
				{
					...tuple,
					inputReplay: replayRequirement.replay.input,
					outputReplay,
				},
				noProofs,
				"2026-08-05T00:00:00.000Z",
			);

		expect(decide(nativeHistory, ["native-Anthropic"])).toEqual({
			decision: "unknown",
			reason: "no_exact_proof",
		});
		expect(
			decide(nativeHistory, ["native-Anthropic", "proxy-evidence-v1"]),
		).toEqual({
			decision: "unknown",
			reason: "no_exact_proof",
		});
		expect(decide(nativeHistory, ["proxy-evidence-v1"])).toEqual({
			decision: "unknown",
			reason: "requirement_mismatch",
		});
		expect(decide(nativeHistory, [])).toEqual({
			decision: "unknown",
			reason: "requirement_mismatch",
		});
		expect(
			decide(mixedHistory, ["native-Anthropic", "proxy-evidence-v1"]),
		).toEqual({
			decision: "unknown",
			reason: "no_exact_proof",
		});
		expect(decide(mixedHistory, ["native-Anthropic"])).toEqual({
			decision: "unknown",
			reason: "requirement_mismatch",
		});
		expect(decide(mixedHistory, ["proxy-evidence-v1"])).toEqual({
			decision: "unknown",
			reason: "requirement_mismatch",
		});
	});

	test("indexes proofs once and resolves a refreshed proof independently of source order", () => {
		const oldProof = { ...proof, supersededBy: "proof-2" };
		const refreshedProof = {
			...proof,
			revision: "proof-2",
			verifiedAt: "2026-08-05T00:00:00.000Z",
			revalidateAfter: "2026-10-05T00:00:00.000Z",
		};
		const oldFirst = indexServerToolCapabilityProofs([
			oldProof,
			refreshedProof,
		]);
		const newFirst = indexServerToolCapabilityProofs([
			refreshedProof,
			oldProof,
		]);

		expect(Object.isFrozen(oldFirst)).toBe(true);
		expect(Object.isFrozen(newFirst)).toBe(true);
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				oldFirst,
				"2026-08-06T00:00:00.000Z",
			),
		).toEqual({
			decision: "proven",
			proof: refreshedProof,
		});
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				newFirst,
				"2026-08-06T00:00:00.000Z",
			),
		).toEqual({
			decision: "proven",
			proof: refreshedProof,
		});
	});

	test("canonicalizes replay atom order in proof keys and freezes indexed tuple arrays", () => {
		const canonicalTuple = {
			...tuple,
			candidateId: "simultaneous-replay-candidate",
			inputReplay: ["native-Anthropic", "proxy-evidence-v1"],
			outputReplay: ["native-Anthropic", "proxy-evidence-v1"],
		} as const;
		const simultaneousProof: ServerToolCapabilityProof = {
			...proof,
			revision: "proof-simultaneous-1",
			tuple: canonicalTuple,
		};
		const index = indexServerToolCapabilityProofs([simultaneousProof]);
		const reverseOrderedTuple = {
			...canonicalTuple,
			inputReplay: ["proxy-evidence-v1", "native-Anthropic"],
			outputReplay: ["proxy-evidence-v1", "native-Anthropic"],
		} as const;
		const entry = index.lookup(reverseOrderedTuple);

		expect(entry?.state).toBe("selected");
		if (entry?.state !== "selected") {
			throw new Error(
				"order-independent replay proof lookup must select a proof",
			);
		}
		expect(Object.isFrozen(entry.proof)).toBe(true);
		expect(Object.isFrozen(entry.proof.tuple)).toBe(true);
		expect(Object.isFrozen(entry.proof.tuple.inputReplay)).toBe(true);
		expect(Object.isFrozen(entry.proof.tuple.outputReplay)).toBe(true);
	});

	test("fails closed when an exact proof key has duplicate active proofs", () => {
		const duplicate = {
			...proof,
			revision: "proof-duplicate",
			verifiedAt: "2026-08-04T01:00:00.000Z",
		};
		const index = indexServerToolCapabilityProofs([proof, duplicate]);

		expect(Object.isFrozen(index)).toBe(true);
		expect(
			resolveServerToolCapability(
				requirement,
				tuple,
				index,
				"2026-08-05T00:00:00.000Z",
			),
		).toEqual({
			decision: "unknown",
			reason: "proof_ambiguous",
		});
	});
});
