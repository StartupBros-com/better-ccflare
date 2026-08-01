import { Buffer } from "node:buffer";
import {
	ANTHROPIC_DEGRADED_MODE_DEFAULTS,
	type AnthropicDegradedMode,
	type AnthropicDegradedModeConfig,
	resolveAnthropicDegradedModeConfig,
} from "@better-ccflare/config";
import {
	CLAUDE_MODEL_IDS,
	type ClaudeModelId,
	getModelFamily,
} from "@better-ccflare/core";

const KNOWN_CLAUDE_MODELS = new Set<ClaudeModelId>(
	Object.values(CLAUDE_MODEL_IDS),
);
const ALLOWED_BETA_FEATURES = new Set([
	"context-1m",
	"context-1m-2025-08-07",
	"oauth-2025-04-20",
	"prompt-caching-2024-07-31",
	"max-tokens-3-5-sonnet-2024-07-15",
	"computer-use-2024-10-22",
	"computer-use-2025-01-24",
	"interleaved-thinking-2025-05-14",
	"fine-grained-tool-streaming-2025-05-14",
	"token-efficient-tools-2025-02-19",
	"output-128k-2025-02-19",
]);
const MAX_BETA_SIGNATURE_BYTES = 512;
const MAX_BETA_FEATURES = 8;
const SATURATING_COUNTER_MAX = Number.MAX_SAFE_INTEGER;

declare const cohortKeyBrand: unique symbol;
export type AnthropicDegradedCohortKey = string & {
	readonly [cohortKeyBrand]: true;
};

export type AnthropicRequestProtocol = "messages" | "responses";
type AnthropicPathClass = AnthropicRequestProtocol;

export interface AnthropicDegradedCohortFacts {
	provider: string;
	endpoint: string;
	path?: string;
	protocol: AnthropicRequestProtocol;
	model: string;
	betaSignature?: string | null;
}

function canonicalizeAllowedBetaSignature(
	value: string | null | undefined,
): string | null {
	if (value == null || value.trim() === "") return "";
	if (Buffer.byteLength(value, "utf8") > MAX_BETA_SIGNATURE_BYTES) return null;
	const features = [
		...new Set(
			value
				.split(",")
				.map((feature) => feature.trim().toLowerCase())
				.filter(Boolean),
		),
	];
	if (
		features.length > MAX_BETA_FEATURES ||
		features.some((feature) => !ALLOWED_BETA_FEATURES.has(feature))
	) {
		return null;
	}
	return features.sort().join(",");
}

function pathClass(path: string): AnthropicPathClass | null {
	const normalized = path
		.split("?", 1)[0]
		?.replace(/\/+/g, "/")
		.replace(/\/$/, "")
		.toLowerCase();
	if (normalized?.endsWith("/messages")) return "messages";
	if (normalized?.endsWith("/responses")) return "responses";
	return null;
}

/**
 * Build a retained cohort key only from bounded, allowlisted physical-route
 * facts. Returning null is an intentional fail-open result.
 */
