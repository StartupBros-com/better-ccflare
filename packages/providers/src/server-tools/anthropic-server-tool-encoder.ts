import { BUFFER_SIZES } from "@better-ccflare/core";
import type { ProviderServerToolReplayIssuer } from "../types";
import type {
	HostedSearchCitation,
	HostedSearchCitedAnswerTextEvent,
	HostedSearchFinalizationVerdict,
	HostedSearchLifecycleEvent,
	HostedSearchLifecycleReducer,
	HostedSearchLifecycleSnapshot,
	HostedSearchResultErrorCode,
	HostedSearchResultErrorEvent,
	HostedSearchResultEvent,
	HostedSearchSource,
} from "./hosted-search-lifecycle";

const WEB_SEARCH_TOOL_TYPE = "web_search_20250305" as const;
const WEB_SEARCH_TOOL_NAME = "web_search" as const;
const REPLAY_PROVIDER = "codex" as const;
const MAX_STRUCTURAL_BYTES = 256;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const MAX_TITLE_BYTES = 2 * 1024;
const MAX_PAGE_AGE_BYTES = 256;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_ARRAY_ITEMS = 1024;
const MAX_TRANSLATED_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CLIENT_FUNCTION_NAME_BYTES = 256;
const PUBLIC_MESSAGE_ID = /^msg_[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const PUBLIC_CALL_ID = /^srvtoolu_[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const FORBIDDEN_STRUCTURAL_SCALAR = /[\p{Cc}\p{Cf}]/u;
const URL_WHITESPACE = /\s/u;
const RESULT_ERROR_CODES = new Set<HostedSearchResultErrorCode>([
	"too_many_requests",
	"invalid_tool_input",
	"max_uses_exceeded",
	"query_too_long",
	"request_too_large",
	"unavailable",
]);
const DIRECT_CALLER = Object.freeze({ type: "direct" as const });
const ABORTED_LIFECYCLE_FALLBACK: HostedSearchLifecycleSnapshot = Object.freeze(
	{
		status: "aborted",
		terminalReason: null,
		activeCallAssemblies: 0,
		compactCallProvenance: 0,
		activeCitationAssemblies: 0,
		retainedAnswerProvenance: 0,
		retainedSourceProvenance: 0,
		releasedCallAssemblies: 0,
		releasedCitationAssemblies: 0,
		uniqueSourceCount: 0,
		citationCount: 0,
		completedSearchCalls: 0,
		successfulSearchCalls: 0,
		emptySearchCalls: 0,
		erroredSearchCalls: 0,
		observedWebSearchRequests: null,
		providerReportedWebSearchRequests: null,
		usageReconciliation: "unknown",
		replayEnvelopeCount: 0,
		replayEnvelopeBytes: 0,
		retainedSemanticIdentityBytes: 0,
		liveSemanticBytes: 0,
	},
);

export const ANTHROPIC_SERVER_TOOL_ENCODING_ERROR_CODE =
	"anthropic_server_tool_encoding_failed" as const;
export const ANTHROPIC_SERVER_TOOL_ENCODING_ERROR_MESSAGE =
	"Anthropic server-tool response encoding failed." as const;

/** Content-free boundary for replay, lifecycle, sink, and serialization faults. */
export class AnthropicServerToolEncodingError extends Error {
	readonly code = ANTHROPIC_SERVER_TOOL_ENCODING_ERROR_CODE;

	constructor() {
		super(ANTHROPIC_SERVER_TOOL_ENCODING_ERROR_MESSAGE);
		Object.defineProperty(this, "name", {
			value: "AnthropicServerToolEncodingError",
			configurable: true,
		});
	}
}

export interface AnthropicServerToolReplayContext {
	/** Exact physical model that produced the evidence. */
	readonly physicalModel: string;
	/** Caller-supplied, collision-resistant proof and decoder fidelity label. */
	readonly fidelity: string;
}

/**
 * Narrow immutable state known before any downstream content is emitted.
 * The message id must be proxy-owned (`msg_...`), never a native provider id.
 */
export interface AnthropicServerToolBaseContext {
	readonly messageId: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly cacheCreationInputTokens: number;
	readonly startContentBlockIndex?: number;
}

/** State that becomes authoritative only at the hosted lifecycle terminal. */
export interface AnthropicServerToolTerminalContext {
	readonly inputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly cacheCreationInputTokens: number;
	readonly outputTokens: number;
	readonly clientFunctionPending: boolean;
}

export interface AnthropicServerToolSseEvent {
	readonly event: string;
	readonly data: unknown;
	/** Complete direct SSE frame; callers never need to serialize or reparse JSON. */
	readonly wire: string;
}

/**
 * The signal is the request-scoped cancellation gate. Implementations MUST
 * check `signal.aborted` immediately before every externally visible write.
 * Continuing delivery after cancellation violates the encoder contract; the
 * encoder converts detectable violations to its content-free failure boundary.
 */
export type AnthropicServerToolWriteSseEvent = (
	event: AnthropicServerToolSseEvent,
	signal: AbortSignal,
) => void | Promise<void>;

/** Cancellation-aware, content-free observation after canonical JSON encoding. */
export type AnthropicServerToolObserveJsonSerialization = (
	observation: Readonly<{ byteLength: number }>,
	signal: AbortSignal,
) => void | Promise<void>;

export interface AnthropicServerToolCompletion {
	readonly stopReason: AnthropicMessageStopReason;
	readonly usage: AnthropicMessageUsage;
	readonly contentBlockCount: number;
	readonly lifecycle: HostedSearchLifecycleSnapshot;
}

export interface AnthropicServerToolSseCompletion
	extends AnthropicServerToolCompletion {
	readonly sseEventCount: number;
	readonly sseBytes: number;
}

export interface AnthropicServerToolJsonCompletion
	extends AnthropicServerToolCompletion {
	readonly body: AnthropicMessageBody;
	readonly json: string;
}

/** Frozen cancellation receipt with no request-scoped semantic provenance. */
export interface AnthropicServerToolAbortSnapshot {
	readonly status: "aborted";
	readonly retainedHostedQueries: 0;
	readonly retainedHostedCalls: 0;
	readonly retainedAnswerBlocks: 0;
	readonly retainedClientFunctions: 0;
	readonly retainedClientFunctionArgumentBytes: 0;
	readonly lifecycle: HostedSearchLifecycleSnapshot;
}

export interface AnthropicServerToolEncoder<
	TCompletion extends AnthropicServerToolCompletion,
> {
	accept(event: HostedSearchLifecycleEvent): Promise<void>;
	acceptClientFunction(
		event: AnthropicClientFunctionIntegrationEvent,
	): Promise<void>;
	complete(terminal: AnthropicServerToolTerminalContext): Promise<TCompletion>;
	abort(): AnthropicServerToolAbortSnapshot;
}

/**
 * Already-normalized bridge from the existing Codex function-call path. Raw
 * argument deltas are bounded here; `normalizedArgumentsJson` is the exact
 * legacy-sanitized JSON emitted at item completion.
 */
export type AnthropicClientFunctionIntegrationEvent =
	| Readonly<{
			type: "start";
			callId: string;
			name: string;
	  }>
	| Readonly<{
			type: "arguments_delta";
			callId: string;
			delta: string;
	  }>
	| Readonly<{
			type: "complete";
			callId: string;
			normalizedArgumentsJson: string;
	  }>;

export interface AnthropicServerToolSseEncoderOptions {
	readonly lifecycle: HostedSearchLifecycleReducer;
	readonly replayIssuer: ProviderServerToolReplayIssuer;
	readonly replay: AnthropicServerToolReplayContext;
	readonly base: AnthropicServerToolBaseContext;
	readonly writeEvent: AnthropicServerToolWriteSseEvent;
}

export interface AnthropicServerToolJsonEncoderOptions {
	readonly lifecycle: HostedSearchLifecycleReducer;
	readonly replayIssuer: ProviderServerToolReplayIssuer;
	readonly replay: AnthropicServerToolReplayContext;
	readonly base: AnthropicServerToolBaseContext;
	/** Content-free observation called once after canonical JSON serialization. */
	readonly observeJsonSerialization?: AnthropicServerToolObserveJsonSerialization;
}

export type AnthropicMessageStopReason =
	| "end_turn"
	| "tool_use"
	| "max_tokens"
	| "refusal";

export interface AnthropicMessageUsage {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_read_input_tokens: number;
	readonly cache_creation_input_tokens: number;
	readonly server_tool_use: Readonly<{ web_search_requests: number }>;
}

export interface AnthropicServerToolUseBlock {
	readonly type: "server_tool_use";
	readonly id: string;
	readonly name: "web_search";
	readonly caller: Readonly<{ type: "direct" }>;
	readonly input: Readonly<{ query: string }>;
}

export interface AnthropicWebSearchResult {
	readonly type: "web_search_result";
	readonly url: string;
	readonly title: string;
	readonly page_age: string | null;
	readonly encrypted_content: string;
}

export interface AnthropicWebSearchResultError {
	readonly type: "web_search_tool_result_error";
	readonly error_code: HostedSearchResultErrorCode;
}

export interface AnthropicWebSearchToolResultBlock {
	readonly type: "web_search_tool_result";
	readonly tool_use_id: string;
	readonly caller: Readonly<{ type: "direct" }>;
	readonly content:
		| readonly AnthropicWebSearchResult[]
		| AnthropicWebSearchResultError;
}

export interface AnthropicWebSearchCitation {
	readonly type: "web_search_result_location";
	readonly url: string;
	readonly title: string;
	readonly cited_text: string;
	readonly encrypted_index: string;
}

export interface AnthropicTextBlock {
	readonly type: "text";
	readonly text: string;
	readonly citations?: readonly AnthropicWebSearchCitation[];
}

export interface AnthropicClientToolUseBlock {
	readonly type: "tool_use";
	readonly id: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export type AnthropicServerToolContentBlock =
	| AnthropicServerToolUseBlock
	| AnthropicWebSearchToolResultBlock
	| AnthropicTextBlock
	| AnthropicClientToolUseBlock;

export interface AnthropicMessageBody {
	readonly id: string;
	readonly type: "message";
	readonly role: "assistant";
	readonly model: string;
	readonly content: readonly AnthropicServerToolContentBlock[];
	readonly stop_reason: AnthropicMessageStopReason;
	readonly stop_sequence: null;
	readonly usage: AnthropicMessageUsage;
}

type JsonRecord = Record<string, unknown>;

type BaseSnapshot = Readonly<{
	messageId: string;
	model: string;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	startContentBlockIndex: number;
}>;

type ReplaySnapshot = Readonly<{
	physicalModel: string;
	fidelity: string;
}>;

type TerminalSnapshot = Readonly<{
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	clientFunctionPending: boolean;
}>;

type SourceSnapshot = Readonly<{
	sourceRef: string;
	url: string;
	title: string;
	pageAge: string | null;
	ordinal: number;
}>;

type CitationSnapshot = Readonly<{
	callId: string;
	sourceRef: string;
	sourceOrdinal: number;
	citationOrdinal: number;
	originalIndex: number;
	startCharIndex: number;
	endCharIndex: number;
	citedText: string;
	source: SourceSnapshot;
}>;

type ResultSnapshot = Readonly<{
	type: "result";
	callId: string;
	queryOrdinal: 0;
	query: string;
	state: "result" | "empty";
	sources: readonly SourceSnapshot[];
}>;

type ResultErrorSnapshot = Readonly<{
	type: "result_error";
	callId: string;
	queryOrdinal: 0;
	query: string;
	errorCode: HostedSearchResultErrorCode;
}>;

type AnswerSnapshot = Readonly<{
	type: "cited_answer_text";
	blockId: string;
	text: string;
	citations: readonly CitationSnapshot[];
}>;

type RelevantEventSnapshot =
	| Readonly<{
			type: "query_known";
			callId: string;
			queryOrdinal: 0;
			query: string;
	  }>
	| ResultSnapshot
	| ResultErrorSnapshot
	| AnswerSnapshot
	| Readonly<{ type: "other" }>;

type CompletedCall = Readonly<{
	queryOrdinal: 0;
	query: string;
	state: "result" | "empty" | "error";
	sources: ReadonlyMap<number, SourceSnapshot>;
}>;

type ClientFunctionAssembly = {
	readonly callId: string;
	readonly name: string;
	readonly index: number;
	readonly argumentDeltas: string[];
	argumentBytes: number;
};

type ClientFunctionSnapshot =
	| Readonly<{ type: "start"; callId: string; name: string }>
	| Readonly<{ type: "arguments_delta"; callId: string; delta: string }>
	| Readonly<{
			type: "complete";
			callId: string;
			normalizedArgumentsJson: string;
			input: Readonly<Record<string, unknown>>;
	  }>;

interface CanonicalSink<TSinkCompletion extends object> {
	abort(): void;
	start(base: BaseSnapshot): Promise<void>;
	emit(block: AnthropicServerToolContentBlock, index: number): Promise<void>;
	startClientFunction(
		block: Omit<AnthropicClientToolUseBlock, "input">,
		index: number,
	): Promise<void>;
	completeClientFunction(
		block: AnthropicClientToolUseBlock,
		normalizedArgumentsJson: string,
		index: number,
	): Promise<void>;
	complete(
		base: BaseSnapshot,
		stopReason: AnthropicMessageStopReason,
		usage: AnthropicMessageUsage,
	): Promise<TSinkCompletion>;
}

const textEncoder = new TextEncoder();

function rejected(): AnthropicServerToolEncodingError {
	return new AnthropicServerToolEncodingError();
}

function fail(): never {
	throw rejected();
}

type AbortableOutcome<T> =
	| Readonly<{ status: "fulfilled"; value: T }>
	| Readonly<{ status: "rejected" }>
	| Readonly<{ status: "aborted" }>;

const ABORTABLE_REJECTED = Object.freeze({ status: "rejected" as const });
const ABORTABLE_ABORTED = Object.freeze({ status: "aborted" as const });

/**
 * Races request work against cancellation without ever abandoning a rejecting
 * promise. The normalized `settled` branch remains attached after abort, so a
 * provider or observer that settles late cannot create an unhandled rejection.
 */
async function settleAbortable<T>(
	signal: AbortSignal,
	operation: () => T | PromiseLike<T>,
): Promise<AbortableOutcome<T>> {
	if (signal.aborted) return ABORTABLE_ABORTED;
	let operationResult: T | PromiseLike<T>;
	try {
		operationResult = operation();
	} catch {
		return ABORTABLE_REJECTED;
	}
	const settled: Promise<AbortableOutcome<T>> = Promise.resolve(
		operationResult,
	).then(
		(value): AbortableOutcome<T> =>
			Object.freeze({ status: "fulfilled" as const, value }),
		(): AbortableOutcome<T> => ABORTABLE_REJECTED,
	);
	if (signal.aborted) return ABORTABLE_ABORTED;

	let onAbort: (() => void) | undefined;
	const aborted = new Promise<AbortableOutcome<T>>((resolve) => {
		onAbort = () => resolve(ABORTABLE_ABORTED);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		const outcome = await Promise.race([settled, aborted]);
		return signal.aborted ? ABORTABLE_ABORTED : outcome;
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
	if (!isRecord(value)) fail();
	return value;
}

function own(record: JsonRecord, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined || !("value" in descriptor)) fail();
	return descriptor.value;
}

function optionalOwn(record: JsonRecord, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) fail();
	return descriptor.value;
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
			continue;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
	}
	return false;
}

function boundedString(
	value: unknown,
	maxBytes: number,
	options: Readonly<{
		nonEmpty?: boolean;
		structural?: boolean;
	}> = {},
): string {
	if (
		typeof value !== "string" ||
		hasLoneSurrogate(value) ||
		(options.nonEmpty === true && value.length === 0) ||
		(options.structural === true && FORBIDDEN_STRUCTURAL_SCALAR.test(value)) ||
		textEncoder.encode(value).byteLength > maxBytes
	) {
		fail();
	}
	return value;
}

function safeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail();
	}
	return value;
}

