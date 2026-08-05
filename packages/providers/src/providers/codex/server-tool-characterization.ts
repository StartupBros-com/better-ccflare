export const CHARACTERIZATION_LIMITS = Object.freeze({
	maxDepth: 8,
	maxNodes: 256,
	// One consumed input node can expand to a container plus one fixed
	// three-field truncation marker in the sanitized JSON tree.
	maxSnapshotNodes: 1_280,
	maxArrayItems: 64,
	maxArrayInspectionItems: 256,
	maxObjectKeys: 64,
	maxKeyUtf16CodeUnits: 128,
	maxKeyUtf8Bytes: 256,
	maxStringUtf16CodeUnits: 4_096,
	maxStringUtf8Bytes: 4_096,
	maxAliases: 256,
	maxIgnoredSymbols: 16,
});

export type ServerToolCharacterizationKind =
	| "outbound_request"
	| "response_metadata"
	| "upstream_event";

export interface ServerToolCharacterizationStringMetadata {
	readonly type: "string";
	readonly utf8_bytes: number;
}

export interface ServerToolCharacterizationPrimitiveMetadata {
	readonly type: "boolean" | "null" | "number";
}

export type ServerToolCharacterizationTruncationReason =
	| "max_array_items"
	| "max_depth"
	| "max_nodes"
	| "max_object_keys"
	| "max_string_utf16_code_units"
	| "max_string_utf8_bytes";

export interface ServerToolCharacterizationTruncationMetadata {
	readonly type: "truncated";
	readonly reason: ServerToolCharacterizationTruncationReason;
	readonly observed: number;
}

export type ServerToolCharacterizationValue =
	| null
	| boolean
	| number
	| string
	| ServerToolCharacterizationPrimitiveMetadata
	| ServerToolCharacterizationStringMetadata
	| ServerToolCharacterizationTruncationMetadata
	| readonly ServerToolCharacterizationValue[]
	| {
			readonly [key: string]: ServerToolCharacterizationValue;
	  };

export interface ServerToolCharacterizationRecord {
	readonly kind: ServerToolCharacterizationKind;
	readonly data: Readonly<Record<string, ServerToolCharacterizationValue>>;
}

export type ServerToolCharacterizationObserver = (
	record: ServerToolCharacterizationRecord,
) => void;

export interface ServerToolCharacterizationContextOptions {
	readonly ignoredSymbols?: readonly symbol[];
}

export interface ServerToolCharacterizationSanitizer {
	sanitize(
		kind: ServerToolCharacterizationKind,
		input: unknown,
	): ServerToolCharacterizationRecord | null;
	canonicalize(record: ServerToolCharacterizationRecord): string | null;
	emit(
		observer: ServerToolCharacterizationObserver,
		kind: ServerToolCharacterizationKind,
		input: unknown,
	): void;
}

export type ServerToolCharacterizationContext =
	ServerToolCharacterizationSanitizer;

const CHARACTERIZATION_KINDS = new Set<ServerToolCharacterizationKind>([
	"outbound_request",
	"response_metadata",
	"upstream_event",
]);
const textEncoder = new TextEncoder();
const AUTHENTIC_RECORDS = new WeakSet<ServerToolCharacterizationRecord>();
const AUTHENTIC_METADATA = new WeakSet<object>();

const SAFE_TOKEN_COUNT_KEYS = new Set([
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
	"cache_write_tokens",
	"cached_input_tokens",
	"cached_tokens",
	"input_tokens",
	"max_output_tokens",
	"output_tokens",
	"reasoning_tokens",
	"total_tokens",
]);

const SAFE_USAGE_DETAIL_KEYS = new Set([
	"input_tokens_details",
	"output_tokens_details",
]);

const SAFE_NUMBER_KEYS = new Set([
	"content_index",
	"index",
	"max_uses",
	"output_index",
	"sequence_number",
	"utf8_bytes",
	...SAFE_TOKEN_COUNT_KEYS,
]);

const SAFE_BOOLEAN_KEYS = new Set([
	"additionalProperties",
	"body_present",
	"ok",
	"parallel_tool_calls",
	"requested_stream",
	"store",
	"stream",
	"turn_state_present",
]);

const CONTENT_TYPE_CLASSES = new Set([
	"event_stream",
	"json",
	"missing",
	"other",
]);

const STATUS_ENUMS = new Set([
	"canceled",
	"cancelled",
	"completed",
	"failed",
	"in_progress",
	"incomplete",
	"queued",
	"requires_action",
	"searching",
	"supported",
	"unknown",
	"unsupported",
]);

const ROLE_ENUMS = new Set([
	"assistant",
	"developer",
	"system",
	"tool",
	"user",
]);

const JSON_SCHEMA_TYPES = new Set([
	"array",
	"boolean",
	"integer",
	"null",
	"number",
	"object",
	"string",
]);

const ARRAY_ITEM_PATH_SEGMENT = Symbol("array-item-path-segment");
type CharacterizationPathSegment = string | typeof ARRAY_ITEM_PATH_SEGMENT;

