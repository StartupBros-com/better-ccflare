import { createHash } from "node:crypto";
import type {
	Account,
	ApproximateUserLocation,
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityProofIndex,
	ServerToolCapabilityProofIndexEntry,
	ServerToolCapabilityTuple,
	ServerToolMixedToolMode,
	ServerToolReplayAtom,
	ServerToolReplayRequirement,
	ServerToolRequirements,
	ServerToolResponseMode,
	WebSearchServerToolDeclaration,
} from "@better-ccflare/types";
import type {
	Provider,
	ProviderServerToolCapabilityAccountContext,
	ProviderServerToolCapabilityContext,
	ProviderServerToolCapabilityEndpointContract,
	ProviderServerToolCapabilityMaterializationContext,
} from "./types";

export type {
	ApproximateUserLocation,
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityProofIndex,
	ServerToolCapabilityProofIndexEntry,
	ServerToolCapabilityTuple,
	ServerToolMixedToolMode,
	ServerToolReplayAtom,
	ServerToolReplayRequirement,
	ServerToolRequirements,
	ServerToolResponseMode,
	WebSearchServerToolDeclaration,
} from "@better-ccflare/types";

const EXACT_WEB_SEARCH_TYPE = "web_search_20250305" as const;
const REQUIREMENT_REVISION = 2 as const;
const MAX_DOMAINS = 10;
const MAX_DOMAIN_LENGTH = 8 * 1024;
const MAX_LOCATION_VALUE_LENGTH = 256;
const MAX_ISSUE_RECORDS = 8;
const MAX_RETAINED_TOOL_TYPE_LENGTH = 128;
const MAX_HISTORY_MESSAGE_VISITS = 4_096;
const MAX_HISTORY_BLOCK_VISITS = 16_384;
const WEB_SEARCH_PROFILE_PREFIX = "web-search-20250305-v1" as const;
const OPTION_PROFILE_PREFIX = "server-tool-option-profile-v1.sha256." as const;
const OPTION_PROFILE_DOMAIN =
	"better-ccflare/server-tool-option-profile/v1\0" as const;
const UNKNOWN_TYPED_TOOL = "unknown_typed_tool" as const;

type UnknownRecord = Record<string, unknown>;

export interface DeriveServerToolRequirementOptions {
	/** Protect the exact request layers inspected while deriving requirements. */
	readonly freezeSemanticLayers?: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: UnknownRecord,
	allowed: ReadonlySet<string>,
): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainDataRecordWithOnlyKeys(
	value: unknown,
	allowed: ReadonlySet<string>,
	maximumKeys: number,
): value is UnknownRecord {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length > maximumKeys) return false;
	for (const key of keys) {
		if (typeof key !== "string" || !allowed.has(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			return false;
		}
	}
	return true;
}

function readOwnDataValue(value: object, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
		throw new TypeError("Invalid provider server-tool capability data");
	}
	return descriptor.value;
}

function normalizeRetainedToolType(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_RETAINED_TOOL_TYPE_LENGTH ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)
	) {
		return UNKNOWN_TYPED_TOOL;
	}
	return value;
}

function pushBoundedIssue<T>(issues: T[], issue: T): void {
	if (issues.length < MAX_ISSUE_RECORDS) issues.push(issue);
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.charCodeAt(index);
		if (codePoint <= 0x1f || codePoint === 0x7f) return true;
	}
	return false;
}

