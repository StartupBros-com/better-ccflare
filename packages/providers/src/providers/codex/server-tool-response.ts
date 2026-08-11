import {
	HOSTED_SEARCH_LIFECYCLE_LIMITS,
	type HostedSearchCitationInput,
	type HostedSearchLifecycleInput,
	type HostedSearchSourceInput,
} from "../../server-tools/hosted-search-lifecycle";

type UnknownRecord = Record<string, unknown>;

const MAX_NATIVE_ID_BYTES = 256;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const MAX_TITLE_BYTES = 2 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ARRAY_ITEMS = 1024;
const OPAQUE_RANDOM_BYTES = 18;
const BASE64URL =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const FORBIDDEN_STRUCTURAL_SCALAR = /[\p{Cc}\p{Cf}]/u;
const URL_WHITESPACE = /\s/u;
const URL_CITATION_FIELDS = new Set([
	"type",
	"start_index",
	"end_index",
	"title",
	"url",
]);
const FILE_CITATION_FIELDS = new Set(["type", "file_id", "filename", "index"]);
const CONTAINER_FILE_CITATION_FIELDS = new Set([
	"type",
	"container_id",
	"file_id",
	"filename",
	"start_index",
	"end_index",
]);
const FILE_PATH_FIELDS = new Set(["type", "file_id", "index"]);
const SEARCH_ITEM_FIELDS = new Set(["id", "type", "status", "action"]);
const SEARCH_ACTION_FIELDS = new Set(["type", "query", "queries", "sources"]);
const SEARCH_SOURCE_FIELDS = new Set(["type", "url"]);
const MESSAGE_ITEM_FIELDS = new Set([
	"id",
	"type",
	"status",
	"role",
	"content",
	"phase",
]);
const OUTPUT_TEXT_FIELDS = new Set(["type", "text", "annotations", "logprobs"]);
const REFUSAL_FIELDS = new Set(["type", "refusal"]);
const GLOBAL_NONSEMANTIC_EVENT_TYPES = new Set([
	"response.created",
	"response.queued",
	"response.in_progress",
]);
const REASONING_NONSEMANTIC_EVENT_TYPES = new Set([
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.reasoning_text.done",
]);
const MESSAGE_NONSEMANTIC_EVENT_TYPES = new Set([
	"response.content_part.added",
	"response.output_text.delta",
	"response.content_part.done",
]);
const FUNCTION_NONSEMANTIC_EVENT_TYPES = new Set([
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
]);

export const CODEX_SERVER_TOOL_RESPONSE_LIMITS = Object.freeze({
	searchCalls: HOSTED_SEARCH_LIFECYCLE_LIMITS.activeCalls,
	messages: 256,
	genericOutputs: 256,
	outputItems: HOSTED_SEARCH_LIFECYCLE_LIMITS.replayEnvelopes,
	annotations: HOSTED_SEARCH_LIFECYCLE_LIMITS.citations,
	sourcesPerCall: HOSTED_SEARCH_LIFECYCLE_LIMITS.sourcesPerCall,
	sourcesPerResponse: HOSTED_SEARCH_LIFECYCLE_LIMITS.sourcesPerResponse,
	retainedBytes: HOSTED_SEARCH_LIFECYCLE_LIMITS.liveSemanticBytes,
});

/**
 * Native Responses events that carry no hosted-search semantics. This closed
 * allowlist is mirrored by the sanitized official-contract fixture.
 */
export const CODEX_HOSTED_SEARCH_NONSEMANTIC_EVENT_TYPES = Object.freeze([
	"response.created",
	"response.queued",
	"response.in_progress",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.reasoning_text.done",
	"response.content_part.added",
	"response.output_text.delta",
	"response.content_part.done",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
] as const);

const NONSEMANTIC_EVENT_TYPES = new Set<string>(
	CODEX_HOSTED_SEARCH_NONSEMANTIC_EVENT_TYPES,
);

/** Content-free failure for a response that entered the exact hosted path. */
export class CodexServerToolResponseError extends Error {
	readonly code = "codex_server_tool_response_invalid" as const;

	constructor() {
		super("Codex server-tool response decoding failed");
		Object.defineProperty(this, "name", {
			value: "CodexServerToolResponseError",
			configurable: true,
		});
	}
}

function rejected(): CodexServerToolResponseError {
	return new CodexServerToolResponseError();
}

function fail(): never {
	throw rejected();
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
	if (!isRecord(value)) fail();
	return value;
}

function own(record: UnknownRecord, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined || !("value" in descriptor)) fail();
	return descriptor.value;
}

function optionalOwn(record: UnknownRecord, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) fail();
	return descriptor.value;
}

function allowOnlyOwnFields(
	record: UnknownRecord,
	allowed: ReadonlySet<string>,
): void {
	for (const key of Reflect.ownKeys(record)) {
		if (typeof key !== "string" || !allowed.has(key)) fail();
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (descriptor === undefined || !("value" in descriptor)) fail();
	}
}

function arraySnapshot(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) fail();
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

const textEncoder = new TextEncoder();

const SHA256_INITIAL = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
	0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
	return (value >>> count) | (value << (32 - count));
}

