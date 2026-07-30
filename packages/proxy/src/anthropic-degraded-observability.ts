import type { AnthropicDegradedMode } from "@better-ccflare/config";
import {
	type OpaqueRuntimeId,
	type OpaqueRuntimeIdFactory,
	processOpaqueRuntimeIdFactory,
} from "./opaque-runtime-id";

export const ANTHROPIC_DEGRADED_DIAGNOSTIC_EVENT_VERSION = 1 as const;
export const ANTHROPIC_DEGRADED_MAX_EVENTS_PER_REQUEST = 32;
export const ANTHROPIC_DEGRADED_MAX_PENDING_SINK_OPERATIONS = 64;

const SATURATING_COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const NON_TERMINAL_EVENT_BUDGET = ANTHROPIC_DEGRADED_MAX_EVENTS_PER_REQUEST - 1;

export type DegradedModeReplayRisk = "small" | "large" | "unknown";
export type DegradedModeSizeBucket =
	| "small"
	| "near_threshold"
	| "large"
	| "unknown";
export type DegradedModePhysicalAttemptKind =
	| "initial"
	| "in_place_retry"
	| "account_failover"
	| "recovery_probe"
	| "guard_replay";
export type DegradedModeSuppressionDecision = "suppressed" | "would_suppress";
export type DegradedModeSuppressionReason =
	| "cohort_open"
	| "probe_busy"
	| "owner_mismatch"
	| "owner_missing"
	| "route_ineligible"
	| "retry_exhausted"
	| "unknown";
export type DegradedModeTransitionSubject = "quorum" | "probe" | "owner";
export type DegradedModeTransitionState =
	| "inactive"
	| "collecting"
	| "open"
	| "reserved"
	| "committed"
	| "recovering"
	| "missing"
	| "retained"
	| "invalidated";
export type DegradedModeTransitionReason =
	| "trusted_overload"
	| "evidence_expired"
	| "probe_reserved"
	| "probe_committed"
	| "probe_success"
	| "probe_failure"
	| "probe_timeout"
	| "owner_observed"
	| "owner_invalidated"
	| "hold_down_elapsed"
	| "restart"
	| "unknown";
export type DegradedModeTerminalOutcome =
	| "success"
	| "overload"
	| "suppressed"
	| "failure"
	| "cancelled"
	| "timeout";

interface DegradedModeDiagnosticEventBase {
	readonly version: typeof ANTHROPIC_DEGRADED_DIAGNOSTIC_EVENT_VERSION;
	readonly bootId: OpaqueRuntimeId<"boot">;
	readonly logicalRequestId: OpaqueRuntimeId<"logical_request">;
	readonly sequence: number;
	readonly guardAttemptOrdinal?: number;
}

export interface DegradedModeRequestDiagnosticEvent
	extends DegradedModeDiagnosticEventBase {
	readonly kind: "request";
	readonly replayRisk: DegradedModeReplayRisk;
	readonly sizeBucket: DegradedModeSizeBucket;
	/** Exact estimates are allowed only in this default-off detailed event. */
	readonly estimatedInputTokens?: number;
	/** Exact estimates are allowed only in this default-off detailed event. */
	readonly bodyBytes?: number;
}

export interface DegradedModePhysicalAttemptDiagnosticEvent
	extends DegradedModeDiagnosticEventBase {
	readonly kind: "physical_attempt";
	readonly physicalAttemptId: OpaqueRuntimeId<"physical_attempt">;
	readonly physicalAttemptOrdinal: number;
	readonly attemptKind: DegradedModePhysicalAttemptKind;
	readonly accountId?: OpaqueRuntimeId<"account">;
	readonly candidateId?: OpaqueRuntimeId<"candidate">;
	readonly laneId?: OpaqueRuntimeId<"lane">;
}

export interface DegradedModeSuppressionDiagnosticEvent
	extends DegradedModeDiagnosticEventBase {
	readonly kind: "suppression";
	readonly decision: DegradedModeSuppressionDecision;
	readonly reason: DegradedModeSuppressionReason;
	readonly cohortId?: OpaqueRuntimeId<"cohort">;
	readonly ownerId?: OpaqueRuntimeId<"owner">;
}