const OUTBOUND_NATIVE_TOOL_TYPES = new Set(["function", "web_search"]);
const OUTBOUND_NATIVE_INCLUDE_TOKENS = new Set([
	"web_search_call.action.sources",
]);
const OUTBOUND_NATIVE_LOCATION_KEYS = new Set([
	"city",
	"country",
	"region",
	"timezone",
	"type",
]);
const OUTBOUND_NATIVE_LOCATION_TYPES = new Set(["approximate"]);

const RESPONSES_STREAM_EVENT_NAMES = new Set([
	"error",
	"response.completed",
	"response.content_part.added",
	"response.content_part.done",
	"response.created",
	"response.failed",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.in_progress",
	"response.incomplete",
	"response.output_item.added",
	"response.output_item.done",
	"response.output_text.annotation.added",
	"response.output_text.delta",
	"response.output_text.done",
	"response.queued",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_part.done",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_text.delta",
	"response.reasoning_text.done",
	"response.web_search_call.completed",
	"response.web_search_call.in_progress",
	"response.web_search_call.searching",
]);
const UPSTREAM_ROOT_TYPE_VALUES = new Set([
	"message",
	...RESPONSES_STREAM_EVENT_NAMES,
]);

const PROTOCOL_LABEL_MODES = new Set<StringMode>([
	"content_type_class",
	"event",
	"model",
	"protocol_enum",
	"role",
	"status",
	"tool_kind",
	"type",
]);

const SAFE_PROTOCOL_VALUES_BY_LOCATION = new Map<string, ReadonlySet<string>>([
	["outbound_request:event:event", new Set(["response.created"])],
	["outbound_request:model:model", new Set(["gpt-5-codex"])],
	[
		"outbound_request:reasoning.effort:protocol_enum",
		new Set(["high", "low", "medium", "minimal", "none", "xhigh"]),
	],
	[
		"outbound_request:reasoning.summary:protocol_enum",
		new Set(["auto", "concise", "detailed", "none"]),
	],
	["outbound_request:role:role", new Set(["user"])],
	["outbound_request:status:status", new Set(["completed"])],
	["outbound_request:tool_choice.type:type", new Set(["function"])],
	["outbound_request:tool_kind:tool_kind", new Set(["web_search"])],
	["outbound_request:type:type", new Set(["message", "object"])],
	["outbound_request:input.*.content.*.type:type", new Set(["input_text"])],
	["outbound_request:input.*.role:role", ROLE_ENUMS],
	[
		"outbound_request:input.*.type:type",
		new Set(["function_call", "function_call_output", "message", "reasoning"]),
	],
	[
		"response_metadata:content_type_class:content_type_class",
		CONTENT_TYPE_CLASSES,
	],
	["upstream_event:event:event", RESPONSES_STREAM_EVENT_NAMES],
	["upstream_event:item.type:type", new Set(["web_search_call"])],
	["upstream_event:tool_kind:tool_kind", new Set(["web_search"])],
	["upstream_event:type:type", UPSTREAM_ROOT_TYPE_VALUES],
	["upstream_event:data.item.type:type", new Set(["web_search_call"])],
	["upstream_event:data.response.model:model", new Set(["gpt-5.4"])],
	["upstream_event:data.response.status:status", STATUS_ENUMS],
	["upstream_event:data.tool_kind:tool_kind", new Set(["web_search"])],
	["upstream_event:data.type:type", RESPONSES_STREAM_EVENT_NAMES],
	["upstream_event:status:status", STATUS_ENUMS],
]);

const PROTOCOL_KEYS = new Set([
	"$defs",
	"$ref",
	"additionalProperties",
	"arguments",
	"body",
	"body_present",
	"call_id",
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
	"cache_write_tokens",
	"cached_input_tokens",
	"cached_tokens",
	"code",
	"content",
	"content_index",
	"content_type_class",
	"created_at",
	"data",
	"delta",
	"description",
	"effort",
	"error",
	"event",
	"finish_reason",
	"format",
	"id",
	"include",
	"index",
	"input",
	"input_tokens",
	"input_tokens_details",
	"instructions",
	"item",
	"item_id",
	"items",
	"kind",
	"max_output_tokens",
	"max_uses",
	"message",
	"model",
	"name",
	"object",
	"ok",
	"other_name",
	"output",
	"output_index",
	"output_tokens",
	"output_tokens_details",
	"parallel_tool_calls",
	"parameters",
	"previous_response_id",
	"prompt",
	"prompt_cache_key",
	"properties",
	"query",
	"reasoning",
	"reasoning_tokens",
	"related_id",
	"required",
	"requested_stream",
	"response",
	"role",
	"sequence_number",
	"source",
	"source_url",
	"sources",
	"status",
	"store",
	"stream",
	"summary",
	"text",
	"title",
	"truncated",
	"tool",
	"tool_choice",
	"tool_kind",
	"tools",
	"total_tokens",
	"type",
	"turn_state_present",
	"usage",
	"url",
	"urls",
	"utf8_bytes",
]);