/** Runtime-portable synchronous SHA-256 for bounded decoder identities. */
function sha256Hex(input: Uint8Array): string {
	const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.byteLength] = 0x80;
	const bitLength = input.byteLength * 8;
	const paddedView = new DataView(padded.buffer);
	paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
	paddedView.setUint32(paddedLength - 4, bitLength >>> 0);

	const state = Uint32Array.from(SHA256_INITIAL);
	const words = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			words[index] = paddedView.getUint32(offset + index * 4);
		}
		for (let index = 16; index < 64; index += 1) {
			const previous15 = words[index - 15] ?? 0;
			const previous2 = words[index - 2] ?? 0;
			const sigma0 =
				rotateRight(previous15, 7) ^
				rotateRight(previous15, 18) ^
				(previous15 >>> 3);
			const sigma1 =
				rotateRight(previous2, 17) ^
				rotateRight(previous2, 19) ^
				(previous2 >>> 10);
			words[index] =
				((words[index - 16] ?? 0) +
					sigma0 +
					(words[index - 7] ?? 0) +
					sigma1) >>>
				0;
		}

		let a = state[0] ?? 0;
		let b = state[1] ?? 0;
		let c = state[2] ?? 0;
		let d = state[3] ?? 0;
		let e = state[4] ?? 0;
		let f = state[5] ?? 0;
		let g = state[6] ?? 0;
		let h = state[7] ?? 0;
		for (let index = 0; index < 64; index += 1) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choose = (e & f) ^ (~e & g);
			const temporary1 =
				(h +
					sum1 +
					choose +
					(SHA256_ROUND[index] ?? 0) +
					(words[index] ?? 0)) >>>
				0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}
		state[0] = ((state[0] ?? 0) + a) >>> 0;
		state[1] = ((state[1] ?? 0) + b) >>> 0;
		state[2] = ((state[2] ?? 0) + c) >>> 0;
		state[3] = ((state[3] ?? 0) + d) >>> 0;
		state[4] = ((state[4] ?? 0) + e) >>> 0;
		state[5] = ((state[5] ?? 0) + f) >>> 0;
		state[6] = ((state[6] ?? 0) + g) >>> 0;
		state[7] = ((state[7] ?? 0) + h) >>> 0;
	}
	return [...state]
		.map((value) => value.toString(16).padStart(8, "0"))
		.join("");
}

function identityDigest(domain: string, parts: readonly string[]): string {
	const encoded = [domain, ...parts].map((part) => textEncoder.encode(part));
	const byteLength = encoded.reduce(
		(total, part) => total + 4 + part.byteLength,
		0,
	);
	if (!Number.isSafeInteger(byteLength) || byteLength > 0xffff_ffff) fail();
	const framed = new Uint8Array(byteLength);
	const view = new DataView(framed.buffer);
	let offset = 0;
	for (const part of encoded) {
		view.setUint32(offset, part.byteLength);
		offset += 4;
		framed.set(part, offset);
		offset += part.byteLength;
	}
	return sha256Hex(framed);
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
		(options.structural === true && FORBIDDEN_STRUCTURAL_SCALAR.test(value)) ||
		textEncoder.encode(value).byteLength > maxBytes
	) {
		fail();
	}
	return value;
}

function nativeId(value: unknown): string {
	return boundedString(value, MAX_NATIVE_ID_BYTES, {
		nonEmpty: true,
		structural: true,
	});
}

function safeIndex(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail();
	}
	return value;
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
	const authority = input.slice(input.indexOf("://") + 3).split(/[/?#]/u, 1)[0];
	if (authority?.includes("@")) fail();
	return input;
}

function eventType(record: UnknownRecord): string {
	return boundedString(own(record, "type"), 128, {
		nonEmpty: true,
		structural: true,
	});
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

function base64url(bytes: Uint8Array): string {
	let output = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1] ?? 0;
		const third = bytes[index + 2] ?? 0;
		const word = (first << 16) | (second << 8) | third;
		output += BASE64URL[(word >>> 18) & 63];
		output += BASE64URL[(word >>> 12) & 63];
		if (index + 1 < bytes.length) output += BASE64URL[(word >>> 6) & 63];
		if (index + 2 < bytes.length) output += BASE64URL[word & 63];
	}
	return output;
}

function defaultRandomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

type RandomBytes = (length: number) => Uint8Array;

export interface CodexServerToolResponseDecoderOptions {
	/** Test seam only; production callers should use the OS CSPRNG default. */
	readonly randomBytes?: RandomBytes;
}

export interface CodexServerToolResponseDecoderSnapshot {
	readonly status: "open" | "terminal" | "poisoned" | "aborted";
	readonly searchCalls: number;
	readonly messageItems: number;
	readonly genericOutputs: number;
	readonly outputItems: number;
	readonly streamedAnnotations: number;
	readonly retainedBytes: number;
}

type ParsedUrlAnnotation = Readonly<{
	kind: "url";
	startIndex: number;
	endIndex: number;
	title: string;
	url: string;
	signature: string;
}>;

type ParsedOtherAnnotation = Readonly<{
	kind: "other";
	signature: string;
}>;

type ParsedAnnotation = ParsedUrlAnnotation | ParsedOtherAnnotation;

type SearchCallState = {
	readonly nativeId: string;
	readonly outputIndex: number;
	readonly publicId: string;
	inProgressSeen: boolean;
	searchingSeen: boolean;
	completedProgressSeen: boolean;
	done: boolean;
	sourceRefsByUrl: ReadonlyMap<string, string>;
	signature: string | null;
};

type TextState = {
	readonly annotations: ParsedAnnotation[];
	finalized: boolean;
	signature: string | null;
};

type MessageState = {
	readonly nativeId: string;
	readonly outputIndex: number;
	readonly content: Map<number, TextState>;
	done: boolean;
};

type GenericOutputState = {
	readonly nativeId: string;
	readonly outputIndex: number;
	readonly type: "reasoning" | "function_call";
	done: boolean;
};

type OutputState =
	| Readonly<{ type: "web_search_call"; nativeId: string }>
	| Readonly<{ type: "message"; nativeId: string }>
	| Readonly<{
			type: "reasoning" | "function_call";
			nativeId: string;
	  }>;

function freezeInputs(
	events: readonly HostedSearchLifecycleInput[],
): readonly HostedSearchLifecycleInput[] {
	return Object.freeze(events.map((event) => Object.freeze(event)));
}

