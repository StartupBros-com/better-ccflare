import { createHash } from "node:crypto";
import { TIME_CONSTANTS } from "@better-ccflare/core";

export const CODEX_SINGLE_ORCHESTRATION_ROOT_ENV =
	"CCFLARE_CODEX_SINGLE_ORCHESTRATION_ROOT";
export const ORCHESTRATION_SESSION_TTL_MS =
	TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT;
export const ORCHESTRATION_MAX_SESSIONS = 2_048;

/**
 * Bounds on per-session continuity state. Identity aliases retain accepted
 * insertion order; lineage hashes retain recency order so reobserved calls
 * remain eligible while older, inactive lineage is evicted first.
 */
export const ORCHESTRATION_MAX_IDENTITY_ALIASES = 8;
export const ORCHESTRATION_MAX_LINEAGE_HASHES = 32;

/** Inclusive bounds on a `call_id` string eligible for lineage hashing. */
export const ORCHESTRATION_MIN_CALL_ID_LENGTH = 1;
export const ORCHESTRATION_MAX_CALL_ID_LENGTH = 512;

const LINEAGE_HASH_DOMAIN = "ccflare.codex.orchestration.lineage.v1";
const INSTRUCTIONS_HASH_DOMAIN = "ccflare.codex.orchestration.instructions.v1";

export type OrchestrationAdmission =
	| "root"
	| "non_root"
	| "no_session"
	| "no_conversation"
	| "no_orchestration_tools"
	| "disabled"
	/**
	 * A request attributed to a subagent (isAttributedAgent=true) that
	 * offered current Agent/Task tools. Assigned entirely outside of
	 * OrchestrationElectionStore.admit(): descendants must never contend
	 * for -- or claim -- a session's root slot, so this value is set by the
	 * caller (see provider.ts) without ever calling admit() or snapshot().
	 */
	| "attributed_descendant";

/** The reasoning basis behind an admit() outcome. */
export type OrchestrationAdmissionBasis =
	| "initial_claim"
	| "identity_match"
	| "lineage_match"
	| "rejected";

export interface OrchestrationAdmissionResult {
	readonly admission: "root" | "non_root";
	readonly basis: OrchestrationAdmissionBasis;
	/** Stable root identity for accepted admissions; null when rejected. */
	readonly canonicalConversationIdentity: string | null;
}

interface ElectionEntry {
	/** Stable conversation identity used as the root's canonical cache identity. */
	canonicalIdentity: string;
	/** Bounded FIFO of conversation identity hashes accepted as this root. */
	identities: string[];
	/** Bounded FIFO of the newest session-scoped call_id lineage hashes seen. */
	lineageHashes: string[];
	/** Domain-separated hash of the instructions text that hold the root. */
	instructionHash: string;
	lastActiveAt: number;
}

interface ElectionStoreOptions {
	clock?: () => number;
	ttlMs?: number;
	maxSessions?: number;
}

/**
 * Diagnostic-only, read-only, defensively-copied view of a session's current
 * root entry. Never shares array references with internal state, so mutating
 * a returned snapshot can never influence admit()'s future decisions.
 */
export interface OrchestrationRootSnapshot {
	readonly identities: readonly string[];
	readonly lineageHashes: readonly string[];
	readonly instructionHash: string;
	readonly lastActiveAt: number;
}

/**
 * Pure, domain-separated, session-scoped hash of a `call_id` string. Returns
 * undefined for any input that is not a string within
 * [ORCHESTRATION_MIN_CALL_ID_LENGTH, ORCHESTRATION_MAX_CALL_ID_LENGTH], so
 * malformed or adversarial call_id values can never be turned into a lineage
 * hash. Session-scoped (via sessionId) so lineage hashes never collide
 * across unrelated sessions.
 */
export function hashOrchestrationCallId(
	sessionId: string,
	callId: unknown,
): string | undefined {
	if (typeof callId !== "string") return undefined;
	if (
		callId.length < ORCHESTRATION_MIN_CALL_ID_LENGTH ||
		callId.length > ORCHESTRATION_MAX_CALL_ID_LENGTH
	) {
		return undefined;
	}
	return createHash("sha256")
		.update(LINEAGE_HASH_DOMAIN)
		.update("\0")
		.update(sessionId.toLowerCase())
		.update("\0")
		.update(callId)
		.digest("hex");
}