function isValidDomainFilter(domain: string): boolean {
	if (
		domain.length === 0 ||
		domain.length > MAX_DOMAIN_LENGTH ||
		!/^[\x21-\x7e]+$/u.test(domain)
	) {
		return false;
	}
	if (
		domain.includes("@") ||
		domain.includes("?") ||
		domain.includes("#") ||
		domain.includes("\\")
	) {
		return false;
	}

	const pathStart = domain.indexOf("/");
	const host = pathStart === -1 ? domain : domain.slice(0, pathStart);
	const path = pathStart === -1 ? "" : domain.slice(pathStart);
	if (host.length === 0 || host.length > 253) return false;

	const labels = host.split(".");
	if (
		labels.some(
			(label) =>
				label.length === 0 ||
				label.length > 63 ||
				!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(label),
		)
	) {
		return false;
	}

	if (path !== "" && !/^\/[a-zA-Z0-9._~!$&'()*+,;=:%/-]*$/u.test(path))
		return false;
	for (let index = 0; index < path.length; index += 1) {
		if (path[index] !== "%") continue;
		if (!/^[a-fA-F0-9]{2}$/u.test(path.slice(index + 1, index + 3)))
			return false;
		index += 2;
	}
	return true;
}

function normalizeDomains(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DOMAINS)
		return undefined;
	if (
		value.some(
			(domain) => typeof domain !== "string" || !isValidDomainFilter(domain),
		)
	) {
		return undefined;
	}
	return Object.freeze([...value]) as readonly string[];
}

function normalizeLocation(
	value: unknown,
): ApproximateUserLocation | undefined {
	if (!isRecord(value)) return undefined;
	const allowed = new Set(["type", "city", "region", "country", "timezone"]);
	if (!hasOnlyKeys(value, allowed) || value.type !== "approximate")
		return undefined;

	const result: {
		type: "approximate";
		city?: string;
		region?: string;
		country?: string;
		timezone?: string;
	} = { type: "approximate" };

	for (const key of ["city", "region", "country", "timezone"] as const) {
		const field = value[key];
		if (field === undefined) continue;
		if (
			typeof field !== "string" ||
			field.length === 0 ||
			field.length > MAX_LOCATION_VALUE_LENGTH ||
			hasControlCharacter(field)
		) {
			return undefined;
		}
		result[key] = field;
	}

	if (Object.keys(result).length === 1) return undefined;
	return Object.freeze(result);
}

function normalizeExactDeclaration(
	tool: UnknownRecord,
): WebSearchServerToolDeclaration | undefined {
	const allowed = new Set([
		"type",
		"name",
		"max_uses",
		"allowed_domains",
		"blocked_domains",
		"user_location",
	]);
	if (!hasOnlyKeys(tool, allowed) || tool.name !== "web_search")
		return undefined;

	const declaration: {
		type: typeof EXACT_WEB_SEARCH_TYPE;
		maxUses?: number;
		allowedDomains?: readonly string[];
		blockedDomains?: readonly string[];
		userLocation?: ApproximateUserLocation;
	} = { type: EXACT_WEB_SEARCH_TYPE };

	if (tool.max_uses !== undefined) {
		if (
			!Number.isInteger(tool.max_uses) ||
			(tool.max_uses as number) < 1 ||
			(tool.max_uses as number) > 8
		) {
			return undefined;
		}
		declaration.maxUses = tool.max_uses as number;
	}

	if (tool.allowed_domains !== undefined && tool.blocked_domains !== undefined)
		return undefined;
	if (tool.allowed_domains !== undefined) {
		const domains = normalizeDomains(tool.allowed_domains);
		if (!domains) return undefined;
		declaration.allowedDomains = domains;
	}
	if (tool.blocked_domains !== undefined) {
		const domains = normalizeDomains(tool.blocked_domains);
		if (!domains) return undefined;
		declaration.blockedDomains = domains;
	}
	if (tool.user_location !== undefined) {
		const location = normalizeLocation(tool.user_location);
		if (!location) return undefined;
		declaration.userLocation = location;
	}

	return Object.freeze(declaration);
}

function buildWebSearchProfileId(
	declaration: WebSearchServerToolDeclaration,
	hasClientFunctions: boolean,
	forcedWebSearchChoice: boolean,
): string {
	const domainShape = declaration.allowedDomains
		? "allow"
		: declaration.blockedDomains
			? "block"
			: "none";
	const maxUsesShape = declaration.maxUses === undefined ? "none" : "present";

	let locationShape = "absent";
	const userLocation = declaration.userLocation;
	if (userLocation) {
		const locationFields = ["city", "region", "country", "timezone"] as const;
		const bitset = locationFields.reduce(
			(bits, field, index) => bits | (field in userLocation ? 1 << index : 0),
			0,
		);
		locationShape = `fields-${bitset}`;
	}

	return `${WEB_SEARCH_PROFILE_PREFIX}:domains-${domainShape}:max-${maxUsesShape}:location-${locationShape}:client-${hasClientFunctions ? "yes" : "no"}${forcedWebSearchChoice ? ":choice-forced" : ""}`;
}

function buildWebSearchOptionProfileId(
	declaration: WebSearchServerToolDeclaration,
): string {
	const sorted = (values: readonly string[] | undefined) =>
		values === undefined ? null : [...values].sort();
	const location = declaration.userLocation;
	const canonical = JSON.stringify([
		declaration.type,
		declaration.maxUses ?? null,
		sorted(declaration.allowedDomains),
		sorted(declaration.blockedDomains),
		location === undefined
			? null
			: [
					location.type,
					location.city ?? null,
					location.region ?? null,
					location.country ?? null,
					location.timezone ?? null,
				],
	]);
	const digest = createHash("sha256")
		.update(OPTION_PROFILE_DOMAIN, "utf8")
		.update(canonical, "utf8")
		.digest("hex");
	return `${OPTION_PROFILE_PREFIX}${digest}`;
}

function freezeToolSemanticLayers(tool: UnknownRecord): void {
	if (Array.isArray(tool.allowed_domains)) Object.freeze(tool.allowed_domains);
	if (Array.isArray(tool.blocked_domains)) Object.freeze(tool.blocked_domains);
	if (isRecord(tool.user_location)) Object.freeze(tool.user_location);
	Object.freeze(tool);
}

function classifyOpaqueReplayValue(
	value: unknown,
): "native-Anthropic" | "proxy-evidence-v1" | undefined {
	if (typeof value !== "string") return undefined;
	return value.startsWith("bccf") ? "proxy-evidence-v1" : "native-Anthropic";
}

function scanHistoricalReplay(
	messages: unknown,
	requiresOutputReplay: boolean,
	freezeSemanticLayers: boolean,
): ServerToolReplayRequirement {
	let hasNativeInput = false;
	let hasNativeOutput = false;
	let hasProxyOpaqueOutput = false;
	let messageVisits = 0;
	let historyBlockVisits = 0;
	let traversalTruncated = false;
	const recordOpaqueReplay = (value: unknown): boolean => {
		const replayAtom = classifyOpaqueReplayValue(value);
		if (replayAtom === "native-Anthropic") hasNativeOutput = true;
		if (replayAtom === "proxy-evidence-v1") hasProxyOpaqueOutput = true;
		return replayAtom !== undefined;
	};

	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (messageVisits >= MAX_HISTORY_MESSAGE_VISITS) {
				traversalTruncated = true;
				break;
			}
			messageVisits += 1;
			if (!isRecord(message)) continue;
			const messageContent = message.content;
			if (Array.isArray(messageContent)) {
				for (const block of messageContent) {
					if (historyBlockVisits >= MAX_HISTORY_BLOCK_VISITS) {
						traversalTruncated = true;
						break;
					}
					historyBlockVisits += 1;
					if (!isRecord(block)) continue;
					if (block.type === "server_tool_use") hasNativeInput = true;
					if (block.type === "web_search_tool_result") {
						let classifiedOpaqueReplay = false;
						const resultContent = block.content;
						if (Array.isArray(resultContent)) {
							for (const result of resultContent) {
								if (historyBlockVisits >= MAX_HISTORY_BLOCK_VISITS) {
									traversalTruncated = true;
									break;
								}
								historyBlockVisits += 1;
								if (!isRecord(result)) continue;
								if (result.type === "web_search_result") {
									classifiedOpaqueReplay =
										recordOpaqueReplay(result.encrypted_content) ||
										classifiedOpaqueReplay;
								}
								if (freezeSemanticLayers) Object.freeze(result);
							}
							if (freezeSemanticLayers) Object.freeze(resultContent);
						}
						if (!classifiedOpaqueReplay) hasNativeOutput = true;
					}

					const citations = block.citations;
					if (Array.isArray(citations)) {
						for (const citation of citations) {
							if (historyBlockVisits >= MAX_HISTORY_BLOCK_VISITS) {
								traversalTruncated = true;
								break;
							}
							historyBlockVisits += 1;
							if (!isRecord(citation)) continue;
							if (citation.type === "web_search_result_location") {
								recordOpaqueReplay(citation.encrypted_index);
							}
							if (freezeSemanticLayers) Object.freeze(citation);
						}
						if (freezeSemanticLayers) Object.freeze(citations);
					}
					if (freezeSemanticLayers) Object.freeze(block);
				}
			}
			if (freezeSemanticLayers) {
				if (Array.isArray(messageContent)) Object.freeze(messageContent);
				Object.freeze(message);
			}
			if (traversalTruncated) break;
		}
		if (freezeSemanticLayers) Object.freeze(messages);
	}

	if (traversalTruncated) {
		// An uninspected suffix may contain any replay shape. Fail closed by
		// requiring every replay mode instead of silently under-classifying it.
		hasNativeInput = true;
		hasNativeOutput = true;
		hasProxyOpaqueOutput = true;
	}

	const input = freezeReplayAtoms(hasNativeInput, false);
	const output = freezeReplayAtoms(hasNativeOutput, hasProxyOpaqueOutput);

	return Object.freeze({ input, output, requiresOutputReplay });
}

