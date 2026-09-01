import { sanitizeSchemaForOpenAI } from "@better-ccflare/openai-formats";
import type {
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityTuple,
	ServerToolMixedToolMode,
	ServerToolReplayAtom,
	ServerToolRequirements,
	ServerToolResponseMode,
} from "@better-ccflare/types";
import {
	buildServerToolCapabilityTupleKey,
	deriveServerToolRequirement,
	type WebSearchServerToolDeclaration,
} from "../../server-tool-capabilities";
import type { ProviderServerToolCapabilityContext } from "../../types";

export const CODEX_SERVER_TOOL_MODEL = "gpt-5.6-sol" as const;
export const CODEX_SERVER_TOOL_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/responses" as const;
export const CODEX_SERVER_TOOL_ENDPOINT_CLASS = "codex_responses" as const;
export const CODEX_SERVER_TOOL_PROVIDER_CONTRACT_REVISION =
	"codex-responses-web-search-v4" as const;
export const CODEX_SERVER_TOOL_REPLAY_DECODER_REVISION =
	"server-tool-replay-v3" as const;
export const CODEX_SERVER_TOOL_REQUEST_TRANSPORT = "openai_responses" as const;
export const CODEX_SERVER_TOOL_RESPONSE_TRANSPORT =
	"openai_responses_sse" as const;

const FRESH_REPLAY = Object.freeze([]) as readonly ServerToolReplayAtom[];
const NATIVE_ANTHROPIC_REPLAY = Object.freeze(["native-Anthropic" as const]);
const PROXY_EVIDENCE_REPLAY = Object.freeze(["proxy-evidence-v1" as const]);
const RESPONSE_MODES = Object.freeze(["json" as const, "streaming" as const]);
const MIXED_TOOL_MODES = Object.freeze([
	"server_only" as const,
	"server_and_client_functions" as const,
]);

interface CodexServerToolCompiledContract {
	readonly responseMode: ServerToolResponseMode;
	readonly mixedToolMode: ServerToolMixedToolMode;
	readonly inputReplay: readonly ServerToolReplayAtom[];
	readonly outputReplay: readonly ServerToolReplayAtom[];
}

const CODEX_SERVER_TOOL_REPLAY_CONTRACTS = Object.freeze([
	Object.freeze({
		inputReplay: FRESH_REPLAY,
		outputReplay: PROXY_EVIDENCE_REPLAY,
	}),
	// The Anthropic encoder emits a native server_tool_use paired with
	// proxy-authenticated output. These two rows are the complete replay authority;
	// proxy-evidence input, native output, and mixed atoms remain inadmissible.
	Object.freeze({
		inputReplay: NATIVE_ANTHROPIC_REPLAY,
		outputReplay: PROXY_EVIDENCE_REPLAY,
	}),
]);

/**
 * The complete reviewed Codex hosted-search transport matrix. These are code
 * authority, not runtime-learned proof profiles: changing any row changes the
 * deployed SHA and requires review like any other provider contract change.
 */
const CODEX_SERVER_TOOL_COMPILED_CONTRACTS = Object.freeze(
	RESPONSE_MODES.flatMap((responseMode) =>
		MIXED_TOOL_MODES.flatMap((mixedToolMode) =>
			CODEX_SERVER_TOOL_REPLAY_CONTRACTS.map(({ inputReplay, outputReplay }) =>
				Object.freeze({
					responseMode,
					mixedToolMode,
					inputReplay,
					outputReplay,
				}),
			),
		),
	),
) as readonly CodexServerToolCompiledContract[];

const REVALIDATION_TRIGGERS = Object.freeze([
	"tuple_change" as const,
	"contract_change" as const,
	"decoder_change" as const,
	"observed_behavior_change" as const,
]);

const UNKNOWN_NO_EXACT_CONTRACT: ServerToolCapabilityDecision = Object.freeze({
	decision: "unknown",
	reason: "no_exact_proof",
});
const UNKNOWN_REQUIREMENT_MISMATCH: ServerToolCapabilityDecision =
	Object.freeze({
		decision: "unknown",
		reason: "requirement_mismatch",
	});
const UNKNOWN_INVALID_REQUIREMENT: ServerToolCapabilityDecision = Object.freeze(
	{
		decision: "unknown",
		reason: "invalid_requirement",
	},
);
const UNKNOWN_UNSUPPORTED_REQUIREMENT: ServerToolCapabilityDecision =
	Object.freeze({
		decision: "unknown",
		reason: "unsupported_requirement",
	});
