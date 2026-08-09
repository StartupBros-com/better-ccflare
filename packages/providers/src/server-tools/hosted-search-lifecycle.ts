const RESULT_ERROR_CODES = new Set<HostedSearchResultErrorCode>([
	"too_many_requests",
	"invalid_tool_input",
	"max_uses_exceeded",
	"query_too_long",
	"request_too_large",
	"unavailable",
]);

const TERMINAL_REASONS = new Set<HostedSearchTerminalReason>([
	"end_turn",
	"tool_use",
	"max_tokens",
	"refusal",
	"incomplete",
	"error",
]);

const LIFECYCLE_ERROR_CODES = new Set<HostedSearchLifecycleErrorCode>([
	"unknown_event",
	"invalid_event",
	"duplicate_event",
	"out_of_order_event",
	"resource_limit_exceeded",
	"invalid_terminal",
]);

const MAX_CALL_ID_BYTES = 256;
const MAX_SOURCE_REF_BYTES = 256;
const MAX_BLOCK_ID_BYTES = 256;
const MAX_PAGE_AGE_BYTES = 256;
const MAX_ANSWER_TEXT_BYTES = 1024 * 1024;
const MAX_INPUT_OBSERVATIONS = 1024;
const MAX_ACTIVE_ANSWER_BLOCKS = 256;
const PUBLIC_CALL_ID = /^srvtoolu_[A-Za-z0-9][A-Za-z0-9_-]*$/u;

const BASE_CALL_BYTES = 64;
const CALL_QUERY_BYTES = 24;
const QUERY_ORDINAL_BYTES = 8;
const CALL_OUTCOME_BYTES = 24;
const SOURCE_RECORD_BYTES = 96;
const SOURCE_IDENTITY_BYTES = 32;
const SOURCE_LINK_BYTES = 16;
const SOURCE_LINK_IDENTITY_BYTES = 8;
const ANSWER_BLOCK_BYTES = 48;
const ANSWER_BLOCK_IDENTITY_BYTES = 24;
const CITATION_RECORD_BYTES = 128;
const CITATION_IDENTITY_BYTES = 64;
const USAGE_RECORD_BYTES = 32;

export const HOSTED_SEARCH_LIFECYCLE_LIMITS = Object.freeze({
	activeCalls: 8,
	sourcesPerCall: 64,
	sourcesPerResponse: 256,
	citations: 256,
	urlBytes: 8 * 1024,
	titleBytes: 2 * 1024,
	citedTextBytes: 8 * 1024,
	replayTokenBytes: 4 * 1024,
	replayEnvelopes: 512,
	queryBytes: 8 * 1024,
	liveSemanticBytes: 1024 * 1024,
});

export const HOSTED_SEARCH_SOURCE_RECONCILIATION_POLICY = Object.freeze({
	scope: "call",
	identity: "source_ref",
	duplicate: "exact_visible_evidence_only",
	conflict: "reject",
	ordinal: "first_finalized_result_order",
} as const);

export type HostedSearchResultErrorCode =
	| "too_many_requests"
	| "invalid_tool_input"
	| "max_uses_exceeded"
	| "query_too_long"
	| "request_too_large"
	| "unavailable";

export type HostedSearchTerminalReason =
	| "end_turn"
	| "tool_use"
	| "max_tokens"
	| "refusal"
	| "incomplete"
	| "error";

export type HostedSearchLifecycleErrorCode =
	| "unknown_event"
	| "invalid_event"
	| "duplicate_event"
	| "out_of_order_event"
	| "resource_limit_exceeded"
	| "invalid_terminal";

const ERROR_MESSAGES: Readonly<Record<HostedSearchLifecycleErrorCode, string>> =
	Object.freeze({
		unknown_event: "Unknown hosted search lifecycle event.",
		invalid_event: "Invalid hosted search lifecycle event.",
		duplicate_event: "Duplicate hosted search lifecycle event.",
		out_of_order_event: "Out-of-order hosted search lifecycle event.",
		resource_limit_exceeded: "Hosted search lifecycle resource limit exceeded.",
		invalid_terminal: "Invalid hosted search lifecycle terminal.",
	});

export class HostedSearchLifecycleError extends Error {
	readonly code: HostedSearchLifecycleErrorCode;

	constructor(code: HostedSearchLifecycleErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.code = code;
		Object.defineProperty(this, "name", {
			value: "HostedSearchLifecycleError",
			configurable: true,
		});
	}
}

export interface HostedSearchSourceInput {
	readonly sourceRef: string;
	readonly url: string;
	readonly title: string;
	readonly pageAge: string | null;
}

export interface HostedSearchSource extends HostedSearchSourceInput {
	readonly ordinal: number;
}

export interface HostedSearchSourceIdentity {
	readonly callId: string;
	readonly sourceRef: string;
}

export interface HostedSearchCitationInput {
	readonly blockId: string;
	readonly callId: string;
	readonly sourceRef: string;
	readonly citationOrdinal: number;
	readonly originalIndex: number;
	readonly startCharIndex: number;
	readonly endCharIndex: number;
}

export interface HostedSearchCitation {
	readonly callId: string;
	readonly sourceRef: string;
	readonly sourceOrdinal: number;
	readonly citationOrdinal: number;
	readonly originalIndex: number;
	readonly startCharIndex: number;
	readonly endCharIndex: number;
	readonly citedText: string;
	readonly source: HostedSearchSource;
}

