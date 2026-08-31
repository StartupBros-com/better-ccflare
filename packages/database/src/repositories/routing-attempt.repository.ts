import {
	ROUTING_ATTEMPT_SUMMARY_WINDOWS,
	type RoutingAttemptReason,
	type RoutingAttemptScope,
	type RoutingAttemptSummary,
	type RoutingAttemptSummaryWindow,
} from "@better-ccflare/types";
import { getCleanupBatchSize } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

export {
	ROUTING_ATTEMPT_SUMMARY_WINDOWS,
	type RoutingAttemptSummary,
	type RoutingAttemptSummaryWindow,
};

export interface RoutingAttemptData {
	id: string;
	parentRequestId: string;
	timestamp: number;
	provider: string;
	accountId: string;
	attemptedModel: string | null;
	modelFamily: string | null;
	statusCode: number;
	reason: RoutingAttemptReason;
	scope: RoutingAttemptScope;
	availableAt: number | null;
	failoverAttempts: number;
	physicalAttempt: number | null;
	accountBenched: boolean;
	routeSuppressed: boolean;
	circuitCounted: boolean;
	upstreamEvidence: string | null;
	routeFallbackRung?: string | null;
	routeCandidateId?: string | null;
}

interface SummaryRow {
	row_kind: "headline" | "group";
	first_observed_at: unknown;
	total_attempts: unknown;
	distinct_requests: unknown;
	recovered_requests: unknown;
	terminal_failure_requests: unknown;
	awaiting_terminal_requests: unknown;
	reason: RoutingAttemptReason | null;
	scope: RoutingAttemptScope | null;
	attempt_count: unknown;
}

/** Normalize SQLite numbers and PostgreSQL bigint strings at this boundary. */
function formatObservedAt(timestamp: unknown): string | null {
	if (timestamp == null) return null;
	const value = Number(timestamp);
	if (!Number.isFinite(value)) return null;
	const observedAt = new Date(value);
	return Number.isNaN(observedAt.valueOf()) ? null : observedAt.toISOString();
}