/**
 * Pure, domain-separated hash of an instructions string. Domain separation
 * (a distinct label plus a NUL separator) guarantees this can never collide
 * with a lineage hash, even if the raw bytes coincide.
 */
export function hashOrchestrationInstructions(instructions: string): string {
	return createHash("sha256")
		.update(INSTRUCTIONS_HASH_DOMAIN)
		.update("\0")
		.update(instructions)
		.digest("hex");
}

/** Appends `value` to `list` and evicts from the front until the bound is
 * satisfied. Reobserved values move to the newest position. */
function pushCapped(list: string[], value: string, max: number): void {
	const existingIndex = list.indexOf(value);
	if (existingIndex !== -1) list.splice(existingIndex, 1);
	list.push(value);
	while (list.length > max) list.shift();
}

/**
 * Pure, session-scoped extraction of lineage hashes from the `call_id` of
 * every `function_call` / `function_call_output` item in `input`. Items of
 * any other shape (wrong type, missing/invalid call_id, non-object entries)
 * are silently skipped rather than throwing, since `input` is
 * caller-controlled request data.
 *
 * Unlike a naive extraction, this itself enforces the same bound
 * `admit()` ultimately applies to stored lineage state: the returned array
 * holds at most {@link ORCHESTRATION_MAX_LINEAGE_HASHES} *unique* hashes.
 * Duplicates within `input` never grow the result past that bound, and when
 * more than the bound worth of unique hashes are present, only the newest
 * (last-seen) unique ones survive -- older unique hashes are evicted first,
 * exactly like the bounded FIFO `pushCapped` uses for stored state, so
 * calling this before storage is a no-op with respect to final content.
 * `input` itself is never mutated or held onto.
 */
export function extractLineageHashes(
	sessionId: string,
	input: readonly unknown[],
): string[] {
	const hashes: string[] = [];
	for (const item of input) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (
			record.type !== "function_call" &&
			record.type !== "function_call_output"
		) {
			continue;
		}
		const hash = hashOrchestrationCallId(sessionId, record.call_id);
		if (hash === undefined) continue;
		pushCapped(hashes, hash, ORCHESTRATION_MAX_LINEAGE_HASHES);
	}
	return hashes;
}

/**
 * Synchronous process-local election with bounded continuity state.
 * JavaScript's run-to-completion semantics make the first immediate caller
 * the sole initial-claim winner without an async race window.
 *
 * A session's root, once claimed, can survive a changed conversation
 * identity (e.g. context compaction reshaping deriveConversationIdentity's
 * hash) only when BOTH the instructions hash still matches AND the new
 * turn's call_id lineage overlaps a previously observed lineage hash for
 * this session. Any other differing identity is rejected without mutating
 * the entry at all (no timestamp renewal, no alias/lineage growth), so a
 * rejected caller can never accidentally extend or poison the true root's
 * TTL or continuity state.
 */
export class OrchestrationElectionStore {
	private readonly entries = new Map<string, ElectionEntry>();
	private readonly clock: () => number;
	private readonly ttlMs: number;
	private readonly maxSessions: number;

	constructor(options: ElectionStoreOptions = {}) {
		this.clock = options.clock ?? Date.now;
		this.ttlMs = options.ttlMs ?? ORCHESTRATION_SESSION_TTL_MS;
		this.maxSessions = options.maxSessions ?? ORCHESTRATION_MAX_SESSIONS;
	}

	get size(): number {
		return this.entries.size;
	}