type StringMode =
	| "boolean"
	| "content"
	| "content_type_class"
	| "event"
	| "identifier"
	| "max_tool_calls"
	| "model"
	| "name"
	| "number"
	| "object"
	| "opaque_string"
	| "protocol_enum"
	| "role"
	| "schema_key"
	| "schema_properties"
	| "schema_ref"
	| "status"
	| "tool_kind"
	| "type"
	| "url";

interface SanitizeState {
	nodes: number;
	readonly active: Set<object>;
	readonly aliases: AliasContext;
	readonly ignoredSymbols: ReadonlySet<symbol>;
	readonly kind: ServerToolCharacterizationKind;
}

interface AliasContext {
	readonly identifiers: Map<string, string>;
	readonly labels: Map<string, string>;
	readonly toolNames: Map<string, string>;
	readonly urls: Map<string, string>;
	readonly fields: Map<string, string>;
}

function keyTokens(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[._-]+/)
		.filter(Boolean);
}

function isForbiddenKey(key: string): boolean {
	if (
		key === "turn_state_present" ||
		SAFE_TOKEN_COUNT_KEYS.has(key) ||
		SAFE_USAGE_DETAIL_KEYS.has(key)
	) {
		return false;
	}
	const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
	const tokens = keyTokens(key);
	if (
		compact === "apikey" ||
		compact === "turnstate" ||
		compact === "setcookie"
	) {
		return true;
	}
	if (
		tokens.some((token) =>
			[
				"auth",
				"authenticated",
				"authentication",
				"authorization",
				"ciphertext",
				"cookie",
				"cookies",
				"correlation",
				"credential",
				"credentials",
				"key",
				"nonce",
				"oauth",
				"password",
				"replay",
				"secret",
				"token",
				"tokens",
			].includes(token),
		)
	) {
		return true;
	}
	return tokens.some(
		(token, index) => token === "turn" && tokens[index + 1] === "state",
	);
}

function stringModeForKey(key: string): StringMode {
	const normalized = key.replace(/[.-]/g, "_").toLowerCase();
	const tokens = keyTokens(key);
	const finalToken = tokens.at(-1);
	if (key === "$ref") return "schema_ref";
	if (key === "$defs") return "schema_properties";
	if (normalized === "event") return "event";
	if (normalized === "type") return "type";
	if (normalized === "status") return "status";
	if (normalized === "role") return "role";
	if (normalized === "model") return "model";
	if (normalized === "content_type_class") return "content_type_class";
	if (normalized === "prompt_cache_key") return "opaque_string";
	if (SAFE_USAGE_DETAIL_KEYS.has(normalized)) return "object";
	if (SAFE_BOOLEAN_KEYS.has(key) || SAFE_BOOLEAN_KEYS.has(normalized)) {
		return "boolean";
	}
	if (SAFE_NUMBER_KEYS.has(normalized)) return "number";
	if (normalized === "effort" || normalized === "summary") {
		return "protocol_enum";
	}
	if (
		normalized === "kind" ||
		normalized === "tool_kind" ||
		normalized === "toolkind"
	) {
		return "tool_kind";
	}
	if (
		finalToken === "id" ||
		finalToken === "ids" ||
		finalToken === "identifier" ||
		finalToken === "identifiers"
	) {
		return "identifier";
	}
	if (finalToken === "name") return "name";
	if (finalToken === "url" || finalToken === "uri" || finalToken === "href") {
		return "url";
	}
	if (normalized === "required") return "schema_key";
	if (normalized === "properties") return "schema_properties";
	return "content";
}

function isRootOutboundPromptCacheKey(
	kind: ServerToolCharacterizationKind,
	depth: number,
	key: string,
): boolean {
	return (
		kind === "outbound_request" && depth === 0 && key === "prompt_cache_key"
	);
}

function aliasCount(aliases: AliasContext): number {
	return (
		aliases.identifiers.size +
		aliases.labels.size +
		aliases.toolNames.size +
		aliases.urls.size +
		aliases.fields.size
	);
}

function alias(
	allAliases: AliasContext,
	aliases: Map<string, string>,
	value: string,
	prefix: "field" | "id" | "label" | "tool" | "source",
): string | undefined {
	const existing = aliases.get(value);
	if (existing !== undefined) return existing;
	if (aliasCount(allAliases) >= CHARACTERIZATION_LIMITS.maxAliases) {
		return undefined;
	}
	const next = `${prefix}-${aliases.size + 1}`;
	aliases.set(value, next);
	return next;
}

function normalizedPath(path: readonly CharacterizationPathSegment[]): string {
	return path
		.map((segment) => (segment === ARRAY_ITEM_PATH_SEGMENT ? "*" : segment))
		.join(".");
}

function pathEquals(
	path: readonly CharacterizationPathSegment[],
	expected: readonly CharacterizationPathSegment[],
): boolean {
	return (
		path.length === expected.length &&
		path.every((segment, index) => segment === expected[index])
	);
}

