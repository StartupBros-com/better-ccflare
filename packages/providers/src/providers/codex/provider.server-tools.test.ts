import { describe, expect, test } from "bun:test";
import type {
	Account,
	ServerToolCapabilityTuple,
	ServerToolRequirements,
} from "@better-ccflare/types";
import {
	createProviderAttemptNoExecutionSnapshot,
	materializeProviderAttemptPlan,
} from "../../provider-attempt-plan";
import {
	buildServerToolCapabilityTupleKey,
	deriveServerToolRequirement,
	materializeProviderServerToolCapabilityDecision,
	materializeProviderServerToolCapabilityTuple,
} from "../../server-tool-capabilities";
import officialSearchStream from "./__fixtures__/server-tools/official-search-stream.sanitized.json";
import { CODEX_DEFAULT_ENDPOINT, CodexProvider } from "./provider";
import {
	CODEX_SERVER_TOOL_COMPILED_CONTRACTS,
	CodexServerToolConversionError,
	hasCodexServerToolDeclaration,
	mapCodexServerToolRequest,
} from "./server-tools";

function requestBodyBuffer(value: unknown): ArrayBuffer {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function hostedRequestBody(stream = true): Record<string, unknown> {
	return {
		model: "claude-opus-4-1-20250805",
		max_tokens: 512,
		stream,
		messages: [{ role: "user", content: "Search the official docs" }],
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 2,
				allowed_domains: ["openai.com/docs"],
			},
			{
				name: "Lookup",
				description: "Lookup a record",
				input_schema: {
					type: "object",
					properties: { id: { type: "string" } },
				},
			},
		],
	};
}

function upstreamSse(events: readonly unknown[]): Response {
	return new Response(
		events
			.map((event) => {
				const type = (event as { type: string }).type;
				return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
			})
			.join(""),
		{
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-final-model": "gpt-5.6-sol",
			},
		},
	);
}