export interface DegradedModeTransitionDiagnosticEvent
	extends DegradedModeDiagnosticEventBase {
	readonly kind: "transition";
	readonly subject: DegradedModeTransitionSubject;
	readonly from: DegradedModeTransitionState;
	readonly to: DegradedModeTransitionState;
	readonly reason: DegradedModeTransitionReason;
	readonly cohortId?: OpaqueRuntimeId<"cohort">;
	readonly ownerId?: OpaqueRuntimeId<"owner">;
}

export interface DegradedModeTerminalDiagnosticEvent
	extends DegradedModeDiagnosticEventBase {
	readonly kind: "terminal";
	readonly outcome: DegradedModeTerminalOutcome;
	readonly physicalAttemptCount: number;
}

export type DegradedModeDiagnosticEvent =
	| DegradedModeRequestDiagnosticEvent
	| DegradedModePhysicalAttemptDiagnosticEvent
	| DegradedModeSuppressionDiagnosticEvent
	| DegradedModeTransitionDiagnosticEvent
	| DegradedModeTerminalDiagnosticEvent;

/**
 * Returning false is synchronous backpressure. A rejected promise is an
 * asynchronous drop. The producer never awaits either path.
 */
export type DegradedModeDetailedEventSink = (
	event: Readonly<DegradedModeDiagnosticEvent>,
) => undefined | boolean | PromiseLike<unknown>;

export type DegradedModeAggregateCounter =
	| "logicalRequests"
	| "guardAttempts"
	| "localAttempts"
	| "physicalAttempts"
	| "suppressedSends"
	| "wouldSuppressSends"
	| "probeSends"
	| "wouldProbeSends"
	| "overloadEvidence"
	| "quorumTransitions"
	| "probeTransitions"
	| "ownerTransitions"
	| "terminalRequests"
	| "terminalSuccesses"
	| "terminalOverloads"
	| "terminalSuppressed"
	| "terminalCancelled"
	| "terminalTimeouts"
	| "terminalFailures"
	| "droppedEvents";

interface DegradedModeAggregateCounters {
	logicalRequests: number;
	guardAttempts: number;
	localAttempts: number;
	physicalAttempts: number;
	suppressedSends: number;
	wouldSuppressSends: number;
	probeSends: number;
	wouldProbeSends: number;
	overloadEvidence: number;
	quorumTransitions: number;
	probeTransitions: number;
	ownerTransitions: number;
	terminalRequests: number;
	terminalSuccesses: number;
	terminalOverloads: number;
	terminalSuppressed: number;
	terminalCancelled: number;
	terminalTimeouts: number;
	terminalFailures: number;
	droppedEvents: number;
}

export interface DegradedModeObservabilitySnapshot
	extends DegradedModeAggregateCounters {
	readonly version: 1;
	readonly mode: AnthropicDegradedMode;
	readonly largeRequestTokenThreshold: number;
	readonly largeRequestByteThreshold: number;
	readonly detailedEventsEnabled: boolean;
	readonly bootId: OpaqueRuntimeId<"boot">;
	readonly pendingDetailedEvents: number;
}

export interface DegradedModeObservabilityOptions {
	readonly mode: AnthropicDegradedMode;
	readonly largeRequestTokenThreshold: number;
	readonly largeRequestByteThreshold: number;
	readonly detailedEventsEnabled?: boolean;
	readonly sink?: DegradedModeDetailedEventSink;
	readonly idFactory?: OpaqueRuntimeIdFactory;
}

export interface DegradedModeRequestStart {
	/** Raw only at this call boundary; it is immediately replaced by a pseudonym. */
	readonly correlationKey: string;
	readonly replayRisk: DegradedModeReplayRisk;
	readonly sizeBucket: DegradedModeSizeBucket;
	readonly guardAttemptOrdinal?: number;
	readonly estimatedInputTokens?: number | null;
	readonly bodyBytes?: number | null;
}

export interface DegradedModePhysicalAttemptInput {
	readonly ordinal: number;
	readonly kind: DegradedModePhysicalAttemptKind;
	readonly accountKey?: string | null;
	readonly candidateKey?: string | null;
	readonly laneKey?: string | null;
}

export interface DegradedModeSuppressionInput {
	readonly decision: DegradedModeSuppressionDecision;
	readonly reason: DegradedModeSuppressionReason;
	readonly cohortKey?: string | null;
	readonly ownerKey?: string | null;
}