const MAX_LOCATION_VALUE_BYTES = 256;
const LOCATION_TEXT_ENCODER = new TextEncoder();

type ExactCodexServerToolRequirements = ServerToolRequirements &
	Required<
		Pick<
			ServerToolRequirements,
			| "profileId"
			| "optionProfileId"
			| "responseMode"
			| "mixedToolMode"
			| "declarations"
		>
	>;

function replayEquals(
	actual: readonly ServerToolReplayAtom[],
	expected: readonly ServerToolReplayAtom[],
): boolean {
	return (
		actual.length === expected.length &&
		actual.every((atom, index) => atom === expected[index])
	);
}

function hasCompiledOptionBounds(
	declaration: WebSearchServerToolDeclaration,
): boolean {
	const location = declaration.userLocation;
	if (!location) return true;
	return (["city", "region", "country", "timezone"] as const).every((key) => {
		const value = location[key];
		return (
			value === undefined ||
			LOCATION_TEXT_ENCODER.encode(value).byteLength <= MAX_LOCATION_VALUE_BYTES
		);
	});
}

function matchCompiledContract(
	requirements: ServerToolRequirements,
): CodexServerToolCompiledContract | undefined {
	if (
		requirements.revision !== 2 ||
		requirements.invalid?.length ||
		requirements.unsupported?.length ||
		requirements.declarations?.length !== 1 ||
		requirements.declarations[0]?.type !== "web_search_20250305" ||
		!hasCompiledOptionBounds(requirements.declarations[0]) ||
		typeof requirements.profileId !== "string" ||
		requirements.profileId.length === 0 ||
		typeof requirements.optionProfileId !== "string" ||
		requirements.optionProfileId.length === 0 ||
		requirements.replay.requiresOutputReplay !== true
	) {
		return undefined;
	}

	const mixedShapeMatches =
		(requirements.mixedToolMode === "server_only" &&
			requirements.hasClientFunctions !== true) ||
		(requirements.mixedToolMode === "server_and_client_functions" &&
			requirements.hasClientFunctions === true);
	if (!mixedShapeMatches) return undefined;
	// A fresh history has no observed output atom; the matched compiled row still
	// requires proxy-evidence output for the response this candidate will produce.
	const isFreshRequest =
		replayEquals(requirements.replay.input, FRESH_REPLAY) &&
		replayEquals(requirements.replay.output, FRESH_REPLAY);
	const isNaturalContinuation =
		replayEquals(requirements.replay.input, NATIVE_ANTHROPIC_REPLAY) &&
		replayEquals(requirements.replay.output, PROXY_EVIDENCE_REPLAY);
	if (!isFreshRequest && !isNaturalContinuation) return undefined;

	return CODEX_SERVER_TOOL_COMPILED_CONTRACTS.find(
		(contract) =>
			contract.responseMode === requirements.responseMode &&
			contract.mixedToolMode === requirements.mixedToolMode &&
			replayEquals(contract.inputReplay, requirements.replay.input),
	);
}

function isCodexOAuthSubscription(
	account: ProviderServerToolCapabilityContext["account"],
): boolean {
	const billingType = account.billingType?.trim().toLowerCase() || null;
	return (
		account.provider === "codex" &&
		account.apiKeyConfigured === false &&
		account.legacyMirroredApiKey === false &&
		(account.refreshTokenConfigured || account.accessTokenConfigured) &&
		(billingType === null || billingType === "plan") &&
		account.customEndpointConfigured === false &&
		account.customEndpoint === null &&
		account.unsafeCustomEndpoint === false
	);
}

function materializeCodexTuple(
	candidateId: string,
	requirements: ExactCodexServerToolRequirements,
	contract: CodexServerToolCompiledContract,
): ServerToolCapabilityTuple | undefined {
	return Object.freeze({
		candidateId,
		provider: "codex",
		authMode: "oauth-subscription",
		endpointClass: CODEX_SERVER_TOOL_ENDPOINT_CLASS,
		normalizedEndpoint: CODEX_SERVER_TOOL_ENDPOINT,
		model: CODEX_SERVER_TOOL_MODEL,
		toolType: "web_search_20250305",
		profile: requirements.profileId,
		optionProfile: requirements.optionProfileId,
		responseMode: contract.responseMode,
		mixedToolMode: contract.mixedToolMode,
		inputReplay: contract.inputReplay,
		outputReplay: contract.outputReplay,
		providerContractRevision: CODEX_SERVER_TOOL_PROVIDER_CONTRACT_REVISION,
		replayDecoderRevision: CODEX_SERVER_TOOL_REPLAY_DECODER_REVISION,
		requestTransport: CODEX_SERVER_TOOL_REQUEST_TRANSPORT,
		responseTransport: CODEX_SERVER_TOOL_RESPONSE_TRANSPORT,
	});
}