	admit(
		sessionId: string,
		conversationId: string,
		instructions: string,
		input: readonly unknown[],
	): OrchestrationAdmissionResult {
		const now = this.clock();
		this.pruneExpired(now);

		const instructionHash = hashOrchestrationInstructions(instructions);
		const callLineageHashes = extractLineageHashes(sessionId, input);
		const existing = this.entries.get(sessionId);

		if (!existing) {
			if (this.entries.size >= this.maxSessions) {
				this.evictLeastRecentlyActive();
			}
			this.entries.set(sessionId, {
				canonicalIdentity: conversationId,
				identities: [conversationId],
				lineageHashes: [...callLineageHashes],
				instructionHash,
				lastActiveAt: now,
			});
			return {
				admission: "root",
				basis: "initial_claim",
				canonicalConversationIdentity: conversationId,
			};
		}

		if (existing.identities.includes(conversationId)) {
			existing.lastActiveAt = now;
			this.mergeLineage(existing, callLineageHashes);
			return {
				admission: "root",
				basis: "identity_match",
				canonicalConversationIdentity: existing.canonicalIdentity,
			};
		}

		const sameInstructions = existing.instructionHash === instructionHash;
		const lineageOverlap = callLineageHashes.some((hash) =>
			existing.lineageHashes.includes(hash),
		);

		if (sameInstructions && lineageOverlap) {
			existing.lastActiveAt = now;
			pushCapped(
				existing.identities,
				conversationId,
				ORCHESTRATION_MAX_IDENTITY_ALIASES,
			);
			this.mergeLineage(existing, callLineageHashes);
			return {
				admission: "root",
				basis: "lineage_match",
				canonicalConversationIdentity: existing.canonicalIdentity,
			};
		}

		// Rejected: no mutation whatsoever. Timestamps, identities, and lineage
		// hashes are left exactly as they were, so a rejected sibling can never
		// renew the true root's TTL or pollute its continuity state.
		return {
			admission: "non_root",
			basis: "rejected",
			canonicalConversationIdentity: null,
		};
	}

	reset(): void {
		this.entries.clear();
	}

	/**
	 * Diagnostic-only, read-only, defensively-copied snapshot of a session's
	 * current root entry. Never mutates state and is not part of admit()'s
	 * decision path.
	 */
	snapshot(sessionId: string): OrchestrationRootSnapshot | undefined {
		const existing = this.entries.get(sessionId);
		if (!existing) return undefined;
		return {
			identities: [...existing.identities],
			lineageHashes: [...existing.lineageHashes],
			instructionHash: existing.instructionHash,
			lastActiveAt: existing.lastActiveAt,
		};
	}

	private mergeLineage(entry: ElectionEntry, hashes: readonly string[]): void {
		for (const hash of hashes) {
			pushCapped(entry.lineageHashes, hash, ORCHESTRATION_MAX_LINEAGE_HASHES);
		}
	}

	private pruneExpired(now: number): void {
		for (const [sessionId, entry] of this.entries) {
			if (now - entry.lastActiveAt >= this.ttlMs) {
				this.entries.delete(sessionId);
			}
		}
	}

	private evictLeastRecentlyActive(): void {
		let oldestSession: string | undefined;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [sessionId, entry] of this.entries) {
			if (entry.lastActiveAt < oldestAt) {
				oldestAt = entry.lastActiveAt;
				oldestSession = sessionId;
			}
		}
		if (oldestSession !== undefined) {
			this.entries.delete(oldestSession);
		}
	}
}

export function deriveConversationIdentity(
	sessionId: string,
	instructions: string,
	input: readonly unknown[],
): string | undefined {
	if (input.length === 0) return undefined;
	let firstItem: string;
	try {
		const serialized = JSON.stringify(input[0]);
		if (serialized === undefined) return undefined;
		firstItem = serialized;
	} catch {
		return undefined;
	}
	return createHash("sha256")
		.update(sessionId.toLowerCase())
		.update("\0")
		.update(instructions)
		.update("\0")
		.update(firstItem)
		.digest("hex");
}

const processElectionStore = new OrchestrationElectionStore();

export function electOrchestrationRoot(
	sessionId: string,
	conversationId: string,
	instructions: string,
	input: readonly unknown[],
): OrchestrationAdmissionResult {
	return processElectionStore.admit(
		sessionId,
		conversationId,
		instructions,
		input,
	);
}

/**
 * Diagnostic-only, read-only snapshot of a session's current entry. See
 * OrchestrationElectionStore.snapshot for the contract; never affects
 * election outcomes.
 */
export function snapshotOrchestrationRoot(
	sessionId: string,
): OrchestrationRootSnapshot | undefined {
	return processElectionStore.snapshot(sessionId);
}

export function resetOrchestrationElectionForTest(): void {
	processElectionStore.reset();
}
