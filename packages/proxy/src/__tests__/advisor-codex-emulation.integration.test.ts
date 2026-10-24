import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";

// Focused proxy tests must not load ignored embedded worker artifacts.
const { getProvider } = await import("@better-ccflare/providers");
const usageCollectorModule = await import("../usage-collector");
const { handleProxy } = await import("../proxy");
const { resetAdvisorResultOwnershipForTests } = await import(
	"../advisor-result-ownership"
);
const { createReadyServerToolReplayRuntimeForTest } = await import(
	"./helpers/server-tool-replay-runtime"
);
const READY_SERVER_TOOL_REPLAY_RUNTIME =
	await createReadyServerToolReplayRuntimeForTest();

const ADVISOR_BETA = "advisor-tool-2026-03-01";
const PHYSICAL_MODEL = "gpt-5.6-sol";
const OPTED_IN_MODEL = "claude-bccf-route-adv-codex";
const PLAIN_MODEL = "claude-bccf-route-plain-codex";
const originalFetch = globalThis.fetch;
const originalPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
const originalKillSwitch = process.env.BCCF_ADVISOR_EMULATION;
let restoreUsageCollectors = (): void => {};
let collectedChunks: string[] = [];

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "anthropic-a",
		name: "anthropic-a",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "oauth-access-token",
		expires_at: Date.now() + 60 * 60_000,
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		id: "codex-a",
		name: "codex-a",
		provider: "codex",
		priority: 5,
		api_key: null,
		access_token: "codex-access-token",
		model_mappings: JSON.stringify({
			opus: PHYSICAL_MODEL,
			sonnet: "gpt-5.6-terra",
		}),
		...overrides,
	});
}

function makeContext(accounts: Account[], providerName: "codex" | "anthropic") {
	const mutations = {
		pauseAccount: mock(async () => undefined),
		markAccountRateLimited: mock(async () => ({
			consecutiveRateLimits: 1,
			applied: true,
		})),
		updateAccountUsage: mock(async () => undefined),
		asyncWrite: mock((job: () => Promise<unknown>) => {
			void job();
		}),
	};
	const provider = getProvider(providerName);
	if (!provider) throw new Error(`expected ${providerName} provider`);
	const ctx = {
		strategy: {
			select: mock(async (list: Account[]) => list),
			reportCandidateFailure: mock(() => undefined),
			reportCandidateSuccess: mock(() => undefined),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
			pauseAccount: mutations.pauseAccount,
			markAccountRateLimited: mutations.markAccountRateLimited,
			updateAccountUsage: mutations.updateAccountUsage,
		},
		runtime: { port: 8080, clientId: "test" },
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		},
		provider,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mutations.asyncWrite },
		serverToolReplay: READY_SERVER_TOOL_REPLAY_RUNTIME,
	} as unknown as ProxyContext;
	ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry(
		parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "adv-codex",
					displayName: "Advisor Codex",
					selection: "capability",
					logicalModel: "claude-opus-5",
					expectedProvider: "codex",
					expectedPhysicalModel: PHYSICAL_MODEL,
					advisorEmulation: true,
				},
				{
					id: "plain-codex",
					displayName: "Plain Codex",
					selection: "capability",
					logicalModel: "claude-opus-5",
					expectedProvider: "codex",
					expectedPhysicalModel: PHYSICAL_MODEL,
				},
			]),
		),
	);
	return { ctx, mutations };
}

// The advisor tool object exactly as Claude Code declares it.
const ADVISOR_TOOL = {
	type: "advisor_20260301",
	name: "advisor",
	model: "claude-fable-5",
	max_uses: 3,
	caching: { type: "ephemeral", ttl: "5m" },
};
const READ_TOOL = {
	name: "Read",
	description: "Read a file",
	input_schema: {
		type: "object",
		properties: { path: { type: "string" } },
	},
};