function isOutboundNativeOptionKey(
	kind: ServerToolCharacterizationKind,
	path: readonly CharacterizationPathSegment[],
	key: string,
): boolean {
	if (kind !== "outbound_request") return false;
	if (path.length === 0) return key === "max_tool_calls";
	if (pathEquals(path, ["tools", ARRAY_ITEM_PATH_SEGMENT])) {
		return key === "filters" || key === "user_location";
	}
	if (pathEquals(path, ["tools", ARRAY_ITEM_PATH_SEGMENT, "filters"])) {
		return key === "allowed_domains" || key === "blocked_domains";
	}
	if (pathEquals(path, ["tools", ARRAY_ITEM_PATH_SEGMENT, "user_location"])) {
		return OUTBOUND_NATIVE_LOCATION_KEYS.has(key);
	}
	return false;
}

function stringModeForLocation(
	kind: ServerToolCharacterizationKind,
	path: readonly CharacterizationPathSegment[],
	key: string,
): StringMode {
	if (
		kind === "outbound_request" &&
		key === "max_tool_calls" &&
		path.length === 0
	) {
		return "max_tool_calls";
	}
	return stringModeForKey(key);
}

function isSchemaTypePath(
	kind: ServerToolCharacterizationKind,
	path: readonly CharacterizationPathSegment[],
): boolean {
	return (
		kind === "outbound_request" &&
		path.at(-1) === "type" &&
		(path.includes("$defs") ||
			path.includes("parameters") ||
			path.includes("properties"))
	);
}

function safeProtocolValues(
	kind: ServerToolCharacterizationKind,
	path: readonly CharacterizationPathSegment[],
	mode: StringMode,
): ReadonlySet<string> | undefined {
	if (
		kind === "outbound_request" &&
		mode === "type" &&
		pathEquals(path, ["tools", ARRAY_ITEM_PATH_SEGMENT, "type"])
	) {
		return OUTBOUND_NATIVE_TOOL_TYPES;
	}
	if (
		kind === "outbound_request" &&
		mode === "content" &&
		pathEquals(path, ["include", ARRAY_ITEM_PATH_SEGMENT])
	) {
		return OUTBOUND_NATIVE_INCLUDE_TOKENS;
	}
	if (
		kind === "outbound_request" &&
		mode === "type" &&
		pathEquals(path, [
			"tools",
			ARRAY_ITEM_PATH_SEGMENT,
			"user_location",
			"type",
		])
	) {
		return OUTBOUND_NATIVE_LOCATION_TYPES;
	}
	if (mode === "type" && isSchemaTypePath(kind, path)) {
		return JSON_SCHEMA_TYPES;
	}
	return SAFE_PROTOCOL_VALUES_BY_LOCATION.get(
		`${kind}:${normalizedPath(path)}:${mode}`,
	);
}

function isPrototypePollutionKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isBoundedRawKey(key: string): boolean {
	if (
		key.length === 0 ||
		key.length > CHARACTERIZATION_LIMITS.maxKeyUtf16CodeUnits
	) {
		return false;
	}
	return (
		textEncoder.encode(key).byteLength <=
		CHARACTERIZATION_LIMITS.maxKeyUtf8Bytes
	);
}

function looksLikeHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function sanitizeUrl(value: string, state: SanitizeState): string | null {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return null;
		const source = alias(state.aliases, state.aliases.urls, value, "source");
		return source === undefined ? null : `https://${source}.example/`;
	} catch {
		return null;
	}
}

function freezeMetadata<T extends object>(value: T): Readonly<T> {
	const frozen = Object.freeze(value);
	AUTHENTIC_METADATA.add(frozen);
	return frozen;
}

function truncationMetadata(
	reason: ServerToolCharacterizationTruncationReason,
	observed: number,
): ServerToolCharacterizationTruncationMetadata {
	return freezeMetadata({ type: "truncated" as const, reason, observed });
}

function isTruncationWithReason(
	value: ServerToolCharacterizationValue,
	reason: ServerToolCharacterizationTruncationReason,
): value is ServerToolCharacterizationTruncationMetadata {
	return (
		value !== null &&
		typeof value === "object" &&
		AUTHENTIC_METADATA.has(value) &&
		"reason" in value &&
		value.reason === reason
	);
}

function stringMetadata(
	utf8Bytes: number,
): ServerToolCharacterizationStringMetadata {
	return freezeMetadata({ type: "string" as const, utf8_bytes: utf8Bytes });
}

