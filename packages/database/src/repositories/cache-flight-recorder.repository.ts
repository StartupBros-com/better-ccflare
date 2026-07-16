import type {
	Completeness,
	Timeline,
	TurnEvidence,
} from "@better-ccflare/core";
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
}

export interface MarkIncompleteOptions {
	dropped?: boolean;
	at?: number;
}

export interface CacheFlightRecorderCounts {
	dropped: number;
	incomplete: number;
}

export interface CacheFlightRecorderTimeline extends Timeline {
	createdAt: number;
	updatedAt: number;
	incomplete: boolean;
	droppedEvents: number;
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

/** Durable privacy-safe evidence store for cache flight recorder timelines. */
export class CacheFlightRecorderRepository extends BaseRepository<Timeline> {
	async appendTurn(
		recorderConversationId: string,
		turn: TurnEvidence,
		recordedAt = Date.now(),
	): Promise<void> {
		this.assertPrivacySafeRecorderId(recorderConversationId);
		this.assertPrivacySafeTurn(turn);
		// Keep tombstone removal, conversation upsert, and sequence allocation atomic so
		// a partial failure cannot leave an expired tombstone without its live timeline.
		await this.adapter.runBatchWithChanges([
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
			{
				sql: `INSERT INTO cache_flight_recorder_turns (
					recorder_conversation_id, sequence, timestamp,
					identity_fingerprint, serving_account_id, prefix_fingerprint,
					cache_outcome, input_tokens, cached_tokens, completeness,
					unavailable_dimensions, gap_before
				) SELECT ?, COALESCE(MAX(sequence), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
					recorderConversationId,
				],
			},
		]);
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
			`SELECT sequence, timestamp, identity_fingerprint, serving_account_id,
				prefix_fingerprint, cache_outcome, input_tokens, cached_tokens,
				completeness, unavailable_dimensions, gap_before
			 FROM cache_flight_recorder_turns
			 WHERE recorder_conversation_id = ?
			 ORDER BY sequence ASC`,
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
			[recorderConversationId, at, at, options.dropped ? 1 : 0],
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
		return {
			dropped: Number(row?.dropped ?? 0),
			incomplete: Number(row?.incomplete ?? 0),
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
		]);
		return expired ?? 0;
	}

	async expireTombstonesOlderThan(now: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM cache_flight_recorder_tombstones WHERE expires_at < ?`,
			[now],
		);
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

	private toTurnEvidence(row: StoredTurn): TurnEvidence {
		const turn: TurnEvidence = {
			sequence: Number(row.sequence),
			timestamp: row.timestamp,
			cacheOutcome: row.cache_outcome,
			completeness: row.completeness,
			unavailableDimensions: this.parseUnavailableDimensions(
				row.unavailable_dimensions,
			),
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
