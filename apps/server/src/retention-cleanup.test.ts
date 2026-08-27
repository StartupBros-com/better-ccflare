import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { Logger } from "@better-ccflare/logger";
import { scheduleAdaptiveVacuumAfterRetentionCleanup } from "./retention-cleanup";

describe("scheduleAdaptiveVacuumAfterRetentionCleanup", () => {
	it("logs and starts adaptive vacuum when routing attempts are the only expired data", () => {
		const incrementalVacuumAdaptive = mock(async () => ({
			reclaimedPages: 0,
			chunks: 0,
		}));
		const info = mock(() => {});
		const error = mock(() => {});

		const scheduled = scheduleAdaptiveVacuumAfterRetentionCleanup(
			{
				removedRequests: 0,
				removedPayloads: 0,
				removedRoutingAttempts: 3,
			},
			{ incrementalVacuumAdaptive } as unknown as DatabaseOperations,
			{ info, error } as unknown as Logger,
			25,
		);

		expect(scheduled).toBe(true);
		expect(info).toHaveBeenCalledWith(
			"Periodic cleanup: removed 0 requests, 0 payloads, 3 routing attempts in 25ms",
		);
		expect(incrementalVacuumAdaptive).toHaveBeenCalledTimes(1);
	});
});
