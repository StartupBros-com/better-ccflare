import { describe, expect, test } from "bun:test";
import type { Account, ServerToolCapabilityTuple } from "@better-ccflare/types";

import {
	buildServerToolCapabilityProofKey,
	buildServerToolCapabilityTupleKey,
	deriveServerToolRequirement,
	indexServerToolCapabilityProofs,
	materializeProviderServerToolCapabilityDecision as materializeDecision,
	materializeProviderServerToolCapabilityTuple,
	resolveServerToolCapability,
	type ServerToolCapabilityProof,
	type ServerToolReplayAtom,
} from "./server-tool-capabilities";
import type { Provider, ProviderServerToolCapabilityContext } from "./types";

function capabilityAccountFixture(): Account {
	return {
		id: "capability-account-1",
		name: "Capability Account",
		provider: "fixture",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: true,
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://fixture.invalid/v1/responses",
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: "plan",
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function capabilityProvider(overrides: Partial<Provider> = {}): Provider {
	return {
		name: "fixture",
		canHandle: () => true,
		refreshToken: async () => ({
			accessToken: "token",
			expiresAt: 1,
			refreshToken: "refresh",
		}),
		buildUrl: () => "https://fixture.invalid/v1/responses",
		prepareHeaders: (headers) => new Headers(headers),
		parseRateLimit: () => ({ isRateLimited: false }),
		processResponse: async (response) => response,
		...overrides,
	};
}

function capabilityTupleFixture(
	overrides: Partial<ServerToolCapabilityTuple> = {},
): ServerToolCapabilityTuple {
	return {
		candidateId: "candidate-1",
		provider: "codex",
		authMode: "oauth-subscription",
		endpointClass: "codex_responses",
		normalizedEndpoint: "https://chatgpt.com/backend-api/codex/responses",
		model: "gpt-5.6-sol",
		toolType: "web_search_20250305",
		profile: "web-search-profile-1",
		optionProfile:
			"server-tool-option-profile-v1.sha256.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		responseMode: "streaming",
		mixedToolMode: "server_only",
		inputReplay: ["native-Anthropic", "proxy-evidence-v1"],
		outputReplay: ["native-Anthropic", "proxy-evidence-v1"],
		providerContractRevision: "codex-responses-v1",
		replayDecoderRevision: "server-tool-replay-v1",
		requestTransport: "openai_responses",
		responseTransport: "openai_responses_sse",
		...overrides,
	};
}

function capabilityProofFixture(
	tuple: ServerToolCapabilityTuple,
	overrides: Partial<ServerToolCapabilityProof> = {},
): ServerToolCapabilityProof {
	return {
		revision: "proof-fixture-1",
		tuple,
		decision: "proven",
		provenance: "sanitized_fixture",
		owner: "providers/fixture",
		verifiedAt: "2026-08-04T00:00:00.000Z",
		revalidateAfter: "2026-09-04T00:00:00.000Z",
		fixtureRevision: "fixture-1",
		contractRevision: "fixture-contract-1",
		revalidationTriggers: [
			"tuple_change",
			"contract_change",
			"decoder_change",
			"observed_behavior_change",
		],
		...overrides,
	};
}

function requireDefined<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) throw new Error(message);
	return value;
}