function makeRequest(
	options: {
		model?: string;
		messages?: unknown[];
		tools?: unknown[];
		stream?: boolean;
		toolChoice?: unknown;
		signal?: AbortSignal;
	} = {},
): Request {
	const body: Record<string, unknown> = {
		model: options.model ?? OPTED_IN_MODEL,
		max_tokens: 64,
		stream: options.stream ?? true,
		tools: options.tools ?? [READ_TOOL, ADVISOR_TOOL],
		messages: options.messages ?? [{ role: "user", content: "review my plan" }],
	};
	if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": ADVISOR_BETA,
			authorization: "Bearer advisor-test-client",
			"x-claude-code-session-id": "advisor-codex-session",
		},
		body: JSON.stringify(body),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

// ---- fake Codex upstream (Responses-API SSE, NOT Anthropic SSE) ----------

type RespEvent = [string, Record<string, unknown>];

function responsesSse(events: RespEvent[]): Response {
	const text = events
		.map(
			([name, data]) =>
				`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`,
		)
		.join("");
	return new Response(text, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function completed(usage = { input_tokens: 10, output_tokens: 5 }): RespEvent {
	return [
		"response.completed",
		{ response: { id: "resp_x", status: "completed", usage } },
	];
}

function textEvents(text: string, outputIndex = 0): RespEvent[] {
	return [
		[
			"response.output_item.added",
			{ output_index: outputIndex, item: { type: "message", id: "msg_1" } },
		],
		[
			"response.content_part.added",
			{ output_index: outputIndex, part: { type: "output_text" } },
		],
		["response.output_text.delta", { output_index: outputIndex, delta: text }],
		[
			"response.output_item.done",
			{ output_index: outputIndex, item: { type: "message" } },
		],
	];
}

function callEvents(
	callId: string,
	name: string,
	args: string,
	outputIndex: number,
): RespEvent[] {
	return [
		[
			"response.output_item.added",
			{
				output_index: outputIndex,
				item: { type: "function_call", call_id: callId, name },
			},
		],
		[
			"response.function_call_arguments.delta",
			{ output_index: outputIndex, delta: args },
		],
		[
			"response.output_item.done",
			{
				output_index: outputIndex,
				item: {
					type: "function_call",
					call_id: callId,
					name,
					arguments: args,
				},
			},
		],
	];
}

function workerReply(opts: {
	text?: string;
	calls?: Array<{ callId: string; name: string; args?: string }>;
	usage?: { input_tokens: number; output_tokens: number };
}): Response {
	const events: RespEvent[] = [
		["response.created", { response: { id: "resp_w", model: PHYSICAL_MODEL } }],
	];
	let index = 0;
	if (opts.text !== undefined) {
		events.push(...textEvents(opts.text, index));
		index++;
	}
	for (const call of opts.calls ?? []) {
		events.push(
			...callEvents(call.callId, call.name, call.args ?? "{}", index),
		);
		index++;
	}
	events.push(completed(opts.usage));
	return responsesSse(events);
}

function advisorReply(
	text: string,
	usage = { input_tokens: 100, output_tokens: 20 },
): Response {
	return responsesSse([
		["response.created", { response: { id: "resp_a", model: "gpt-6-astra" } }],
		...textEvents(text),
		completed(usage),
	]);
}

interface UpstreamCall {
	url: string;
	body: Record<string, unknown>;
	signal: AbortSignal;
}

type Kind = "worker" | "advisor" | "continuation";

function classify(call: UpstreamCall): Kind {
	const tools = call.body.tools as unknown[] | undefined;
	if (!tools || tools.length === 0) return "advisor";
	const input = call.body.input as Array<Record<string, unknown>>;
	return input.at(-1)?.type === "function_call_output"
		? "continuation"
		: "worker";
}

function installFetch(
	respond: (
		call: UpstreamCall,
		kind: Kind,
		index: number,
	) => Response | Promise<Response>,
): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			const call: UpstreamCall = {
				url: request.url,
				body: JSON.parse(await request.text()) as Record<string, unknown>,
				signal: request.signal,
			};
			calls.push(call);
			return respond(call, classify(call), calls.length - 1);
		},
	) as unknown as typeof fetch;
	return calls;
}