export function deriveServerToolRequirement(
	body: unknown,
	options: DeriveServerToolRequirementOptions = {},
): ServerToolRequirements | undefined {
	const freezeSemanticLayers = options.freezeSemanticLayers === true;
	if (!isRecord(body)) {
		if (freezeSemanticLayers && typeof body === "object" && body !== null) {
			Object.freeze(body);
		}
		return undefined;
	}

	const declarations: WebSearchServerToolDeclaration[] = [];
	const invalid: { type: string; reason: "invalid_options" }[] = [];
	const unsupported: { type: string }[] = [];
	let hasClientFunctions = false;
	let exactDeclarationCount = 0;
	let forcedWebSearchChoice = false;

	const tools = body.tools;
	if (Array.isArray(tools)) {
		for (const tool of tools) {
			if (!isRecord(tool)) continue;
			if (freezeSemanticLayers) freezeToolSemanticLayers(tool);

			if (
				tool.type === undefined &&
				typeof tool.name === "string" &&
				isRecord(tool.input_schema)
			) {
				hasClientFunctions = true;
				continue;
			}
			if (typeof tool.type !== "string") {
				if ("type" in tool) {
					pushBoundedIssue(
						unsupported,
						Object.freeze({ type: UNKNOWN_TYPED_TOOL }),
					);
				}
				continue;
			}

			if (tool.type === EXACT_WEB_SEARCH_TYPE) {
				exactDeclarationCount += 1;
				const declaration = normalizeExactDeclaration(tool);
				if (!declaration) {
					pushBoundedIssue(
						invalid,
						Object.freeze({
							type: EXACT_WEB_SEARCH_TYPE,
							reason: "invalid_options",
						}),
					);
				} else if (exactDeclarationCount === 1) {
					declarations.push(declaration);
				}
			} else {
				pushBoundedIssue(
					unsupported,
					Object.freeze({ type: normalizeRetainedToolType(tool.type) }),
				);
			}
		}
		if (freezeSemanticLayers) Object.freeze(tools);
	}

	if (exactDeclarationCount > 1) {
		declarations.length = 0;
		if (!invalid.some((entry) => entry.type === EXACT_WEB_SEARCH_TYPE)) {
			pushBoundedIssue(
				invalid,
				Object.freeze({
					type: EXACT_WEB_SEARCH_TYPE,
					reason: "invalid_options",
				}),
			);
		}
	}
	const toolChoice = body.tool_choice;
	if (freezeSemanticLayers && isRecord(toolChoice)) {
		Object.freeze(toolChoice);
	}

	if (
		exactDeclarationCount === 1 &&
		declarations.length === 1 &&
		toolChoice !== undefined
	) {
		const isAdmittedAutoChoice =
			isRecord(toolChoice) &&
			hasOnlyKeys(toolChoice, new Set(["type", "disable_parallel_tool_use"])) &&
			toolChoice.type === "auto" &&
			(toolChoice.disable_parallel_tool_use === undefined ||
				toolChoice.disable_parallel_tool_use === false);
		const isAdmittedForcedWebSearchChoice =
			isRecord(toolChoice) &&
			!hasClientFunctions &&
			hasOnlyKeys(toolChoice, new Set(["type", "name"])) &&
			toolChoice.type === "tool" &&
			toolChoice.name === "web_search";
		if (isAdmittedForcedWebSearchChoice) {
			forcedWebSearchChoice = true;
		} else if (!isAdmittedAutoChoice) {
			declarations.length = 0;
			if (!invalid.some((entry) => entry.type === EXACT_WEB_SEARCH_TYPE)) {
				pushBoundedIssue(
					invalid,
					Object.freeze({
						type: EXACT_WEB_SEARCH_TYPE,
						reason: "invalid_options",
					}),
				);
			}
		}
	}

	if (
		exactDeclarationCount === 1 &&
		declarations.length === 1 &&
		body.stream !== undefined &&
		typeof body.stream !== "boolean"
	) {
		declarations.length = 0;
		if (!invalid.some((entry) => entry.type === EXACT_WEB_SEARCH_TYPE)) {
			pushBoundedIssue(
				invalid,
				Object.freeze({
					type: EXACT_WEB_SEARCH_TYPE,
					reason: "invalid_options",
				}),
			);
		}
	}

	const replay = scanHistoricalReplay(
		body.messages,
		declarations.length > 0,
		freezeSemanticLayers,
	);
	if (freezeSemanticLayers) Object.freeze(body);
	if (
		declarations.length === 0 &&
		invalid.length === 0 &&
		unsupported.length === 0 &&
		replay.input.length === 0 &&
		replay.output.length === 0
	) {
		return undefined;
	}

	const requirement: {
		revision: typeof REQUIREMENT_REVISION;
		profileId?: string;
		optionProfileId?: string;
		responseMode?: ServerToolResponseMode;
		mixedToolMode?: ServerToolMixedToolMode;
		hasClientFunctions?: true;
		declarations?: readonly WebSearchServerToolDeclaration[];
		invalid?: readonly {
			readonly type: string;
			readonly reason: "invalid_options";
		}[];
		unsupported?: readonly { readonly type: string }[];
		replay: ServerToolReplayRequirement;
	} = { revision: REQUIREMENT_REVISION, replay };

	const declaration = declarations[0];
	if (declaration !== undefined) {
		requirement.profileId = buildWebSearchProfileId(
			declaration,
			hasClientFunctions,
			forcedWebSearchChoice,
		);
		requirement.optionProfileId = buildWebSearchOptionProfileId(declaration);
		requirement.responseMode = body.stream === true ? "streaming" : "json";
		requirement.mixedToolMode = hasClientFunctions
			? "server_and_client_functions"
			: "server_only";
		requirement.declarations = Object.freeze(declarations);
	}
	if (hasClientFunctions) requirement.hasClientFunctions = true;
	if (invalid.length > 0) requirement.invalid = Object.freeze(invalid);
	if (unsupported.length > 0)
		requirement.unsupported = Object.freeze(unsupported);
	return Object.freeze(requirement);
}

const TUPLE_KEYS = [
	"candidateId",
	"provider",
	"authMode",
	"endpointClass",
	"normalizedEndpoint",
	"model",
	"toolType",
	"profile",
	"optionProfile",
	"responseMode",
	"mixedToolMode",
	"providerContractRevision",
	"replayDecoderRevision",
	"requestTransport",
	"responseTransport",
] as const;
type ServerToolCapabilityTupleStringKey = (typeof TUPLE_KEYS)[number];
const TUPLE_STRING_LIMITS: Readonly<
	Record<ServerToolCapabilityTupleStringKey, number>
> = Object.freeze({
	candidateId: 256,
	provider: 128,
	authMode: 64,
	endpointClass: 128,
	normalizedEndpoint: 2 * 1024,
	model: 512,
	toolType: 128,
	profile: 256,
	optionProfile: 256,
	responseMode: 32,
	mixedToolMode: 64,
	providerContractRevision: 128,
	replayDecoderRevision: 128,
	requestTransport: 128,
	responseTransport: 128,
});
const MAX_PROOF_REVISION_LENGTH = 256;
const MAX_CANONICAL_TUPLE_KEY_BYTES = 8 * 1024;
const SERVER_TOOL_PROOF_KEY_PREFIX = "server-tool-proof-v2.sha256.";
const TUPLE_ALL_KEYS = new Set<PropertyKey>([
	...TUPLE_KEYS,
	"inputReplay",
	"outputReplay",
]);

function serializeCanonicalCapabilityTuple(
	tuple: ServerToolCapabilityTuple,
): string {
	return JSON.stringify([
		"server-tool-capability-tuple-v2",
		...TUPLE_KEYS.map((key) => {
			const value = tuple[key];
			return value === undefined ? null : value;
		}),
		replayAtomBits(tuple.inputReplay),
		replayAtomBits(tuple.outputReplay),
	]);
}

/** Stable canonical identity for every field in one exact capability tuple. */
export function buildServerToolCapabilityTupleKey(
	tuple: ServerToolCapabilityTuple,
): string | undefined {
	const canonicalTuple = snapshotCapabilityTuple(tuple);
	if (canonicalTuple === undefined) return undefined;
	const key = serializeCanonicalCapabilityTuple(canonicalTuple);
	if (key.length > MAX_CANONICAL_TUPLE_KEY_BYTES) return undefined;
	return new TextEncoder().encode(key).byteLength <=
		MAX_CANONICAL_TUPLE_KEY_BYTES
		? key
		: undefined;
}

