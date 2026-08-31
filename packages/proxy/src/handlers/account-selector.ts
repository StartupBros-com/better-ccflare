import type {
	ImplicitFallbackPolicyConfig,
	ModelScopedCapacityRoutingMode,
} from "@better-ccflare/config";
import {
	getConfiguredModelMapping,
	getModelFamily,
	getModelList,
	isAccountAvailable,
	isOfficialXaiEndpoint,
	providerAcceptsClientModel,
	resolveEffectiveComboMembership,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Provider } from "@better-ccflare/providers";
import {
	buildServerToolCapabilityProofKey,
	canonicalizeBetaSignature,
	deriveComboRouteClass,
	materializeProviderServerToolCapabilityDecision,
	materializeProviderServerToolCapabilityTuple,
	resolveAccountLogicalModelCapability,
	resolveProviderForAccount,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	AccountQuotaPressure,
	AffinityOwnerDirective,
	ComboFamily,
	ComboMembershipSource,
	ComboRouteClass,
	ComboRoutingPolicySnapshot,
	ComboSlotInfo,
	RequestMeta,
	RoutingCandidateMetadata,
	RoutingCandidateServerToolCapability,
	RoutingCandidateServerToolCapabilityReason,
	RoutingSelectionDiagnostics,
	ServerToolCapabilityTuple,
	ServerToolRoutingCapabilitySummary,
} from "@better-ccflare/types";
import { isNativeAnthropicOAuthDegradedModeEligible } from "../anthropic-degraded-eligibility";
import type {
	AnthropicDegradedRouteInspection,
	AnthropicReplayRisk,
} from "../anthropic-degraded-mode";
import { getKnownCodexModels } from "../codex-model-catalog";
import { evaluateServerToolReplayEligibility } from "../server-tool-replay-eligibility";
import {
	ServerToolRoutingError,
	type ServerToolRoutingErrorReason,
} from "../server-tool-routing-errors";
import { buildComboMembershipDiagnostics } from "./managed-routing-diagnostics";
import {
	emitPoolFloorEvent,
	poolFloorApproachingThreshold,
} from "./pool-floor-event";
import { isInternalProbe, type ProxyContext } from "./proxy-types";
import { boundedRoutingSelectionCount } from "./routing-selection-diagnostics";
import {
	evaluateHardCapacity,
	getWeeklyQuotaPressure,
	type HardCapacityExclusion,
} from "./usage-throttling";

const log = new Logger("AccountSelector");

const STOCK_CLAUDE_FAMILY_ALIASES = new Set([
	"fable",
	"opus",
	"sonnet",
	"haiku",
]);

export function isForceAccountModelEnabled(ctx: ProxyContext): boolean {
	return ctx.config?.getForceAccountModel?.() ?? false;
}

function isClaudeModelId(model: string): boolean {
	return getModelFamily(model) !== null;
}

/**
 * Route-profile constraints are server-derived metadata, distinct from public
 * force-account routes. Every executable mapping candidate must remain within
 * the profile's one expected physical model; an array is a fallback list, not
 * an allowed model set.
 */
export function getRouteProfileConstraintViolation(
	account: Account,
	meta: Pick<
		RequestMeta,
		| "routeProfileId"
		| "routeProfileSelection"
		| "routeExpectedProvider"
		| "routeExpectedPhysicalModel"
		| "routeProfileExpectedPhysicalModel"
	>,
	logicalModel: string | null | undefined,
	concretePhysicalModel?: string | null,
): "provider_mismatch" | "model_mapping_mismatch" | null {
	if (!meta.routeProfileId?.trim()) return null;

	const expectedProvider = meta.routeExpectedProvider?.trim().toLowerCase();
	if (
		expectedProvider &&
		account.provider.trim().toLowerCase() !== expectedProvider
	) {
		return "provider_mismatch";
	}

	const expectedPhysicalModel = meta.routeExpectedPhysicalModel?.trim();
	if (!expectedPhysicalModel) return null;

	const candidates =
		concretePhysicalModel !== undefined
			? [concretePhysicalModel]
			: logicalModel?.trim()
				? (() => {
						const mapped = getModelList(logicalModel, account);
						return mapped && mapped.length > 0 ? mapped : [logicalModel];
					})()
				: [];
	return candidates.length > 0 &&
		candidates.every(
			(candidate) =>
				typeof candidate === "string" &&
				candidate.trim() === expectedPhysicalModel,
		)
		? null
		: "model_mapping_mismatch";
}

/**
 * The ordinary-pool integrity fence is intentionally narrow. It covers the
 * stock logical Claude IDs (plus their supported bare family aliases), but
 * leaves custom logical IDs on their existing routing contract.
 */
function isStockClaudeModelOrFamilyAlias(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	return (
		STOCK_CLAUDE_FAMILY_ALIASES.has(normalized) ||
		(normalized.startsWith("claude-") && getModelFamily(normalized) !== null)
	);
}

function hasActualAgentPreferenceRewrite(meta: RequestMeta): boolean {
	return (
		meta.agentUsed != null &&
		meta.originalModel != null &&
		meta.appliedModel != null &&
		meta.originalModel !== meta.appliedModel
	);
}

/**
 * Ordinary stock-model traffic may only enter the pool through a route that
 * preserves the client model. Configured mappings are allowed only when every
 * candidate is the same model after trim; provider defaults never establish
 * this admission, because they can represent a provider-side rewrite.
 *
 * Unknown/undeclared providers intentionally remain eligible when they have
 * no explicit mapping so existing representation adapters retain their native
 * pass-through behavior.
 */
function isOrdinaryStockModelAccountEligible(
	account: Account,
	model: string,
): boolean {
	const requestedModel = model.trim();
	const configured = getConfiguredModelMapping(requestedModel, account);
	if (configured) {
		return (
			configured.models.length > 0 &&
			configured.models.every(
				(candidate) => candidate.trim() === requestedModel,
			)
		);
	}

	try {
		return (
			resolveAccountLogicalModelCapability(account, requestedModel)
				.provenance !== "provider_default"
		);
	} catch {
		// This selector has historically admitted unknown provider adapters. A
		// malformed/third-party capability declaration must not turn that into a
		// new exclusion in the absence of an explicit changing mapping.
		return true;
	}
}

function accountServesModel(account: Account, model: string): boolean {
	const known =
		account.provider === "codex" ? getKnownCodexModels(account.id) : null;
	if (known) return known.models.some((entry) => entry.id === model);
	return (
		providerAcceptsClientModel(account.provider) === isClaudeModelId(model)
	);
}

const PRESSURE_RANK = {
	cold: 0,
	steady: 1,
	warm: 2,
	hot: 3,
	urgent: 4,
	critical: 5,
} as const;

const IMPLICIT_FALLBACK_DIAGNOSTIC_INTERVAL_MS = 60_000;
let implicitFallbackDiagnosticLastLoggedAt = 0;

export {
	buildComboMembershipDiagnostics,
	type ComboMembershipDiagnostics,
	type ComboMembershipDiagnosticsSelection,
} from "./managed-routing-diagnostics";

/** Higher comparable pressure is consumed first; incomparable lanes stay stable. */
function compareCandidatePressure(
	a: AccountQuotaPressure | null,
	b: AccountQuotaPressure | null,
): number {
	if (
		!a ||
		!b ||
		a.comparisonKey === null ||
		b.comparisonKey === null ||
		a.comparisonKey !== b.comparisonKey
	) {
		return 0;
	}
	return PRESSURE_RANK[b.band] - PRESSURE_RANK[a.band];
}

function normalCandidateMetadata(
	account: Account,
	ordinal: number,
	model: string | null,
	quotaPressure: AccountQuotaPressure | null = null,
): RoutingCandidateMetadata {
	return {
		candidateId: `account:${account.id}`,
		accountId: account.id,
		tier: account.priority,
		ordinal,
		comboSlotId: null,
		modelOverride: model,
		quotaPressure,
	};
}

function capacityDeferredCandidateId(accountId: string, model: string): string {
	return `capacity-deferred:${encodeURIComponent(accountId)}:${encodeURIComponent(
		model.trim().toLowerCase(),
	)}`;
}

function capacityDeferredCandidateMetadata(
	account: Account,
	ordinal: number,
	model: string,
): RoutingCandidateMetadata {
	return {
		...normalCandidateMetadata(account, ordinal, model),
		candidateId: capacityDeferredCandidateId(account.id, model),
	};
}

function splitRequestTarget(target: string): { path: string; query: string } {
	const queryIndex = target.indexOf("?");
	if (queryIndex < 0) return { path: target || "/", query: "" };
	return {
		path: target.slice(0, queryIndex) || "/",
		query: target.slice(queryIndex + 1),
	};
}

/**
 * Preview only physical models already proven by existing pure configuration
 * seams. Provider defaults intentionally remain unknown until a provider owns
 * an exact preview contract; guessing here could bind proof to a model transport
 * later rewrites.
 */
function previewCandidatePhysicalModel(
	account: Account,
	logicalModel: string,
	provider: Provider,
): string | null {
	const configured = getConfiguredModelMapping(logicalModel, account);
	if (configured) {
		const first = configured.models[0];
		return typeof first === "string" && first.trim().length > 0
			? first.trim()
			: null;
	}
	try {
		const capability = provider.getLogicalModelCapability?.(
			logicalModel,
			account,
		);
		return capability?.status === "supported" &&
			capability.provenance === "native_passthrough" &&
			logicalModel.trim().length > 0
			? logicalModel.trim()
			: null;
	} catch {
		return null;
	}
}

function freezeReplayMode<T extends readonly string[]>(mode: T): T {
	return Object.freeze([...mode]) as unknown as T;
}

function unknownCandidateCapability(input: {
	resolvedProvider: string | null;
	physicalModel: string | null;
	reason: RoutingCandidateServerToolCapabilityReason;
	inputReplayMode?: ServerToolCapabilityTuple["inputReplay"];
	outputReplayMode?: ServerToolCapabilityTuple["outputReplay"];
}): RoutingCandidateServerToolCapability {
	return Object.freeze({
		resolvedProvider: input.resolvedProvider,
		physicalModel: input.physicalModel,
		decision: "unknown",
		reason: input.reason,
		proofKey: null,
		inputReplayMode: freezeReplayMode(input.inputReplayMode ?? []),
		outputReplayMode: freezeReplayMode(input.outputReplayMode ?? []),
		replayRuntimeStatus: "not_required",
	});
}

function validateProviderCapabilityDecision(
	decision: ReturnType<typeof materializeProviderServerToolCapabilityDecision>,
	tuple: ServerToolCapabilityTuple,
	requirements: NonNullable<RequestMeta["serverToolRequirements"]>,
	ctx: ProxyContext,
): RoutingCandidateServerToolCapability {
	const base = {
		resolvedProvider: tuple.provider,
		physicalModel: tuple.model,
		inputReplayMode: tuple.inputReplay,
		outputReplayMode: tuple.outputReplay,
	};
	if (requirements.invalid?.length) {
		return unknownCandidateCapability({
			...base,
			reason: "invalid_requirement",
		});
	}
	if (requirements.unsupported?.length) {
		return unknownCandidateCapability({
			...base,
			reason: "unsupported_requirement",
		});
	}
	if (decision.decision === "unknown") {
		return unknownCandidateCapability({
			...base,
			reason: decision.reason,
		});
	}
	const proof = decision.proof;
	const proofKey = buildServerToolCapabilityProofKey(proof.revision, tuple);
	if (proofKey === undefined)
		throw new TypeError("Invalid capability proof key");
	const runtimeStatus =
		decision.decision === "proven"
			? evaluateServerToolReplayEligibility(
					requirements,
					tuple.inputReplay,
					tuple.outputReplay,
					ctx.serverToolReplay,
				).status
			: "not_required";
	return Object.freeze({
		resolvedProvider: tuple.provider,
		physicalModel: tuple.model,
		decision: decision.decision,
		reason: null,
		proofKey,
		inputReplayMode: freezeReplayMode(tuple.inputReplay),
		outputReplayMode: freezeReplayMode(tuple.outputReplay),
		replayRuntimeStatus: runtimeStatus,
	});
}

