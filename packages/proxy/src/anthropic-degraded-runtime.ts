import type { AnthropicDegradedRuntimeHealth } from "@better-ccflare/types";
import type {
	AnthropicDegradedModeCoordinator,
	AnthropicDegradedPermitOutcome,
} from "./anthropic-degraded-mode";
import {
	ANTHROPIC_DEGRADED_MAX_PENDING_SINK_OPERATIONS,
	type DegradedModeDetailedEventSink,
	type DegradedModeDiagnosticEvent,
	type DegradedModeObservability,
	type DegradedModeRequestTracker,
	type DegradedModeTerminalOutcome,
} from "./anthropic-degraded-observability";
import type { DegradedOwnerOverlay } from "./degraded-owner-overlay";

interface StructuredWritable {
	readonly writableNeedDrain?: boolean;
	write(chunk: string): boolean;
}

export interface AnthropicDegradedRuntimeHealthInput {
	readonly coordinator: AnthropicDegradedModeCoordinator;
	readonly observability: DegradedModeObservability;
	readonly ownerOverlay?: DegradedOwnerOverlay;
	readonly shadowOwnerOverlay?: DegradedOwnerOverlay;
	readonly now?: number;
}

function saturatingAdd(...values: number[]): number {
	let total = 0;
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value <= 0) continue;
		total = Math.min(Number.MAX_SAFE_INTEGER, total + value);
	}
	return total;
}

export function createAnthropicDegradedRuntimeHealth(
	input: AnthropicDegradedRuntimeHealthInput,
): AnthropicDegradedRuntimeHealth {
	const coordinator = input.coordinator.snapshot(input.now);
	const telemetry = input.observability.snapshot();
	const config = input.coordinator.config;
	const ownerDroppedEvidence = input.ownerOverlay?.droppedEntries ?? 0;
	const shadowOwnerDroppedEvidence =
		input.shadowOwnerOverlay?.droppedEntries ?? 0;
	const droppedEvidence = saturatingAdd(
		coordinator.droppedEvidence,
		ownerDroppedEvidence,
		shadowOwnerDroppedEvidence,
	);
	const aggregateValues = [
		telemetry.logicalRequests,
		telemetry.guardAttempts,
		telemetry.localAttempts,
		telemetry.physicalAttempts,
		telemetry.suppressedSends,
		telemetry.wouldSuppressSends,
		telemetry.probeSends,
		telemetry.wouldProbeSends,
		telemetry.overloadEvidence,
		telemetry.quorumTransitions,
		telemetry.probeTransitions,
		telemetry.ownerTransitions,
		telemetry.terminalRequests,
		telemetry.terminalSuccesses,
		telemetry.terminalOverloads,
		telemetry.terminalSuppressed,
		telemetry.terminalFailures,
		telemetry.terminalCancelled,
		telemetry.terminalTimeouts,
		telemetry.droppedEvents,
		coordinator.droppedEvidence,
	];

	return {
		schemaVersion: 1,
		bootId: telemetry.bootId,
		mode: coordinator.mode,
		diagnosticsEnabled: telemetry.detailedEventsEnabled,
		thresholds: {
			largeRequestTokenThreshold: config.largeRequestTokenThreshold,
			largeRequestByteThreshold: config.largeRequestByteThreshold,
			evidenceWindowMs: config.evidenceWindowMs,
			quorum: config.quorum,
			retryMinMs: config.retryMinMs,
			retryFallbackMs: config.retryFallbackMs,
			retryMaxMs: config.retryMaxMs,
			recoveryWindowMs: config.recoveryWindowMs,
			probeLeaseMs: config.probeLeaseMs,
			maxCohorts: config.maxCohorts,
		},
		cohorts: {
			total: coordinator.retainedCohorts,
			byState: {
				collecting: coordinator.collectingCohorts,
				open: coordinator.openCohorts,
				probing: coordinator.probingCohorts,
				recovering: coordinator.recoveringCohorts,
			},
			ageBands: { ...coordinator.cohortAgeBands },
		},
		activeProbes: coordinator.activeProbes,
		attempts: {
			logical: telemetry.logicalRequests,
			guard: telemetry.guardAttempts,
			local: telemetry.localAttempts,
			physical: telemetry.physicalAttempts,
		},
		decisions: {
			suppressedSends: telemetry.suppressedSends,
			wouldSuppressSends: telemetry.wouldSuppressSends,
			probeSends: telemetry.probeSends,
			wouldProbeSends: telemetry.wouldProbeSends,
		},
		terminals: {
			success: telemetry.terminalSuccesses,
			overload: telemetry.terminalOverloads,
			suppressed: telemetry.terminalSuppressed,
			failure: telemetry.terminalFailures,
			cancelled: telemetry.terminalCancelled,
			timeout: telemetry.terminalTimeouts,
		},
		droppedEvents: telemetry.droppedEvents,
		droppedEvidence,
		saturation:
			coordinator.retainedCohorts >= config.maxCohorts ||
			ownerDroppedEvidence > 0 ||
			shadowOwnerDroppedEvidence > 0 ||
			telemetry.pendingDetailedEvents >=
				ANTHROPIC_DEGRADED_MAX_PENDING_SINK_OPERATIONS ||
			aggregateValues.some((value) => value >= Number.MAX_SAFE_INTEGER),
	};
}