export type HostedSearchLifecycleInput =
	| Readonly<{ type: "declared"; callId: string }>
	| Readonly<{ type: "dispatched"; callId: string }>
	| Readonly<{
			type: "query_known";
			callId: string;
			queryOrdinal: 0;
			query: string;
	  }>
	| Readonly<{ type: "searching"; callId: string }>
	| Readonly<{
			type: "result";
			callId: string;
			sources: readonly HostedSearchSourceInput[];
	  }>
	| Readonly<{
			type: "result_error";
			callId: string;
			errorCode: HostedSearchResultErrorCode;
	  }>
	| Readonly<{
			type: "answer_text_started";
			blockId: string;
			text: string;
	  }>
	| (Readonly<{ type: "citation" }> & HostedSearchCitationInput)
	| Readonly<{ type: "answer_text_completed"; blockId: string }>
	| Readonly<{
			type: "usage_observation";
			webSearchRequests: number;
	  }>
	| Readonly<{
			type: "usage_provider_report";
			webSearchRequests: number;
	  }>
	| Readonly<{ type: "terminal"; reason: HostedSearchTerminalReason }>;

export type HostedSearchResultEvent = Readonly<{
	type: "result";
	callId: string;
	queryOrdinal: 0;
	query: string;
	state: "result" | "empty";
	sources: readonly HostedSearchSource[];
}>;

export type HostedSearchResultErrorEvent = Readonly<{
	type: "result_error";
	callId: string;
	queryOrdinal: 0;
	query: string;
	errorCode: HostedSearchResultErrorCode;
}>;

export type HostedSearchCitationEvent = Readonly<
	{ type: "citation"; blockId: string } & HostedSearchCitation
>;

export type HostedSearchCitedAnswerTextEvent = Readonly<{
	type: "cited_answer_text";
	blockId: string;
	text: string;
	citations: readonly HostedSearchCitation[];
}>;

export type HostedSearchLifecycleEvent =
	| Exclude<
			HostedSearchLifecycleInput,
			{
				type: "result" | "result_error" | "citation" | "answer_text_completed";
			}
	  >
	| HostedSearchResultEvent
	| HostedSearchResultErrorEvent
	| HostedSearchCitationEvent
	| HostedSearchCitedAnswerTextEvent;

export type HostedSearchUsageReconciliation = "unknown" | "match" | "mismatch";

export interface HostedSearchLifecycleSnapshot {
	readonly status: "open" | "terminal" | "finalized" | "complete" | "aborted";
	readonly terminalReason: HostedSearchTerminalReason | null;
	readonly activeCallAssemblies: number;
	readonly compactCallProvenance: number;
	readonly activeCitationAssemblies: number;
	readonly retainedAnswerProvenance: number;
	readonly retainedSourceProvenance: number;
	readonly releasedCallAssemblies: number;
	readonly releasedCitationAssemblies: number;
	readonly uniqueSourceCount: number;
	readonly citationCount: number;
	readonly completedSearchCalls: number;
	readonly successfulSearchCalls: number;
	readonly emptySearchCalls: number;
	readonly erroredSearchCalls: number;
	readonly observedWebSearchRequests: number | null;
	readonly providerReportedWebSearchRequests: number | null;
	readonly usageReconciliation: HostedSearchUsageReconciliation;
	readonly replayEnvelopeCount: number;
	readonly replayEnvelopeBytes: number;
	readonly retainedSemanticIdentityBytes: number;
	readonly liveSemanticBytes: number;
}

export interface HostedSearchFinalizationVerdict {
	readonly status: "ready_for_encoding";
	readonly terminalReason: HostedSearchTerminalReason;
	readonly completedSearchCalls: number;
	readonly observedWebSearchRequests: number;
	readonly providerReportedWebSearchRequests: number | null;
	readonly usageReconciliation: HostedSearchUsageReconciliation;
	readonly uniqueSourceCount: number;
	readonly citationCount: number;
	readonly replayEnvelopeCount: number;
}

export interface HostedSearchReplayEnvelopeObservation {
	readonly ordinal: number;
	readonly byteLength: number;
}

type HostedSearchLifecycleOutputFor<T extends HostedSearchLifecycleInput> =
	T extends { type: "result" }
		? HostedSearchResultEvent
		: T extends { type: "result_error" }
			? HostedSearchResultErrorEvent
			: T extends { type: "citation" }
				? HostedSearchCitationEvent
				: T extends { type: "answer_text_completed" }
					? HostedSearchCitedAnswerTextEvent
					: Readonly<T>;

type JsonRecord = Record<string, unknown>;

type NormalizedInput =
	| Readonly<{ type: "declared"; callId: string }>
	| Readonly<{ type: "dispatched"; callId: string }>
	| Readonly<{
			type: "query_known";
			callId: string;
			queryOrdinal: 0;
			query: string;
	  }>
	| Readonly<{ type: "searching"; callId: string }>
	| Readonly<{
			type: "result";
			callId: string;
			sources: readonly HostedSearchSourceInput[];
	  }>
	| Readonly<{
			type: "result_error";
			callId: string;
			errorCode: HostedSearchResultErrorCode;
	  }>
	| Readonly<{
			type: "answer_text_started";
			blockId: string;
			text: string;
	  }>
	| (Readonly<{ type: "citation" }> & HostedSearchCitationInput)
	| Readonly<{ type: "answer_text_completed"; blockId: string }>
	| Readonly<{
			type: "usage_observation";
			webSearchRequests: number;
	  }>
	| Readonly<{
			type: "usage_provider_report";
			webSearchRequests: number;
	  }>
	| Readonly<{ type: "terminal"; reason: HostedSearchTerminalReason }>;

type ActiveCall = {
	readonly callId: string;
	dispatched: boolean;
	searching: boolean;
	queryOrdinal: 0 | null;
	query: string | null;
};

