import {
	inspectServerToolReplayEnvelopeHeader,
	SERVER_TOOL_REPLAY_ENVELOPE_PREFIX,
	type ServerToolReplayEnvelopeBinding,
} from "./replay-envelope";

const RESERVED_PROXY_NAMESPACE_PREFIX = "bccf";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305" as const;
const UNTRUSTED_HISTORY_REVISION = "bccf-untrusted-history-v1" as const;

const MAX_TOKEN_CODE_UNITS = 4096;
const MAX_UNIQUE_TOKENS = 512;
const MAX_AGGREGATE_ENCRYPTED_INPUT_BYTES = 1024 * 1024;
const MAX_FINALIZED_REPLACEMENT_TEXT_BYTES = 1024 * 1024;
const MAX_SOURCES_PER_CALL = 64;
const MAX_SOURCES_PER_RESPONSE = 256;
const MAX_CITATIONS_PER_RESPONSE = 256;
const MAX_URL_BYTES = 8 * 1024;
const MAX_TITLE_BYTES = 2 * 1024;
const MAX_CITED_TEXT_BYTES = 8 * 1024;
const MAX_PAGE_AGE_BYTES = 256;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_CALL_ID_BYTES = 256;

const SAFE_WEB_SEARCH_ERROR_CODES = new Set([
	"too_many_requests",
	"invalid_tool_input",
	"max_uses_exceeded",
	"query_too_long",
	"request_too_large",
	"unavailable",
]);

const URL_WHITESPACE = /\s/u;
const STRUCTURAL_FORBIDDEN_CODE_POINT = /(?:[\p{Cc}\p{Cf}]|\u034f)/u;

export const INVALID_SERVER_TOOL_HISTORY_PROJECTION_CODE =
	"invalid_server_tool_history_projection" as const;
export const INVALID_SERVER_TOOL_HISTORY_PROJECTION_MESSAGE =
	"Invalid server tool history projection." as const;

export class InvalidServerToolHistoryProjectionError extends Error {
	readonly code = INVALID_SERVER_TOOL_HISTORY_PROJECTION_CODE;

	constructor() {
		super(INVALID_SERVER_TOOL_HISTORY_PROJECTION_MESSAGE);
		Object.defineProperty(this, "name", {
			value: "InvalidServerToolHistoryProjectionError",
			configurable: true,
		});
	}
}

export interface ServerToolHistoryReplayContext {
	readonly audience: string;
	readonly lineage: string;
}

export interface ServerToolHistoryReplayDecoder {
	decodeReplayToken(
		token: string,
		binding: ServerToolReplayEnvelopeBinding,
	): Promise<unknown>;
}

export interface NativeServerToolOpaquePosition {
	readonly messageIndex: number;
	readonly blockIndex: number;
	readonly role: string;
	readonly sourceType: "web_search_result" | "citation";
	readonly itemIndex: number;
	readonly field: "encrypted_content" | "encrypted_index";
}

interface ServerToolHistoryReplacementBase {
	readonly messageIndex: number;
	readonly blockIndex: number;
	readonly role: string;
	readonly callId: string;
	readonly text: string;
}

export type ServerToolHistoryReplacement =
	| (ServerToolHistoryReplacementBase & {
			readonly sourceType: "server_tool_use" | "web_search_tool_result";
	  })
	| (ServerToolHistoryReplacementBase & {
			readonly sourceType: "web_search_citation";
			readonly citationIndex: number;
	  });

export interface ServerToolHistoryProjection {
	readonly declarations: readonly never[];
	readonly nativeOpaquePositions: readonly NativeServerToolOpaquePosition[];
	readonly replacements: readonly ServerToolHistoryReplacement[];
	readonly envelopeCount: number;
	readonly encryptedInputBytes: number;
}

export interface ProjectServerToolHistoryOptions {
	readonly messages: unknown;
	readonly replayContext: ServerToolHistoryReplayContext;
	readonly decoder: ServerToolHistoryReplayDecoder;
}

type JsonRecord = Record<string, unknown>;

type ServerToolCall = Readonly<{
	messageIndex: number;
	blockIndex: number;
	role: string;
	callId: string;
	query: string;
}>;

type ProjectedSource = Readonly<{
	messageIndex: number;
	blockIndex: number;
	itemIndex: number;
	call: ServerToolCall;
	ordinal: number;
	url: string;
	title: string;
	pageAge: string | null;
	citedText: string;
}>;

