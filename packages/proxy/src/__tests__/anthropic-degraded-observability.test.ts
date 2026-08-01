import { describe, expect, it, mock } from "bun:test";
import {
	ANTHROPIC_DEGRADED_DIAGNOSTIC_EVENT_VERSION,
	type DegradedModeDetailedEventSink,
	type DegradedModeDiagnosticEvent,
	DegradedModeObservability,
} from "../anthropic-degraded-observability";
import { createOpaqueRuntimeIdFactory } from "../opaque-runtime-id";

const TEST_SECRET = new Uint8Array(32).fill(7);
const TEST_BOOT_NONCE = new Uint8Array(32).fill(11);

function testIdFactory() {
	return createOpaqueRuntimeIdFactory({
		secret: TEST_SECRET,
		bootNonce: TEST_BOOT_NONCE,
	});
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function createEnabled(
	sink: DegradedModeDetailedEventSink,
): DegradedModeObservability {
	return new DegradedModeObservability({
		mode: "enforce",
		largeRequestTokenThreshold: 100_000,
		largeRequestByteThreshold: 256 * 1024,
		detailedEventsEnabled: true,
		sink,
		idFactory: testIdFactory(),
	});
}

describe("DegradedModeObservability", () => {
	it("keeps synchronous aggregate counters on while detailed events default off", async () => {
		const sink = mock(() => undefined);
		const observability = new DegradedModeObservability({
			mode: "off",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			sink,
			idFactory: testIdFactory(),
		});

		const request = observability.beginRequest({
			correlationKey: "raw-logical-request",
			replayRisk: "large",
			sizeBucket: "large",
			guardAttemptOrdinal: 1,
			estimatedInputTokens: 290_123,
			bodyBytes: 1_234_567,
		});
		request.recordPhysicalAttempt({
			ordinal: 1,
			kind: "initial",
			accountKey: "raw-account",
			candidateKey: "raw-candidate",
			laneKey: "raw-lane",
		});
		request.recordSuppression({
			decision: "suppressed",
			reason: "probe_busy",
		});
		request.finish({ outcome: "overload" });
		await flushMicrotasks();

		expect(sink).not.toHaveBeenCalled();
		expect(observability.snapshot()).toEqual({
			version: 1,
			mode: "off",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			detailedEventsEnabled: false,
			bootId: testIdFactory().bootId,
			logicalRequests: 1,
			guardAttempts: 1,
			localAttempts: 0,
			physicalAttempts: 1,
			suppressedSends: 1,
			wouldSuppressSends: 0,
			probeSends: 0,
			wouldProbeSends: 0,
			overloadEvidence: 0,
			quorumTransitions: 0,
			probeTransitions: 0,
			ownerTransitions: 0,
			terminalRequests: 1,
			terminalSuccesses: 0,
			terminalOverloads: 1,
			terminalSuppressed: 0,
			terminalCancelled: 0,
			terminalTimeouts: 0,
			terminalFailures: 0,
			droppedEvents: 0,
			pendingDetailedEvents: 0,
		});
	});

	it("emits only the versioned privacy allowlist and keeps exact sizes on the request event", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const observability = createEnabled((event) => {
			events.push(event);
		});

		const request = observability.beginRequest({
			correlationKey: "logical\nrequest\0secret",
			replayRisk: "large",
			sizeBucket: "large",
			guardAttemptOrdinal: 3,
			estimatedInputTokens: 290_123,
			bodyBytes: 1_234_567,
		});
		request.recordPhysicalAttempt({
			ordinal: 1,
			kind: "recovery_probe",
			accountKey: "account@example.com",
			candidateKey: "candidate-uuid",
			laneKey: "claude-opus-secret-model",
		});
		request.recordTransition({
			subject: "owner",
			from: "missing",
			to: "retained",
			reason: "owner_observed",
			cohortKey: "raw-cohort",
			ownerKey: "raw-owner",
		});
		request.finish({ outcome: "success" });
		await flushMicrotasks();

		expect(events).toHaveLength(4);
		expect(
			events.every(
				(event) =>
					event.version === ANTHROPIC_DEGRADED_DIAGNOSTIC_EVENT_VERSION,
			),
		).toBe(true);

		const requestEvent = events[0];
		expect(requestEvent?.kind).toBe("request");
		if (requestEvent?.kind !== "request")
			throw new Error("missing request event");
		expect(Object.keys(requestEvent).sort()).toEqual(
			[
				"bodyBytes",
				"bootId",
				"estimatedInputTokens",
				"guardAttemptOrdinal",
				"kind",
				"logicalRequestId",
				"replayRisk",
				"sequence",
				"sizeBucket",
				"version",
			].sort(),
		);
		expect(requestEvent.estimatedInputTokens).toBe(290_123);
		expect(requestEvent.bodyBytes).toBe(1_234_567);

		for (const event of events.slice(1)) {
			expect("estimatedInputTokens" in event).toBe(false);
			expect("bodyBytes" in event).toBe(false);
		}

		const serialized = JSON.stringify(events);
		for (const forbidden of [
			"logical\nrequest",
			"account@example.com",
			"candidate-uuid",
			"claude-opus-secret-model",
			"raw-cohort",
			"raw-owner",
			"headers",
			"requestBody",
			"responseBody",
			"endpoint",
			"model",
			"error",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(serialized).toMatch(
			/or1_(boot|logical_request|physical_attempt|account|candidate|lane|cohort|owner)_[A-Za-z0-9_-]{43}/,
		);
	});

	it("saturates aggregate counters without throwing or wrapping", () => {
		const observability = new DegradedModeObservability({
			mode: "observe",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			idFactory: testIdFactory(),
		});

		observability.incrementCounter("physicalAttempts", Number.MAX_SAFE_INTEGER);
		observability.incrementCounter("physicalAttempts", 100);
		observability.incrementCounter("suppressedSends", Number.POSITIVE_INFINITY);
		observability.incrementCounter("suppressedSends", -1);

		const snapshot = observability.snapshot();
		expect(snapshot.physicalAttempts).toBe(Number.MAX_SAFE_INTEGER);
		expect(snapshot.suppressedSends).toBe(0);
	});

	it("reserves the thirty-second per-request event for one terminal", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const observability = createEnabled((event) => {
			events.push(event);
		});
		const request = observability.beginRequest({
			correlationKey: "request-budget",
			replayRisk: "large",
			sizeBucket: "large",
		});

		for (let index = 0; index < 40; index++) {
			request.recordSuppression({
				decision: "suppressed",
				reason: "probe_busy",
			});
		}
		request.finish({ outcome: "suppressed" });
		await flushMicrotasks();

		expect(events).toHaveLength(32);
		expect(events.filter((event) => event.kind === "terminal")).toHaveLength(1);
		expect(events.at(-1)?.kind).toBe("terminal");
		expect(observability.snapshot().suppressedSends).toBe(40);
		expect(observability.snapshot().droppedEvents).toBe(10);
	});

	it("isolates synchronous throws, rejections, and synchronous backpressure", async () => {
		let call = 0;
		const observability = createEnabled(() => {
			call++;
			if (call === 1) throw new Error("sink failure");
			if (call === 2) return Promise.reject(new Error("sink rejection"));
			return false;
		});
		const request = observability.beginRequest({
			correlationKey: "sink-failures",
			replayRisk: "small",
			sizeBucket: "small",
		});
		request.recordSuppression({
			decision: "would_suppress",
			reason: "cohort_open",
		});
		request.finish({ outcome: "failure" });

		await flushMicrotasks();
		await flushMicrotasks();

		expect(observability.snapshot().droppedEvents).toBe(3);
		expect(observability.snapshot().pendingDetailedEvents).toBe(0);
		expect(observability.snapshot().terminalFailures).toBe(1);
	});

	it("bounds a permanently pending sink at sixty-four global operations", async () => {
		const never = new Promise<undefined>(() => undefined);
		const observability = createEnabled(() => never);

		for (let index = 0; index < 65; index++) {
			observability.beginRequest({
				correlationKey: `pending-${index}`,
				replayRisk: "small",
				sizeBucket: "small",
			});
		}
		await flushMicrotasks();

		const snapshot = observability.snapshot();
		expect(snapshot.logicalRequests).toBe(65);
		expect(snapshot.pendingDetailedEvents).toBe(64);
		expect(snapshot.droppedEvents).toBe(1);
	});

	it("emits and counts at most one terminal outcome per request", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const observability = createEnabled((event) => {
			events.push(event);
		});
		const request = observability.beginRequest({
			correlationKey: "one-terminal",
			replayRisk: "small",
			sizeBucket: "small",
		});

		request.finish({ outcome: "success" });
		request.finish({ outcome: "failure" });
		request.finish({ outcome: "overload" });
		await flushMicrotasks();

		expect(events.filter((event) => event.kind === "terminal")).toHaveLength(1);
		const snapshot = observability.snapshot();
		expect(snapshot.terminalRequests).toBe(1);
		expect(snapshot.terminalSuccesses).toBe(1);
		expect(snapshot.terminalFailures).toBe(0);
		expect(snapshot.terminalOverloads).toBe(0);
		expect(snapshot.droppedEvents).toBe(0);
	});

	it("reconciles guard replays to one logical request and distinct physical attempts", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const observability = createEnabled((event) => {
			events.push(event);
		});

		for (const guardAttemptOrdinal of [1, 2]) {
			const request = observability.beginRequest({
				correlationKey: "same-guard-request-id",
				guardAttemptOrdinal,
				replayRisk: "small",
				sizeBucket: "small",
			});
			request.recordPhysicalAttempt({
				ordinal: 1,
				kind: guardAttemptOrdinal === 1 ? "initial" : "guard_replay",
			});
		}
		await flushMicrotasks();

		const starts = events.filter((event) => event.kind === "request");
		const attempts = events.filter(
			(event) => event.kind === "physical_attempt",
		);
		expect(starts).toHaveLength(2);
		expect(attempts).toHaveLength(2);
		expect(starts[0]?.logicalRequestId).toBe(starts[1]?.logicalRequestId);
		expect(starts.map((event) => event.guardAttemptOrdinal)).toEqual([1, 2]);
		expect(attempts[0]?.physicalAttemptId).not.toBe(
			attempts[1]?.physicalAttemptId,
		);
		expect(attempts.map((event) => event.guardAttemptOrdinal)).toEqual([1, 2]);
		expect(observability.snapshot().logicalRequests).toBe(1);
		expect(observability.snapshot().guardAttempts).toBe(2);
		expect(observability.snapshot().localAttempts).toBe(0);
		expect(observability.snapshot().physicalAttempts).toBe(2);
	});

	it("counts direct attempts, probe decisions, and terminal outcomes in distinct fixed buckets", () => {
		const observability = new DegradedModeObservability({
			mode: "observe",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			idFactory: testIdFactory(),
		});

		const suppressed = observability.beginRequest({
			correlationKey: "direct-suppressed",
			replayRisk: "large",
			sizeBucket: "large",
		});
		suppressed.recordProbe("would_send");
		suppressed.finish({ outcome: "suppressed" });

		const cancelled = observability.beginRequest({
			correlationKey: "direct-cancelled",
			replayRisk: "small",
			sizeBucket: "small",
		});
		cancelled.recordProbe("sent");
		cancelled.finish({ outcome: "cancelled" });

		const timeout = observability.beginRequest({
			correlationKey: "direct-timeout",
			replayRisk: "small",
			sizeBucket: "small",
		});
		timeout.finish({ outcome: "timeout" });

		expect(observability.snapshot()).toMatchObject({
			logicalRequests: 3,
			localAttempts: 3,
			guardAttempts: 0,
			probeSends: 1,
			wouldProbeSends: 1,
			terminalRequests: 3,
			terminalSuppressed: 1,
			terminalCancelled: 1,
			terminalTimeouts: 1,
			terminalFailures: 0,
		});
	});

	it("does no opaque-ID work while details are off and contains ID failures when enabled", async () => {
		const throwingFactory = {
			bootId: testIdFactory().bootId,
			id(): never {
				throw new Error("opaque-id unavailable");
			},
		} as unknown as import("../opaque-runtime-id").OpaqueRuntimeIdFactory;

		const off = new DegradedModeObservability({
			mode: "off",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			idFactory: throwingFactory,
		});
		const offRequest = off.beginRequest({
			correlationKey: "must-not-be-derived",
			replayRisk: "small",
			sizeBucket: "small",
		});
		offRequest.recordPhysicalAttempt({
			ordinal: Number.NaN,
			kind: "initial",
			accountKey: "must-not-be-derived",
		});
		offRequest.finish({ outcome: "success" });
		expect(off.snapshot()).toMatchObject({
			logicalRequests: 1,
			localAttempts: 1,
			physicalAttempts: 1,
			terminalSuccesses: 1,
			droppedEvents: 0,
		});

		const events: DegradedModeDiagnosticEvent[] = [];
		const enabled = new DegradedModeObservability({
			mode: "enforce",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 256 * 1024,
			detailedEventsEnabled: true,
			sink: (event) => {
				events.push(event);
			},
			idFactory: throwingFactory,
		});
		const enabledRequest = enabled.beginRequest({
			correlationKey: "contained",
			replayRisk: "large",
			sizeBucket: "large",
		});
		enabledRequest.recordPhysicalAttempt({
			ordinal: Number.POSITIVE_INFINITY,
			kind: "initial",
			accountKey: "contained-account",
		});
		enabledRequest.finish({ outcome: "timeout" });
		await flushMicrotasks();

		expect(events).toHaveLength(0);
		expect(enabled.snapshot()).toMatchObject({
			logicalRequests: 1,
			localAttempts: 1,
			physicalAttempts: 1,
			terminalTimeouts: 1,
			droppedEvents: 3,
		});
	});

	it("normalizes invalid physical ordinals to a one-based diagnostic ordinal", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const observability = createEnabled((event) => {
			events.push(event);
		});
		const request = observability.beginRequest({
			correlationKey: "invalid-ordinals",
			replayRisk: "small",
			sizeBucket: "small",
		});

		for (const ordinal of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			request.recordPhysicalAttempt({ ordinal, kind: "in_place_retry" });
		}
		request.finish({ outcome: "success" });
		await flushMicrotasks();

		expect(
			events
				.filter((event) => event.kind === "physical_attempt")
				.map((event) => event.physicalAttemptOrdinal),
		).toEqual([1, 1, 1, 1]);
	});
});