/** Bind a proof revision to the entire canonical tuple without ambiguity. */
export function buildServerToolCapabilityProofKey(
	proofRevision: string,
	tuple: ServerToolCapabilityTuple,
): string | undefined {
	if (
		typeof proofRevision !== "string" ||
		proofRevision.length === 0 ||
		proofRevision.length > MAX_PROOF_REVISION_LENGTH
	)
		return undefined;
	const canonicalTupleKey = buildServerToolCapabilityTupleKey(tuple);
	if (canonicalTupleKey === undefined) return undefined;
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				"server-tool-capability-proof-v2",
				proofRevision,
				canonicalTupleKey,
			]),
			"utf8",
		)
		.digest("hex");
	return `${SERVER_TOOL_PROOF_KEY_PREFIX}${digest}`;
}

const PROOF_ALLOWED_KEYS = new Set([
	"revision",
	"tuple",
	"decision",
	"provenance",
	"owner",
	"verifiedAt",
	"revalidateAfter",
	"fixtureRevision",
	"contractRevision",
	"revalidationTriggers",
	"supersededBy",
]);

function parseCanonicalUtcInstant(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 32) {
		return undefined;
	}
	const millis = Date.parse(value);
	if (!Number.isFinite(millis)) return undefined;
	try {
		return new Date(millis).toISOString() === value ? millis : undefined;
	} catch {
		return undefined;
	}
}

function snapshotProof(
	proof: ServerToolCapabilityProof,
): ServerToolCapabilityProof | undefined {
	let plainProof: unknown;
	try {
		if (!isPlainDataRecordWithOnlyKeys(proof, PROOF_ALLOWED_KEYS, 11)) {
			return undefined;
		}
		plainProof = snapshotPlainCapabilityData(proof);
	} catch {
		return undefined;
	}
	if (!isRecord(plainProof)) return undefined;
	const tuple = snapshotCapabilityTuple(plainProof.tuple);
	if (tuple === undefined) return undefined;
	const boundedString = (
		value: unknown,
		maximumLength: number,
	): value is string =>
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximumLength;
	const verifiedAt = plainProof.verifiedAt;
	const revalidateAfter = plainProof.revalidateAfter;
	if (
		!boundedString(plainProof.revision, MAX_PROOF_REVISION_LENGTH) ||
		(plainProof.decision !== "proven" &&
			plainProof.decision !== "unsupported") ||
		!boundedString(plainProof.provenance, 256) ||
		!boundedString(plainProof.owner, 256) ||
		!boundedString(verifiedAt, 32) ||
		parseCanonicalUtcInstant(verifiedAt) === undefined ||
		!boundedString(revalidateAfter, 32) ||
		parseCanonicalUtcInstant(revalidateAfter) === undefined ||
		(plainProof.fixtureRevision !== undefined &&
			!boundedString(plainProof.fixtureRevision, 256)) ||
		(plainProof.contractRevision !== undefined &&
			!boundedString(plainProof.contractRevision, 256)) ||
		(plainProof.supersededBy !== undefined &&
			!boundedString(plainProof.supersededBy, 256))
	) {
		return undefined;
	}
	const revalidationTriggers = plainProof.revalidationTriggers;
	if (
		revalidationTriggers !== undefined &&
		(!Array.isArray(revalidationTriggers) ||
			revalidationTriggers.length > 8 ||
			revalidationTriggers.some(
				(trigger) =>
					trigger !== "tuple_change" &&
					trigger !== "contract_change" &&
					trigger !== "decoder_change" &&
					trigger !== "observed_behavior_change",
			))
	) {
		return undefined;
	}
	return Object.freeze({
		revision: plainProof.revision,
		tuple,
		decision: plainProof.decision,
		provenance: plainProof.provenance,
		owner: plainProof.owner,
		verifiedAt,
		revalidateAfter,
		...(plainProof.fixtureRevision === undefined
			? {}
			: { fixtureRevision: plainProof.fixtureRevision }),
		...(plainProof.contractRevision === undefined
			? {}
			: { contractRevision: plainProof.contractRevision }),
		...(revalidationTriggers === undefined ? {} : { revalidationTriggers }),
		...(plainProof.supersededBy === undefined
			? {}
			: { supersededBy: plainProof.supersededBy }),
	});
}

export function indexServerToolCapabilityProofs(
	proofs: readonly ServerToolCapabilityProof[],
): ServerToolCapabilityProofIndex {
	const grouped = new Map<string, ServerToolCapabilityProof[]>();
	for (const sourceProof of proofs) {
		const proof = snapshotProof(sourceProof);
		if (proof === undefined) continue;
		const key = buildServerToolCapabilityTupleKey(proof.tuple);
		if (key === undefined) continue;
		const group = grouped.get(key);
		if (group) group.push(proof);
		else grouped.set(key, [proof]);
	}

	const entries = new Map<string, ServerToolCapabilityProofIndexEntry>();
	for (const [key, group] of grouped) {
		const active = group.filter((proof) => proof.supersededBy === undefined);
		const activeProof = active[0];
		if (active.length === 1 && activeProof !== undefined) {
			entries.set(
				key,
				Object.freeze({ state: "selected", proof: activeProof }),
			);
		} else if (active.length === 0) {
			entries.set(key, Object.freeze({ state: "superseded" }));
		} else {
			entries.set(key, Object.freeze({ state: "ambiguous" }));
		}
	}

	return Object.freeze({
		lookup: (tuple: ServerToolCapabilityTuple) => {
			const key = buildServerToolCapabilityTupleKey(tuple);
			return key === undefined ? undefined : entries.get(key);
		},
	});
}

const REQUIRED_REVALIDATION_TRIGGERS = [
	"tuple_change",
	"contract_change",
	"decoder_change",
	"observed_behavior_change",
] as const;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function hasCompleteProofLifecycle(proof: ServerToolCapabilityProof): boolean {
	if (
		!isNonEmptyString(proof.revision) ||
		!isNonEmptyString(proof.provenance) ||
		!isNonEmptyString(proof.owner) ||
		!isNonEmptyString(proof.fixtureRevision) ||
		!isNonEmptyString(proof.contractRevision) ||
		!Array.isArray(proof.revalidationTriggers) ||
		!REQUIRED_REVALIDATION_TRIGGERS.every((trigger) =>
			proof.revalidationTriggers?.includes(trigger),
		)
	) {
		return false;
	}

	const verifiedAtMillis = parseCanonicalUtcInstant(proof.verifiedAt);
	const revalidateMillis = parseCanonicalUtcInstant(proof.revalidateAfter);
	return (
		verifiedAtMillis !== undefined &&
		revalidateMillis !== undefined &&
		verifiedAtMillis < revalidateMillis
	);
}

const NATIVE_REPLAY_BIT = 1;
const PROXY_REPLAY_BIT = 2;

function freezeReplayAtoms(
	hasNative: boolean,
	hasProxy: boolean,
): readonly ServerToolReplayAtom[] {
	const atoms: ServerToolReplayAtom[] = [];
	if (hasNative) atoms.push("native-Anthropic");
	if (hasProxy) atoms.push("proxy-evidence-v1");
	return Object.freeze(atoms);
}