function evaluateCandidateServerToolCapability(input: {
	account: Account;
	routing: RoutingCandidateMetadata;
	logicalModel: string | null;
	physicalModel?: string;
	meta: RequestMeta;
	ctx: ProxyContext;
}): RoutingCandidateServerToolCapability | undefined {
	const requirements = input.meta.serverToolRequirements;
	if (!requirements) return undefined;
	const provider = resolveProviderForAccount(
		input.account.provider,
		input.ctx.provider,
	);
	if (!provider) {
		return unknownCandidateCapability({
			resolvedProvider: null,
			physicalModel: null,
			reason: "provider_unavailable",
		});
	}
	if (!input.logicalModel) {
		return unknownCandidateCapability({
			resolvedProvider: input.account.provider,
			physicalModel: null,
			reason: "physical_model_unavailable",
		});
	}
	const physicalModel =
		input.physicalModel ??
		previewCandidatePhysicalModel(input.account, input.logicalModel, provider);
	if (!physicalModel) {
		return unknownCandidateCapability({
			resolvedProvider: input.account.provider,
			physicalModel: null,
			reason: "physical_model_unavailable",
		});
	}
	const requestTarget = splitRequestTarget(input.meta.path);
	const capabilityQuery =
		requestTarget.query.length > 0
			? requestTarget.query
			: input.meta.serverToolQueryPresent === true
				? "present"
				: "";
	let tuple: ServerToolCapabilityTuple | undefined;
	try {
		tuple = materializeProviderServerToolCapabilityTuple(provider, {
			candidateId: input.routing.candidateId,
			account: input.account,
			path: requestTarget.path,
			query: capabilityQuery,
			physicalModel,
			requirements,
		});
	} catch {
		return unknownCandidateCapability({
			resolvedProvider: input.account.provider,
			physicalModel,
			reason: "tuple_unavailable",
		});
	}
	if (!tuple) {
		return unknownCandidateCapability({
			resolvedProvider: input.account.provider,
			physicalModel,
			reason: "tuple_unavailable",
		});
	}
	try {
		const decision = materializeProviderServerToolCapabilityDecision(
			provider,
			requirements,
			tuple,
		);
		return validateProviderCapabilityDecision(
			decision,
			tuple,
			requirements,
			input.ctx,
		);
	} catch {
		return unknownCandidateCapability({
			resolvedProvider: tuple.provider,
			physicalModel,
			reason: "invalid_resolver_result",
			inputReplayMode: tuple.inputReplay,
			outputReplayMode: tuple.outputReplay,
		});
	}
}

function isServerToolCandidateSemanticallyEligible(
	candidate: RoutingCandidateMetadata,
): boolean {
	const capability = candidate.serverToolCapability;
	return (
		capability?.decision === "proven" &&
		capability.proofKey !== null &&
		(capability.replayRuntimeStatus === "not_required" ||
			capability.replayRuntimeStatus === "ready")
	);
}

function publishServerToolCapabilitySummary(
	meta: RequestMeta,
	catalog: readonly RoutingCandidateMetadata[],
	transientlyEligibleCandidateIds: ReadonlySet<string>,
): ServerToolRoutingCapabilitySummary | undefined {
	if (!meta.serverToolRequirements) {
		meta.serverToolCapabilitySummary = undefined;
		return undefined;
	}
	let provenCandidateCount = 0;
	let unsupportedCandidateCount = 0;
	let unknownCandidateCount = 0;
	let replayIneligibleCandidateCount = 0;
	let semanticallyEligibleCandidateCount = 0;
	for (const candidate of catalog) {
		const capability = candidate.serverToolCapability;
		if (capability?.decision === "proven") {
			provenCandidateCount += 1;
			if (
				capability.replayRuntimeStatus === "input_unavailable" ||
				capability.replayRuntimeStatus === "output_unavailable"
			) {
				replayIneligibleCandidateCount += 1;
			} else {
				semanticallyEligibleCandidateCount += 1;
			}
		} else if (capability?.decision === "unsupported") {
			unsupportedCandidateCount += 1;
		} else {
			unknownCandidateCount += 1;
		}
	}
	const eligibleCandidateCount = transientlyEligibleCandidateIds.size;
	const summary = Object.freeze({
		structuralCandidateCount: catalog.length,
		provenCandidateCount,
		unsupportedCandidateCount,
		unknownCandidateCount,
		replayIneligibleCandidateCount,
		temporarilyUnavailableProvenCandidateCount: Math.max(
			0,
			semanticallyEligibleCandidateCount - eligibleCandidateCount,
		),
		eligibleCandidateCount,
	});
	meta.serverToolCapabilitySummary = summary;
	return summary;
}

function capabilityPoolErrorReason(
	meta: RequestMeta,
	summary: ServerToolRoutingCapabilitySummary,
): ServerToolRoutingErrorReason {
	if (meta.serverToolRequirements?.invalid?.length)
		return "invalid_requirement";
	if (meta.serverToolRequirements?.unsupported?.length)
		return "unsupported_requirement";
	if (summary.provenCandidateCount === 0) return "no_implementation";
	if (summary.provenCandidateCount === summary.replayIneligibleCandidateCount) {
		return "replay_unavailable";
	}
	return "temporary_unavailable";
}

/**
 * Returns an account id only when it came from the public force-route surface.
 * Route profiles carry a private configured account UUID that must remain
 * server-side even when server-tool routing fails before transport.
 */
export function getClientVisibleServerToolAccountId(
	meta: Pick<RequestMeta, "routeProfileId">,
	accountId: string | undefined,
): string | undefined {
	return meta.routeProfileId == null ? accountId : undefined;
}

function throwServerToolCapabilityPoolError(meta: RequestMeta): never {
	const summary = meta.serverToolCapabilitySummary;
	if (!summary) {
		throw new ServerToolRoutingError({
			reason: "no_implementation",
			requestedToolTypes: meta.serverToolRequirements?.declarations?.map(
				(d) => d.type,
			),
		});
	}
	throw new ServerToolRoutingError({
		reason: capabilityPoolErrorReason(meta, summary),
		capabilitySummary: summary,
		requestedToolTypes: meta.serverToolRequirements?.declarations?.map(
			(d) => d.type,
		),
	});
}

function serverToolSelectionFailure(meta: RequestMeta): ServerToolRoutingError {
	return new ServerToolRoutingError({
		reason: "temporary_unavailable",
		capabilitySummary: meta.serverToolCapabilitySummary,
	});
}

export type ForceRouteUnavailableReason =
	| "account_capacity_exhausted"
	| "conflicting_force_route"
	| "lookup_failed"
	| "model_capacity_exhausted"
	| "model_mapping_mismatch"
	| "not_found"
	| "paused"
	| "provider_excluded"
	| "provider_mismatch"
	| "rate_limited_or_unavailable";

/** Thrown when an explicit one-account route cannot use its target. */
export class ForceRouteUnavailableError extends Error {
	readonly accountId: string;
	readonly reason: ForceRouteUnavailableReason;

	constructor(accountId: string, reason: ForceRouteUnavailableReason) {
		super(`Force-routed account unavailable: ${reason}`);
		this.name = "ForceRouteUnavailableError";
		this.accountId = accountId;
		this.reason = reason;
	}
}

// Module-level WeakMap to store combo slot info per RequestMeta
const comboSlotInfoMap = new WeakMap<RequestMeta, ComboSlotInfo>();

export interface RoutingCapacityBlocker {
	readonly source: "usage_snapshot" | "reactive_marker";
	readonly scope: "account" | "family" | "model";
	readonly window: string;
	readonly windowKind:
		| "session"
		| "weekly_all"
		| "weekly_scoped"
		| "reactive_model"
		| "reactive_family";
	readonly modelFamily: string | null;
	readonly utilization: number | null;
	readonly resetAtMs: number | null;
	readonly evidenceExpiresAt: number;
}

export interface RoutingCapacityCandidateExclusion {
	readonly accountId: string;
	readonly accountName: string;
	readonly model: string;
	readonly modelFamily: string | null;
	readonly source: "normal" | "force" | "combo";
	readonly comboSlotId: string | null;
	readonly comboSlotOrdinal: number | null;
	/** This candidate can be reconsidered only after all simultaneous blockers clear. */
	readonly blockedUntil: number | null;
	readonly exclusions: readonly RoutingCapacityBlocker[];
}

export interface RoutingCapacityContext {
	readonly effectiveModel: string | null;
	readonly effectiveModelFamily: string | null;
	readonly exclusions: readonly RoutingCapacityCandidateExclusion[];
	/** Earliest known recovery among capacity-excluded candidates. */
	readonly blockedUntil: number | null;
}

/** Exact account/model routes deferred when the requested lane is capacity-blocked. */
export interface CapacityDeferredModelRoute {
	readonly account: Account;
	readonly model: string;
	readonly candidateId: string;
	readonly fallbackRank: number;
	readonly familyOccurrence: number | null;
}

export interface AccountSelectionOptions {
	/** Bypass active combo lookup for the explicit post-combo normal fallback. */
	readonly skipCombo?: boolean;
	/** Ignore request-reactive model/family markers for a trusted synthetic probe. */
	readonly syntheticProbe?: boolean;
	/**
	 * U3 supplies the capture-once replay/cohort inspection computed before
	 * selection. Account selection owns materializing the typed directive before
	 * the strategy can mutate affinity.
	 */
	readonly degradedOwner?: DegradedOwnerSelectionContext;
}

export interface DegradedOwnerSelectionContext {
	readonly inspection: AnthropicDegradedRouteInspection;
	readonly requestKind: AnthropicReplayRisk["kind"];
	/** Reports the actual/enforce or hypothetical/observe owner decision. */
	readonly onDecision?: (decision: AffinityOwnerDirective | null) => void;
}

/** Request-local capacity evidence retained for terminal classification. */
const routingCapacityContextMap = new WeakMap<
	RequestMeta,
	RoutingCapacityContext
>();

/** Request-local capacity fallback plan consumed by the proxy route executor. */
const capacityDeferredModelRoutesMap = new WeakMap<
	RequestMeta,
	readonly CapacityDeferredModelRoute[]
>();

/** Retrieve request-local hard-capacity evidence (null before selection). */
export function getRoutingCapacityContext(
	meta: RequestMeta,
): RoutingCapacityContext | null {
	return routingCapacityContextMap.get(meta) ?? null;
}

export function getCapacityDeferredModelRoutes(
	meta: RequestMeta,
): readonly CapacityDeferredModelRoute[] {
	return capacityDeferredModelRoutesMap.get(meta) ?? [];
}

/** Store combo slot info on a RequestMeta for downstream consumption */
export function setComboSlotInfo(meta: RequestMeta, info: ComboSlotInfo): void {
	comboSlotInfoMap.set(meta, info);
}

/** Retrieve combo slot info from a RequestMeta (null if not combo-routed) */
export function getComboSlotInfo(meta: RequestMeta): ComboSlotInfo | null {
	return comboSlotInfoMap.get(meta) ?? null;
}

// xAI cache-native conversation affinity is request-local at this seam and
// process-wide only for confirmed account ownership. Keeping this side channel
// separate from RequestMeta preserves the existing metadata shape.
const xaiConvIdMap = new WeakMap<RequestMeta, string>();

export function setXaiConvId(meta: RequestMeta, convId: string): void {
	xaiConvIdMap.set(meta, convId);
}

export function getXaiConvId(meta: RequestMeta): string | null {
	return xaiConvIdMap.get(meta) ?? null;
}

// Deliberately kept even though our fork replaced upstream's model-capacity.ts
// module wholesale (see account-selector's hard-capacity system below): this
// one flag is an unrelated, additive combo-isolation safety valve with no
// equivalent in our fork's hard-capacity system. The legacy environment value
// is adopted into config once at boot; request-time routing has one authority.
export function isComboSessionFallbackDisabled(ctx: ProxyContext): boolean {
	return ctx.config?.getComboSessionFallback?.() === false;
}

/**
 * Resolves the model that should drive account routing: the agent
 * interceptor's applied (post-rewrite) model when it modified the request,
 * falling back to the original client-requested model otherwise. Routing
 * must see the model that will actually be sent upstream — combo routing
 * and family-based selection would otherwise match against a model the
 * outgoing request no longer carries.
 */
export function resolveEffectiveModel(
	appliedModel: string | null | undefined,
	requestModel: string | null | undefined,
): string | null {
	return appliedModel ?? requestModel ?? null;
}