describe("deriveServerToolRequirement", () => {
	test("binds exact normalized options without exposing option values", () => {
		const first = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 2,
					allowed_domains: ["one.example/docs"],
					user_location: { type: "approximate", country: "US" },
				},
			],
		});
		const second = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 8,
					allowed_domains: ["two.example/docs"],
					user_location: { type: "approximate", country: "CA" },
				},
			],
		});

		const firstOptionProfile = (
			first as unknown as { optionProfileId?: string }
		).optionProfileId;
		const secondOptionProfile = (
			second as unknown as { optionProfileId?: string }
		).optionProfileId;
		expect(first?.profileId).toBe(second?.profileId);
		expect(firstOptionProfile).toMatch(
			/^server-tool-option-profile-v1\.sha256\.[a-f0-9]{64}$/,
		);
		expect(secondOptionProfile).not.toBe(firstOptionProfile);
		expect(firstOptionProfile).not.toContain("one.example");
		expect(firstOptionProfile).not.toContain("US");
	});

	test("derives closed response and mixed-tool modes and rejects invalid stream values", () => {
		const jsonServerOnly = deriveServerToolRequirement({
			stream: false,
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		}) as unknown as {
			responseMode?: string;
			mixedToolMode?: string;
		};
		const streamingMixed = deriveServerToolRequirement({
			stream: true,
			tools: [
				{ name: "lookup", input_schema: { type: "object" } },
				{ type: "web_search_20250305", name: "web_search" },
			],
		}) as unknown as {
			responseMode?: string;
			mixedToolMode?: string;
		};

		expect(jsonServerOnly).toMatchObject({
			responseMode: "json",
			mixedToolMode: "server_only",
		});
		expect(streamingMixed).toMatchObject({
			responseMode: "streaming",
			mixedToolMode: "server_and_client_functions",
		});
		expect(
			deriveServerToolRequirement({
				stream: "true",
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
		).toEqual({
			revision: 2,
			invalid: [{ type: "web_search_20250305", reason: "invalid_options" }],
			replay: { input: [], output: [], requiresOutputReplay: false },
		});
	});

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
			revision: 2,
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
			revision: 2,
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
			revision: 2,
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
			revision: 2,
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
							content: [
								{
									type: "web_search_result",
									title: "private",
									encrypted_content: "anthropic-opaque-content",
								},
							],
						},
						{
							type: "text",
							text: "cited answer",
							citations: [
								{
									type: "web_search_result_location",
									encrypted_index: "bccf1.A256GCM.proxy-envelope",
								},
							],
						},
					],
				},
			],
		});

		expect(requirement).toEqual({
			revision: 2,
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

	test("routes every bccf-prefixed opaque field to local proxy projection validation", () => {
		for (const proxyEnvelope of [
			"bccf",
			"bccf0.legacy",
			"bccf1.malformed",
			"bccf2.future",
		]) {
			const contentReplay = deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "web_search_tool_result",
								content: [
									{
										type: "web_search_result",
										encrypted_content: proxyEnvelope,
									},
								],
							},
						],
					},
				],
			})?.replay.output;
			const locationReplay = deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "text",
								text: "cited answer",
								citations: [
									{
										type: "web_search_result_location",
										encrypted_index: proxyEnvelope,
									},
								],
							},
						],
					},
				],
			})?.replay.output;

			expect(contentReplay).toEqual(["proxy-evidence-v1"]);
			expect(locationReplay).toEqual(["proxy-evidence-v1"]);
		}

		expect(
			deriveServerToolRequirement({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "web_search_tool_result",
								content: [
									{
										type: "web_search_result",
										encrypted_content: "anthropic-opaque-content",
									},
								],
							},
							{
								type: "text",
								text: "cited answer",
								citations: [
									{
										type: "web_search_result_location",
										encrypted_index: "anthropic-opaque-index",
									},
								],
							},
						],
					},
				],
			})?.replay.output,
		).toEqual(["native-Anthropic"]);
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
							{
								type: "web_search_tool_result",
								content: [
									{
										type: "web_search_result",
										encrypted_content: "bccf1.A256GCM.proxy-envelope",
									},
								],
							},
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
					optionProfile: "default-options",
					responseMode: "json",
					mixedToolMode: "server_only",
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
		optionProfile: requireDefined(
			requirement.optionProfileId,
			"valid web-search requirement must have an exact option profile",
		),
		responseMode: requireDefined(
			requirement.responseMode,
			"valid web-search requirement must have a response mode",
		),
		mixedToolMode: requireDefined(
			requirement.mixedToolMode,
			"valid web-search requirement must have a mixed-tool mode",
		),
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
				proofIndex,
				"2026-08-03T00:00:00.000Z",
			),
		).toEqual({
			decision: "unknown",
			reason: "proof_incomplete",
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
			{ optionProfile: `${requirement.optionProfileId}-different` },
			{
				responseMode:
					requirement.responseMode === "streaming" ? "json" : "streaming",
			},
			{
				mixedToolMode:
					requirement.mixedToolMode === "server_only"
						? "server_and_client_functions"
						: "server_only",
			},
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
								content: [
									{
										type: "web_search_result",
										encrypted_content: "anthropic-opaque-content",
									},
								],
							},
							{
								type: "text",
								text: "cited answer",
								citations: [
									{
										type: "web_search_result_location",
										encrypted_index: "bccf1.A256GCM.proxy-envelope",
									},
								],
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

describe("canonical server-tool capability identity", () => {
	const tuple = capabilityTupleFixture();

	test("binds exact option, response, and mixed-tool dimensions into tuple identity", () => {
		const exactTuple = {
			...tuple,
			optionProfile:
				"server-tool-option-profile-v1.sha256.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			responseMode: "streaming",
			mixedToolMode: "server_and_client_functions",
		} as unknown as ServerToolCapabilityTuple;
		const key = buildServerToolCapabilityTupleKey(exactTuple);

		expect(typeof key).toBe("string");
		for (const drift of [
			{ optionProfile: "different-exact-options" },
			{ responseMode: "json" },
			{ mixedToolMode: "server_only" },
		]) {
			expect(
				buildServerToolCapabilityTupleKey({
					...exactTuple,
					...drift,
				} as ServerToolCapabilityTuple),
			).not.toBe(key);
		}
	});

	test("binds every tuple field while canonicalizing replay order", () => {
		const key = buildServerToolCapabilityTupleKey(tuple);
		expect(typeof key).toBe("string");
		expect(key).toContain("server-tool-capability-tuple-v2");
		expect(key).not.toContain("server-tool-capability-tuple-v1");
		expect(buildServerToolCapabilityProofKey("proof-v2", tuple)).toMatch(
			/^server-tool-proof-v2\.sha256\.[a-f0-9]{64}$/,
		);
		expect(
			buildServerToolCapabilityTupleKey({
				...tuple,
				inputReplay: ["proxy-evidence-v1", "native-Anthropic"],
				outputReplay: ["proxy-evidence-v1", "native-Anthropic"],
			}),
		).toBe(key);

		const scalarDrifts: Partial<ServerToolCapabilityTuple>[] = [
			{ candidateId: "candidate-2" },
			{ provider: "anthropic" },
			{ authMode: "api-key" },
			{ endpointClass: "anthropic_messages" },
			{ normalizedEndpoint: "https://api.anthropic.com/v1/messages" },
			{ normalizedEndpoint: undefined },
			{ model: "gpt-5.6-terra" },
			{ toolType: "web_search_20260101" },
			{ profile: "web-search-profile-2" },
			{ providerContractRevision: "codex-responses-v2" },
			{ replayDecoderRevision: "server-tool-replay-v2" },
			{ requestTransport: "anthropic_messages" },
			{ responseTransport: "anthropic_sse" },
		];
		for (const drift of scalarDrifts) {
			expect(
				buildServerToolCapabilityTupleKey({ ...tuple, ...drift }),
			).not.toBe(key);
		}
		expect(
			buildServerToolCapabilityTupleKey({
				...tuple,
				inputReplay: ["native-Anthropic"],
			}),
		).not.toBe(key);
		expect(
			buildServerToolCapabilityTupleKey({
				...tuple,
				outputReplay: ["proxy-evidence-v1"],
			}),
		).not.toBe(key);
	});

	test("fails closed on duplicate or noncanonical replay atoms", () => {
		expect(
			buildServerToolCapabilityTupleKey({
				...tuple,
				inputReplay: ["native-Anthropic", "native-Anthropic"],
			}),
		).toBeUndefined();
		expect(
			buildServerToolCapabilityTupleKey({
				...tuple,
				outputReplay: ["provider-private-v1"],
			} as unknown as ServerToolCapabilityTuple),
		).toBeUndefined();
	});

	test("fails closed without invoking tuple accessors or accepting extensions", () => {
		let getterCalls = 0;
		const accessorTuple = capabilityTupleFixture();
		Object.defineProperty(accessorTuple, "provider", {
			configurable: true,
			enumerable: true,
			get() {
				getterCalls += 1;
				return "codex";
			},
		});

		expect(buildServerToolCapabilityTupleKey(accessorTuple)).toBeUndefined();
		expect(
			buildServerToolCapabilityProofKey("proof-accessor", accessorTuple),
		).toBeUndefined();
		expect(getterCalls).toBe(0);
		expect(
			buildServerToolCapabilityTupleKey({
				...tuple,
				unexpected: { retained: true },
			} as ServerToolCapabilityTuple),
		).toBeUndefined();
	});

	test("canonicalizes URL-shaped endpoints and rejects credentials, query, or fragment", () => {
		const canonical = buildServerToolCapabilityTupleKey(
			capabilityTupleFixture({
				normalizedEndpoint: "https://EXAMPLE.com:443/v1/responses",
			}),
		);
		expect(canonical).toBe(
			buildServerToolCapabilityTupleKey(
				capabilityTupleFixture({
					normalizedEndpoint: "https://example.com/v1/responses",
				}),
			),
		);
		for (const normalizedEndpoint of [
			"https://user@example.com/v1/responses",
			"https://user:password@example.com/v1/responses",
			"https://example.com/v1/responses?api_key=secret",
			"https://example.com/v1/responses#credential",
			"not-a-url-secret-bearing-value",
			"bedrock:profile:region",
			"ftp://example.com/private",
		]) {
			expect(
				buildServerToolCapabilityTupleKey(
					capabilityTupleFixture({ normalizedEndpoint }),
				),
			).toBeUndefined();
		}
	});

	test("binds proof revision and the entire canonical tuple without collisions", () => {
		const first = buildServerToolCapabilityProofKey("proof-1", tuple);
		const revised = buildServerToolCapabilityProofKey("proof-2", tuple);
		const otherTuple = buildServerToolCapabilityProofKey("proof-1", {
			...tuple,
			candidateId: "candidate-2",
		});
		expect(typeof first).toBe("string");
		expect(revised).not.toBe(first);
		expect(otherTuple).not.toBe(first);
		expect(new Set([first, revised, otherTuple]).size).toBe(3);
		expect(buildServerToolCapabilityProofKey("", tuple)).toBeUndefined();
		expect(
			buildServerToolCapabilityProofKey("proof-1", {
				...tuple,
				outputReplay: ["proxy-evidence-v1", "proxy-evidence-v1"],
			}),
		).toBeUndefined();
	});

	test("uses bounded tuple fields and fixed-size collision-resistant proof keys", () => {
		const maximumCandidate = capabilityTupleFixture({
			candidateId: "c".repeat(256),
			model: "m".repeat(512),
		});
		const maximumTupleKey = buildServerToolCapabilityTupleKey(maximumCandidate);
		expect(typeof maximumTupleKey).toBe("string");
		expect(maximumTupleKey?.length).toBeLessThan(8 * 1024);
		expect(
			buildServerToolCapabilityTupleKey({
				...maximumCandidate,
				candidateId: "c".repeat(257),
			}),
		).toBeUndefined();
		expect(
			buildServerToolCapabilityTupleKey({
				...maximumCandidate,
				model: "m".repeat(513),
			}),
		).toBeUndefined();
		expect(
			buildServerToolCapabilityTupleKey(
				capabilityTupleFixture({
					normalizedEndpoint: `https://example.com/${"x".repeat(2048)}`,
				}),
			),
		).toBeUndefined();
		expect(
			buildServerToolCapabilityTupleKey(
				capabilityTupleFixture({
					candidateId: "\0".repeat(256),
					provider: "\0".repeat(128),
					authMode: "\0".repeat(64),
					endpointClass: "\0".repeat(128),
					model: "\0".repeat(512),
					toolType: "\0".repeat(128),
					profile: "\0".repeat(256),
					providerContractRevision: "\0".repeat(128),
					replayDecoderRevision: "\0".repeat(128),
					requestTransport: "\0".repeat(128),
					responseTransport: "\0".repeat(128),
				}),
			),
		).toBeUndefined();

		const proofKeys = Array.from({ length: 512 }, (_, index) =>
			buildServerToolCapabilityProofKey(
				`proof-${index}`,
				capabilityTupleFixture({ candidateId: `candidate-${index}` }),
			),
		);
		expect(proofKeys.every((key) => typeof key === "string")).toBe(true);
		expect(new Set(proofKeys).size).toBe(proofKeys.length);
		const proofKeyLengths = new Set(proofKeys.map((key) => key?.length));
		expect(proofKeyLengths.size).toBe(1);
		expect(proofKeys[0]?.length).toBeLessThan(128);
		expect(
			proofKeys.reduce((total, key) => total + (key?.length ?? 0), 0),
		).toBe(proofKeys.length * (proofKeys[0]?.length ?? 0));
		expect(
			buildServerToolCapabilityProofKey("p".repeat(257), tuple),
		).toBeUndefined();
	});
});

describe("provider-owned server-tool tuple materialization", () => {
	test("passes a frozen content-minimal private copy and snapshots the tuple", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const account = capabilityAccountFixture();
		let observedContext: ProviderServerToolCapabilityContext | undefined;
		const provider = capabilityProvider({
			createServerToolCapabilityTuple(context) {
				observedContext = context;
				return {
					candidateId: context.candidateId,
					provider: "fixture",
					authMode: "oauth-subscription",
					endpointClass: "fixture_responses",
					normalizedEndpoint: context.account.customEndpoint ?? undefined,
					model: context.physicalModel,
					toolType: "web_search_20250305",
					profile: requirement.profileId ?? "missing",
					optionProfile: requirement.optionProfileId ?? "missing",
					responseMode: requirement.responseMode ?? "json",
					mixedToolMode: requirement.mixedToolMode ?? "server_only",
					inputReplay: ["proxy-evidence-v1", "native-Anthropic"],
					outputReplay: ["proxy-evidence-v1", "native-Anthropic"],
					providerContractRevision: "fixture-responses-v1",
					replayDecoderRevision: "fixture-replay-v1",
					requestTransport: "openai_responses",
					responseTransport: "openai_responses_sse",
				};
			},
		});

		const materialized = materializeProviderServerToolCapabilityTuple(
			provider,
			{
				candidateId: "combo-slot-7",
				account,
				path: "/v1/messages",
				query: "beta=true",
				physicalModel: "gpt-5.6-sol",
				requirements: requirement,
			},
		);

		expect(Object.isFrozen(observedContext)).toBe(true);
		expect(Object.keys(observedContext ?? {}).sort()).toEqual([
			"account",
			"candidateId",
			"endpointContract",
			"physicalModel",
			"requirements",
		]);
		expect(observedContext?.account).not.toBe(account);
		expect(Object.isFrozen(observedContext?.account)).toBe(true);
		expect(observedContext?.requirements).not.toBe(requirement);
		expect(Object.isFrozen(observedContext?.requirements)).toBe(true);
		expect(Object.isFrozen(observedContext?.requirements?.replay)).toBe(true);
		expect(observedContext).not.toHaveProperty("request");
		expect(observedContext).not.toHaveProperty("messages");
		expect(observedContext).not.toHaveProperty("tools");
		expect(observedContext).not.toHaveProperty("path");
		expect(observedContext).not.toHaveProperty("query");
		expect(observedContext?.endpointContract).toEqual({
			routeClass: "anthropic_messages",
			queryPresent: true,
		});
		expect(Object.isFrozen(observedContext?.endpointContract)).toBe(true);
		expect(Object.isFrozen(materialized)).toBe(true);
		expect(Object.isFrozen(materialized?.inputReplay)).toBe(true);
		expect(Object.isFrozen(materialized?.outputReplay)).toBe(true);
		expect(materialized?.inputReplay).toEqual([
			"native-Anthropic",
			"proxy-evidence-v1",
		]);
		expect(materialized?.outputReplay).toEqual([
			"native-Anthropic",
			"proxy-evidence-v1",
		]);

		account.provider = "mutated-after-materialization";
		account.custom_endpoint = "https://mutated.invalid";
		expect(observedContext?.account.provider).toBe("fixture");
		expect(observedContext?.account.customEndpoint).toBe(
			"https://fixture.invalid/v1/responses",
		);
	});

	test("treats a null refresh token as unconfigured capability metadata", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const account = capabilityAccountFixture();
		account.refresh_token = null;
		let observedAccount:
			| ProviderServerToolCapabilityContext["account"]
			| undefined;
		const tuple = materializeProviderServerToolCapabilityTuple(
			capabilityProvider({
				createServerToolCapabilityTuple(context) {
					observedAccount = context.account;
					return capabilityTupleFixture({
						candidateId: context.candidateId,
						provider: "fixture",
						normalizedEndpoint: context.account.customEndpoint ?? undefined,
						model: context.physicalModel,
						profile: requirement.profileId ?? "missing",
					});
				},
			}),
			{
				candidateId: "candidate-null-refresh-token",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "fixture-model",
				requirements: requirement,
			},
		);

		expect(tuple).toBeDefined();
		expect(observedAccount).toMatchObject({
			refreshTokenConfigured: false,
			legacyMirroredApiKey: false,
		});
	});

	test("mirrors raw transport truthiness and fails closed on whitespace endpoints", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const account = capabilityAccountFixture();
		account.api_key = "   ";
		account.refresh_token = "   ";
		account.access_token = "   ";
		account.custom_endpoint = "   ";
		let observedAccount:
			| ProviderServerToolCapabilityContext["account"]
			| undefined;
		let factoryCalls = 0;
		const tuple = materializeProviderServerToolCapabilityTuple(
			capabilityProvider({
				createServerToolCapabilityTuple(context) {
					factoryCalls += 1;
					observedAccount = context.account;
					return capabilityTupleFixture({
						candidateId: context.candidateId,
						provider: "fixture",
						model: context.physicalModel,
					});
				},
			}),
			{
				candidateId: "candidate-whitespace",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "fixture-model",
				requirements: requirement,
			},
		);

		expect(factoryCalls).toBe(1);
		expect(observedAccount).toMatchObject({
			apiKeyConfigured: true,
			refreshTokenConfigured: true,
			accessTokenConfigured: true,
			legacyMirroredApiKey: true,
			customEndpoint: null,
			customEndpointConfigured: true,
			unsafeCustomEndpoint: true,
		});
		expect(tuple).toBeUndefined();
	});

	test("binds configured custom endpoints into exact tuple identity", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const account = capabilityAccountFixture();
		const provider = capabilityProvider({
			createServerToolCapabilityTuple(context) {
				return capabilityTupleFixture({
					candidateId: context.candidateId,
					provider: "fixture",
					normalizedEndpoint: context.account.customEndpoint ?? undefined,
					model: context.physicalModel,
				});
			},
		});
		const materialize = () =>
			materializeProviderServerToolCapabilityTuple(provider, {
				candidateId: "candidate-endpoint",
				account,
				path: "/v1/messages",
				query: "",
				physicalModel: "fixture-model",
				requirements: requirement,
			});

		account.custom_endpoint = "https://EXAMPLE.com:443/v1/first";
		const first = materialize();
		expect(first?.normalizedEndpoint).toBe("https://example.com/v1/first");
		account.custom_endpoint = "https://example.com/v1/second";
		const second = materialize();
		expect(second?.normalizedEndpoint).toBe("https://example.com/v1/second");
		expect(buildServerToolCapabilityTupleKey(second as never)).not.toBe(
			buildServerToolCapabilityTupleKey(first as never),
		);

		expect(
			materializeProviderServerToolCapabilityTuple(
				capabilityProvider({
					createServerToolCapabilityTuple(context) {
						return capabilityTupleFixture({
							candidateId: context.candidateId,
							provider: "fixture",
							normalizedEndpoint: "https://example.com/v1/first",
							model: context.physicalModel,
						});
					},
				}),
				{
					candidateId: "candidate-endpoint",
					account,
					path: "/v1/messages",
					query: "",
					physicalModel: "fixture-model",
					requirements: requirement,
				},
			),
		).toBeUndefined();
		expect(
			materializeProviderServerToolCapabilityTuple(
				capabilityProvider({
					createServerToolCapabilityTuple(context) {
						return capabilityTupleFixture({
							candidateId: context.candidateId,
							provider: "fixture",
							normalizedEndpoint: undefined,
							model: context.physicalModel,
						});
					},
				}),
				{
					candidateId: "candidate-endpoint",
					account,
					path: "/v1/messages",
					query: "",
					physicalModel: "fixture-model",
					requirements: requirement,
				},
			),
		).toBeUndefined();
	});

	test("reduces raw route inputs to the same credential-free endpoint contract", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const observedContexts: string[] = [];
		const provider = capabilityProvider({
			createServerToolCapabilityTuple(context) {
				observedContexts.push(JSON.stringify(context));
				return capabilityTupleFixture({
					candidateId: context.candidateId,
					provider: "fixture",
					normalizedEndpoint: context.account.customEndpoint ?? undefined,
					model: context.physicalModel,
				});
			},
		});
		const account = capabilityAccountFixture();
		const common = {
			candidateId: "candidate-query-normalization",
			account,
			path: "/v1/messages",
			physicalModel: "fixture-model",
			requirements: requirement,
		};
		const selectionTuple = materializeProviderServerToolCapabilityTuple(
			provider,
			{ ...common, query: "api_key=selection-query-sentinel" },
		);
		const pretransportTuple = materializeProviderServerToolCapabilityTuple(
			provider,
			{ ...common, query: "?api_key=pretransport-query-sentinel" },
		);
		expect(observedContexts).toHaveLength(2);
		expect(observedContexts[0]).toBe(observedContexts[1]);
		expect(observedContexts.join(" ")).not.toContain(
			"selection-query-sentinel",
		);
		expect(observedContexts.join(" ")).not.toContain(
			"pretransport-query-sentinel",
		);
		expect(buildServerToolCapabilityTupleKey(selectionTuple as never)).toBe(
			buildServerToolCapabilityTupleKey(pretransportTuple as never),
		);

		let pathContext = "";
		materializeProviderServerToolCapabilityTuple(
			capabilityProvider({
				createServerToolCapabilityTuple(context) {
					pathContext = JSON.stringify(context);
					return undefined;
				},
			}),
			{
				...common,
				path: "/v1/messages/path-credential-sentinel",
				query: "",
			},
		);
		expect(pathContext).not.toContain("path-credential-sentinel");
		expect(JSON.parse(pathContext).endpointContract).toEqual({
			routeClass: "other",
			queryPresent: false,
		});
	});

	test("allows an absent or explicitly unsupported provider seam without throwing", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const context = {
			candidateId: "candidate-unsupported",
			account: capabilityAccountFixture(),
			path: "/v1/messages",
			query: "",
			physicalModel: "fixture-model",
			requirements: requirement,
		};
		expect(
			materializeProviderServerToolCapabilityTuple(
				capabilityProvider(),
				context,
			),
		).toBeUndefined();
		expect(
			materializeProviderServerToolCapabilityTuple(
				capabilityProvider({
					createServerToolCapabilityTuple: () => undefined,
				}),
				context,
			),
		).toBeUndefined();
	});

	test("never exposes credential bytes to capability factories, tuples, or proof keys", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const account = capabilityAccountFixture();
		const secretSentinels = [
			"u4-api-key-secret",
			"u4-refresh-token-secret",
			"u4-access-token-secret",
			"endpoint-user-secret",
			"endpoint-password-secret",
			"endpoint-query-secret",
		] as const;
		account.api_key = secretSentinels[0];
		account.refresh_token = secretSentinels[1];
		account.access_token = secretSentinels[2];
		account.custom_endpoint = `https://${secretSentinels[3]}:${secretSentinels[4]}@example.com/v1/responses?api_key=${secretSentinels[5]}`;
		let serializedFactoryContext = "";
		let capabilityAccountKeys: string[] = [];
		let capabilityAccountContext:
			| ProviderServerToolCapabilityContext["account"]
			| undefined;
		const provider = capabilityProvider({
			createServerToolCapabilityTuple(context) {
				serializedFactoryContext = JSON.stringify(context);
				capabilityAccountKeys = Object.keys(context.account).sort();
				capabilityAccountContext = context.account;
				return capabilityTupleFixture({
					candidateId: context.candidateId,
					provider: "fixture",
					model: context.physicalModel,
				});
			},
		});
		const tuple = materializeProviderServerToolCapabilityTuple(provider, {
			candidateId: "candidate-secret-sentinel",
			account,
			path: "/v1/messages",
			query: "",
			physicalModel: "fixture-model",
			requirements: requirement,
		});
		const proofKey =
			tuple === undefined
				? undefined
				: buildServerToolCapabilityProofKey("proof-secret-sentinel", tuple);

		expect(capabilityAccountKeys).toEqual([
			"accessTokenConfigured",
			"apiKeyConfigured",
			"billingType",
			"crossRegionMode",
			"customEndpoint",
			"customEndpointConfigured",
			"legacyMirroredApiKey",
			"provider",
			"refreshTokenConfigured",
			"unsafeCustomEndpoint",
		]);
		expect(capabilityAccountContext).toMatchObject({
			customEndpoint: null,
			customEndpointConfigured: true,
			unsafeCustomEndpoint: true,
		});
		expect(tuple).toBeUndefined();
		expect(proofKey).toBeUndefined();
		for (const sentinel of secretSentinels) {
			expect(serializedFactoryContext).not.toContain(sentinel);
			expect(JSON.stringify(tuple) ?? "").not.toContain(sentinel);
			expect(String(proofKey)).not.toContain(sentinel);
		}
	});

	test("rejects an asynchronous tuple factory before it can escape planning", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		expect(() =>
			materializeProviderServerToolCapabilityTuple(
				capabilityProvider({
					createServerToolCapabilityTuple: async () => undefined,
				} as unknown as Partial<Provider>),
				{
					candidateId: "candidate-async",
					account: capabilityAccountFixture(),
					path: "/v1/messages",
					query: "",
					physicalModel: "fixture-model",
					requirements: requirement,
				},
			),
		).toThrow();
	});

	test("does not invoke accessors on a provider-returned tuple", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		let getterCalls = 0;
		const tuple = capabilityTupleFixture({
			provider: "fixture",
			model: "fixture-model",
		});
		Object.defineProperty(tuple, "endpointClass", {
			configurable: true,
			enumerable: true,
			get() {
				getterCalls += 1;
				return "fixture_responses";
			},
		});

		expect(
			materializeProviderServerToolCapabilityTuple(
				capabilityProvider({
					createServerToolCapabilityTuple: () => tuple,
				}),
				{
					candidateId: tuple.candidateId,
					account: capabilityAccountFixture(),
					path: "/v1/messages",
					query: "",
					physicalModel: tuple.model,
					requirements: requirement,
				},
			),
		).toBeUndefined();
		expect(getterCalls).toBe(0);
	});

	test("rejects provider identity accessors and factory-reference drift", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		const context = {
			candidateId: "candidate-drift",
			account: capabilityAccountFixture(),
			path: "/v1/messages",
			query: "",
			physicalModel: "fixture-model",
			requirements: requirement,
		};

		let nameGetterCalls = 0;
		let accessorFactoryCalls = 0;
		const alternatingNameProvider = capabilityProvider({
			createServerToolCapabilityTuple: () => {
				accessorFactoryCalls += 1;
				return undefined;
			},
		});
		Object.defineProperty(alternatingNameProvider, "name", {
			configurable: true,
			enumerable: true,
			get() {
				nameGetterCalls += 1;
				return nameGetterCalls % 2 === 1 ? "fixture" : "mutated";
			},
		});
		expect(() =>
			materializeProviderServerToolCapabilityTuple(
				alternatingNameProvider,
				context,
			),
		).toThrow();
		expect(nameGetterCalls).toBe(0);
		expect(accessorFactoryCalls).toBe(0);

		let provider: Provider;
		provider = capabilityProvider({
			createServerToolCapabilityTuple: () => {
				provider.createServerToolCapabilityTuple = () => undefined;
				return capabilityTupleFixture({
					candidateId: context.candidateId,
					provider: "fixture",
					model: context.physicalModel,
				});
			},
		});
		expect(() =>
			materializeProviderServerToolCapabilityTuple(provider, context),
		).toThrow();
	});

	test("rejects materialization-context accessors and symbols before provider code", () => {
		const requirement = requireDefined(
			deriveServerToolRequirement({
				tools: [{ type: "web_search_20250305", name: "web_search" }],
			}),
			"valid server-tool request must produce requirements",
		);
		let getterCalls = 0;
		let factoryCalls = 0;
		const context = {
			candidateId: "candidate-context-accessor",
			account: capabilityAccountFixture(),
			path: "/v1/messages",
			query: "",
			physicalModel: "fixture-model",
			requirements: requirement,
			[Symbol("unexpected")]: true,
		};
		Object.defineProperty(context, "candidateId", {
			configurable: true,
			enumerable: true,
			get() {
				getterCalls += 1;
				return "candidate-context-accessor";
			},
		});
		const provider = capabilityProvider({
			createServerToolCapabilityTuple: () => {
				factoryCalls += 1;
				return undefined;
			},
		});

		expect(() =>
			materializeProviderServerToolCapabilityTuple(provider, context),
		).toThrow();
		expect(getterCalls).toBe(0);
		expect(factoryCalls).toBe(0);
	});
});

