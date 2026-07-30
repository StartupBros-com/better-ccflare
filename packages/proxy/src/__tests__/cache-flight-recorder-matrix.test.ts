import { describe, expect, it } from "bun:test";
import type { AnthropicDegradedModeConfig } from "@better-ccflare/config";
import {
	type DegradedModeDiagnosticEvent,
	DegradedModeObservability,
} from "../anthropic-degraded-observability";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";
import { createOpaqueRuntimeIdFactory } from "../opaque-runtime-id";

const thresholds: Pick<
	AnthropicDegradedModeConfig,
	"largeRequestTokenThreshold" | "largeRequestByteThreshold"
> = {
	largeRequestTokenThreshold: 100_000,
	largeRequestByteThreshold: 262_144,
};

function observability(events: DegradedModeDiagnosticEvent[] = []) {
	return new DegradedModeObservability({
		mode: "observe",
		...thresholds,
		detailedEventsEnabled: true,
		sink: (event) => {
			events.push(event);
		},
		idFactory: createOpaqueRuntimeIdFactory({
			secret: new Uint8Array(32).fill(3),
			bootNonce: new Uint8Array(32).fill(4),
		}),
	});
}

describe("physical-attempt reconciliation matrix", () => {
	it("uses physical ordinals rather than unique route claims for in-place retries and failover", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const telemetry = observability(events);
		const tracker = telemetry.beginRequest({
			correlationKey: "logical",
			replayRisk: "large",
			sizeBucket: "large",
		});
		const ledger = new RoutingAttemptLedger();
		ledger.attachDegradedTracker(tracker);

		expect(ledger.claim("account-a", "model-a")).toBe(true);
		expect(
			ledger.recordPhysicalAttempt({
				accountId: "account-a",
				candidateId: "candidate-a",
				laneKey: "lane-a",
			}),
		).toBe(1);
		expect(
			ledger.recordPhysicalAttempt({
				accountId: "account-a",
				candidateId: "candidate-a",
				laneKey: "lane-a",
			}),
		).toBe(2);
		expect(ledger.claim("account-b", "model-a")).toBe(true);
		expect(
			ledger.recordPhysicalAttempt({
				accountId: "account-b",
				candidateId: "candidate-b",
				laneKey: "lane-a",
			}),
		).toBe(3);

		expect(ledger.attemptedCount).toBe(2);
		expect(ledger.physicalAttemptCount).toBe(3);
		expect(telemetry.snapshot().physicalAttempts).toBe(3);
		await Promise.resolve();
		await Promise.resolve();
		expect(
			events
				.filter((event) => event.kind === "physical_attempt")
				.map((event) => event.attemptKind),
		).toEqual(["initial", "in_place_retry", "account_failover"]);
	});

	it("classifies authenticated guard replay and recovery probe without changing counts", async () => {
		const events: DegradedModeDiagnosticEvent[] = [];
		const telemetry = observability(events);
		const guardTracker = telemetry.beginRequest({
			correlationKey: "guard-logical",
			guardAttemptOrdinal: 2,
			replayRisk: "large",
			sizeBucket: "large",
		});
		const guardLedger = new RoutingAttemptLedger();
		guardLedger.attachDegradedTracker(guardTracker, 2);
		guardLedger.recordPhysicalAttempt({ accountId: "account-a" });

		const probeTracker = telemetry.beginRequest({
			correlationKey: "probe-logical",
			replayRisk: "large",
			sizeBucket: "large",
		});
		const probeLedger = new RoutingAttemptLedger();
		probeLedger.attachDegradedTracker(probeTracker);
		probeLedger.recordPhysicalAttempt({
			accountId: "account-a",
			recoveryProbe: true,
		});

		expect(telemetry.snapshot()).toMatchObject({
			guardAttempts: 1,
			localAttempts: 1,
			physicalAttempts: 2,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(
			events
				.filter((event) => event.kind === "physical_attempt")
				.map((event) => event.attemptKind),
		).toEqual(["guard_replay", "recovery_probe"]);
	});
});