function parsedAnnotation(value: unknown): ParsedAnnotation {
	const record = asRecord(value);
	const type = eventType(record);
	switch (type) {
		case "url_citation": {
			allowOnlyOwnFields(record, URL_CITATION_FIELDS);
			const startIndex = safeIndex(own(record, "start_index"));
			const endIndex = safeIndex(own(record, "end_index"));
			const title = boundedString(own(record, "title"), MAX_TITLE_BYTES);
			const url = canonicalUrl(own(record, "url"));
			return Object.freeze({
				kind: "url",
				startIndex,
				endIndex,
				title,
				url,
				signature: identityDigest("annotation:url", [
					String(startIndex),
					String(endIndex),
					title,
					url,
				]),
			});
		}
		case "file_citation": {
			allowOnlyOwnFields(record, FILE_CITATION_FIELDS);
			const fileId = nativeId(own(record, "file_id"));
			const filename = boundedString(own(record, "filename"), MAX_TITLE_BYTES);
			const index = safeIndex(own(record, "index"));
			return Object.freeze({
				kind: "other",
				signature: identityDigest("annotation:file", [
					fileId,
					filename,
					String(index),
				]),
			});
		}
		case "container_file_citation": {
			allowOnlyOwnFields(record, CONTAINER_FILE_CITATION_FIELDS);
			const containerId = nativeId(own(record, "container_id"));
			const fileId = nativeId(own(record, "file_id"));
			const filename = boundedString(own(record, "filename"), MAX_TITLE_BYTES);
			const startIndex = safeIndex(own(record, "start_index"));
			const endIndex = safeIndex(own(record, "end_index"));
			if (endIndex <= startIndex) fail();
			return Object.freeze({
				kind: "other",
				signature: identityDigest("annotation:container-file", [
					containerId,
					fileId,
					filename,
					String(startIndex),
					String(endIndex),
				]),
			});
		}
		case "file_path": {
			allowOnlyOwnFields(record, FILE_PATH_FIELDS);
			const fileId = nativeId(own(record, "file_id"));
			const index = safeIndex(own(record, "index"));
			return Object.freeze({
				kind: "other",
				signature: identityDigest("annotation:file-path", [
					fileId,
					String(index),
				]),
			});
		}
		default:
			fail();
	}
}

function parseCompleteSearchItem(value: unknown): Readonly<{
	nativeId: string;
	query: string;
	sources: readonly HostedSearchSourceInput[];
	sourceRefsByUrl: ReadonlyMap<string, string>;
	signature: string;
}> {
	const item = asRecord(value);
	if (eventType(item) !== "web_search_call") fail();
	allowOnlyOwnFields(item, SEARCH_ITEM_FIELDS);
	const id = nativeId(own(item, "id"));
	if (own(item, "status") !== "completed") fail();
	const action = asRecord(own(item, "action"));
	if (eventType(action) !== "search") fail();
	allowOnlyOwnFields(action, SEARCH_ACTION_FIELDS);
	const query = boundedString(own(action, "query"), MAX_QUERY_BYTES, {
		nonEmpty: true,
	});
	const queriesValue = optionalOwn(action, "queries");
	if (queriesValue !== undefined && queriesValue !== null) {
		const queries = arraySnapshot(queriesValue);
		if (queries.length !== 1 || queries[0] !== query) fail();
	}
	const sourceValues = arraySnapshot(own(action, "sources"));
	const sources: HostedSearchSourceInput[] = [];
	const urls = new Set<string>();
	const sourceRefsByUrl = new Map<string, string>();
	for (const sourceValue of sourceValues) {
		const sourceRecord = asRecord(sourceValue);
		if (eventType(sourceRecord) !== "url") fail();
		allowOnlyOwnFields(sourceRecord, SEARCH_SOURCE_FIELDS);
		const url = canonicalUrl(own(sourceRecord, "url"));
		if (urls.has(url)) continue;
		if (sources.length >= CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerCall) {
			fail();
		}
		urls.add(url);
		const sourceRef = `source_${sources.length.toString(36)}`;
		sourceRefsByUrl.set(url, sourceRef);
		sources.push(
			Object.freeze({
				sourceRef,
				url,
				title: "",
				pageAge: null,
			}),
		);
	}
	return Object.freeze({
		nativeId: id,
		query,
		sources: Object.freeze(sources),
		sourceRefsByUrl,
		signature: identityDigest("search", [query, ...urls]),
	});
}

export class CodexServerToolResponseDecoder {
	private readonly randomBytes: RandomBytes;
	private readonly issuedOpaqueIds = new Set<string>();
	private readonly calls = new Map<string, SearchCallState>();
	private readonly messages = new Map<string, MessageState>();
	private readonly genericOutputs = new Map<string, GenericOutputState>();
	private readonly outputByIndex = new Map<number, OutputState>();
	private readonly nextCitationOrdinalBySource = new Map<string, number>();
	private lastSequence: number | null = null;
	private nextOutputIndex = 0;
	private activeOutputIndex: number | null = null;
	private streamedAnnotationCount = 0;
	private terminal = false;
	private poisoned = false;
	private aborted = false;
	private abortSnapshot: CodexServerToolResponseDecoderSnapshot | null = null;
	private successfulSearchCalls = 0;
	private sawFunctionCall = false;
	private sawRefusal = false;

	constructor(randomBytes: RandomBytes = defaultRandomBytes) {
		this.randomBytes = randomBytes;
	}