function replayAtomBits(atoms: unknown): number | undefined {
	if (!Array.isArray(atoms)) return undefined;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(atoms, "length");
	if (
		lengthDescriptor === undefined ||
		!Object.hasOwn(lengthDescriptor, "value") ||
		!Number.isInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > 2
	) {
		return undefined;
	}
	const length = lengthDescriptor.value as number;
	for (const key of Reflect.ownKeys(atoms)) {
		if (typeof key !== "string") return undefined;
		if (key === "length") continue;
		const index = Number(key);
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= length ||
			`${index}` !== key
		)
			return undefined;
	}

	let bits = 0;
	for (let index = 0; index < length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(atoms, `${index}`);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			return undefined;
		}
		const atom = descriptor.value;
		let bit: number;
		switch (atom) {
			case "native-Anthropic":
				bit = NATIVE_REPLAY_BIT;
				break;
			case "proxy-evidence-v1":
				bit = PROXY_REPLAY_BIT;
				break;
			default:
				return undefined;
		}
		if ((bits & bit) !== 0) return undefined;
		bits |= bit;
	}
	return bits;
}

function canonicalizeReplayAtoms(
	atoms: unknown,
): readonly ServerToolReplayAtom[] | undefined {
	const bits = replayAtomBits(atoms);
	if (bits === undefined) return undefined;
	return freezeReplayAtoms(
		(bits & NATIVE_REPLAY_BIT) !== 0,
		(bits & PROXY_REPLAY_BIT) !== 0,
	);
}

const CAPABILITY_ACCOUNT_KEYS = [
	"provider",
	"api_key",
	"refresh_token",
	"access_token",
	"custom_endpoint",
	"cross_region_mode",
	"billing_type",
] as const satisfies readonly (keyof Account)[];

function snapshotCapabilityAccount(
	account: Account,
): ProviderServerToolCapabilityAccountContext {
	if (!isRecord(account)) {
		throw new TypeError("Invalid provider server-tool capability account");
	}
	const source: Partial<
		Record<(typeof CAPABILITY_ACCOUNT_KEYS)[number], unknown>
	> = {};
	for (const key of CAPABILITY_ACCOUNT_KEYS) {
		const descriptor = Object.getOwnPropertyDescriptor(account, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			throw new TypeError(
				`Invalid provider server-tool capability account field ${key}`,
			);
		}
		const value = descriptor.value;
		if (value !== null && typeof value !== "string") {
			throw new TypeError(
				`Invalid provider server-tool capability account field ${key}`,
			);
		}
		source[key] = value;
	}
	const provider = source.provider;
	const apiKey = source.api_key;
	const refreshToken = source.refresh_token;
	const accessToken = source.access_token;
	const customEndpoint = source.custom_endpoint;
	const crossRegionMode = source.cross_region_mode;
	const billingType = source.billing_type;
	if (
		typeof provider !== "string" ||
		provider.length === 0 ||
		provider.length > TUPLE_STRING_LIMITS.provider ||
		(apiKey !== null && typeof apiKey !== "string") ||
		(refreshToken !== null && typeof refreshToken !== "string") ||
		(accessToken !== null && typeof accessToken !== "string") ||
		(customEndpoint !== null && typeof customEndpoint !== "string") ||
		(crossRegionMode !== null &&
			(typeof crossRegionMode !== "string" || crossRegionMode.length > 128)) ||
		(billingType !== null &&
			(typeof billingType !== "string" || billingType.length > 128))
	) {
		throw new TypeError("Invalid provider server-tool capability account");
	}
	// Mirror the transport's raw string truthiness exactly. In particular,
	// whitespace-only values are configured inputs, not absent values.
	const apiKeyConfigured = Boolean(apiKey);
	const refreshTokenConfigured = Boolean(refreshToken);
	const accessTokenConfigured = Boolean(accessToken);
	const customEndpointConfigured = Boolean(customEndpoint);
	const normalizedCustomEndpoint = customEndpointConfigured
		? normalizeCapabilityEndpoint(customEndpoint)
		: undefined;
	const unsafeCustomEndpoint =
		customEndpointConfigured && normalizedCustomEndpoint === undefined;
	return Object.freeze({
		provider,
		apiKeyConfigured,
		refreshTokenConfigured,
		accessTokenConfigured,
		legacyMirroredApiKey:
			apiKeyConfigured &&
			refreshTokenConfigured &&
			accessTokenConfigured &&
			refreshToken === apiKey &&
			accessToken === apiKey,
		customEndpoint: normalizedCustomEndpoint ?? null,
		customEndpointConfigured,
		unsafeCustomEndpoint,
		crossRegionMode,
		billingType,
	});
}

const MAX_CAPABILITY_SNAPSHOT_DEPTH = 12;
const MAX_CAPABILITY_SNAPSHOT_NODES = 256;
const MAX_CAPABILITY_SNAPSHOT_BYTES = 64 * 1024;
const MAX_CAPABILITY_SNAPSHOT_ARRAY_LENGTH = 64;
const MAX_CAPABILITY_SNAPSHOT_OBJECT_KEYS = 32;

interface CapabilitySnapshotState {
	readonly ancestors: WeakSet<object>;
	nodes: number;
	bytes: number;
}

function consumeCapabilitySnapshotString(
	value: string,
	state: CapabilitySnapshotState,
): void {
	const remaining = MAX_CAPABILITY_SNAPSHOT_BYTES - state.bytes;
	// UTF-8 requires at least one byte per UTF-16 code unit. Reject oversized
	// input before scanning so a giant string cannot consume unbounded work.
	if (value.length > remaining) {
		throw new TypeError("Invalid provider server-tool capability context");
	}
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) bytes += 1;
		else if (codeUnit <= 0x7ff) bytes += 2;
		else if (
			codeUnit >= 0xd800 &&
			codeUnit <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index += 1;
		} else bytes += 3;
		if (bytes > remaining) {
			throw new TypeError("Invalid provider server-tool capability context");
		}
	}
	state.bytes += bytes;
}

function snapshotPlainCapabilityData(
	value: unknown,
	state: CapabilitySnapshotState = {
		ancestors: new WeakSet<object>(),
		nodes: 0,
		bytes: 0,
	},
	depth = 0,
): unknown {
	if (
		depth > MAX_CAPABILITY_SNAPSHOT_DEPTH ||
		++state.nodes > MAX_CAPABILITY_SNAPSHOT_NODES
	) {
		throw new TypeError("Invalid provider server-tool capability context");
	}
	if (value === undefined || value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		consumeCapabilitySnapshotString(value, state);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("Invalid provider server-tool capability context");
		}
		return value;
	}
	if (typeof value !== "object" || state.ancestors.has(value)) {
		throw new TypeError("Invalid provider server-tool capability context");
	}
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
			if (
				lengthDescriptor === undefined ||
				!Object.hasOwn(lengthDescriptor, "value") ||
				!Number.isSafeInteger(lengthDescriptor.value) ||
				lengthDescriptor.value < 0 ||
				lengthDescriptor.value > MAX_CAPABILITY_SNAPSHOT_ARRAY_LENGTH
			) {
				throw new TypeError("Invalid provider server-tool capability context");
			}
			const length = lengthDescriptor.value as number;
			const keys = Reflect.ownKeys(value);
			if (keys.length !== length + 1) {
				throw new TypeError("Invalid provider server-tool capability context");
			}
			for (const key of keys) {
				if (typeof key !== "string") {
					throw new TypeError(
						"Invalid provider server-tool capability context",
					);
				}
				if (key === "length") continue;
				const index = Number(key);
				if (
					!Number.isInteger(index) ||
					index < 0 ||
					index >= length ||
					`${index}` !== key
				) {
					throw new TypeError(
						"Invalid provider server-tool capability context",
					);
				}
			}
			const snapshot: unknown[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
				if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
					throw new TypeError(
						"Invalid provider server-tool capability context",
					);
				}
				snapshot.push(
					snapshotPlainCapabilityData(descriptor.value, state, depth + 1),
				);
			}
			return Object.freeze(snapshot);
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Invalid provider server-tool capability context");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length > MAX_CAPABILITY_SNAPSHOT_OBJECT_KEYS) {
			throw new TypeError("Invalid provider server-tool capability context");
		}
		const snapshot: Record<string, unknown> = {};
		for (const key of keys) {
			if (typeof key !== "string") {
				throw new TypeError("Invalid provider server-tool capability context");
			}
			consumeCapabilitySnapshotString(key, state);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
				throw new TypeError("Invalid provider server-tool capability context");
			}
			snapshot[key] = snapshotPlainCapabilityData(
				descriptor.value,
				state,
				depth + 1,
			);
		}
		return Object.freeze(snapshot);
	} finally {
		state.ancestors.delete(value);
	}
}