describe("provider-owned server-tool decision materialization", () => {
	const requirement = requireDefined(
		deriveServerToolRequirement({
			tools: [{ type: "web_search_20250305", name: "web_search" }],
		}),
		"valid server-tool request must produce requirements",
	);
	const tuple = capabilityTupleFixture({
		candidateId: "candidate-decision",
		provider: "fixture",
		model: "fixture-model",
		profile: requirement.profileId,
		optionProfile: requirement.optionProfileId,
		responseMode: requirement.responseMode,
		mixedToolMode: requirement.mixedToolMode,
	});

	test("returns an immutable conservative decision when no resolver exists", () => {
		expect(typeof materializeDecision).toBe("function");
		const decision = materializeDecision(
			capabilityProvider(),
			requirement,
			tuple,
		);
		expect(decision).toEqual({
			decision: "unknown",
			reason: "no_exact_proof",
		});
		expect(Object.isFrozen(decision)).toBe(true);
	});

	test("fails closed on a pre-v2 requirement snapshot", () => {
		expect(() =>
			materializeDecision(
				capabilityProvider(),
				{ ...requirement, revision: 1 } as never,
				tuple,
			),
		).toThrow("Invalid provider server-tool capability requirements");
	});

	test("snapshots a valid exact proof without retaining resolver objects", () => {
		const proof = capabilityProofFixture(tuple);
		let observedRequirements: unknown;
		let observedTuple: unknown;
		const provider = capabilityProvider({
			resolveServerToolCapability(requirements, candidateTuple) {
				observedRequirements = requirements;
				observedTuple = candidateTuple;
				return { decision: "proven", proof };
			},
		});
		const decision = materializeDecision(provider, requirement, tuple);

		expect(decision).toMatchObject({ decision: "proven" });
		expect(decision).not.toBe(proof);
		expect(Object.isFrozen(decision)).toBe(true);
		expect(observedRequirements).not.toBe(requirement);
		expect(Object.isFrozen(observedRequirements)).toBe(true);
		expect(observedTuple).not.toBe(tuple);
		expect(Object.isFrozen(observedTuple)).toBe(true);
		if (decision.decision !== "proven") {
			throw new Error("exact proof must remain proven");
		}
		expect(decision.proof).not.toBe(proof);
		expect(Object.isFrozen(decision.proof)).toBe(true);
		expect(Object.isFrozen(decision.proof.tuple)).toBe(true);
		expect(buildServerToolCapabilityTupleKey(decision.proof.tuple)).toBe(
			buildServerToolCapabilityTupleKey(tuple),
		);
	});

	test("rejects requirement-mismatched tuples before invoking provider code", () => {
		let resolverCalls = 0;
		const decision = materializeDecision(
			capabilityProvider({
				resolveServerToolCapability(_requirements, candidateTuple) {
					resolverCalls += 1;
					return {
						decision: "proven",
						proof: capabilityProofFixture(candidateTuple),
					};
				},
			}),
			requirement,
			{ ...tuple, profile: "mismatched-profile" },
		);

		expect(decision).toEqual({
			decision: "unknown",
			reason: "requirement_mismatch",
		});
		expect(Object.isFrozen(decision)).toBe(true);
		expect(resolverCalls).toBe(0);
	});

	test("bounds requirement snapshots by bytes, depth, nodes, arrays, and keys", () => {
		let resolverCalls = 0;
		const provider = capabilityProvider({
			resolveServerToolCapability() {
				resolverCalls += 1;
				return { decision: "unknown", reason: "no_exact_proof" };
			},
		});
		const deepRoot: Record<string, unknown> = {};
		let deepCursor = deepRoot;
		for (let depth = 0; depth < 20; depth += 1) {
			const next: Record<string, unknown> = {};
			deepCursor.child = next;
			deepCursor = next;
		}
		const nodeHeavy = Array.from({ length: 32 }, (_, row) =>
			Object.fromEntries(
				Array.from({ length: 16 }, (_unused, column) => [
					`field-${column}`,
					`${row}-${column}`,
				]),
			),
		);
		const invalidRequirements = [
			{ ...requirement, profileId: "x".repeat(64 * 1024 + 1) },
			{
				...requirement,
				declarations: Array.from({ length: 65 }, () => ({ type: "x" })),
			},
			{
				...requirement,
				declarations: [
					Object.fromEntries(
						Array.from({ length: 33 }, (_unused, index) => [
							`field-${index}`,
							index,
						]),
					),
				],
			},
			{ ...requirement, declarations: [deepRoot] },
			{ ...requirement, declarations: nodeHeavy },
		] as const;

		for (const invalidRequirement of invalidRequirements) {
			expect(() =>
				materializeDecision(provider, invalidRequirement as never, tuple),
			).toThrow();
		}
		expect(resolverCalls).toBe(0);
	});

	test("validates tiny decision and proof shapes before recursive descent", () => {
		let nestedTraversals = 0;
		const nestedTrap = new Proxy(
			{},
			{
				ownKeys() {
					nestedTraversals += 1;
					return [];
				},
			},
		);
		expect(() =>
			materializeDecision(
				capabilityProvider({
					resolveServerToolCapability: () =>
						({
							decision: "unknown",
							reason: "no_exact_proof",
							unexpected: nestedTrap,
						}) as never,
				}),
				requirement,
				tuple,
			),
		).toThrow();
		expect(nestedTraversals).toBe(0);

		expect(() =>
			materializeDecision(
				capabilityProvider({
					resolveServerToolCapability: () =>
						({
							decision: "proven",
							proof: {
								...capabilityProofFixture(tuple),
								unexpected: nestedTrap,
							},
						}) as never,
				}),
				requirement,
				tuple,
			),
		).toThrow();
		expect(nestedTraversals).toBe(0);
	});

	test("requires canonical UTC ISO proof instants in both decision paths", () => {
		for (const verifiedAt of [
			"2026-08-04T00:00:00",
			"2026-08-04T00:00:00+00:00",
			"August 4, 2026 00:00:00 GMT",
		]) {
			const proof = capabilityProofFixture(tuple, { verifiedAt });
			expect(() =>
				materializeDecision(
					capabilityProvider({
						resolveServerToolCapability: () => ({
							decision: "proven",
							proof,
						}),
					}),
					requirement,
					tuple,
					"2026-08-05T00:00:00.000Z",
				),
			).toThrow();
			expect(
				resolveServerToolCapability(
					requirement,
					tuple,
					indexServerToolCapabilityProofs([proof]),
					"2026-08-05T00:00:00.000Z",
				),
			).toEqual({ decision: "unknown", reason: "no_exact_proof" });
		}
	});

	test("rejects mismatched proof decisions, tuples, and unknown reasons", () => {
		for (const decision of [
			{
				decision: "proven",
				proof: capabilityProofFixture(tuple, { decision: "unsupported" }),
			},
			{
				decision: "proven",
				proof: capabilityProofFixture(
					capabilityTupleFixture({
						candidateId: tuple.candidateId,
						provider: tuple.provider,
						model: "different-model",
						profile: tuple.profile,
					}),
				),
			},
			{
				decision: "proven",
				proof: capabilityProofFixture(tuple, {
					fixtureRevision: undefined,
				}),
			},
			{
				decision: "proven",
				proof: capabilityProofFixture(tuple, {
					revalidateAfter: "2026-08-04T00:00:00.000Z",
				}),
			},
			{
				decision: "proven",
				proof: capabilityProofFixture(tuple, {
					verifiedAt: "2026-08-06T00:00:00.000Z",
				}),
			},
			{ decision: "unknown", reason: "provider_said_maybe" },
		] as const) {
			expect(() =>
				materializeDecision(
					capabilityProvider({
						resolveServerToolCapability: () => decision as never,
					}),
					requirement,
					tuple,
					"2026-08-05T00:00:00.000Z",
				),
			).toThrow();
		}
	});

	test("rejects async, throwing, accessor, and drifting resolvers safely", () => {
		expect(() =>
			materializeDecision(
				capabilityProvider({
					resolveServerToolCapability: async () => ({
						decision: "unknown",
						reason: "no_exact_proof",
					}),
				} as unknown as Partial<Provider>),
				requirement,
				tuple,
			),
		).toThrow();

		const diagnosticSentinel = "resolver-secret-diagnostic";
		let thrownMessage = "";
		try {
			materializeDecision(
				capabilityProvider({
					resolveServerToolCapability: () => {
						throw new Error(diagnosticSentinel);
					},
				}),
				requirement,
				tuple,
			);
		} catch (error) {
			thrownMessage = error instanceof Error ? error.message : String(error);
		}
		expect(thrownMessage).not.toContain(diagnosticSentinel);

		let getterCalls = 0;
		const accessorDecision: Record<string, unknown> = {
			reason: "no_exact_proof",
		};
		Object.defineProperty(accessorDecision, "decision", {
			configurable: true,
			enumerable: true,
			get() {
				getterCalls += 1;
				return "unknown";
			},
		});
		expect(() =>
			materializeDecision(
				capabilityProvider({
					resolveServerToolCapability: () => accessorDecision as never,
				}),
				requirement,
				tuple,
			),
		).toThrow();
		expect(getterCalls).toBe(0);

		let provider: Provider;
		provider = capabilityProvider({
			resolveServerToolCapability: () => {
				provider.resolveServerToolCapability = () => ({
					decision: "unknown",
					reason: "no_exact_proof",
				});
				return { decision: "unknown", reason: "no_exact_proof" };
			},
		});
		expect(() => materializeDecision(provider, requirement, tuple)).toThrow();
	});
});