type GlobalSource = {
	readonly id: number;
	readonly callId: string;
	readonly source: HostedSearchSource;
	readonly semanticBytes: number;
	readonly identityBytes: number;
};

type CompletedCall = {
	readonly callId: string;
	readonly queryOrdinal: 0;
	readonly query: string;
	readonly outcome: "result" | "empty" | "error";
	readonly errorCode: HostedSearchResultErrorCode | null;
	readonly sourcesByRef: Map<string, GlobalSource>;
};

type AnswerAssembly = {
	readonly blockId: string;
	readonly text: string;
	readonly citations: HostedSearchCitation[];
};

const textEncoder = new TextEncoder();
const FORBIDDEN_STRUCTURAL_SCALAR = /[\p{Cc}\p{Cf}]/u;
const URL_WHITESPACE = /\s/u;
const FORBIDDEN_NATIVE_OPAQUE_FIELDS = [
	"replayToken",
	"encryptedContent",
	"encrypted_content",
	"encryptedIndex",
	"encrypted_index",
] as const;

function fail(code: HostedSearchLifecycleErrorCode): never {
	throw new HostedSearchLifecycleError(code);
}

function sanitizeCaught(
	error: unknown,
	fallback: HostedSearchLifecycleErrorCode,
): never {
	let code = fallback;
	if (
		(typeof error === "object" && error !== null) ||
		typeof error === "function"
	) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(error, "code");
			if (
				descriptor !== undefined &&
				"value" in descriptor &&
				typeof descriptor.value === "string" &&
				LIFECYCLE_ERROR_CODES.has(
					descriptor.value as HostedSearchLifecycleErrorCode,
				)
			) {
				code = descriptor.value as HostedSearchLifecycleErrorCode;
			}
		} catch {}
	}
	throw new HostedSearchLifecycleError(code);
}

function utf8Bytes(value: string): number {
	return textEncoder.encode(value).byteLength;
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
	options: Readonly<{ nonEmpty?: boolean; structural?: boolean }> = {},
): string {
	if (
		typeof value !== "string" ||
		hasLoneSurrogate(value) ||
		(options.nonEmpty === true && value.length === 0) ||
		(options.structural === true && FORBIDDEN_STRUCTURAL_SCALAR.test(value))
	) {
		fail("invalid_event");
	}
	if (utf8Bytes(value) > maxBytes) fail("resource_limit_exceeded");
	return value;
}

function canonicalUrl(value: unknown): string {
	const input = boundedString(value, HOSTED_SEARCH_LIFECYCLE_LIMITS.urlBytes, {
		nonEmpty: true,
		structural: true,
	});
	if (URL_WHITESPACE.test(input) || input.includes("\\")) {
		fail("invalid_event");
	}

	let parsed: URL;
	let decoded: string;
	try {
		parsed = new URL(input);
		decoded = decodeURI(input);
	} catch {
		fail("invalid_event");
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
		fail("invalid_event");
	}
	const authority = input.slice(input.indexOf("://") + 3).split(/[/?#]/u, 1)[0];
	if (authority?.includes("@")) fail("invalid_event");
	return input;
}

function ownValue(record: JsonRecord, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined || !("value" in descriptor)) {
		fail("invalid_event");
	}
	return descriptor.value;
}

function rejectForbiddenOwnFields(record: JsonRecord): void {
	for (const key of FORBIDDEN_NATIVE_OPAQUE_FIELDS) {
		if (Object.getOwnPropertyDescriptor(record, key) !== undefined) {
			fail("invalid_event");
		}
	}
}

function asRecord(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail("invalid_event");
	}
	return value as JsonRecord;
}

function asArray(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) fail("invalid_event");
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		lengthDescriptor === undefined ||
		!("value" in lengthDescriptor) ||
		typeof lengthDescriptor.value !== "number" ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0
	) {
		fail("invalid_event");
	}
	if (lengthDescriptor.value > MAX_INPUT_OBSERVATIONS) {
		fail("resource_limit_exceeded");
	}
	const snapshot: unknown[] = [];
	for (let index = 0; index < lengthDescriptor.value; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (descriptor === undefined || !("value" in descriptor)) {
			fail("invalid_event");
		}
		snapshot.push(descriptor.value);
	}
	return snapshot;
}

function safeIndex(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail("invalid_event");
	}
	return value;
}

function singleQueryOrdinal(value: unknown): 0 {
	if (safeIndex(value) !== 0) fail("invalid_event");
	return 0;
}

function normalizeCallId(value: unknown): string {
	const normalized = boundedString(value, MAX_CALL_ID_BYTES, {
		nonEmpty: true,
		structural: true,
	});
	if (!PUBLIC_CALL_ID.test(normalized)) fail("invalid_event");
	return normalized;
}

function normalizeSourceRef(value: unknown): string {
	return boundedString(value, MAX_SOURCE_REF_BYTES, {
		nonEmpty: true,
		structural: true,
	});
}

function normalizeBlockId(value: unknown): string {
	return boundedString(value, MAX_BLOCK_ID_BYTES, {
		nonEmpty: true,
		structural: true,
	});
}

function normalizeSource(value: unknown): HostedSearchSourceInput {
	const record = asRecord(value);
	rejectForbiddenOwnFields(record);
	const pageAgeValue = ownValue(record, "pageAge");
	return Object.freeze({
		sourceRef: normalizeSourceRef(ownValue(record, "sourceRef")),
		url: canonicalUrl(ownValue(record, "url")),
		title: boundedString(
			ownValue(record, "title"),
			HOSTED_SEARCH_LIFECYCLE_LIMITS.titleBytes,
		),
		pageAge:
			pageAgeValue === null
				? null
				: boundedString(pageAgeValue, MAX_PAGE_AGE_BYTES),
	});
}

