import type {
	CacheFlightCohortSealReceipt,
	CacheFlightKeepalivePolicySnapshot,
	CacheFlightPersistedSeal,
	CacheFlightSealCompleteness,
	CacheFlightSealDimension,
	CacheFlightServiceEpoch,
	Completeness,
	Timeline,
	TurnEvidence,
} from "@better-ccflare/core";
import {
	BatchExpectedChangesError,
	type BatchStatement,
} from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

interface StoredTurn {
	sequence: number;
	timestamp: string;
	identity_fingerprint: string | null;
	serving_account_id: string | null;
	prefix_fingerprint: string | null;
	cache_outcome: TurnEvidence["cacheOutcome"];
	input_tokens: number | null;
	cached_tokens: number | null;
	completeness: Completeness;
	unavailable_dimensions: string;
	gap_before: number | boolean;
	observation_partition_id: string | null;
	partition_id: string | null;
	partition_service_epoch_id: string | null;
	serving_account_scope: string | null;
	route_model_epoch: string | null;
	partition_completeness: CacheFlightSealCompleteness | string | null;
	partition_unavailable_dimensions: string | null;
	seal_completeness: CacheFlightSealCompleteness | string | null;
	seal_unavailable_dimensions: string | null;
	epoch_id: string | null;
	seal_contract_version: number | null;
	deployment_revision: string | null;
	service_instance_id: string | null;
	process_started_at: string | null;
	native_cache_state: string | null;
	recorder_state: string | null;
	keepalive_global_ttl_minutes: number | null;
	keepalive_xai_ttl_minutes: number | null;
	keepalive_effective_xai_enabled: number | boolean | null;
	keepalive_effective_xai_ttl_minutes: number | null;
	occurrence_id: string | null;
	epoch_completeness: CacheFlightSealCompleteness | string | null;
	epoch_unavailable_dimensions: string | null;
}

type StoredSealHealthStatus = "sealed" | "unsealed" | "incompleteSeal";

interface StoredSealProjection {
	readonly seal: CacheFlightPersistedSeal | null;
	readonly status: StoredSealHealthStatus;
}

export interface MarkIncompleteOptions {
	dropped?: boolean;
	/** Coalesced count of drops for one call. Defaults to 1 when `dropped`
	 * is true and no explicit count is given, 0 otherwise. */
	droppedCount?: number;
	at?: number;
}

export interface CacheFlightRecorderCounts {
	dropped: number;
	incomplete: number;
	sealed: number;
	unsealed: number;
	incompleteSeal: number;
}

export interface CacheFlightRecorderStoredTurn extends TurnEvidence {
	seal: CacheFlightPersistedSeal | null;
}

export interface CacheFlightRecorderTimeline extends Timeline {
	createdAt: number;
	updatedAt: number;
	incomplete: boolean;
	droppedEvents: number;
	turns: readonly CacheFlightRecorderStoredTurn[];
}

export type CacheFlightRecorderLookup =
	| { status: "found"; timeline: CacheFlightRecorderTimeline }
	| { status: "expired" | "not_found" };

const TURN_EVIDENCE_KEYS = new Set<keyof TurnEvidence>([
	"sequence",
	"timestamp",
	"identityFingerprint",
	"servingAccountId",
	"prefixFingerprint",
	"cacheOutcome",
	"inputTokens",
	"cachedTokens",
	"completeness",
	"unavailableDimensions",
	"gapBefore",
]);
const EVIDENCE_DIMENSIONS = new Set([
	"identity",
	"serving_account",
	"cacheable_prefix",
	"cache_outcome",
	"token_accounting",
	"timeline",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_FINGERPRINT = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET_SHAPED =
	/(^sk-)|secret|credential|password|api[_-]?key|access[_-]?token|refresh[_-]?token/i;
const SEAL_CONTRACT_VERSION = 1;
const MAX_TTL_MINUTES = 365 * 24 * 60;
const UNKNOWN_SEAL_IDENTIFIER = "unknown";
const SERVICE_EPOCH_KEYS = new Set<
	keyof CacheFlightCohortSealReceipt["serviceEpoch"]
>([
	"id",
	"occurrenceId",
	"sealContractVersion",
	"deploymentRevision",
	"serviceInstanceId",
	"processStartedAt",
	"nativeCacheState",
	"recorderState",
	"keepalivePolicy",
	"completeness",
	"unavailableDimensions",
]);
const PARTITION_KEYS = new Set<
	keyof CacheFlightCohortSealReceipt["observationPartition"]
>([
	"id",
	"serviceEpochId",
	"servingAccountScope",
	"routeModelEpoch",
	"completeness",
	"unavailableDimensions",
]);
const RECEIPT_KEYS = new Set<keyof CacheFlightCohortSealReceipt>([
	"serviceEpoch",
	"observationPartition",
	"completeness",
	"unavailableDimensions",
]);
const KEEPALIVE_POLICY_KEYS = new Set<keyof CacheFlightKeepalivePolicySnapshot>(
	[
		"globalTtlMinutes",
		"xaiTtlMinutes",
		"effectiveXaiEnabled",
		"effectiveXaiTtlMinutes",
	],
);
const SERVICE_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	"seal_contract_version",
	"deployment_revision",
	"service_instance",
	"process_started_at",
	"native_cache_state",
	"recorder_state",
	"keepalive_policy",
	"service_epoch_occurrence",
];
const PARTITION_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	"serving_account_scope",
	"route_model_epoch",
];
const SEAL_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	...SERVICE_DIMENSION_ORDER,
	...PARTITION_DIMENSION_ORDER,
	"seal_receipt",
];
const SERVICE_DIMENSIONS = new Set(SERVICE_DIMENSION_ORDER);
const PARTITION_DIMENSIONS = new Set(PARTITION_DIMENSION_ORDER);
const ALL_SEAL_DIMENSIONS = new Set(SEAL_DIMENSION_ORDER);
const STORED_TURN_COLUMNS = `t.sequence, t.timestamp, t.identity_fingerprint, t.serving_account_id,
	t.prefix_fingerprint, t.cache_outcome, t.input_tokens, t.cached_tokens,
	t.completeness, t.unavailable_dimensions, t.gap_before,
	t.observation_partition_id,
	p.id AS partition_id,
	p.service_epoch_id AS partition_service_epoch_id,
	p.serving_account_scope,
	p.route_model_epoch,
	p.completeness AS partition_completeness,
	p.unavailable_dimensions AS partition_unavailable_dimensions,
	p.seal_completeness,
	p.seal_unavailable_dimensions,
	e.id AS epoch_id,
	e.seal_contract_version,
	e.deployment_revision,
	e.service_instance_id,
	e.process_started_at,
	e.native_cache_state,
	e.recorder_state,
	e.keepalive_global_ttl_minutes,
	e.keepalive_xai_ttl_minutes,
	e.keepalive_effective_xai_enabled,
	e.keepalive_effective_xai_ttl_minutes,
	e.occurrence_id,
	e.completeness AS epoch_completeness,
	e.unavailable_dimensions AS epoch_unavailable_dimensions`;