function singleQueryOrdinal(value: unknown): 0 {
	if (value !== 0) fail();
	return 0;
}

function publicMessageId(value: unknown): string {
	const id = boundedString(value, MAX_STRUCTURAL_BYTES, {
		nonEmpty: true,
		structural: true,
	});
	if (!PUBLIC_MESSAGE_ID.test(id)) fail();
	return id;
}

function publicCallId(value: unknown): string {
	const id = boundedString(value, MAX_STRUCTURAL_BYTES, {
		nonEmpty: true,
		structural: true,
	});
	if (!PUBLIC_CALL_ID.test(id)) fail();
	return id;
}

function clientFunctionCallId(value: unknown): string {
	return boundedString(value, MAX_STRUCTURAL_BYTES, {
		nonEmpty: true,
		structural: true,
	});
}

function canonicalUrl(value: unknown): string {
	const input = boundedString(value, MAX_URL_BYTES, {
		nonEmpty: true,
		structural: true,
	});
	if (URL_WHITESPACE.test(input) || input.includes("\\")) fail();
	let parsed: URL;
	let decoded: string;
	try {
		parsed = new URL(input);
		decoded = decodeURI(input);
	} catch {
		fail();
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.href !== input ||
		URL_WHITESPACE.test(decoded) ||
		decoded.includes("\\") ||
		FORBIDDEN_STRUCTURAL_SCALAR.test(decoded)
	) {
		fail();
	}
	return input;
}