/** Materialize only the official Codex OAuth subscription tuple. */
export function createCodexServerToolCapabilityTuple(
	context: ProviderServerToolCapabilityContext,
): ServerToolCapabilityTuple | undefined {
	if (
		context.physicalModel !== CODEX_SERVER_TOOL_MODEL ||
		context.endpointContract.routeClass !== "anthropic_messages" ||
		context.endpointContract.queryPresent ||
		!isCodexOAuthSubscription(context.account)
	) {
		return undefined;
	}
	const contract = matchCompiledContract(context.requirements);
	if (!contract) return undefined;
	return materializeCodexTuple(
		context.candidateId,
		context.requirements as ExactCodexServerToolRequirements,
		contract,
	);
}

function readCandidateId(tuple: ServerToolCapabilityTuple): string | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(tuple, "candidateId");
		return descriptor !== undefined &&
			Object.hasOwn(descriptor, "value") &&
			typeof descriptor.value === "string" &&
			descriptor.value.length > 0
			? descriptor.value
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Re-materialize the tuple from the closed revision-2 contract before blessing
 * it. A structurally similar tuple with any drift never becomes a proof.
 */
export function resolveCodexServerToolCapability(
	requirements: ServerToolRequirements,
	tuple: ServerToolCapabilityTuple,
): ServerToolCapabilityDecision {
	if (requirements.invalid?.length) return UNKNOWN_INVALID_REQUIREMENT;
	if (requirements.unsupported?.length) return UNKNOWN_UNSUPPORTED_REQUIREMENT;
	const contract = matchCompiledContract(requirements);
	if (!contract) {
		return UNKNOWN_REQUIREMENT_MISMATCH;
	}
	const candidateId = readCandidateId(tuple);
	if (!candidateId) return UNKNOWN_NO_EXACT_CONTRACT;
	const expected = materializeCodexTuple(
		candidateId,
		requirements as ExactCodexServerToolRequirements,
		contract,
	);
	if (
		!expected ||
		buildServerToolCapabilityTupleKey(tuple) !==
			buildServerToolCapabilityTupleKey(expected)
	) {
		return UNKNOWN_NO_EXACT_CONTRACT;
	}

	const proof: ServerToolCapabilityProof = Object.freeze({
		revision: "codex-hosted-search-embedded-v1",
		tuple: expected,
		decision: "proven",
		provenance: "reviewed_embedded_contract",
		owner: "providers/codex",
		verifiedAt: "2026-07-29T00:00:00.000Z",
		revalidateAfter: "9999-12-31T23:59:59.999Z",
		fixtureRevision: "codex-official-responses-web-search-v4",
		contractRevision: CODEX_SERVER_TOOL_PROVIDER_CONTRACT_REVISION,
		revalidationTriggers: REVALIDATION_TRIGGERS,
	});
	return Object.freeze({ decision: "proven", proof });
}

export const CODEX_UNSUPPORTED_WEB_SEARCH_SOURCES_INCLUDE =
	"web_search_call.action.sources" as const;
const ORCHESTRATION_TOOL_NAMES = new Set(["Agent", "Task"]);
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 16_384;

type UnknownRecord = Record<string, unknown>;

export interface CodexFunctionTool {
	readonly type: "function";
	readonly name: string;
	readonly description?: string;
	readonly parameters: UnknownRecord;
}

export interface CodexWebSearchTool {
	readonly type: "web_search";
	readonly filters?: Readonly<
		| { allowed_domains: readonly string[] }
		| { blocked_domains: readonly string[] }
	>;
	readonly user_location?: Readonly<{
		type: "approximate";
		city?: string;
		region?: string;
		country?: string;
		timezone?: string;
	}>;
}

export interface CodexServerToolRequestMapping {
	readonly tools: readonly (CodexFunctionTool | CodexWebSearchTool)[];
}

export interface CodexServerToolRequestMappingPolicy {
	/** Mirror the existing Codex Agent/Task root-election decision. */
	readonly filterOrchestrationTools?: boolean;
}

/** Content-free local failure for an exact hosted-tool conversion. */
export class CodexServerToolConversionError extends Error {
	readonly code = "codex_server_tool_conversion_failed" as const;