function sanitizeString(
	value: string,
	mode: StringMode,
	state: SanitizeState,
	path: readonly CharacterizationPathSegment[],
): ServerToolCharacterizationValue | undefined {
	if (value.length > CHARACTERIZATION_LIMITS.maxStringUtf16CodeUnits) {
		return truncationMetadata("max_string_utf16_code_units", value.length);
	}
	const utf8Bytes = textEncoder.encode(value).byteLength;
	if (utf8Bytes > CHARACTERIZATION_LIMITS.maxStringUtf8Bytes) {
		return truncationMetadata("max_string_utf8_bytes", utf8Bytes);
	}
	if (safeProtocolValues(state.kind, path, mode)?.has(value)) return value;
	if (mode === "url") return sanitizeUrl(value, state) ?? undefined;
	if (mode === "identifier") {
		if (value.length === 0) return undefined;
		return alias(
			state.aliases,
			state.aliases.identifiers,
			`string:${value}`,
			"id",
		);
	}
	if (mode === "name") {
		if (value.length === 0) return undefined;
		return alias(state.aliases, state.aliases.toolNames, value, "tool");
	}
	if (mode === "schema_key") {
		return alias(state.aliases, state.aliases.fields, value, "field");
	}
	if (PROTOCOL_LABEL_MODES.has(mode)) {
		return alias(
			state.aliases,
			state.aliases.labels,
			`${state.kind}:${normalizedPath(path)}:${mode}:${value}`,
			"label",
		);
	}
	if (mode === "schema_ref" || mode === "opaque_string") {
		return stringMetadata(utf8Bytes);
	}
	if (mode !== "content") return undefined;
	if (looksLikeHttpUrl(value)) {
		return sanitizeUrl(value, state) ?? stringMetadata(utf8Bytes);
	}
	return stringMetadata(utf8Bytes);
}

function primitiveMetadata(
	type: ServerToolCharacterizationPrimitiveMetadata["type"],
): ServerToolCharacterizationPrimitiveMetadata {
	return freezeMetadata({ type });
}

function sanitizeNumber(
	value: number,
	mode: StringMode,
	state: SanitizeState,
): ServerToolCharacterizationValue | undefined {
	if (!Number.isFinite(value)) return undefined;
	if (mode === "identifier") {
		if (!Number.isSafeInteger(value) || value < 0) return undefined;
		return alias(
			state.aliases,
			state.aliases.identifiers,
			`number:${value}`,
			"id",
		);
	}
	if (mode === "status") {
		return Number.isSafeInteger(value) && value >= 100 && value <= 599
			? value
			: undefined;
	}
	if (mode === "max_tool_calls") {
		return Number.isSafeInteger(value) && value >= 1 && value <= 8
			? value
			: undefined;
	}
	if (mode === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	}
	if (mode !== "content") return undefined;
	return primitiveMetadata("number");
}

function sanitizeBoolean(
	value: boolean,
	mode: StringMode,
): ServerToolCharacterizationValue | undefined {
	if (mode === "boolean") return value;
	if (mode !== "content") return undefined;
	return primitiveMetadata("boolean");
}

function sanitizeNull(
	mode: StringMode,
): ServerToolCharacterizationValue | undefined {
	return mode === "content" ? primitiveMetadata("null") : undefined;
}

function isConfiguredNonWireSymbol(
	input: object,
	key: symbol,
	state: SanitizeState,
): boolean {
	if (!state.ignoredSymbols.has(key)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	return Boolean(descriptor && !descriptor.enumerable && "value" in descriptor);
}

function sanitizeArray(
	input: unknown[],
	mode: StringMode,
	depth: number,
	state: SanitizeState,
	path: readonly CharacterizationPathSegment[],
): readonly ServerToolCharacterizationValue[] | undefined {
	if (input.length > CHARACTERIZATION_LIMITS.maxArrayInspectionItems) {
		return undefined;
	}
	const ownKeys = Reflect.ownKeys(input);
	let indexedKeys = 0;
	if (
		ownKeys.some((key) => {
			if (typeof key === "symbol") {
				return !isConfiguredNonWireSymbol(input, key, state);
			}
			if (key === "length") return false;
			if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return true;
			if (Number(key) >= input.length) return true;
			indexedKeys++;
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			return !descriptor || !("value" in descriptor);
		})
	) {
		return undefined;
	}
	if (indexedKeys !== input.length) return undefined;
	const result: ServerToolCharacterizationValue[] = [];
	const isArrayTruncated = input.length > CHARACTERIZATION_LIMITS.maxArrayItems;
	const retainedItems = isArrayTruncated
		? CHARACTERIZATION_LIMITS.maxArrayItems - 1
		: input.length;
	for (let index = 0; index < retainedItems; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
		if (!descriptor || !("value" in descriptor)) return undefined;
		const sanitized = sanitizeValue(descriptor.value, mode, depth + 1, state, [
			...path,
			ARRAY_ITEM_PATH_SEGMENT,
		]);
		if (sanitized === undefined) return undefined;
		result.push(sanitized);
		if (
			isTruncationWithReason(sanitized, "max_depth") ||
			isTruncationWithReason(sanitized, "max_nodes")
		) {
			return Object.freeze(result);
		}
	}
	if (isArrayTruncated) {
		result.push(truncationMetadata("max_array_items", input.length));
	}
	return Object.freeze(result);
}

function sanitizeKey(
	key: string,
	state: SanitizeState,
	path: readonly CharacterizationPathSegment[],
	aliasEveryKey: boolean,
): string | undefined {
	if (
		!aliasEveryKey &&
		(PROTOCOL_KEYS.has(key) || isOutboundNativeOptionKey(state.kind, path, key))
	) {
		return key;
	}
	return alias(state.aliases, state.aliases.fields, key, "field");
}

function sanitizeObject(
	input: object,
	depth: number,
	state: SanitizeState,
	path: readonly CharacterizationPathSegment[],
	aliasEveryKey = false,
): Readonly<Record<string, ServerToolCharacterizationValue>> | undefined {
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (state.active.has(input)) return undefined;
	state.active.add(input);
	try {
		const ownKeys = Reflect.ownKeys(input);
		if (
			ownKeys.some(
				(key) =>
					typeof key === "symbol" &&
					!isConfiguredNonWireSymbol(input, key, state),
			)
		) {
			return undefined;
		}
		const keys = ownKeys
			.filter((key): key is string => typeof key === "string")
			.sort();
		for (const key of keys) {
			const isAllowedPromptCacheKey = isRootOutboundPromptCacheKey(
				state.kind,
				depth,
				key,
			);
			if (
				!isBoundedRawKey(key) ||
				isPrototypePollutionKey(key) ||
				(isForbiddenKey(key) && !isAllowedPromptCacheKey)
			) {
				return undefined;
			}
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
				return undefined;
			}
		}
		if (keys.length > CHARACTERIZATION_LIMITS.maxObjectKeys) {
			return Object.freeze({
				truncated: truncationMetadata("max_object_keys", keys.length),
			});
		}
		const output: Record<string, ServerToolCharacterizationValue> = {};
		for (const key of keys) {
			const outputKey = sanitizeKey(key, state, path, aliasEveryKey);
			if (outputKey === undefined || outputKey in output) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			if (!descriptor || !("value" in descriptor)) return undefined;
			const mode = stringModeForLocation(state.kind, path, key);
			const sanitized = sanitizeValue(
				descriptor.value,
				mode,
				depth + 1,
				state,
				[...path, aliasEveryKey ? "*" : key],
			);
			if (sanitized === undefined) return undefined;
			output[outputKey] = sanitized;
			if (
				isTruncationWithReason(sanitized, "max_depth") ||
				isTruncationWithReason(sanitized, "max_nodes")
			) {
				break;
			}
		}
		return Object.freeze(output);
	} finally {
		state.active.delete(input);
	}
}

