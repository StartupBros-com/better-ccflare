import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_DEGRADED_MODE_DEFAULTS,
	type AnthropicDegradedModeConfig,
} from "@better-ccflare/config";
import {
	AnthropicDegradedModeCoordinator,
	buildAnthropicDegradedCohortKey,
} from "../anthropic-degraded-mode";
import {
	type DegradedModeDiagnosticEvent,
	DegradedModeObservability,
	type DegradedModeRequestTracker,
} from "../anthropic-degraded-observability";
import {
	createAnthropicDegradedDetailedEventSink,
	createAnthropicDegradedRuntimeHealth,
	trackDegradedResponseTerminal,
} from "../anthropic-degraded-runtime";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import { createOpaqueRuntimeIdFactory } from "../opaque-runtime-id";

const config: AnthropicDegradedModeConfig = {
	...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
	mode: "enforce",
};

function idFactory() {
	return createOpaqueRuntimeIdFactory({
		secret: new Uint8Array(32).fill(1),
		bootNonce: new Uint8Array(32).fill(2),
	});
}

describe("Anthropic degraded runtime observability integration", () => {
	it("builds one fixed aggregate health schema with no route identities", () => {
		let now = 0;
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: () => now,
		});
		const key = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (!key) throw new Error("expected cohort");
		for (const accountId of ["private-account-a", "private-account-b"]) {
			coordinator.observeTrustedOverload({
				cohortKey: key,
				accountId,
				outcome: "http_529",
				phase: "pre_commit",
				forceRouted: false,
			});
		}
		now = 31_000;

		const observability = new DegradedModeObservability({
			mode: "enforce",
			largeRequestTokenThreshold: config.largeRequestTokenThreshold,
			largeRequestByteThreshold: config.largeRequestByteThreshold,
			idFactory: idFactory(),
		});
		const tracker = observability.beginRequest({
			correlationKey: "private-logical-request",
			replayRisk: "large",
			sizeBucket: "large",
		});
		tracker.recordProbe("sent");
		tracker.recordSuppression({
			decision: "suppressed",
			reason: "cohort_open",
			cohortKey: key,
		});
		tracker.recordPhysicalAttempt({
			ordinal: 1,
			kind: "recovery_probe",
			accountKey: "private-account-a",
		});
		tracker.finish({ outcome: "overload" });

		const health = createAnthropicDegradedRuntimeHealth({
			coordinator,
			observability,
			ownerOverlay: new DegradedOwnerOverlay(),
			shadowOwnerOverlay: new DegradedOwnerOverlay(),
			now,
		});
		expect(health).toEqual({
			schemaVersion: 1,
			bootId: idFactory().bootId,
			mode: "enforce",
			diagnosticsEnabled: false,
			thresholds: {
				largeRequestTokenThreshold: 100_000,
				largeRequestByteThreshold: 262_144,
				evidenceWindowMs: 30_000,
				quorum: 2,
				retryMinMs: 5_000,
				retryFallbackMs: 10_000,
				retryMaxMs: 60_000,
				recoveryWindowMs: 30_000,
				probeLeaseMs: 600_000,
				maxCohorts: 1_024,
			},
			cohorts: {
				total: 1,
				byState: {
					collecting: 0,
					open: 1,
					probing: 0,
					recovering: 0,
				},
				ageBands: {
					under30Seconds: 0,
					from30SecondsTo5Minutes: 1,
					atLeast5Minutes: 0,
				},
			},
			activeProbes: 0,
			attempts: { logical: 1, guard: 0, local: 1, physical: 1 },
			decisions: {
				suppressedSends: 1,
				wouldSuppressSends: 0,
				probeSends: 1,
				wouldProbeSends: 0,
			},
			terminals: {
				success: 0,
				overload: 1,
				suppressed: 0,
				failure: 0,
				cancelled: 0,
				timeout: 0,
			},
			droppedEvents: 0,
			droppedEvidence: 0,
			saturation: false,
		});
		expect(JSON.stringify(health)).not.toContain("private-");
		expect(JSON.stringify(health)).not.toContain("cohortId");
	});

	it("terminalizes a streamed response once without changing status, headers, or body", async () => {
		const observability = new DegradedModeObservability({
			mode: "observe",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 262_144,
			idFactory: idFactory(),
		});
		const tracker = observability.beginRequest({
			correlationKey: "streamed",
			replayRisk: "large",
			sizeBucket: "large",
		});
		const wrapped = trackDegradedResponseTerminal(
			new Response("overloaded", {
				status: 529,
				headers: { "x-safe": "yes" },
			}),
			tracker,
		);

		expect(wrapped.status).toBe(529);
		expect(wrapped.headers.get("x-safe")).toBe("yes");
		expect(await wrapped.text()).toBe("overloaded");
		tracker.finish({ outcome: "success" });
		expect(observability.snapshot()).toMatchObject({
			terminalRequests: 1,
			terminalOverloads: 1,
			terminalSuccesses: 0,
		});
	});

	it("keeps health saturation aggregate-only across counter and owner-overlay pressure", () => {
		const coordinator = new AnthropicDegradedModeCoordinator({ config });
		const observability = new DegradedModeObservability({
			mode: "enforce",
			largeRequestTokenThreshold: config.largeRequestTokenThreshold,
			largeRequestByteThreshold: config.largeRequestByteThreshold,
			idFactory: idFactory(),
		});
		observability.incrementCounter("ownerTransitions", Number.MAX_SAFE_INTEGER);
		const ownerOverlay = new DegradedOwnerOverlay({ maxEntries: 0 });
		const key = buildAnthropicDegradedCohortKey({
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages",
			model: "claude-opus-4-6",
			betaSignature: "oauth-2025-04-20",
		});
		if (!key) throw new Error("expected cohort");
		expect(
			ownerOverlay.retainQualifyingOwner({
				laneKey: "private-lane",
				cohortKey: key,
				owner: {
					accountId: "private-account",
					candidateId: "private-candidate",
				},
			}),
		).toBe(false);

		const health = createAnthropicDegradedRuntimeHealth({
			coordinator,
			observability,
			ownerOverlay,
		});
		expect(health.saturation).toBe(true);
		expect(health.droppedEvidence).toBe(1);
		expect(JSON.stringify(health)).not.toContain("private-");
	});

	it("keeps terminal telemetry throws from changing the downstream response", async () => {
		const wrapped = trackDegradedResponseTerminal(
			new Response("ok", {
				status: 201,
				headers: { "x-safe": "yes" },
			}),
			{
				finish() {
					throw new Error("telemetry unavailable");
				},
			} as unknown as DegradedModeRequestTracker,
		);

		expect(wrapped.status).toBe(201);
		expect(wrapped.headers.get("x-safe")).toBe("yes");
		expect(await wrapped.text()).toBe("ok");
	});

	it("writes bounded structured events without waiting for drain or retaining listeners", () => {
		const written: string[] = [];
		let listeners = 0;
		const writable = {
			writableNeedDrain: false,
			write(chunk: string) {
				written.push(chunk);
				return true;
			},
			on() {
				listeners++;
			},
		};
		const sink = createAnthropicDegradedDetailedEventSink(writable);
		const event = {
			version: 1,
			kind: "terminal",
			bootId: idFactory().bootId,
			logicalRequestId: idFactory().id("logical_request", "logical"),
			sequence: 1,
			outcome: "success",
			physicalAttemptCount: 1,
		} satisfies DegradedModeDiagnosticEvent;

		expect(sink(event)).toBe(true);
		expect(written).toHaveLength(1);
		expect(JSON.parse(written[0] ?? "{}")).toEqual({
			event: "anthropic_degraded_mode",
			payload: event,
		});
		expect(listeners).toBe(0);

		writable.writableNeedDrain = true;
		expect(sink(event)).toBe(false);
		expect(written).toHaveLength(1);
		expect(listeners).toBe(0);
	});
});
