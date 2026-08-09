import { describe, expect, test } from "bun:test";
import type {
	Account,
	ServerToolCapabilityTuple,
	ServerToolRequirements,
} from "@better-ccflare/types";
import {
	buildServerToolCapabilityTupleKey,
	deriveServerToolRequirement,
	materializeProviderServerToolCapabilityDecision,
	materializeProviderServerToolCapabilityTuple,
} from "../../server-tool-capabilities";
import { CODEX_DEFAULT_ENDPOINT, CodexProvider } from "./provider";
import {
	CODEX_SERVER_TOOL_COMPILED_CONTRACTS,
	CodexServerToolConversionError,
	hasCodexServerToolDeclaration,
	mapCodexServerToolRequest,
} from "./server-tools";

function codexOAuthAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-live-shaped",
		name: "Codex OAuth",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: "geographic",
		billing_type: null,
		model_fallbacks: null,
		...overrides,
	};
}

function deriveExactRequirement(
	options: {
		readonly stream?: boolean;
		readonly mixed?: boolean;
		readonly continuation?: boolean;
		readonly domain?: string;
	} = {},
): ServerToolRequirements {
	const requirement = deriveServerToolRequirement({
		stream: options.stream ?? true,
		tools: [
			...(options.mixed
				? [
						{
							name: "Lookup",
							description: "Lookup a record",
							input_schema: { type: "object" },
						},
					]
				: []),
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 3,
				allowed_domains: [options.domain ?? "example.com/docs"],
				user_location: {
					type: "approximate",
					city: "Miami",
					region: "Florida",
					country: "US",
					timezone: "America/New_York",
				},
			},
		],
	});
	if (!requirement) throw new Error("expected exact server-tool requirement");
	if (!options.continuation) return requirement;
	return Object.freeze({
		...requirement,
		replay: Object.freeze({
			...requirement.replay,
			input: Object.freeze(["proxy-evidence-v1" as const]),
		}),
	});
}

function materializeCodexTuple(
	requirements: ServerToolRequirements,
	overrides: Partial<{
		account: Account;
		path: string;
		query: string;
		physicalModel: string;
	}> = {},
) {
	return materializeProviderServerToolCapabilityTuple(new CodexProvider(), {
		candidateId: "account:codex-live-shaped",
		account: overrides.account ?? codexOAuthAccount(),
		path: overrides.path ?? "/v1/messages",
		query: overrides.query ?? "",
		physicalModel: overrides.physicalModel ?? "gpt-5.6-sol",
		requirements,
	});
}