function normalizePath(path: string): string {
	const withoutQuery = path.split("?", 1)[0]?.trim().toLowerCase() ?? "";
	if (!withoutQuery) return "/";
	return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function getProtocolFamily(path: string): string {
	if (path.endsWith("/responses")) return "responses";
	if (path.endsWith("/messages")) return "messages";
	if (path.endsWith("/chat/completions")) return "chat-completions";
	return "other";
}

/**
 * Construct the pre-selection owner lane. The client-visible beta signature is
 * canonicalized before inclusion so header ordering cannot split ownership.
 */
export function deriveAffinityLaneKey(
	meta: RequestMeta,
	effectiveModel: string | null,
): string | null {
	const session = meta.clientSessionId?.trim();
	const model = effectiveModel?.trim().toLowerCase();
	if (!session || !model) return null;
	const path = normalizePath(meta.path);
	const family = getModelFamily(model) ?? "unknown";
	const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
	const legacyLane = [
		"routing-lane-v1",
		session,
		getProtocolFamily(path),
		path,
		family,
		model,
		beta,
	] as const;
	const routeProfileId = meta.routeProfileId?.trim();
	if (!routeProfileId) return JSON.stringify(legacyLane);
	if (meta.routeLineage?.kind === "descendant") {
		if (!meta.routeLineage.childHomeKey) return null;
		return JSON.stringify([
			"routing-lane-profile-child-v1",
			routeProfileId,
			meta.routeLineage.childHomeKey,
			...legacyLane.slice(1),
		]);
	}
	// Profile-scoped lanes intentionally use a distinct version/tag. This keeps
	// the long-standing ordinary-traffic JSON shape/indexes stable while making
	// capability pools unable to inherit an owner retained by a native lane.
	return JSON.stringify([
		"routing-lane-profile-v1",
		routeProfileId,
		...legacyLane.slice(1),
	]);
}

function getBillingClass(account: Account): string | null {
	const explicit = account.billing_type?.trim().toLowerCase();
	if (explicit) return explicit;
	// OAuth subscription accounts historically store NULL billing_type. Their
	// credential shape is stable enough to compare accounts from the same
	// provider without treating unknown API-key accounts as subscriptions.
	if (account.refresh_token?.trim() && !account.api_key) {
		return "oauth-subscription";
	}
	return null;
}

function snapshotBlocker(
	exclusion: HardCapacityExclusion,
): RoutingCapacityBlocker {
	return {
		source: "usage_snapshot",
		scope: exclusion.scope,
		window: exclusion.window,
		windowKind: exclusion.windowKind,
		modelFamily: exclusion.modelFamily,
		utilization: exclusion.utilization,
		resetAtMs: exclusion.resetAtMs,
		evidenceExpiresAt: exclusion.evidenceExpiresAt,
	};
}

/**
 * Look up exact model+client-beta direct failure evidence in one place. Family
 * markers can extend this helper without duplicating selector paths.
 */
export function getReactiveModelCapacityBlocker(
	accountId: string,
	model: string,
	betaSignature: string,
	now: number,
): RoutingCapacityBlocker | null {
	const marker = usageCache.getModelScopedExhaustion(
		accountId,
		model,
		betaSignature,
		now,
	);
	if (marker) {
		return {
			source: "reactive_marker",
			scope: "model",
			window: "reactive_model",
			windowKind: "reactive_model",
			modelFamily: getModelFamily(model),
			utilization: null,
			resetAtMs: marker.expiresAt,
			evidenceExpiresAt: marker.expiresAt,
		};
	}

	const familyMarker = usageCache.getFamilyScopedExhaustion(
		accountId,
		model,
		now,
	);
	if (!familyMarker) return null;
	return {
		source: "reactive_marker",
		scope: "family",
		window: "reactive_family",
		windowKind: "reactive_family",
		modelFamily: familyMarker.family,
		utilization: null,
		resetAtMs: familyMarker.expiresAt,
		evidenceExpiresAt: familyMarker.expiresAt,
	};
}

interface CandidateCapacityEvaluation {
	readonly blockers: readonly RoutingCapacityBlocker[];
	readonly blockedUntil: number | null;
	readonly quotaPressure: AccountQuotaPressure | null;
}

type CapacityRouteIntent = "ordinary" | "capability" | "combo" | "force";

interface CandidateCapacityEvaluationOptions {
	readonly modelScopedCapacityRouting: ModelScopedCapacityRoutingMode;
	readonly routeIntent: CapacityRouteIntent;
	readonly syntheticProbe: boolean;
}

function getModelScopedCapacityRoutingMode(
	ctx: ProxyContext,
): ModelScopedCapacityRoutingMode {
	return ctx.config?.getModelScopedCapacityRouting?.() ?? "off";
}

function enforcesModelScopedCapacity(
	options: CandidateCapacityEvaluationOptions,
): boolean {
	return (
		options.modelScopedCapacityRouting === "exhausted" ||
		options.routeIntent === "force"
	);
}

function evaluateCandidateCapacity(
	account: Account,
	model: string,
	betaSignature: string,
	now: number,
	options: CandidateCapacityEvaluationOptions,
): CandidateCapacityEvaluation {
	const snapshot = usageCache.getSnapshot(account.id);
	const blockers: RoutingCapacityBlocker[] = [];
	let quotaPressure: AccountQuotaPressure | null = null;
	const enforceModelScopedCapacity = enforcesModelScopedCapacity(options);

	if (snapshot) {
		const hardCapacity = evaluateHardCapacity(snapshot.data, {
			requestModel: model,
			observedAt: snapshot.observedAt,
			provider: account.provider,
			now,
		});
		blockers.push(
			...hardCapacity.exclusions
				.filter(
					(exclusion) =>
						exclusion.scope === "account" || enforceModelScopedCapacity,
				)
				.map(snapshotBlocker),
		);

		const pressure = getWeeklyQuotaPressure(snapshot.data, {
			requestModel: model,
			observedAt: snapshot.observedAt,
			provider: account.provider,
			billingClass: getBillingClass(account),
			now,
		});
		if (pressure) {
			const comparator = pressure.comparator;
			const comparisonKey =
				comparator.provider && comparator.billingClass
					? [
							"authoritative-usage-v1",
							comparator.provider,
							comparator.billingClass,
							comparator.windowKind,
							pressure.modelFamily ?? "all",
						].join(":")
					: null;
			quotaPressure = {
				band: pressure.band,
				comparisonKey,
			};
		}
	}

	if (!options.syntheticProbe && enforceModelScopedCapacity) {
		const reactive = getReactiveModelCapacityBlocker(
			account.id,
			model,
			betaSignature,
			now,
		);
		if (reactive) blockers.push(reactive);
	}

	return {
		blockers,
		blockedUntil:
			blockers.length === 0
				? null
				: Math.max(...blockers.map((blocker) => blocker.evidenceExpiresAt)),
		quotaPressure,
	};
}

function resolveCapacityDeferredRoutes(
	account: Account,
	requestedModel: string,
	betaSignature: string,
	now: number,
	capacityOptions: CandidateCapacityEvaluationOptions,
): {
	readonly routes: readonly {
		readonly model: string;
		readonly fallbackRank: number;
		readonly familyOccurrence: number | null;
	}[];
	readonly blocked: readonly {
		readonly model: string;
		readonly evaluation: CandidateCapacityEvaluation;
	}[];
} {
	const requestedFamily = getModelFamily(requestedModel);
	const configuredModels = getModelList(requestedModel, account);
	if (!configuredModels || configuredModels.length < 2) {
		return { routes: [], blocked: [] };
	}

	const requestedFamilyRoutes: Array<{
		model: string;
		fallbackRank: number;
		familyOccurrence: number | null;
	}> = [];
	const fallbackRoutes: Array<{
		model: string;
		fallbackRank: number;
		familyOccurrence: number | null;
	}> = [];
	const blocked: Array<{
		model: string;
		evaluation: CandidateCapacityEvaluation;
	}> = [];
	let deferredFallbackRank = 0;
	const familyOccurrences = new Map<string, number>();
	for (const candidateModel of configuredModels.slice(1)) {
		const candidateFamily = getModelFamily(candidateModel);
		const familyOccurrence = candidateFamily
			? (familyOccurrences.get(candidateFamily) ?? 0)
			: null;
		if (candidateFamily) {
			familyOccurrences.set(candidateFamily, (familyOccurrence ?? 0) + 1);
		}
		const isRequestedFamilySibling =
			requestedFamily !== null && candidateFamily === requestedFamily;
		const fallbackRank = isRequestedFamilySibling ? 0 : deferredFallbackRank++;
		const evaluation = evaluateCandidateCapacity(
			account,
			candidateModel,
			betaSignature,
			now,
			capacityOptions,
		);
		if (evaluation.blockers.length === 0) {
			const route = { model: candidateModel, fallbackRank, familyOccurrence };
			if (isRequestedFamilySibling) {
				requestedFamilyRoutes.push(route);
			} else {
				fallbackRoutes.push(route);
			}
			continue;
		}
		blocked.push({ model: candidateModel, evaluation });
	}
	return { routes: [...requestedFamilyRoutes, ...fallbackRoutes], blocked };
}

function candidateExclusion(
	account: Account,
	model: string,
	evaluation: CandidateCapacityEvaluation,
	source: RoutingCapacityCandidateExclusion["source"],
	comboSlotId: string | null = null,
	comboSlotOrdinal: number | null = null,
): RoutingCapacityCandidateExclusion {
	return {
		accountId: account.id,
		accountName: account.name,
		model,
		modelFamily: getModelFamily(model),
		source,
		comboSlotId,
		comboSlotOrdinal,
		blockedUntil: evaluation.blockedUntil,
		exclusions: evaluation.blockers,
	};
}

/** Throttle state for the pool-floor alarm, keyed by lane and severity. */
const poolFloorAlarmState = new Map<string, number>();

function saveCapacityContext(
	meta: RequestMeta,
	effectiveModel: string | null,
	exclusions: readonly RoutingCapacityCandidateExclusion[],
	/**
	 * Pool sizes for the alarm, when the caller knows them but `meta` does not.
	 *
	 * The force-route path deliberately leaves `routingCandidateCatalog` and
	 * `routingCandidates` null (it never builds a catalog), so reading them here
	 * would report an unknown pool and silently skip the alarm on exactly the
	 * path that produces route_unavailable. Telemetry only — passing counts here
	 * does not write routing state.
	 */
	poolCounts?: { before: number | null; after: number | null },
): void {
	const now = Date.now();
	const futureRecoveries = exclusions
		.map((entry) => entry.blockedUntil)
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value) && value > now,
		);
	const effectiveModelFamily = effectiveModel
		? getModelFamily(effectiveModel)
		: null;
	routingCapacityContextMap.set(meta, {
		effectiveModel,
		effectiveModelFamily,
		exclusions,
		blockedUntil:
			futureRecoveries.length > 0 ? Math.min(...futureRecoveries) : null,
	});

	// Every path that excludes candidates for capacity funnels through here, so
	// this is the one place the pool-floor alarm can see both the pool and the
	// evidence that shrank it. Telemetry only — nothing below affects routing.
	emitPoolFloorEvent(log, poolFloorAlarmState, {
		lane: effectiveModel,
		modelFamily: effectiveModelFamily,
		candidatesBefore: poolCounts
			? poolCounts.before
			: (meta.routingCandidateCatalog?.length ?? null),
		candidatesAfter: poolCounts
			? poolCounts.after
			: (meta.routingCandidates?.length ?? null),
		exclusions,
		now,
		approachingThreshold: poolFloorApproachingThreshold(
			process.env.CCFLARE_POOL_FLOOR_THRESHOLD,
		),
	});
}