interface ClientFrame {
	event: string;
	data: Record<string, any>;
}

function parseFrames(text: string): ClientFrame[] {
	const frames: ClientFrame[] = [];
	for (const chunk of text.split("\n\n")) {
		let event = "";
		let data = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data += line.slice(5).trim();
		}
		if (!event || !data) continue;
		try {
			frames.push({ event, data: JSON.parse(data) });
		} catch {
			// not JSON
		}
	}
	return frames;
}

function contentBlocks(frames: ClientFrame[]): Array<Record<string, any>> {
	return frames
		.filter((f) => f.event === "content_block_start")
		.map((f) => f.data.content_block as Record<string, any>);
}

function blockIndices(frames: ClientFrame[]): number[] {
	return frames
		.filter((f) => f.event === "content_block_start")
		.map((f) => f.data.index as number);
}

async function send(
	ctx: ProxyContext,
	request: Request,
): Promise<{ status: number; text: string; frames: ClientFrame[] }> {
	const response = await handleProxy(
		request,
		new URL(request.url),
		ctx,
		"key-1",
	);
	const text = await response.text();
	return { status: response.status, text, frames: parseFrames(text) };
}

const ADV_CALL_ID = "call_adv1";
const EMULATED_ID = `srvtoolu_bccf_${ADV_CALL_ID}`;

beforeEach(() => {
	process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
	delete process.env.BCCF_ADVISOR_EMULATION;
	resetAdvisorResultOwnershipForTests();
	const collector = {
		handleStart: mock(() => undefined),
		handleChunk: mock((_requestId: string, chunk: Uint8Array) => {
			collectedChunks.push(Buffer.from(chunk).toString());
		}),
		handleEnd: mock(async () => undefined),
	};
	collectedChunks = [];
	const required = spyOn(
		usageCollectorModule,
		"getUsageCollector",
	).mockReturnValue(collector as never);
	const optional = spyOn(
		usageCollectorModule,
		"tryGetUsageCollector",
	).mockReturnValue(collector as never);
	restoreUsageCollectors = () => {
		required.mockRestore();
		optional.mockRestore();
	};
});

afterEach(() => {
	restoreUsageCollectors();
	restoreUsageCollectors = (): void => {};
	globalThis.fetch = originalFetch;
	if (originalPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = originalPassthrough;
	}
	if (originalKillSwitch === undefined) {
		delete process.env.BCCF_ADVISOR_EMULATION;
	} else {
		process.env.BCCF_ADVISOR_EMULATION = originalKillSwitch;
	}
});

/** AE1 script: text + sole advisor call, advice, then a final text. */
function ae1Responder(adviceText = "Use the cache.") {
	return (_call: UpstreamCall, kind: Kind): Response => {
		if (kind === "worker") {
			return workerReply({
				text: "Let me check.",
				calls: [{ callId: ADV_CALL_ID, name: "advisor" }],
			});
		}
		if (kind === "advisor") return advisorReply(adviceText);
		return workerReply({ text: "Done." });
	};
}