export interface DegradedModeTransitionInput {
	readonly subject: DegradedModeTransitionSubject;
	readonly from: DegradedModeTransitionState;
	readonly to: DegradedModeTransitionState;
	readonly reason: DegradedModeTransitionReason;
	readonly cohortKey?: string | null;
	readonly ownerKey?: string | null;
}

export interface DegradedModeTerminalInput {
	readonly outcome: DegradedModeTerminalOutcome;
}

function createZeroCounters(): DegradedModeAggregateCounters {
	return {
		logicalRequests: 0,
		guardAttempts: 0,
		localAttempts: 0,
		physicalAttempts: 0,
		suppressedSends: 0,
		wouldSuppressSends: 0,
		probeSends: 0,
		wouldProbeSends: 0,
		overloadEvidence: 0,
		quorumTransitions: 0,
		probeTransitions: 0,
		ownerTransitions: 0,
		terminalRequests: 0,
		terminalSuccesses: 0,
		terminalOverloads: 0,
		terminalSuppressed: 0,
		terminalCancelled: 0,
		terminalTimeouts: 0,
		terminalFailures: 0,
		droppedEvents: 0,
	};
}

function boundedInteger(value: number | null | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.min(SATURATING_COUNTER_MAX, Math.floor(value));
}

function positiveOrdinal(value: number): number {
	const bounded = boundedInteger(value);
	return bounded === undefined ? 1 : Math.max(1, bounded);
}

function optionalPositiveOrdinal(
	value: number | null | undefined,
): number | undefined {
	const bounded = boundedInteger(value);
	return bounded === undefined || bounded < 1 ? undefined : bounded;
}

function optionalOpaqueId<Domain extends "account" | "candidate" | "lane">(
	factory: OpaqueRuntimeIdFactory,
	domain: Domain,
	value: string | null | undefined,
): OpaqueRuntimeId<Domain> | undefined {
	if (value == null || value === "") return undefined;
	return factory.id(domain, value);
}

export class DegradedModeObservability {
	private readonly mode: AnthropicDegradedMode;
	private readonly largeRequestTokenThreshold: number;
	private readonly largeRequestByteThreshold: number;
	private readonly detailedEventsEnabled: boolean;
	private readonly sink: DegradedModeDetailedEventSink | undefined;
	private readonly idFactory: OpaqueRuntimeIdFactory;
	private readonly counters = createZeroCounters();
	private pendingDetailedEvents = 0;

	constructor(options: DegradedModeObservabilityOptions) {
		this.mode = options.mode;
		this.largeRequestTokenThreshold =
			boundedInteger(options.largeRequestTokenThreshold) ?? 0;
		this.largeRequestByteThreshold =
			boundedInteger(options.largeRequestByteThreshold) ?? 0;
		this.detailedEventsEnabled =
			options.detailedEventsEnabled === true && options.sink !== undefined;
		this.sink = options.sink;
		this.idFactory = options.idFactory ?? processOpaqueRuntimeIdFactory;
	}

	get detailsEnabled(): boolean {
		return this.detailedEventsEnabled;
	}

	incrementCounter(counter: DegradedModeAggregateCounter, amount = 1): void {
		if (
			!Number.isSafeInteger(amount) ||
			amount <= 0 ||
			this.counters[counter] >= SATURATING_COUNTER_MAX
		) {
			return;
		}
		this.counters[counter] = Math.min(
			SATURATING_COUNTER_MAX,
			this.counters[counter] + amount,
		);
	}

	recordOverloadEvidence(): void {
		this.incrementCounter("overloadEvidence");
	}

	beginRequest(input: DegradedModeRequestStart): DegradedModeRequestTracker {
		const guardAttemptOrdinal = optionalPositiveOrdinal(
			input.guardAttemptOrdinal,
		);
		if (guardAttemptOrdinal === undefined || guardAttemptOrdinal === 1) {
			this.incrementCounter("logicalRequests");
		}
		if (guardAttemptOrdinal !== undefined) {
			this.incrementCounter("guardAttempts");
		} else {
			this.incrementCounter("localAttempts");
		}
		let logicalRequestId: OpaqueRuntimeId<"logical_request"> | null = null;
		if (this.detailedEventsEnabled) {
			try {
				logicalRequestId = this.idFactory.id(
					"logical_request",
					input.correlationKey,
				);
			} catch {
				this.incrementCounter("droppedEvents");
			}
		}
		const tracker = new DegradedModeRequestTracker(
			this,
			this.idFactory,
			logicalRequestId,
			guardAttemptOrdinal,
		);
		if (logicalRequestId !== null) {
			tracker.emitStart({
				replayRisk: input.replayRisk,
				sizeBucket: input.sizeBucket,
				estimatedInputTokens: boundedInteger(input.estimatedInputTokens),
				bodyBytes: boundedInteger(input.bodyBytes),
			});
		}
		return tracker;
	}