function normalizeCapabilityEndpoint(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > TUPLE_STRING_LIMITS.normalizedEndpoint
	)
		return undefined;
	if (value.includes("?") || value.includes("#")) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return undefined;
	}
	if (
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		return undefined;
	}
	return `${parsed.origin}${parsed.pathname}`;
}

function snapshotCapabilityTuple(
	value: unknown,
): ServerToolCapabilityTuple | undefined {
	try {
		if (!isRecord(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		for (const key of Reflect.ownKeys(value)) {
			if (!TUPLE_ALL_KEYS.has(key)) return undefined;
		}
		const readOwnValue = (key: PropertyKey): unknown => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor !== undefined && Object.hasOwn(descriptor, "value")
				? descriptor.value
				: undefined;
		};
		const readString = (
			key: (typeof TUPLE_KEYS)[number],
		): string | undefined => {
			const field = readOwnValue(key);
			return typeof field === "string" &&
				field.length > 0 &&
				field.length <= TUPLE_STRING_LIMITS[key]
				? field
				: undefined;
		};
		const candidateId = readString("candidateId");
		const provider = readString("provider");
		const authMode = readString("authMode");
		const endpointClass = readString("endpointClass");
		const model = readString("model");
		const toolType = readString("toolType");
		const profile = readString("profile");
		const optionProfile = readString("optionProfile");
		const responseMode = readString("responseMode");
		const mixedToolMode = readString("mixedToolMode");
		const providerContractRevision = readString("providerContractRevision");
		const replayDecoderRevision = readString("replayDecoderRevision");
		const requestTransport = readString("requestTransport");
		const responseTransport = readString("responseTransport");
		const rawNormalizedEndpoint = readOwnValue("normalizedEndpoint");
		const normalizedEndpoint = normalizeCapabilityEndpoint(
			rawNormalizedEndpoint,
		);
		if (
			candidateId === undefined ||
			provider === undefined ||
			authMode === undefined ||
			endpointClass === undefined ||
			model === undefined ||
			toolType === undefined ||
			profile === undefined ||
			optionProfile === undefined ||
			(responseMode !== "json" && responseMode !== "streaming") ||
			(mixedToolMode !== "server_only" &&
				mixedToolMode !== "server_and_client_functions") ||
			providerContractRevision === undefined ||
			replayDecoderRevision === undefined ||
			requestTransport === undefined ||
			responseTransport === undefined ||
			(rawNormalizedEndpoint !== undefined && normalizedEndpoint === undefined)
		) {
			return undefined;
		}
		const inputReplay = canonicalizeReplayAtoms(readOwnValue("inputReplay"));
		const outputReplay = canonicalizeReplayAtoms(readOwnValue("outputReplay"));
		if (inputReplay === undefined || outputReplay === undefined)
			return undefined;

		return Object.freeze({
			candidateId,
			provider,
			authMode,
			endpointClass,
			...(normalizedEndpoint === undefined ? {} : { normalizedEndpoint }),
			model,
			toolType,
			profile,
			optionProfile,
			responseMode,
			mixedToolMode,
			inputReplay,
			outputReplay,
			providerContractRevision,
			replayDecoderRevision,
			requestTransport,
			responseTransport,
		});
	} catch {
		return undefined;
	}
}

function readDataMember(
	value: object,
	key: PropertyKey,
): { readonly found: boolean; readonly value?: unknown } {
	let owner: object | null = value;
	while (owner !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor !== undefined) {
			if (!Object.hasOwn(descriptor, "value")) {
				throw new TypeError("Invalid provider capability descriptor");
			}
			return { found: true, value: descriptor.value };
		}
		owner = Object.getPrototypeOf(owner);
	}
	return { found: false };
}

function isThenable(value: unknown): boolean {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return false;
	}
	try {
		const then = readDataMember(value, "then");
		return then.found && typeof then.value === "function";
	} catch {
		return true;
	}
}

type ProviderCapabilityMethodName =
	| "createServerToolCapabilityTuple"
	| "resolveServerToolCapability";

interface CapturedProviderCapabilityDescriptor {
	readonly providerName: string;
	readonly method: (...args: never[]) => unknown;
}

function captureProviderCapabilityDescriptor(
	provider: Provider,
	methodName: ProviderCapabilityMethodName,
): CapturedProviderCapabilityDescriptor | undefined {
	if (!isRecord(provider)) {
		throw new TypeError("Invalid provider capability descriptor");
	}
	const methodMember = readDataMember(provider, methodName);
	if (!methodMember.found || methodMember.value === undefined) return undefined;
	if (typeof methodMember.value !== "function") {
		throw new TypeError("Invalid provider capability descriptor");
	}
	const nameMember = readDataMember(provider, "name");
	if (
		!nameMember.found ||
		typeof nameMember.value !== "string" ||
		nameMember.value.length === 0
	) {
		throw new TypeError("Invalid provider capability descriptor");
	}
	return Object.freeze({
		providerName: nameMember.value,
		method: methodMember.value as (...args: never[]) => unknown,
	});
}

function requireStableProviderCapabilityDescriptor(
	provider: Provider,
	methodName: ProviderCapabilityMethodName,
	expected: CapturedProviderCapabilityDescriptor,
): void {
	const current = captureProviderCapabilityDescriptor(provider, methodName);
	if (
		current === undefined ||
		current.providerName !== expected.providerName ||
		current.method !== expected.method
	) {
		throw new TypeError(
			"Provider server-tool capability descriptor changed during planning",
		);
	}
}

const CAPABILITY_CONTEXT_KEYS = new Set<PropertyKey>([
	"candidateId",
	"account",
	"path",
	"query",
	"physicalModel",
	"requirements",
]);
const CAPABILITY_REQUIREMENT_KEYS = new Set([
	"revision",
	"profileId",
	"optionProfileId",
	"responseMode",
	"mixedToolMode",
	"hasClientFunctions",
	"declarations",
	"invalid",
	"unsupported",
	"replay",
]);
const CAPABILITY_REPLAY_REQUIREMENT_KEYS = new Set([
	"input",
	"output",
	"requiresOutputReplay",
]);

