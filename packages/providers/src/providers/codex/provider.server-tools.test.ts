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
import type { ServerToolHistoryReplacement } from "../../server-tools/history-projection";
import officialSearchStream from "./__fixtures__/server-tools/official-search-stream.sanitized.json";
import { CODEX_DEFAULT_ENDPOINT, CodexProvider } from "./provider";
import {
	classifyCodexHostedDecoderRejectionShape,
	classifyCodexHostedError,
	classifyCodexHostedTerminalShape,
	createCodexHostedSearchAttemptPlan,
} from "./server-tool-attempt-plan";
import {
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

function claudeCodeForcedSearchBody(): Record<string, unknown> {
	return {
		model: "claude-opus-5",
		max_tokens: 512,
		stream: true,
		messages: [
			{
				role: "user",
				content: "Perform a web search for the query: test",
			},
		],
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 8,
			},
		],
		tool_choice: { type: "tool", name: "web_search" },
	};
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

function liveSourceLessSearchStream(): unknown[] {
	const events = structuredClone(officialSearchStream) as Array<
		Record<string, unknown>
	>;
	const patchItem = (value: unknown): void => {
		if (
			typeof value !== "object" ||
			value === null ||
			(value as { type?: unknown }).type !== "web_search_call"
		) {
			return;
		}
		const item = value as { action?: Record<string, unknown> };
		const action = item.action;
		if (!action || typeof action.query !== "string") return;
		action.queries = [action.query, `${action.query} refinement`];
		delete action.sources;
	};
	for (const event of events) {
		patchItem(event.item);
		const response = event.response as { output?: unknown[] } | undefined;
		for (const item of response?.output ?? []) patchItem(item);
	}
	return events;
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
		...(options.continuation
			? {
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "server_tool_use",
									id: "srvtoolu_continuation_fixture",
									name: "web_search",
									input: { query: "prior query" },
								},
								{
									type: "web_search_tool_result",
									tool_use_id: "srvtoolu_continuation_fixture",
									content: [
										{
											type: "web_search_result",
											url: "https://example.com/docs",
											title: "Example docs",
											encrypted_content: "bccf2.fixture",
										},
									],
								},
							],
						},
					],
				}
			: {}),
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
	return requirement;
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

describe("Codex hosted-search upstream error diagnostics", () => {
	test("retains only bounded decoder rejection shape", () => {
		const privateValue = "private item content must not escape";
		const shape = classifyCodexHostedDecoderRejectionShape({
			type: "response.output_item.added",
			output_index: 1,
			item: {
				type: "computer_call",
				content: privateValue,
				action: {
					type: "search",
					queries: [privateValue],
					sources: [{ url: privateValue }],
				},
			},
			privateValue,
		});
		expect(shape).toEqual({
			eventType: "response.output_item.added",
			itemType: "computer_call",
			outputIndex: 1,
			actionType: "search",
			hasQuery: false,
			queriesCount: 1,
			hasSources: true,
			sourcesCount: 1,
		});
		expect(JSON.stringify(shape)).not.toContain(privateValue);
	});

	test("classifies only non-success terminal shape fields", () => {
		expect(
			classifyCodexHostedTerminalShape({
				type: "response.incomplete",
				response: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					error: { message: "private" },
				},
			}),
		).toEqual({
			eventType: "response.incomplete",
			responseStatus: "incomplete",
			incompleteReason: "max_output_tokens",
			hasError: true,
		});
		expect(
			classifyCodexHostedTerminalShape({
				type: "response.completed",
				response: { status: "completed" },
			}),
		).toBeNull();
		expect(
			classifyCodexHostedTerminalShape({
				type: "response.completed",
				response: {
					status: "failed",
					error: { message: "private" },
				},
			}),
		).toEqual({
			eventType: "response.completed",
			responseStatus: "failed",
			incompleteReason: null,
			hasError: true,
		});
	});

	test("retains only bounded identifiers and an allowlisted category", () => {
		const privateMessage = "private backend detail must not escape";
		const diagnostic = classifyCodexHostedError({
			type: "error",
			error: {
				type: "api_error",
				code: "invalid_tool_choice",
				param: "tool_choice",
				message: privateMessage,
			},
		});
		expect(diagnostic).toEqual({
			errorType: "api_error",
			errorCode: "invalid_tool_choice",
			errorParameter: "tool_choice",
			unsupportedParameter: null,
			category: "other",
		});
		expect(JSON.stringify(diagnostic)).not.toContain(privateMessage);
	});

	test("classifies response.failed machine errors before translation", () => {
		const privateMessage = "private response failure must not escape";
		const diagnostic = classifyCodexHostedError({
			type: "response.failed",
			response: {
				error: {
					type: "api_error",
					code: "web_search_unavailable",
					message: privateMessage,
				},
			},
		});
		expect(diagnostic).toMatchObject({
			errorType: "api_error",
			errorCode: "web_search_unavailable",
			category: "other",
		});
		expect(JSON.stringify(diagnostic)).not.toContain(privateMessage);
	});

	test.each([
		["Unsupported parameter: max_tool_calls", "unsupported_parameter"],
		["Web search is not enabled for this account", "web_search_unavailable"],
		["tool_choice is unsupported", "tool_choice_invalid"],
		["model is unavailable", "model_unavailable"],
		["You do not have access to this feature", "entitlement"],
		["Blocked by safety policy", "policy"],
		["Internal server error", "internal"],
	] as const)("classifies %s", (message, category) => {
		expect(
			classifyCodexHostedError({
				type: "error",
				error: { type: "api_error", message },
			})?.category,
		).toBe(category);
	});
});