function prepareNormalRoutingMetadata(
	meta: RequestMeta,
	ctx: ProxyContext,
	accounts: Account[],
	effectiveModel: string | null,
	capacityOptions: CandidateCapacityEvaluationOptions,
	priorServerToolCatalog: readonly RoutingCandidateMetadata[] = [],
): Account[] {
	meta.affinityLaneKey = deriveAffinityLaneKey(meta, effectiveModel);
	if (meta.serverToolRequirements) {
		const normalCatalog = accounts.map((account, ordinal) => {
			const routing = normalCandidateMetadata(account, ordinal, effectiveModel);
			routing.serverToolCapability = evaluateCandidateServerToolCapability({
				account,
				routing,
				logicalModel: effectiveModel,
				meta,
				ctx,
			});
			return routing;
		});
		const now = Date.now();
		const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
		const preliminaryExcludedIds = new Set<string>();
		const preliminaryQuotaPressure = new Map<string, AccountQuotaPressure>();
		const preliminaryExclusions: RoutingCapacityCandidateExclusion[] = [];
		const eligibleAccounts: Account[] = [];
		const eligibleCandidateIds = new Set<string>();
		for (const [ordinal, account] of accounts.entries()) {
			const candidate = normalCatalog[ordinal];
			if (!candidate || !isServerToolCandidateSemanticallyEligible(candidate)) {
				continue;
			}
			// Preserve pressure ordering and degraded-owner inspection without
			// publishing a route. SessionStrategy still receives every proven
			// candidate so only its reset-qualified path can reactivate a pause;
			// availability and capacity are authoritatively rechecked afterward.
			if (effectiveModel) {
				const evaluation = evaluateCandidateCapacity(
					account,
					effectiveModel,
					beta,
					now,
					capacityOptions,
				);
				candidate.quotaPressure = evaluation.quotaPressure;
				if (evaluation.quotaPressure) {
					preliminaryQuotaPressure.set(account.id, evaluation.quotaPressure);
				}
				if (evaluation.blockers.length > 0) {
					preliminaryExcludedIds.add(account.id);
					preliminaryExclusions.push(
						candidateExclusion(account, effectiveModel, evaluation, "normal"),
					);
				}
			}
			eligibleAccounts.push(account);
			eligibleCandidateIds.add(candidate.candidateId);
		}
		const catalog = [...priorServerToolCatalog, ...normalCatalog];
		meta.hardExcludedAccountIds =
			preliminaryExcludedIds.size > 0 ? preliminaryExcludedIds : null;
		meta.quotaPressureByAccountId =
			preliminaryQuotaPressure.size > 0 ? preliminaryQuotaPressure : null;
		capacityDeferredModelRoutesMap.set(meta, []);
		meta.routingCandidateCatalog = catalog;
		meta.routingCandidates = normalCatalog.filter((candidate) =>
			eligibleCandidateIds.has(candidate.candidateId),
		);
		saveCapacityContext(meta, effectiveModel, preliminaryExclusions);
		publishServerToolCapabilitySummary(meta, catalog, eligibleCandidateIds);
		if (eligibleAccounts.length === 0) {
			throwServerToolCapabilityPoolError(meta);
		}
		return eligibleAccounts;
	}
	if (!effectiveModel) {
		capacityDeferredModelRoutesMap.set(meta, []);
		meta.hardExcludedAccountIds = null;
		meta.quotaPressureByAccountId = null;
		meta.routingCandidateCatalog = accounts.map((account, ordinal) =>
			normalCandidateMetadata(account, ordinal, null),
		);
		meta.routingCandidates = meta.routingCandidateCatalog;
		saveCapacityContext(meta, null, []);
		return accounts;
	}

	const now = Date.now();
	const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
	const excludedIds = new Set<string>();
	const quotaPressure = new Map<string, AccountQuotaPressure>();
	const exclusions: RoutingCapacityCandidateExclusion[] = [];
	const deferredRoutes: CapacityDeferredModelRoute[] = [];
	for (const account of accounts) {
		const evaluation = evaluateCandidateCapacity(
			account,
			effectiveModel,
			beta,
			now,
			capacityOptions,
		);
		if (evaluation.blockers.length > 0) {
			excludedIds.add(account.id);
			exclusions.push(
				candidateExclusion(account, effectiveModel, evaluation, "normal"),
			);
			const accountWide = evaluation.blockers.some(
				(blocker) => blocker.scope === "account",
			);
			const fallback =
				accountWide || !isAccountAvailable(account)
					? { routes: [], blocked: [] }
					: resolveCapacityDeferredRoutes(
							account,
							effectiveModel,
							beta,
							now,
							capacityOptions,
						);
			for (const blocked of fallback.blocked) {
				exclusions.push(
					candidateExclusion(
						account,
						blocked.model,
						blocked.evaluation,
						"normal",
					),
				);
			}
			for (const route of fallback.routes) {
				deferredRoutes.push({
					account,
					model: route.model,
					candidateId: capacityDeferredCandidateId(account.id, route.model),
					fallbackRank: route.fallbackRank,
					familyOccurrence: route.familyOccurrence,
				});
			}
			continue;
		}
		if (evaluation.quotaPressure) {
			quotaPressure.set(account.id, evaluation.quotaPressure);
		}
	}
	meta.hardExcludedAccountIds = excludedIds.size > 0 ? excludedIds : null;
	meta.quotaPressureByAccountId = quotaPressure.size > 0 ? quotaPressure : null;
	capacityDeferredModelRoutesMap.set(meta, deferredRoutes);
	meta.routingCandidateCatalog = accounts.map((account, ordinal) =>
		normalCandidateMetadata(
			account,
			ordinal,
			effectiveModel,
			quotaPressure.get(account.id) ?? null,
		),
	);
	meta.routingCandidates = meta.routingCandidateCatalog.filter(
		(candidate) => !excludedIds.has(candidate.accountId),
	);
	saveCapacityContext(meta, effectiveModel, exclusions);
	return accounts.filter((account) => !excludedIds.has(account.id));
}

function finalizeNormalServerToolRoutingMetadata(
	meta: RequestMeta,
	ctx: ProxyContext,
	orderedAccounts: readonly Account[],
	effectiveModel: string | null,
	capacityOptions: CandidateCapacityEvaluationOptions,
): Account[] {
	const baseCatalog = meta.routingCandidateCatalog ?? [];
	const normalCatalog = baseCatalog.filter(
		(candidate) =>
			candidate.comboSlotId === null &&
			candidate.candidateId === `account:${candidate.accountId}`,
	);
	const candidateByAccountId = new Map(
		normalCatalog.map((candidate) => [candidate.accountId, candidate]),
	);
	const now = Date.now();
	const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
	const excludedIds = new Set<string>();
	const quotaPressure = new Map<string, AccountQuotaPressure>();
	const exclusions: RoutingCapacityCandidateExclusion[] = [];
	const deferredCatalog: RoutingCandidateMetadata[] = [];
	const deferredRoutes: CapacityDeferredModelRoute[] = [];
	const eligibleAccounts: Account[] = [];
	const eligibleCandidateIds = new Set<string>();
	const seenAccountIds = new Set<string>();

	for (const account of orderedAccounts) {
		if (seenAccountIds.has(account.id)) continue;
		seenAccountIds.add(account.id);
		const candidate = candidateByAccountId.get(account.id);
		if (
			!candidate ||
			!isServerToolCandidateSemanticallyEligible(candidate) ||
			!isAccountAvailable(account)
		) {
			continue;
		}

		if (effectiveModel) {
			const evaluation = evaluateCandidateCapacity(
				account,
				effectiveModel,
				beta,
				now,
				capacityOptions,
			);
			candidate.quotaPressure = evaluation.quotaPressure;
			if (evaluation.quotaPressure) {
				quotaPressure.set(account.id, evaluation.quotaPressure);
			}
			if (evaluation.blockers.length > 0) {
				excludedIds.add(account.id);
				exclusions.push(
					candidateExclusion(account, effectiveModel, evaluation, "normal"),
				);
				const accountWide = evaluation.blockers.some(
					(blocker) => blocker.scope === "account",
				);
				const fallback = accountWide
					? { routes: [], blocked: [] }
					: resolveCapacityDeferredRoutes(
							account,
							effectiveModel,
							beta,
							now,
							capacityOptions,
						);
				for (const blocked of fallback.blocked) {
					exclusions.push(
						candidateExclusion(
							account,
							blocked.model,
							blocked.evaluation,
							"normal",
						),
					);
				}
				for (const route of [...fallback.routes, ...fallback.blocked]) {
					const routing = capacityDeferredCandidateMetadata(
						account,
						normalCatalog.length + deferredCatalog.length,
						route.model,
					);
					routing.serverToolCapability = evaluateCandidateServerToolCapability({
						account,
						routing,
						logicalModel: route.model,
						physicalModel: route.model,
						meta,
						ctx,
					});
					deferredCatalog.push(routing);
					if (
						"fallbackRank" in route &&
						isServerToolCandidateSemanticallyEligible(routing)
					) {
						deferredRoutes.push({
							account,
							model: route.model,
							candidateId: routing.candidateId,
							fallbackRank: route.fallbackRank,
							familyOccurrence: route.familyOccurrence,
						});
						eligibleCandidateIds.add(routing.candidateId);
					}
				}
				continue;
			}
		}

		eligibleAccounts.push(account);
		eligibleCandidateIds.add(candidate.candidateId);
	}

	const catalog = [...baseCatalog, ...deferredCatalog];
	meta.hardExcludedAccountIds = excludedIds.size > 0 ? excludedIds : null;
	meta.quotaPressureByAccountId = quotaPressure.size > 0 ? quotaPressure : null;
	capacityDeferredModelRoutesMap.set(meta, deferredRoutes);
	meta.routingCandidateCatalog = catalog;
	meta.routingCandidates = normalCatalog.filter((candidate) =>
		eligibleCandidateIds.has(candidate.candidateId),
	);
	saveCapacityContext(meta, effectiveModel, exclusions);
	publishServerToolCapabilitySummary(meta, catalog, eligibleCandidateIds);
	if (eligibleAccounts.length === 0 && deferredRoutes.length === 0) {
		throwServerToolCapabilityPoolError(meta);
	}
	return eligibleAccounts;
}

function captureAffinityOwnerSnapshot(
	meta: RequestMeta,
	ctx: ProxyContext,
): void {
	if (meta.affinityOwnerSnapshot !== undefined) return;
	meta.affinityOwnerSnapshot =
		ctx.strategy.snapshotAffinityOwner?.(meta) ?? null;
}

function findNativeAnthropicOAuthOwner(
	owner: NonNullable<RequestMeta["affinityOwnerSnapshot"]>,
	meta: RequestMeta,
	accounts: readonly Account[],
): Account | null {
	const ownerCandidate = meta.routingCandidateCatalog?.find(
		(candidate) =>
			candidate.candidateId === owner.candidateId &&
			candidate.accountId === owner.accountId,
	);
	const candidateStillConfigured =
		ownerCandidate !== undefined &&
		(!meta.serverToolRequirements ||
			isServerToolCandidateSemanticallyEligible(ownerCandidate));
	if (
		!candidateStillConfigured ||
		meta.hardExcludedAccountIds?.has(owner.accountId)
	) {
		return null;
	}
	const account = accounts.find(
		(candidate) => candidate.id === owner.accountId,
	);
	return account &&
		!account.paused &&
		isNativeAnthropicOAuthDegradedModeEligible(account)
		? account
		: null;
}

function hasOnlyNativeAnthropicOAuthCandidates(
	meta: RequestMeta,
	accounts: readonly Account[],
): boolean {
	const candidates = meta.routingCandidates ?? [];
	if (candidates.length === 0) return false;
	const accountsById = new Map(
		accounts.map((account) => [account.id, account]),
	);
	return candidates.every((candidate) => {
		const account = accountsById.get(candidate.accountId);
		return (
			account !== undefined &&
			!account.paused &&
			!meta.hardExcludedAccountIds?.has(account.id) &&
			isNativeAnthropicOAuthDegradedModeEligible(account)
		);
	});
}

function hasNativeAnthropicOAuthCandidate(
	meta: RequestMeta,
	accounts: readonly Account[],
): boolean {
	const candidates = meta.routingCandidates ?? [];
	if (candidates.length === 0) return false;
	const accountsById = new Map(
		accounts.map((account) => [account.id, account]),
	);
	return candidates.some((candidate) => {
		const account = accountsById.get(candidate.accountId);
		return (
			account !== undefined &&
			!account.paused &&
			!meta.hardExcludedAccountIds?.has(account.id) &&
			isNativeAnthropicOAuthDegradedModeEligible(account)
		);
	});
}

function materializeDegradedOwnerDirective(
	meta: RequestMeta,
	ctx: ProxyContext,
	accounts: readonly Account[],
	context: DegradedOwnerSelectionContext | undefined,
): void {
	if (!context) {
		meta.affinityOwnerDirective = null;
		return;
	}
	const { inspection, requestKind } = context;
	const mode = ctx.anthropicDegradedMode.config.mode;
	if (mode === "off") {
		meta.affinityOwnerDirective = null;
		return;
	}
	if (!hasNativeAnthropicOAuthCandidate(meta, accounts)) {
		meta.affinityOwnerDirective = null;
		return;
	}
	captureAffinityOwnerSnapshot(meta, ctx);
	const observeOnly = mode === "observe";
	const overlay = observeOnly
		? ctx.degradedOwnerShadowOverlay
		: ctx.degradedOwnerOverlay;
	const publish = (decision: AffinityOwnerDirective | null): void => {
		try {
			context.onDecision?.(decision);
		} catch {
			// Observability cannot affect account selection.
		}
		meta.affinityOwnerDirective = observeOnly ? null : decision;
	};
	const laneKey = meta.affinityLaneKey ?? null;
	let prospectiveOwner = overlay.peekRetainedOwner(
		laneKey,
		inspection.cohortKey,
	);
	if (
		prospectiveOwner &&
		!findNativeAnthropicOAuthOwner(prospectiveOwner, meta, accounts)
	) {
		if (laneKey && inspection.cohortKey) {
			overlay.invalidateOwner(laneKey, inspection.cohortKey);
		}
		prospectiveOwner = null;
	}
	prospectiveOwner ??= meta.affinityOwnerSnapshot ?? null;
	if (prospectiveOwner) {
		if (!findNativeAnthropicOAuthOwner(prospectiveOwner, meta, accounts)) {
			publish(null);
			return;
		}
	} else if (!hasOnlyNativeAnthropicOAuthCandidates(meta, accounts)) {
		publish(null);
		return;
	}

	const recoveringUntil =
		inspection.detail.state === "recovering"
			? inspection.detail.recoveringUntil
			: undefined;
	const directive = overlay.materializeDirective({
		laneKey,
		cohortKey: inspection.cohortKey,
		state: inspection.state,
		requestKind,
		owner: meta.affinityOwnerSnapshot ?? null,
		enforced: true,
		recoveringUntil,
	});

	if (directive?.kind !== "retain-owner") {
		publish(directive);
		return;
	}

	if (findNativeAnthropicOAuthOwner(directive.owner, meta, accounts)) {
		publish(directive);
		return;
	}

	if (laneKey && inspection.cohortKey) {
		overlay.invalidateOwner(laneKey, inspection.cohortKey);
	}
	publish(null);
}