	acceptSseEvent(event: unknown): readonly HostedSearchLifecycleInput[] {
		try {
			if (this.terminal) fail();
			const record = asRecord(event);
			const type = eventType(record);
			this.acceptSequence(own(record, "sequence_number"));
			if (NONSEMANTIC_EVENT_TYPES.has(type)) {
				this.acceptNonsemanticEvent(record, type);
				return Object.freeze([]);
			}

			switch (type) {
				case "response.output_item.added":
					return freezeInputs(
						this.acceptOutputItemAdded(
							own(record, "item"),
							safeIndex(own(record, "output_index")),
						),
					);
				case "response.web_search_call.in_progress":
					return freezeInputs(this.acceptSearchProgress(record, "in_progress"));
				case "response.web_search_call.searching":
					return freezeInputs(this.acceptSearchProgress(record, "searching"));
				case "response.web_search_call.completed":
					return freezeInputs(this.acceptSearchProgress(record, "completed"));
				case "response.output_text.annotation.added":
					this.acceptAnnotationAdded(record);
					return Object.freeze([]);
				case "response.output_text.done":
					return freezeInputs(this.acceptOutputTextDone(record));
				case "response.output_item.done":
					return freezeInputs(
						this.acceptOutputItemDone(
							own(record, "item"),
							safeIndex(own(record, "output_index")),
						),
					);
				case "response.completed":
				case "response.incomplete":
				case "response.failed":
					return freezeInputs(
						this.acceptTerminalResponse(own(record, "response"), type),
					);
				case "error": {
					if (
						this.activeOutputIndex !== null ||
						[...this.calls.values()].some((call) => !call.done) ||
						[...this.messages.values()].some((message) => !message.done) ||
						[...this.genericOutputs.values()].some((output) => !output.done)
					) {
						fail();
					}
					const successfulSearchCalls = this.successfulSearchCalls;
					this.releaseTerminalState();
					return freezeInputs([
						{
							type: "usage_observation",
							webSearchRequests: successfulSearchCalls,
						},
						{ type: "terminal", reason: "error" },
					]);
				}
				default:
					fail();
			}
		} catch {
			this.poisonAndThrow();
		}
	}

	acceptResponse(response: unknown): readonly HostedSearchLifecycleInput[] {
		try {
			if (this.terminal || this.lastSequence !== null) fail();
			const record = asRecord(response);
			const status = boundedString(own(record, "status"), 32, {
				nonEmpty: true,
				structural: true,
			});
			const eventTypeForStatus =
				status === "completed"
					? "response.completed"
					: status === "incomplete"
						? "response.incomplete"
						: status === "failed"
							? "response.failed"
							: fail();
			return freezeInputs(
				this.acceptTerminalResponse(record, eventTypeForStatus),
			);
		} catch {
			this.poisonAndThrow();
		}
	}

	/**
	 * Permanently closes the decoder and releases every request-scoped native
	 * identity and semantic assembly. Cancellation is deliberately idempotent.
	 */
	abort(): CodexServerToolResponseDecoderSnapshot {
		if (this.abortSnapshot !== null) return this.abortSnapshot;
		this.clearNativeState();
		this.terminal = true;
		this.aborted = true;
		this.abortSnapshot = Object.freeze({
			status: "aborted",
			searchCalls: 0,
			messageItems: 0,
			genericOutputs: 0,
			outputItems: 0,
			streamedAnnotations: 0,
			retainedBytes: 0,
		});
		return this.abortSnapshot;
	}

	snapshot(): CodexServerToolResponseDecoderSnapshot {
		if (this.abortSnapshot !== null) return this.abortSnapshot;
		return Object.freeze({
			status: this.poisoned ? "poisoned" : this.terminal ? "terminal" : "open",
			searchCalls: this.calls.size,
			messageItems: this.messages.size,
			genericOutputs: this.genericOutputs.size,
			outputItems: this.outputByIndex.size,
			streamedAnnotations: this.streamedAnnotationCount,
			retainedBytes: this.retainedBytes(),
		});
	}

	private acceptSequence(value: unknown): void {
		const sequence = safeIndex(value);
		if (this.lastSequence !== null && sequence <= this.lastSequence) fail();
		this.lastSequence = sequence;
	}