function mixedFunctionStream(): unknown[] {
	const events = structuredClone(officialSearchStream) as Array<
		Record<string, unknown>
	>;
	const terminal = events.at(-1);
	if (
		!terminal ||
		!Array.isArray((terminal.response as { output?: unknown[] }).output)
	) {
		throw new Error("invalid fixture terminal");
	}
	const prefix = events.slice(0, 6);
	const suffix = events.slice(6, -1).map((event) => ({
		...event,
		sequence_number: (event.sequence_number as number) + 4,
		output_index:
			typeof event.output_index === "number"
				? event.output_index + 1
				: undefined,
	}));
	const functionItem = {
		id: "fc_fixture_alpha",
		type: "function_call",
		status: "completed",
		call_id: "call_fixture_alpha",
		name: "Lookup",
		arguments: '{"id":"42"}',
	};
	const terminalResponse = terminal.response as Record<string, unknown> & {
		output: unknown[];
	};
	return [
		...prefix,
		{
			type: "response.output_item.added",
			sequence_number: 6,
			output_index: 1,
			item: { ...functionItem, status: "in_progress", arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			sequence_number: 7,
			output_index: 1,
			item_id: functionItem.id,
			delta: '{"id":"42"}',
		},
		{
			type: "response.function_call_arguments.done",
			sequence_number: 8,
			output_index: 1,
			item_id: functionItem.id,
			arguments: functionItem.arguments,
		},
		{
			type: "response.output_item.done",
			sequence_number: 9,
			output_index: 1,
			item: functionItem,
		},
		...suffix,
		{
			...terminal,
			sequence_number: 14,
			response: {
				...terminalResponse,
				output: [
					terminalResponse.output[0],
					functionItem,
					terminalResponse.output[1],
				],
			},
		},
	];
}

function materializeHostedPlan(
	body: Record<string, unknown>,
	overrides: Partial<Parameters<typeof materializeProviderAttemptPlan>[1]> = {},
) {
	const request = new Request(CODEX_DEFAULT_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return materializeProviderAttemptPlan(new CodexProvider(), {
		request,
		requestBodyBuffer: requestBodyBuffer(body),
		account: codexOAuthAccount(),
		path: "/v1/messages",
		query: "",
		physicalModel: "gpt-5.6-sol",
		capabilityProofKey: "codex-hosted-search-proof",
		inputReplayMode: [],
		outputReplayMode: ["proxy-evidence-v1"],
		serverToolHistoryProjector: async () =>
			Object.freeze({
				declarations: Object.freeze([]),
				nativeOpaquePositions: Object.freeze([]),
				replacements: Object.freeze([]),
				envelopeCount: 0,
				encryptedInputBytes: 0,
			}),
		serverToolReplayIssuer: async () => "bccf2.fixture",
		...overrides,
	});
}

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
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: "geographic",
		billing_type: null,
		model_fallbacks: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
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

describe("Codex exact hosted-search attempt plan", () => {
	test("materializes only the exact hosted transport and delegates stable policy", async () => {
		const plan = materializeHostedPlan(hostedRequestBody());
		expect(plan).toMatchObject({
			providerName: "codex",
			targetUrl: CODEX_DEFAULT_ENDPOINT,
			apiFamily: "codex:hosted-search:v1",
			physicalModel: "gpt-5.6-sol",
			capabilityProofKey: "codex-hosted-search-proof",
			inputReplayMode: [],
			outputReplayMode: ["proxy-evidence-v1"],
			dataRetryPolicy: { mode: "none", maxAttempts: 0 },
			cacheReplayModelStrategy: "transformed-body",
		});
		expect(
			await plan.classifyNoExecution(
				createProviderAttemptNoExecutionSnapshot({
					status: 400,
					headers: {},
					bodyText: "",
					bodyTruncated: false,
				}),
			),
		).toEqual({ decision: "executing_or_ambiguous" });
	});

	test("projects first, preserves current conversion, then replaces only the hosted declaration", async () => {
		const body = hostedRequestBody();
		let projectedMessages: unknown;
		const plan = materializeHostedPlan(body, {
			serverToolHistoryProjector: async (messages) => {
				projectedMessages = messages;
				return Object.freeze({
					declarations: Object.freeze([]),
					nativeOpaquePositions: Object.freeze([]),
					replacements: Object.freeze([]),
					envelopeCount: 0,
					encryptedInputBytes: 0,
				});
			},
		});
		const transformed = await plan.transformRequestBody(
			new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const mapped = (await transformed.json()) as Record<string, unknown>;
		expect(projectedMessages).toBeUndefined();
		expect(mapped).toMatchObject({
			model: "gpt-5.6-sol",
			stream: true,
			store: false,
			include: ["web_search_call.action.sources"],
			max_tool_calls: 2,
			tools: [
				{
					type: "web_search",
					filters: { allowed_domains: ["openai.com/docs"] },
				},
				{
					type: "function",
					name: "Lookup",
					parameters: {
						type: "object",
						properties: { id: { type: "string" } },
					},
				},
			],
		});
		expect(mapped.input).toEqual([
			{
				role: "user",
				content: [{ type: "input_text", text: "Search the official docs" }],
			},
		]);
	});

	test("projects authenticated continuation blocks to inert history before conversion", async () => {
		const body = hostedRequestBody();
		body.messages = [
			{
				role: "assistant",
				content: [
					{
						type: "server_tool_use",
						id: "srvtoolu_fixture",
						name: "web_search",
						input: { query: "prior query" },
					},
				],
			},
			{ role: "user", content: "Continue" },
		];
		const replacementText = '["bccf-untrusted-history-v1","server_tool_use"]';
		const plan = materializeHostedPlan(body, {
			inputReplayMode: ["proxy-evidence-v1"],
			serverToolHistoryProjector: async () =>
				Object.freeze({
					declarations: Object.freeze([]),
					nativeOpaquePositions: Object.freeze([]),
					replacements: Object.freeze([
						Object.freeze({
							messageIndex: 0,
							blockIndex: 0,
							role: "assistant",
							sourceType: "server_tool_use" as const,
							callId: "srvtoolu_fixture",
							text: replacementText,
						}),
					]),
					envelopeCount: 0,
					encryptedInputBytes: 0,
				}),
		});
		const transformed = await plan.transformRequestBody(
			new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const mapped = (await transformed.json()) as { input: unknown[] };
		expect(mapped.input[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "output_text", text: replacementText }],
		});
		expect(JSON.stringify(mapped.input)).not.toContain(
			'"type":"server_tool_use"',
		);
	});

	test("retains the current attributed-agent orchestration filter in the native mapping", async () => {
		const body = hostedRequestBody();
		(body.tools as unknown[]).unshift({
			name: "Agent",
			input_schema: { type: "object" },
		});
		const plan = materializeHostedPlan(body);
		const transformed = await plan.transformRequestBody(
			new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-attributed-agent": "true",
				},
				body: JSON.stringify(body),
			}),
		);
		const mapped = (await transformed.json()) as {
			tools: Array<{ type: string; name?: string }>;
		};
		expect(mapped.tools.some(({ name }) => name === "Agent")).toBe(false);
		expect(mapped.tools.map(({ type, name }) => name ?? type)).toEqual([
			"web_search",
			"Lookup",
		]);
	});

	test("ordinary requests continue through the legacy plan without invoking hosted authorities", async () => {
		const body = {
			model: "claude-opus-4-1-20250805",
			max_tokens: 32,
			messages: [{ role: "user", content: "hello" }],
		};
		let authorityCalls = 0;
		const request = new Request("http://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const plan = materializeProviderAttemptPlan(new CodexProvider(), {
			request,
			requestBodyBuffer: requestBodyBuffer(body),
			account: codexOAuthAccount(),
			path: "/v1/messages",
			query: "",
			physicalModel: "gpt-5.6-sol",
			capabilityProofKey: null,
			inputReplayMode: [],
			outputReplayMode: [],
			serverToolHistoryProjector: async () => {
				authorityCalls += 1;
				throw new Error("must remain private");
			},
			serverToolReplayIssuer: async () => {
				authorityCalls += 1;
				throw new Error("must remain private");
			},
		});
		expect(plan.apiFamily).toBe("legacy:codex");
		expect(authorityCalls).toBe(0);
	});

	test("translates one upstream Responses stream directly to Anthropic SSE", async () => {
		const plan = materializeHostedPlan(hostedRequestBody(true));
		const response = await plan.processResponse(
			upstreamSse(officialSearchStream),
		);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const wire = await response.text();
		expect(wire).toContain("event: message_start");
		expect(wire).toContain('"type":"server_tool_use"');
		expect(wire).toContain('"type":"web_search_tool_result"');
		expect(wire).toContain('"type":"citations_delta"');
		expect(wire).toContain('"web_search_requests":1');
		expect(wire).toContain("event: message_stop");
	});

	test("buffers the same upstream SSE once for non-streaming Anthropic JSON", async () => {
		const plan = materializeHostedPlan(hostedRequestBody(false));
		const response = await plan.processResponse(
			upstreamSse(officialSearchStream),
		);
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = (await response.json()) as {
			content: Array<{ type: string }>;
			usage: { server_tool_use: { web_search_requests: number } };
		};
		expect(body.content.map(({ type }) => type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"text",
		]);
		expect(body.usage.server_tool_use.web_search_requests).toBe(1);
	});

	test("fans mixed client-function arguments to the canonical encoder with complete JSON", async () => {
		const plan = materializeHostedPlan(hostedRequestBody(false));
		const response = await plan.processResponse(
			upstreamSse(mixedFunctionStream()),
		);
		const body = (await response.json()) as {
			content: Array<Record<string, unknown>>;
			stop_reason: string;
		};
		const toolUse = body.content.find(
			(block) => block.type === "tool_use" && block.name === "Lookup",
		);
		expect(toolUse).toMatchObject({
			type: "tool_use",
			id: "call_fixture_alpha",
			name: "Lookup",
			input: { id: "42" },
		});
		expect(body.stop_reason).toBe("tool_use");
	});

	test("fails closed on an unknown native event instead of falling back to ordinary parsing", async () => {
		const plan = materializeHostedPlan(hostedRequestBody(false));
		await expect(
			plan.processResponse(
				upstreamSse([
					officialSearchStream[0],
					{ type: "response.secret.future", sequence_number: 1 },
				]),
			),
		).rejects.toBeInstanceOf(Error);
	});

	test("cancels the single upstream reader when the Anthropic stream is abandoned", async () => {
		let upstreamCancelled = false;
		const firstFrame = upstreamSse([officialSearchStream[0]]);
		const firstBytes = new Uint8Array(await firstFrame.arrayBuffer());
		const upstream = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(firstBytes);
				},
				cancel() {
					upstreamCancelled = true;
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const plan = materializeHostedPlan(hostedRequestBody(true));
		const response = await plan.processResponse(upstream);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected downstream reader");
		await reader.cancel("client-aborted");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(upstreamCancelled).toBe(true);
	});
});