	snapshot(): DegradedModeObservabilitySnapshot {
		return Object.freeze({
			version: 1,
			mode: this.mode,
			largeRequestTokenThreshold: this.largeRequestTokenThreshold,
			largeRequestByteThreshold: this.largeRequestByteThreshold,
			detailedEventsEnabled: this.detailedEventsEnabled,
			bootId: this.idFactory.bootId,
			...this.counters,
			pendingDetailedEvents: this.pendingDetailedEvents,
		});
	}

	emitDetailed(event: DegradedModeDiagnosticEvent): boolean {
		if (!this.detailedEventsEnabled || this.sink === undefined) return false;
		if (
			this.pendingDetailedEvents >=
			ANTHROPIC_DEGRADED_MAX_PENDING_SINK_OPERATIONS
		) {
			this.incrementCounter("droppedEvents");
			return false;
		}

		this.pendingDetailedEvents++;
		const frozenEvent = Object.freeze(event);
		try {
			queueMicrotask(() => {
				let result: ReturnType<DegradedModeDetailedEventSink>;
				try {
					result = this.sink?.(frozenEvent);
				} catch {
					this.pendingDetailedEvents--;
					this.incrementCounter("droppedEvents");
					return;
				}

				if (result === false) {
					this.pendingDetailedEvents--;
					this.incrementCounter("droppedEvents");
					return;
				}
				if (result === undefined || result === true) {
					this.pendingDetailedEvents--;
					return;
				}

				Promise.resolve(result).then(
					(accepted) => {
						this.pendingDetailedEvents--;
						if (accepted === false) this.incrementCounter("droppedEvents");
					},
					() => {
						this.pendingDetailedEvents--;
						this.incrementCounter("droppedEvents");
					},
				);
			});
		} catch {
			this.pendingDetailedEvents--;
			this.incrementCounter("droppedEvents");
			return false;
		}
		return true;
	}

	dropBudgetedEvent(): void {
		if (this.detailedEventsEnabled) this.incrementCounter("droppedEvents");
	}
}

export class DegradedModeRequestTracker {
	private sequence = 0;
	private nonTerminalEvents = 0;
	private physicalAttemptCount = 0;
	private terminal = false;

	constructor(
		private readonly observability: DegradedModeObservability,
		private readonly idFactory: OpaqueRuntimeIdFactory,
		private readonly logicalRequestId: OpaqueRuntimeId<"logical_request"> | null,
		private readonly guardAttemptOrdinal: number | undefined,
	) {}

	emitStart(
		input: Pick<DegradedModeRequestStart, "replayRisk" | "sizeBucket"> & {
			estimatedInputTokens?: number;
			bodyBytes?: number;
		},
	): void {
		this.emitNonTerminal(() => ({
			...this.base("request"),
			replayRisk: input.replayRisk,
			sizeBucket: input.sizeBucket,
			...(input.estimatedInputTokens === undefined
				? {}
				: { estimatedInputTokens: input.estimatedInputTokens }),
			...(input.bodyBytes === undefined ? {} : { bodyBytes: input.bodyBytes }),
		}));
	}

	recordPhysicalAttempt(input: DegradedModePhysicalAttemptInput): void {
		this.observability.incrementCounter("physicalAttempts");
		this.physicalAttemptCount =
			this.physicalAttemptCount < SATURATING_COUNTER_MAX
				? this.physicalAttemptCount + 1
				: SATURATING_COUNTER_MAX;
		this.emitNonTerminal(() => {
			const ordinal = positiveOrdinal(input.ordinal);
			const accountId = optionalOpaqueId(
				this.idFactory,
				"account",
				input.accountKey,
			);
			const candidateId = optionalOpaqueId(
				this.idFactory,
				"candidate",
				input.candidateKey,
			);
			const laneId = optionalOpaqueId(this.idFactory, "lane", input.laneKey);
			return {
				...this.base("physical_attempt"),
				physicalAttemptId: this.idFactory.id(
					"physical_attempt",
					this.logicalRequestId ?? "",
					String(this.guardAttemptOrdinal ?? 0),
					String(ordinal),
				),
				physicalAttemptOrdinal: ordinal,
				attemptKind: input.kind,
				...(accountId === undefined ? {} : { accountId }),
				...(candidateId === undefined ? {} : { candidateId }),
				...(laneId === undefined ? {} : { laneId }),
			};
		});
	}