function normalizeInput(input: unknown): NormalizedInput {
	let record: JsonRecord;
	let typeValue: unknown;
	try {
		record = asRecord(input);
		typeValue = ownValue(record, "type");
	} catch (error) {
		sanitizeCaught(error, "invalid_event");
	}
	if (typeof typeValue !== "string") fail("unknown_event");

	try {
		switch (typeValue) {
			case "declared":
			case "dispatched":
			case "searching":
				return Object.freeze({
					type: typeValue,
					callId: normalizeCallId(ownValue(record, "callId")),
				});
			case "query_known":
				return Object.freeze({
					type: typeValue,
					callId: normalizeCallId(ownValue(record, "callId")),
					queryOrdinal: singleQueryOrdinal(ownValue(record, "queryOrdinal")),
					query: boundedString(
						ownValue(record, "query"),
						HOSTED_SEARCH_LIFECYCLE_LIMITS.queryBytes,
					),
				});
			case "result":
				return Object.freeze({
					type: typeValue,
					callId: normalizeCallId(ownValue(record, "callId")),
					sources: Object.freeze(
						asArray(ownValue(record, "sources")).map(normalizeSource),
					),
				});
			case "result_error": {
				const errorCode = ownValue(record, "errorCode");
				if (
					typeof errorCode !== "string" ||
					!RESULT_ERROR_CODES.has(errorCode as HostedSearchResultErrorCode)
				) {
					fail("invalid_event");
				}
				return Object.freeze({
					type: typeValue,
					callId: normalizeCallId(ownValue(record, "callId")),
					errorCode: errorCode as HostedSearchResultErrorCode,
				});
			}
			case "answer_text_started":
				return Object.freeze({
					type: typeValue,
					blockId: normalizeBlockId(ownValue(record, "blockId")),
					text: boundedString(ownValue(record, "text"), MAX_ANSWER_TEXT_BYTES),
				});
			case "citation":
				rejectForbiddenOwnFields(record);
				return Object.freeze({
					type: typeValue,
					blockId: normalizeBlockId(ownValue(record, "blockId")),
					callId: normalizeCallId(ownValue(record, "callId")),
					sourceRef: normalizeSourceRef(ownValue(record, "sourceRef")),
					citationOrdinal: safeIndex(ownValue(record, "citationOrdinal")),
					originalIndex: safeIndex(ownValue(record, "originalIndex")),
					startCharIndex: safeIndex(ownValue(record, "startCharIndex")),
					endCharIndex: safeIndex(ownValue(record, "endCharIndex")),
				});
			case "answer_text_completed":
				return Object.freeze({
					type: typeValue,
					blockId: normalizeBlockId(ownValue(record, "blockId")),
				});
			case "usage_observation":
			case "usage_provider_report":
				return Object.freeze({
					type: typeValue,
					webSearchRequests: safeIndex(ownValue(record, "webSearchRequests")),
				});
			case "terminal": {
				const reason = ownValue(record, "reason");
				if (
					typeof reason !== "string" ||
					!TERMINAL_REASONS.has(reason as HostedSearchTerminalReason)
				) {
					fail("invalid_terminal");
				}
				return Object.freeze({
					type: typeValue,
					reason: reason as HostedSearchTerminalReason,
				});
			}
			default:
				fail("unknown_event");
		}
	} catch (error) {
		sanitizeCaught(error, "invalid_event");
	}
}

function sameVisibleSource(
	left: HostedSearchSourceInput,
	right: HostedSearchSourceInput,
): boolean {
	return (
		left.sourceRef === right.sourceRef &&
		left.url === right.url &&
		left.title === right.title &&
		left.pageAge === right.pageAge
	);
}

function sourceSemanticBytes(source: HostedSearchSourceInput): number {
	return (
		SOURCE_RECORD_BYTES +
		utf8Bytes(source.sourceRef) +
		utf8Bytes(source.url) +
		utf8Bytes(source.title) +
		(source.pageAge === null ? 0 : utf8Bytes(source.pageAge))
	);
}

function sourceIdentityBytes(source: HostedSearchSourceInput): number {
	return (
		SOURCE_IDENTITY_BYTES +
		utf8Bytes(source.sourceRef) +
		utf8Bytes(source.url) +
		utf8Bytes(source.title) +
		(source.pageAge === null ? 0 : utf8Bytes(source.pageAge))
	);
}