type PlannedDecode = Readonly<{
	token: string;
	bindingSnapshot: string;
	binding: ServerToolReplayEnvelopeBinding;
}>;

type LocatedSource = Readonly<{
	source: ProjectedSource;
	bindingSnapshot: string;
}>;

type ReplacementDraft = ServerToolHistoryReplacement & {
	readonly sequence: number;
};

const textEncoder = new TextEncoder();

function invalidProjection(): InvalidServerToolHistoryProjectionError {
	return new InvalidServerToolHistoryProjectionError();
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

function hasForbiddenScalarCodePoint(value: string): boolean {
	return STRUCTURAL_FORBIDDEN_CODE_POINT.test(value);
}

function structuralScalar(value: unknown, maxBytes?: number): string {
	if (
		typeof value !== "string" ||
		hasLoneSurrogate(value) ||
		hasForbiddenScalarCodePoint(value) ||
		(maxBytes !== undefined && utf8ByteLength(value) > maxBytes)
	) {
		throw invalidProjection();
	}
	return value;
}

function visibleScalar(value: unknown, maxBytes: number): string {
	if (
		typeof value !== "string" ||
		hasLoneSurrogate(value) ||
		utf8ByteLength(value) > maxBytes
	) {
		throw invalidProjection();
	}
	return value;
}

function escapeCodeUnits(value: string): string {
	let escaped = "";
	for (let index = 0; index < value.length; index += 1) {
		escaped += `\\u${value.charCodeAt(index).toString(16).padStart(4, "0")}`;
	}
	return escaped;
}

function renderVisibleScalar(value: string): string {
	let rendered = "";
	for (const character of value) {
		if (character === "\\") {
			rendered += "\\\\";
		} else if (hasForbiddenScalarCodePoint(character)) {
			rendered += escapeCodeUnits(character);
		} else {
			rendered += character;
		}
	}
	return rendered;
}

function stringifyProjection(value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) throw invalidProjection();
	return json;
}

