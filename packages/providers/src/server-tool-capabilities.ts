import type {
	ApproximateUserLocation,
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityProofIndex,
	ServerToolCapabilityProofIndexEntry,
	ServerToolCapabilityTuple,
	ServerToolReplayAtom,
	ServerToolReplayRequirement,
	ServerToolRequirements,
	WebSearchServerToolDeclaration,
} from "@better-ccflare/types";

export type {
	ApproximateUserLocation,
	ServerToolCapabilityDecision,
	ServerToolCapabilityProof,
	ServerToolCapabilityProofIndex,
	ServerToolCapabilityProofIndexEntry,
	ServerToolCapabilityTuple,
	ServerToolReplayAtom,
	ServerToolReplayRequirement,
	ServerToolRequirements,
	WebSearchServerToolDeclaration,
} from "@better-ccflare/types";

const EXACT_WEB_SEARCH_TYPE = "web_search_20250305" as const;
const REQUIREMENT_REVISION = 1 as const;
const MAX_DOMAINS = 10;
const MAX_DOMAIN_LENGTH = 8 * 1024;
const MAX_LOCATION_VALUE_LENGTH = 256;
const MAX_ISSUE_RECORDS = 8;
const MAX_RETAINED_TOOL_TYPE_LENGTH = 128;
const WEB_SEARCH_PROFILE_PREFIX = "web-search-20250305-v1" as const;
const UNKNOWN_TYPED_TOOL = "unknown_typed_tool" as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: UnknownRecord,
	allowed: ReadonlySet<string>,
): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
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

	return `${WEB_SEARCH_PROFILE_PREFIX}:domains-${domainShape}:max-${maxUsesShape}:location-${locationShape}:client-${hasClientFunctions ? "yes" : "no"}`;
}

function scanHistoricalReplay(
	messages: unknown,
	requiresOutputReplay: boolean,
): ServerToolReplayRequirement {
	let hasNativeInput = false;
	let hasNativeOutput = false;
	let hasProxyOpaqueOutput = false;

	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (!isRecord(message) || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "server_tool_use") hasNativeInput = true;
				if (block.type === "web_search_tool_result") hasNativeOutput = true;
				if (block.type === "x_better_ccflare_server_tool")
					hasProxyOpaqueOutput = true;
			}
		}
	}

	const input = freezeReplayAtoms(hasNativeInput, false);
	const output = freezeReplayAtoms(hasNativeOutput, hasProxyOpaqueOutput);

	return Object.freeze({ input, output, requiresOutputReplay });
}

export function deriveServerToolRequirement(
	body: unknown,
): ServerToolRequirements | undefined {
	if (!isRecord(body)) return undefined;

	const declarations: WebSearchServerToolDeclaration[] = [];
	const invalid: { type: string; reason: "invalid_options" }[] = [];
	const unsupported: { type: string }[] = [];
	let hasClientFunctions = false;
	let exactDeclarationCount = 0;

	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (!isRecord(tool)) continue;

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

	if (
		exactDeclarationCount === 1 &&
		declarations.length === 1 &&
		body.tool_choice !== undefined
	) {
		const toolChoice = body.tool_choice;
		const isAdmittedAutoChoice =
			isRecord(toolChoice) &&
			hasOnlyKeys(toolChoice, new Set(["type", "disable_parallel_tool_use"])) &&
			toolChoice.type === "auto" &&
			(toolChoice.disable_parallel_tool_use === undefined ||
				toolChoice.disable_parallel_tool_use === false);
		if (!isAdmittedAutoChoice) {
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

	const replay = scanHistoricalReplay(body.messages, declarations.length > 0);
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
		);
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
	"providerContractRevision",
	"replayDecoderRevision",
	"requestTransport",
	"responseTransport",
] as const;

function tupleKey(tuple: ServerToolCapabilityTuple): string | undefined {
	const inputReplayBits = replayAtomBits(tuple.inputReplay);
	const outputReplayBits = replayAtomBits(tuple.outputReplay);
	if (inputReplayBits === undefined || outputReplayBits === undefined)
		return undefined;

	return JSON.stringify([
		...TUPLE_KEYS.map((key) => {
			const value = tuple[key];
			return value === undefined ? null : value;
		}),
		inputReplayBits,
		outputReplayBits,
	]);
}

function snapshotProof(
	proof: ServerToolCapabilityProof,
): ServerToolCapabilityProof | undefined {
	const inputReplay = canonicalizeReplayAtoms(proof.tuple.inputReplay);
	const outputReplay = canonicalizeReplayAtoms(proof.tuple.outputReplay);
	if (inputReplay === undefined || outputReplay === undefined) return undefined;

	return Object.freeze({
		...proof,
		tuple: Object.freeze({ ...proof.tuple, inputReplay, outputReplay }),
		...(proof.revalidationTriggers === undefined
			? {}
			: {
					revalidationTriggers: Object.freeze([...proof.revalidationTriggers]),
				}),
	});
}

export function indexServerToolCapabilityProofs(
	proofs: readonly ServerToolCapabilityProof[],
): ServerToolCapabilityProofIndex {
	const grouped = new Map<string, ServerToolCapabilityProof[]>();
	for (const sourceProof of proofs) {
		const proof = snapshotProof(sourceProof);
		if (proof === undefined) continue;
		const key = tupleKey(proof.tuple);
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
			const key = tupleKey(tuple);
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

	const verifiedAtMillis = Date.parse(proof.verifiedAt);
	const revalidateMillis = Date.parse(proof.revalidateAfter);
	return (
		Number.isFinite(verifiedAtMillis) &&
		Number.isFinite(revalidateMillis) &&
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

function replayAtomBits(
	atoms: readonly ServerToolReplayAtom[],
): number | undefined {
	if (!Array.isArray(atoms)) return undefined;

	let bits = 0;
	for (const atom of atoms) {
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
	atoms: readonly ServerToolReplayAtom[],
): readonly ServerToolReplayAtom[] | undefined {
	const bits = replayAtomBits(atoms);
	if (bits === undefined) return undefined;
	return freezeReplayAtoms(
		(bits & NATIVE_REPLAY_BIT) !== 0,
		(bits & PROXY_REPLAY_BIT) !== 0,
	);
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
			requirement.profileId === undefined
		)
			return false;
		if (tuple.toolType !== requirement.declarations[0]?.type) return false;
		if (tuple.profile !== requirement.profileId) return false;
	}

	return true;
}

export function resolveServerToolCapability(
	requirement: ServerToolRequirements,
	tuple: ServerToolCapabilityTuple,
	proofIndex: ServerToolCapabilityProofIndex,
	now: string = new Date().toISOString(),
): ServerToolCapabilityDecision {
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
	const revalidateMillis = Date.parse(proof.revalidateAfter);
	if (
		!Number.isFinite(nowMillis) ||
		!Number.isFinite(revalidateMillis) ||
		nowMillis >= revalidateMillis
	) {
		return { decision: "unknown", reason: "proof_expired" };
	}

	return { decision: proof.decision, proof };
}