function snapshotProviderCapabilityRequirements(
	source: unknown,
): ServerToolRequirements {
	let requirements: ServerToolRequirements;
	try {
		if (
			!isPlainDataRecordWithOnlyKeys(source, CAPABILITY_REQUIREMENT_KEYS, 10)
		) {
			throw new TypeError();
		}
		const replaySource = readOwnDataValue(source, "replay");
		if (
			!isPlainDataRecordWithOnlyKeys(
				replaySource,
				CAPABILITY_REPLAY_REQUIREMENT_KEYS,
				3,
			)
		) {
			throw new TypeError();
		}
		requirements = snapshotPlainCapabilityData(
			source,
		) as ServerToolRequirements;
	} catch {
		throw new TypeError("Invalid provider server-tool capability requirements");
	}
	if (
		!isRecord(requirements) ||
		requirements.revision !== REQUIREMENT_REVISION ||
		!isRecord(requirements.replay) ||
		replayAtomBits(requirements.replay.input) === undefined ||
		replayAtomBits(requirements.replay.output) === undefined ||
		typeof requirements.replay.requiresOutputReplay !== "boolean"
	) {
		throw new TypeError("Invalid provider server-tool capability requirements");
	}
	return requirements;
}

function materializeProviderEndpointContract(
	path: string,
	query: string,
): ProviderServerToolCapabilityEndpointContract {
	let routeClass: ProviderServerToolCapabilityEndpointContract["routeClass"];
	switch (path) {
		case "/v1/messages":
			routeClass = "anthropic_messages";
			break;
		case "/v1/chat/completions":
			routeClass = "openai_chat_completions";
			break;
		case "/v1/responses":
			routeClass = "openai_responses";
			break;
		default:
			routeClass = "other";
	}
	return Object.freeze({ routeClass, queryPresent: query.length > 0 });
}

function snapshotProviderCapabilityContext(
	context: ProviderServerToolCapabilityMaterializationContext,
): ProviderServerToolCapabilityContext {
	if (!isRecord(context)) {
		throw new TypeError("Invalid provider server-tool capability context");
	}
	for (const key of Reflect.ownKeys(context)) {
		if (!CAPABILITY_CONTEXT_KEYS.has(key)) {
			throw new TypeError("Invalid provider server-tool capability context");
		}
	}
	const readOwnValue = (key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(context, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			throw new TypeError("Invalid provider server-tool capability context");
		}
		return descriptor.value;
	};
	const candidateId = readOwnValue("candidateId");
	const account = readOwnValue("account");
	const path = readOwnValue("path");
	const query = readOwnValue("query");
	const physicalModel = readOwnValue("physicalModel");
	const sourceRequirements = readOwnValue("requirements");
	if (
		typeof candidateId !== "string" ||
		candidateId.length === 0 ||
		candidateId.length > TUPLE_STRING_LIMITS.candidateId ||
		!isRecord(account) ||
		typeof path !== "string" ||
		path.length === 0 ||
		typeof query !== "string" ||
		typeof physicalModel !== "string" ||
		physicalModel.length === 0 ||
		physicalModel.length > TUPLE_STRING_LIMITS.model ||
		!isRecord(sourceRequirements)
	) {
		throw new TypeError("Invalid provider server-tool capability context");
	}
	const requirements =
		snapshotProviderCapabilityRequirements(sourceRequirements);
	return Object.freeze({
		candidateId,
		account: snapshotCapabilityAccount(account as unknown as Account),
		endpointContract: materializeProviderEndpointContract(path, query),
		physicalModel,
		requirements,
	});
}

/**
 * Invoke the provider-owned pure tuple seam with a private immutable context.
 * Missing/unsupported/invalid tuple declarations fail closed as undefined.
 */
export function materializeProviderServerToolCapabilityTuple(
	provider: Provider,
	context: ProviderServerToolCapabilityMaterializationContext,
): ServerToolCapabilityTuple | undefined {
	const descriptor = captureProviderCapabilityDescriptor(
		provider,
		"createServerToolCapabilityTuple",
	);
	if (descriptor === undefined) return undefined;
	const planningContext = snapshotProviderCapabilityContext(context);
	const providerName = descriptor.providerName;
	const candidate = Reflect.apply(descriptor.method, provider, [
		planningContext,
	]) as unknown;
	requireStableProviderCapabilityDescriptor(
		provider,
		"createServerToolCapabilityTuple",
		descriptor,
	);
	if (isThenable(candidate)) {
		throw new TypeError(
			"Provider server-tool capability factory must be synchronous",
		);
	}
	if (planningContext.account.unsafeCustomEndpoint) return undefined;
	if (candidate === undefined) return undefined;
	const tuple = snapshotCapabilityTuple(candidate);
	if (
		tuple === undefined ||
		tuple.candidateId !== planningContext.candidateId ||
		tuple.provider !== providerName ||
		tuple.model !== planningContext.physicalModel ||
		(planningContext.account.customEndpointConfigured &&
			tuple.normalizedEndpoint !== planningContext.account.customEndpoint) ||
		buildServerToolCapabilityTupleKey(tuple) === undefined
	) {
		return undefined;
	}
	return tuple;
}

const NO_EXACT_SERVER_TOOL_PROOF: ServerToolCapabilityDecision = Object.freeze({
	decision: "unknown",
	reason: "no_exact_proof",
});
const INVALID_SERVER_TOOL_REQUIREMENT: ServerToolCapabilityDecision =
	Object.freeze({ decision: "unknown", reason: "invalid_requirement" });
const UNSUPPORTED_SERVER_TOOL_REQUIREMENT: ServerToolCapabilityDecision =
	Object.freeze({ decision: "unknown", reason: "unsupported_requirement" });
const MISMATCHED_SERVER_TOOL_REQUIREMENT: ServerToolCapabilityDecision =
	Object.freeze({ decision: "unknown", reason: "requirement_mismatch" });
const SERVER_TOOL_UNKNOWN_REASONS = new Set([
	"no_exact_proof",
	"proof_expired",
	"proof_superseded",
	"proof_incomplete",
	"proof_ambiguous",
	"requirement_mismatch",
	"invalid_requirement",
	"unsupported_requirement",
]);
const SERVER_TOOL_UNKNOWN_DECISION_KEYS = new Set(["decision", "reason"]);
const SERVER_TOOL_PROOF_DECISION_KEYS = new Set(["decision", "proof"]);

/**
 * Invoke the optional provider resolver through the same descriptor-safe,
 * synchronous, exact-tuple boundary used by candidate materialization.
 */
