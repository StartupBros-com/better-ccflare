import type { RequestMeta } from "@better-ccflare/types";
import type {
	RoutingDecision,
	RoutingDecisionReason,
	RoutingExclusionReason,
	RoutingSelectionStage,
	RoutingSelectionStageEvidence,
} from "@better-ccflare/types/request";

/**
 * Shared bounds for request-local routing diagnostics. These values are
 * intentionally independent of account-pool size so malformed or future
 * callers cannot create unbounded response/log fields.
 */
export const MAX_ROUTING_SELECTION_DIAGNOSTIC_COUNT = 1_000_000;

export function boundedRoutingSelectionCount(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(
		MAX_ROUTING_SELECTION_DIAGNOSTIC_COUNT,
		Math.max(0, Math.floor(value)),
	);
}

const MAX_OBSERVED_STAGE_CANDIDATES = 4096;
const MAX_DIAGNOSTIC_CANDIDATE_KEY_CHARS = 263;
function safeCandidateIdentity(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		/^[a-zA-Z0-9_.:/[\]@+-]+$/.test(value)
	);
}
/** Bound each scalar before serialization; a missing key is incomplete evidence, never exclusion. */
export function routingDiagnosticCandidateKey(
	accountId: unknown,
	model: unknown,
): string | null {
	return safeCandidateIdentity(accountId) && safeCandidateIdentity(model)
		? JSON.stringify([accountId, model])
		: null;
}
function safeCandidateKey(key: unknown): key is string {
	return (
		typeof key === "string" &&
		key.length > 0 &&
		key.length <= MAX_DIAGNOSTIC_CANDIDATE_KEY_CHARS &&
		/^[a-zA-Z0-9_.:/[\]@+,"-]+$/.test(key)
	);
}

interface StageObservation {
	candidates: Map<string, RoutingExclusionReason | null>;
	complete: boolean;
	overflow: boolean;
}
const stagesByRequest = new WeakMap<
	RequestMeta,
	Map<RoutingSelectionStage, StageObservation>
>();
/** Record the actual predicate result once per unique candidate/stage. No policy is rerun. */
export function observeRoutingSelectionCandidate(
	meta: RequestMeta,
	stage: RoutingSelectionStage,
	key: string | null,
	reason: RoutingExclusionReason | null,
): void {
	let stages = stagesByRequest.get(meta);
	if (!stages) {
		stages = new Map();
		stagesByRequest.set(meta, stages);
	}
	let entry = stages.get(stage);
	if (!entry) {
		entry = { candidates: new Map(), complete: false, overflow: false };
		stages.set(stage, entry);
	}
	entry.complete = false;
	if (!safeCandidateKey(key)) {
		entry.overflow = true;
		return;
	}
	if (!entry.candidates.has(key)) {
		if (entry.candidates.size >= MAX_OBSERVED_STAGE_CANDIDATES) {
			entry.overflow = true;
			return;
		}
		entry.candidates.set(key, reason);
	} else if (entry.candidates.get(key) === null && reason !== null)
		entry.candidates.set(key, reason);
}
export function completeRoutingSelectionStage(
	meta: RequestMeta,
	stage: RoutingSelectionStage,
): void {
	const entry = stagesByRequest.get(meta)?.get(stage);
	if (entry) entry.complete = true;
}
export function routingSelectionStageSnapshot(
	meta: RequestMeta,
): RoutingSelectionStageEvidence[] {
	return [...(stagesByRequest.get(meta) ?? [])].map(([stage, entry]) => {
		const reasons: Partial<Record<RoutingExclusionReason, number>> = {};
		for (const reason of entry.candidates.values())
			if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
		return {
			stage,
			observed: entry.candidates.size,
			excluded: Object.values(reasons).reduce((a, b) => a + b, 0),
			complete: entry.complete && !entry.overflow,
			reasons,
		};
	});
}
export function observeRoutingInventory(
	meta: RequestMeta,
	outcome: "complete" | "failed" | "unknown",
): void {
	// An earlier failed inventory read remains a gap even if a terminal reread succeeds.
	if (meta.routingInventoryOutcome !== "failed")
		meta.routingInventoryOutcome = outcome;
}
/** Capture from typed transition evidence, never from the terminal wire body. */
export function captureRoutingDecision(
	meta: RequestMeta,
	terminalKind: string,
): RoutingDecision {
	const diagnostics = meta.routingSelectionDiagnostics;
	let reason: RoutingDecisionReason = "unknown";
	let evidence: RoutingDecision["evidence"] = "exact";
	if (
		terminalKind === "selection_timeout" ||
		diagnostics?.zeroAttemptReason === "selection_timeout"
	)
		reason = "selection_timeout";
	else if (meta.routingInventoryOutcome === "failed")
		reason = "inventory_failed";
	else if (
		terminalKind === "model_pool_exhausted" ||
		terminalKind === "pool_exhausted" ||
		terminalKind === "context_length_exceeded"
	)
		reason = terminalKind;
	else if (
		terminalKind === "predictive_throttle" ||
		terminalKind === "force_model_denied" ||
		terminalKind === "count_tokens_unsupported"
	)
		reason = terminalKind;
	else if (terminalKind.startsWith("force_route_"))
		reason = "force_route_denied";
	else if (terminalKind.startsWith("server_tool_"))
		reason = "server_tool_denied";
	else if (terminalKind === "route_unavailable") {
		reason = diagnostics?.zeroAttemptReason ?? "route_unavailable";
		evidence = diagnostics?.reasonEvidence ?? "unknown";
	} else evidence = "unknown";
	return {
		version: 1,
		requestedLogicalModel:
			meta.routingRequestedLogicalModel !== undefined
				? meta.routingRequestedLogicalModel
				: (meta.requestedLogicalModel ?? meta.originalModel ?? null),
		operation:
			meta.path === "/v1/messages/count_tokens"
				? "count_tokens"
				: meta.path === "/v1/messages"
					? "messages"
					: "other",
		origin: meta.trustedInternalAutoRefresh
			? "trusted_auto_refresh"
			: meta.routingTrustedKeepalive
				? "trusted_keepalive"
				: meta.routeLineage?.kind === "helper"
					? "trusted_helper"
					: "unknown",
		reason,
		evidence,
		inventory: meta.routingInventoryOutcome ?? "unknown",
		constraints:
			meta.routingDeclaredConstraints ?? currentRoutingConstraints(meta),
		selection:
			diagnostics &&
			!(
				meta.routingInventoryOutcome === "failed" &&
				diagnostics.reasonEvidence !== "exact"
			)
				? {
						mode: diagnostics.mode,
						structuralCandidateCount: diagnostics.structuralCandidateCount,
						eligibleCandidateCount: diagnostics.eligibleCandidateCount,
						excludedCandidateCount: diagnostics.excludedCandidateCount,
						selectedCandidateCount: diagnostics.selectedCandidateCount,
						zeroAttemptReason: diagnostics.zeroAttemptReason,
					}
				: null,
		stages: routingSelectionStageSnapshot(meta),
		...(capacitySnapshot(meta) ? { capacity: capacitySnapshot(meta) } : {}),
	};
}

export async function loadRoutingInventory<T>(
	meta: RequestMeta,
	load: () => Promise<T>,
): Promise<T> {
	try {
		const result = await load();
		observeRoutingInventory(meta, "complete");
		return result;
	} catch (error) {
		observeRoutingInventory(meta, "failed");
		throw error;
	}
}

interface CapacityObservation {
	keys: Set<string>;
	missingSnapshot: number;
	oldestSnapshotAgeMs: number | null;
	earliestBlockerExpiryMs: number | null;
	saturated: boolean;
}
const capacityByRequest = new WeakMap<RequestMeta, CapacityObservation>();
/** Existing evaluator supplies these facts; snapshot age does not establish freshness or exclusion. */
export function observeRoutingCapacity(
	meta: RequestMeta,
	key: string | null,
	observedAt: number | null,
	firstBlockerExpiry: number | null,
	now: number,
): void {
	let entry = capacityByRequest.get(meta);
	if (!entry) {
		entry = {
			keys: new Set(),
			missingSnapshot: 0,
			oldestSnapshotAgeMs: null,
			earliestBlockerExpiryMs: null,
			saturated: false,
		};
		capacityByRequest.set(meta, entry);
	}
	if (!safeCandidateKey(key)) {
		entry.saturated = true;
		return;
	}
	if (entry.keys.has(key)) return;
	if (entry.keys.size >= MAX_OBSERVED_STAGE_CANDIDATES) {
		entry.saturated = true;
		return;
	}
	entry.keys.add(key);
	if (observedAt === null) entry.missingSnapshot++;
	else {
		const age = Math.max(0, now - observedAt);
		if (age > 86_400_000) entry.saturated = true;
		entry.oldestSnapshotAgeMs = Math.max(
			entry.oldestSnapshotAgeMs ?? 0,
			Math.min(age, 86_400_000),
		);
	}
	if (firstBlockerExpiry !== null) {
		const ttl = Math.max(0, firstBlockerExpiry - now);
		if (ttl > 86_400_000) entry.saturated = true;
		entry.earliestBlockerExpiryMs = Math.min(
			entry.earliestBlockerExpiryMs ?? 86_400_000,
			Math.min(ttl, 86_400_000),
		);
	}
}
function capacitySnapshot(meta: RequestMeta): RoutingDecision["capacity"] {
	const entry = capacityByRequest.get(meta);
	return entry
		? {
				observed: entry.keys.size,
				missingSnapshot: entry.missingSnapshot,
				oldestSnapshotAgeMs: entry.oldestSnapshotAgeMs,
				earliestBlockerExpiryMs: entry.earliestBlockerExpiryMs,
				saturated: entry.saturated,
			}
		: undefined;
}

function currentRoutingConstraints(
	meta: RequestMeta,
): RoutingDecision["constraints"] {
	return {
		forcedRoute:
			meta.forcedAccountId != null ||
			meta.headers?.has("x-better-ccflare-account-id") === true,
		capabilityProfile:
			meta.routeProfileSelection === "capability" ||
			meta.routeProfileSelection === "implicit-codex",
		routeProfile: meta.routeProfileId != null,
		profileId: meta.routeProfileId ?? null,
		provider: meta.routeExpectedProvider ?? null,
		physicalModel:
			meta.routeExpectedPhysicalModel ??
			meta.routeProfileExpectedPhysicalModel ??
			null,
	};
}
/** Freeze declared policy before body rewriting or later authorized fallback alters working metadata. */
export function freezeRoutingDecisionConstraints(meta: RequestMeta): void {
	meta.routingDeclaredConstraints ??= Object.freeze(
		currentRoutingConstraints(meta),
	);
}