	recordSuppression(input: DegradedModeSuppressionInput): void {
		this.observability.incrementCounter(
			input.decision === "suppressed"
				? "suppressedSends"
				: "wouldSuppressSends",
		);
		this.emitNonTerminal(() => ({
			...this.base("suppression"),
			decision: input.decision,
			reason: input.reason,
			...(input.cohortKey == null || input.cohortKey === ""
				? {}
				: { cohortId: this.idFactory.id("cohort", input.cohortKey) }),
			...(input.ownerKey == null || input.ownerKey === ""
				? {}
				: { ownerId: this.idFactory.id("owner", input.ownerKey) }),
		}));
	}

	recordProbe(decision: "sent" | "would_send"): void {
		this.observability.incrementCounter(
			decision === "sent" ? "probeSends" : "wouldProbeSends",
		);
	}

	recordTransition(input: DegradedModeTransitionInput): void {
		const counter =
			input.subject === "quorum"
				? "quorumTransitions"
				: input.subject === "probe"
					? "probeTransitions"
					: "ownerTransitions";
		this.observability.incrementCounter(counter);
		this.emitNonTerminal(() => ({
			...this.base("transition"),
			subject: input.subject,
			from: input.from,
			to: input.to,
			reason: input.reason,
			...(input.cohortKey == null || input.cohortKey === ""
				? {}
				: { cohortId: this.idFactory.id("cohort", input.cohortKey) }),
			...(input.ownerKey == null || input.ownerKey === ""
				? {}
				: { ownerId: this.idFactory.id("owner", input.ownerKey) }),
		}));
	}

	finish(input: DegradedModeTerminalInput): void {
		if (this.terminal) return;
		this.terminal = true;
		this.observability.incrementCounter("terminalRequests");
		switch (input.outcome) {
			case "success":
				this.observability.incrementCounter("terminalSuccesses");
				break;
			case "overload":
				this.observability.incrementCounter("terminalOverloads");
				break;
			case "suppressed":
				this.observability.incrementCounter("terminalSuppressed");
				break;
			case "cancelled":
				this.observability.incrementCounter("terminalCancelled");
				break;
			case "timeout":
				this.observability.incrementCounter("terminalTimeouts");
				break;
			default:
				this.observability.incrementCounter("terminalFailures");
				break;
		}
		if (!this.observability.detailsEnabled) return;
		try {
			const event: DegradedModeTerminalDiagnosticEvent = {
				...this.base("terminal"),
				outcome: input.outcome,
				physicalAttemptCount: this.physicalAttemptCount,
			};
			this.observability.emitDetailed(event);
		} catch {
			this.observability.dropBudgetedEvent();
		}
	}

	private base<Kind extends DegradedModeDiagnosticEvent["kind"]>(
		kind: Kind,
	): DegradedModeDiagnosticEventBase & { kind: Kind } {
		if (this.logicalRequestId === null) {
			throw new Error("Detailed request identity is unavailable");
		}
		this.sequence++;
		return {
			version: ANTHROPIC_DEGRADED_DIAGNOSTIC_EVENT_VERSION,
			kind,
			bootId: this.idFactory.bootId,
			logicalRequestId: this.logicalRequestId,
			sequence: Math.min(
				ANTHROPIC_DEGRADED_MAX_EVENTS_PER_REQUEST,
				this.sequence,
			),
			...(this.guardAttemptOrdinal === undefined
				? {}
				: { guardAttemptOrdinal: this.guardAttemptOrdinal }),
		};
	}

	private emitNonTerminal(build: () => DegradedModeDiagnosticEvent): void {
		if (!this.observability.detailsEnabled) return;
		if (this.terminal || this.nonTerminalEvents >= NON_TERMINAL_EVENT_BUDGET) {
			this.observability.dropBudgetedEvent();
			return;
		}
		this.nonTerminalEvents++;
		try {
			this.observability.emitDetailed(build());
		} catch {
			this.observability.dropBudgetedEvent();
		}
	}
}