describe("Codex exact hosted-search capability", () => {
	test("admits the complete response, mixed-tool, and continuation matrix", () => {
		expect(CODEX_SERVER_TOOL_COMPILED_CONTRACTS).toHaveLength(8);
		expect(Object.isFrozen(CODEX_SERVER_TOOL_COMPILED_CONTRACTS)).toBe(true);

		for (const stream of [false, true]) {
			for (const mixed of [false, true]) {
				for (const continuation of [false, true]) {
					const requirements = deriveExactRequirement({
						stream,
						mixed,
						continuation,
					});
					const tuple = materializeCodexTuple(requirements);
					expect(tuple).toMatchObject({
						provider: "codex",
						authMode: "oauth-subscription",
						endpointClass: "codex_responses",
						normalizedEndpoint: CODEX_DEFAULT_ENDPOINT,
						model: "gpt-5.6-sol",
						toolType: "web_search_20250305",
						profile: requirements.profileId,
						optionProfile: requirements.optionProfileId,
						responseMode: stream ? "streaming" : "json",
						mixedToolMode: mixed
							? "server_and_client_functions"
							: "server_only",
						inputReplay: continuation ? ["proxy-evidence-v1"] : [],
						outputReplay: ["proxy-evidence-v1"],
						requestTransport: "openai_responses",
						responseTransport: "openai_responses_sse",
					});
					expect(Object.isFrozen(tuple)).toBe(true);
					expect(Object.isFrozen(tuple?.inputReplay)).toBe(true);
					expect(Object.isFrozen(tuple?.outputReplay)).toBe(true);
					if (!tuple) throw new Error("expected exact Codex tuple");

					const decision = materializeProviderServerToolCapabilityDecision(
						new CodexProvider(),
						requirements,
						tuple,
						"2026-08-08T12:00:00.000Z",
					);
					expect(decision).toMatchObject({
						decision: "proven",
						proof: { tuple },
					});
				}
			}
		}
	});

	test("rejects every near miss before capability admission", () => {
		const exact = deriveExactRequirement();
		const invalid = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 0,
				},
			],
		});
		const unsupported = deriveServerToolRequirement({
			tools: [{ type: "web_search_20990101", name: "web_search" }],
		});
		if (!invalid || !unsupported) throw new Error("expected rejected inputs");
		const nativeReplay: ServerToolRequirements = Object.freeze({
			...exact,
			replay: Object.freeze({
				...exact.replay,
				input: Object.freeze(["native-Anthropic"]),
			}),
		});
		const nativeOutputReplay: ServerToolRequirements = Object.freeze({
			...exact,
			replay: Object.freeze({
				...exact.replay,
				output: Object.freeze(["native-Anthropic"]),
			}),
		});
		const oversizedLocation = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					user_location: {
						type: "approximate",
						city: "🌎".repeat(100),
					},
				},
			],
		});
		if (!oversizedLocation) {
			throw new Error("expected byte-oversized normalized requirement");
		}

		const misses = [
			{ physicalModel: "gpt-5.6-sol-latest" },
			{ path: "/v1/responses" },
			{ query: "beta=true" },
			{ account: codexOAuthAccount({ provider: "anthropic" }) },
			{ account: codexOAuthAccount({ api_key: "api-key" }) },
			{
				account: codexOAuthAccount({
					api_key: "mirrored",
					access_token: "mirrored",
					refresh_token: "mirrored",
				}),
			},
			{
				account: codexOAuthAccount({
					access_token: null,
					refresh_token: null,
				}),
			},
			{ account: codexOAuthAccount({ billing_type: "api" }) },
			{ account: codexOAuthAccount({ billing_type: "unknown" }) },
			{
				account: codexOAuthAccount({ custom_endpoint: CODEX_DEFAULT_ENDPOINT }),
			},
		] as const;
		for (const miss of misses) {
			expect(materializeCodexTuple(exact, miss)).toBeUndefined();
		}
		expect(materializeCodexTuple(invalid)).toBeUndefined();
		expect(materializeCodexTuple(unsupported)).toBeUndefined();
		expect(materializeCodexTuple(nativeReplay)).toBeUndefined();
		expect(materializeCodexTuple(nativeOutputReplay)).toBeUndefined();
		expect(materializeCodexTuple(oversizedLocation)).toBeUndefined();
	});

	test("binds option values, response mode, mixed mode, and replay shape into identity", () => {
		const variants = [
			deriveExactRequirement(),
			deriveExactRequirement({ domain: "openai.com/research" }),
			deriveExactRequirement({ stream: false }),
			deriveExactRequirement({ mixed: true }),
			deriveExactRequirement({ continuation: true }),
		];
		const tuples = variants.map((requirement) => {
			const tuple = materializeCodexTuple(requirement);
			if (!tuple) throw new Error("expected exact tuple variant");
			return tuple;
		});
		expect(new Set(tuples.map(buildServerToolCapabilityTupleKey)).size).toBe(
			tuples.length,
		);
	});

	test("revalidates every revision-2 tuple dimension and rejects forged drift", () => {
		const provider = new CodexProvider();
		const requirements = deriveExactRequirement();
		const tuple = materializeCodexTuple(requirements);
		if (!tuple) throw new Error("expected exact tuple");
		expect(
			provider.resolveServerToolCapability(requirements, tuple),
		).toMatchObject({ decision: "proven", proof: { tuple } });

		const drifts: Partial<ServerToolCapabilityTuple>[] = [
			{ provider: "codex-family" },
			{ authMode: "oauth" },
			{ endpointClass: "responses" },
			{ normalizedEndpoint: "https://api.openai.com/v1/responses" },
			{ model: "gpt-5.6-sol-latest" },
			{ toolType: "web_search" },
			{ profile: `${tuple.profile}:forged` },
			{ optionProfile: `${tuple.optionProfile}:forged` },
			{ responseMode: "json" },
			{ mixedToolMode: "server_and_client_functions" },
			{ inputReplay: ["native-Anthropic"] },
			{ outputReplay: [] },
			{ providerContractRevision: "codex-responses-v2" },
			{ replayDecoderRevision: "server-tool-replay-v2" },
			{ requestTransport: "openai_chat_completions" },
			{ responseTransport: "openai_responses_json" },
		];
		for (const drift of drifts) {
			expect(
				provider.resolveServerToolCapability(requirements, {
					...tuple,
					...drift,
				}),
			).toMatchObject({ decision: "unknown" });
		}
	});
});