const STORED_TURN_FROM = `FROM cache_flight_recorder_turns t
	LEFT JOIN cache_flight_recorder_partitions p
		ON p.id = t.observation_partition_id
	LEFT JOIN cache_flight_recorder_service_epochs e
		ON e.id = p.service_epoch_id`;

/** Durable privacy-safe evidence store for cache flight recorder timelines. */
export class CacheFlightRecorderRepository extends BaseRepository<Timeline> {
	async appendTurn(
		recorderConversationId: string,
		turn: TurnEvidence,
		recordedAt = Date.now(),
		sealReceipt?: CacheFlightCohortSealReceipt | null,
	): Promise<void> {
		this.assertPrivacySafeRecorderId(recorderConversationId);
		this.assertPrivacySafeTurn(turn);
		if (sealReceipt !== undefined && sealReceipt !== null) {
			this.assertPrivacySafeSealReceipt(sealReceipt);
		}
		const batch: BatchStatement[] = [
			{
				sql: "DELETE FROM cache_flight_recorder_tombstones WHERE recorder_conversation_id = ?",
				params: [recorderConversationId],
			},
			{
				sql: `INSERT INTO cache_flight_recorder_conversations (
					recorder_conversation_id, created_at, updated_at, incomplete, dropped_events
				) VALUES (?, ?, ?, ?, 0)
				ON CONFLICT (recorder_conversation_id) DO UPDATE SET
					updated_at = CASE
						WHEN EXCLUDED.updated_at > cache_flight_recorder_conversations.updated_at
						THEN EXCLUDED.updated_at
						ELSE cache_flight_recorder_conversations.updated_at
					END,
					incomplete = CASE
						WHEN EXCLUDED.incomplete = 1 THEN 1
						ELSE cache_flight_recorder_conversations.incomplete
					END`,
				params: [
					recorderConversationId,
					recordedAt,
					recordedAt,
					turn.completeness === "complete" ? 0 : 1,
				],
			},
		];
		let serviceEpochVerificationIndex = -1;
		let partitionVerificationIndex = -1;
		if (sealReceipt) {
			const registry = this.registryStatements(sealReceipt, recordedAt);
			serviceEpochVerificationIndex = batch.length + 1;
			partitionVerificationIndex = batch.length + 3;
			batch.push(...registry);
		}
		// Keep tombstone removal, conversation upsert, and sequence allocation atomic so
		// a partial failure cannot leave an expired tombstone without its live timeline.
		batch.push({
			sql: `INSERT INTO cache_flight_recorder_turns (
					recorder_conversation_id, sequence, timestamp,
					identity_fingerprint, serving_account_id, prefix_fingerprint,
					cache_outcome, input_tokens, cached_tokens, completeness,
					unavailable_dimensions, gap_before, observation_partition_id
				) SELECT ?, COALESCE(MAX(sequence), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				FROM cache_flight_recorder_turns
				WHERE recorder_conversation_id = ?`,
			params: [
				recorderConversationId,
				turn.timestamp,
				turn.identityFingerprint ?? null,
				turn.servingAccountId ?? null,
				turn.prefixFingerprint ?? null,
				turn.cacheOutcome,
				turn.inputTokens ?? null,
				turn.cachedTokens ?? null,
				turn.completeness,
				JSON.stringify(turn.unavailableDimensions),
				turn.gapBefore ? 1 : 0,
				sealReceipt?.observationPartition.id ?? null,
				recorderConversationId,
			],
			expectedChanges: 1,
		});
		try {
			await this.adapter.runBatchWithChanges(batch);
		} catch (error) {
			if (
				error instanceof BatchExpectedChangesError &&
				error.statementIndex === serviceEpochVerificationIndex
			) {
				throw new Error(
					"immutable cache flight service epoch evidence conflict",
				);
			}
			if (
				error instanceof BatchExpectedChangesError &&
				error.statementIndex === partitionVerificationIndex
			) {
				throw new Error("immutable cache flight partition evidence conflict");
			}
			throw error;
		}
	}

	async loadTimeline(
		recorderConversationId: string,
	): Promise<CacheFlightRecorderTimeline | null> {
		const conversation = await this.get<{
			recorder_conversation_id: string;
			created_at: number;
			updated_at: number;
			incomplete: number | boolean;
			dropped_events: number;
		}>(
			`SELECT recorder_conversation_id, created_at, updated_at, incomplete, dropped_events
			 FROM cache_flight_recorder_conversations
			 WHERE recorder_conversation_id = ?`,
			[recorderConversationId],
		);
		if (!conversation) return null;

		const rows = await this.query<StoredTurn>(
			`SELECT ${STORED_TURN_COLUMNS}
			 ${STORED_TURN_FROM}
			 WHERE t.recorder_conversation_id = ?
			 ORDER BY t.sequence ASC`,
			[recorderConversationId],
		);
		return {
			recorderConversationId,
			createdAt: Number(conversation.created_at),
			updatedAt: Number(conversation.updated_at),
			incomplete: Boolean(conversation.incomplete),
			droppedEvents: Number(conversation.dropped_events),
			turns: rows.map((row) => this.toTurnEvidence(row)),
		};
	}

	async lookupTimeline(
		recorderConversationId: string,
	): Promise<CacheFlightRecorderLookup> {
		this.assertPrivacySafeRecorderId(recorderConversationId);
		const timeline = await this.loadTimeline(recorderConversationId);
		if (timeline) return { status: "found", timeline };
		const tombstone = await this.get<{ found: number }>(
			`SELECT 1 AS found FROM cache_flight_recorder_tombstones
			 WHERE recorder_conversation_id = ?`,
			[recorderConversationId],
		);
		if (!tombstone) return { status: "not_found" };
		const recreated = await this.loadTimeline(recorderConversationId);
		return recreated
			? { status: "found", timeline: recreated }
			: { status: "expired" };
	}

	async markIncomplete(
		recorderConversationId: string,
		options: MarkIncompleteOptions = {},
	): Promise<void> {
		const at = options.at ?? Date.now();
		const droppedCount = options.droppedCount ?? (options.dropped ? 1 : 0);
		await this.run(
			`INSERT INTO cache_flight_recorder_conversations (
				recorder_conversation_id, created_at, updated_at, incomplete, dropped_events
			) VALUES (?, ?, ?, 1, ?)
			ON CONFLICT (recorder_conversation_id) DO UPDATE SET
				updated_at = CASE
					WHEN EXCLUDED.updated_at > cache_flight_recorder_conversations.updated_at
					THEN EXCLUDED.updated_at
					ELSE cache_flight_recorder_conversations.updated_at
				END,
				incomplete = 1,
				dropped_events = cache_flight_recorder_conversations.dropped_events + EXCLUDED.dropped_events`,
			[recorderConversationId, at, at, droppedCount],
		);
	}