	constructor() {
		super("Codex server-tool request conversion failed");
		this.name = "CodexServerToolConversionError";
	}
}

function rejected(): CodexServerToolConversionError {
	return new CodexServerToolConversionError();
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OwnDataField {
	readonly present: boolean;
	readonly value?: unknown;
}

const ABSENT_FIELD: OwnDataField = Object.freeze({ present: false });

function readOwnDataField(value: object, key: PropertyKey): OwnDataField {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return ABSENT_FIELD;
	if (!Object.hasOwn(descriptor, "value")) throw rejected();
	return { present: true, value: descriptor.value };
}

interface InspectedTool {
	readonly record?: UnknownRecord;
	readonly type: OwnDataField;
}

interface HostedToolCandidate {
	readonly body: UnknownRecord;
	readonly tools: readonly InspectedTool[];
}

function inspectHostedToolCandidate(
	body: unknown,
): HostedToolCandidate | undefined {
	if (!isRecord(body)) return undefined;
	const toolsField = readOwnDataField(body, "tools");
	if (!toolsField.present) return undefined;
	const tools = toolsField.value;
	if (!Array.isArray(tools)) {
		if (isRecord(tools) && readOwnDataField(tools, "type").present) {
			throw rejected();
		}
		return undefined;
	}

	const lengthField = readOwnDataField(tools, "length");
	if (
		!lengthField.present ||
		typeof lengthField.value !== "number" ||
		!Number.isSafeInteger(lengthField.value) ||
		lengthField.value < 0
	) {
		throw rejected();
	}

	let hasTypedTool = false;
	const inspectedTools: InspectedTool[] = [];
	for (let index = 0; index < lengthField.value; index += 1) {
		const itemField = readOwnDataField(tools, String(index));
		if (!itemField.present || !isRecord(itemField.value)) {
			inspectedTools.push({ type: ABSENT_FIELD });
			continue;
		}
		const type = readOwnDataField(itemField.value, "type");
		if (type.present) hasTypedTool = true;
		inspectedTools.push({ record: itemField.value, type });
	}
	return hasTypedTool ? { body, tools: inspectedTools } : undefined;
}

/** Detect typed provider-owned tools without matching display names. */
export function hasCodexServerToolDeclaration(body: unknown): boolean {
	try {
		return inspectHostedToolCandidate(body) !== undefined;
	} catch {
		return true;
	}
}

interface JsonSnapshotState {
	readonly ancestors: WeakSet<object>;
	nodes: number;
}

function snapshotJsonData(
	value: unknown,
	state: JsonSnapshotState = { ancestors: new WeakSet(), nodes: 0 },
	depth = 0,
): unknown {
	if (depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_SCHEMA_NODES) {
		throw rejected();
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw rejected();
		return value;
	}
	if (typeof value !== "object") throw rejected();
	if (state.ancestors.has(value)) throw rejected();
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const field = readOwnDataField(value, String(index));
				if (!field.present) throw rejected();
				result.push(snapshotJsonData(field.value, state, depth + 1));
			}
			return result;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw rejected();
		const result: UnknownRecord = {};
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") throw rejected();
			const field = readOwnDataField(value, key);
			if (!field.present) throw rejected();
			result[key] = snapshotJsonData(field.value, state, depth + 1);
		}
		return result;
	} finally {
		state.ancestors.delete(value);
	}
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && Object.hasOwn(descriptor, "value")) {
			deepFreeze(descriptor.value);
		}
	}
	return Object.freeze(value);
}

function snapshotClientFunction(tool: UnknownRecord): {
	readonly source: UnknownRecord;
	readonly mapped: CodexFunctionTool;
} {
	const name = readOwnDataField(tool, "name");
	const description = readOwnDataField(tool, "description");
	const inputSchema = readOwnDataField(tool, "input_schema");
	if (
		!name.present ||
		typeof name.value !== "string" ||
		name.value.length === 0 ||
		!inputSchema.present ||
		!isRecord(inputSchema.value) ||
		(description.present &&
			description.value !== undefined &&
			typeof description.value !== "string")
	) {
		throw rejected();
	}
	const schemaSnapshot = snapshotJsonData(inputSchema.value);
	if (!isRecord(schemaSnapshot)) throw rejected();
	const sanitized = sanitizeSchemaForOpenAI(schemaSnapshot);
	if (!isRecord(sanitized)) throw rejected();
	return {
		source: {
			name: name.value,
			...(description.present ? { description: description.value } : {}),
			input_schema: schemaSnapshot,
		},
		mapped: {
			type: "function",
			name: name.value,
			description: description.value as string | undefined,
			parameters: sanitized,
		},
	};
}

