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

/** Durable privacy-safe evidence store for cache flight recorder timelines. */
export class CacheFlightRecorderRepository extends BaseRepository<Timeline> {
	async appendTurn(
		recorderConversationId: string,
		turn: TurnEvidence,
		recordedAt = Date.now(),
	): Promise<void> {
		this.assertPrivacySafeTurn(turn);
		if (turn.sequence < 0 || !Number.isSafeInteger(turn.sequence)) {
			throw new Error("turn sequence must be a non-negative safe integer");
		}
		await this.run(
			`INSERT INTO cache_flight_recorder_conversations (
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
			[
				recorderConversationId,
				recordedAt,
				recordedAt,
				turn.completeness === "complete" ? 0 : 1,
			],
		);
		await this.run(
			`INSERT INTO cache_flight_recorder_turns (
				recorder_conversation_id, sequence, timestamp,
				identity_fingerprint, serving_account_id, prefix_fingerprint,
				cache_outcome, input_tokens, cached_tokens, completeness,
				unavailable_dimensions, gap_before
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (recorder_conversation_id, sequence) DO UPDATE SET
				timestamp = EXCLUDED.timestamp,
				identity_fingerprint = EXCLUDED.identity_fingerprint,
				serving_account_id = EXCLUDED.serving_account_id,
				prefix_fingerprint = EXCLUDED.prefix_fingerprint,
				cache_outcome = EXCLUDED.cache_outcome,
				input_tokens = EXCLUDED.input_tokens,
				cached_tokens = EXCLUDED.cached_tokens,
				completeness = EXCLUDED.completeness,
				unavailable_dimensions = EXCLUDED.unavailable_dimensions,
				gap_before = EXCLUDED.gap_before`,
			[
				recorderConversationId,
				turn.sequence,
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
			],
		);
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

	async expireOlderThan(cutoffTs: number): Promise<number> {
		const expired = await this.query<{ recorder_conversation_id: string }>(
			`DELETE FROM cache_flight_recorder_conversations
			 WHERE updated_at < ?
			 RETURNING recorder_conversation_id`,
			[cutoffTs],
		);
		return expired.length;
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