/**
 * Gets accounts ordered by the load balancing strategy
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @returns Array of ordered accounts
 */
function setXaiCacheEligibleAccounts(
	meta: RequestMeta,
	accounts: Account[],
): void {
	if (!meta.xaiCacheNativeActive) return;
	meta.xaiCacheEligibleAccountIds = new Set(
		accounts
			.filter(
				(account) =>
					account.provider === "xai" && isOfficialXaiEndpoint(account),
			)
			.map((account) => account.id),
	);
}

function applyXaiCacheAffinity(
	accounts: Account[],
	meta: RequestMeta,
	ctx: ProxyContext,
): Account[] {
	return ctx.cacheAffinityOrderer?.order(accounts, meta) ?? accounts;
}

function getExcludedProviders(meta: RequestMeta): readonly string[] {
	return (
		meta.headers
			?.get("x-better-ccflare-exclude-providers")
			?.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean) ?? []
	);
}

function isProviderExcludedForRequest(
	account: Account,
	excludeProviders: readonly string[],
): boolean {
	for (const excluded of excludeProviders) {
		if (excluded === "anthropic-oauth") {
			if (account.provider === "anthropic" && account.refresh_token != null) {
				return true;
			}
		} else if (account.provider === excluded) {
			return true;
		}
	}
	return false;
}

/**
 * Profile-only accounts are reserved for an active configured exact route.
 * `forcedAccountId` is server-derived for profiles, so a public force header
 * alone cannot satisfy this gate.
 */
function isAccountEligibleForRouteIntent(
	account: Account,
	meta: RequestMeta,
	ctx: ProxyContext,
): boolean {
	const registry = ctx.modelRouteSessionRegistry;
	if (!registry?.isProfileOnlyAccount(account.id)) return true;
	const profileId = meta.routeProfileId?.trim();
	const forcedAccountId = meta.forcedAccountId?.trim();
	return (
		profileId !== undefined &&
		forcedAccountId === account.id &&
		registry.isExactProfileRouteForAccount(profileId, account.id)
	);
}

export type ImplicitFallbackPolicyDecisionReason =
	| "off"
	| "allowed"
	| "denied"
	| "unknown";

export interface ImplicitFallbackPolicyDecision {
	readonly allowed: boolean;
	readonly routeClass: ComboRouteClass | null;
	readonly reason: ImplicitFallbackPolicyDecisionReason;
}

const IMPLICIT_FALLBACK_POLICY_OFF: ImplicitFallbackPolicyConfig =
	Object.freeze({
		mode: "off",
		allowedClasses: Object.freeze([]),
		deniedClasses: Object.freeze([]),
	});

/**
 * Pure account admission predicate for implicit normal/combo fallback. The
 * route class is derived from the provider's existing credential-shape rules;
 * no billing status or provider price assumptions are made here.
 */
export function evaluateImplicitFallbackPolicy(
	account: Account,
	policy: ImplicitFallbackPolicyConfig,
): ImplicitFallbackPolicyDecision {
	const routeClass = deriveComboRouteClass(account);
	if (policy.mode === "off") {
		return { allowed: true, routeClass, reason: "off" };
	}
	if (routeClass === null) {
		return {
			allowed: policy.mode !== "enforce",
			routeClass: null,
			reason: "unknown",
		};
	}
	if (policy.allowedClasses.includes(routeClass)) {
		return { allowed: true, routeClass, reason: "allowed" };
	}
	if (policy.deniedClasses.includes(routeClass)) {
		return { allowed: false, routeClass, reason: "denied" };
	}
	return { allowed: true, routeClass, reason: "allowed" };
}

export function isImplicitFallbackAccountAllowed(
	account: Account,
	policy: ImplicitFallbackPolicyConfig,
): boolean {
	return evaluateImplicitFallbackPolicy(account, policy).allowed;
}

function setImplicitFallbackSelectionDiagnostics(
	meta: RequestMeta,
	policy: ImplicitFallbackPolicyConfig,
	structuralCandidateCount: number,
	eligibleCandidateCount: number,
): void {
	if (policy.mode === "off" || structuralCandidateCount <= 0) return;
	const structural = boundedRoutingSelectionCount(structuralCandidateCount);
	const eligible = Math.min(
		structural,
		boundedRoutingSelectionCount(eligibleCandidateCount),
	);
	const existing = meta.routingSelectionDiagnostics;
	const forcedRoute =
		meta.forcedAccountId != null ||
		meta.headers?.has("x-better-ccflare-account-id") === true;
	const exactPolicyExclusion = policy.mode === "enforce" && eligible === 0;
	const diagnostics: RoutingSelectionDiagnostics = {
		mode: policy.mode,
		structuralCandidateCount: structural,
		eligibleCandidateCount: eligible,
		excludedCandidateCount: structural - eligible,
		selectedCandidateCount: existing?.selectedCandidateCount ?? 0,
		zeroAttemptReason: exactPolicyExclusion
			? "policy_excluded"
			: "all_unavailable",
		forcedRoute,
		capabilityProfile: meta.routeProfileSelection === "capability",
		routeProfile: meta.routeProfileId != null,
	};
	meta.routingSelectionDiagnostics = diagnostics;
}

function finalizeSelectionDiagnostics(
	meta: RequestMeta,
	selectedCandidateCount: number,
): void {
	const existing = meta.routingSelectionDiagnostics;
	if (!existing) return;
	meta.routingSelectionDiagnostics = {
		...existing,
		selectedCandidateCount: boundedRoutingSelectionCount(
			selectedCandidateCount,
		),
		zeroAttemptReason:
			selectedCandidateCount === 0
				? existing.zeroAttemptReason
				: existing.zeroAttemptReason === "policy_excluded"
					? "all_unavailable"
					: existing.zeroAttemptReason,
	};
}

/**
 * Apply the process snapshot to an implicit candidate pool. Observe mode emits
 * aggregate diagnostics but deliberately returns the original order and set.
 */
function applyImplicitFallbackPolicy(
	accounts: Account[],
	ctx: ProxyContext,
	lane: "normal" | "combo",
	meta?: RequestMeta,
): Account[] {
	const policy = ctx.implicitFallbackPolicy ?? IMPLICIT_FALLBACK_POLICY_OFF;
	if (policy.mode === "off") return accounts;

	let deniedCount = 0;
	let unknownCount = 0;
	const filtered = accounts.filter((account) => {
		const decision = evaluateImplicitFallbackPolicy(account, policy);
		if (decision.reason === "unknown") unknownCount += 1;
		if (!decision.allowed) deniedCount += 1;
		return decision.allowed;
	});
	if (meta) {
		setImplicitFallbackSelectionDiagnostics(
			meta,
			policy,
			accounts.length,
			filtered.length,
		);
	}

	if (deniedCount > 0 || unknownCount > 0) {
		const now = Date.now();
		if (
			now - implicitFallbackDiagnosticLastLoggedAt >=
			IMPLICIT_FALLBACK_DIAGNOSTIC_INTERVAL_MS
		) {
			implicitFallbackDiagnosticLastLoggedAt = now;
			log.info(
				`Implicit fallback policy ${policy.mode} ${lane} candidates: denied=${deniedCount}, unknown=${unknownCount}`,
			);
		}
	}
	return policy.mode === "observe" ? accounts : filtered;
}

/**
 * Apply the ordinary-pool model-integrity fence before candidate metadata,
 * capacity deferral, and strategy selection can observe a changing route.
 * Explicit force/profile routes and active combo slots take earlier branches;
 * an actual agent preference rewrite is deliberate model-routing intent.
 */
function applyOrdinaryStockModelEligibility(
	accounts: Account[],
	meta: RequestMeta,
	effectiveModel: string | null,
): Account[] {
	if (
		!effectiveModel ||
		!isStockClaudeModelOrFamilyAlias(effectiveModel) ||
		meta.routeProfileId != null ||
		hasActualAgentPreferenceRewrite(meta)
	) {
		return accounts;
	}

	const eligible = accounts.filter((account) =>
		isOrdinaryStockModelAccountEligible(account, effectiveModel),
	);
	if (eligible.length === accounts.length) return accounts;

	const existing = meta.routingSelectionDiagnostics;
	const structural = boundedRoutingSelectionCount(
		existing?.structuralCandidateCount ?? accounts.length,
	);
	const eligibleCount = Math.min(
		structural,
		boundedRoutingSelectionCount(eligible.length),
	);
	meta.routingSelectionDiagnostics = {
		mode: "enforce",
		structuralCandidateCount: structural,
		eligibleCandidateCount: eligibleCount,
		excludedCandidateCount: structural - eligibleCount,
		selectedCandidateCount: existing?.selectedCandidateCount ?? 0,
		zeroAttemptReason:
			eligibleCount === 0 ? "policy_excluded" : "all_unavailable",
		forcedRoute: false,
		capabilityProfile: false,
		routeProfile: false,
	};
	return eligible;
}

/**
 * Match an account against the root capability declared by a dynamic model
 * route profile.  The profile's logical model is intentionally used here,
 * rather than the current child-agent model: a session must remain inside the
 * account pool that can serve the model the operator selected.  Capacity and
 * availability for the current request are evaluated later by the normal
 * selector and strategy.
 */
function matchesCapabilityRouteProfile(
	account: Account,
	meta: RequestMeta,
): boolean {
	const expectedProvider = meta.routeExpectedProvider?.trim().toLowerCase();
	const expectedPhysicalModel = meta.routeProfileExpectedPhysicalModel?.trim();
	const logicalModel = meta.routeProfileLogicalModel?.trim();
	if (!expectedProvider || !expectedPhysicalModel || !logicalModel) {
		return false;
	}
	return (
		getRouteProfileConstraintViolation(
			account,
			{
				...meta,
				routeExpectedPhysicalModel: expectedPhysicalModel,
			},
			logicalModel,
		) === null
	);
}

function capabilityRouteUnavailable(
	meta: RequestMeta,
	matchingAccounts: readonly Account[],
): ForceRouteUnavailableError {
	const accountId = meta.routeProfileId?.trim() || "capability-route";
	if (matchingAccounts.length === 0) {
		return new ForceRouteUnavailableError(accountId, "model_mapping_mismatch");
	}
	if (matchingAccounts.every((account) => account.paused)) {
		return new ForceRouteUnavailableError(accountId, "paused");
	}
	if (
		meta.hardExcludedAccountIds &&
		matchingAccounts.every((account) =>
			meta.hardExcludedAccountIds?.has(account.id),
		)
	) {
		return new ForceRouteUnavailableError(
			accountId,
			"account_capacity_exhausted",
		);
	}
	return new ForceRouteUnavailableError(
		accountId,
		"rate_limited_or_unavailable",
	);
}

function capabilityDescendantCandidateId(
	profileId: string,
	rung: NonNullable<RoutingCandidateMetadata["routeFallbackRung"]>,
	accountId: string,
	model: string,
): string {
	return `profile:${encodeURIComponent(profileId)}:${rung}:${encodeURIComponent(
		accountId,
	)}:${encodeURIComponent(model.trim().toLowerCase())}`;
}

function alignCapabilityCandidates(
	accounts: readonly Account[],
	candidates: readonly RoutingCandidateMetadata[],
): RoutingCandidateMetadata[] {
	const used = new Set<number>();
	return accounts.flatMap((account, index) => {
		const positional = candidates[index];
		if (positional?.accountId === account.id && !used.has(index)) {
			used.add(index);
			return [positional];
		}
		const matchedIndex = candidates.findIndex(
			(candidate, candidateIndex) =>
				candidate.accountId === account.id && !used.has(candidateIndex),
		);
		if (matchedIndex < 0) return [];
		used.add(matchedIndex);
		return [candidates[matchedIndex] as RoutingCandidateMetadata];
	});
}