function sanitizeValue(
	input: unknown,
	mode: StringMode,
	depth: number,
	state: SanitizeState,
	path: readonly CharacterizationPathSegment[],
): ServerToolCharacterizationValue | undefined {
	if (depth > CHARACTERIZATION_LIMITS.maxDepth) {
		return truncationMetadata("max_depth", depth);
	}
	if (
		depth === CHARACTERIZATION_LIMITS.maxDepth &&
		input !== null &&
		typeof input === "object"
	) {
		return truncationMetadata("max_depth", depth);
	}
	if (state.nodes >= CHARACTERIZATION_LIMITS.maxNodes) {
		return truncationMetadata("max_nodes", state.nodes + 1);
	}
	state.nodes++;
	if (mode === "opaque_string" && typeof input !== "string") return undefined;
	if (mode === "max_tool_calls" && typeof input !== "number") return undefined;
	if (
		mode === "object" &&
		(input === null || typeof input !== "object" || Array.isArray(input))
	) {
		return undefined;
	}
	if (input === null) return sanitizeNull(mode);
	if (typeof input === "boolean") return sanitizeBoolean(input, mode);
	if (typeof input === "number") return sanitizeNumber(input, mode, state);
	if (typeof input === "string") {
		return sanitizeString(input, mode, state, path);
	}
	if (typeof input !== "object") return undefined;
	if (Array.isArray(input)) {
		return sanitizeArray(input, mode, depth, state, path);
	}
	return sanitizeObject(
		input,
		depth,
		state,
		path,
		mode === "schema_properties",
	);
}

function createAliasContext(): AliasContext {
	return {
		identifiers: new Map(),
		labels: new Map(),
		toolNames: new Map(),
		urls: new Map(),
		fields: new Map(),
	};
}

function cloneAliasContext(source: AliasContext): AliasContext {
	return {
		identifiers: new Map(source.identifiers),
		labels: new Map(source.labels),
		toolNames: new Map(source.toolNames),
		urls: new Map(source.urls),
		fields: new Map(source.fields),
	};
}

function commitAliases(target: AliasContext, source: AliasContext): void {
	for (const key of Object.keys(target) as Array<keyof AliasContext>) {
		target[key].clear();
		for (const [raw, sanitized] of source[key]) {
			target[key].set(raw, sanitized);
		}
	}
}

function sanitize(
	kind: ServerToolCharacterizationKind,
	input: unknown,
	aliases: AliasContext,
	ignoredSymbols: ReadonlySet<symbol>,
): ServerToolCharacterizationRecord | null {
	if (!CHARACTERIZATION_KINDS.has(kind)) return null;
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return null;
	}
	const pendingAliases = cloneAliasContext(aliases);
	const state: SanitizeState = {
		nodes: 1,
		active: new Set(),
		aliases: pendingAliases,
		ignoredSymbols,
		kind,
	};
	const data = sanitizeObject(input, 0, state, []);
	if (data === undefined) return null;
	commitAliases(aliases, pendingAliases);
	const record = Object.freeze({ kind, data });
	AUTHENTIC_RECORDS.add(record);
	return record;
}