/**
 * The sink is intentionally a write-only adapter over stdout/journald. It
 * never waits for drain and never registers a listener, so telemetry pressure
 * cannot retain request state or delay routing.
 */
export function createAnthropicDegradedDetailedEventSink(
	writable: StructuredWritable,
): DegradedModeDetailedEventSink {
	return (event: Readonly<DegradedModeDiagnosticEvent>): boolean => {
		if (writable.writableNeedDrain === true) return false;
		return writable.write(
			`${JSON.stringify({
				event: "anthropic_degraded_mode",
				payload: event,
			})}\n`,
		);
	};
}

function responseOutcome(response: Response): DegradedModeTerminalOutcome {
	if (response.status === 529) return "overload";
	if (response.status === 408 || response.status === 504) return "timeout";
	return response.ok ? "success" : "failure";
}

/**
 * Finish request telemetry from the response lifecycle's authoritative,
 * permit-accepted outcome. The outer HTTP/body wrapper remains an idempotent
 * fallback for routes that never acquire a protected lifecycle.
 */
export function finishDegradedRequestFromPermitOutcome(
	tracker: DegradedModeRequestTracker,
	outcome: AnthropicDegradedPermitOutcome,
): void {
	let terminal: DegradedModeTerminalOutcome;
	switch (outcome) {
		case "success":
			terminal = "success";
			break;
		case "overloaded":
			terminal = "overload";
			break;
		case "cancelled":
			terminal = "cancelled";
			break;
		case "timeout":
			terminal = "timeout";
			break;
		case "truncated":
		case "failed":
		case "abandoned":
			terminal = "failure";
			break;
	}
	try {
		tracker.finish({ outcome: terminal });
	} catch {
		// Lifecycle settlement already won; telemetry cannot revise it.
	}
}

/**
 * Attach one best-effort terminal observation to the downstream body without
 * making telemetry authoritative over status, headers, content, or errors.
 */
export function trackDegradedResponseTerminal(
	response: Response,
	tracker: DegradedModeRequestTracker,
): Response {
	const finish = (outcome: DegradedModeTerminalOutcome): void => {
		try {
			tracker.finish({ outcome });
		} catch {
			// Aggregate/event failures are never response authority.
		}
	};
	const outcome = responseOutcome(response);
	if (response.body === null) {
		finish(outcome);
		return response;
	}

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = response.body.getReader();
	} catch {
		finish("failure");
		return response;
	}
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					finish(outcome);
					controller.close();
					return;
				}
				controller.enqueue(next.value);
			} catch (error) {
				finish("failure");
				controller.error(error);
			}
		},
		async cancel(reason) {
			finish("cancelled");
			try {
				await reader.cancel(reason);
			} catch {
				// Downstream cancellation already won; telemetry is complete.
			}
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
