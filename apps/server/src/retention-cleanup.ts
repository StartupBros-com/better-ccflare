import type { DatabaseOperations } from "@better-ccflare/database";
import type { Logger } from "@better-ccflare/logger";

export interface RetentionCleanupResult {
	removedRequests: number;
	removedPayloads: number;
	removedRoutingAttempts: number;
}

/**
 * Logs a retention sweep and starts page reclamation when any retained data was
 * removed. Kept separate from the server lifecycle so attempt-only sweeps are
 * covered without booting a server.
 */
export function scheduleAdaptiveVacuumAfterRetentionCleanup(
	result: RetentionCleanupResult,
	dbOps: Pick<DatabaseOperations, "incrementalVacuumAdaptive">,
	log: Pick<Logger, "info" | "error">,
	durationMs: number,
): boolean {
	const { removedRequests, removedPayloads, removedRoutingAttempts } = result;
	if (
		removedRequests === 0 &&
		removedPayloads === 0 &&
		removedRoutingAttempts === 0
	) {
		return false;
	}

	log.info(
		`Periodic cleanup: removed ${removedRequests} requests, ${removedPayloads} payloads, ${removedRoutingAttempts} routing attempts in ${durationMs}ms`,
	);
	void dbOps
		.incrementalVacuumAdaptive()
		.then((vacuumResult) => {
			if (vacuumResult.reclaimedPages > 0) {
				log.info(
					`Adaptive incremental vacuum reclaimed ${vacuumResult.reclaimedPages} pages in ${vacuumResult.chunks} chunk(s)`,
				);
			}
		})
		.catch((err) => {
			log.error(`Incremental vacuum error: ${err}`);
		});
	return true;
}
