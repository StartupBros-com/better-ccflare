import { BUFFER_SIZES, SseFrameBuffer } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	type AnthropicServerToolEncoder,
	type AnthropicServerToolJsonCompletion,
	type AnthropicServerToolSseCompletion,
	createAnthropicServerToolJsonEncoder,
	createAnthropicServerToolSseEncoder,
} from "../../server-tools/anthropic-server-tool-encoder";
import {
	createHostedSearchLifecycleReducer,
	type HostedSearchLifecycleReducer,
} from "../../server-tools/hosted-search-lifecycle";
import type {
	ProviderAttemptPlan,
	ProviderAttemptPlanContext,
	ProviderUsageInfo,
	RateLimitInfo,
} from "../../types";
import {
	type CodexServerToolResponseDecoder,
	createCodexServerToolResponseDecoder,
} from "./server-tool-response";
import {
	CODEX_SERVER_TOOL_ENDPOINT,
	CODEX_SERVER_TOOL_MODEL,
	CODEX_UNSUPPORTED_WEB_SEARCH_SOURCES_INCLUDE,
	CodexServerToolConversionError,
	mapCodexServerToolRequest,
} from "./server-tools";
import { normalizeCodexResponseInputUsage } from "./usage";

type JsonRecord = Record<string, unknown>;