function immutableArray(value: unknown): readonly unknown[] {
	if (!Array.isArray(value) || !Object.isFrozen(value)) fail();
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		lengthDescriptor === undefined ||
		!("value" in lengthDescriptor) ||
		typeof lengthDescriptor.value !== "number" ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > MAX_ARRAY_ITEMS
	) {
		fail();
	}
	const result: unknown[] = [];
	for (let index = 0; index < lengthDescriptor.value; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !("value" in descriptor)) fail();
		result.push(descriptor.value);
	}
	return result;
}

function snapshotBase(value: unknown): BaseSnapshot {
	const record = asRecord(value);
	const startValue = optionalOwn(record, "startContentBlockIndex");
	return Object.freeze({
		messageId: publicMessageId(own(record, "messageId")),
		model: boundedString(own(record, "model"), MAX_STRUCTURAL_BYTES, {
			nonEmpty: true,
			structural: true,
		}),
		inputTokens: safeInteger(own(record, "inputTokens")),
		cacheReadInputTokens: safeInteger(own(record, "cacheReadInputTokens")),
		cacheCreationInputTokens: safeInteger(
			own(record, "cacheCreationInputTokens"),
		),
		startContentBlockIndex:
			startValue === undefined ? 0 : safeInteger(startValue),
	});
}

function snapshotReplay(value: unknown): ReplaySnapshot {
	const record = asRecord(value);
	return Object.freeze({
		physicalModel: boundedString(
			own(record, "physicalModel"),
			MAX_STRUCTURAL_BYTES,
			{ nonEmpty: true, structural: true },
		),
		fidelity: boundedString(own(record, "fidelity"), MAX_STRUCTURAL_BYTES, {
			nonEmpty: true,
			structural: true,
		}),
	});
}

function snapshotTerminal(value: unknown): TerminalSnapshot {
	const record = asRecord(value);
	const clientFunctionPending = own(record, "clientFunctionPending");
	if (typeof clientFunctionPending !== "boolean") fail();
	return Object.freeze({
		inputTokens: safeInteger(own(record, "inputTokens")),
		cacheReadInputTokens: safeInteger(own(record, "cacheReadInputTokens")),
		cacheCreationInputTokens: safeInteger(
			own(record, "cacheCreationInputTokens"),
		),
		outputTokens: safeInteger(own(record, "outputTokens")),
		clientFunctionPending,
	});
}

function snapshotSource(value: unknown): SourceSnapshot {
	if (!Object.isFrozen(value)) fail();
	const record = asRecord(value);
	const pageAgeValue = own(record, "pageAge");
	const pageAge =
		pageAgeValue === null
			? null
			: boundedString(pageAgeValue, MAX_PAGE_AGE_BYTES, {
					structural: true,
				});
	return Object.freeze({
		sourceRef: boundedString(own(record, "sourceRef"), MAX_STRUCTURAL_BYTES, {
			nonEmpty: true,
			structural: true,
		}),
		url: canonicalUrl(own(record, "url")),
		title: boundedString(own(record, "title"), MAX_TITLE_BYTES),
		pageAge,
		ordinal: safeInteger(own(record, "ordinal")),
	});
}

function sameSource(left: SourceSnapshot, right: SourceSnapshot): boolean {
	return (
		left.sourceRef === right.sourceRef &&
		left.url === right.url &&
		left.title === right.title &&
		left.pageAge === right.pageAge &&
		left.ordinal === right.ordinal
	);
}