describe("advisor emulation on an opted-in Codex route", () => {
	it("AE1: runs the worker, the advisor sub-call and the continuation, and splices one message", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(ae1Responder());

		const { status, text, frames } = await send(ctx, makeRequest());

		expect(status).toBe(200);
		expect(calls).toHaveLength(3);
		expect(calls.map((c) => classify(c))).toEqual([
			"worker",
			"advisor",
			"continuation",
		]);

		// Worker call: the typed declaration became a function tool named advisor.
		const workerTools = calls[0]?.body.tools as Array<Record<string, any>>;
		expect(
			workerTools.some((t) => t.type === "function" && t.name === "advisor"),
		).toBe(true);

		// Sub-call: advisor model, no tools, its own cache key.
		expect(calls[1]?.body.model).toBe("gpt-6-astra");
		expect(calls[1]?.body.tools ?? []).toEqual([]);
		expect(String(calls[1]?.body.prompt_cache_key)).toStartWith("bccf-adv-");

		// Continuation: ends with the call/output pair under one equal id.
		const input = calls[2]?.body.input as Array<Record<string, any>>;
		const call = input.at(-2);
		const output = input.at(-1);
		expect(call?.type).toBe("function_call");
		expect(output?.type).toBe("function_call_output");
		expect(call?.call_id).toBe(output?.call_id);
		expect(call?.call_id).toBe(EMULATED_ID);
		expect(String(output?.output)).toContain("Use the cache.");
		expect(calls[2]?.body.model).toBe(PHYSICAL_MODEL);

		// Client sees one Anthropic message.
		expect(frames.filter((f) => f.event === "message_start")).toHaveLength(1);
		expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(1);
		const blocks = contentBlocks(frames);
		expect(blocks.map((b) => b.type)).toEqual([
			"text",
			"server_tool_use",
			"advisor_tool_result",
			"text",
		]);
		expect(blocks[1]?.id).toBe(EMULATED_ID);
		expect(blocks[1]?.name).toBe("advisor");
		expect(blocks[2]?.tool_use_id).toBe(EMULATED_ID);
		expect(blocks[2]?.content).toEqual({
			type: "advisor_result",
			text: "Use the cache.",
		});
		expect(blockIndices(frames)).toEqual([0, 1, 2, 3]);
		const finalDelta = frames.filter((f) => f.event === "message_delta").at(-1);
		expect(finalDelta?.data.delta.stop_reason).toBe("end_turn");
		const iterations = finalDelta?.data.usage.iterations as Array<
			Record<string, any>
		>;
		expect(iterations.map((i) => i.type)).toEqual([
			"message",
			"advisor_message",
			"message",
		]);
		expect(iterations[1]?.model).toBe("gpt-6-astra");
		// The raw Responses stream never reaches the client.
		expect(text).not.toContain("response.output_item");
		// The usage collector tees the spliced bytes, not the first call's.
		const teed = collectedChunks.join("");
		expect(teed).toContain(EMULATED_ID);
		expect(teed).toContain("advisor_message");
	});

	it("AE2: drops an advisor call that has siblings without running a round", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(() =>
			workerReply({
				calls: [
					{ callId: ADV_CALL_ID, name: "advisor" },
					{ callId: "call_read1", name: "Read", args: '{"path":"a.ts"}' },
				],
			}),
		);

		const { status, frames } = await send(ctx, makeRequest());

		expect(status).toBe(200);
		expect(calls).toHaveLength(1);
		const blocks = contentBlocks(frames);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.type).toBe("tool_use");
		expect(blocks[0]?.name).toBe("Read");
		expect(blockIndices(frames)).toEqual([0]);
		const finalDelta = frames.filter((f) => f.event === "message_delta").at(-1);
		expect(finalDelta?.data.delta.stop_reason).toBe("tool_use");
	});

	it("AE3: a 429 on the sub-call becomes advisor_tool_result_error and the continuation still runs", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch((call, kind) => {
			if (kind === "advisor") {
				return new Response(
					JSON.stringify({
						error: { type: "rate_limit_error", message: "slow down" },
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			}
			return ae1Responder()(call, kind);
		});

		const { status, frames } = await send(ctx, makeRequest());

		expect(status).toBe(200);
		expect(calls).toHaveLength(3);
		const blocks = contentBlocks(frames);
		expect(blocks[2]?.content).toEqual({
			type: "advisor_tool_result_error",
			error_code: "too_many_requests",
		});
		const input = calls[2]?.body.input as Array<Record<string, any>>;
		expect(String(input.at(-1)?.output)).toBe(
			"Advisor unavailable (too_many_requests). Continue without advice.",
		);
		// The 429 belongs to the advisor round only: no account is benched.
		expect(
			(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock.calls,
		).toHaveLength(0);
	});

	it("AE4: the kill switch restores today's refusal with zero upstream fetches", async () => {
		process.env.BCCF_ADVISOR_EMULATION = "off";
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(ae1Responder());

		const { status } = await send(ctx, makeRequest());

		expect(status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("AE5: a profile without advisorEmulation keeps today's refusal", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(ae1Responder());

		const { status } = await send(ctx, makeRequest({ model: PLAIN_MODEL }));

		expect(status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("AE10: a forced tool_choice keeps today's refusal", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(ae1Responder());

		const { status } = await send(
			ctx,
			makeRequest({ toolChoice: { type: "any" } }),
		);

		expect(status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("AE6: replaying the emulated pair next turn reproduces the continuation's input prefix", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const first = installFetch(ae1Responder());
		await send(ctx, makeRequest());
		const continuationInput = first[2]?.body.input as unknown[];
		expect(continuationInput.length).toBeGreaterThan(0);

		const second = installFetch(() => workerReply({ text: "Next." }));
		const replay = makeRequest({
			messages: [
				{ role: "user", content: "review my plan" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check." },
						{
							type: "server_tool_use",
							id: EMULATED_ID,
							name: "advisor",
							input: {},
						},
						{
							type: "advisor_tool_result",
							tool_use_id: EMULATED_ID,
							content: { type: "advisor_result", text: "Use the cache." },
						},
						{ type: "text", text: "Done." },
					],
				},
				{ role: "user", content: "thanks, continue" },
			],
		});
		const { status } = await send(ctx, replay);

		expect(status).toBe(200);
		expect(second).toHaveLength(1);
		const replayInput = second[0]?.body.input as unknown[];
		expect(replayInput.slice(0, continuationInput.length)).toEqual(
			continuationInput,
		);
	});

	it("AE8: a client abort during the sub-call aborts it and starts no continuation", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const controller = new AbortController();
		let advisorSignal: AbortSignal | undefined;
		const calls = installFetch(async (call, kind) => {
			if (kind === "worker") return ae1Responder()(call, kind);
			if (kind === "advisor") {
				advisorSignal = call.signal;
				controller.abort();
				await new Promise((_, reject) => {
					call.signal.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			}
			return ae1Responder()(call, kind);
		});

		const request = makeRequest({ signal: controller.signal });
		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			"key-1",
		);
		await response.text().catch(() => "");
		await Bun.sleep(25);

		expect(calls.map((c) => classify(c))).toEqual(["worker", "advisor"]);
		expect(advisorSignal?.aborted).toBe(true);
	});

	it("AE9: exhausted rounds end with max_uses_exceeded, bounded worker calls and a clean stop", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		let workerCalls = 0;
		const calls = installFetch((_call, kind) => {
			if (kind === "advisor") return advisorReply("More advice.");
			workerCalls++;
			return workerReply({
				calls: [{ callId: `call_adv${workerCalls}`, name: "advisor" }],
			});
		});

		const { status, frames } = await send(ctx, makeRequest());

		expect(status).toBe(200);
		expect(workerCalls).toBe(4);
		expect(calls.filter((c) => classify(c) === "advisor")).toHaveLength(2);
		const results = contentBlocks(frames).filter(
			(b) => b.type === "advisor_tool_result",
		);
		expect(results.map((b) => b.content.error_code ?? b.content.type)).toEqual([
			"advisor_result",
			"advisor_result",
			"max_uses_exceeded",
			"max_uses_exceeded",
		]);
		expect(frames.filter((f) => f.event === "message_start")).toHaveLength(1);
		expect(frames.filter((f) => f.event === "message_stop")).toHaveLength(1);
		const finalDelta = frames.filter((f) => f.event === "message_delta").at(-1);
		expect(finalDelta?.data.delta.stop_reason).toBe("end_turn");
	});

	it("accepts a history whose emulated pair ends the message (consecutive user messages after projection)", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(() => workerReply({ text: "Continuing." }));
		const request = makeRequest({
			messages: [
				{ role: "user", content: "review my plan" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check." },
						{
							type: "server_tool_use",
							id: EMULATED_ID,
							name: "advisor",
							input: {},
						},
						{
							type: "advisor_tool_result",
							tool_use_id: EMULATED_ID,
							content: {
								type: "advisor_tool_result_error",
								error_code: "max_uses_exceeded",
							},
						},
					],
				},
				{ role: "user", content: "go on" },
			],
		});

		const { status } = await send(ctx, request);

		expect(status).toBe(200);
		expect(calls).toHaveLength(1);
		const input = calls[0]?.body.input as Array<Record<string, any>>;
		const types = input.map((i) => i.type ?? i.role);
		const callIndex = types.indexOf("function_call");
		expect(callIndex).toBeGreaterThan(-1);
		expect(types[callIndex + 1]).toBe("function_call_output");
		// The next user turn follows the output; both survive conversion.
		expect(input.at(-1)?.role).toBe("user");
		expect(String(input[callIndex + 1]?.output)).toBe(
			"Advisor unavailable (max_uses_exceeded). Continue without advice.",
		);
	});

	it("leaves a request with no advisor declaration untouched", async () => {
		const { ctx } = makeContext([makeCodexAccount()], "codex");
		const calls = installFetch(() => workerReply({ text: "Hi." }));

		const { status, frames } = await send(
			ctx,
			makeRequest({ tools: [READ_TOOL] }),
		);

		expect(status).toBe(200);
		expect(calls).toHaveLength(1);
		const tools = calls[0]?.body.tools as Array<Record<string, any>>;
		expect(tools.some((t) => t.name === "advisor")).toBe(false);
		expect(contentBlocks(frames).map((b) => b.type)).toEqual(["text"]);
	});
});

describe("emulated history on a first-party account", () => {
	it("AE7: strips the emulated pair but leaves a native pair untouched", async () => {
		const first = makeAccount();
		const { ctx } = makeContext([first], "anthropic");
		const upstream: Array<Record<string, any>> = [];
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				upstream.push(JSON.parse(await request.text()));
				return new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "claude-sonnet-4-5",
						content: [{ type: "text", text: "ok" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 3, output_tokens: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		) as unknown as typeof fetch;
		const request = makeRequest({
			model: "claude-sonnet-4-5",
			stream: false,
			messages: [
				{ role: "user", content: "review my plan" },
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: EMULATED_ID,
							name: "advisor",
							input: {},
						},
						{
							type: "advisor_tool_result",
							tool_use_id: EMULATED_ID,
							content: { type: "advisor_result", text: "emulated advice" },
						},
					],
				},
				{ role: "user", content: "and again" },
				{
					role: "assistant",
					content: [
						{
							type: "server_tool_use",
							id: "srvtoolu_native_1",
							name: "advisor",
							input: {},
						},
						{
							type: "advisor_tool_result",
							tool_use_id: "srvtoolu_native_1",
							content: { type: "advisor_result", text: "native advice" },
						},
						{ type: "text", text: "Applied it." },
					],
				},
				{ role: "user", content: "thanks" },
			],
		});

		const { status } = await send(ctx, request);

		expect(status).toBe(200);
		expect(upstream).toHaveLength(1);
		const serialized = JSON.stringify(upstream[0]?.messages);
		expect(serialized).not.toContain(EMULATED_ID);
		expect(serialized).not.toContain("emulated advice");
		expect(serialized).toContain("[Advisor response]");
		expect(serialized).toContain("srvtoolu_native_1");
		expect(serialized).toContain("native advice");
	});
});