function stableStringify(value: ServerToolCharacterizationValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableStringify(
					(value as Record<string, ServerToolCharacterizationValue>)[key],
				)}`,
		)
		.join(",")}}`;
}

interface SnapshotState {
	nodes: number;
	readonly active: Set<object>;
	readonly kind: ServerToolCharacterizationKind;
}

function isSanitizedString(
	value: string,
	mode: StringMode,
	kind: ServerToolCharacterizationKind,
	path: readonly CharacterizationPathSegment[],
): boolean {
	if (/^https:\/\/source-[1-9][0-9]*\.example\/$/.test(value)) return true;
	if (/^(?:field|id|label|tool)-[1-9][0-9]*$/.test(value)) return true;
	if (safeProtocolValues(kind, path, mode)?.has(value)) return true;
	if (mode === "identifier") return /^id-[1-9][0-9]*$/.test(value);
	if (mode === "name") return /^tool-[1-9][0-9]*$/.test(value);
	if (mode === "schema_key") return /^field-[1-9][0-9]*$/.test(value);
	return false;
}

function snapshotArray(
	value: readonly unknown[],
	mode: StringMode,
	depth: number,
	state: SnapshotState,
	path: readonly CharacterizationPathSegment[],
): readonly ServerToolCharacterizationValue[] | undefined {
	if (value.length > CHARACTERIZATION_LIMITS.maxArrayItems) return undefined;
	const ownKeys = Reflect.ownKeys(value);
	if (
		ownKeys.some((key) => {
			if (typeof key !== "string") return true;
			if (key === "length") return false;
			if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return true;
			return Number(key) >= value.length;
		})
	) {
		return undefined;
	}
	const snapshot: ServerToolCharacterizationValue[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor)) return undefined;
		const child = snapshotSanitizedValue(
			descriptor.value,
			mode,
			depth + 1,
			state,
			[...path, ARRAY_ITEM_PATH_SEGMENT],
		);
		if (child === undefined) return undefined;
		snapshot.push(child);
	}
	return Object.freeze(snapshot);
}

function snapshotObject(
	value: object,
	depth: number,
	state: SnapshotState,
	path: readonly CharacterizationPathSegment[],
): Readonly<Record<string, ServerToolCharacterizationValue>> | undefined {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (state.active.has(value)) return undefined;
	state.active.add(value);
	try {
		const ownKeys = Reflect.ownKeys(value);
		if (
			ownKeys.length > CHARACTERIZATION_LIMITS.maxObjectKeys ||
			ownKeys.some((key) => typeof key !== "string")
		) {
			return undefined;
		}
		const snapshot: Record<string, ServerToolCharacterizationValue> = {};
		for (const key of (ownKeys as string[]).sort()) {
			const isAllowedPromptCacheKey = isRootOutboundPromptCacheKey(
				state.kind,
				depth,
				key,
			);
			if (
				isPrototypePollutionKey(key) ||
				(isForbiddenKey(key) && !isAllowedPromptCacheKey) ||
				(!PROTOCOL_KEYS.has(key) &&
					!isOutboundNativeOptionKey(state.kind, path, key) &&
					!/^field-[1-9][0-9]*$/.test(key))
			) {
				return undefined;
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
				return undefined;
			}
			const child = snapshotSanitizedValue(
				descriptor.value,
				stringModeForLocation(state.kind, path, key),
				depth + 1,
				state,
				[...path, key],
			);
			if (child === undefined) return undefined;
			snapshot[key] = child;
		}
		return Object.freeze(snapshot);
	} finally {
		state.active.delete(value);
	}
}

function snapshotSanitizedValue(
	value: unknown,
	mode: StringMode,
	depth: number,
	state: SnapshotState,
	path: readonly CharacterizationPathSegment[],
): ServerToolCharacterizationValue | undefined {
	state.nodes++;
	if (
		state.nodes > CHARACTERIZATION_LIMITS.maxSnapshotNodes ||
		depth > CHARACTERIZATION_LIMITS.maxDepth
	) {
		return undefined;
	}
	if (value === null) return undefined;
	if (typeof value === "boolean") {
		return mode === "boolean" ? value : undefined;
	}
	if (typeof value === "number") {
		if (mode === "status") {
			return Number.isSafeInteger(value) && value >= 100 && value <= 599
				? value
				: undefined;
		}
		if (mode === "max_tool_calls") {
			return Number.isSafeInteger(value) && value >= 1 && value <= 8
				? value
				: undefined;
		}
		return mode === "number" && Number.isSafeInteger(value) && value >= 0
			? value
			: undefined;
	}
	if (typeof value === "string") {
		if (
			value.length > CHARACTERIZATION_LIMITS.maxStringUtf16CodeUnits ||
			!isSanitizedString(value, mode, state.kind, path)
		) {
			return undefined;
		}
		return textEncoder.encode(value).byteLength <=
			CHARACTERIZATION_LIMITS.maxStringUtf8Bytes
			? value
			: undefined;
	}
	if (mode === "max_tool_calls") return undefined;
	if (typeof value !== "object") return undefined;
	if (AUTHENTIC_METADATA.has(value)) {
		return value as
			| ServerToolCharacterizationPrimitiveMetadata
			| ServerToolCharacterizationStringMetadata
			| ServerToolCharacterizationTruncationMetadata;
	}
	if (Array.isArray(value)) {
		return mode === "object"
			? undefined
			: snapshotArray(value, mode, depth, state, path);
	}
	return snapshotObject(value, depth, state, path);
}