export function buildAnthropicDegradedCohortKey(
	facts: AnthropicDegradedCohortFacts,
): AnthropicDegradedCohortKey | null {
	if (facts.provider.trim().toLowerCase() !== "anthropic") return null;

	let endpoint: URL;
	try {
		endpoint = new URL(facts.endpoint);
	} catch {
		return null;
	}
	if (
		(endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
		endpoint.username !== "" ||
		endpoint.password !== ""
	) {
		return null;
	}

	const routePath = facts.path ?? endpoint.pathname;
	const routeClass = pathClass(routePath);
	if (routeClass === null || routeClass !== facts.protocol) return null;

	const normalizedModel = facts.model.trim().toLowerCase();
	if (!KNOWN_CLAUDE_MODELS.has(normalizedModel as ClaudeModelId)) return null;
	const family = getModelFamily(normalizedModel);
	if (family === null) return null;

	const beta = canonicalizeAllowedBetaSignature(facts.betaSignature);
	if (beta === null) return null;

	return JSON.stringify([
		"anthropic-degraded-cohort-v1",
		endpoint.protocol,
		endpoint.host.toLowerCase(),
		routeClass,
		family,
		facts.protocol,
		beta,
	]) as AnthropicDegradedCohortKey;
}

export type AnthropicReplayRiskReason = "tokens" | "bytes";

export interface AnthropicReplayRisk {
	readonly kind: "small" | "large";
	readonly bodyBytes: number;
	readonly estimatedInputTokens: number | null;
	readonly reasons: readonly AnthropicReplayRiskReason[];
}

export interface AnthropicReplayRiskInput {
	body: Uint8Array;
	estimateInputTokens?: () => unknown;
	config?: Pick<
		AnthropicDegradedModeConfig,
		"largeRequestTokenThreshold" | "largeRequestByteThreshold"
	>;
}

function normalizeTokenEstimate(value: unknown): number | null {
	const candidate =
		typeof value === "object" && value !== null && "tokens" in value
			? (value as { tokens?: unknown }).tokens
			: value;
	if (candidate === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	if (
		typeof candidate !== "number" ||
		!Number.isFinite(candidate) ||
		candidate < 0
	) {
		return null;
	}
	return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(candidate));
}

/**
 * Classify once from the final immutable body buffer. Estimator failure is a
 * byte-fallback condition, never a request failure.
 */
export function classifyAnthropicReplayRisk(
	input: AnthropicReplayRiskInput,
): AnthropicReplayRisk {
	const thresholds = input.config ?? ANTHROPIC_DEGRADED_MODE_DEFAULTS;
	const bodyBytes = Math.min(
		Number.MAX_SAFE_INTEGER,
		Math.max(0, input.body.byteLength),
	);
	let estimatedInputTokens: number | null = null;
	try {
		estimatedInputTokens = normalizeTokenEstimate(
			input.estimateInputTokens?.(),
		);
	} catch {
		estimatedInputTokens = null;
	}

	const reasons: AnthropicReplayRiskReason[] = [];
	if (
		estimatedInputTokens !== null &&
		estimatedInputTokens >= thresholds.largeRequestTokenThreshold
	) {
		reasons.push("tokens");
	}
	if (bodyBytes >= thresholds.largeRequestByteThreshold) {
		reasons.push("bytes");
	}
	return {
		kind: reasons.length > 0 ? "large" : "small",
		bodyBytes,
		estimatedInputTokens,
		reasons,
	};
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Parse Retry-After delta-seconds or an HTTP date, then return safe whole
 * seconds for a client response and the coordinator's next-probe time.
 */
export function sanitizeAnthropicRetryAfterSeconds(
	value: unknown,
	now: number,
	config: Pick<
		AnthropicDegradedModeConfig,
		"retryMinMs" | "retryFallbackMs" | "retryMaxMs"
	> = ANTHROPIC_DEGRADED_MODE_DEFAULTS,
): number {
	let milliseconds: number;
	const minimumSeconds = Math.ceil(config.retryMinMs / 1_000);
	const maximumSeconds = Math.ceil(config.retryMaxMs / 1_000);

	if (typeof value === "number") {
		milliseconds =
			value === Number.POSITIVE_INFINITY ? config.retryMaxMs : value * 1_000;
	} else if (typeof value === "string" && value.trim() !== "") {
		const numeric = Number(value);
		if (!Number.isNaN(numeric)) {
			milliseconds =
				numeric === Number.POSITIVE_INFINITY
					? config.retryMaxMs
					: numeric * 1_000;
		} else {
			const parsedDate = Date.parse(value);
			milliseconds = Number.isFinite(parsedDate)
				? parsedDate - now
				: config.retryFallbackMs;
		}
	} else {
		milliseconds = config.retryFallbackMs;
	}

	if (!Number.isFinite(milliseconds)) milliseconds = config.retryFallbackMs;
	return clamp(Math.ceil(milliseconds / 1_000), minimumSeconds, maximumSeconds);
}

export type AnthropicDegradedOutcome =
	| "http_529"
	| "semantic_overloaded"
	| "authentication"
	| "authorization"
	| "quota"
	| "rate_limited_429"
	| "transport"
	| "cancelled"
	| "success";

export interface AnthropicDegradedOutcomeObservation {
	cohortKey: AnthropicDegradedCohortKey;
	accountId: string;
	outcome: AnthropicDegradedOutcome;
	phase: "pre_commit" | "post_commit";
	forceRouted: boolean;
	retryAfter?: unknown;
}

export type AnthropicTrustedOverloadObservation = Omit<
	AnthropicDegradedOutcomeObservation,
	"outcome"
> & {
	outcome: "http_529" | "semantic_overloaded";
};

export type AnthropicDegradedObservationResult =
	| {
			kind: "ignored";
			accepted: false;
			cohortKey: AnthropicDegradedCohortKey;
			opened: false;
			reason:
				| "mode_off"
				| "non_overload"
				| "post_commit"
				| "force_routed"
				| "invalid_account";
	  }
	| {
			kind: "recorded";
			accepted: true;
			cohortKey: AnthropicDegradedCohortKey;
			distinctAccounts: number;
			opened: boolean;
			retryAfterSeconds?: number;
	  }
	| {
			kind: "dropped";
			accepted: false;
			cohortKey: AnthropicDegradedCohortKey;
			opened: false;
			reason: "protected_capacity";
	  };

type CohortState = "collecting" | "open" | "probing" | "recovering";

interface ProbeLease {
	generation: number;
	accountId: string;
	expiresAt: number;
	committed: boolean;
}

interface CohortEntry {
	state: CohortState;
	entryEpoch: bigint;
	updatedAt: number;
	generation: number;
	evidenceAccounts: Map<string, number>;
	nextProbeAt: number;
	lease?: ProbeLease;
	recoveringUntil?: number;
}

export type AnthropicDegradedCohortStateSnapshot =
	| { state: "inactive" }
	| {
			state: "collecting";
			distinctAccounts: number;
			oldestEvidenceAt: number;
	  }
	| {
			state: "open";
			nextProbeAt: number;
	  }
	| {
			state: "probing";
			nextProbeAt: number;
			leaseExpiresAt: number;
			leaseCommitted: boolean;
	  }
	| {
			state: "recovering";
			recoveringUntil: number;
	  };

export type AnthropicDegradedProtectionState =
	| "closed"
	| "open"
	| "probing"
	| "recovering";

export interface AnthropicDegradedRouteInspection {
	readonly cohortKey: AnthropicDegradedCohortKey | null;
	readonly state: AnthropicDegradedProtectionState;
	readonly detail: AnthropicDegradedCohortStateSnapshot;
}

export interface AnthropicDegradedModeSnapshot {
	mode: AnthropicDegradedMode;
	retainedCohorts: number;
	collectingCohorts: number;
	openCohorts: number;
	probingCohorts: number;
	recoveringCohorts: number;
	activeProbes: number;
	droppedEvidence: number;
	cohortAgeBands: {
		under30Seconds: number;
		from30SecondsTo5Minutes: number;
		atLeast5Minutes: number;
	};
}

export type AnthropicDegradedPermitOutcome =
	| "success"
	| "overloaded"
	| "cancelled"
	| "timeout"
	| "truncated"
	| "failed"
	| "abandoned";

export interface AnthropicDegradedPermit {
	readonly kind: "probe" | "recovery_send";
	readonly leaseExpiresAt: number | null;
	commit(): boolean;
	cancel(retryAfter?: unknown): boolean;
	complete(
		outcome: AnthropicDegradedPermitOutcome,
		retryAfter?: unknown,
	): boolean;
	expire(): boolean;
}

interface AdmissionBase {
	readonly wouldAction: "allow" | "probe" | "recovery_send" | "suppress";
	readonly enforced: boolean;
	readonly reservation: "not_required" | "reserved" | "denied";
}

export type AnthropicDegradedAdmissionDecision =
	| (AdmissionBase & {
			action: "allow";
			reason:
				| "mode_off"
				| "small_request"
				| "no_cohort"
				| "collecting"
				| "observed_probe"
				| "observed_recovery_send"
				| "observed_suppression";
			permit?: AnthropicDegradedPermit;
			retryAfterSeconds?: number;
			requiredAccountId?: string;
	  })
	| (AdmissionBase & {
			action: "send";
			enforced: true;
			reason: "probe_reserved" | "recovery_send_reserved";
			permit: AnthropicDegradedPermit;
	  })
	| (AdmissionBase & {
			action: "suppress";
			enforced: true;
			wouldAction: "suppress";
			reason:
				| "probe_not_ready"
				| "probe_in_flight"
				| "owner_mismatch"
				| "request_budget_spent";
			retryAfterSeconds: number;
			requiredAccountId?: string;
	  });

export interface AnthropicDegradedRequestAdmissionInput {
	cohortKey: AnthropicDegradedCohortKey | null;
	risk: AnthropicReplayRisk;
	ownerAccountId?: string | null;
	forceRouted?: boolean;
}

export class AnthropicDegradedRequestAdmission {
	private protectedSendClaimed = false;

	constructor(
		private readonly coordinator: AnthropicDegradedModeCoordinator,
		readonly input: Readonly<AnthropicDegradedRequestAdmissionInput>,
	) {}

	reserve(
		selectedAccountId: string,
		cohortKey: AnthropicDegradedCohortKey | null = this.input.cohortKey,
	): AnthropicDegradedAdmissionDecision {
		return this.coordinator.reserveForRequest(
			this,
			selectedAccountId,
			cohortKey,
		);
	}

	claimProtectedSend(): boolean {
		if (this.protectedSendClaimed) return false;
		this.protectedSendClaimed = true;
		return true;
	}

	get hasClaimedProtectedSend(): boolean {
		return this.protectedSendClaimed;
	}
}

type PermitPhase = "reserved" | "committed" | "terminal";

class FencedPermit implements AnthropicDegradedPermit {
	private phase: PermitPhase = "reserved";

	constructor(
		private readonly coordinator: AnthropicDegradedModeCoordinator,
		readonly cohortKey: AnthropicDegradedCohortKey,
		readonly accountId: string,
		readonly entryEpoch: bigint,
		readonly generation: number,
		readonly kind: "probe" | "recovery_send",
		readonly leaseExpiresAt: number | null,
	) {}

	commit(): boolean {
		if (this.phase !== "reserved") return false;
		if (!this.coordinator.commitPermit(this)) return false;
		this.phase = "committed";
		return true;
	}

	cancel(retryAfter?: unknown): boolean {
		if (this.phase !== "reserved") return false;
		if (!this.coordinator.cancelPermit(this, retryAfter)) return false;
		this.phase = "terminal";
		return true;
	}

	complete(
		outcome: AnthropicDegradedPermitOutcome,
		retryAfter?: unknown,
	): boolean {
		if (this.phase !== "committed") return false;
		if (!this.coordinator.completePermit(this, outcome, retryAfter)) {
			return false;
		}
		this.phase = "terminal";
		return true;
	}

	expire(): boolean {
		if (this.phase === "terminal") return false;
		if (!this.coordinator.expirePermit(this)) return false;
		this.phase = "terminal";
		return true;
	}
}

export interface AnthropicDegradedModeCoordinatorOptions {
	config?: AnthropicDegradedModeConfig;
	now?: () => number;
}

export class AnthropicDegradedModeCoordinator {
	readonly config: Readonly<AnthropicDegradedModeConfig>;
	private readonly nowSource: () => number;
	private readonly cohorts = new Map<AnthropicDegradedCohortKey, CohortEntry>();
	private droppedEvidence = 0;
	private nextEntryEpoch = 0n;

	constructor(options: AnthropicDegradedModeCoordinatorOptions = {}) {
		this.config = Object.freeze({
			...resolveAnthropicDegradedModeConfig(
				options.config ?? ANTHROPIC_DEGRADED_MODE_DEFAULTS,
			),
		});
		this.nowSource = options.now ?? Date.now;
	}

	/** Runtime adapters use the coordinator's clock for lease-aligned timers. */
	currentTime(): number {
		return this.now();
	}

	private allocateEntryEpoch(): bigint {
		this.nextEntryEpoch += 1n;
		return this.nextEntryEpoch;
	}

	private now(): number {
		const now = this.nowSource();
		return Number.isFinite(now) ? Math.max(0, Math.floor(now)) : Date.now();
	}

	private saturatingIncrementDroppedEvidence(): void {
		this.droppedEvidence = Math.min(
			SATURATING_COUNTER_MAX,
			this.droppedEvidence + 1,
		);
	}

	private transitionToOpen(
		entry: CohortEntry,
		now: number,
		retryAfter?: unknown,
	): number {
		const retryAfterSeconds = sanitizeAnthropicRetryAfterSeconds(
			retryAfter,
			now,
			this.config,
		);
		entry.state = "open";
		entry.updatedAt = now;
		entry.generation += 1;
		entry.evidenceAccounts.clear();
		entry.lease = undefined;
		entry.recoveringUntil = undefined;
		entry.nextProbeAt = Math.max(
			entry.nextProbeAt,
			now + retryAfterSeconds * 1_000,
		);
		return retryAfterSeconds;
	}

	private pruneEntry(
		key: AnthropicDegradedCohortKey,
		entry: CohortEntry,
		now: number,
	): CohortEntry | undefined {
		const cutoff = now - this.config.evidenceWindowMs;
		if (entry.state === "collecting") {
			for (const [accountId, observedAt] of entry.evidenceAccounts) {
				if (observedAt <= cutoff) entry.evidenceAccounts.delete(accountId);
			}
			if (entry.evidenceAccounts.size === 0) {
				this.cohorts.delete(key);
				return undefined;
			}
		}
		if (
			entry.state === "recovering" &&
			entry.recoveringUntil !== undefined &&
			now >= entry.recoveringUntil
		) {
			this.cohorts.delete(key);
			return undefined;
		}
		// Elapsed time cannot prove a committed transport was aborted. Only
		// the watchdog owner may explicitly expire and fence that permit.
		if (
			entry.state === "probing" &&
			entry.lease !== undefined &&
			!entry.lease.committed &&
			now >= entry.lease.expiresAt
		) {
			this.transitionToOpen(entry, now, this.config.retryMinMs / 1_000);
		}
		return entry;
	}

	/**
	 * Single-cohort operations prune only the cohort they are about to inspect.
	 * A map-wide pass is reserved for capacity/eviction and aggregate snapshots,
	 * whose semantics require an exact global view. This keeps request admission
	 * work independent of the retained cohort count while preserving the same
	 * expiration boundary for every cohort when it is read or mutated.
	 */
	private pruneCohort(
		key: AnthropicDegradedCohortKey,
		now: number,
	): CohortEntry | undefined {
		const entry = this.cohorts.get(key);
		return entry === undefined ? undefined : this.pruneEntry(key, entry, now);
	}

	private pruneAll(now: number): void {
		for (const [key, entry] of this.cohorts) {
			this.pruneEntry(key, entry, now);
		}
	}

	private makeCollectingEntry(
		key: AnthropicDegradedCohortKey,
		now: number,
		incomingAccountId: string,
	): CohortEntry | null {
		this.pruneAll(now);
		if (this.cohorts.size >= this.config.maxCohorts) {
			type EvictionCandidate = {
				key: AnthropicDegradedCohortKey;
				oldestEvidenceAt: number;
				entryEpoch: bigint;
			};
			let oldestCollecting: EvictionCandidate | null = null;
			let oldestSameAccountChurn: EvictionCandidate | null = null;
			const isOlder = (
				candidate: EvictionCandidate,
				current: EvictionCandidate | null,
			): boolean =>
				current === null ||
				candidate.oldestEvidenceAt < current.oldestEvidenceAt ||
				(candidate.oldestEvidenceAt === current.oldestEvidenceAt &&
					candidate.entryEpoch < current.entryEpoch);

			for (const [candidateKey, candidate] of this.cohorts) {
				if (candidate.state !== "collecting") continue;
				const evictionCandidate: EvictionCandidate = {
					key: candidateKey,
					oldestEvidenceAt: Math.min(...candidate.evidenceAccounts.values()),
					entryEpoch: candidate.entryEpoch,
				};
				if (isOlder(evictionCandidate, oldestCollecting)) {
					oldestCollecting = evictionCandidate;
				}
				if (
					candidate.evidenceAccounts.size === 1 &&
					candidate.evidenceAccounts.has(incomingAccountId) &&
					isOlder(evictionCandidate, oldestSameAccountChurn)
				) {
					oldestSameAccountChurn = evictionCandidate;
				}
			}
			const eviction = oldestSameAccountChurn ?? oldestCollecting;
			if (eviction !== null) this.cohorts.delete(eviction.key);
		}
		if (this.cohorts.size >= this.config.maxCohorts) {
			this.saturatingIncrementDroppedEvidence();
			return null;
		}

		const entry: CohortEntry = {
			state: "collecting",
			entryEpoch: this.allocateEntryEpoch(),
			updatedAt: now,
			generation: 0,
			evidenceAccounts: new Map(),
			nextProbeAt: 0,
		};
		this.cohorts.set(key, entry);
		return entry;
	}

	recordOutcome(
		observation: AnthropicDegradedOutcomeObservation,
	): AnthropicDegradedObservationResult {
		const resultBase = {
			cohortKey: observation.cohortKey,
			opened: false as const,
		};
		if (this.config.mode === "off") {
			return {
				...resultBase,
				kind: "ignored",
				accepted: false,
				reason: "mode_off",
			};
		}
		if (
			observation.outcome !== "http_529" &&
			observation.outcome !== "semantic_overloaded"
		) {
			return {
				...resultBase,
				kind: "ignored",
				accepted: false,
				reason: "non_overload",
			};
		}
		if (observation.phase !== "pre_commit") {
			return {
				...resultBase,
				kind: "ignored",
				accepted: false,
				reason: "post_commit",
			};
		}
		if (observation.forceRouted) {
			return {
				...resultBase,
				kind: "ignored",
				accepted: false,
				reason: "force_routed",
			};
		}
		const accountId = observation.accountId.trim();
		if (!accountId) {
			return {
				...resultBase,
				kind: "ignored",
				accepted: false,
				reason: "invalid_account",
			};
		}

		const now = this.now();
		let entry = this.pruneCohort(observation.cohortKey, now);
		if (entry === undefined) {
			entry =
				this.makeCollectingEntry(observation.cohortKey, now, accountId) ??
				undefined;
			if (entry === undefined) {
				return {
					...resultBase,
					kind: "dropped",
					accepted: false,
					reason: "protected_capacity",
				};
			}
		}

		if (entry.state === "recovering") {
			const retryAfterSeconds = this.transitionToOpen(
				entry,
				now,
				observation.retryAfter,
			);
			return {
				kind: "recorded",
				accepted: true,
				cohortKey: observation.cohortKey,
				distinctAccounts: this.config.quorum,
				opened: true,
				retryAfterSeconds,
			};
		}
		if (entry.state === "open" || entry.state === "probing") {
			const retryAfterSeconds = sanitizeAnthropicRetryAfterSeconds(
				observation.retryAfter,
				now,
				this.config,
			);
			entry.nextProbeAt = Math.max(
				entry.nextProbeAt,
				now + retryAfterSeconds * 1_000,
			);
			entry.updatedAt = now;
			return {
				...resultBase,
				kind: "recorded",
				accepted: true,
				distinctAccounts: this.config.quorum,
				retryAfterSeconds,
			};
		}

		const cutoff = now - this.config.evidenceWindowMs;
		for (const [seenAccountId, observedAt] of entry.evidenceAccounts) {
			if (observedAt <= cutoff) entry.evidenceAccounts.delete(seenAccountId);
		}
		entry.evidenceAccounts.set(accountId, now);
		entry.updatedAt = now;
		const distinctAccounts = entry.evidenceAccounts.size;
		if (distinctAccounts < this.config.quorum) {
			return {
				...resultBase,
				kind: "recorded",
				accepted: true,
				distinctAccounts,
			};
		}

		const retryAfterSeconds = this.transitionToOpen(
			entry,
			now,
			observation.retryAfter,
		);
		return {
			kind: "recorded",
			accepted: true,
			cohortKey: observation.cohortKey,
			distinctAccounts,
			opened: true,
			retryAfterSeconds,
		};
	}

	observeTrustedOverload(
		observation: AnthropicTrustedOverloadObservation,
	): AnthropicDegradedObservationResult {
		return this.recordOutcome(observation);
	}

	createRequestAdmission(
		input: AnthropicDegradedRequestAdmissionInput,
	): AnthropicDegradedRequestAdmission {
		return new AnthropicDegradedRequestAdmission(
			this,
			Object.freeze({ ...input }),
		);
	}

	private retrySeconds(entry: CohortEntry, now: number): number {
		const remainingSeconds = Math.ceil(
			Math.max(0, entry.nextProbeAt - now) / 1_000,
		);
		return sanitizeAnthropicRetryAfterSeconds(
			remainingSeconds,
			now,
			this.config,
		);
	}

	private suppressionDecision(
		reason:
			| "probe_not_ready"
			| "probe_in_flight"
			| "owner_mismatch"
			| "request_budget_spent",
		entry: CohortEntry,
		now: number,
		requiredAccountId?: string,
	): AnthropicDegradedAdmissionDecision {
		const retryAfterSeconds = this.retrySeconds(entry, now);
		if (this.config.mode === "observe") {
			return {
				action: "allow",
				wouldAction: "suppress",
				enforced: false,
				reservation: "denied",
				reason: "observed_suppression",
				retryAfterSeconds,
				requiredAccountId,
			};
		}
		return {
			action: "suppress",
			wouldAction: "suppress",
			enforced: true,
			reservation: "denied",
			reason,
			retryAfterSeconds,
			requiredAccountId,
		};
	}

	reserveForRequest(
		request: AnthropicDegradedRequestAdmission,
		selectedAccountId: string,
		cohortKey: AnthropicDegradedCohortKey | null = request.input.cohortKey,
	): AnthropicDegradedAdmissionDecision {
		if (this.config.mode === "off") {
			return {
				action: "allow",
				wouldAction: "allow",
				enforced: false,
				reservation: "not_required",
				reason: "mode_off",
			};
		}
		if (request.input.risk.kind !== "large") {
			return {
				action: "allow",
				wouldAction: "allow",
				enforced: false,
				reservation: "not_required",
				reason: "small_request",
			};
		}
		const key = cohortKey;
		if (key === null) {
			return {
				action: "allow",
				wouldAction: "allow",
				enforced: false,
				reservation: "not_required",
				reason: "no_cohort",
			};
		}

		const now = this.now();
		const entry = this.pruneCohort(key, now);
		if (entry === undefined) {
			return {
				action: "allow",
				wouldAction: "allow",
				enforced: false,
				reservation: "not_required",
				reason: "no_cohort",
			};
		}
		if (entry.state === "collecting") {
			return {
				action: "allow",
				wouldAction: "allow",
				enforced: false,
				reservation: "not_required",
				reason: "collecting",
			};
		}
		if (request.hasClaimedProtectedSend) {
			return this.suppressionDecision("request_budget_spent", entry, now);
		}

		const ownerAccountId = request.input.ownerAccountId?.trim();
		if (ownerAccountId && ownerAccountId !== selectedAccountId) {
			return this.suppressionDecision(
				"owner_mismatch",
				entry,
				now,
				ownerAccountId,
			);
		}

		if (entry.state === "probing") {
			return this.suppressionDecision("probe_in_flight", entry, now);
		}
		if (entry.state === "open" && now < entry.nextProbeAt) {
			return this.suppressionDecision("probe_not_ready", entry, now);
		}

		if (!request.claimProtectedSend()) {
			return this.suppressionDecision("request_budget_spent", entry, now);
		}

		let permit: FencedPermit;
		let wouldAction: "probe" | "recovery_send";
		if (entry.state === "open") {
			entry.state = "probing";
			entry.generation += 1;
			entry.updatedAt = now;
			entry.lease = {
				generation: entry.generation,
				accountId: selectedAccountId,
				expiresAt: now + this.config.probeLeaseMs,
				committed: false,
			};
			permit = new FencedPermit(
				this,
				key,
				selectedAccountId,
				entry.entryEpoch,
				entry.generation,
				"probe",
				entry.lease.expiresAt,
			);
			wouldAction = "probe";
		} else {
			permit = new FencedPermit(
				this,
				key,
				selectedAccountId,
				entry.entryEpoch,
				entry.generation,
				"recovery_send",
				null,
			);
			wouldAction = "recovery_send";
		}

		if (this.config.mode === "observe") {
			return {
				action: "allow",
				wouldAction,
				enforced: false,
				reservation: "reserved",
				reason:
					wouldAction === "probe" ? "observed_probe" : "observed_recovery_send",
				permit,
			};
		}
		return {
			action: "send",
			wouldAction,
			enforced: true,
			reservation: "reserved",
			reason:
				wouldAction === "probe" ? "probe_reserved" : "recovery_send_reserved",
			permit,
		};
	}

	private matchingProbeLease(
		permit: FencedPermit,
		entry: CohortEntry | undefined,
	): { entry: CohortEntry; lease: ProbeLease } | null {
		if (
			entry?.state !== "probing" ||
			entry.lease === undefined ||
			entry.entryEpoch !== permit.entryEpoch ||
			entry.lease.generation !== permit.generation ||
			entry.lease.accountId !== permit.accountId
		) {
			return null;
		}
		return { entry, lease: entry.lease };
	}

	commitPermit(permit: FencedPermit): boolean {
		const now = this.now();
		const entry = this.pruneCohort(permit.cohortKey, now);
		if (permit.kind === "recovery_send") {
			return (
				entry?.state === "recovering" &&
				entry.entryEpoch === permit.entryEpoch &&
				entry.generation === permit.generation
			);
		}
		const match = this.matchingProbeLease(permit, entry);
		if (match === null || match.lease.committed) return false;
		match.lease.committed = true;
		return true;
	}

	cancelPermit(permit: FencedPermit, retryAfter?: unknown): boolean {
		const now = this.now();
		const entry = this.pruneCohort(permit.cohortKey, now);
		if (permit.kind === "recovery_send") {
			return (
				entry?.state === "recovering" &&
				entry.entryEpoch === permit.entryEpoch &&
				entry.generation === permit.generation
			);
		}
		const match = this.matchingProbeLease(permit, entry);
		if (match === null || match.lease.committed) return false;
		this.transitionToOpen(match.entry, now, retryAfter);
		return true;
	}

	completePermit(
		permit: FencedPermit,
		outcome: AnthropicDegradedPermitOutcome,
		retryAfter?: unknown,
	): boolean {
		const now = this.now();
		const entry = this.pruneCohort(permit.cohortKey, now);

		if (permit.kind === "recovery_send") {
			if (
				entry?.state !== "recovering" ||
				entry.entryEpoch !== permit.entryEpoch ||
				entry.generation !== permit.generation
			) {
				return false;
			}
			if (outcome === "overloaded") {
				this.transitionToOpen(entry, now, retryAfter);
			}
			return true;
		}

		const match = this.matchingProbeLease(permit, entry);
		if (match === null || !match.lease.committed) return false;
		if (outcome === "success") {
			match.entry.state = "recovering";
			match.entry.updatedAt = now;
			match.entry.generation += 1;
			match.entry.lease = undefined;
			match.entry.recoveringUntil = now + this.config.recoveryWindowMs;
			match.entry.nextProbeAt = 0;
			return true;
		}
		this.transitionToOpen(match.entry, now, retryAfter);
		return true;
	}

	expirePermit(permit: FencedPermit): boolean {
		if (permit.kind === "recovery_send" || permit.leaseExpiresAt === null) {
			return false;
		}
		const now = this.now();
		if (now < permit.leaseExpiresAt) return false;
		const entry = this.cohorts.get(permit.cohortKey);
		const match = this.matchingProbeLease(permit, entry);
		if (match === null) return false;
		this.transitionToOpen(match.entry, now, this.config.retryMinMs / 1_000);
		return true;
	}

	/**
	 * Side-effect-free state read for pre-selection ownership decisions. It
	 * interprets elapsed windows without pruning, acquiring, or releasing state.
	 */
	peekCohortState(
		key: AnthropicDegradedCohortKey,
		at: number = this.now(),
	): AnthropicDegradedCohortStateSnapshot {
		if (this.config.mode === "off") return { state: "inactive" };
		const now = Number.isFinite(at) ? Math.max(0, Math.floor(at)) : this.now();
		const entry = this.cohorts.get(key);
		if (entry === undefined) return { state: "inactive" };
		if (entry.state === "collecting") {
			const cutoff = now - this.config.evidenceWindowMs;
			const liveEvidence = [...entry.evidenceAccounts.values()].filter(
				(observedAt) => observedAt > cutoff,
			);
			if (liveEvidence.length === 0) return { state: "inactive" };
			return {
				state: "collecting",
				distinctAccounts: liveEvidence.length,
				oldestEvidenceAt: Math.min(...liveEvidence),
			};
		}
		if (
			entry.state === "recovering" &&
			entry.recoveringUntil !== undefined &&
			now >= entry.recoveringUntil
		) {
			return { state: "inactive" };
		}
		if (
			entry.state === "probing" &&
			entry.lease !== undefined &&
			!entry.lease.committed &&
			now >= entry.lease.expiresAt
		) {
			return {
				state: "open",
				nextProbeAt: Math.max(entry.nextProbeAt, now + this.config.retryMinMs),
			};
		}
		if (entry.state === "open") {
			return { state: "open", nextProbeAt: entry.nextProbeAt };
		}
		if (entry.state === "probing") {
			return {
				state: "probing",
				nextProbeAt: entry.nextProbeAt,
				leaseExpiresAt: entry.lease?.expiresAt ?? now,
				leaseCommitted: entry.lease?.committed ?? false,
			};
		}
		return {
			state: "recovering",
			recoveringUntil: entry.recoveringUntil ?? now,
		};
	}

	/**
	 * Pure route-to-cohort derivation plus a non-mutating protection snapshot.
	 * U2 can call this before account selection without checking out a permit.
	 */
	inspectRoute(
		facts: AnthropicDegradedCohortFacts,
	): AnthropicDegradedRouteInspection {
		const cohortKey = buildAnthropicDegradedCohortKey(facts);
		const detail =
			cohortKey === null
				? ({ state: "inactive" } as const)
				: this.peekCohortState(cohortKey);
		return {
			cohortKey,
			state:
				detail.state === "open" ||
				detail.state === "probing" ||
				detail.state === "recovering"
					? detail.state
					: "closed",
			detail,
		};
	}

	getCohortState(
		key: AnthropicDegradedCohortKey,
	): AnthropicDegradedCohortStateSnapshot {
		if (this.config.mode === "off") return { state: "inactive" };
		const now = this.now();
		this.pruneCohort(key, now);
		return this.peekCohortState(key, now);
	}

	snapshot(nowOverride?: number): AnthropicDegradedModeSnapshot {
		const now =
			typeof nowOverride === "number" && Number.isFinite(nowOverride)
				? Math.max(0, Math.floor(nowOverride))
				: this.now();
		if (this.config.mode !== "off") this.pruneAll(now);
		let collectingCohorts = 0;
		let openCohorts = 0;
		let probingCohorts = 0;
		let recoveringCohorts = 0;
		const cohortAgeBands = {
			under30Seconds: 0,
			from30SecondsTo5Minutes: 0,
			atLeast5Minutes: 0,
		};
		for (const entry of this.cohorts.values()) {
			if (entry.state === "collecting") collectingCohorts += 1;
			else if (entry.state === "open") openCohorts += 1;
			else if (entry.state === "probing") probingCohorts += 1;
			else recoveringCohorts += 1;
			const ageMs = Math.max(0, now - entry.updatedAt);
			if (ageMs < 30_000) cohortAgeBands.under30Seconds += 1;
			else if (ageMs < 5 * 60_000) {
				cohortAgeBands.from30SecondsTo5Minutes += 1;
			} else {
				cohortAgeBands.atLeast5Minutes += 1;
			}
		}
		return {
			mode: this.config.mode,
			retainedCohorts: this.cohorts.size,
			collectingCohorts,
			openCohorts,
			probingCohorts,
			recoveringCohorts,
			activeProbes: probingCohorts,
			droppedEvidence: this.droppedEvidence,
			cohortAgeBands,
		};
	}
}