const log = new Logger("CodexHostedSearch");
const SAFE_ERROR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const UNSUPPORTED_PARAMETER =
	/^Unsupported parameter:\s*["'`]?([A-Za-z][A-Za-z0-9._-]{0,63})["'`]?\.?$/;

export type CodexHostedErrorCategory =
	| "unsupported_parameter"
	| "web_search_unavailable"
	| "tool_choice_invalid"
	| "model_unavailable"
	| "entitlement"
	| "policy"
	| "internal"
	| "other";

export interface CodexHostedErrorDiagnostic {
	readonly errorType: string | null;
	readonly errorCode: string | null;
	readonly errorParameter: string | null;
	readonly unsupportedParameter: string | null;
	readonly category: CodexHostedErrorCategory;
}

function safeIdentifier(value: unknown): string | null {
	return typeof value === "string" && SAFE_ERROR_IDENTIFIER.test(value)
		? value
		: null;
}

export function classifyCodexHostedError(
	value: unknown,
): CodexHostedErrorDiagnostic | null {
	if (!isRecord(value)) return null;
	let error: JsonRecord;
	if (value.type === "error") error = isRecord(value.error) ? value.error : {};
	else if (value.type === "response.failed") {
		const response = isRecord(value.response) ? value.response : {};
		error = isRecord(response.error) ? response.error : {};
	} else return null;
	const message = typeof error.message === "string" ? error.message : "";
	const unsupportedMatch = message.match(UNSUPPORTED_PARAMETER);
	const unsupportedParameter = unsupportedMatch?.[1] ?? null;
	let category: CodexHostedErrorCategory;
	if (unsupportedParameter) category = "unsupported_parameter";
	else if (
		/web.?search.*(?:not supported|unavailable|not enabled|access)/iu.test(
			message,
		)
	)
		category = "web_search_unavailable";
	else if (
		/tool.?choice.*(?:invalid|not supported|unsupported)/iu.test(message)
	)
		category = "tool_choice_invalid";
	else if (/model.*(?:not supported|unavailable|unsupported)/iu.test(message))
		category = "model_unavailable";
	else if (
		/(?:not authorized|not entitled|does not have access|do not have access|permission)/iu.test(
			message,
		)
	)
		category = "entitlement";
	else if (/(?:policy|safety|cyber)/iu.test(message)) category = "policy";
	else if (/(?:internal|server error|something went wrong)/iu.test(message))
		category = "internal";
	else category = "other";
	return Object.freeze({
		errorType: safeIdentifier(error.type),
		errorCode: safeIdentifier(error.code),
		errorParameter: safeIdentifier(error.param ?? error.parameter),
		unsupportedParameter,
		category,
	});
}

const NO_DATA_RETRY = Object.freeze({
	mode: "none" as const,
	maxAttempts: 0 as const,
});
const EXECUTING_OR_AMBIGUOUS = Object.freeze({
	decision: "executing_or_ambiguous" as const,
});

export interface CodexHostedSearchPlanDelegates {
	readonly prepareHeaders: (
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	) => Headers;
	readonly transformOrdinaryRequest: (request: Request) => Promise<Request>;
	readonly processHostedResponse: (
		response: Response,
		requestHeaders: Headers | undefined,
		requestedStream: boolean,
		replayIssuer: NonNullable<
			ProviderAttemptPlanContext["serverToolReplayIssuer"]
		>,
		capabilityProofKey: string,
		physicalModel: string,
	) => Promise<Response>;
	readonly parseRateLimit: (response: Response) => RateLimitInfo;
	readonly parseRateLimitFromBody?: (
		response: Response,
	) => Promise<number | undefined>;
	readonly isStreamingResponse?: (response: Response) => boolean;
	readonly extractTierInfo?: (response: Response) => Promise<number | null>;
	readonly extractUsageInfo?: (
		response: Response,
	) => Promise<ProviderUsageInfo | null>;
	readonly parseUsage?: (
		response: Response,
	) => Promise<ProviderUsageInfo | null>;
}

export interface ProcessCodexHostedSearchResponseOptions {
	readonly response: Response;
	readonly requestedStream: boolean;
	readonly replayIssuer: NonNullable<
		ProviderAttemptPlanContext["serverToolReplayIssuer"]
	>;
	readonly capabilityProofKey: string;
	readonly physicalModel: string;
	readonly sanitizeHeaders: (headers: Headers) => Headers;
	readonly sanitizeClientFunctionArguments: (
		name: string,
		argumentsJson: string,
	) => string;
	readonly fallback: () => Promise<Response>;
}

function rejected(): CodexServerToolConversionError {
	return new CodexServerToolConversionError();
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBodyBuffer(buffer: ArrayBuffer | null): JsonRecord {
	if (buffer === null) throw rejected();
	try {
		const body = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
		if (!isRecord(body)) throw rejected();
		return body;
	} catch {
		throw rejected();
	}
}

function sameReplay(
	actual: readonly string[],
	expected: readonly string[],
): boolean {
	return (
		actual.length === expected.length &&
		actual.every((value, index) => value === expected[index])
	);
}

function assertExactContext(context: ProviderAttemptPlanContext): {
	readonly requestedStream: boolean;
	readonly capabilityProofKey: string;
	readonly replayIssuer: NonNullable<
		ProviderAttemptPlanContext["serverToolReplayIssuer"]
	>;
} {
	const body = parseBodyBuffer(context.requestBodyBuffer);
	const proofKey = context.capabilityProofKey;
	const replayIssuer = context.serverToolReplayIssuer;
	const account = context.account;
	const hasReviewedInputReplay =
		sameReplay(context.inputReplayMode, []) ||
		sameReplay(context.inputReplayMode, ["native-Anthropic"]);
	if (
		typeof proofKey !== "string" ||
		proofKey.length === 0 ||
		context.path !== "/v1/messages" ||
		context.query !== "" ||
		context.physicalModel !== CODEX_SERVER_TOOL_MODEL ||
		!sameReplay(context.outputReplayMode, ["proxy-evidence-v1"]) ||
		!hasReviewedInputReplay ||
		typeof replayIssuer !== "function" ||
		account.provider !== "codex" ||
		account.api_key !== null ||
		(account.refresh_token === null && account.access_token === null) ||
		account.custom_endpoint !== null
	) {
		throw rejected();
	}
	if (
		context.inputReplayMode.length > 0 &&
		typeof context.serverToolHistoryProjector !== "function"
	) {
		throw rejected();
	}
	return {
		requestedStream: body.stream === true,
		capabilityProofKey: proofKey,
		replayIssuer,
	};
}

function cloneJson<T>(value: T): T {
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		throw rejected();
	}
}

function readUsage(value: unknown): {
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
} {
	const usage = isRecord(value) ? value : {};
	const details = isRecord(usage.input_tokens_details)
		? usage.input_tokens_details
		: undefined;
	const normalized = normalizeCodexResponseInputUsage(
		typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
		details,
	);
	return {
		inputTokens: normalized.inputTokens,
		cacheReadInputTokens: normalized.cacheReadInputTokens,
		cacheCreationInputTokens: normalized.cacheCreationInputTokens,
		outputTokens:
			typeof usage.output_tokens === "number" &&
			Number.isFinite(usage.output_tokens) &&
			usage.output_tokens >= 0
				? usage.output_tokens
				: 0,
	};
}

function parseSseFrame(frame: string): JsonRecord {
	let eventName: string | null = null;
	let dataText: string | null = null;
	for (const line of frame.split(/\r?\n/u)) {
		if (line.startsWith("event:")) {
			if (eventName !== null) throw rejected();
			eventName = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			if (dataText !== null) throw rejected();
			dataText = line.slice(5).trim();
		} else if (line !== "" && !line.startsWith(":")) {
			throw rejected();
		}
	}
	if (!eventName || !dataText || dataText === "[DONE]") throw rejected();
	let data: unknown;
	try {
		data = JSON.parse(dataText);
	} catch {
		throw rejected();
	}
	if (!isRecord(data) || data.type !== eventName) throw rejected();
	return data;
}

type FunctionAssembly = {
	readonly callId: string;
	readonly name: string;
	readonly arguments: string[];
};

class HostedResponsePipeline<
	TCompletion extends
		| AnthropicServerToolSseCompletion
		| AnthropicServerToolJsonCompletion,
> {
	private readonly decoder: CodexServerToolResponseDecoder =
		createCodexServerToolResponseDecoder();
	private readonly lifecycle: HostedSearchLifecycleReducer =
		createHostedSearchLifecycleReducer();
	private readonly functions = new Map<number, FunctionAssembly>();
	private encoder: AnthropicServerToolEncoder<TCompletion> | null = null;
	private terminalUsage = readUsage(undefined);
	private sawClientFunction = false;
	private sawCreated = false;
	private sawTerminal = false;

	constructor(
		private readonly createEncoder: (
			lifecycle: HostedSearchLifecycleReducer,
			base: Readonly<{
				messageId: string;
				model: string;
				inputTokens: number;
				cacheReadInputTokens: number;
				cacheCreationInputTokens: number;
			}>,
		) => AnthropicServerToolEncoder<TCompletion>,
		private readonly physicalModel: string,
		private readonly sanitizeClientFunctionArguments: (
			name: string,
			argumentsJson: string,
		) => string,
	) {}

	async accept(data: JsonRecord): Promise<TCompletion | null> {
		if (this.sawTerminal) throw rejected();
		const diagnostic = classifyCodexHostedError(data);
		if (diagnostic) log.warn("codex_hosted_search_upstream_error", diagnostic);
		if (!this.sawCreated) {
			if (data.type !== "response.created") throw rejected();
			const response = isRecord(data.response) ? data.response : {};
			const initialUsage = readUsage(response.usage);
			this.encoder = this.createEncoder(
				this.lifecycle,
				Object.freeze({
					messageId: `msg_${crypto.randomUUID().replace(/-/gu, "").slice(0, 24)}`,
					model:
						typeof response.model === "string" && response.model.length > 0
							? response.model
							: this.physicalModel,
					inputTokens: initialUsage.inputTokens,
					cacheReadInputTokens: initialUsage.cacheReadInputTokens,
					cacheCreationInputTokens: initialUsage.cacheCreationInputTokens,
				}),
			);
			this.sawCreated = true;
		}
		const encoder = this.encoder;
		if (encoder === null) throw rejected();

		const lifecycleInputs = this.decoder.acceptSseEvent(data);
		for (const input of lifecycleInputs) {
			const event = this.lifecycle.accept(input);
			await encoder.accept(event);
		}
		await this.acceptClientFunction(data, encoder);

		if (
			data.type === "response.completed" ||
			data.type === "response.incomplete" ||
			data.type === "response.failed" ||
			data.type === "error"
		) {
			const response = isRecord(data.response) ? data.response : {};
			this.terminalUsage = readUsage(response.usage);
			if (this.functions.size !== 0) throw rejected();
			this.sawTerminal = true;
			return encoder.complete({
				inputTokens: this.terminalUsage.inputTokens,
				cacheReadInputTokens: this.terminalUsage.cacheReadInputTokens,
				cacheCreationInputTokens: this.terminalUsage.cacheCreationInputTokens,
				outputTokens: this.terminalUsage.outputTokens,
				clientFunctionPending: this.sawClientFunction,
			});
		}
		return null;
	}

	abort(): void {
		this.decoder.abort();
		this.encoder?.abort();
		this.functions.clear();
	}

	assertTerminal(): void {
		if (!this.sawTerminal) throw rejected();
	}

	private async acceptClientFunction(
		data: JsonRecord,
		encoder: AnthropicServerToolEncoder<TCompletion>,
	): Promise<void> {
		const outputIndex = data.output_index;
		if (data.type === "response.output_item.added") {
			const item = isRecord(data.item) ? data.item : undefined;
			if (item?.type !== "function_call") return;
			if (
				!Number.isSafeInteger(outputIndex) ||
				typeof item.call_id !== "string" ||
				typeof item.name !== "string" ||
				this.functions.has(outputIndex as number)
			) {
				throw rejected();
			}
			const assembly = {
				callId: item.call_id,
				name: item.name,
				arguments: [],
			};
			this.functions.set(outputIndex as number, assembly);
			this.sawClientFunction = true;
			await encoder.acceptClientFunction({
				type: "start",
				callId: assembly.callId,
				name: assembly.name,
			});
			return;
		}
		if (data.type === "response.function_call_arguments.delta") {
			if (
				!Number.isSafeInteger(outputIndex) ||
				typeof data.delta !== "string"
			) {
				throw rejected();
			}
			const assembly = this.functions.get(outputIndex as number);
			if (!assembly) throw rejected();
			assembly.arguments.push(data.delta);
			await encoder.acceptClientFunction({
				type: "arguments_delta",
				callId: assembly.callId,
				delta: data.delta,
			});
			return;
		}
		if (data.type !== "response.output_item.done") return;
		const item = isRecord(data.item) ? data.item : undefined;
		if (item?.type !== "function_call") return;
		if (!Number.isSafeInteger(outputIndex)) throw rejected();
		const assembly = this.functions.get(outputIndex as number);
		if (
			!assembly ||
			item.call_id !== assembly.callId ||
			item.name !== assembly.name
		) {
			throw rejected();
		}
		const rawArguments = assembly.arguments.join("");
		if (typeof item.arguments === "string" && item.arguments !== rawArguments) {
			throw rejected();
		}
		const normalizedArgumentsJson = this.sanitizeClientFunctionArguments(
			assembly.name,
			rawArguments,
		);
		await encoder.acceptClientFunction({
			type: "complete",
			callId: assembly.callId,
			normalizedArgumentsJson,
		});
		this.functions.delete(outputIndex as number);
	}
}

async function consumeHostedSse<
	TCompletion extends
		| AnthropicServerToolSseCompletion
		| AnthropicServerToolJsonCompletion,
>(
	response: Response,
	pipeline: HostedResponsePipeline<TCompletion>,
	signal?: AbortSignal,
): Promise<TCompletion> {
	const reader = response.body?.getReader();
	if (!reader) throw rejected();
	const frames = new SseFrameBuffer({
		maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
		maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
	});
	let completion: TCompletion | null = null;
	const cancel = () => {
		pipeline.abort();
		try {
			void reader.cancel(signal?.reason).catch(() => undefined);
		} catch {
			// Best effort; the main cleanup path still releases the reader.
		}
	};
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		if (signal?.aborted) throw rejected();
		while (true) {
			const { done, value } = await reader.read();
			if (signal?.aborted) throw rejected();
			if (done) break;
			for (const frame of frames.push(value)) {
				if (completion !== null) throw rejected();
				completion = await pipeline.accept(parseSseFrame(frame));
			}
		}
		if (frames.flush() !== "" || completion === null) throw rejected();
		pipeline.assertTerminal();
		return completion;
	} catch {
		pipeline.abort();
		try {
			await reader.cancel();
		} catch {
			// Best-effort cleanup; preserve the content-free boundary.
		}
		throw rejected();
	} finally {
		signal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

export async function processCodexHostedSearchResponse(
	options: ProcessCodexHostedSearchResponseOptions,
): Promise<Response> {
	const contentType = options.response.headers.get("content-type");
	const isSse =
		contentType?.includes("text/event-stream") ??
		(options.response.ok && options.response.body !== null);
	if (!isSse) {
		if (!options.response.ok) return options.fallback();
		throw rejected();
	}
	const headers = options.sanitizeHeaders(options.response.headers);
	if (!options.requestedStream) {
		const pipeline = new HostedResponsePipeline(
			(lifecycle, base) =>
				createAnthropicServerToolJsonEncoder({
					lifecycle,
					replayIssuer: options.replayIssuer,
					replay: {
						physicalModel: options.physicalModel,
						fidelity: options.capabilityProofKey,
					},
					base,
				}),
			options.physicalModel,
			options.sanitizeClientFunctionArguments,
		);
		const completion = await consumeHostedSse(options.response, pipeline);
		headers.set("content-type", "application/json");
		headers.delete("content-length");
		return new Response(completion.json, {
			status: options.response.status,
			statusText: options.response.statusText,
			headers,
		});
	}

	headers.set("content-type", "text/event-stream");
	headers.delete("content-length");
	const upstream = options.response;
	const downstreamAbort = new AbortController();
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			const outputEncoder = new TextEncoder();
			const pipeline = new HostedResponsePipeline(
				(lifecycle, base) =>
					createAnthropicServerToolSseEncoder({
						lifecycle,
						replayIssuer: options.replayIssuer,
						replay: {
							physicalModel: options.physicalModel,
							fidelity: options.capabilityProofKey,
						},
						base,
						writeEvent: ({ wire }, signal) => {
							if (signal.aborted) throw rejected();
							controller.enqueue(outputEncoder.encode(wire));
						},
					}),
				options.physicalModel,
				options.sanitizeClientFunctionArguments,
			);
			void consumeHostedSse(upstream, pipeline, downstreamAbort.signal).then(
				() => controller.close(),
				() => {
					try {
						controller.enqueue(
							outputEncoder.encode(
								'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Codex server-tool response decoding failed"}}\n\n',
							),
						);
						controller.close();
					} catch {
						// Downstream was already cancelled.
					}
				},
			);
		},
		cancel(reason) {
			downstreamAbort.abort(reason);
		},
	});
	return new Response(readable, {
		status: options.response.status,
		statusText: options.response.statusText,
		headers,
	});
}