function isScalarBoundary(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) return true;
	const previous = text.charCodeAt(index - 1);
	const current = text.charCodeAt(index);
	return !(
		previous >= 0xd800 &&
		previous <= 0xdbff &&
		current >= 0xdc00 &&
		current <= 0xdfff
	);
}

function snapshotCitation(value: unknown, text: string): CitationSnapshot {
	if (!Object.isFrozen(value)) fail();
	const record = asRecord(value);
	const source = snapshotSource(own(record, "source"));
	const startCharIndex = safeInteger(own(record, "startCharIndex"));
	const endCharIndex = safeInteger(own(record, "endCharIndex"));
	const citedText = boundedString(own(record, "citedText"), MAX_QUERY_BYTES);
	if (
		endCharIndex <= startCharIndex ||
		endCharIndex > text.length ||
		!isScalarBoundary(text, startCharIndex) ||
		!isScalarBoundary(text, endCharIndex) ||
		text.slice(startCharIndex, endCharIndex) !== citedText
	) {
		fail();
	}
	const sourceRef = boundedString(
		own(record, "sourceRef"),
		MAX_STRUCTURAL_BYTES,
		{ nonEmpty: true, structural: true },
	);
	const sourceOrdinal = safeInteger(own(record, "sourceOrdinal"));
	if (source.sourceRef !== sourceRef || source.ordinal !== sourceOrdinal)
		fail();
	return Object.freeze({
		callId: publicCallId(own(record, "callId")),
		sourceRef,
		sourceOrdinal,
		citationOrdinal: safeInteger(own(record, "citationOrdinal")),
		originalIndex: safeInteger(own(record, "originalIndex")),
		startCharIndex,
		endCharIndex,
		citedText,
		source,
	});
}

function snapshotResult(event: HostedSearchResultEvent): ResultSnapshot {
	const record = asRecord(event);
	const sources = immutableArray(own(record, "sources")).map(snapshotSource);
	for (let index = 0; index < sources.length; index += 1) {
		if (sources[index]?.ordinal !== index) fail();
	}
	const state = own(record, "state");
	if (
		(state !== "result" && state !== "empty") ||
		(state === "empty") !== (sources.length === 0)
	) {
		fail();
	}
	return Object.freeze({
		type: "result",
		callId: publicCallId(own(record, "callId")),
		queryOrdinal: singleQueryOrdinal(own(record, "queryOrdinal")),
		query: boundedString(own(record, "query"), MAX_QUERY_BYTES, {
			nonEmpty: true,
		}),
		state,
		sources: Object.freeze(sources),
	});
}

function snapshotResultError(
	event: HostedSearchResultErrorEvent,
): ResultErrorSnapshot {
	const record = asRecord(event);
	const errorCode = own(record, "errorCode");
	if (
		typeof errorCode !== "string" ||
		!RESULT_ERROR_CODES.has(errorCode as HostedSearchResultErrorCode)
	) {
		fail();
	}
	return Object.freeze({
		type: "result_error",
		callId: publicCallId(own(record, "callId")),
		queryOrdinal: singleQueryOrdinal(own(record, "queryOrdinal")),
		query: boundedString(own(record, "query"), MAX_QUERY_BYTES, {
			nonEmpty: true,
		}),
		errorCode: errorCode as HostedSearchResultErrorCode,
	});
}

function snapshotAnswer(
	event: HostedSearchCitedAnswerTextEvent,
): AnswerSnapshot {
	const record = asRecord(event);
	const text = boundedString(own(record, "text"), MAX_TEXT_BYTES);
	const citations = immutableArray(own(record, "citations"))
		.map((citation) => snapshotCitation(citation, text))
		.sort(
			(left, right) =>
				left.originalIndex - right.originalIndex ||
				left.citationOrdinal - right.citationOrdinal,
		);
	return Object.freeze({
		type: "cited_answer_text",
		blockId: boundedString(own(record, "blockId"), MAX_STRUCTURAL_BYTES, {
			nonEmpty: true,
			structural: true,
		}),
		text,
		citations: Object.freeze(citations),
	});
}

function snapshotEvent(event: unknown): RelevantEventSnapshot {
	if (!Object.isFrozen(event)) fail();
	const record = asRecord(event);
	const type = own(record, "type");
	if (typeof type !== "string") fail();
	switch (type) {
		case "query_known":
			return Object.freeze({
				type,
				callId: publicCallId(own(record, "callId")),
				queryOrdinal: singleQueryOrdinal(own(record, "queryOrdinal")),
				query: boundedString(own(record, "query"), MAX_QUERY_BYTES, {
					nonEmpty: true,
				}),
			});
		case "result":
			return snapshotResult(event as HostedSearchResultEvent);
		case "result_error":
			return snapshotResultError(event as HostedSearchResultErrorEvent);
		case "cited_answer_text":
			return snapshotAnswer(event as HostedSearchCitedAnswerTextEvent);
		case "declared":
		case "dispatched":
		case "searching":
		case "answer_text_started":
		case "citation":
		case "usage_observation":
		case "usage_provider_report":
		case "terminal":
			return Object.freeze({ type: "other" });
		default:
			fail();
	}
}

function deepFreezeJson(value: unknown, depth = 0): unknown {
	if (depth > 64) fail();
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_ITEMS) fail();
		for (let index = 0; index < value.length; index += 1) {
			value[index] = deepFreezeJson(value[index], depth + 1);
		}
		return Object.freeze(value);
	}
	if (!isRecord(value)) fail();
	const keys = Object.keys(value);
	if (keys.length > MAX_ARRAY_ITEMS) fail();
	for (const key of keys) {
		value[key] = deepFreezeJson(value[key], depth + 1);
	}
	return Object.freeze(value);
}

function snapshotClientFunctionEvent(value: unknown): ClientFunctionSnapshot {
	const record = asRecord(value);
	const type = own(record, "type");
	const callId = clientFunctionCallId(own(record, "callId"));
	switch (type) {
		case "start":
			return Object.freeze({
				type,
				callId,
				name: boundedString(
					own(record, "name"),
					MAX_CLIENT_FUNCTION_NAME_BYTES,
					{ nonEmpty: true, structural: true },
				),
			});
		case "arguments_delta":
			return Object.freeze({
				type,
				callId,
				delta: boundedString(
					own(record, "delta"),
					BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES,
				),
			});
		case "complete": {
			const normalizedArgumentsJson = boundedString(
				own(record, "normalizedArgumentsJson"),
				BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES,
				{ nonEmpty: true },
			);
			let parsed: unknown;
			try {
				parsed = JSON.parse(normalizedArgumentsJson);
			} catch {
				fail();
			}
			if (!isRecord(parsed)) fail();
			return Object.freeze({
				type,
				callId,
				normalizedArgumentsJson,
				input: deepFreezeJson(parsed) as Readonly<Record<string, unknown>>,
			});
		}
		default:
			fail();
	}
}