	async countRetained(): Promise<number> {
		const row = await this.get<{ count: number }>(
			"SELECT COUNT(*) AS count FROM cache_flight_recorder_conversations",
		);
		return Number(row?.count ?? 0);
	}

	async countDroppedIncomplete(): Promise<CacheFlightRecorderCounts> {
		const row = await this.get<{
			dropped: number | null;
			incomplete: number | null;
		}>(
			`SELECT COALESCE(SUM(dropped_events), 0) AS dropped,
				COALESCE(SUM(CASE WHEN incomplete = 1 THEN 1 ELSE 0 END), 0) AS incomplete
			 FROM cache_flight_recorder_conversations`,
		);
		const storedTurns = await this.query<StoredTurn>(
			`SELECT ${STORED_TURN_COLUMNS}
			 ${STORED_TURN_FROM}`,
		);
		const sealCounts = {
			sealed: 0,
			unsealed: 0,
			incompleteSeal: 0,
		};
		for (const storedTurn of storedTurns) {
			sealCounts[this.projectStoredSeal(storedTurn).status] += 1;
		}
		return {
			dropped: Number(row?.dropped ?? 0),
			incomplete: Number(row?.incomplete ?? 0),
			sealed: sealCounts.sealed,
			unsealed: sealCounts.unsealed,
			incompleteSeal: sealCounts.incompleteSeal,
		};
	}

	async expireOlderThan(
		cutoffTs: number,
		tombstoneExpiresAt: number,
	): Promise<number> {
		// Turn timestamps are `new Date(...).toISOString()`: UTC Zulu
		// ISO-8601, which sorts lexicographically the same as chronologically,
		// so a plain string comparison works identically on SQLite and
		// PostgreSQL without any date parsing in SQL.
		const isoCutoff = new Date(cutoffTs).toISOString();
		const [expired] = await this.adapter.runBatchWithChanges([
			{
				// Tombstone every conversation whose retention window has
				// lapsed: either the conversation row itself has gone stale
				// (updated_at < cutoff), or it was touched recently but every
				// turn on its timeline predates the cutoff, so no
				// retained-window evidence survives (conversations with zero
				// turns fall back to the updated_at rule only, since
				// MAX(timestamp) is NULL and `NULL < ?` is never true). One
				// OR-predicate keeps this INSERT the sole source of the
				// returned count, so the cascaded/explicit turn deletes below
				// can never inflate it.
				sql: `INSERT INTO cache_flight_recorder_tombstones (
					recorder_conversation_id, expires_at
				) SELECT c.recorder_conversation_id, ?
				FROM cache_flight_recorder_conversations c
				WHERE c.updated_at < ?
				   OR (
						SELECT MAX(t.timestamp) FROM cache_flight_recorder_turns t
						WHERE t.recorder_conversation_id = c.recorder_conversation_id
					) < ?
				ON CONFLICT (recorder_conversation_id) DO UPDATE SET
					expires_at = EXCLUDED.expires_at`,
				params: [tombstoneExpiresAt, cutoffTs, isoCutoff],
			},
			{
				sql: `DELETE FROM cache_flight_recorder_conversations
				 WHERE updated_at < ?`,
				params: [cutoffTs],
			},
			{
				// Conversations touched recently but whose entire timeline
				// predates the cutoff carry no retained-window evidence:
				// expire them outright instead of leaving an empty timeline
				// behind. Must run before the turn truncation below, since
				// truncating first would empty the timeline and make this
				// predicate unable to tell "only stale turns" apart from
				// "no turns at all".
				sql: `DELETE FROM cache_flight_recorder_conversations
				 WHERE (
						SELECT MAX(t.timestamp) FROM cache_flight_recorder_turns t
						WHERE t.recorder_conversation_id = cache_flight_recorder_conversations.recorder_conversation_id
					) < ?`,
				params: [isoCutoff],
			},
			{
				// For conversations that survive (still have at least one
				// turn at or after the cutoff), mark the truncation as an
				// explicit gap on the earliest turn that will remain after
				// pruning, so the diagnosis layer sees a declared gap rather
				// than silently missing evidence. Must run before the turn
				// delete below so "lost a turn" can still be observed.
				sql: `UPDATE cache_flight_recorder_turns
				 SET gap_before = 1
				 WHERE timestamp >= ?
					AND sequence = (
						SELECT MIN(t2.sequence) FROM cache_flight_recorder_turns t2
						WHERE t2.recorder_conversation_id = cache_flight_recorder_turns.recorder_conversation_id
						  AND t2.timestamp >= ?
					)
					AND EXISTS (
						SELECT 1 FROM cache_flight_recorder_turns t3
						WHERE t3.recorder_conversation_id = cache_flight_recorder_turns.recorder_conversation_id
						  AND t3.timestamp < ?
					)`,
				params: [isoCutoff, isoCutoff, isoCutoff],
			},
			{
				// Retention applies at turn granularity too: prune stale
				// turns from conversations that remain active, so a
				// conversation touched at least once per retention window
				// cannot accumulate turns without bound. appendTurn allocates
				// sequences via MAX(sequence)+1 scoped to the surviving rows,
				// so pruning the oldest turns never causes sequence reuse.
				sql: `DELETE FROM cache_flight_recorder_turns WHERE timestamp < ?`,
				params: [isoCutoff],
			},
			{
				// A partition can look like a zero-turn orphan while a
				// concurrent live append is still attaching a fresh turn to
				// it: on PostgreSQL the insert-or-verify batch and this
				// cleanup run as separate transactions (bun-sql-adapter.ts
				// runBatchWithChanges), so this DELETE's snapshot can miss
				// the appending transaction's uncommitted turn row under
				// READ COMMITTED.
				//
				// Gating on created_at alone is not enough: the registry
				// verify UPDATE is a no-op guard (`id = id` historically, now
				// a last_verified_at refresh — see registryStatements()), so
				// created_at is written once at first creation and never
				// changes again. partitionFor() memoizes partition ids per
				// process, so a low-traffic account/route combination that
				// goes quiet longer than the retention window and then
				// resumes traffic reuses the same long-lived partition id —
				// permanently older than any cutoff, so a created_at-only
				// guard never protects it once past its first retention
				// window, including inside the very race window this guard
				// exists to close.
				//
				// last_verified_at lives on the SAME row this DELETE
				// targets, so PostgreSQL's EvalPlanQual recheck (after a
				// concurrent append's FK KEY SHARE lock unblocks this
				// DELETE) observes the freshly committed refresh — closing
				// the gap a created_at-only guard cannot, since a live
				// append always writes recordedAt strictly after this pass's
				// own cutoffTs. created_at <= last_verified_at always holds
				// by construction (both set to the same value at first
				// insert; only last_verified_at is refreshed thereafter), so
				// gating on last_verified_at alone strictly dominates and
				// subsumes the created_at check.
				sql: `DELETE FROM cache_flight_recorder_partitions
				 WHERE last_verified_at < ?
					AND NOT EXISTS (
					SELECT 1 FROM cache_flight_recorder_turns t
					WHERE t.observation_partition_id = cache_flight_recorder_partitions.id
				 )`,
				params: [cutoffTs],
			},
			{
				// Same race and guard as the partition cleanup above, one
				// level up the registry.
				sql: `DELETE FROM cache_flight_recorder_service_epochs
				 WHERE last_verified_at < ?
					AND NOT EXISTS (
					SELECT 1 FROM cache_flight_recorder_partitions p
					WHERE p.service_epoch_id = cache_flight_recorder_service_epochs.id
				 )`,
				params: [cutoffTs],
			},
		]);
		return expired ?? 0;
	}