export class RoutingAttemptRepository extends BaseRepository<RoutingAttemptData> {
	async append(data: RoutingAttemptData): Promise<void> {
		await this.run(
			`INSERT INTO routing_attempts (
				id, parent_request_id, timestamp, provider, account_id,
				attempted_model, model_family, status_code, reason, scope,
				available_at, failover_attempts, physical_attempt, account_benched,
				route_suppressed, circuit_counted, upstream_evidence,
				route_fallback_rung, route_candidate_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				data.id,
				data.parentRequestId,
				data.timestamp,
				data.provider,
				data.accountId,
				data.attemptedModel,
				data.modelFamily,
				data.statusCode,
				data.reason,
				data.scope,
				data.availableAt,
				data.failoverAttempts,
				data.physicalAttempt,
				data.accountBenched ? 1 : 0,
				data.routeSuppressed ? 1 : 0,
				data.circuitCounted ? 1 : 0,
				data.upstreamEvidence,
				data.routeFallbackRung ?? null,
				data.routeCandidateId ?? null,
			],
		);
	}

	async getSummary(
		window: RoutingAttemptSummaryWindow,
		now = Date.now(),
	): Promise<RoutingAttemptSummary> {
		const since = now - ROUTING_ATTEMPT_SUMMARY_WINDOWS[window];
		const rows = await this.query<SummaryRow>(
			`WITH retained_history AS (
				SELECT MIN(timestamp) AS first_observed_at
				FROM routing_attempts
			),
			windowed_attempts AS (
				SELECT parent_request_id, reason, scope
				FROM routing_attempts
				WHERE timestamp >= ? AND timestamp <= ?
			),
			attempted_requests AS (
				SELECT DISTINCT parent_request_id
				FROM windowed_attempts
			),
			request_outcomes AS (
				SELECT ar.parent_request_id, r.success
				FROM attempted_requests ar
				LEFT JOIN requests r ON r.id = ar.parent_request_id
			),
			headline AS (
				SELECT
					(SELECT first_observed_at FROM retained_history) AS first_observed_at,
					(SELECT COUNT(*) FROM windowed_attempts) AS total_attempts,
					COUNT(*) AS distinct_requests,
					COALESCE(SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END), 0) AS recovered_requests,
					COALESCE(SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END), 0) AS terminal_failure_requests,
					COALESCE(SUM(CASE WHEN success IS NULL THEN 1 ELSE 0 END), 0) AS awaiting_terminal_requests
				FROM request_outcomes
			),
			grouped AS (
				SELECT
					a.reason,
					a.scope,
					COUNT(*) AS attempt_count,
					COUNT(DISTINCT a.parent_request_id) AS distinct_requests,
					COUNT(DISTINCT CASE WHEN r.success = TRUE THEN a.parent_request_id END) AS recovered_requests,
					COUNT(DISTINCT CASE WHEN r.success = FALSE THEN a.parent_request_id END) AS terminal_failure_requests,
					COUNT(DISTINCT CASE WHEN r.success IS NULL THEN a.parent_request_id END) AS awaiting_terminal_requests
				FROM windowed_attempts a
				LEFT JOIN requests r ON r.id = a.parent_request_id
				GROUP BY a.reason, a.scope
			)
			SELECT
				row_kind,
				first_observed_at,
				total_attempts,
				distinct_requests,
				recovered_requests,
				terminal_failure_requests,
				awaiting_terminal_requests,
				reason,
				scope,
				attempt_count
			FROM (
				SELECT
					0 AS sort_order,
					'headline' AS row_kind,
					first_observed_at,
					total_attempts,
					distinct_requests,
					recovered_requests,
					terminal_failure_requests,
					awaiting_terminal_requests,
					NULL AS reason,
					NULL AS scope,
					NULL AS attempt_count
				FROM headline
				UNION ALL
				SELECT
					1 AS sort_order,
					'group' AS row_kind,
					NULL AS first_observed_at,
					NULL AS total_attempts,
					distinct_requests,
					recovered_requests,
					terminal_failure_requests,
					awaiting_terminal_requests,
					reason,
					scope,
					attempt_count
				FROM grouped
			) summary_rows
			ORDER BY sort_order ASC, attempt_count DESC, reason ASC, scope ASC`,
			[since, now],
		);
		const headline = rows.find((row) => row.row_kind === "headline");

		return {
			firstObservedAt: formatObservedAt(headline?.first_observed_at),
			totalAttempts: Number(headline?.total_attempts) || 0,
			distinctRequests: Number(headline?.distinct_requests) || 0,
			recoveredRequests: Number(headline?.recovered_requests) || 0,
			terminalFailureRequests: Number(headline?.terminal_failure_requests) || 0,
			awaitingTerminalRequests:
				Number(headline?.awaiting_terminal_requests) || 0,
			byReasonScope: rows
				.filter(
					(
						row,
					): row is SummaryRow & {
						reason: RoutingAttemptReason;
						scope: RoutingAttemptScope;
					} =>
						row.row_kind === "group" &&
						row.reason !== null &&
						row.scope !== null,
				)
				.map((row) => ({
					reason: row.reason,
					scope: row.scope,
					attemptCount: Number(row.attempt_count) || 0,
					distinctRequests: Number(row.distinct_requests) || 0,
					recoveredRequests: Number(row.recovered_requests) || 0,
					terminalFailureRequests: Number(row.terminal_failure_requests) || 0,
					awaitingTerminalRequests: Number(row.awaiting_terminal_requests) || 0,
				})),
		};
	}

	async deleteOlderThan(cutoffTs: number): Promise<number> {
		const batchSize = getCleanupBatchSize();
		let total = 0;
		let deleted: number;
		do {
			deleted = await this.runWithChanges(
				`DELETE FROM routing_attempts WHERE id IN (
					SELECT id FROM routing_attempts
					WHERE timestamp < ?
					ORDER BY timestamp ASC, id ASC
					LIMIT ?
				)`,
				[cutoffTs, batchSize],
			);
			total += deleted;
		} while (deleted === batchSize);
		return total;
	}
}