function freezeEvidence(
	source: SourceSnapshot,
	citedText: string,
): readonly Readonly<{
	url: string;
	title: string;
	citedText: string;
	pageAge: string | null;
}>[] {
	return Object.freeze([
		Object.freeze({
			url: source.url,
			title: source.title,
			citedText,
			pageAge: source.pageAge,
		}),
	]);
}

function freezeUsage(
	terminal: TerminalSnapshot,
	webSearchRequests: number,
): AnthropicMessageUsage {
	return Object.freeze({
		input_tokens: terminal.inputTokens,
		output_tokens: terminal.outputTokens,
		cache_read_input_tokens: terminal.cacheReadInputTokens,
		cache_creation_input_tokens: terminal.cacheCreationInputTokens,
		server_tool_use: Object.freeze({
			web_search_requests: webSearchRequests,
		}),
	});
}

function mapStopReason(
	verdict: HostedSearchFinalizationVerdict,
	clientFunctionPending: boolean,
): AnthropicMessageStopReason {
	if ((verdict.terminalReason === "tool_use") !== clientFunctionPending) fail();
	switch (verdict.terminalReason) {
		case "end_turn":
		case "tool_use":
		case "max_tokens":
		case "refusal":
			return verdict.terminalReason;
		case "incomplete":
			return "max_tokens";
		case "error":
			fail();
	}
}

class AnthropicServerToolEncoderImpl<
	TSinkCompletion extends object,
	TCompletion extends AnthropicServerToolCompletion & TSinkCompletion,