	private newOpaqueId(prefix: "srvtoolu_" | "srvtext_"): string {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const bytes = this.randomBytes(OPAQUE_RANDOM_BYTES);
			if (
				!(bytes instanceof Uint8Array) ||
				bytes.byteLength !== OPAQUE_RANDOM_BYTES
			) {
				fail();
			}
			const suffix = base64url(Uint8Array.from(bytes));
			// base64url's alphabet ends in '-' and '_' (indices 62/63), but the
			// consumer that validates these ids downstream — PUBLIC_CALL_ID in
			// server-tools/hosted-search-lifecycle.ts — requires the character
			// right after the prefix to be alphanumeric. A leading '-'/'_' is
			// therefore a 2-in-64 (~3.1%) chance of minting an id that fails its
			// own validation, surfacing as "Codex server-tool response decoding
			// failed" for the whole response. The retry loop below only re-drew
			// on duplicates, so a bad shape was never retried. Re-draw on it too.
			// Applied to both prefixes: srvtext_'s consumer has no such rule
			// today, but narrowing the output space is safe for a consumer that
			// already accepts a superset, and one uniform check beats a branch.
			if (!/^[A-Za-z0-9]/.test(suffix)) continue;
			const opaque = `${prefix}${suffix}`;
			if (this.issuedOpaqueIds.has(opaque)) continue;
			this.issuedOpaqueIds.add(opaque);
			this.enforceAggregateBounds();
			return opaque;
		}
		fail();
	}

	private releaseTerminalState(): void {
		this.terminal = true;
		this.clearNativeState();
	}

	private poisonAndThrow(): never {
		this.clearNativeState();
		this.terminal = true;
		if (!this.aborted) this.poisoned = true;
		throw rejected();
	}

	private clearNativeState(): void {
		this.calls.clear();
		this.messages.clear();
		this.genericOutputs.clear();
		this.outputByIndex.clear();
		this.nextCitationOrdinalBySource.clear();
		this.issuedOpaqueIds.clear();
		this.lastSequence = null;
		this.nextOutputIndex = 0;
		this.activeOutputIndex = null;
		this.streamedAnnotationCount = 0;
		this.successfulSearchCalls = 0;
		this.sawFunctionCall = false;
		this.sawRefusal = false;
	}

	private retainedBytes(): number {
		let total = 0;
		const add = (value: string | null): void => {
			if (value !== null) total += utf8Bytes(value);
		};
		for (const opaque of this.issuedOpaqueIds) add(opaque);
		for (const call of this.calls.values()) {
			add(call.nativeId);
			add(call.publicId);
			add(call.signature);
			for (const [url, sourceRef] of call.sourceRefsByUrl) {
				add(url);
				add(sourceRef);
			}
		}
		for (const message of this.messages.values()) {
			add(message.nativeId);
			for (const state of message.content.values()) {
				add(state.signature);
				for (const annotation of state.annotations) {
					total += this.annotationRetainedBytes(annotation);
				}
			}
		}
		for (const output of this.genericOutputs.values()) add(output.nativeId);
		for (const output of this.outputByIndex.values()) add(output.nativeId);
		for (const key of this.nextCitationOrdinalBySource.keys()) add(key);
		return total;
	}

	private annotationRetainedBytes(annotation: ParsedAnnotation): number {
		let total = utf8Bytes(annotation.signature);
		if (annotation.kind === "url") {
			total += utf8Bytes(annotation.title) + utf8Bytes(annotation.url);
		}
		return total;
	}

	private enforceTransientRetainedBytes(
		extraBytes: number,
		releasedBytes = 0,
	): void {
		const retained = this.retainedBytes();
		if (
			!Number.isSafeInteger(extraBytes) ||
			extraBytes < 0 ||
			!Number.isSafeInteger(releasedBytes) ||
			releasedBytes < 0 ||
			releasedBytes > retained ||
			retained - releasedBytes + extraBytes >
				CODEX_SERVER_TOOL_RESPONSE_LIMITS.retainedBytes
		) {
			fail();
		}
	}

	private enforceAggregateBounds(): void {
		let sourceCount = 0;
		for (const call of this.calls.values()) {
			if (
				call.sourceRefsByUrl.size >
				CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerCall
			) {
				fail();
			}
			sourceCount += call.sourceRefsByUrl.size;
		}
		if (
			this.calls.size > CODEX_SERVER_TOOL_RESPONSE_LIMITS.searchCalls ||
			this.messages.size > CODEX_SERVER_TOOL_RESPONSE_LIMITS.messages ||
			this.genericOutputs.size >
				CODEX_SERVER_TOOL_RESPONSE_LIMITS.genericOutputs ||
			this.outputByIndex.size > CODEX_SERVER_TOOL_RESPONSE_LIMITS.outputItems ||
			this.streamedAnnotationCount >
				CODEX_SERVER_TOOL_RESPONSE_LIMITS.annotations ||
			sourceCount > CODEX_SERVER_TOOL_RESPONSE_LIMITS.sourcesPerResponse ||
			this.retainedBytes() > CODEX_SERVER_TOOL_RESPONSE_LIMITS.retainedBytes
		) {
			fail();
		}
	}

	private acceptNonsemanticEvent(record: UnknownRecord, type: string): void {
		if (GLOBAL_NONSEMANTIC_EVENT_TYPES.has(type)) {
			if (
				Object.getOwnPropertyDescriptor(record, "item_id") !== undefined ||
				Object.getOwnPropertyDescriptor(record, "output_index") !== undefined
			) {
				fail();
			}
			return;
		}

		const id = nativeId(own(record, "item_id"));
		const outputIndex = safeIndex(own(record, "output_index"));
		if (this.activeOutputIndex !== outputIndex) fail();
		if (REASONING_NONSEMANTIC_EVENT_TYPES.has(type)) {
			this.assertOutputIdentity(outputIndex, "reasoning", id);
			const state = this.genericOutputs.get(id);
			if (state === undefined || state.done) fail();
			if (type.includes("summary")) {
				safeIndex(own(record, "summary_index"));
			} else {
				safeIndex(own(record, "content_index"));
			}
			return;
		}
		if (MESSAGE_NONSEMANTIC_EVENT_TYPES.has(type)) {
			this.assertOutputIdentity(outputIndex, "message", id);
			const state = this.messages.get(id);
			if (state === undefined || state.done) fail();
			safeIndex(own(record, "content_index"));
			return;
		}
		if (FUNCTION_NONSEMANTIC_EVENT_TYPES.has(type)) {
			this.assertOutputIdentity(outputIndex, "function_call", id);
			const state = this.genericOutputs.get(id);
			if (state === undefined || state.done) fail();
			return;
		}
		fail();
	}

	private reserveOutput(
		outputIndex: number,
		type: OutputState["type"],
		id: string,
	): void {
		if (
			outputIndex !== this.nextOutputIndex ||
			this.activeOutputIndex !== null ||
			this.outputByIndex.has(outputIndex) ||
			this.outputByIndex.size >= CODEX_SERVER_TOOL_RESPONSE_LIMITS.outputItems
		) {
			fail();
		}
		this.outputByIndex.set(outputIndex, { type, nativeId: id } as OutputState);
		this.nextOutputIndex += 1;
		this.activeOutputIndex = outputIndex;
		this.enforceAggregateBounds();
	}

	private resolveOutput(outputIndex: number): void {
		if (this.activeOutputIndex !== outputIndex) fail();
		this.activeOutputIndex = null;
	}

	private assertOutputIdentity(
		outputIndex: number,
		type: OutputState["type"],
		id: string,
	): void {
		const output = this.outputByIndex.get(outputIndex);
		if (
			output === undefined ||
			output.type !== type ||
			output.nativeId !== id
		) {
			fail();
		}
	}

	private acceptOutputItemAdded(
		value: unknown,
		outputIndex: number,
	): readonly HostedSearchLifecycleInput[] {
		const item = asRecord(value);
		const type = eventType(item);
		if (type === "web_search_call") {
			const id = nativeId(own(item, "id"));
			if (
				own(item, "status") !== "in_progress" ||
				this.calls.has(id) ||
				this.calls.size >= CODEX_SERVER_TOOL_RESPONSE_LIMITS.searchCalls
			) {
				fail();
			}
			this.reserveOutput(outputIndex, type, id);
			const publicId = this.newOpaqueId("srvtoolu_");
			this.calls.set(id, {
				nativeId: id,
				outputIndex,
				publicId,
				inProgressSeen: false,
				searchingSeen: false,
				completedProgressSeen: false,
				done: false,
				sourceRefsByUrl: new Map(),
				signature: null,
			});
			this.enforceAggregateBounds();
			return [
				Object.freeze({ type: "declared", callId: publicId }),
				Object.freeze({ type: "dispatched", callId: publicId }),
			];
		}
		if (type === "message") {
			const id = nativeId(own(item, "id"));
			this.validateMessagePhase(item);
			if (
				own(item, "status") !== "in_progress" ||
				own(item, "role") !== "assistant" ||
				this.messages.has(id)
			) {
				fail();
			}
			arraySnapshot(own(item, "content"));
			this.reserveOutput(outputIndex, type, id);
			this.messages.set(id, {
				nativeId: id,
				outputIndex,
				content: new Map(),
				done: false,
			});
			this.enforceAggregateBounds();
			return [];
		}
		if (type === "reasoning" || type === "function_call") {
			const id = nativeId(own(item, "id"));
			if (this.genericOutputs.has(id)) fail();
			this.reserveOutput(outputIndex, type, id);
			this.genericOutputs.set(id, {
				nativeId: id,
				outputIndex,
				type,
				done: false,
			});
			if (type === "function_call") this.sawFunctionCall = true;
			this.enforceAggregateBounds();
			return [];
		}
		fail();
	}

	private acceptSearchProgress(
		record: UnknownRecord,
		phase: "in_progress" | "searching" | "completed",
	): readonly HostedSearchLifecycleInput[] {
		const id = nativeId(own(record, "item_id"));
		const outputIndex = safeIndex(own(record, "output_index"));
		this.assertOutputIdentity(outputIndex, "web_search_call", id);
		if (this.activeOutputIndex !== outputIndex) fail();
		const call = this.calls.get(id);
		if (call === undefined || call.done) fail();
		if (phase === "in_progress") {
			if (
				call.inProgressSeen ||
				call.searchingSeen ||
				call.completedProgressSeen
			) {
				fail();
			}
			call.inProgressSeen = true;
			return [];
		}
		if (phase === "searching") {
			if (
				!call.inProgressSeen ||
				call.searchingSeen ||
				call.completedProgressSeen
			) {
				fail();
			}
			call.searchingSeen = true;
			return [Object.freeze({ type: "searching", callId: call.publicId })];
		}
		if (!call.searchingSeen || call.completedProgressSeen) fail();
		call.completedProgressSeen = true;
		return [];
	}

	private completeSearch(
		value: unknown,
		outputIndex: number,
		allowExisting = false,
	): readonly HostedSearchLifecycleInput[] {
		const parsed = parseCompleteSearchItem(value);
		let call = this.calls.get(parsed.nativeId);
		const events: HostedSearchLifecycleInput[] = [];
		if (call === undefined) {
			if (this.calls.size >= CODEX_SERVER_TOOL_RESPONSE_LIMITS.searchCalls) {
				fail();
			}
			this.reserveOutput(outputIndex, "web_search_call", parsed.nativeId);
			const publicId = this.newOpaqueId("srvtoolu_");
			call = {
				nativeId: parsed.nativeId,
				outputIndex,
				publicId,
				inProgressSeen: false,
				searchingSeen: false,
				completedProgressSeen: false,
				done: false,
				sourceRefsByUrl: new Map(),
				signature: null,
			};
			this.calls.set(parsed.nativeId, call);
			this.enforceAggregateBounds();
			events.push(
				Object.freeze({ type: "declared", callId: publicId }),
				Object.freeze({ type: "dispatched", callId: publicId }),
			);
		} else {
			this.assertOutputIdentity(
				outputIndex,
				"web_search_call",
				parsed.nativeId,
			);
			if (call.outputIndex !== outputIndex) fail();
		}
		if (call.done) {
			if (!allowExisting || call.signature !== parsed.signature) fail();
			return events;
		}
		if (!call.searchingSeen) {
			call.searchingSeen = true;
			events.push(Object.freeze({ type: "searching", callId: call.publicId }));
		}
		call.done = true;
		call.sourceRefsByUrl = parsed.sourceRefsByUrl;
		call.signature = parsed.signature;
		this.successfulSearchCalls += 1;
		this.resolveOutput(outputIndex);
		this.enforceAggregateBounds();
		const queryKnown = Object.freeze({
			type: "query_known" as const,
			callId: call.publicId,
			queryOrdinal: 0 as const,
			query: parsed.query,
		});
		const result = Object.freeze({
			type: "result" as const,
			callId: call.publicId,
			queryOrdinal: 0 as const,
			sources: parsed.sources,
		});
		events.push(queryKnown, result);
		return events;
	}

	private acceptAnnotationAdded(record: UnknownRecord): void {
		const id = nativeId(own(record, "item_id"));
		const outputIndex = safeIndex(own(record, "output_index"));
		this.assertOutputIdentity(outputIndex, "message", id);
		if (this.activeOutputIndex !== outputIndex) fail();
		const message = this.messages.get(id);
		if (message === undefined || message.done) fail();
		const contentIndex = safeIndex(own(record, "content_index"));
		const annotationIndex = safeIndex(own(record, "annotation_index"));
		let textState = message.content.get(contentIndex);
		if (textState === undefined) {
			textState = { annotations: [], finalized: false, signature: null };
			message.content.set(contentIndex, textState);
		}
		if (
			textState.finalized ||
			annotationIndex !== textState.annotations.length
		) {
			fail();
		}
		const annotation = parsedAnnotation(own(record, "annotation"));
		textState.annotations.push(annotation);
		this.streamedAnnotationCount += 1;
		this.enforceAggregateBounds();
	}

	private acceptOutputTextDone(
		record: UnknownRecord,
	): readonly HostedSearchLifecycleInput[] {
		const id = nativeId(own(record, "item_id"));
		const outputIndex = safeIndex(own(record, "output_index"));
		this.assertOutputIdentity(outputIndex, "message", id);
		if (this.activeOutputIndex !== outputIndex) fail();
		const message = this.messages.get(id);
		if (message === undefined || message.done) fail();
		const contentIndex = safeIndex(own(record, "content_index"));
		let textState = message.content.get(contentIndex);
		if (textState === undefined) {
			textState = { annotations: [], finalized: false, signature: null };
			message.content.set(contentIndex, textState);
		}
		if (textState.finalized) fail();
		return this.finalizeText(
			textState,
			boundedString(own(record, "text"), MAX_TEXT_BYTES),
			textState.annotations,
		);
	}

	private finalizeText(
		state: TextState,
		text: string,
		annotations: readonly ParsedAnnotation[],
	): readonly HostedSearchLifecycleInput[] {
		const transientAnnotationBytes =
			annotations === state.annotations
				? 0
				: annotations.reduce(
						(total, annotation) =>
							total + this.annotationRetainedBytes(annotation),
						0,
					);
		this.enforceTransientRetainedBytes(
			utf8Bytes(text) + transientAnnotationBytes,
		);
		const signature = identityDigest("answer-text", [
			text,
			...annotations.map((annotation) => annotation.signature),
		]);
		if (state.finalized) {
			if (state.signature !== signature) fail();
			return [];
		}

		const citations: Omit<HostedSearchCitationInput, "blockId">[] = [];
		for (
			let originalIndex = 0;
			originalIndex < annotations.length;
			originalIndex += 1
		) {
			const annotation = annotations[originalIndex];
			if (annotation?.kind !== "url") continue;
			if (
				annotation.endIndex <= annotation.startIndex ||
				annotation.endIndex > text.length ||
				!isScalarBoundary(text, annotation.startIndex) ||
				!isScalarBoundary(text, annotation.endIndex)
			) {
				fail();
			}
			const matches = [...this.calls.values()].filter(
				(call) => call.done && call.sourceRefsByUrl.has(annotation.url),
			);
			if (matches.length !== 1) fail();
			const call = matches[0];
			if (call === undefined) fail();
			const sourceRef = call.sourceRefsByUrl.get(annotation.url);
			if (sourceRef === undefined) fail();
			const ordinalKey = `${call.publicId}\0${sourceRef}`;
			const citationOrdinal =
				this.nextCitationOrdinalBySource.get(ordinalKey) ?? 0;
			this.nextCitationOrdinalBySource.set(ordinalKey, citationOrdinal + 1);
			citations.push(
				Object.freeze({
					callId: call.publicId,
					sourceRef,
					citationOrdinal,
					originalIndex,
					startCharIndex: annotation.startIndex,
					endCharIndex: annotation.endIndex,
				}),
			);
		}
		state.finalized = true;
		state.signature = signature;
		state.annotations.splice(0);
		this.enforceAggregateBounds();
		if (citations.length === 0) return [];
		const blockId = this.newOpaqueId("srvtext_");
		this.enforceAggregateBounds();
		return [
			Object.freeze({ type: "answer_text_started", blockId, text }),
			...citations.map((citation) =>
				Object.freeze({
					type: "citation" as const,
					blockId,
					callId: citation.callId,
					sourceRef: citation.sourceRef,
					citationOrdinal: citation.citationOrdinal,
					originalIndex: citation.originalIndex,
					startCharIndex: citation.startCharIndex,
					endCharIndex: citation.endCharIndex,
				}),
			),
			Object.freeze({ type: "answer_text_completed", blockId }),
		];
	}

	private completeMessage(
		value: unknown,
		outputIndex: number,
		allowExisting = false,
	): readonly HostedSearchLifecycleInput[] {
		const item = asRecord(value);
		if (eventType(item) !== "message") fail();
		allowOnlyOwnFields(item, MESSAGE_ITEM_FIELDS);
		const id = nativeId(own(item, "id"));
		this.validateMessagePhase(item);
		if (
			own(item, "status") !== "completed" ||
			own(item, "role") !== "assistant"
		) {
			fail();
		}
		let message = this.messages.get(id);
		if (message === undefined) {
			this.reserveOutput(outputIndex, "message", id);
			message = {
				nativeId: id,
				outputIndex,
				content: new Map(),
				done: false,
			};
			this.messages.set(id, message);
		} else {
			this.assertOutputIdentity(outputIndex, "message", id);
			if (message.outputIndex !== outputIndex) fail();
			if (message.done && !allowExisting) fail();
		}
		const content = arraySnapshot(own(item, "content"));
		const events: HostedSearchLifecycleInput[] = [];
		for (let index = 0; index < content.length; index += 1) {
			const part = asRecord(content[index]);
			const type = eventType(part);
			if (type === "output_text") {
				allowOnlyOwnFields(part, OUTPUT_TEXT_FIELDS);
				const text = boundedString(own(part, "text"), MAX_TEXT_BYTES);
				const annotationValues = arraySnapshot(own(part, "annotations"));
				if (
					annotationValues.length >
					CODEX_SERVER_TOOL_RESPONSE_LIMITS.annotations
				) {
					fail();
				}
				const annotations: ParsedAnnotation[] = [];
				let transientAnnotationBytes = 0;
				for (const annotationValue of annotationValues) {
					const annotation = parsedAnnotation(annotationValue);
					annotations.push(annotation);
					transientAnnotationBytes += this.annotationRetainedBytes(annotation);
					this.enforceTransientRetainedBytes(transientAnnotationBytes);
				}
				let state = message.content.get(index);
				if (state === undefined) {
					state = { annotations: [], finalized: false, signature: null };
					message.content.set(index, state);
				}
				if (!state.finalized) {
					if (state.annotations.length > 0) {
						if (
							state.annotations.length !== annotations.length ||
							state.annotations.some(
								(entry, annotationIndex) =>
									entry.signature !== annotations[annotationIndex]?.signature,
							)
						) {
							fail();
						}
					} else {
						this.streamedAnnotationCount += annotations.length;
						this.enforceAggregateBounds();
					}
				}
				events.push(...this.finalizeText(state, text, annotations));
				continue;
			}
			if (type === "refusal") {
				allowOnlyOwnFields(part, REFUSAL_FIELDS);
				const refusal = boundedString(own(part, "refusal"), MAX_TEXT_BYTES);
				this.enforceTransientRetainedBytes(utf8Bytes(refusal));
				this.sawRefusal = true;
				continue;
			}
			fail();
		}
		if ([...message.content.keys()].some((index) => index >= content.length)) {
			fail();
		}
		if (message.done) {
			if (events.length > 0) fail();
			return [];
		}
		message.done = true;
		this.resolveOutput(outputIndex);
		this.enforceAggregateBounds();
		return events;
	}

	private validateMessagePhase(item: UnknownRecord): void {
		const phase = optionalOwn(item, "phase");
		if (
			phase !== undefined &&
			phase !== null &&
			phase !== "commentary" &&
			phase !== "final_answer"
		) {
			fail();
		}
	}

	private acceptOutputItemDone(
		value: unknown,
		outputIndex: number,
	): readonly HostedSearchLifecycleInput[] {
		const item = asRecord(value);
		const type = eventType(item);
		if (type === "web_search_call")
			return this.completeSearch(item, outputIndex);
		if (type === "message") return this.completeMessage(item, outputIndex);
		if (type === "reasoning" || type === "function_call") {
			const id = nativeId(own(item, "id"));
			let state = this.genericOutputs.get(id);
			if (state === undefined) {
				this.reserveOutput(outputIndex, type, id);
				state = { nativeId: id, outputIndex, type, done: false };
				this.genericOutputs.set(id, state);
			} else {
				this.assertOutputIdentity(outputIndex, type, id);
			}
			if (state.done) fail();
			state.done = true;
			this.resolveOutput(outputIndex);
			if (type === "function_call") this.sawFunctionCall = true;
			this.enforceAggregateBounds();
			return [];
		}
		fail();
	}

	private terminalReason(
		response: UnknownRecord,
		event: "response.completed" | "response.incomplete" | "response.failed",
	):
		| "end_turn"
		| "tool_use"
		| "max_tokens"
		| "refusal"
		| "incomplete"
		| "error" {
		const status = own(response, "status");
		if (event === "response.completed") {
			if (status !== "completed") fail();
			if (this.sawRefusal) return "refusal";
			return this.sawFunctionCall ? "tool_use" : "end_turn";
		}
		if (event === "response.failed") {
			if (status !== "failed") fail();
			return "error";
		}
		if (status !== "incomplete") fail();
		const detailsValue = optionalOwn(response, "incomplete_details");
		if (detailsValue !== undefined && detailsValue !== null) {
			const details = asRecord(detailsValue);
			if (optionalOwn(details, "reason") === "max_output_tokens") {
				return "max_tokens";
			}
		}
		return "incomplete";
	}

	private acceptTerminalResponse(
		value: unknown,
		event: "response.completed" | "response.incomplete" | "response.failed",
	): readonly HostedSearchLifecycleInput[] {
		if (this.terminal) fail();
		const response = asRecord(value);
		const output = arraySnapshot(own(response, "output"));
		const events: HostedSearchLifecycleInput[] = [];
		const terminalSearchIds = new Set<string>();
		for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
			const item = asRecord(output[outputIndex]);
			const type = eventType(item);
			if (type === "web_search_call") {
				const id = nativeId(own(item, "id"));
				if (terminalSearchIds.has(id)) fail();
				terminalSearchIds.add(id);
				events.push(...this.completeSearch(item, outputIndex, true));
				continue;
			}
			if (type === "message") {
				events.push(...this.completeMessage(item, outputIndex, true));
				continue;
			}
			if (type === "reasoning" || type === "function_call") {
				const id = nativeId(own(item, "id"));
				const existing = this.outputByIndex.get(outputIndex);
				if (existing === undefined) {
					this.reserveOutput(outputIndex, type, id);
				} else {
					this.assertOutputIdentity(outputIndex, type, id);
				}
				const existingGeneric = this.genericOutputs.get(id);
				let shouldResolve = false;
				if (existingGeneric === undefined) {
					this.genericOutputs.set(id, {
						nativeId: id,
						outputIndex,
						type,
						done: true,
					});
					shouldResolve = true;
				} else {
					if (
						existingGeneric.outputIndex !== outputIndex ||
						existingGeneric.type !== type
					) {
						fail();
					}
					shouldResolve = !existingGeneric.done;
					existingGeneric.done = true;
				}
				if (shouldResolve) this.resolveOutput(outputIndex);
				if (type === "function_call") this.sawFunctionCall = true;
				this.enforceAggregateBounds();
				continue;
			}
			fail();
		}

		const reason = this.terminalReason(response, event);
		if (
			this.activeOutputIndex !== null ||
			[...this.calls.values()].some((call) => !call.done) ||
			terminalSearchIds.size !== this.calls.size ||
			[...this.calls.keys()].some((id) => !terminalSearchIds.has(id)) ||
			this.outputByIndex.size !== output.length ||
			[...this.outputByIndex.keys()].some(
				(outputIndex) => outputIndex >= output.length,
			)
		) {
			fail();
		}
		events.push(
			Object.freeze({
				type: "usage_observation",
				webSearchRequests: this.successfulSearchCalls,
			}),
			Object.freeze({ type: "terminal", reason }),
		);
		this.releaseTerminalState();
		return events;
	}
}

export function createCodexServerToolResponseDecoder(
	options: CodexServerToolResponseDecoderOptions = {},
): CodexServerToolResponseDecoder {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(options, "randomBytes");
		if (descriptor !== undefined && !("value" in descriptor)) fail();
		const randomBytes = descriptor?.value;
		if (randomBytes !== undefined && typeof randomBytes !== "function") fail();
		return new CodexServerToolResponseDecoder(
			randomBytes as RandomBytes | undefined,
		);
	} catch {
		throw rejected();
	}
}