	async expireTombstonesOlderThan(now: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM cache_flight_recorder_tombstones WHERE expires_at < ?`,
			[now],
		);
	}

	private registryStatements(
		receipt: CacheFlightCohortSealReceipt,
		recordedAt: number,
	): BatchStatement[] {
		const epoch = receipt.serviceEpoch;
		const partition = receipt.observationPartition;
		const keepalive = epoch.keepalivePolicy;
		const effectiveEnabled =
			keepalive === null ? null : keepalive.effectiveXaiEnabled ? 1 : 0;
		const epochUnavailable = JSON.stringify(epoch.unavailableDimensions);
		const partitionUnavailable = JSON.stringify(
			partition.unavailableDimensions,
		);
		const sealUnavailable = JSON.stringify(receipt.unavailableDimensions);
		const nullableEquals = (column: string) =>
			`((${column} IS NULL AND ? IS NULL) OR ${column} = ?)`;

		return [
			{
				sql: `INSERT INTO cache_flight_recorder_service_epochs (
					id, seal_contract_version, deployment_revision, service_instance_id,
					process_started_at, native_cache_state, recorder_state,
					keepalive_global_ttl_minutes, keepalive_xai_ttl_minutes,
					keepalive_effective_xai_enabled, keepalive_effective_xai_ttl_minutes,
					occurrence_id, completeness, unavailable_dimensions, created_at,
					last_verified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO NOTHING`,
				params: [
					epoch.id,
					epoch.sealContractVersion,
					epoch.deploymentRevision,
					epoch.serviceInstanceId,
					epoch.processStartedAt,
					epoch.nativeCacheState,
					epoch.recorderState,
					keepalive?.globalTtlMinutes ?? null,
					keepalive?.xaiTtlMinutes ?? null,
					effectiveEnabled,
					keepalive?.effectiveXaiTtlMinutes ?? null,
					epoch.occurrenceId,
					epoch.completeness,
					epochUnavailable,
					recordedAt,
					recordedAt,
				],
			},
			{
				// The equality guard below only compares immutable evidence
				// columns (never last_verified_at itself, which changes on
				// every append and would break re-verification of an
				// unchanged row). The SET clause refreshes last_verified_at
				// to recordedAt on every successful re-verify — including
				// when this INSERT/verify pair fires for a row that already
				// existed — so a long-lived registry row's liveness reflects
				// the most recent append that touched it, not just its
				// original creation time. See expireOlderThan() below for
				// why that distinction closes a retention-sweep race.
				sql: `UPDATE cache_flight_recorder_service_epochs
				 SET last_verified_at = ?
				 WHERE id = ?
					AND seal_contract_version = ?
					AND ${nullableEquals("deployment_revision")}
					AND ${nullableEquals("service_instance_id")}
					AND ${nullableEquals("process_started_at")}
					AND ${nullableEquals("native_cache_state")}
					AND ${nullableEquals("recorder_state")}
					AND ${nullableEquals("keepalive_global_ttl_minutes")}
					AND ${nullableEquals("keepalive_xai_ttl_minutes")}
					AND ${nullableEquals("keepalive_effective_xai_enabled")}
					AND ${nullableEquals("keepalive_effective_xai_ttl_minutes")}
					AND ${nullableEquals("occurrence_id")}
					AND completeness = ?
					AND unavailable_dimensions = ?`,
				params: [
					recordedAt,
					epoch.id,
					epoch.sealContractVersion,
					epoch.deploymentRevision,
					epoch.deploymentRevision,
					epoch.serviceInstanceId,
					epoch.serviceInstanceId,
					epoch.processStartedAt,
					epoch.processStartedAt,
					epoch.nativeCacheState,
					epoch.nativeCacheState,
					epoch.recorderState,
					epoch.recorderState,
					keepalive?.globalTtlMinutes ?? null,
					keepalive?.globalTtlMinutes ?? null,
					keepalive?.xaiTtlMinutes ?? null,
					keepalive?.xaiTtlMinutes ?? null,
					effectiveEnabled,
					effectiveEnabled,
					keepalive?.effectiveXaiTtlMinutes ?? null,
					keepalive?.effectiveXaiTtlMinutes ?? null,
					epoch.occurrenceId,
					epoch.occurrenceId,
					epoch.completeness,
					epochUnavailable,
				],
				expectedChanges: 1,
			},
			{
				sql: `INSERT INTO cache_flight_recorder_partitions (
					id, service_epoch_id, serving_account_scope, route_model_epoch,
					completeness, unavailable_dimensions, seal_completeness,
					seal_unavailable_dimensions, created_at, last_verified_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO NOTHING`,
				params: [
					partition.id,
					partition.serviceEpochId,
					partition.servingAccountScope,
					partition.routeModelEpoch,
					partition.completeness,
					partitionUnavailable,
					receipt.completeness,
					sealUnavailable,
					recordedAt,
					recordedAt,
				],
			},
			{
				// Same last_verified_at refresh as the service-epoch verify
				// above, and same rule: never add last_verified_at to the
				// equality guard.
				sql: `UPDATE cache_flight_recorder_partitions
				 SET last_verified_at = ?
				 WHERE id = ?
					AND service_epoch_id = ?
					AND ${nullableEquals("serving_account_scope")}
					AND ${nullableEquals("route_model_epoch")}
					AND completeness = ?
					AND unavailable_dimensions = ?
					AND seal_completeness = ?
					AND seal_unavailable_dimensions = ?`,
				params: [
					recordedAt,
					partition.id,
					partition.serviceEpochId,
					partition.servingAccountScope,
					partition.servingAccountScope,
					partition.routeModelEpoch,
					partition.routeModelEpoch,
					partition.completeness,
					partitionUnavailable,
					receipt.completeness,
					sealUnavailable,
				],
				expectedChanges: 1,
			},
		];
	}

	private assertPrivacySafeRecorderId(recorderConversationId: string): void {
		if (!SAFE_IDENTIFIER.test(recorderConversationId)) {
			throw new Error(
				"recorder conversation id must be a bounded safe identifier",
			);
		}
	}

	private assertPrivacySafeTurn(turn: TurnEvidence): void {
		const unexpectedKeys = Object.keys(turn).filter(
			(key) => !TURN_EVIDENCE_KEYS.has(key as keyof TurnEvidence),
		);
		if (unexpectedKeys.length > 0) {
			throw new Error(
				`cache flight recorder turn contains unsupported fields: ${unexpectedKeys.join(", ")}`,
			);
		}
		for (const value of [
			turn.identityFingerprint,
			turn.servingAccountId,
			turn.prefixFingerprint,
		]) {
			if (value !== undefined && !SAFE_FINGERPRINT.test(value)) {
				throw new Error(
					"cache flight recorder identifiers must be bounded and safe",
				);
			}
		}
		if (
			turn.unavailableDimensions.length > EVIDENCE_DIMENSIONS.size ||
			turn.unavailableDimensions.some(
				(dimension) => !EVIDENCE_DIMENSIONS.has(dimension),
			)
		) {
			throw new Error("cache flight recorder dimensions must be allowlisted");
		}
	}

	private assertPrivacySafeSealReceipt(
		receipt: CacheFlightCohortSealReceipt,
	): void {
		this.assertExactKeys(receipt, RECEIPT_KEYS, "cache flight seal receipt");
		this.assertExactKeys(
			receipt.serviceEpoch,
			SERVICE_EPOCH_KEYS,
			"cache flight service epoch",
		);
		this.assertExactKeys(
			receipt.observationPartition,
			PARTITION_KEYS,
			"cache flight partition",
		);
		const service = receipt.serviceEpoch;
		const partition = receipt.observationPartition;
		this.assertSafeSealIdentifier(service.id);
		this.assertSafeSealIdentifier(partition.id);
		this.assertSafeSealIdentifier(partition.serviceEpochId);
		if (partition.serviceEpochId !== service.id) {
			throw new Error(
				"cache flight partition must reference its service epoch",
			);
		}
		if (service.sealContractVersion !== SEAL_CONTRACT_VERSION) {
			throw new Error("cache flight seal contract version must be v1");
		}
		this.assertOptionalSafeSealIdentifier(service.deploymentRevision);
		this.assertOptionalSafeSealIdentifier(service.serviceInstanceId);
		this.assertOptionalSafeSealIdentifier(service.occurrenceId);
		this.assertOptionalSafeSealIdentifier(partition.servingAccountScope);
		this.assertOptionalSafeSealIdentifier(partition.routeModelEpoch);
		this.assertTimestamp(service.processStartedAt);
		this.assertState(service.nativeCacheState, "native cache");
		this.assertState(service.recorderState, "recorder");
		this.assertKeepalivePolicy(service.keepalivePolicy);
		this.assertCompleteness(service.completeness);
		this.assertCompleteness(partition.completeness);
		this.assertCompleteness(receipt.completeness);

		const expectedServiceUnavailable = this.expectedServiceUnavailable(service);
		const expectedPartitionUnavailable =
			this.expectedPartitionUnavailable(partition);
		const expectedReceiptUnavailable = [
			...expectedServiceUnavailable,
			...expectedPartitionUnavailable,
		];
		this.assertUnavailableDimensions(
			service.unavailableDimensions,
			SERVICE_DIMENSIONS,
		);
		this.assertUnavailableDimensions(
			partition.unavailableDimensions,
			PARTITION_DIMENSIONS,
		);
		this.assertUnavailableDimensions(
			receipt.unavailableDimensions,
			ALL_SEAL_DIMENSIONS,
		);
		this.assertExactUnavailable(
			service.unavailableDimensions,
			expectedServiceUnavailable,
		);
		this.assertExactUnavailable(
			partition.unavailableDimensions,
			expectedPartitionUnavailable,
		);
		this.assertExactUnavailable(
			receipt.unavailableDimensions,
			expectedReceiptUnavailable,
		);
		if (
			service.completeness !== this.completenessFor(expectedServiceUnavailable)
		) {
			throw new Error(
				"cache flight service epoch completeness is inconsistent",
			);
		}
		if (
			partition.completeness !==
			this.completenessFor(expectedPartitionUnavailable)
		) {
			throw new Error("cache flight partition completeness is inconsistent");
		}
		if (
			receipt.completeness !== this.completenessFor(expectedReceiptUnavailable)
		) {
			throw new Error("cache flight seal completeness is inconsistent");
		}
	}

	private toTurnEvidence(row: StoredTurn): CacheFlightRecorderStoredTurn {
		const turn: CacheFlightRecorderStoredTurn = {
			sequence: Number(row.sequence),
			timestamp: row.timestamp,
			cacheOutcome: row.cache_outcome,
			completeness: row.completeness,
			unavailableDimensions: this.parseUnavailableDimensions(
				row.unavailable_dimensions,
			),
			seal: this.toPersistedSeal(row),
		};
		if (row.identity_fingerprint !== null)
			turn.identityFingerprint = row.identity_fingerprint;
		if (row.serving_account_id !== null)
			turn.servingAccountId = row.serving_account_id;
		if (row.prefix_fingerprint !== null)
			turn.prefixFingerprint = row.prefix_fingerprint;
		if (row.input_tokens !== null) turn.inputTokens = Number(row.input_tokens);
		if (row.cached_tokens !== null)
			turn.cachedTokens = Number(row.cached_tokens);
		if (row.gap_before) turn.gapBefore = true;
		return turn;
	}

	private toPersistedSeal(row: StoredTurn): CacheFlightPersistedSeal | null {
		return this.projectStoredSeal(row).seal;
	}

	private projectStoredSeal(row: StoredTurn): StoredSealProjection {
		if (row.observation_partition_id === null) {
			return { seal: null, status: "unsealed" };
		}

		const turnPartitionId = this.loadedRequiredSealIdentifier(
			row.observation_partition_id,
		);
		const partitionId = this.loadedRequiredSealIdentifier(row.partition_id);
		const partitionServiceEpochId = this.loadedRequiredSealIdentifier(
			row.partition_service_epoch_id,
		);
		const epochId = this.loadedRequiredSealIdentifier(row.epoch_id);
		const missingPartition = row.partition_id === null;
		const missingEpoch = row.epoch_id === null;
		const serviceDeclared = this.parseSealDimensions(
			row.epoch_unavailable_dimensions,
			SERVICE_DIMENSIONS,
		);
		const partitionDeclared = this.parseSealDimensions(
			row.partition_unavailable_dimensions,
			PARTITION_DIMENSIONS,
		);
		const sealDeclared = this.parseSealDimensions(
			row.seal_unavailable_dimensions,
			ALL_SEAL_DIMENSIONS,
		);
		const serviceDeclaredFromSeal = sealDeclared.dimensions.filter(
			(dimension) => SERVICE_DIMENSIONS.has(dimension),
		);
		const partitionDeclaredFromSeal = sealDeclared.dimensions.filter(
			(dimension) => PARTITION_DIMENSIONS.has(dimension),
		);
		const declaredServiceUnavailable = new Set<CacheFlightSealDimension>([
			...serviceDeclared.dimensions,
			...serviceDeclaredFromSeal,
		]);
		const declaredPartitionUnavailable = new Set<CacheFlightSealDimension>([
			...partitionDeclared.dimensions,
			...partitionDeclaredFromSeal,
		]);
		const serviceStructuralUnavailable =
			missingEpoch ||
			partitionServiceEpochId.malformed ||
			epochId.malformed ||
			(!missingEpoch && partitionServiceEpochId.value !== epochId.value);
		const partitionStructuralUnavailable =
			missingPartition ||
			turnPartitionId.malformed ||
			partitionId.malformed ||
			partitionServiceEpochId.malformed ||
			turnPartitionId.value !== partitionId.value;

		let sealReceiptUnavailable =
			serviceStructuralUnavailable ||
			partitionStructuralUnavailable ||
			serviceDeclared.malformed ||
			partitionDeclared.malformed ||
			sealDeclared.malformed ||
			sealDeclared.dimensions.includes("seal_receipt") ||
			!this.sameDimensionSet(
				serviceDeclared.dimensions,
				serviceDeclaredFromSeal,
			) ||
			!this.sameDimensionSet(
				partitionDeclared.dimensions,
				partitionDeclaredFromSeal,
			) ||
			turnPartitionId.value !== partitionId.value ||
			(!missingEpoch && partitionServiceEpochId.value !== epochId.value);

		const contractVersion = this.loadedSealContractVersion(
			row.seal_contract_version,
		);
		const occurrenceId = this.loadedIdentifier(row.occurrence_id);
		const deploymentRevision = this.loadedIdentifier(row.deployment_revision);
		const serviceInstanceId = this.loadedIdentifier(row.service_instance_id);
		const processStartedAt = this.loadedTimestamp(row.process_started_at);
		const nativeCacheState = this.loadedState(row.native_cache_state);
		const recorderState = this.loadedState(row.recorder_state);
		const keepalivePolicy = this.loadedKeepalivePolicy(row);
		const servingAccountScope = this.loadedIdentifier(
			row.serving_account_scope,
		);
		const routeModelEpoch = this.loadedIdentifier(row.route_model_epoch);
		const serviceCompleteness = this.loadedCompleteness(row.epoch_completeness);
		const partitionCompleteness = this.loadedCompleteness(
			row.partition_completeness,
		);
		const sealCompleteness = this.loadedCompleteness(row.seal_completeness);

		if (
			contractVersion.malformed ||
			occurrenceId.malformed ||
			deploymentRevision.malformed ||
			serviceInstanceId.malformed ||
			processStartedAt.malformed ||
			nativeCacheState.malformed ||
			recorderState.malformed ||
			keepalivePolicy.malformed ||
			servingAccountScope.malformed ||
			routeModelEpoch.malformed ||
			serviceCompleteness.malformed ||
			partitionCompleteness.malformed ||
			sealCompleteness.malformed
		) {
			sealReceiptUnavailable = true;
		}

		const serviceEpoch: CacheFlightServiceEpoch = {
			id: missingEpoch ? partitionServiceEpochId.value : epochId.value,
			occurrenceId: declaredServiceUnavailable.has("service_epoch_occurrence")
				? null
				: occurrenceId.value,
			sealContractVersion: declaredServiceUnavailable.has(
				"seal_contract_version",
			)
				? null
				: contractVersion.value,
			deploymentRevision: declaredServiceUnavailable.has("deployment_revision")
				? null
				: deploymentRevision.value,
			serviceInstanceId: declaredServiceUnavailable.has("service_instance")
				? null
				: serviceInstanceId.value,
			processStartedAt: declaredServiceUnavailable.has("process_started_at")
				? null
				: processStartedAt.value,
			nativeCacheState: declaredServiceUnavailable.has("native_cache_state")
				? null
				: nativeCacheState.value,
			recorderState: declaredServiceUnavailable.has("recorder_state")
				? null
				: recorderState.value,
			keepalivePolicy: declaredServiceUnavailable.has("keepalive_policy")
				? null
				: keepalivePolicy.value,
			completeness: "incomplete",
			unavailableDimensions: [],
		};
		const partition = {
			id: partitionId.value,
			serviceEpochId: partitionServiceEpochId.value,
			servingAccountScope: declaredPartitionUnavailable.has(
				"serving_account_scope",
			)
				? null
				: servingAccountScope.value,
			routeModelEpoch: declaredPartitionUnavailable.has("route_model_epoch")
				? null
				: routeModelEpoch.value,
			completeness: "incomplete" as CacheFlightSealCompleteness,
			unavailableDimensions: [] as CacheFlightSealDimension[],
		};

		const serviceUnavailable = this.orderedSealDimensions(
			SERVICE_DIMENSION_ORDER,
			new Set([
				...declaredServiceUnavailable,
				...this.expectedServiceUnavailable(serviceEpoch),
			]),
		);
		const partitionUnavailable = this.orderedSealDimensions(
			PARTITION_DIMENSION_ORDER,
			new Set([
				...declaredPartitionUnavailable,
				...this.expectedPartitionUnavailable(partition),
			]),
		);
		const sealDeclaredWithoutReceipt = sealDeclared.dimensions.filter(
			(dimension) => dimension !== "seal_receipt",
		);
		if (
			!this.sameDimensionSet(serviceDeclared.dimensions, serviceUnavailable) ||
			!this.sameDimensionSet(
				partitionDeclared.dimensions,
				partitionUnavailable,
			) ||
			!this.sameDimensionSet(sealDeclaredWithoutReceipt, [
				...serviceUnavailable,
				...partitionUnavailable,
			]) ||
			serviceCompleteness.value !== this.completenessFor(serviceUnavailable) ||
			partitionCompleteness.value !==
				this.completenessFor(partitionUnavailable) ||
			sealCompleteness.value !==
				this.completenessFor([...serviceUnavailable, ...partitionUnavailable])
		) {
			sealReceiptUnavailable = true;
		}

		const receiptUnavailable = new Set<CacheFlightSealDimension>([
			...sealDeclared.dimensions,
			...serviceUnavailable,
			...partitionUnavailable,
		]);
		if (sealReceiptUnavailable) {
			receiptUnavailable.add("seal_receipt");
		}
		const unavailableDimensions = this.orderedSealDimensions(
			SEAL_DIMENSION_ORDER,
			receiptUnavailable,
		);
		const serviceEvidenceMalformed =
			serviceStructuralUnavailable ||
			serviceDeclared.malformed ||
			contractVersion.malformed ||
			occurrenceId.malformed ||
			deploymentRevision.malformed ||
			serviceInstanceId.malformed ||
			processStartedAt.malformed ||
			nativeCacheState.malformed ||
			recorderState.malformed ||
			keepalivePolicy.malformed ||
			serviceCompleteness.malformed;
		const partitionEvidenceMalformed =
			partitionStructuralUnavailable ||
			partitionDeclared.malformed ||
			servingAccountScope.malformed ||
			routeModelEpoch.malformed ||
			partitionCompleteness.malformed;
		const projectedServiceCompleteness =
			serviceCompleteness.value === "complete" &&
			serviceUnavailable.length === 0 &&
			!serviceEvidenceMalformed
				? "complete"
				: "incomplete";
		const projectedPartitionCompleteness =
			partitionCompleteness.value === "complete" &&
			partitionUnavailable.length === 0 &&
			!partitionEvidenceMalformed
				? "complete"
				: "incomplete";
		const projectedSealCompleteness =
			sealCompleteness.value === "complete" &&
			unavailableDimensions.length === 0 &&
			projectedServiceCompleteness === "complete" &&
			projectedPartitionCompleteness === "complete" &&
			!sealCompleteness.malformed
				? "complete"
				: "incomplete";
		const seal: CacheFlightPersistedSeal = {
			serviceEpoch: {
				...serviceEpoch,
				completeness: projectedServiceCompleteness,
				unavailableDimensions: serviceUnavailable,
			},
			observationPartition: {
				...partition,
				completeness: projectedPartitionCompleteness,
				unavailableDimensions: partitionUnavailable,
			},
			completeness: projectedSealCompleteness,
			unavailableDimensions,
		};
		return {
			seal,
			status:
				projectedSealCompleteness === "complete" ? "sealed" : "incompleteSeal",
		};
	}

	private assertExactKeys(
		value: unknown,
		keys: ReadonlySet<string>,
		label: string,
	): void {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`${label} must match exact own-key set`);
		}
		const missingKeys = [...keys].filter((key) => !Object.hasOwn(value, key));
		const unexpectedKeys = Object.keys(value).filter((key) => !keys.has(key));
		if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
			throw new Error(`${label} must match exact own-key set`);
		}
	}

	private assertSafeSealIdentifier(value: unknown): asserts value is string {
		if (
			typeof value !== "string" ||
			!SAFE_IDENTIFIER.test(value) ||
			SECRET_SHAPED.test(value)
		) {
			throw new Error("cache flight seal identifiers must be bounded and safe");
		}
	}

	private assertOptionalSafeSealIdentifier(
		value: unknown,
	): asserts value is string | null {
		if (value !== null) this.assertSafeSealIdentifier(value);
	}

	private assertTimestamp(value: string | null): void {
		if (value === null) return;
		if (!this.isCanonicalIsoTimestamp(value)) {
			throw new Error(
				"cache flight seal timestamps must be bounded ISO evidence",
			);
		}
	}

	private assertState(value: string | null, label: string): void {
		if (value !== null && value !== "enabled" && value !== "disabled") {
			throw new Error(`cache flight ${label} state must be an exact enum`);
		}
	}

	private assertKeepalivePolicy(
		value: CacheFlightKeepalivePolicySnapshot | null,
	): void {
		if (value === null) return;
		this.assertExactKeys(
			value,
			KEEPALIVE_POLICY_KEYS,
			"cache flight keepalive policy",
		);
		this.assertTtl(value.globalTtlMinutes);
		this.assertTtl(value.xaiTtlMinutes);
		this.assertTtl(value.effectiveXaiTtlMinutes);
		if (typeof value.effectiveXaiEnabled !== "boolean") {
			throw new Error("cache flight keepalive policy booleans must be typed");
		}
		if (!this.keepalivePolicyMatchesCanonicalV1XaiDerivation(value)) {
			throw new Error(
				"cache flight keepalive policy must match canonical v1 xAI derivation",
			);
		}
	}

	private keepalivePolicyMatchesCanonicalV1XaiDerivation(
		value: CacheFlightKeepalivePolicySnapshot,
	): boolean {
		if (value.globalTtlMinutes === null || value.xaiTtlMinutes === null) {
			return false;
		}
		const effectiveXaiTtlMinutes =
			value.xaiTtlMinutes > 0
				? value.xaiTtlMinutes
				: value.globalTtlMinutes > 0
					? value.globalTtlMinutes
					: null;
		return (
			value.effectiveXaiEnabled === (effectiveXaiTtlMinutes !== null) &&
			value.effectiveXaiTtlMinutes === effectiveXaiTtlMinutes
		);
	}

	private assertTtl(value: number | null): void {
		if (value === null) return;
		if (!Number.isInteger(value) || value < 0 || value > MAX_TTL_MINUTES) {
			throw new Error("cache flight keepalive TTLs must be bounded integers");
		}
	}

	private assertCompleteness(
		value: string,
	): asserts value is CacheFlightSealCompleteness {
		if (value !== "complete" && value !== "incomplete") {
			throw new Error("cache flight seal completeness must be exact");
		}
	}

	private assertUnavailableDimensions(
		value: readonly CacheFlightSealDimension[],
		allowed: ReadonlySet<CacheFlightSealDimension>,
	): void {
		if (!Array.isArray(value) || value.length > SEAL_DIMENSION_ORDER.length) {
			throw new Error(
				"cache flight seal unavailable dimensions must be bounded",
			);
		}
		const seen = new Set<CacheFlightSealDimension>();
		for (const dimension of value) {
			if (!allowed.has(dimension) || seen.has(dimension)) {
				throw new Error(
					"cache flight seal unavailable dimensions must be allowlisted",
				);
			}
			seen.add(dimension);
		}
	}

	private assertExactUnavailable(
		actual: readonly CacheFlightSealDimension[],
		expected: readonly CacheFlightSealDimension[],
	): void {
		if (
			actual.length !== expected.length ||
			actual.some((dimension, index) => dimension !== expected[index])
		) {
			throw new Error("unknown seal dimensions must be explicit");
		}
	}

	private expectedServiceUnavailable(
		service: CacheFlightServiceEpoch,
	): CacheFlightSealDimension[] {
		const unavailable: CacheFlightSealDimension[] = [];
		if (service.sealContractVersion !== SEAL_CONTRACT_VERSION) {
			unavailable.push("seal_contract_version");
		}
		if (service.deploymentRevision === null) {
			unavailable.push("deployment_revision");
		}
		if (service.serviceInstanceId === null) {
			unavailable.push("service_instance");
		}
		if (service.processStartedAt === null) {
			unavailable.push("process_started_at");
		}
		if (service.nativeCacheState === null) {
			unavailable.push("native_cache_state");
		}
		if (service.recorderState === null) {
			unavailable.push("recorder_state");
		}
		if (service.keepalivePolicy === null) {
			unavailable.push("keepalive_policy");
		}
		if (service.occurrenceId === null) {
			unavailable.push("service_epoch_occurrence");
		}
		return unavailable;
	}

	private expectedPartitionUnavailable(partition: {
		readonly servingAccountScope: string | null;
		readonly routeModelEpoch: string | null;
	}): CacheFlightSealDimension[] {
		const unavailable: CacheFlightSealDimension[] = [];
		if (partition.servingAccountScope === null) {
			unavailable.push("serving_account_scope");
		}
		if (partition.routeModelEpoch === null) {
			unavailable.push("route_model_epoch");
		}
		return unavailable;
	}

	private completenessFor(
		unavailableDimensions: readonly CacheFlightSealDimension[],
	): CacheFlightSealCompleteness {
		return unavailableDimensions.length === 0 ? "complete" : "incomplete";
	}

	private loadedIdentifier(value: string | null): {
		value: string | null;
		malformed: boolean;
	} {
		if (value === null) return { value: null, malformed: false };
		if (SAFE_IDENTIFIER.test(value) && !SECRET_SHAPED.test(value)) {
			return { value, malformed: false };
		}
		return { value: null, malformed: true };
	}

	private loadedRequiredSealIdentifier(value: string | null): {
		value: string;
		malformed: boolean;
	} {
		const loaded = this.loadedIdentifier(value);
		return {
			value: loaded.value ?? UNKNOWN_SEAL_IDENTIFIER,
			malformed: loaded.malformed,
		};
	}

	private loadedSealContractVersion(value: number | null): {
		value: number | null;
		malformed: boolean;
	} {
		if (value === SEAL_CONTRACT_VERSION) {
			return { value: SEAL_CONTRACT_VERSION, malformed: false };
		}
		if (value === null) return { value: null, malformed: false };
		return { value: null, malformed: true };
	}

	private loadedTimestamp(value: string | null): {
		value: string | null;
		malformed: boolean;
	} {
		if (value === null) return { value: null, malformed: false };
		if (this.isCanonicalIsoTimestamp(value)) {
			return { value, malformed: false };
		}
		return { value: null, malformed: true };
	}

	private loadedState(value: string | null): {
		value: "enabled" | "disabled" | null;
		malformed: boolean;
	} {
		if (value === null) return { value: null, malformed: false };
		if (value === "enabled" || value === "disabled") {
			return { value, malformed: false };
		}
		return { value: null, malformed: true };
	}

	private loadedCompleteness(
		value: CacheFlightSealCompleteness | string | null,
	): {
		value: CacheFlightSealCompleteness;
		malformed: boolean;
	} {
		if (value === "complete" || value === "incomplete") {
			return { value, malformed: false };
		}
		return { value: "incomplete", malformed: true };
	}

	private loadedKeepalivePolicy(row: StoredTurn): {
		value: CacheFlightKeepalivePolicySnapshot | null;
		malformed: boolean;
	} {
		const rawValues = [
			row.keepalive_global_ttl_minutes,
			row.keepalive_xai_ttl_minutes,
			row.keepalive_effective_xai_enabled,
			row.keepalive_effective_xai_ttl_minutes,
		];
		if (rawValues.every((value) => value === null)) {
			return { value: null, malformed: false };
		}
		const globalTtl = this.loadedTtl(row.keepalive_global_ttl_minutes);
		const xaiTtl = this.loadedTtl(row.keepalive_xai_ttl_minutes);
		const effectiveEnabled = this.loadedBoolean(
			row.keepalive_effective_xai_enabled,
		);
		const effectiveTtl = this.loadedTtl(
			row.keepalive_effective_xai_ttl_minutes,
		);
		if (
			globalTtl.malformed ||
			xaiTtl.malformed ||
			effectiveEnabled.malformed ||
			effectiveEnabled.value === null ||
			effectiveTtl.malformed
		) {
			return { value: null, malformed: true };
		}
		const keepalivePolicy = {
			globalTtlMinutes: globalTtl.value,
			xaiTtlMinutes: xaiTtl.value,
			effectiveXaiEnabled: effectiveEnabled.value,
			effectiveXaiTtlMinutes: effectiveTtl.value,
		};
		if (!this.keepalivePolicyMatchesCanonicalV1XaiDerivation(keepalivePolicy)) {
			return { value: null, malformed: true };
		}
		return {
			value: keepalivePolicy,
			malformed: false,
		};
	}

	private loadedBoolean(value: number | boolean | null): {
		value: boolean | null;
		malformed: boolean;
	} {
		if (value === null) return { value: null, malformed: false };
		if (value === 0 || value === false) {
			return { value: false, malformed: false };
		}
		if (value === 1 || value === true) {
			return { value: true, malformed: false };
		}
		return { value: null, malformed: true };
	}

	private loadedTtl(value: number | null): {
		value: number | null;
		malformed: boolean;
	} {
		if (value === null) return { value: null, malformed: false };
		if (Number.isInteger(value) && value >= 0 && value <= MAX_TTL_MINUTES) {
			return { value: Number(value), malformed: false };
		}
		return { value: null, malformed: true };
	}

	private isCanonicalIsoTimestamp(value: string): boolean {
		if (
			typeof value !== "string" ||
			value.length > 64 ||
			SECRET_SHAPED.test(value)
		) {
			return false;
		}
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
	}

	private orderedSealDimensions(
		order: readonly CacheFlightSealDimension[],
		dimensions: ReadonlySet<CacheFlightSealDimension>,
	): CacheFlightSealDimension[] {
		return order.filter((dimension) => dimensions.has(dimension));
	}

	private sameDimensionSet(
		left: readonly CacheFlightSealDimension[],
		right: readonly CacheFlightSealDimension[],
	): boolean {
		if (left.length !== right.length) return false;
		const rightSet = new Set(right);
		return left.every((dimension) => rightSet.has(dimension));
	}

	private parseSealDimensions(
		value: string | null,
		allowed: ReadonlySet<CacheFlightSealDimension>,
	): {
		dimensions: CacheFlightSealDimension[];
		malformed: boolean;
	} {
		if (value === null) return { dimensions: [], malformed: true };
		try {
			const parsed: unknown = JSON.parse(value);
			if (!Array.isArray(parsed)) {
				return { dimensions: [], malformed: true };
			}
			const dimensions: CacheFlightSealDimension[] = [];
			const seen = new Set<CacheFlightSealDimension>();
			for (const item of parsed) {
				if (
					typeof item !== "string" ||
					!allowed.has(item as CacheFlightSealDimension) ||
					seen.has(item as CacheFlightSealDimension)
				) {
					return { dimensions: [], malformed: true };
				}
				const dimension = item as CacheFlightSealDimension;
				seen.add(dimension);
				dimensions.push(dimension);
			}
			return { dimensions, malformed: false };
		} catch {
			return { dimensions: [], malformed: true };
		}
	}

	private parseUnavailableDimensions(value: string): string[] {
		try {
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: [];
		} catch {
			return [];
		}
	}
}