async function projectContinuation(
	body: JsonRecord,
	context: ProviderAttemptPlanContext,
): Promise<JsonRecord> {
	if (sameReplay(context.inputReplayMode, [])) return body;
	const projector = context.serverToolHistoryProjector;
	if (typeof projector !== "function") throw rejected();
	const messages = body.messages;
	const projection = await projector(messages);
	if (projection.nativeOpaquePositions.length !== 0) throw rejected();
	if (!Array.isArray(messages)) throw rejected();

	const projected = cloneJson(body);
	const projectedMessages = projected.messages;
	if (!Array.isArray(projectedMessages)) throw rejected();
	const groupedCitations = new Map<string, string[]>();
	for (const replacement of projection.replacements) {
		const message = projectedMessages[replacement.messageIndex];
		if (!isRecord(message) || message.role !== replacement.role)
			throw rejected();
		const content = message.content;
		if (!Array.isArray(content)) throw rejected();
		const block = content[replacement.blockIndex];
		if (!isRecord(block)) throw rejected();
		if (replacement.sourceType === "web_search_citation") {
			if (block.type !== "text" || typeof block.text !== "string")
				throw rejected();
			const citations = block.citations;
			if (
				!Array.isArray(citations) ||
				citations[replacement.citationIndex] === undefined
			) {
				throw rejected();
			}
			const key = `${replacement.messageIndex}:${replacement.blockIndex}`;
			const values = groupedCitations.get(key) ?? [];
			values.push(replacement.text);
			groupedCitations.set(key, values);
			continue;
		}
		if (
			block.type !== replacement.sourceType ||
			(block.id ?? block.tool_use_id) !== replacement.callId
		) {
			throw rejected();
		}
		content[replacement.blockIndex] = {
			type: "text",
			text: replacement.text,
		};
	}
	for (const [key, values] of groupedCitations) {
		const [messageIndexText, blockIndexText] = key.split(":");
		const messageIndex = Number(messageIndexText);
		const blockIndex = Number(blockIndexText);
		const message = projectedMessages[messageIndex];
		if (!isRecord(message) || !Array.isArray(message.content)) throw rejected();
		const block = message.content[blockIndex];
		if (
			!isRecord(block) ||
			block.type !== "text" ||
			typeof block.text !== "string"
		) {
			throw rejected();
		}
		block.text = [block.text, ...values].filter(Boolean).join("\n");
		delete block.citations;
	}
	return projected;
}