function canonicalUrl(value: unknown): string {
	const input = structuralScalar(value, MAX_URL_BYTES);
	if (URL_WHITESPACE.test(input) || input.includes("\\")) {
		throw invalidProjection();
	}

	let parsed: URL;
	let decoded: string;
	try {
		parsed = new URL(input);
		decoded = decodeURI(input);
	} catch {
		throw invalidProjection();
	}

	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.href !== input ||
		URL_WHITESPACE.test(decoded) ||
		decoded.includes("\\")
	) {
		throw invalidProjection();
	}
	structuralScalar(decoded);

	const authority = input.slice(input.indexOf("://") + 3).split(/[/?#]/u, 1)[0];
	if (authority?.includes("@")) throw invalidProjection();
	return input;
}

function proxyToken(value: unknown): string {
	const token = structuralScalar(value);
	if (
		!token.startsWith(SERVER_TOOL_REPLAY_ENVELOPE_PREFIX) ||
		token.length > MAX_TOKEN_CODE_UNITS
	) {
		throw invalidProjection();
	}
	for (let index = 0; index < token.length; index += 1) {
		if (token.charCodeAt(index) > 0x7f) throw invalidProjection();
	}
	return token;
}

function isProxyOpaqueValue(value: string): boolean {
	if (value.startsWith(SERVER_TOOL_REPLAY_ENVELOPE_PREFIX)) return true;
	if (value.startsWith(RESERVED_PROXY_NAMESPACE_PREFIX)) {
		throw invalidProjection();
	}
	return false;
}

function scalarTuple(
	label: "call_id" | "query" | "url" | "title" | "cited_text",
	value: string,
): readonly [typeof label, number, string] {
	const renderedValue =
		label === "query" || label === "title" || label === "cited_text"
			? renderVisibleScalar(value)
			: value;
	return [label, utf8ByteLength(value), renderedValue];
}

function pageAgeTuple(
	value: string | null,
): readonly ["page_age", number, string | null] {
	return [
		"page_age",
		value === null ? 0 : utf8ByteLength(value),
		value === null ? null : renderVisibleScalar(value),
	];
}

function sourceLocatorKey(keyId: string, sourceLocator: string): string {
	return JSON.stringify([keyId, sourceLocator]);
}

function bindingSnapshot(binding: ServerToolReplayEnvelopeBinding): string {
	return JSON.stringify([
		binding.envelopeKind,
		binding.toolType,
		binding.audience,
		binding.lineage,
		binding.callId,
		binding.visibleQuery,
		binding.resultState,
		binding.ordinal,
		binding.linkage,
		binding.visibleEvidence.map((evidence) => [
			evidence.url,
			evidence.title,
			evidence.citedText,
			evidence.pageAge ?? null,
		]),
	]);
}

function frozenBinding(
	replayContext: ServerToolHistoryReplayContext,
	call: ServerToolCall,
	envelopeKind: "source" | "citation",
	ordinal: number,
	linkage: string | null,
	url: string,
	title: string,
	citedText: string,
	pageAge: string | null,
): ServerToolReplayEnvelopeBinding {
	const evidence = Object.freeze({ url, title, citedText, pageAge });
	return Object.freeze({
		envelopeKind,
		toolType: WEB_SEARCH_TOOL_TYPE,
		audience: replayContext.audience,
		lineage: replayContext.lineage,
		callId: call.callId,
		visibleQuery: call.query,
		resultState: "result",
		ordinal,
		linkage,
		visibleEvidence: Object.freeze([evidence]),
	});
}

function buildUseReplacement(
	call: ServerToolCall,
	sequence: number,
): ReplacementDraft {
	return {
		messageIndex: call.messageIndex,
		blockIndex: call.blockIndex,
		role: call.role,
		sourceType: "server_tool_use",
		callId: call.callId,
		text: stringifyProjection([
			UNTRUSTED_HISTORY_REVISION,
			"server_tool_use",
			scalarTuple("call_id", call.callId),
			scalarTuple("query", call.query),
		]),
		sequence,
	};
}

function sourceTuple(source: ProjectedSource): readonly unknown[] {
	return [
		source.ordinal,
		scalarTuple("url", source.url),
		scalarTuple("title", source.title),
		pageAgeTuple(source.pageAge),
		scalarTuple("cited_text", source.citedText),
	];
}

function buildResultReplacement(
	messageIndex: number,
	blockIndex: number,
	role: string,
	callId: string,
	sources: readonly ProjectedSource[],
	sequence: number,
): ReplacementDraft {
	return {
		messageIndex,
		blockIndex,
		role,
		sourceType: "web_search_tool_result",
		callId,
		text: stringifyProjection([
			UNTRUSTED_HISTORY_REVISION,
			"web_search_tool_result",
			scalarTuple("call_id", callId),
			["state", "result"],
			["sources", sources.map(sourceTuple)],
		]),
		sequence,
	};
}

function buildErrorReplacement(
	messageIndex: number,
	blockIndex: number,
	role: string,
	callId: string,
	errorCode: string,
	sequence: number,
): ReplacementDraft {
	return {
		messageIndex,
		blockIndex,
		role,
		sourceType: "web_search_tool_result",
		callId,
		text: stringifyProjection([
			UNTRUSTED_HISTORY_REVISION,
			"web_search_tool_result",
			scalarTuple("call_id", callId),
			["state", "error"],
			["error_code", errorCode],
		]),
		sequence,
	};
}

function buildCitationReplacement(
	messageIndex: number,
	blockIndex: number,
	role: string,
	citationIndex: number,
	source: ProjectedSource,
	citationOrdinal: number,
	citedText: string,
	sequence: number,
): ReplacementDraft {
	return {
		messageIndex,
		blockIndex,
		role,
		sourceType: "web_search_citation",
		callId: source.call.callId,
		citationIndex,
		text: stringifyProjection([
			UNTRUSTED_HISTORY_REVISION,
			"web_search_citation",
			scalarTuple("call_id", source.call.callId),
			["source_ordinal", source.ordinal],
			["citation_ordinal", citationOrdinal],
			scalarTuple("url", source.url),
			scalarTuple("title", source.title),
			pageAgeTuple(source.pageAge),
			scalarTuple("cited_text", citedText),
		]),
		sequence,
	};
}

function compareReplacementSource(
	left: ReplacementDraft,
	right: ReplacementDraft,
): number {
	return (
		left.messageIndex - right.messageIndex ||
		left.blockIndex - right.blockIndex ||
		left.sequence - right.sequence
	);
}

function isExactErrorResult(value: JsonRecord): boolean {
	const keys = Object.keys(value).sort();
	return (
		keys.length === 2 &&
		keys[0] === "error_code" &&
		keys[1] === "type" &&
		value.type === "web_search_tool_result_error" &&
		typeof value.error_code === "string" &&
		SAFE_WEB_SEARCH_ERROR_CODES.has(value.error_code)
	);
}

function isExactProxyCitation(value: JsonRecord): boolean {
	const keys = Object.keys(value).sort();
	return (
		keys.length === 5 &&
		keys[0] === "cited_text" &&
		keys[1] === "encrypted_index" &&
		keys[2] === "title" &&
		keys[3] === "type" &&
		keys[4] === "url" &&
		value.type === "web_search_result_location"
	);
}

export async function projectServerToolHistory({
	messages,
	replayContext,
	decoder,
}: ProjectServerToolHistoryOptions): Promise<ServerToolHistoryProjection> {
	try {
		if (!isRecord(replayContext) || !isRecord(decoder)) {
			throw invalidProjection();
		}
		const audience = structuralScalar(replayContext.audience);
		const lineage = structuralScalar(replayContext.lineage);
		if (typeof decoder.decodeReplayToken !== "function") {
			throw invalidProjection();
		}
		const validatedReplayContext = { audience, lineage };

		const nativeOpaquePositionDrafts: NativeServerToolOpaquePosition[] = [];
		const replacementDrafts: ReplacementDraft[] = [];
		const calls = new Map<string, ServerToolCall>();
		const emittedUses = new Set<string>();
		const plannedDecodes = new Map<string, PlannedDecode>();
		const sourcesPerCall = new Map<string, number>();
		const sourcesByLocatorKey = new Map<string, LocatedSource>();
		const citationOrdinals = new Map<string, number>();
		let totalSources = 0;
		let totalHostedCitations = 0;
		let encryptedInputBytes = 0;
		let finalizedReplacementTextBytes = 0;
		let sequence = 0;
		let citationReplayMode: "proxy" | "native" | null = null;

		const pushReplacementDraft = (draft: ReplacementDraft): void => {
			const nextFinalizedTextBytes =
				finalizedReplacementTextBytes + utf8ByteLength(draft.text);
			if (nextFinalizedTextBytes > MAX_FINALIZED_REPLACEMENT_TEXT_BYTES) {
				throw invalidProjection();
			}
			finalizedReplacementTextBytes = nextFinalizedTextBytes;
			replacementDrafts.push(draft);
		};

		const emitUse = (call: ServerToolCall): void => {
			if (emittedUses.has(call.callId)) return;
			pushReplacementDraft(buildUseReplacement(call, sequence++));
			emittedUses.add(call.callId);
		};

		const addDecode = (
			tokenValue: unknown,
			binding: ServerToolReplayEnvelopeBinding,
		): void => {
			const token = proxyToken(tokenValue);
			const nextInputBytes = encryptedInputBytes + token.length;
			if (nextInputBytes > MAX_AGGREGATE_ENCRYPTED_INPUT_BYTES) {
				throw invalidProjection();
			}
			encryptedInputBytes = nextInputBytes;

			const snapshot = bindingSnapshot(binding);
			const existing = plannedDecodes.get(token);
			if (existing) {
				if (existing.bindingSnapshot !== snapshot) throw invalidProjection();
				return;
			}

			if (plannedDecodes.size + 1 > MAX_UNIQUE_TOKENS) {
				throw invalidProjection();
			}
			plannedDecodes.set(token, {
				token,
				bindingSnapshot: snapshot,
				binding,
			});
		};

		if (Array.isArray(messages)) {
			for (
				let messageIndex = 0;
				messageIndex < messages.length;
				messageIndex += 1
			) {
				const message = messages[messageIndex];
				if (!isRecord(message) || !Array.isArray(message.content)) continue;
				const role =
					typeof message.role === "string"
						? structuralScalar(message.role)
						: undefined;

				for (
					let blockIndex = 0;
					blockIndex < message.content.length;
					blockIndex += 1
				) {
					const block = message.content[blockIndex];
					if (!isRecord(block)) continue;
					if (
						(block.type === "server_tool_use" ||
							block.type === "web_search_tool_result") &&
						role !== "assistant"
					) {
						throw invalidProjection();
					}

					if (block.type === "server_tool_use" && block.name === "web_search") {
						if (role !== "assistant" || !isRecord(block.input)) {
							throw invalidProjection();
						}
						const callId = structuralScalar(block.id, MAX_CALL_ID_BYTES);
						const query = visibleScalar(block.input.query, MAX_QUERY_BYTES);
						if (calls.has(callId)) throw invalidProjection();
						calls.set(callId, {
							messageIndex,
							blockIndex,
							role,
							callId,
							query,
						});
					}

					if (block.type === "web_search_tool_result") {
						const content = block.content;

						if (Array.isArray(content)) {
							const callId = structuralScalar(
								block.tool_use_id,
								MAX_CALL_ID_BYTES,
							);
							const callSourceCount =
								(sourcesPerCall.get(callId) ?? 0) + content.length;
							totalSources += content.length;
							if (
								callSourceCount > MAX_SOURCES_PER_CALL ||
								totalSources > MAX_SOURCES_PER_RESPONSE
							) {
								throw invalidProjection();
							}
							sourcesPerCall.set(callId, callSourceCount);

							if (content.length === 0) {
								if (role !== "assistant") throw invalidProjection();
								const call = calls.get(callId);
								if (!call) throw invalidProjection();
								emitUse(call);
								pushReplacementDraft(
									buildResultReplacement(
										messageIndex,
										blockIndex,
										role,
										callId,
										[],
										sequence++,
									),
								);
							} else {
								let replayMode: "proxy" | "native" | null = null;
								for (const item of content) {
									if (
										!isRecord(item) ||
										item.type !== "web_search_result" ||
										typeof item.encrypted_content !== "string"
									) {
										throw invalidProjection();
									}
									const itemMode = isProxyOpaqueValue(item.encrypted_content)
										? "proxy"
										: "native";
									if (replayMode !== null && replayMode !== itemMode) {
										throw invalidProjection();
									}
									replayMode = itemMode;
								}

								if (replayMode === "native") {
									if (role !== undefined) {
										for (
											let itemIndex = 0;
											itemIndex < content.length;
											itemIndex += 1
										) {
											nativeOpaquePositionDrafts.push({
												messageIndex,
												blockIndex,
												role,
												sourceType: "web_search_result",
												itemIndex,
												field: "encrypted_content",
											});
										}
									}
								} else if (replayMode === "proxy") {
									if (role !== "assistant") throw invalidProjection();
									const call = calls.get(callId);
									if (!call) throw invalidProjection();
									const projectedSources: ProjectedSource[] = [];
									let previousSourceOrdinal: number | null = null;

									for (
										let itemIndex = 0;
										itemIndex < content.length;
										itemIndex += 1
									) {
										const item = content[itemIndex];
										if (!isRecord(item)) throw invalidProjection();
										const url = canonicalUrl(item.url);
										const title = visibleScalar(item.title, MAX_TITLE_BYTES);
										const pageAge =
											item.page_age === undefined || item.page_age === null
												? null
												: visibleScalar(item.page_age, MAX_PAGE_AGE_BYTES);
										const source: ProjectedSource = {
											messageIndex,
											blockIndex,
											itemIndex,
											call,
											ordinal: itemIndex,
											url,
											title,
											pageAge,
											citedText: "",
										};
										const binding = frozenBinding(
											validatedReplayContext,
											call,
											"source",
											itemIndex,
											previousSourceOrdinal === null
												? null
												: String(previousSourceOrdinal),
											url,
											title,
											"",
											pageAge,
										);
										const token = proxyToken(item.encrypted_content);
										const header = inspectServerToolReplayEnvelopeHeader(token);
										const locatorKey = sourceLocatorKey(
											header.keyId,
											header.sourceLocator,
										);
										const snapshot = bindingSnapshot(binding);
										const locatedSource = sourcesByLocatorKey.get(locatorKey);
										if (
											locatedSource !== undefined &&
											locatedSource.bindingSnapshot !== snapshot
										) {
											throw invalidProjection();
										}
										addDecode(token, binding);
										if (locatedSource === undefined) {
											sourcesByLocatorKey.set(locatorKey, {
												source,
												bindingSnapshot: snapshot,
											});
										}
										projectedSources.push(source);
										previousSourceOrdinal = itemIndex;
									}

									emitUse(call);
									pushReplacementDraft(
										buildResultReplacement(
											messageIndex,
											blockIndex,
											role,
											callId,
											projectedSources,
											sequence++,
										),
									);
								}
							}
						} else if (isRecord(content) && isExactErrorResult(content)) {
							if (role !== "assistant") throw invalidProjection();
							const callId = structuralScalar(
								block.tool_use_id,
								MAX_CALL_ID_BYTES,
							);
							const call = calls.get(callId);
							if (!call || typeof content.error_code !== "string") {
								throw invalidProjection();
							}
							emitUse(call);
							pushReplacementDraft(
								buildErrorReplacement(
									messageIndex,
									blockIndex,
									role,
									callId,
									content.error_code,
									sequence++,
								),
							);
						} else {
							throw invalidProjection();
						}
					}

					if (Array.isArray(block.citations)) {
						const hostedCitations: Array<{
							citationIndex: number;
							citation: JsonRecord;
							mode: "proxy" | "native";
						}> = [];
						for (
							let citationIndex = 0;
							citationIndex < block.citations.length;
							citationIndex += 1
						) {
							const citation = block.citations[citationIndex];
							if (
								!isRecord(citation) ||
								citation.type !== "web_search_result_location"
							) {
								continue;
							}
							totalHostedCitations += 1;
							if (totalHostedCitations > MAX_CITATIONS_PER_RESPONSE) {
								throw invalidProjection();
							}
							if (typeof citation.encrypted_index !== "string") {
								throw invalidProjection();
							}
							const mode = isProxyOpaqueValue(citation.encrypted_index)
								? "proxy"
								: "native";
							if (citationReplayMode !== null && citationReplayMode !== mode) {
								throw invalidProjection();
							}
							citationReplayMode = mode;
							hostedCitations.push({
								citationIndex,
								citation,
								mode,
							});
						}

						if (hostedCitations.length > 0 && role !== "assistant") {
							throw invalidProjection();
						}
						const hasProxyCitation = hostedCitations.some(
							({ mode }) => mode === "proxy",
						);
						const hasNativeCitation = hostedCitations.some(
							({ mode }) => mode === "native",
						);
						if (hasProxyCitation && hasNativeCitation) {
							throw invalidProjection();
						}

						if (hasProxyCitation) {
							if (
								role !== "assistant" ||
								block.type !== "text" ||
								typeof block.text !== "string"
							) {
								throw invalidProjection();
							}

							for (const { citationIndex, citation } of hostedCitations) {
								if (!isExactProxyCitation(citation)) {
									throw invalidProjection();
								}
								const url = canonicalUrl(citation.url);
								const title = visibleScalar(citation.title, MAX_TITLE_BYTES);
								const citedText = visibleScalar(
									citation.cited_text,
									MAX_CITED_TEXT_BYTES,
								);
								const token = proxyToken(citation.encrypted_index);
								const header = inspectServerToolReplayEnvelopeHeader(token);
								const locatorKey = sourceLocatorKey(
									header.keyId,
									header.sourceLocator,
								);
								const locatedSource = sourcesByLocatorKey.get(locatorKey);
								if (!locatedSource) throw invalidProjection();
								const source = locatedSource.source;

								const citationOrdinal = citationOrdinals.get(locatorKey) ?? 0;
								citationOrdinals.set(locatorKey, citationOrdinal + 1);
								const binding = frozenBinding(
									validatedReplayContext,
									source.call,
									"citation",
									source.ordinal,
									`citation:${citationOrdinal}`,
									url,
									title,
									citedText,
									source.pageAge,
								);
								addDecode(token, binding);
								emitUse(source.call);
								pushReplacementDraft(
									buildCitationReplacement(
										messageIndex,
										blockIndex,
										role,
										citationIndex,
										source,
										citationOrdinal,
										citedText,
										sequence++,
									),
								);
							}
						} else if (hasNativeCitation && role !== undefined) {
							for (const { citationIndex } of hostedCitations) {
								nativeOpaquePositionDrafts.push({
									messageIndex,
									blockIndex,
									role,
									sourceType: "citation",
									itemIndex: citationIndex,
									field: "encrypted_index",
								});
							}
						}
					}
				}
			}
		}

		await Promise.all(
			[...plannedDecodes.values()].map(({ token, binding }) =>
				decoder.decodeReplayToken(token, binding),
			),
		);

		replacementDrafts.sort(compareReplacementSource);
		const nativeOpaquePositions = nativeOpaquePositionDrafts.map((position) =>
			Object.freeze({ ...position }),
		);
		const replacements = replacementDrafts.map(
			({ sequence: _sequence, ...replacement }) => Object.freeze(replacement),
		);

		return Object.freeze({
			declarations: Object.freeze([]),
			nativeOpaquePositions: Object.freeze(nativeOpaquePositions),
			replacements: Object.freeze(replacements),
			envelopeCount: plannedDecodes.size,
			encryptedInputBytes,
		});
	} catch {
		throw invalidProjection();
	}
}