function callSemanticBytes(value: string): number {
	return BASE_CALL_BYTES + utf8Bytes(value);
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

function sameCitation(
	left: HostedSearchCitation,
	right: HostedSearchCitation,
): boolean {
	return (
		left.callId === right.callId &&
		left.sourceRef === right.sourceRef &&
		left.sourceOrdinal === right.sourceOrdinal &&
		left.citationOrdinal === right.citationOrdinal &&
		left.originalIndex === right.originalIndex &&
		left.startCharIndex === right.startCharIndex &&
		left.endCharIndex === right.endCharIndex
	);
}

function citationSemanticBytes(
	blockId: string,
	citation: HostedSearchCitation,
): number {
	return (
		CITATION_RECORD_BYTES +
		utf8Bytes(blockId) +
		utf8Bytes(citation.callId) +
		utf8Bytes(citation.sourceRef) +
		utf8Bytes(citation.citedText)
	);
}

function citationIdentityBytes(
	blockId: string,
	citation: HostedSearchCitation,
): number {
	return (
		CITATION_IDENTITY_BYTES +
		utf8Bytes(blockId) +
		utf8Bytes(citation.callId) +
		utf8Bytes(citation.sourceRef)
	);
}

function freezeEvent<T extends HostedSearchLifecycleEvent>(event: T): T {
	return Object.freeze(event);
}

export function canonicalHostedSearchSourceIdentity(
	value: HostedSearchSourceIdentity,
): HostedSearchSourceIdentity {
	try {
		const record = asRecord(value);
		return Object.freeze({
			callId: normalizeCallId(ownValue(record, "callId")),
			sourceRef: normalizeSourceRef(ownValue(record, "sourceRef")),
		});
	} catch (error) {
		sanitizeCaught(error, "invalid_event");
	}
}

export class HostedSearchLifecycleReducer {
	private status: "open" | "terminal" | "finalized" | "complete" | "aborted" =
		"open";
	private terminalReason: HostedSearchTerminalReason | null = null;
	private readonly activeCalls = new Map<string, ActiveCall>();
	private readonly completedCalls = new Map<string, CompletedCall>();
	private readonly globalSources: GlobalSource[] = [];
	private readonly answerAssemblies = new Map<string, AnswerAssembly>();
	private readonly completedAnswers: HostedSearchCitedAnswerTextEvent[] = [];
	private releasedCallAssemblies = 0;
	private releasedCitationAssemblies = 0;
	private uniqueSourceCount = 0;
	private citationCount = 0;
	private completedSearchCalls = 0;
	private successfulSearchCalls = 0;
	private emptySearchCalls = 0;
	private erroredSearchCalls = 0;
	private observedWebSearchRequests: number | null = null;
	private providerReportedWebSearchRequests: number | null = null;
	private replayEnvelopeCount = 0;
	private replayEnvelopeBytes = 0;
	private retainedSemanticIdentityBytes = 0;
	private liveSemanticBytes = 0;

	accept<const T extends HostedSearchLifecycleInput>(
		input: T,
	): HostedSearchLifecycleOutputFor<T>;
	accept(input: unknown): HostedSearchLifecycleEvent;
	accept(input: unknown): HostedSearchLifecycleEvent {
		const event = normalizeInput(input);
		if (event.type !== "terminal" && this.status !== "open") {
			fail("out_of_order_event");
		}
		switch (event.type) {
			case "declared":
				return this.acceptDeclared(event);
			case "dispatched":
				return this.acceptDispatched(event);
			case "query_known":
				return this.acceptQueryKnown(event);
			case "searching":
				return this.acceptSearching(event);
			case "result":
				return this.acceptResult(event);
			case "result_error":
				return this.acceptResultError(event);
			case "answer_text_started":
				return this.acceptAnswerTextStarted(event);
			case "citation":
				return this.acceptCitation(event);
			case "answer_text_completed":
				return this.acceptAnswerTextCompleted(event);
			case "usage_observation":
				return this.acceptUsageObservation(event);
			case "usage_provider_report":
				return this.acceptUsageProviderReport(event);
			case "terminal":
				return this.acceptTerminal(event);
		}
	}

	recordReplayEnvelope(token: string): HostedSearchReplayEnvelopeObservation {
		if (
			this.status === "finalized" ||
			this.status === "complete" ||
			this.status === "aborted"
		) {
			fail("out_of_order_event");
		}
		const normalized = boundedString(
			token,
			HOSTED_SEARCH_LIFECYCLE_LIMITS.replayTokenBytes,
			{ nonEmpty: true },
		);
		if (
			this.replayEnvelopeCount >= HOSTED_SEARCH_LIFECYCLE_LIMITS.replayEnvelopes
		) {
			fail("resource_limit_exceeded");
		}
		const byteLength = utf8Bytes(normalized);
		const observation = Object.freeze({
			ordinal: this.replayEnvelopeCount,
			byteLength,
		});
		this.replayEnvelopeCount += 1;
		this.replayEnvelopeBytes += byteLength;
		return observation;
	}

	abort(): HostedSearchLifecycleSnapshot {
		if (this.status === "aborted" || this.status === "complete") {
			fail("duplicate_event");
		}
		this.completedCalls.clear();
		this.globalSources.splice(0);
		this.completedAnswers.splice(0);
		this.answerAssemblies.clear();
		this.activeCalls.clear();
		this.retainedSemanticIdentityBytes = 0;
		this.liveSemanticBytes = 0;
		this.terminalReason = null;
		this.status = "aborted";
		return this.snapshot();
	}

	finalize(): HostedSearchFinalizationVerdict {
		if (this.status === "open") fail("invalid_terminal");
		if (this.status === "finalized" || this.status === "complete") {
			fail("duplicate_event");
		}
		if (
			this.activeCalls.size !== 0 ||
			this.answerAssemblies.size !== 0 ||
			this.observedWebSearchRequests === null ||
			this.observedWebSearchRequests !== this.successfulSearchCalls ||
			(this.providerReportedWebSearchRequests !== null &&
				this.providerReportedWebSearchRequests !== this.successfulSearchCalls)
		) {
			fail("invalid_terminal");
		}
		const terminalReason = this.terminalReason;
		if (terminalReason === null) fail("invalid_terminal");
		this.status = "finalized";
		return Object.freeze({
			status: "ready_for_encoding",
			terminalReason,
			completedSearchCalls: this.completedSearchCalls,
			observedWebSearchRequests: this.observedWebSearchRequests,
			providerReportedWebSearchRequests: this.providerReportedWebSearchRequests,
			usageReconciliation: this.usageReconciliation(),
			uniqueSourceCount: this.uniqueSourceCount,
			citationCount: this.citationCount,
			replayEnvelopeCount: this.replayEnvelopeCount,
		});
	}

	completeEncoding(): HostedSearchLifecycleSnapshot {
		if (this.status === "complete") fail("duplicate_event");
		if (this.status !== "finalized") fail("out_of_order_event");
		this.completedCalls.clear();
		this.globalSources.splice(0);
		this.completedAnswers.splice(0);
		this.answerAssemblies.clear();
		this.activeCalls.clear();
		this.retainedSemanticIdentityBytes = 0;
		this.liveSemanticBytes = 0;
		this.status = "complete";
		return this.snapshot();
	}

	snapshot(): HostedSearchLifecycleSnapshot {
		return Object.freeze({
			status: this.status,
			terminalReason: this.terminalReason,
			activeCallAssemblies: this.activeCalls.size,
			compactCallProvenance: this.completedCalls.size,
			activeCitationAssemblies: this.answerAssemblies.size,
			retainedAnswerProvenance: this.completedAnswers.length,
			retainedSourceProvenance: this.globalSources.length,
			releasedCallAssemblies: this.releasedCallAssemblies,
			releasedCitationAssemblies: this.releasedCitationAssemblies,
			uniqueSourceCount: this.uniqueSourceCount,
			citationCount: this.citationCount,
			completedSearchCalls: this.completedSearchCalls,
			successfulSearchCalls: this.successfulSearchCalls,
			emptySearchCalls: this.emptySearchCalls,
			erroredSearchCalls: this.erroredSearchCalls,
			observedWebSearchRequests: this.observedWebSearchRequests,
			providerReportedWebSearchRequests: this.providerReportedWebSearchRequests,
			usageReconciliation: this.usageReconciliation(),
			replayEnvelopeCount: this.replayEnvelopeCount,
			replayEnvelopeBytes: this.replayEnvelopeBytes,
			retainedSemanticIdentityBytes: this.retainedSemanticIdentityBytes,
			liveSemanticBytes: this.liveSemanticBytes,
		});
	}

	private ensureSemanticBytes(additionalBytes: number): void {
		if (
			additionalBytes < 0 ||
			this.liveSemanticBytes + additionalBytes >
				HOSTED_SEARCH_LIFECYCLE_LIMITS.liveSemanticBytes
		) {
			fail("resource_limit_exceeded");
		}
	}

	private addRetainedBytes(semanticBytes: number, identityBytes: number): void {
		this.liveSemanticBytes += semanticBytes;
		this.retainedSemanticIdentityBytes += identityBytes;
		if (this.retainedSemanticIdentityBytes > this.liveSemanticBytes) {
			fail("resource_limit_exceeded");
		}
	}

	private findActive(callId: string): ActiveCall {
		const active = this.activeCalls.get(callId);
		if (active !== undefined) return active;
		if (this.completedCalls.has(callId)) fail("duplicate_event");
		fail("out_of_order_event");
	}

	private acceptDeclared(
		event: Extract<NormalizedInput, { type: "declared" }>,
	): HostedSearchLifecycleEvent {
		if (
			this.activeCalls.has(event.callId) ||
			this.completedCalls.has(event.callId)
		) {
			fail("duplicate_event");
		}
		if (this.activeCalls.size >= HOSTED_SEARCH_LIFECYCLE_LIMITS.activeCalls) {
			fail("resource_limit_exceeded");
		}
		const semanticBytes = callSemanticBytes(event.callId);
		this.ensureSemanticBytes(semanticBytes);
		this.activeCalls.set(event.callId, {
			callId: event.callId,
			dispatched: false,
			searching: false,
			queryOrdinal: null,
			query: null,
		});
		this.addRetainedBytes(semanticBytes, utf8Bytes(event.callId));
		return freezeEvent({ type: event.type, callId: event.callId });
	}

	private acceptDispatched(
		event: Extract<NormalizedInput, { type: "dispatched" }>,
	): HostedSearchLifecycleEvent {
		const active = this.findActive(event.callId);
		if (active.dispatched) fail("duplicate_event");
		active.dispatched = true;
		return freezeEvent({ type: event.type, callId: event.callId });
	}

	private acceptQueryKnown(
		event: Extract<NormalizedInput, { type: "query_known" }>,
	): HostedSearchLifecycleEvent {
		const active = this.findActive(event.callId);
		if (active.queryOrdinal !== null || active.query !== null) {
			fail("duplicate_event");
		}
		const queryBytes = utf8Bytes(event.query);
		const semanticBytes = CALL_QUERY_BYTES + QUERY_ORDINAL_BYTES + queryBytes;
		this.ensureSemanticBytes(semanticBytes);
		active.queryOrdinal = event.queryOrdinal;
		active.query = event.query;
		this.addRetainedBytes(semanticBytes, QUERY_ORDINAL_BYTES + queryBytes);
		return freezeEvent({
			type: event.type,
			callId: event.callId,
			queryOrdinal: event.queryOrdinal,
			query: event.query,
		});
	}

	private acceptSearching(
		event: Extract<NormalizedInput, { type: "searching" }>,
	): HostedSearchLifecycleEvent {
		const active = this.findActive(event.callId);
		if (!active.dispatched) fail("out_of_order_event");
		if (active.searching) fail("duplicate_event");
		active.searching = true;
		return freezeEvent({ type: event.type, callId: event.callId });
	}

	private acceptResult(
		event: Extract<NormalizedInput, { type: "result" }>,
	): HostedSearchResultEvent {
		const active = this.findActive(event.callId);
		if (
			!active.dispatched ||
			!active.searching ||
			active.queryOrdinal === null ||
			active.query === null
		) {
			fail("out_of_order_event");
		}

		const reconciled: HostedSearchSourceInput[] = [];
		for (const candidate of event.sources) {
			const existing = reconciled.find(
				(source) => source.sourceRef === candidate.sourceRef,
			);
			if (existing !== undefined) {
				if (!sameVisibleSource(existing, candidate)) fail("invalid_event");
				continue;
			}
			reconciled.push(candidate);
		}
		if (reconciled.length > HOSTED_SEARCH_LIFECYCLE_LIMITS.sourcesPerCall) {
			fail("resource_limit_exceeded");
		}
		if (
			this.globalSources.length + reconciled.length >
			HOSTED_SEARCH_LIFECYCLE_LIMITS.sourcesPerResponse
		) {
			fail("resource_limit_exceeded");
		}

		let semanticBytes = CALL_OUTCOME_BYTES;
		let identityBytes = 0;
		for (const source of reconciled) {
			semanticBytes += sourceSemanticBytes(source) + SOURCE_LINK_BYTES;
			identityBytes += sourceIdentityBytes(source) + SOURCE_LINK_IDENTITY_BYTES;
		}
		this.ensureSemanticBytes(semanticBytes);

		const sourcesByRef = new Map<string, GlobalSource>();
		const outputSources: HostedSearchSource[] = [];
		for (let ordinal = 0; ordinal < reconciled.length; ordinal += 1) {
			const source = Object.freeze({ ...reconciled[ordinal], ordinal });
			const global: GlobalSource = {
				id: this.globalSources.length,
				callId: event.callId,
				source,
				semanticBytes: sourceSemanticBytes(source),
				identityBytes: sourceIdentityBytes(source),
			};
			this.globalSources.push(global);
			sourcesByRef.set(source.sourceRef, global);
			outputSources.push(source);
			this.uniqueSourceCount += 1;
		}
		const state = outputSources.length === 0 ? "empty" : "result";
		this.activeCalls.delete(event.callId);
		this.completedCalls.set(event.callId, {
			callId: event.callId,
			queryOrdinal: active.queryOrdinal,
			query: active.query,
			outcome: state,
			errorCode: null,
			sourcesByRef,
		});
		this.addRetainedBytes(semanticBytes, identityBytes);
		this.releasedCallAssemblies += 1;
		this.completedSearchCalls += 1;
		this.successfulSearchCalls += 1;
		if (state === "empty") this.emptySearchCalls += 1;

		return freezeEvent({
			type: "result",
			callId: event.callId,
			queryOrdinal: active.queryOrdinal,
			query: active.query,
			state,
			sources: Object.freeze(outputSources),
		});
	}

	private acceptResultError(
		event: Extract<NormalizedInput, { type: "result_error" }>,
	): HostedSearchResultErrorEvent {
		const active = this.findActive(event.callId);
		if (
			!active.dispatched ||
			!active.searching ||
			active.queryOrdinal === null ||
			active.query === null
		) {
			fail("out_of_order_event");
		}
		this.ensureSemanticBytes(CALL_OUTCOME_BYTES);
		this.activeCalls.delete(event.callId);
		this.completedCalls.set(event.callId, {
			callId: event.callId,
			queryOrdinal: active.queryOrdinal,
			query: active.query,
			outcome: "error",
			errorCode: event.errorCode,
			sourcesByRef: new Map(),
		});
		this.addRetainedBytes(CALL_OUTCOME_BYTES, utf8Bytes(event.errorCode));
		this.releasedCallAssemblies += 1;
		this.completedSearchCalls += 1;
		this.erroredSearchCalls += 1;
		return freezeEvent({
			type: event.type,
			callId: event.callId,
			queryOrdinal: active.queryOrdinal,
			query: active.query,
			errorCode: event.errorCode,
		});
	}

	private acceptAnswerTextStarted(
		event: Extract<NormalizedInput, { type: "answer_text_started" }>,
	): HostedSearchLifecycleEvent {
		if (
			this.answerAssemblies.has(event.blockId) ||
			this.completedAnswers.some(({ blockId }) => blockId === event.blockId)
		) {
			fail("duplicate_event");
		}
		if (this.answerAssemblies.size >= MAX_ACTIVE_ANSWER_BLOCKS) {
			fail("resource_limit_exceeded");
		}
		const semanticBytes =
			ANSWER_BLOCK_BYTES + utf8Bytes(event.blockId) + utf8Bytes(event.text);
		const identityBytes =
			ANSWER_BLOCK_IDENTITY_BYTES + utf8Bytes(event.blockId);
		this.ensureSemanticBytes(semanticBytes);
		this.answerAssemblies.set(event.blockId, {
			blockId: event.blockId,
			text: event.text,
			citations: [],
		});
		this.addRetainedBytes(semanticBytes, identityBytes);
		return freezeEvent({
			type: event.type,
			blockId: event.blockId,
			text: event.text,
		});
	}

	private acceptCitation(
		event: Extract<NormalizedInput, { type: "citation" }>,
	): HostedSearchCitationEvent {
		const assembly = this.answerAssemblies.get(event.blockId);
		if (assembly === undefined) fail("out_of_order_event");
		const call = this.completedCalls.get(event.callId);
		if (call === undefined || call.outcome !== "result") {
			fail("invalid_event");
		}
		const source = call.sourcesByRef.get(event.sourceRef);
		if (source === undefined) fail("invalid_event");
		if (
			event.endCharIndex <= event.startCharIndex ||
			event.endCharIndex > assembly.text.length ||
			!isScalarBoundary(assembly.text, event.startCharIndex) ||
			!isScalarBoundary(assembly.text, event.endCharIndex)
		) {
			fail("invalid_event");
		}
		const citedText = assembly.text.slice(
			event.startCharIndex,
			event.endCharIndex,
		);
		if (utf8Bytes(citedText) > HOSTED_SEARCH_LIFECYCLE_LIMITS.citedTextBytes) {
			fail("resource_limit_exceeded");
		}
		const citation: HostedSearchCitation = Object.freeze({
			callId: event.callId,
			sourceRef: event.sourceRef,
			sourceOrdinal: source.source.ordinal,
			citationOrdinal: event.citationOrdinal,
			originalIndex: event.originalIndex,
			startCharIndex: event.startCharIndex,
			endCharIndex: event.endCharIndex,
			citedText,
			source: source.source,
		});
		const reusedOrdinal = assembly.citations.find(
			(existing) =>
				existing.callId === citation.callId &&
				existing.sourceRef === citation.sourceRef &&
				existing.citationOrdinal === citation.citationOrdinal,
		);
		if (reusedOrdinal !== undefined) {
			if (sameCitation(reusedOrdinal, citation)) fail("duplicate_event");
			fail("invalid_event");
		}
		if (
			assembly.citations.some(
				(existing) => existing.originalIndex === citation.originalIndex,
			)
		) {
			fail("invalid_event");
		}
		if (this.citationCount >= HOSTED_SEARCH_LIFECYCLE_LIMITS.citations) {
			fail("resource_limit_exceeded");
		}
		const semanticBytes = citationSemanticBytes(event.blockId, citation);
		const identityBytes = citationIdentityBytes(event.blockId, citation);
		this.ensureSemanticBytes(semanticBytes);
		assembly.citations.push(citation);
		this.addRetainedBytes(semanticBytes, identityBytes);
		this.citationCount += 1;
		return freezeEvent({
			type: "citation",
			blockId: event.blockId,
			...citation,
		});
	}

	private acceptAnswerTextCompleted(
		event: Extract<NormalizedInput, { type: "answer_text_completed" }>,
	): HostedSearchCitedAnswerTextEvent {
		const assembly = this.answerAssemblies.get(event.blockId);
		if (assembly === undefined) {
			if (
				this.completedAnswers.some(({ blockId }) => blockId === event.blockId)
			) {
				fail("duplicate_event");
			}
			fail("out_of_order_event");
		}
		const completed = freezeEvent({
			type: "cited_answer_text",
			blockId: assembly.blockId,
			text: assembly.text,
			citations: Object.freeze([...assembly.citations]),
		});
		this.answerAssemblies.delete(event.blockId);
		this.completedAnswers.push(completed);
		this.releasedCitationAssemblies += 1;
		return completed;
	}

	private acceptUsageObservation(
		event: Extract<NormalizedInput, { type: "usage_observation" }>,
	): HostedSearchLifecycleEvent {
		if (event.webSearchRequests > this.completedSearchCalls) {
			fail("out_of_order_event");
		}
		if (this.observedWebSearchRequests !== null) {
			if (event.webSearchRequests === this.observedWebSearchRequests) {
				fail("duplicate_event");
			}
			if (event.webSearchRequests < this.observedWebSearchRequests) {
				fail("out_of_order_event");
			}
		} else {
			this.ensureSemanticBytes(USAGE_RECORD_BYTES);
			this.addRetainedBytes(USAGE_RECORD_BYTES, 0);
		}
		this.observedWebSearchRequests = event.webSearchRequests;
		return freezeEvent({
			type: event.type,
			webSearchRequests: event.webSearchRequests,
		});
	}

	private acceptUsageProviderReport(
		event: Extract<NormalizedInput, { type: "usage_provider_report" }>,
	): HostedSearchLifecycleEvent {
		if (this.providerReportedWebSearchRequests !== null) {
			if (event.webSearchRequests === this.providerReportedWebSearchRequests) {
				fail("duplicate_event");
			}
			if (event.webSearchRequests < this.providerReportedWebSearchRequests) {
				fail("out_of_order_event");
			}
		} else {
			this.ensureSemanticBytes(USAGE_RECORD_BYTES);
			this.addRetainedBytes(USAGE_RECORD_BYTES, 0);
		}
		this.providerReportedWebSearchRequests = event.webSearchRequests;
		return freezeEvent({
			type: event.type,
			webSearchRequests: event.webSearchRequests,
		});
	}

	private acceptTerminal(
		event: Extract<NormalizedInput, { type: "terminal" }>,
	): HostedSearchLifecycleEvent {
		if (
			this.status === "terminal" ||
			this.status === "finalized" ||
			this.status === "complete" ||
			this.status === "aborted"
		) {
			fail("duplicate_event");
		}
		if (this.activeCalls.size !== 0 || this.answerAssemblies.size !== 0) {
			fail("invalid_terminal");
		}
		this.status = "terminal";
		this.terminalReason = event.reason;
		return freezeEvent({ type: event.type, reason: event.reason });
	}

	private usageReconciliation(): HostedSearchUsageReconciliation {
		if (
			this.observedWebSearchRequests === null ||
			this.providerReportedWebSearchRequests === null
		) {
			return "unknown";
		}
		return this.observedWebSearchRequests ===
			this.providerReportedWebSearchRequests
			? "match"
			: "mismatch";
	}
}

export function createHostedSearchLifecycleReducer(): HostedSearchLifecycleReducer {
	return new HostedSearchLifecycleReducer();
}