async function transformHostedRequest(
	request: Request,
	context: ProviderAttemptPlanContext,
	delegates: CodexHostedSearchPlanDelegates,
): Promise<Request> {
	let body: JsonRecord;
	try {
		body = (await request.clone().json()) as JsonRecord;
	} catch {
		throw rejected();
	}
	if (!isRecord(body)) throw rejected();
	const projected = await projectContinuation(body, context);

	const projectedHeaders = new Headers(request.headers);
	projectedHeaders.delete("content-length");
	projectedHeaders.set(
		"x-better-ccflare-final-model",
		context.physicalModel ?? CODEX_SERVER_TOOL_MODEL,
	);
	const ordinary = await delegates.transformOrdinaryRequest(
		new Request(request.url, {
			method: request.method,
			headers: projectedHeaders,
			body: JSON.stringify(projected),
		}),
	);
	let converted: JsonRecord;
	try {
		converted = (await ordinary.clone().json()) as JsonRecord;
	} catch {
		throw rejected();
	}
	if (
		!isRecord(converted) ||
		converted.model !== context.physicalModel ||
		converted.stream !== true ||
		converted.store !== false ||
		!Array.isArray(converted.input)
	) {
		throw rejected();
	}
	const projectedTools = Array.isArray(projected.tools) ? projected.tools : [];
	const offersOrchestration = projectedTools.some(
		(tool) => isRecord(tool) && (tool.name === "Agent" || tool.name === "Task"),
	);
	const convertedTools = Array.isArray(converted.tools) ? converted.tools : [];
	const retainedOrchestration = convertedTools.some(
		(tool) => isRecord(tool) && (tool.name === "Agent" || tool.name === "Task"),
	);
	const mapping = mapCodexServerToolRequest(projected, {
		filterOrchestrationTools: offersOrchestration && !retainedOrchestration,
	});
	if (mapping === undefined) throw rejected();
	converted.tools = mapping.tools;
	const retainedIncludes = [
		...new Set(Array.isArray(converted.include) ? converted.include : []),
	].filter((value) => value !== CODEX_UNSUPPORTED_WEB_SEARCH_SOURCES_INCLUDE);
	if (retainedIncludes.length === 0) delete converted.include;
	else converted.include = retainedIncludes;
	// The ChatGPT Codex subscription endpoint rejects Responses API
	// `max_tool_calls`. Preserve Anthropic max_uses in the capability/option
	// profile, but never emit the unsupported field on this reviewed wire path.
	delete converted.max_tool_calls;
	if (
		isRecord(converted.tool_choice) &&
		converted.tool_choice.type === "function" &&
		converted.tool_choice.name === "web_search"
	) {
		// Claude's forced WebSearch request offers exactly one retained tool. Use
		// the standard Responses required form instead of a backend-specific hosted
		// tool selector; the result still cannot select anything except WebSearch.
		converted.tool_choice = "required";
	}
	const headers = new Headers(ordinary.headers);
	headers.delete("content-length");
	return new Request(ordinary.url, {
		method: ordinary.method,
		headers,
		body: JSON.stringify(converted),
	});
}