describe("Codex exact hosted-search capability", () => {
	test("proves Claude Code's forced WebSearch side-query contract", () => {
		const requirements = deriveServerToolRequirement(
			claudeCodeForcedSearchBody(),
		);
		if (!requirements) throw new Error("expected forced WebSearch requirement");
		const tuple = materializeCodexTuple(requirements);
		if (!tuple) throw new Error("expected forced WebSearch tuple");
		const decision = materializeProviderServerToolCapabilityDecision(
			new CodexProvider(),
			requirements,
			tuple,
		);

		expect(requirements.profileId).toContain(":choice-forced");
		expect(requirements.responseMode).toBe("streaming");
		expect(requirements.mixedToolMode).toBe("server_only");
		expect(requirements.declarations).toEqual([
			{ type: "web_search_20250305", maxUses: 8 },
		]);
		expect(tuple).toMatchObject({
			model: "gpt-5.6-sol",
			toolType: "web_search_20250305",
			profile: requirements.profileId,
			inputReplay: [],
			outputReplay: ["proxy-evidence-v1"],
		});
		expect(decision).toMatchObject({ decision: "proven" });
	});

	test("admits the complete response, mixed-tool, and continuation matrix", () => {
		let admittedContracts = 0;

		for (const stream of [false, true]) {
			for (const mixed of [false, true]) {
				for (const continuation of [false, true]) {
					const requirements = deriveExactRequirement({
						stream,
						mixed,
						continuation,
					});
					const tuple = materializeCodexTuple(requirements);
					expect(tuple).toEqual({
						candidateId: "account:codex-live-shaped",
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
						inputReplay: continuation ? ["native-Anthropic"] : [],
						outputReplay: ["proxy-evidence-v1"],
						providerContractRevision: "codex-responses-web-search-v4",
						replayDecoderRevision: "server-tool-replay-v2",
						requestTransport: "openai_responses",
						responseTransport: "openai_responses_sse",
					});
					expect(Object.isFrozen(tuple)).toBe(true);
					expect(Object.isFrozen(tuple?.inputReplay)).toBe(true);
					expect(Object.isFrozen(tuple?.outputReplay)).toBe(true);
					if (!tuple) throw new Error("expected exact Codex tuple");
					admittedContracts += 1;

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
		expect(admittedContracts).toBe(8);
	});

	test("admits the authenticated natural continuation emitted by the Anthropic encoder", async () => {
		const firstTurnPlan = materializeHostedPlan(hostedRequestBody(false));
		const firstTurnResponse = await firstTurnPlan.processResponse(
			upstreamSse(officialSearchStream),
		);
		const firstTurn = (await firstTurnResponse.json()) as {
			content: Array<Record<string, unknown>>;
		};
		const continuationBody = hostedRequestBody(false);
		continuationBody.messages = [
			{ role: "assistant", content: firstTurn.content },
			{ role: "user", content: "Continue from that search" },
		];
		const requirements = deriveServerToolRequirement(continuationBody);
		expect(requirements?.replay).toEqual({
			input: ["native-Anthropic"],
			output: ["proxy-evidence-v1"],
			requiresOutputReplay: true,
		});
		if (!requirements) throw new Error("expected continuation requirement");

		const tuple = materializeCodexTuple(requirements);
		expect(tuple).toMatchObject({
			inputReplay: ["native-Anthropic"],
			outputReplay: ["proxy-evidence-v1"],
		});
		if (!tuple) throw new Error("expected authenticated continuation tuple");
		expect(() =>
			materializeHostedPlan(continuationBody, {
				inputReplayMode: ["proxy-evidence-v1"],
				outputReplayMode: tuple.outputReplay,
			}),
		).toThrow(CodexServerToolConversionError);

		// A native Anthropic server_tool_use is admissible only when its paired
		// output carries proxy evidence and the request-scoped projector is present
		// to authenticate and neutralize that evidence before Codex conversion.
		expect(() =>
			materializeHostedPlan(continuationBody, {
				inputReplayMode: tuple.inputReplay,
				outputReplayMode: tuple.outputReplay,
				serverToolHistoryProjector: undefined,
			}),
		).toThrow(CodexServerToolConversionError);

		const callId = firstTurn.content.find(
			(block) => block.type === "server_tool_use",
		)?.id;
		if (typeof callId !== "string") {
			throw new Error("expected encoded server-tool call id");
		}
		const replacements: ServerToolHistoryReplacement[] = [];
		for (
			let blockIndex = 0;
			blockIndex < firstTurn.content.length;
			blockIndex++
		) {
			const block = firstTurn.content[blockIndex];
			if (block?.type === "server_tool_use") {
				replacements.push({
					messageIndex: 0,
					blockIndex,
					role: "assistant",
					sourceType: "server_tool_use",
					callId,
					text: '["bccf-untrusted-history-v1","server_tool_use"]',
				});
			} else if (block?.type === "web_search_tool_result") {
				replacements.push({
					messageIndex: 0,
					blockIndex,
					role: "assistant",
					sourceType: "web_search_tool_result",
					callId,
					text: '["bccf-untrusted-history-v1","web_search_tool_result"]',
				});
			} else if (block?.type === "text" && Array.isArray(block.citations)) {
				for (
					let citationIndex = 0;
					citationIndex < block.citations.length;
					citationIndex++
				) {
					replacements.push({
						messageIndex: 0,
						blockIndex,
						role: "assistant",
						sourceType: "web_search_citation",
						citationIndex,
						callId,
						text: '["bccf-untrusted-history-v1","web_search_citation"]',
					});
				}
			}
		}
		const continuationPlan = materializeHostedPlan(continuationBody, {
			inputReplayMode: tuple.inputReplay,
			outputReplayMode: tuple.outputReplay,
			serverToolHistoryProjector: async () =>
				Object.freeze({
					declarations: Object.freeze([]),
					nativeOpaquePositions: Object.freeze([]),
					replacements: Object.freeze(replacements),
					envelopeCount: 1,
					encryptedInputBytes: 1,
				}),
		});
		const transformed = await continuationPlan.transformRequestBody(
			new Request(CODEX_DEFAULT_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(continuationBody),
			}),
		);
		const mapped = (await transformed.json()) as {
			input: Array<{ content?: Array<Record<string, unknown>> }>;
		};
		const projectedContent = mapped.input.flatMap(
			(message) => message.content ?? [],
		);
		expect(projectedContent.map((item) => item.type)).toEqual([
			"output_text",
			"output_text",
			"output_text",
			"input_text",
		]);
		expect(
			projectedContent.some((item) => Object.hasOwn(item, "citations")),
		).toBe(false);
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
		const continuation = deriveExactRequirement({ continuation: true });
		const replayNearMisses = [
			{
				input: ["native-Anthropic"],
				output: [],
			},
			{
				input: ["proxy-evidence-v1"],
				output: ["proxy-evidence-v1"],
			},
			{
				input: ["native-Anthropic"],
				output: ["native-Anthropic"],
			},
			{
				input: ["native-Anthropic", "proxy-evidence-v1"],
				output: ["proxy-evidence-v1"],
			},
			{
				input: ["proxy-evidence-v1"],
				output: [],
			},
		] as const;
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
		for (const replay of replayNearMisses) {
			expect(
				materializeCodexTuple(
					Object.freeze({
						...continuation,
						replay: Object.freeze({
							...continuation.replay,
							input: Object.freeze([...replay.input]),
							output: Object.freeze([...replay.output]),
						}),
					}),
				),
			).toBeUndefined();
		}
		expect(materializeCodexTuple(oversizedLocation)).toBeUndefined();
	});

	test("enforces the compiled location limit in UTF-8 bytes", () => {
		const requirementWithCity = (city: string) =>
			deriveServerToolRequirement({
				tools: [
					{
						type: "web_search_20250305",
						name: "web_search",
						user_location: { type: "approximate", city },
					},
				],
			});
		const atLimit = requirementWithCity("x".repeat(256));
		const aboveLimit = requirementWithCity(`${"x".repeat(255)}é`);
		if (!atLimit || !aboveLimit) {
			throw new Error("expected normalized location requirements");
		}

		expect(materializeCodexTuple(atLimit)).toBeDefined();
		expect(materializeCodexTuple(aboveLimit)).toBeUndefined();
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
			{ replayDecoderRevision: "server-tool-replay-v3" },
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
	test("maps Claude Code's forced WebSearch choice to native Codex fields", async () => {
		const body = claudeCodeForcedSearchBody();
		const plan = materializeHostedPlan(body);
		const sourceRequest = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

		const transformed = await plan.transformRequestBody(sourceRequest);
		const mapped = (await transformed.json()) as Record<string, unknown>;

		expect(mapped).toMatchObject({
			model: "gpt-5.6-sol",
			stream: true,
			store: false,
			tools: [{ type: "web_search" }],
			tool_choice: "required",
		});
		expect(mapped).not.toHaveProperty("max_tool_calls");
		expect(mapped.include).toEqual(["reasoning.encrypted_content"]);
		expect(mapped.include).not.toContain("web_search_call.action.sources");
	});

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

	test("removes the non-official sources include while preserving ordinary includes", async () => {
		const body = hostedRequestBody();
		const sourceRequest = new Request(CODEX_DEFAULT_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const plan = createCodexHostedSearchAttemptPlan(
			{
				request: sourceRequest,
				requestBodyBuffer: requestBodyBuffer(body),
				account: codexOAuthAccount(),
				path: "/v1/messages",
				query: "",
				physicalModel: "gpt-5.6-sol",
				capabilityProofKey: "codex-hosted-search-proof",
				inputReplayMode: [],
				outputReplayMode: ["proxy-evidence-v1"],
				serverToolReplayIssuer: async () => "bccf2.fixture",
			},
			{
				prepareHeaders: (headers) => headers,
				transformOrdinaryRequest: async (request) =>
					new Request(request.url, {
						method: request.method,
						headers: request.headers,
						body: JSON.stringify({
							model: "gpt-5.6-sol",
							stream: true,
							store: false,
							input: [],
							tools: [],
							include: [
								"reasoning.encrypted_content",
								"web_search_call.action.sources",
							],
						}),
					}),
				processHostedResponse: async (response) => response,
				parseRateLimit: () => ({ isRateLimited: false }),
			},
		);

		const transformed = await plan.transformRequestBody(sourceRequest);
		const mapped = (await transformed.json()) as { include: string[] };

		expect(mapped.include).toEqual(["reasoning.encrypted_content"]);
		expect(mapped.include).not.toContain("web_search_call.action.sources");
		expect(new Set(mapped.include).size).toBe(mapped.include.length);
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
			include: ["reasoning.encrypted_content"],
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
		expect(mapped).not.toHaveProperty("max_tool_calls");
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
			inputReplayMode: ["native-Anthropic"],
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

	test("synthesizes source results from citations for live source-less search actions", async () => {
		const plan = materializeHostedPlan(hostedRequestBody(true));
		const response = await plan.processResponse(
			upstreamSse(liveSourceLessSearchStream()),
		);
		const wire = await response.text();
		expect(wire).toContain('"type":"web_search_tool_result"');
		expect(wire).toContain('"type":"citations_delta"');
		expect(wire).toContain("https://docs.example.test/launch");
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