export function materializeProviderServerToolCapabilityDecision(
	provider: Provider,
	requirements: ServerToolRequirements,
	tuple: ServerToolCapabilityTuple,
	now: string = new Date().toISOString(),
): ServerToolCapabilityDecision {
	const canonicalRequirements =
		snapshotProviderCapabilityRequirements(requirements);
	const canonicalTuple = snapshotCapabilityTuple(tuple);
	if (canonicalTuple === undefined) {
		throw new TypeError("Invalid provider server-tool capability tuple");
	}
	if (canonicalRequirements.invalid?.length) {
		return INVALID_SERVER_TOOL_REQUIREMENT;
	}
	if (canonicalRequirements.unsupported?.length) {
		return UNSUPPORTED_SERVER_TOOL_REQUIREMENT;
	}
	if (!tupleMatchesRequirement(canonicalRequirements, canonicalTuple)) {
		return MISMATCHED_SERVER_TOOL_REQUIREMENT;
	}
	const tupleKey = buildServerToolCapabilityTupleKey(canonicalTuple);
	if (tupleKey === undefined) {
		throw new TypeError("Invalid provider server-tool capability tuple");
	}
	const descriptor = captureProviderCapabilityDescriptor(
		provider,
		"resolveServerToolCapability",
	);
	if (descriptor === undefined) return NO_EXACT_SERVER_TOOL_PROOF;
	if (canonicalTuple.provider !== descriptor.providerName) {
		throw new TypeError("Provider server-tool capability identity mismatch");
	}

	let rawDecision: unknown;
	try {
		rawDecision = Reflect.apply(descriptor.method, provider, [
			canonicalRequirements,
			canonicalTuple,
		]);
	} catch {
		throw new TypeError("Provider server-tool capability resolver failed");
	}
	requireStableProviderCapabilityDescriptor(
		provider,
		"resolveServerToolCapability",
		descriptor,
	);
	if (isThenable(rawDecision)) {
		throw new TypeError(
			"Provider server-tool capability resolver must be synchronous",
		);
	}

	if (!isRecord(rawDecision)) {
		throw new TypeError("Invalid provider server-tool capability decision");
	}
	let decisionTag: unknown;
	try {
		decisionTag = readOwnDataValue(rawDecision, "decision");
	} catch {
		throw new TypeError("Invalid provider server-tool capability decision");
	}
	if (decisionTag === "unknown") {
		let reason: unknown;
		try {
			if (
				!isPlainDataRecordWithOnlyKeys(
					rawDecision,
					SERVER_TOOL_UNKNOWN_DECISION_KEYS,
					2,
				)
			) {
				throw new TypeError();
			}
			reason = readOwnDataValue(rawDecision, "reason");
		} catch {
			throw new TypeError("Invalid provider server-tool capability decision");
		}
		if (
			typeof reason !== "string" ||
			!SERVER_TOOL_UNKNOWN_REASONS.has(reason)
		) {
			throw new TypeError("Invalid provider server-tool capability decision");
		}
		return Object.freeze({
			decision: "unknown",
			reason,
		}) as ServerToolCapabilityDecision;
	}
	if (decisionTag !== "proven" && decisionTag !== "unsupported") {
		throw new TypeError("Invalid provider server-tool capability decision");
	}
	let rawProof: unknown;
	try {
		if (
			!isPlainDataRecordWithOnlyKeys(
				rawDecision,
				SERVER_TOOL_PROOF_DECISION_KEYS,
				2,
			)
		) {
			throw new TypeError();
		}
		rawProof = readOwnDataValue(rawDecision, "proof");
	} catch {
		throw new TypeError("Invalid provider server-tool capability decision");
	}
	const proof = snapshotProof(rawProof as unknown as ServerToolCapabilityProof);
	const nowMillis = Date.parse(now);
	const verifiedAtMillis =
		proof === undefined
			? undefined
			: parseCanonicalUtcInstant(proof.verifiedAt);
	const revalidateMillis =
		proof === undefined
			? undefined
			: parseCanonicalUtcInstant(proof.revalidateAfter);
	if (
		proof === undefined ||
		proof.decision !== decisionTag ||
		proof.supersededBy !== undefined ||
		!hasCompleteProofLifecycle(proof) ||
		!Number.isFinite(nowMillis) ||
		verifiedAtMillis === undefined ||
		revalidateMillis === undefined ||
		nowMillis < verifiedAtMillis ||
		nowMillis >= revalidateMillis ||
		buildServerToolCapabilityTupleKey(proof.tuple) !== tupleKey ||
		buildServerToolCapabilityProofKey(proof.revision, proof.tuple) === undefined
	) {
		throw new TypeError("Invalid provider server-tool capability decision");
	}
	return Object.freeze({ decision: decisionTag, proof });
}

function outputReplayCoversRequirement(
	replay: ServerToolReplayRequirement,
	candidateAtoms: readonly ServerToolReplayAtom[],
): boolean {
	const candidateBits = replayAtomBits(candidateAtoms);
	const requiredBits = replayAtomBits(replay.output);
	if (candidateBits === undefined || requiredBits === undefined) return false;
	if (replay.requiresOutputReplay && candidateBits === 0) return false;
	return (candidateBits & requiredBits) === requiredBits;
}

function inputReplayCoversRequirement(
	requiredAtoms: readonly ServerToolReplayAtom[],
	candidateAtoms: readonly ServerToolReplayAtom[],
): boolean {
	const candidateBits = replayAtomBits(candidateAtoms);
	const requiredBits = replayAtomBits(requiredAtoms);
	if (candidateBits === undefined || requiredBits === undefined) return false;
	return (candidateBits & requiredBits) === requiredBits;
}

function tupleMatchesRequirement(
	requirement: ServerToolRequirements,
	tuple: ServerToolCapabilityTuple,
): boolean {
	if (
		!inputReplayCoversRequirement(requirement.replay.input, tuple.inputReplay)
	)
		return false;
	if (!outputReplayCoversRequirement(requirement.replay, tuple.outputReplay))
		return false;

	if (requirement.declarations !== undefined) {
		if (
			requirement.declarations.length !== 1 ||
			requirement.profileId === undefined ||
			requirement.optionProfileId === undefined ||
			requirement.responseMode === undefined ||
			requirement.mixedToolMode === undefined
		)
			return false;
		if (tuple.toolType !== requirement.declarations[0]?.type) return false;
		if (tuple.profile !== requirement.profileId) return false;
		if (tuple.optionProfile !== requirement.optionProfileId) return false;
		if (tuple.responseMode !== requirement.responseMode) return false;
		if (tuple.mixedToolMode !== requirement.mixedToolMode) return false;
	}

	return true;
}

export function resolveServerToolCapability(
	requirement: ServerToolRequirements,
	tuple: ServerToolCapabilityTuple,
	proofIndex: ServerToolCapabilityProofIndex,
	now: string = new Date().toISOString(),
): ServerToolCapabilityDecision {
	if (requirement.revision !== REQUIREMENT_REVISION) {
		return { decision: "unknown", reason: "requirement_mismatch" };
	}
	if (requirement.invalid?.length)
		return { decision: "unknown", reason: "invalid_requirement" };
	if (requirement.unsupported?.length)
		return { decision: "unknown", reason: "unsupported_requirement" };
	if (!tupleMatchesRequirement(requirement, tuple)) {
		return { decision: "unknown", reason: "requirement_mismatch" };
	}

	const entry = proofIndex.lookup(tuple);
	if (!entry) return { decision: "unknown", reason: "no_exact_proof" };
	if (entry.state === "ambiguous")
		return { decision: "unknown", reason: "proof_ambiguous" };
	if (entry.state === "superseded")
		return { decision: "unknown", reason: "proof_superseded" };

	const proof = entry.proof;
	if (!hasCompleteProofLifecycle(proof))
		return { decision: "unknown", reason: "proof_incomplete" };
	if (proof.supersededBy)
		return { decision: "unknown", reason: "proof_superseded" };

	const nowMillis = Date.parse(now);
	const verifiedAtMillis = parseCanonicalUtcInstant(proof.verifiedAt);
	const revalidateMillis = parseCanonicalUtcInstant(proof.revalidateAfter);
	const proofIsFutureDated =
		verifiedAtMillis !== undefined &&
		Number.isFinite(nowMillis) &&
		nowMillis < verifiedAtMillis;
	if (
		!Number.isFinite(nowMillis) ||
		verifiedAtMillis === undefined ||
		revalidateMillis === undefined ||
		nowMillis < verifiedAtMillis ||
		nowMillis >= revalidateMillis
	) {
		return {
			decision: "unknown",
			reason: proofIsFutureDated ? "proof_incomplete" : "proof_expired",
		};
	}

	return { decision: proof.decision, proof };
}