function canonicalize(record: ServerToolCharacterizationRecord): string | null {
	if (!AUTHENTIC_RECORDS.has(record)) return null;
	const prototype = Object.getPrototypeOf(record);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const ownKeys = Reflect.ownKeys(record);
	if (
		ownKeys.length !== 2 ||
		!ownKeys.includes("kind") ||
		!ownKeys.includes("data") ||
		ownKeys.some((key) => typeof key !== "string")
	) {
		return null;
	}
	const kindDescriptor = Object.getOwnPropertyDescriptor(record, "kind");
	const dataDescriptor = Object.getOwnPropertyDescriptor(record, "data");
	if (
		!kindDescriptor ||
		!("value" in kindDescriptor) ||
		!CHARACTERIZATION_KINDS.has(kindDescriptor.value) ||
		!dataDescriptor ||
		!("value" in dataDescriptor)
	) {
		return null;
	}
	const state: SnapshotState = {
		nodes: 0,
		active: new Set(),
		kind: kindDescriptor.value,
	};
	const snapshot = snapshotSanitizedValue(
		dataDescriptor.value,
		"content",
		0,
		state,
		[],
	);
	if (
		snapshot === undefined ||
		snapshot === null ||
		typeof snapshot !== "object" ||
		Array.isArray(snapshot)
	) {
		return null;
	}
	return `{"data":${stableStringify(snapshot)},"kind":${JSON.stringify(
		kindDescriptor.value,
	)}}`;
}

function emit(
	aliases: AliasContext,
	ignoredSymbols: ReadonlySet<symbol>,
	observer: ServerToolCharacterizationObserver,
	kind: ServerToolCharacterizationKind,
	input: unknown,
): void {
	try {
		const record = sanitize(kind, input, aliases, ignoredSymbols);
		if (record === null || typeof observer !== "function") return;
		observer(record);
	} catch {
		// Characterization must never affect provider behavior or expose input.
	}
}

function readIgnoredSymbols(
	options: ServerToolCharacterizationContextOptions | undefined,
): ReadonlySet<symbol> | null {
	try {
		const values = options?.ignoredSymbols ?? [];
		if (
			!Array.isArray(values) ||
			values.length > CHARACTERIZATION_LIMITS.maxIgnoredSymbols ||
			values.some((value) => typeof value !== "symbol")
		) {
			return null;
		}
		return new Set(values);
	} catch {
		return null;
	}
}

export function createServerToolCharacterizationSanitizer(
	options?: ServerToolCharacterizationContextOptions,
): ServerToolCharacterizationSanitizer {
	const aliases = createAliasContext();
	const ignoredSymbols = readIgnoredSymbols(options);
	return Object.freeze({
		sanitize(
			kind: ServerToolCharacterizationKind,
			input: unknown,
		): ServerToolCharacterizationRecord | null {
			try {
				return ignoredSymbols === null
					? null
					: sanitize(kind, input, aliases, ignoredSymbols);
			} catch {
				return null;
			}
		},
		canonicalize(record: ServerToolCharacterizationRecord): string | null {
			try {
				return canonicalize(record);
			} catch {
				return null;
			}
		},
		emit(
			observer: ServerToolCharacterizationObserver,
			kind: ServerToolCharacterizationKind,
			input: unknown,
		): void {
			if (ignoredSymbols === null) return;
			emit(aliases, ignoredSymbols, observer, kind, input);
		},
	});
}

export const createServerToolCharacterizationContext =
	createServerToolCharacterizationSanitizer;

export function sanitizeServerToolCharacterization(
	kind: ServerToolCharacterizationKind,
	input: unknown,
): ServerToolCharacterizationRecord | null {
	return createServerToolCharacterizationSanitizer().sanitize(kind, input);
}

export function canonicalizeServerToolCharacterization(
	record: ServerToolCharacterizationRecord,
): string | null {
	try {
		return canonicalize(record);
	} catch {
		return null;
	}
}

export function emitServerToolCharacterization(
	observer: ServerToolCharacterizationObserver,
	kind: ServerToolCharacterizationKind,
	input: unknown,
): void {
	createServerToolCharacterizationSanitizer().emit(observer, kind, input);
}