async function selectCapabilityDescendantAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
	allAccounts: Account[],
	effectiveModel: string,
	syntheticProbe: boolean,
	modelScopedCapacityRouting: ModelScopedCapacityRoutingMode,
): Promise<Account[]> {
	const profileId = meta.routeProfileId?.trim() || "capability-route";
	const rootModel = meta.routeProfileLogicalModel?.trim();
	if (!rootModel) throw capabilityRouteUnavailable(meta, []);
	const excludedProviders = getExcludedProviders(meta);
	const rootPool = allAccounts.filter(
		(account) =>
			isAccountEligibleForRouteIntent(account, meta, ctx) &&
			matchesCapabilityRouteProfile(account, meta) &&
			!isProviderExcludedForRequest(account, excludedProviders),
	);
	if (rootPool.length === 0) throw capabilityRouteUnavailable(meta, rootPool);

	const globalPool = applyImplicitFallbackPolicy(
		allAccounts.filter(
			(account) =>
				isAccountEligibleForRouteIntent(account, meta, ctx) &&
				!isProviderExcludedForRequest(account, excludedProviders) &&
				isOrdinaryStockModelAccountEligible(account, effectiveModel),
		),
		ctx,
		"normal",
		meta,
	);
	const specifications = [
		...rootPool.map((account) => ({
			account,
			model: effectiveModel,
			rung: "profile_requested_model" as const,
			constraint: "profile" as const,
		})),
		...rootPool.map((account) => ({
			account,
			model: rootModel,
			rung: "profile_root_model" as const,
			constraint: "profile" as const,
		})),
		...globalPool.map((account) => ({
			account,
			model: effectiveModel,
			rung: "global_requested_model" as const,
			constraint: "ordinary" as const,
		})),
	];
	const seenRoutes = new Set<string>();
	const catalog: RoutingCandidateMetadata[] = [];
	const eligibleCandidates: RoutingCandidateMetadata[] = [];
	const candidateAccounts: Account[] = [];
	const exclusions: RoutingCapacityCandidateExclusion[] = [];
	const now = Date.now();
	const beta = canonicalizeBetaSignature(meta.headers?.get("anthropic-beta"));
	for (const specification of specifications) {
		const configured = getConfiguredModelMapping(
			specification.model,
			specification.account,
		);
		const physicalModel = configured?.models[0]?.trim() || specification.model;
		const routeKey = JSON.stringify([
			specification.account.id,
			physicalModel.toLowerCase(),
		]);
		if (seenRoutes.has(routeKey)) continue;
		seenRoutes.add(routeKey);
		const routing: RoutingCandidateMetadata = {
			...normalCandidateMetadata(
				specification.account,
				catalog.length,
				specification.model,
			),
			candidateId: capabilityDescendantCandidateId(
				profileId,
				specification.rung,
				specification.account.id,
				specification.model,
			),
			routeFallbackRung: specification.rung,
			effectiveLogicalModel: specification.model,
			routeConstraintMode: specification.constraint,
		};
		catalog.push(routing);
		const evaluation = evaluateCandidateCapacity(
			specification.account,
			specification.model,
			beta,
			now,
			{
				modelScopedCapacityRouting,
				routeIntent:
					specification.constraint === "profile" ? "capability" : "ordinary",
				syntheticProbe,
			},
		);
		routing.quotaPressure = evaluation.quotaPressure;
		if (evaluation.blockers.length > 0) {
			exclusions.push(
				candidateExclusion(
					specification.account,
					specification.model,
					evaluation,
					"normal",
				),
			);
			continue;
		}
		candidateAccounts.push(specification.account);
		eligibleCandidates.push(routing);
	}

	meta.affinityLaneKey = deriveAffinityLaneKey(meta, effectiveModel);
	meta.hardExcludedAccountIds = null;
	meta.quotaPressureByAccountId = null;
	meta.routingCandidateCatalog = catalog;
	meta.routingCandidates = eligibleCandidates;
	capacityDeferredModelRoutesMap.set(meta, []);
	saveCapacityContext(meta, effectiveModel, exclusions, {
		before: catalog.length,
		after: meta.routingCandidates.length,
	});
	if (candidateAccounts.length === 0) {
		throw capabilityRouteUnavailable(meta, rootPool);
	}
	const eligibleCandidateIds = new Set(
		meta.routingCandidates.map((candidate) => candidate.candidateId),
	);
	const strategyOrdered = await ctx.strategy.select(candidateAccounts, meta);
	const aligned = alignCapabilityCandidates(
		strategyOrdered,
		meta.routingCandidates,
	).filter((candidate) => eligibleCandidateIds.has(candidate.candidateId));
	const accountsById = new Map(
		allAccounts.map((account) => [account.id, account]),
	);
	const finalCandidates = aligned.filter((candidate) => {
		const account = accountsById.get(candidate.accountId);
		return account !== undefined && isAccountAvailable(account);
	});
	meta.routingCandidates = finalCandidates;
	const finalAccounts = finalCandidates.flatMap((candidate) => {
		const account = accountsById.get(candidate.accountId);
		return account ? [account] : [];
	});
	finalizeSelectionDiagnostics(meta, finalAccounts.length);
	if (finalAccounts.length === 0) {
		throw capabilityRouteUnavailable(meta, rootPool);
	}
	return finalAccounts;
}

function reportAccountDatabaseError(error: unknown): void {
	log.error("Failed to get accounts from database:", error);
	console.error("\n❌ DATABASE ERROR DETECTED");
	console.error("═".repeat(50));
	console.error("The database encountered an error while loading accounts.");
	console.error("This may indicate database corruption or integrity issues.\n");
	console.error("To diagnose and repair the database, run:");
	console.error("  bun run cli --repair-db\n");
	console.error("The request will fall back to unauthenticated mode.");
	console.error(`${"═".repeat(50)}\n`);
}

export async function getOrderedAccounts(
	meta: RequestMeta,
	ctx: ProxyContext,
	effectiveModel: string | null = null,
	syntheticProbe = false,
	preloadedAccounts?: Account[],
	degradedOwner?: DegradedOwnerSelectionContext,
	priorServerToolCatalog: readonly RoutingCandidateMetadata[] = [],
	preselectionFilter?: (accounts: Account[]) => Account[],
	modelScopedCapacityRouting = getModelScopedCapacityRoutingMode(ctx),
): Promise<Account[]> {
	try {
		const capacityOptions: CandidateCapacityEvaluationOptions = {
			modelScopedCapacityRouting,
			routeIntent:
				meta.routeProfileSelection === "capability" ? "capability" : "ordinary",
			syntheticProbe,
		};
		const loadedAccounts =
			preloadedAccounts ?? (await ctx.dbOps.getAllAccounts());
		const preselectedAccounts = preselectionFilter
			? preselectionFilter(loadedAccounts)
			: loadedAccounts;
		const allAccounts = preselectedAccounts.filter((account) =>
			isAccountEligibleForRouteIntent(account, meta, ctx),
		);
		const excludedProviders = meta.serverToolRequirements
			? getExcludedProviders(meta)
			: [];
		const structuralAccounts = meta.serverToolRequirements
			? allAccounts.filter(
					(account) =>
						!isProviderExcludedForRequest(account, excludedProviders),
				)
			: allAccounts;
		setXaiCacheEligibleAccounts(meta, structuralAccounts);
		const eligibleAccounts = prepareNormalRoutingMetadata(
			meta,
			ctx,
			structuralAccounts,
			effectiveModel,
			capacityOptions,
			priorServerToolCatalog,
		);
		try {
			materializeDegradedOwnerDirective(
				meta,
				ctx,
				structuralAccounts,
				degradedOwner,
			);
		} finally {
			// Preliminary capacity exclusions are inspection-only. Clearing them is
			// what lets SessionStrategy run its existing reset-qualified resume path;
			// the final phase below republishes authoritative exclusions.
			if (meta.serverToolRequirements) meta.hardExcludedAccountIds = null;
		}
		// A strategy may return stale cached objects or otherwise ignore its input.
		// Treat it as an ordering policy, never as authority to escape the candidate
		// set established by exclusions, route intent, and exact-model admission.
		const eligibleAccountIds = new Set(
			eligibleAccounts.map((account) => account.id),
		);
		const strategyOrdered = (
			await ctx.strategy.select(eligibleAccounts, meta)
		).filter((account) => eligibleAccountIds.has(account.id));
		const ordered = meta.serverToolRequirements
			? finalizeNormalServerToolRoutingMetadata(
					meta,
					ctx,
					strategyOrdered,
					effectiveModel,
					capacityOptions,
				)
			: strategyOrdered.filter(
					(account) => !meta.hardExcludedAccountIds?.has(account.id),
				);
		const catalog = meta.routingCandidateCatalog ?? [];
		meta.routingCandidates = ordered
			.map((account) =>
				catalog.find(
					(candidate) =>
						candidate.candidateId === `account:${account.id}` &&
						candidate.accountId === account.id,
				),
			)
			.filter(
				(candidate): candidate is RoutingCandidateMetadata =>
					candidate !== undefined,
			);
		let affinityOrdered = applyXaiCacheAffinity(ordered, meta, ctx);
		if (meta.serverToolRequirements) {
			const candidatesByAccountId = new Map(
				(meta.routingCandidates ?? []).map((candidate) => [
					candidate.accountId,
					candidate,
				]),
			);
			const finalAccounts: Account[] = [];
			const finalCandidates: RoutingCandidateMetadata[] = [];
			const seenCandidateIds = new Set<string>();
			for (const account of affinityOrdered) {
				const candidate = candidatesByAccountId.get(account.id);
				if (!candidate || seenCandidateIds.has(candidate.candidateId)) continue;
				seenCandidateIds.add(candidate.candidateId);
				finalAccounts.push(account);
				finalCandidates.push(candidate);
			}
			affinityOrdered = finalAccounts;
			meta.routingCandidates = finalCandidates;
			const deferredCandidateIds = getCapacityDeferredModelRoutes(meta).map(
				(route) => route.candidateId,
			);
			const eligibleCandidateIds = new Set([
				...seenCandidateIds,
				...deferredCandidateIds,
			]);
			publishServerToolCapabilitySummary(meta, catalog, eligibleCandidateIds);
			if (
				meta.routingCandidates.length === 0 &&
				deferredCandidateIds.length === 0
			) {
				throwServerToolCapabilityPoolError(meta);
			}
		}
		finalizeSelectionDiagnostics(meta, affinityOrdered.length);
		return affinityOrdered;
	} catch (error) {
		capacityDeferredModelRoutesMap.delete(meta);
		if (error instanceof ServerToolRoutingError) throw error;
		reportAccountDatabaseError(error);
		if (meta.serverToolRequirements) throw serverToolSelectionFailure(meta);
		// Return empty array to gracefully handle database errors
		// This will cause the proxy to fall back to unauthenticated mode
		return [];
	}
}

/**
 * Selects accounts for a request based on the load balancing strategy.
 * When an active combo exists for the request's model family, returns
 * combo-ordered accounts filtered by availability. Falls back to normal
 * SessionStrategy when no combo is active or all slots are unavailable.
 *
 * @param meta - Request metadata
 * @param ctx - The proxy context
 * @param model - Optional model string for combo family detection
 * @param options - Selection-mode controls for explicit fallback paths
 * @returns Array of selected accounts
 */