> implements AnthropicServerToolEncoder<TCompletion>
{
	private readonly announcedQueries = new Map<string, string>();
	private readonly completedCalls = new Map<string, CompletedCall>();
	private readonly completedAnswerBlocks = new Set<string>();
	private readonly clientFunctionAssemblies = new Map<
		string,
		ClientFunctionAssembly
	>();
	private readonly completedClientFunctionIds = new Set<string>();
	private clientFunctionArgumentBytes = 0;
	private status: "open" | "failed" | "complete" | "aborted" = "open";
	private started = false;
	private nextContentBlockIndex: number;
	private contentBlockCount = 0;
	private operationGeneration = 0;
	private abortSnapshot: AnthropicServerToolAbortSnapshot | null = null;

	constructor(
		private readonly lifecycle: HostedSearchLifecycleReducer,
		private readonly replayIssuer: ProviderServerToolReplayIssuer,
		private readonly replay: ReplaySnapshot,
		private readonly base: BaseSnapshot,
		private readonly sink: CanonicalSink<TSinkCompletion>,
		private readonly abortController: AbortController,
	) {
		this.nextContentBlockIndex = base.startContentBlockIndex;
	}

	async accept(event: HostedSearchLifecycleEvent): Promise<void> {
		if (this.status !== "open") throw rejected();
		try {
			const snapshot = snapshotEvent(event);
			await this.ensureStarted();
			switch (snapshot.type) {
				case "query_known":
					await this.acceptQuery(snapshot.callId, snapshot.query);
					break;
				case "result":
					await this.acceptResult(snapshot);
					break;
				case "result_error":
					await this.acceptResultError(snapshot);
					break;
				case "cited_answer_text":
					await this.acceptAnswer(snapshot);
					break;
				case "other":
					break;
			}
		} catch {
			this.poisonAndFail();
		}
	}

	async acceptClientFunction(
		event: AnthropicClientFunctionIntegrationEvent,
	): Promise<void> {
		if (this.status !== "open") throw rejected();
		try {
			const snapshot = snapshotClientFunctionEvent(event);
			await this.ensureStarted();
			switch (snapshot.type) {
				case "start":
					await this.startClientFunction(snapshot.callId, snapshot.name);
					break;
				case "arguments_delta":
					this.acceptClientFunctionArguments(snapshot.callId, snapshot.delta);
					break;
				case "complete":
					await this.completeClientFunction(snapshot);
					break;
			}
		} catch {
			this.poisonAndFail();
		}
	}

	async complete(
		terminalValue: AnthropicServerToolTerminalContext,
	): Promise<TCompletion> {
		if (this.status !== "open") throw rejected();
		try {
			const terminal = snapshotTerminal(terminalValue);
			await this.ensureStarted();
			this.ensureOpen();
			this.assertLifecycleParity(terminal);
			const verdict = this.lifecycle.finalize();
			const stopReason = mapStopReason(verdict, terminal.clientFunctionPending);
			const usage = freezeUsage(terminal, verdict.observedWebSearchRequests);
			const sinkCompletion = await this.sink.complete(
				this.base,
				stopReason,
				usage,
			);
			this.ensureOpen();
			const lifecycle = this.lifecycle.completeEncoding();
			this.status = "complete";
			return Object.freeze({
				...sinkCompletion,
				stopReason,
				usage,
				contentBlockCount: this.contentBlockCount,
				lifecycle,
			}) as TCompletion;
		} catch {
			this.poisonAndFail();
		}
	}

	abort(): AnthropicServerToolAbortSnapshot {
		if (this.abortSnapshot !== null) return this.abortSnapshot;
		this.status = "aborted";
		this.abortController.abort();
		this.operationGeneration += 1;
		this.clearOwnedState();
		try {
			this.sink.abort();
		} catch {
			// Sink cleanup is best-effort and cancellation remains idempotent.
		}

		let lifecycle: HostedSearchLifecycleSnapshot;
		try {
			const current = this.lifecycle.snapshot();
			if (current.status === "aborted" || current.status === "complete") {
				lifecycle = current;
			} else {
				lifecycle = this.lifecycle.abort();
			}
		} catch {
			try {
				lifecycle = this.lifecycle.snapshot();
			} catch {
				lifecycle = ABORTED_LIFECYCLE_FALLBACK;
			}
		}
		this.abortSnapshot = Object.freeze({
			status: "aborted",
			retainedHostedQueries: 0,
			retainedHostedCalls: 0,
			retainedAnswerBlocks: 0,
			retainedClientFunctions: 0,
			retainedClientFunctionArgumentBytes: 0,
			lifecycle,
		});
		return this.abortSnapshot;
	}

	private poisonAndFail(): never {
		if (this.status !== "aborted") this.status = "failed";
		this.abortController.abort();
		this.operationGeneration += 1;
		this.clearOwnedState();
		try {
			this.sink.abort();
		} catch {
			// Cleanup is best-effort and must never replace the uniform boundary.
		}
		try {
			if (this.lifecycle.snapshot().status !== "aborted") {
				this.lifecycle.abort();
			}
		} catch {
			// Cleanup is best-effort and must never replace the uniform boundary.
		}
		throw rejected();
	}

	private clearOwnedState(): void {
		this.announcedQueries.clear();
		this.completedCalls.clear();
		this.completedAnswerBlocks.clear();
		for (const assembly of this.clientFunctionAssemblies.values()) {
			assembly.argumentDeltas.splice(0);
			assembly.argumentBytes = 0;
		}
		this.clientFunctionAssemblies.clear();
		this.completedClientFunctionIds.clear();
		this.clientFunctionArgumentBytes = 0;
		this.started = false;
		this.nextContentBlockIndex = this.base.startContentBlockIndex;
		this.contentBlockCount = 0;
	}

	private ensureOpen(generation = this.operationGeneration): void {
		if (this.status !== "open" || generation !== this.operationGeneration) {
			fail();
		}
	}

	private async ensureStarted(): Promise<void> {
		if (this.started) return;
		const generation = this.operationGeneration;
		await this.sink.start(this.base);
		this.ensureOpen(generation);
		this.started = true;
	}

	private async emit(block: AnthropicServerToolContentBlock): Promise<void> {
		const generation = this.operationGeneration;
		await this.sink.emit(block, this.nextContentBlockIndex);
		this.ensureOpen(generation);
		this.nextContentBlockIndex += 1;
		this.contentBlockCount += 1;
	}

	private async acceptQuery(callId: string, query: string): Promise<void> {
		if (this.announcedQueries.has(callId) || this.completedCalls.has(callId)) {
			fail();
		}
		this.announcedQueries.set(callId, query);
		await this.emit(
			Object.freeze({
				type: "server_tool_use",
				id: callId,
				name: WEB_SEARCH_TOOL_NAME,
				caller: DIRECT_CALLER,
				input: Object.freeze({ query }),
			}),
		);
	}

	private assertAnnounced(callId: string, query: string): void {
		if (
			this.announcedQueries.get(callId) !== query ||
			this.completedCalls.has(callId)
		) {
			fail();
		}
	}

	private async startClientFunction(
		callId: string,
		name: string,
	): Promise<void> {
		if (
			this.clientFunctionAssemblies.has(callId) ||
			this.completedClientFunctionIds.has(callId)
		) {
			fail();
		}
		const index = this.nextContentBlockIndex;
		const generation = this.operationGeneration;
		await this.sink.startClientFunction(
			Object.freeze({ type: "tool_use", id: callId, name }),
			index,
		);
		this.ensureOpen(generation);
		this.clientFunctionAssemblies.set(callId, {
			callId,
			name,
			index,
			argumentDeltas: [],
			argumentBytes: 0,
		});
		this.nextContentBlockIndex += 1;
		this.contentBlockCount += 1;
	}

	private acceptClientFunctionArguments(callId: string, delta: string): void {
		const assembly = this.clientFunctionAssemblies.get(callId);
		if (assembly === undefined) fail();
		const deltaBytes = textEncoder.encode(delta).byteLength;
		if (
			assembly.argumentBytes + deltaBytes >
				BUFFER_SIZES.TOOL_ARGUMENTS_PER_CALL_MAX_BYTES ||
			this.clientFunctionArgumentBytes + deltaBytes >
				BUFFER_SIZES.TOOL_ARGUMENTS_TOTAL_MAX_BYTES
		) {
			fail();
		}
		assembly.argumentDeltas.push(delta);
		assembly.argumentBytes += deltaBytes;
		this.clientFunctionArgumentBytes += deltaBytes;
	}

	private async completeClientFunction(
		event: Extract<ClientFunctionSnapshot, { type: "complete" }>,
	): Promise<void> {
		const assembly = this.clientFunctionAssemblies.get(event.callId);
		if (assembly === undefined) fail();
		const generation = this.operationGeneration;
		await this.sink.completeClientFunction(
			Object.freeze({
				type: "tool_use",
				id: event.callId,
				name: assembly.name,
				input: event.input,
			}),
			event.normalizedArgumentsJson,
			assembly.index,
		);
		this.ensureOpen(generation);
		this.clientFunctionArgumentBytes -= assembly.argumentBytes;
		this.clientFunctionAssemblies.delete(event.callId);
		this.completedClientFunctionIds.add(event.callId);
	}

	private assertLifecycleParity(terminal: TerminalSnapshot): void {
		const snapshot = this.lifecycle.snapshot();
		const completedStates = [...this.completedCalls.values()];
		const successfulCalls = completedStates.filter(
			({ state }) => state === "result" || state === "empty",
		).length;
		const emptyCalls = completedStates.filter(
			({ state }) => state === "empty",
		).length;
		const erroredCalls = completedStates.filter(
			({ state }) => state === "error",
		).length;
		const uniqueSources = completedStates.reduce(
			(total, { sources }) => total + sources.size,
			0,
		);
		const expectedHostedBlocks =
			this.completedCalls.size * 2 + this.completedAnswerBlocks.size;
		if (
			snapshot.status !== "terminal" ||
			this.clientFunctionAssemblies.size !== 0 ||
			this.clientFunctionArgumentBytes !== 0 ||
			terminal.clientFunctionPending !==
				this.completedClientFunctionIds.size > 0 ||
			this.announcedQueries.size !== this.completedCalls.size ||
			this.completedCalls.size !== snapshot.completedSearchCalls ||
			this.completedAnswerBlocks.size !== snapshot.retainedAnswerProvenance ||
			successfulCalls !== snapshot.successfulSearchCalls ||
			emptyCalls !== snapshot.emptySearchCalls ||
			erroredCalls !== snapshot.erroredSearchCalls ||
			uniqueSources !== snapshot.uniqueSourceCount ||
			snapshot.replayEnvelopeCount !==
				snapshot.uniqueSourceCount + snapshot.citationCount ||
			this.contentBlockCount !==
				expectedHostedBlocks + this.completedClientFunctionIds.size
		) {
			fail();
		}
	}

	private async issue(
		binding: Parameters<ProviderServerToolReplayIssuer>[0],
	): Promise<string> {
		const generation = this.operationGeneration;
		const frozenBinding = Object.freeze({ ...binding });
		const payload = Object.freeze({
			provider: REPLAY_PROVIDER,
			model: this.replay.physicalModel,
			fidelity: this.replay.fidelity,
		});
		const outcome = await settleAbortable(this.abortController.signal, () =>
			this.replayIssuer(frozenBinding, payload),
		);
		if (outcome.status !== "fulfilled") fail();
		this.ensureOpen(generation);
		const normalizedToken = boundedString(outcome.value, MAX_TOKEN_BYTES, {
			nonEmpty: true,
			structural: true,
		});
		this.lifecycle.recordReplayEnvelope(normalizedToken);
		return normalizedToken;
	}

	private async acceptResult(event: ResultSnapshot): Promise<void> {
		this.assertAnnounced(event.callId, event.query);
		const encryptedSources: AnthropicWebSearchResult[] = [];
		const sources = new Map<number, SourceSnapshot>();
		for (const source of event.sources) {
			const previousOrdinal = source.ordinal - 1;
			const encryptedContent = await this.issue(
				Object.freeze({
					envelopeKind: "source",
					toolType: WEB_SEARCH_TOOL_TYPE,
					callId: event.callId,
					visibleQuery: event.query,
					resultState: event.state,
					ordinal: source.ordinal,
					linkage: source.ordinal === 0 ? null : String(previousOrdinal),
					visibleEvidence: freezeEvidence(source, ""),
				}),
			);
			sources.set(source.ordinal, source);
			encryptedSources.push(
				Object.freeze({
					type: "web_search_result",
					url: source.url,
					title: source.title,
					page_age: source.pageAge,
					encrypted_content: encryptedContent,
				}),
			);
		}
		const content = Object.freeze(encryptedSources);
		await this.emit(
			Object.freeze({
				type: "web_search_tool_result",
				tool_use_id: event.callId,
				caller: DIRECT_CALLER,
				content,
			}),
		);
		this.completedCalls.set(
			event.callId,
			Object.freeze({
				queryOrdinal: event.queryOrdinal,
				query: event.query,
				state: event.state,
				sources,
			}),
		);
	}

	private async acceptResultError(event: ResultErrorSnapshot): Promise<void> {
		this.assertAnnounced(event.callId, event.query);
		await this.emit(
			Object.freeze({
				type: "web_search_tool_result",
				tool_use_id: event.callId,
				caller: DIRECT_CALLER,
				content: Object.freeze({
					type: "web_search_tool_result_error",
					error_code: event.errorCode,
				}),
			}),
		);
		this.completedCalls.set(
			event.callId,
			Object.freeze({
				queryOrdinal: event.queryOrdinal,
				query: event.query,
				state: "error",
				sources: new Map(),
			}),
		);
	}

	private async acceptAnswer(event: AnswerSnapshot): Promise<void> {
		if (this.completedAnswerBlocks.has(event.blockId)) fail();
		const citationKeys = new Set<string>();
		const citations: AnthropicWebSearchCitation[] = [];
		for (const citation of event.citations) {
			const call = this.completedCalls.get(citation.callId);
			const source = call?.sources.get(citation.sourceOrdinal);
			if (
				call === undefined ||
				call.state !== "result" ||
				source === undefined ||
				!sameSource(source, citation.source)
			) {
				fail();
			}
			const citationKey = `${citation.callId}\u0000${citation.sourceOrdinal}\u0000${citation.citationOrdinal}`;
			if (citationKeys.has(citationKey)) fail();
			citationKeys.add(citationKey);
			const encryptedIndex = await this.issue(
				Object.freeze({
					envelopeKind: "citation",
					toolType: WEB_SEARCH_TOOL_TYPE,
					callId: citation.callId,
					visibleQuery: call.query,
					resultState: "result",
					ordinal: citation.sourceOrdinal,
					linkage: `citation:${citation.citationOrdinal}`,
					visibleEvidence: freezeEvidence(source, citation.citedText),
				}),
			);
			citations.push(
				Object.freeze({
					type: "web_search_result_location",
					url: source.url,
					title: source.title,
					cited_text: citation.citedText,
					encrypted_index: encryptedIndex,
				}),
			);
		}
		const block: AnthropicTextBlock =
			citations.length === 0
				? Object.freeze({ type: "text", text: event.text })
				: Object.freeze({
						type: "text",
						text: event.text,
						citations: Object.freeze(citations),
					});
		await this.emit(block);
		this.completedAnswerBlocks.add(event.blockId);
	}
}