describe("Codex strict hosted-search request mapper", () => {
	test("keeps ordinary functions outside the native hosted path", () => {
		const body = {
			tools: [
				{
					name: "web_search",
					description: "ordinary client function",
					input_schema: { type: "object" },
				},
			],
		};
		expect(hasCodexServerToolDeclaration(body)).toBe(false);
		expect(mapCodexServerToolRequest(body)).toBeUndefined();
	});

	test("preserves normalized restrictions and mixed order while applying current function policy", () => {
		const mapping = mapCodexServerToolRequest(
			{
				tool_choice: { type: "auto" },
				tools: [
					{
						name: "Before",
						description: "before search",
						input_schema: {
							$schema: "http://json-schema.org/draft-07/schema#",
							type: "object",
							properties: {
								value: { type: "string", pattern: "^(?!bad).*" },
							},
						},
					},
					{
						name: "Agent",
						input_schema: { type: "object" },
					},
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: 3,
						allowed_domains: ["example.com/docs", "openai.com/research"],
						user_location: {
							type: "approximate",
							city: "Miami",
							region: "Florida",
							country: "US",
							timezone: "America/New_York",
						},
					},
					{
						name: "After",
						input_schema: { type: "object" },
					},
				],
			},
			{ filterOrchestrationTools: true },
		);

		expect(mapping).toEqual({
			include: ["web_search_call.action.sources"],
			max_tool_calls: 3,
			tools: [
				{
					type: "function",
					name: "Before",
					description: "before search",
					parameters: {
						type: "object",
						properties: { value: { type: "string" } },
					},
				},
				{
					type: "web_search",
					filters: {
						allowed_domains: ["example.com/docs", "openai.com/research"],
					},
					user_location: {
						type: "approximate",
						city: "Miami",
						region: "Florida",
						country: "US",
						timezone: "America/New_York",
					},
				},
				{
					type: "function",
					name: "After",
					description: undefined,
					parameters: { type: "object" },
				},
			],
		});
		expect(Object.isFrozen(mapping)).toBe(true);
		expect(Object.isFrozen(mapping?.tools)).toBe(true);
		expect(Object.isFrozen(mapping?.tools[0])).toBe(true);
	});

	test("preserves blocked domains without inventing an allow list or call cap", () => {
		expect(
			mapCodexServerToolRequest({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						blocked_domains: ["example.com/private"],
					},
				],
			}),
		).toEqual({
			include: ["web_search_call.action.sources"],
			tools: [
				{
					type: "web_search",
					filters: { blocked_domains: ["example.com/private"] },
				},
			],
		});
	});

	test("normalizes domain-set identity without changing outbound order or duplicates", () => {
		const first = deriveExactRequirement({ domain: "example.com/a" });
		const reordered = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 3,
					allowed_domains: ["openai.com/b", "example.com/a", "example.com/a"],
					user_location: {
						type: "approximate",
						city: "Miami",
						region: "Florida",
						country: "US",
						timezone: "America/New_York",
					},
				},
			],
		});
		const sameSetDifferentOrder = deriveServerToolRequirement({
			tools: [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: 3,
					allowed_domains: ["example.com/a", "example.com/a", "openai.com/b"],
					user_location: {
						type: "approximate",
						city: "Miami",
						region: "Florida",
						country: "US",
						timezone: "America/New_York",
					},
				},
			],
		});
		if (!reordered || !sameSetDifferentOrder) {
			throw new Error("expected normalized domain requirements");
		}
		expect(reordered.optionProfileId).toBe(
			sameSetDifferentOrder.optionProfileId,
		);
		expect(reordered.optionProfileId).not.toBe(first.optionProfileId);
		expect(
			mapCodexServerToolRequest({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						allowed_domains: ["openai.com/b", "example.com/a", "example.com/a"],
					},
				],
			})?.tools[0],
		).toEqual({
			type: "web_search",
			filters: {
				allowed_domains: ["openai.com/b", "example.com/a", "example.com/a"],
			},
		});
	});

	test("rejects every ambiguous or non-exact hosted declaration locally", () => {
		const privateSentinel = "private-tool-content-must-not-escape";
		const invalidBodies = [
			{
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						extra: privateSentinel,
					},
				],
			},
			{ tools: [{ type: "web_search_20990101", name: "web_search" }] },
			{
				tools: [
					{ type: "web_search_20250305", name: "web_search" },
					{ type: "web_search_20250305", name: "web_search" },
				],
			},
			{
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				include: ["spoofed"],
			},
			{
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				max_tool_calls: 2,
			},
			{
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				parallel_tool_calls: true,
			},
			{
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						max_uses: 0,
					},
				],
			},
			{
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						user_location: {
							type: "approximate",
							city: "🌎".repeat(100),
						},
					},
				],
			},
		];

		for (const body of invalidBodies) {
			try {
				mapCodexServerToolRequest(body);
				throw new Error("expected strict mapper rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(CodexServerToolConversionError);
				expect(String(error)).not.toContain(privateSentinel);
			}
		}
	});
});