const SERVER_TOOL_KEYS = new Set<PropertyKey>([
	"type",
	"name",
	"max_uses",
	"allowed_domains",
	"blocked_domains",
	"user_location",
]);

function snapshotServerTool(tool: InspectedTool): UnknownRecord {
	const record = tool.record;
	if (!record || !tool.type.present) throw rejected();
	const source: UnknownRecord = { type: tool.type.value };
	for (const key of Reflect.ownKeys(record)) {
		if (typeof key !== "string" || !SERVER_TOOL_KEYS.has(key)) throw rejected();
		if (key === "type") continue;
		const field = readOwnDataField(record, key);
		if (!field.present) throw rejected();
		source[key] = snapshotJsonData(field.value);
	}
	return source;
}

function copyOptionalDataField(
	source: UnknownRecord,
	target: UnknownRecord,
	key: PropertyKey,
): void {
	const field = readOwnDataField(source, key);
	if (field.present && typeof key === "string") target[key] = field.value;
}

function mapWebSearch(
	declaration: WebSearchServerToolDeclaration,
): CodexWebSearchTool {
	const tool: {
		type: "web_search";
		filters?:
			| { allowed_domains: readonly string[] }
			| { blocked_domains: readonly string[] };
		user_location?: CodexWebSearchTool["user_location"];
	} = { type: "web_search" };
	if (declaration.allowedDomains) {
		tool.filters = { allowed_domains: [...declaration.allowedDomains] };
	} else if (declaration.blockedDomains) {
		tool.filters = { blocked_domains: [...declaration.blockedDomains] };
	}
	if (declaration.userLocation) {
		tool.user_location = { ...declaration.userLocation };
	}
	return tool;
}

/**
 * Compile the exact Anthropic declaration into native Responses fields.
 * Ordinary requests return undefined, preserving the existing provider path.
 */
export function mapCodexServerToolRequest(
	body: unknown,
	policy: CodexServerToolRequestMappingPolicy = {},
): CodexServerToolRequestMapping | undefined {
	try {
		const candidate = inspectHostedToolCandidate(body);
		if (!candidate) return undefined;
		for (const key of [
			"include",
			"max_tool_calls",
			"parallel_tool_calls",
		] as const) {
			if (readOwnDataField(candidate.body, key).present) throw rejected();
		}

		const requirementBody: UnknownRecord = { tools: [] };
		copyOptionalDataField(candidate.body, requirementBody, "tool_choice");
		copyOptionalDataField(candidate.body, requirementBody, "stream");
		copyOptionalDataField(candidate.body, requirementBody, "messages");

		let hostedCount = 0;
		const mappedTools: (CodexFunctionTool | CodexWebSearchTool)[] = [];
		const sourceTools: UnknownRecord[] = [];
		let mappedServerToolIndex = -1;
		for (const tool of candidate.tools) {
			const record = tool.record;
			if (!record) throw rejected();
			if (!tool.type.present) {
				const client = snapshotClientFunction(record);
				sourceTools.push(client.source);
				if (
					policy.filterOrchestrationTools !== true ||
					!ORCHESTRATION_TOOL_NAMES.has(client.mapped.name)
				) {
					mappedTools.push(client.mapped);
				}
				continue;
			}
			if (tool.type.value !== "web_search_20250305") throw rejected();
			hostedCount += 1;
			if (hostedCount !== 1) throw rejected();
			sourceTools.push(snapshotServerTool(tool));
			mappedServerToolIndex = mappedTools.length;
			mappedTools.push({ type: "web_search" });
		}
		if (hostedCount !== 1 || mappedServerToolIndex < 0) throw rejected();
		requirementBody.tools = sourceTools;

		const requirement = deriveServerToolRequirement(requirementBody);
		if (
			!requirement ||
			requirement.invalid !== undefined ||
			requirement.unsupported !== undefined ||
			requirement.declarations?.length !== 1 ||
			!matchCompiledContract(requirement) ||
			requirement.replay.input.length > 0 ||
			requirement.replay.output.length > 0
		) {
			throw rejected();
		}

		const declaration = requirement.declarations[0];
		if (!declaration) throw rejected();
		mappedTools[mappedServerToolIndex] = mapWebSearch(declaration);
		return deepFreeze({ tools: mappedTools });
	} catch {
		throw rejected();
	}
}