class JsonSink
	implements
		CanonicalSink<
			Readonly<{
				body: AnthropicMessageBody;
				json: string;
			}>
		>
{
	private readonly content: Array<AnthropicServerToolContentBlock | null> = [];
	private readonly clientFunctionPositions = new Map<number, number>();
	private aborted = false;

	constructor(
		private readonly observeJsonSerialization:
			| AnthropicServerToolObserveJsonSerialization
			| undefined,
		private readonly signal: AbortSignal,
	) {}

	abort(): void {
		this.aborted = true;
		this.content.splice(0);
		this.clientFunctionPositions.clear();
	}

	private ensureOpen(): void {
		if (this.aborted) fail();
	}

	async start(_base: BaseSnapshot): Promise<void> {
		this.ensureOpen();
	}

	async emit(block: AnthropicServerToolContentBlock): Promise<void> {
		this.ensureOpen();
		this.content.push(block);
	}

	async startClientFunction(
		_block: Omit<AnthropicClientToolUseBlock, "input">,
		index: number,
	): Promise<void> {
		this.ensureOpen();
		if (this.clientFunctionPositions.has(index)) fail();
		this.clientFunctionPositions.set(index, this.content.length);
		this.content.push(null);
	}

	async completeClientFunction(
		block: AnthropicClientToolUseBlock,
		_normalizedArgumentsJson: string,
		index: number,
	): Promise<void> {
		this.ensureOpen();
		const position = this.clientFunctionPositions.get(index);
		if (position === undefined || this.content[position] !== null) fail();
		this.content[position] = block;
		this.clientFunctionPositions.delete(index);
	}

	async complete(
		base: BaseSnapshot,
		stopReason: AnthropicMessageStopReason,
		usage: AnthropicMessageUsage,
	): Promise<Readonly<{ body: AnthropicMessageBody; json: string }>> {
		this.ensureOpen();
		if (
			this.clientFunctionPositions.size !== 0 ||
			this.content.some((block) => block === null)
		) {
			fail();
		}
		const body: AnthropicMessageBody = Object.freeze({
			id: base.messageId,
			type: "message",
			role: "assistant",
			model: base.model,
			content: Object.freeze([
				...(this.content as AnthropicServerToolContentBlock[]),
			]),
			stop_reason: stopReason,
			stop_sequence: null,
			usage,
		});
		let json: string;
		try {
			json = JSON.stringify(body);
		} catch {
			fail();
		}
		const byteLength = textEncoder.encode(json).byteLength;
		if (byteLength > MAX_TRANSLATED_OUTPUT_BYTES) fail();
		if (this.observeJsonSerialization !== undefined) {
			const observation = Object.freeze({ byteLength });
			const outcome = await settleAbortable(this.signal, () =>
				this.observeJsonSerialization?.(observation, this.signal),
			);
			if (outcome.status !== "fulfilled") fail();
		}
		this.ensureOpen();
		return Object.freeze({ body, json });
	}
}