export function createCodexHostedSearchAttemptPlan(
	context: ProviderAttemptPlanContext,
	delegates: CodexHostedSearchPlanDelegates,
): ProviderAttemptPlan {
	const { requestedStream, capabilityProofKey, replayIssuer } =
		assertExactContext(context);
	const plan: ProviderAttemptPlan = {
		providerName: "codex",
		targetUrl: CODEX_SERVER_TOOL_ENDPOINT,
		apiFamily: "codex:hosted-search:v1",
		physicalModel: context.physicalModel,
		capabilityProofKey,
		inputReplayMode: Object.freeze([...context.inputReplayMode]),
		outputReplayMode: Object.freeze([...context.outputReplayMode]),
		dataRetryPolicy: NO_DATA_RETRY,
		classifyNoExecution: async () => EXECUTING_OR_AMBIGUOUS,
		cacheReplayModelStrategy: "transformed-body",
		prepareHeaders: delegates.prepareHeaders,
		transformRequestBody: (request) =>
			transformHostedRequest(request, context, delegates),
		processResponse: (response, requestHeaders) =>
			delegates.processHostedResponse(
				response,
				requestHeaders,
				requestedStream,
				replayIssuer,
				capabilityProofKey,
				context.physicalModel ?? CODEX_SERVER_TOOL_MODEL,
			),
		parseRateLimit: delegates.parseRateLimit,
		...(delegates.parseRateLimitFromBody
			? { parseRateLimitFromBody: delegates.parseRateLimitFromBody }
			: {}),
		...(delegates.isStreamingResponse
			? { isStreamingResponse: delegates.isStreamingResponse }
			: {}),
		...(delegates.extractTierInfo
			? { extractTierInfo: delegates.extractTierInfo }
			: {}),
		...(delegates.extractUsageInfo
			? { extractUsageInfo: delegates.extractUsageInfo }
			: {}),
		...(delegates.parseUsage ? { parseUsage: delegates.parseUsage } : {}),
	};
	return Object.freeze(plan);
}