async function selectAccountsForRequestInternal(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
	options: AccountSelectionOptions = {},
): Promise<Account[]> {
	comboSlotInfoMap.delete(meta);
	capacityDeferredModelRoutesMap.delete(meta);
	meta.comboName = null;
	meta.comboSlotIndex = null;
	const effectiveModel =
		model ?? resolveEffectiveModel(meta.appliedModel, meta.originalModel);
	const modelScopedCapacityRouting = getModelScopedCapacityRoutingMode(ctx);
	meta.affinityLaneKey = deriveAffinityLaneKey(meta, effectiveModel);
	meta.hardExcludedAccountIds = null;
	meta.quotaPressureByAccountId = null;
	meta.routingCandidateCatalog = null;
	meta.routingCandidates = null;
	meta.routingSelectionDiagnostics = null;
	meta.serverToolCapabilitySummary = undefined;
	saveCapacityContext(meta, effectiveModel, []);

	// A route profile's server-derived account id has the same exact-account,
	// fail-closed semantics as the public header. Never silently choose between
	// conflicting directives: doing so would make the selected account depend on
	// an implementation detail instead of either caller's explicit intent.
	const publicForcedAccountId = meta.headers?.get(
		"x-better-ccflare-account-id",
	);
	const serverForcedAccountId = meta.forcedAccountId?.trim();
	const capabilityProfileRoute = meta.routeProfileSelection === "capability";
	if (
		serverForcedAccountId &&
		publicForcedAccountId &&
		serverForcedAccountId !== publicForcedAccountId
	) {
		throw new ForceRouteUnavailableError(
			serverForcedAccountId,
			"conflicting_force_route",
		);
	}
	const forcedAccountId = serverForcedAccountId || publicForcedAccountId;
	if (capabilityProfileRoute && forcedAccountId) {
		// A capability profile owns its candidate set.  Do not let a caller's
		// public force header (or a stale server pin) escape that set.
		throw new ForceRouteUnavailableError(
			forcedAccountId,
			"conflicting_force_route",
		);
	}
	if (forcedAccountId) {
		try {
			const allAccounts = await ctx.dbOps.getAllAccounts();
			const forcedAccount = allAccounts.find(
				(acc) => acc.id === forcedAccountId,
			);
			if (!forcedAccount) {
				throw new ForceRouteUnavailableError(forcedAccountId, "not_found");
			}
			if (
				effectiveModel &&
				isForceAccountModelEnabled(ctx) &&
				!isInternalProbe(meta.headers, ctx) &&
				!accountServesModel(forcedAccount, effectiveModel)
			) {
				return [];
			}
			if (!isAccountEligibleForRouteIntent(forcedAccount, meta, ctx)) {
				throw new ForceRouteUnavailableError(
					forcedAccountId,
					"rate_limited_or_unavailable",
				);
			}
			setXaiCacheEligibleAccounts(meta, [forcedAccount]);
			if (
				serverForcedAccountId &&
				isProviderExcludedForRequest(forcedAccount, getExcludedProviders(meta))
			) {
				throw new ForceRouteUnavailableError(
					forcedAccountId,
					"provider_excluded",
				);
			}
			if (meta.routeProfileId) {
				const constraintViolation = getRouteProfileConstraintViolation(
					forcedAccount,
					meta,
					effectiveModel,
				);
				if (constraintViolation) {
					throw new ForceRouteUnavailableError(
						forcedAccountId,
						constraintViolation,
					);
				}
			}
			let forcedRouting: RoutingCandidateMetadata | undefined;
			if (meta.serverToolRequirements) {
				forcedRouting = normalCandidateMetadata(
					forcedAccount,
					0,
					effectiveModel,
				);
				forcedRouting.serverToolCapability =
					evaluateCandidateServerToolCapability({
						account: forcedAccount,
						routing: forcedRouting,
						logicalModel: effectiveModel,
						meta,
						ctx,
					});
				meta.routingCandidateCatalog = [forcedRouting];
				meta.routingCandidates = [];
				publishServerToolCapabilitySummary(meta, [forcedRouting], new Set());
				if (!isServerToolCandidateSemanticallyEligible(forcedRouting)) {
					const reason: ServerToolRoutingErrorReason = meta
						.serverToolRequirements.invalid?.length
						? "invalid_requirement"
						: meta.serverToolRequirements.unsupported?.length
							? "unsupported_requirement"
							: "forced_incapable";
					throw new ServerToolRoutingError({
						reason,
						accountId: getClientVisibleServerToolAccountId(
							meta,
							forcedAccount.id,
						),
						capabilitySummary: meta.serverToolCapabilitySummary,
					});
				}
			}
			{
				// The auto-refresh scheduler sends authenticated internal probes
				// to intentionally refresh accounts that are paused due to auto_pause_on_overage,
				// or to probe accounts that are rate-limited (to detect when the window has reset).
				// For trusted probes we allow through an overage-paused or rate-limited account
				// so the scheduler can hit the real endpoint and trigger the window-reset + auto-resume logic.
				// Only an overage pause qualifies: a manual pause (pause_reason='manual') or a
				// failure-threshold / peak_hours pause must still win even when the overage feature
				// flag is enabled, because the auto-resume guard would never un-pause those accounts.
				// This mirrors the scheduler eligibility query and the sendDummyMessage resume guard
				// (auto_pause_on_overage_enabled=1 AND pause_reason IN (NULL,'overage')).
				const isAutoRefreshBypass = meta.trustedInternalAutoRefresh === true;
				const available = isAccountAvailable(forcedAccount);
				const isOveragePaused =
					forcedAccount.paused &&
					forcedAccount.auto_pause_on_overage_enabled &&
					(!forcedAccount.pause_reason ||
						forcedAccount.pause_reason === "overage");
				const isRateLimited =
					!available &&
					!forcedAccount.paused &&
					!!forcedAccount.rate_limited_until;
				// Fail closed for every provider: a client that explicitly
				// force-routes to a specific account id must never be silently
				// redirected to a *different* account it did not ask for, and must
				// never be silently downgraded into normal pool selection. This
				// used to be scoped to the xAI cache-native official-endpoint
				// carve-out only (meta.xaiCacheNativeActive && provider === "xai"
				// && isOfficialXaiEndpoint); it now applies unconditionally to any
				// unavailable or capacity-exhausted forced account, regardless of
				// provider, custom-endpoint status, or the xaiCacheNativeActive flag.
				const mayProbeUnavailableAccount =
					isAutoRefreshBypass && (isOveragePaused || isRateLimited);
				if (!available && !mayProbeUnavailableAccount) {
					throw new ForceRouteUnavailableError(
						forcedAccountId,
						forcedAccount.paused ? "paused" : "rate_limited_or_unavailable",
					);
				}

				if (effectiveModel) {
					const now = Date.now();
					const evaluation = evaluateCandidateCapacity(
						forcedAccount,
						effectiveModel,
						canonicalizeBetaSignature(meta.headers?.get("anthropic-beta")),
						now,
						{
							modelScopedCapacityRouting,
							routeIntent: "force",
							syntheticProbe: options.syntheticProbe === true,
						},
					);
					meta.quotaPressureByAccountId = evaluation.quotaPressure
						? new Map([[forcedAccount.id, evaluation.quotaPressure]])
						: null;
					if (evaluation.blockers.length > 0) {
						meta.hardExcludedAccountIds = new Set([forcedAccount.id]);
						const exclusion = candidateExclusion(
							forcedAccount,
							effectiveModel,
							evaluation,
							"force",
						);
						// A force-route considers exactly one account, and this branch
						// is the case where capacity excluded it. That is a floor: the
						// caller's lane has nothing left to route to.
						saveCapacityContext(meta, effectiveModel, [exclusion], {
							before: 1,
							after: 0,
						});
						const accountWide = evaluation.blockers.some(
							(blocker) => blocker.scope === "account",
						);
						throw new ForceRouteUnavailableError(
							forcedAccountId,
							accountWide
								? "account_capacity_exhausted"
								: "model_capacity_exhausted",
						);
					}
					meta.hardExcludedAccountIds = null;
					saveCapacityContext(meta, effectiveModel, []);
				} else {
					meta.hardExcludedAccountIds = null;
					meta.quotaPressureByAccountId = null;
					saveCapacityContext(meta, null, []);
				}
				if (forcedRouting) {
					meta.routingCandidates = [forcedRouting];
					publishServerToolCapabilitySummary(
						meta,
						[forcedRouting],
						new Set([forcedRouting.candidateId]),
					);
				}
				return [forcedAccount];
			}
			// Forced account id does not exist in the database at all. Fail
			// closed here too instead of silently falling back to normal
			// selection, which would route the request to an account the
			// caller never asked for. (Handled above via the `!forcedAccount`
			// early throw before this try block's inner logic runs.)
		} catch (error) {
			if (
				error instanceof ForceRouteUnavailableError ||
				error instanceof ServerToolRoutingError
			) {
				throw error;
			}
			log.error(
				"Failed to get accounts from database for forced account lookup:",
				error,
			);
			console.error("\n❌ DATABASE ERROR DETECTED");
			console.error("═".repeat(50));
			console.error(
				"The database encountered an error while looking up the requested account.",
			);
			console.error(
				"This may indicate database corruption or integrity issues.\n",
			);
			console.error("To diagnose and repair the database, run:");
			console.error("  bun run cli --repair-db\n");
			console.error("The explicit route will fail closed.");
			console.error(`${"═".repeat(50)}\n`);
			throw new ForceRouteUnavailableError(forcedAccountId, "lookup_failed");
		}
	}

	if (capabilityProfileRoute) {
		let allAccounts: Account[];
		try {
			allAccounts = await ctx.dbOps.getAllAccounts();
		} catch (error) {
			log.error(
				"Failed to get accounts from database for capability route lookup:",
				error,
			);
			throw new ForceRouteUnavailableError(
				meta.routeProfileId?.trim() || "capability-route",
				"lookup_failed",
			);
		}
		if (
			meta.routeLineage?.kind === "descendant" &&
			effectiveModel &&
			!meta.serverToolRequirements
		) {
			return selectCapabilityDescendantAccounts(
				meta,
				ctx,
				allAccounts,
				effectiveModel,
				options.syntheticProbe === true,
				modelScopedCapacityRouting,
			);
		}
		const excludedProviders = getExcludedProviders(meta);
		const selectGlobalHelperFallback = async (): Promise<Account[]> => {
			const selected = await getOrderedAccounts(
				meta,
				ctx,
				effectiveModel,
				options.syntheticProbe === true,
				allAccounts,
				undefined,
				[],
				(accounts) =>
					accounts.filter(
						(account) =>
							isAccountEligibleForRouteIntent(account, meta, ctx) &&
							!isProviderExcludedForRequest(account, excludedProviders),
					),
				modelScopedCapacityRouting,
			);
			for (const candidate of meta.routingCandidateCatalog ?? []) {
				candidate.routeConstraintMode = "ordinary";
			}
			for (const candidate of meta.routingCandidates ?? []) {
				candidate.routeConstraintMode = "ordinary";
			}
			return selected.filter((account) => isAccountAvailable(account));
		};
		const matchingAccounts = allAccounts.filter(
			(account) =>
				isAccountEligibleForRouteIntent(account, meta, ctx) &&
				matchesCapabilityRouteProfile(account, meta) &&
				!isProviderExcludedForRequest(account, excludedProviders),
		);
		if (matchingAccounts.length === 0) {
			if (meta.routeLineage?.kind === "helper") {
				return selectGlobalHelperFallback();
			}
			throw capabilityRouteUnavailable(meta, matchingAccounts);
		}
		let selected: Account[];
		try {
			selected = await getOrderedAccounts(
				meta,
				ctx,
				effectiveModel,
				options.syntheticProbe === true,
				allAccounts,
				undefined,
				[],
				(accounts) =>
					accounts.filter(
						(account) =>
							isAccountEligibleForRouteIntent(account, meta, ctx) &&
							matchesCapabilityRouteProfile(account, meta) &&
							!isProviderExcludedForRequest(account, excludedProviders),
					),
				modelScopedCapacityRouting,
			);
		} catch (error) {
			if (
				meta.routeLineage?.kind === "helper" &&
				(error instanceof ServerToolRoutingError ||
					error instanceof ForceRouteUnavailableError)
			) {
				return selectGlobalHelperFallback();
			}
			throw error;
		}
		// A custom strategy is allowed to return stale/unavailable candidates;
		// dynamic profiles must not let those candidates turn into a passthrough
		// or an unrelated normal-pool route.
		const available = selected.filter(
			(account) =>
				isAccountEligibleForRouteIntent(account, meta, ctx) &&
				matchesCapabilityRouteProfile(account, meta) &&
				!isProviderExcludedForRequest(account, excludedProviders) &&
				isAccountAvailable(account),
		);
		if (available.length === 0) {
			if (meta.routeLineage?.kind === "helper") {
				return selectGlobalHelperFallback();
			}
			throw capabilityRouteUnavailable(meta, matchingAccounts);
		}
		return available;
	}

	// Filter out excluded providers (e.g. claude-oauth excluded by the responses adapter)
	const excludeProviders = getExcludedProviders(meta);
	const isProviderExcluded = (account: Account): boolean => {
		return isProviderExcludedForRequest(account, excludeProviders);
	};

	const applyExclusions = (accounts: Account[]): Account[] => {
		if (excludeProviders.length === 0) return accounts;
		const filtered = accounts.filter((account) => !isProviderExcluded(account));
		const skipped = accounts.length - filtered.length;
		if (skipped > 0) {
			log.warn(
				`Skipping ${skipped} account(s) excluded for this request type (Codex CLI traffic must not use Anthropic OAuth accounts)`,
			);
		}
		return filtered;
	};
	const applyNormalImplicitFallbackPolicy = (accounts: Account[]): Account[] =>
		applyImplicitFallbackPolicy(accounts, ctx, "normal", meta);

	let preloadedAccounts: Account[] | undefined;
	let priorServerToolCatalog: readonly RoutingCandidateMetadata[] = [];

	// Try combo-aware routing if a concrete effective model is available.
	if (
		effectiveModel &&
		!options.skipCombo &&
		(ctx.config?.getCombosEnabled?.() ?? true) &&
		!(isForceAccountModelEnabled(ctx) && !isInternalProbe(meta.headers, ctx)) &&
		meta.routeProfileSelection !== "capability"
	) {
		const family = getModelFamily(effectiveModel);
		if (family) {
			const validFamilies: readonly string[] = [
				"fable",
				"opus",
				"sonnet",
				"haiku",
			];
			if (!validFamilies.includes(family)) {
				log.warn(`Unknown model family "${family}", skipping combo lookup`);
			} else {
				const comboFamily = family as ComboFamily;
				const routingPolicyReader = (
					ctx.dbOps as Partial<
						Pick<ProxyContext["dbOps"], "getComboRoutingPolicy">
					>
				).getComboRoutingPolicy;
				let routingPolicy: ComboRoutingPolicySnapshot;
				if (typeof routingPolicyReader === "function") {
					routingPolicy = await routingPolicyReader.call(
						ctx.dbOps,
						comboFamily,
					);
				} else {
					const combo = await ctx.dbOps.getActiveComboForFamily(comboFamily);
					routingPolicy = {
						assignment: {
							family: comboFamily,
							combo_id: combo?.id ?? null,
							enabled: combo !== null,
							membership_mode: "manual",
							managed_model: null,
						},
						combo,
						slots: combo?.slots ?? [],
						rules: [],
						exclusions: [],
					};
				}
				let allAccounts: Account[];
				try {
					allAccounts = await ctx.dbOps.getAllAccounts();
				} catch (error) {
					reportAccountDatabaseError(error);
					if (meta.serverToolRequirements) {
						throw serverToolSelectionFailure(meta);
					}
					return [];
				}
				preloadedAccounts = allAccounts;
				const resolution = resolveEffectiveComboMembership(
					routingPolicy,
					allAccounts,
					{
						deriveRouteClass: deriveComboRouteClass,
						resolveCapability: resolveAccountLogicalModelCapability,
					},
				);
				if (!resolution.active) {
					log.debug(
						"Combo routing membership resolved",
						buildComboMembershipDiagnostics(
							resolution,
							routingPolicy.assignment.membership_mode,
							null,
						),
					);
				}

				const combo = routingPolicy.combo;
				if (resolution.active && combo) {
					const accountMap = new Map<string, Account>();
					for (const account of allAccounts) {
						accountMap.set(account.id, account);
					}
					// Policy diagnostics must describe concrete combo slots, not the
					// entire account table. A single account may occupy multiple model
					// slots, while provider exclusions remove rows before they can be
					// routed; using allAccounts here misreports both counts and the
					// zero-attempt reason.
					const comboPolicyAccounts = resolution.members
						.map((member) => accountMap.get(member.account_id))
						.filter(
							(account): account is Account =>
								account !== undefined &&
								isAccountEligibleForRouteIntent(account, meta, ctx) &&
								!isProviderExcluded(account),
						);
					const implicitComboAccounts = applyImplicitFallbackPolicy(
						comboPolicyAccounts,
						ctx,
						"combo",
						meta,
					);
					const implicitComboAccountIds = new Set(
						implicitComboAccounts.map((account) => account.id),
					);

					const eligibleEntries: Array<{
						account: Account;
						modelOverride: string;
						tier: number;
						ordinal: number;
						source: ComboMembershipSource;
						quotaPressure: AccountQuotaPressure | null;
						routing: RoutingCandidateMetadata;
					}> = [];
					const candidateCatalog: RoutingCandidateMetadata[] = [];
					const capacityExclusions: RoutingCapacityCandidateExclusion[] = [];
					const candidateCountsByAccount = new Map<string, number>();
					const eligibleCountsByAccount = new Map<string, number>();
					const now = Date.now();
					const beta = canonicalizeBetaSignature(
						meta.headers?.get("anthropic-beta"),
					);

					// Effective members are structural candidates. The resolver owns
					// manual/managed precedence and its order is the stable ordinal.
					const capacityOptions: CandidateCapacityEvaluationOptions = {
						modelScopedCapacityRouting,
						routeIntent: "combo",
						syntheticProbe: options.syntheticProbe === true,
					};
					for (const [ordinal, member] of resolution.members.entries()) {
						const account = accountMap.get(member.account_id);
						if (!account) {
							log.warn("Resolved combo member references an unknown account", {
								family,
								comboId: resolution.combo_id,
								source: member.source,
							});
							continue;
						}

						if (
							isProviderExcluded(account) ||
							!implicitComboAccountIds.has(account.id)
						)
							continue;
						const routing: RoutingCandidateMetadata = {
							candidateId: member.id,
							accountId: account.id,
							tier: member.tier,
							ordinal,
							comboSlotId: member.slot_id,
							modelOverride: member.logical_model,
							quotaPressure: null,
						};
						if (meta.serverToolRequirements) {
							routing.serverToolCapability =
								evaluateCandidateServerToolCapability({
									account,
									routing,
									logicalModel: member.logical_model,
									meta,
									ctx,
								});
						}
						candidateCatalog.push(routing);
						if (
							meta.serverToolRequirements &&
							!isServerToolCandidateSemanticallyEligible(routing)
						) {
							continue;
						}
						if (!meta.serverToolRequirements && !isAccountAvailable(account)) {
							continue;
						}

						candidateCountsByAccount.set(
							account.id,
							(candidateCountsByAccount.get(account.id) ?? 0) + 1,
						);
						const evaluation = evaluateCandidateCapacity(
							account,
							member.logical_model,
							beta,
							now,
							capacityOptions,
						);
						routing.quotaPressure = evaluation.quotaPressure;
						if (evaluation.blockers.length > 0) {
							capacityExclusions.push(
								candidateExclusion(
									account,
									member.logical_model,
									evaluation,
									"combo",
									member.slot_id,
									ordinal,
								),
							);
							continue;
						}

						eligibleCountsByAccount.set(
							account.id,
							(eligibleCountsByAccount.get(account.id) ?? 0) + 1,
						);
						eligibleEntries.push({
							account,
							modelOverride: member.logical_model,
							tier: member.tier,
							ordinal,
							source: member.source,
							quotaPressure: evaluation.quotaPressure,
							routing,
						});
					}

					setXaiCacheEligibleAccounts(
						meta,
						meta.serverToolRequirements
							? implicitComboAccounts.filter(
									(account) => !isProviderExcluded(account),
								)
							: implicitComboAccounts,
					);
					const fullyExcludedAccountIds = new Set<string>();
					for (const [accountId, count] of candidateCountsByAccount) {
						if (
							count > 0 &&
							(eligibleCountsByAccount.get(accountId) ?? 0) === 0
						) {
							fullyExcludedAccountIds.add(accountId);
						}
					}
					meta.hardExcludedAccountIds =
						fullyExcludedAccountIds.size > 0 ? fullyExcludedAccountIds : null;
					// Combo pressure is candidate-local because one account may appear in
					// multiple concrete model lanes. Never collapse it into an account map.
					meta.quotaPressureByAccountId = null;
					meta.routingCandidateCatalog = candidateCatalog;
					meta.routingCandidates = eligibleEntries.map(
						(entry) => entry.routing,
					);
					publishServerToolCapabilitySummary(
						meta,
						candidateCatalog,
						new Set(eligibleEntries.map((entry) => entry.routing.candidateId)),
					);
					saveCapacityContext(meta, effectiveModel, capacityExclusions);

					if (eligibleEntries.length > 0) {
						eligibleEntries.sort(
							(a, b) =>
								a.tier - b.tier ||
								compareCandidatePressure(a.quotaPressure, b.quotaPressure) ||
								a.ordinal - b.ordinal,
						);
						meta.routingCandidates = eligibleEntries.map(
							(entry) => entry.routing,
						);
						materializeDegradedOwnerDirective(
							meta,
							ctx,
							allAccounts,
							options.degradedOwner,
						);
						const entryByCandidateId = new Map(
							eligibleEntries.map((entry) => [
								entry.routing.candidateId,
								entry,
							]),
						);
						const reconcileEntries = (
							orderedAccounts: Account[],
							routingSidecar: readonly RoutingCandidateMetadata[] | null,
						): typeof eligibleEntries => {
							if (
								routingSidecar?.length === orderedAccounts.length &&
								routingSidecar.every(
									(candidate, index) =>
										candidate.accountId === orderedAccounts[index]?.id &&
										entryByCandidateId.has(candidate.candidateId),
								)
							) {
								const seen = new Set<string>();
								const aligned = routingSidecar
									.map((candidate) => {
										if (seen.has(candidate.candidateId)) return undefined;
										seen.add(candidate.candidateId);
										return entryByCandidateId.get(candidate.candidateId);
									})
									.filter(
										(entry): entry is (typeof eligibleEntries)[number] =>
											entry !== undefined,
									);
								if (aligned.length === orderedAccounts.length) return aligned;
							}

							// Account-only custom strategies cannot express which repeated slot
							// moved. Reconcile each returned occurrence to the next unused source
							// candidate for that account, preserving as much identity as possible.
							const used = new Set<string>();
							return orderedAccounts
								.map((account) => {
									const entry = eligibleEntries.find(
										(candidate) =>
											candidate.account.id === account.id &&
											!used.has(candidate.routing.candidateId),
									);
									if (entry) used.add(entry.routing.candidateId);
									return entry;
								})
								.filter(
									(entry): entry is (typeof eligibleEntries)[number] =>
										entry !== undefined,
								);
						};

						const strategyAccounts = await ctx.strategy.select(
							eligibleEntries.map((entry) => entry.account),
							meta,
						);
						let orderedEntries = reconcileEntries(
							strategyAccounts,
							meta.routingCandidates ?? null,
						).filter(
							(entry) =>
								!meta.serverToolRequirements ||
								isAccountAvailable(entry.account),
						);
						meta.routingCandidates = orderedEntries.map(
							(entry) => entry.routing,
						);
						const affinityAccounts = applyXaiCacheAffinity(
							orderedEntries.map((entry) => entry.account),
							meta,
							ctx,
						);
						orderedEntries = reconcileEntries(
							affinityAccounts,
							meta.routingCandidates ?? null,
						);
						meta.routingCandidates = orderedEntries.map(
							(entry) => entry.routing,
						);
						publishServerToolCapabilitySummary(
							meta,
							candidateCatalog,
							new Set(orderedEntries.map((entry) => entry.routing.candidateId)),
						);
						if (orderedEntries.length > 0) {
							const selectedEntry = orderedEntries[0];
							log.debug(
								"Combo routing candidate selected",
								buildComboMembershipDiagnostics(
									resolution,
									routingPolicy.assignment.membership_mode,
									{
										source: selectedEntry.source,
										tier: selectedEntry.tier,
										eligibleCandidateCount: orderedEntries.length,
									},
								),
							);
							const slotInfo: ComboSlotInfo = {
								comboName: combo.name,
								slots: orderedEntries.map((entry) => ({
									accountId: entry.account.id,
									modelOverride: entry.modelOverride,
								})),
							};
							setComboSlotInfo(meta, slotInfo);
							meta.comboName = combo.name;
							finalizeSelectionDiagnostics(meta, orderedEntries.length);
							return orderedEntries.map((entry) => entry.account);
						}
					}

					// All effective candidates unavailable — fall back to normal routing.
					if (isComboSessionFallbackDisabled(ctx)) {
						setComboSlotInfo(meta, { comboName: combo.name, slots: [] });
						meta.comboName = combo.name;
						log.warn(
							`All ${resolution.members.length} combo candidates unavailable for ${combo.name}, session fallback disabled by CCFLARE_DISABLE_COMBO_SESSION_FALLBACK`,
						);
						if (meta.serverToolRequirements) {
							throwServerToolCapabilityPoolError(meta);
						}
						return [];
					}
					if (meta.serverToolRequirements) {
						priorServerToolCatalog = candidateCatalog;
					}

					log.warn(
						`All ${resolution.members.length} combo candidates unavailable for ${combo.name}, falling back to SessionStrategy`,
						buildComboMembershipDiagnostics(
							resolution,
							routingPolicy.assignment.membership_mode,
							null,
						),
					);
				} else if (resolution.active) {
					log.error(
						"Active combo membership resolved without a combo record",
						buildComboMembershipDiagnostics(
							resolution,
							routingPolicy.assignment.membership_mode,
							null,
						),
					);
				}
			}
		}
	}

	return await getOrderedAccounts(
		meta,
		ctx,
		effectiveModel,
		options.syntheticProbe === true,
		preloadedAccounts,
		options.degradedOwner,
		priorServerToolCatalog,
		(accounts) => {
			const eligible = applyOrdinaryStockModelEligibility(
				applyNormalImplicitFallbackPolicy(applyExclusions(accounts)),
				meta,
				effectiveModel,
			);
			return effectiveModel &&
				isForceAccountModelEnabled(ctx) &&
				!isInternalProbe(meta.headers, ctx)
				? eligible.filter((account) =>
						accountServesModel(account, effectiveModel),
					)
				: eligible;
		},
		modelScopedCapacityRouting,
	);
}

export async function selectAccountsForRequest(
	meta: RequestMeta,
	ctx: ProxyContext,
	model?: string,
	options: AccountSelectionOptions = {},
): Promise<Account[]> {
	try {
		return await selectAccountsForRequestInternal(meta, ctx, model, options);
	} catch (error) {
		if (
			error instanceof ServerToolRoutingError ||
			error instanceof ForceRouteUnavailableError ||
			!meta.serverToolRequirements
		) {
			throw error;
		}
		throw serverToolSelectionFailure(meta);
	}
}