class SseSink
	implements
		CanonicalSink<
			Readonly<{
				sseEventCount: number;
				sseBytes: number;
			}>
		>
{
	private eventCount = 0;
	private outputBytes = 0;
	private aborted = false;

	constructor(
		private readonly writeEvent: AnthropicServerToolWriteSseEvent,
		private readonly signal: AbortSignal,
	) {}

	abort(): void {
		this.aborted = true;
		this.eventCount = 0;
		this.outputBytes = 0;
	}

	async start(base: BaseSnapshot): Promise<void> {
		await this.write("message_start", {
			type: "message_start",
			message: {
				id: base.messageId,
				type: "message",
				role: "assistant",
				content: [],
				model: base.model,
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: base.inputTokens,
					output_tokens: 0,
					cache_read_input_tokens: base.cacheReadInputTokens,
					cache_creation_input_tokens: base.cacheCreationInputTokens,
				},
			},
		});
	}

	async emit(
		block: AnthropicServerToolContentBlock,
		index: number,
	): Promise<void> {
		switch (block.type) {
			case "server_tool_use":
				await this.write("content_block_start", {
					type: "content_block_start",
					index,
					content_block: {
						type: block.type,
						id: block.id,
						name: block.name,
						caller: block.caller,
						input: {},
					},
				});
				await this.write("content_block_delta", {
					type: "content_block_delta",
					index,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify(block.input),
					},
				});
				await this.stopBlock(index);
				break;
			case "web_search_tool_result":
				await this.write("content_block_start", {
					type: "content_block_start",
					index,
					content_block: block,
				});
				await this.stopBlock(index);
				break;
			case "text": {
				const startBlock =
					block.citations === undefined
						? { type: "text", text: "" }
						: { type: "text", text: "", citations: [] };
				await this.write("content_block_start", {
					type: "content_block_start",
					index,
					content_block: startBlock,
				});
				if (block.text.length > 0) {
					await this.write("content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "text_delta", text: block.text },
					});
				}
				for (const citation of block.citations ?? []) {
					await this.write("content_block_delta", {
						type: "content_block_delta",
						index,
						delta: { type: "citations_delta", citation },
					});
				}
				await this.stopBlock(index);
				break;
			}
		}
	}

	async startClientFunction(
		block: Omit<AnthropicClientToolUseBlock, "input">,
		index: number,
	): Promise<void> {
		await this.write("content_block_start", {
			type: "content_block_start",
			index,
			content_block: { ...block, input: {} },
		});
	}

	async completeClientFunction(
		_block: AnthropicClientToolUseBlock,
		normalizedArgumentsJson: string,
		index: number,
	): Promise<void> {
		await this.write("content_block_delta", {
			type: "content_block_delta",
			index,
			delta: {
				type: "input_json_delta",
				partial_json: normalizedArgumentsJson,
			},
		});
		await this.stopBlock(index);
	}

	async complete(
		_base: BaseSnapshot,
		stopReason: AnthropicMessageStopReason,
		usage: AnthropicMessageUsage,
	): Promise<Readonly<{ sseEventCount: number; sseBytes: number }>> {
		await this.write("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stopReason, stop_sequence: null },
			usage,
		});
		await this.write("message_stop", { type: "message_stop" });
		return Object.freeze({
			sseEventCount: this.eventCount,
			sseBytes: this.outputBytes,
		});
	}

	private async stopBlock(index: number): Promise<void> {
		await this.write("content_block_stop", {
			type: "content_block_stop",
			index,
		});
	}

	private async write(event: string, data: unknown): Promise<void> {
		if (this.aborted) fail();
		let dataJson: string;
		try {
			dataJson = JSON.stringify(data);
		} catch {
			fail();
		}
		const wire = `event: ${event}\ndata: ${dataJson}\n\n`;
		const bytes = textEncoder.encode(wire).byteLength;
		if (this.outputBytes + bytes > MAX_TRANSLATED_OUTPUT_BYTES) fail();
		const output = Object.freeze({ event, data, wire });
		const outcome = await settleAbortable(this.signal, () =>
			this.writeEvent(output, this.signal),
		);
		if (outcome.status !== "fulfilled" || this.aborted) fail();
		this.outputBytes += bytes;
		this.eventCount += 1;
	}
}

type CommonSnapshots = Readonly<{
	lifecycle: HostedSearchLifecycleReducer;
	replayIssuer: ProviderServerToolReplayIssuer;
	replay: ReplaySnapshot;
	base: BaseSnapshot;
}>;

function snapshotCommonOptions(value: unknown): CommonSnapshots {
	const record = asRecord(value);
	const lifecycle = own(record, "lifecycle");
	const replayIssuer = own(record, "replayIssuer");
	if (
		typeof lifecycle !== "object" ||
		lifecycle === null ||
		typeof (lifecycle as HostedSearchLifecycleReducer).finalize !==
			"function" ||
		typeof (lifecycle as HostedSearchLifecycleReducer).recordReplayEnvelope !==
			"function" ||
		typeof (lifecycle as HostedSearchLifecycleReducer).completeEncoding !==
			"function" ||
		typeof replayIssuer !== "function"
	) {
		fail();
	}
	return Object.freeze({
		lifecycle: lifecycle as HostedSearchLifecycleReducer,
		replayIssuer: replayIssuer as ProviderServerToolReplayIssuer,
		replay: snapshotReplay(own(record, "replay")),
		base: snapshotBase(own(record, "base")),
	});
}

function bestEffortAbortOptionLifecycle(value: unknown): void {
	try {
		if (!isRecord(value)) return;
		const descriptor = Object.getOwnPropertyDescriptor(value, "lifecycle");
		if (descriptor === undefined || !("value" in descriptor)) return;
		const lifecycle = descriptor.value as
			| HostedSearchLifecycleReducer
			| undefined;
		if (typeof lifecycle?.abort !== "function") return;
		lifecycle.abort();
	} catch {
		// Factory rejection has the same best-effort cleanup rule.
	}
}

export function createAnthropicServerToolSseEncoder(
	options: AnthropicServerToolSseEncoderOptions,
): AnthropicServerToolEncoder<AnthropicServerToolSseCompletion> {
	try {
		const common = snapshotCommonOptions(options);
		const record = asRecord(options);
		const writeEvent = own(record, "writeEvent");
		if (typeof writeEvent !== "function") fail();
		const abortController = new AbortController();
		return new AnthropicServerToolEncoderImpl(
			common.lifecycle,
			common.replayIssuer,
			common.replay,
			common.base,
			new SseSink(
				writeEvent as AnthropicServerToolWriteSseEvent,
				abortController.signal,
			),
			abortController,
		);
	} catch {
		bestEffortAbortOptionLifecycle(options);
		throw rejected();
	}
}

export function createAnthropicServerToolJsonEncoder(
	options: AnthropicServerToolJsonEncoderOptions,
): AnthropicServerToolEncoder<AnthropicServerToolJsonCompletion> {
	try {
		const common = snapshotCommonOptions(options);
		const record = asRecord(options);
		const observeJsonSerializationValue = optionalOwn(
			record,
			"observeJsonSerialization",
		);
		if (
			observeJsonSerializationValue !== undefined &&
			typeof observeJsonSerializationValue !== "function"
		) {
			fail();
		}
		const abortController = new AbortController();
		return new AnthropicServerToolEncoderImpl(
			common.lifecycle,
			common.replayIssuer,
			common.replay,
			common.base,
			new JsonSink(
				observeJsonSerializationValue as
					| AnthropicServerToolObserveJsonSerialization
					| undefined,
				abortController.signal,
			),
			abortController,
		);
	} catch {
		bestEffortAbortOptionLifecycle(options);
		throw rejected();
	}
}

// Type-level proof that the snapshots consumed by this file stay aligned with
// the reducer's public finalized event records.
const _sourceCompatibility: HostedSearchSource | undefined = undefined;
const _citationCompatibility: HostedSearchCitation | undefined = undefined;
void _sourceCompatibility;
void _citationCompatibility;
