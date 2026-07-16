import { createHash } from "node:crypto";
import { TIME_CONSTANTS } from "@better-ccflare/core";

export const CODEX_SINGLE_ORCHESTRATION_ROOT_ENV =
	"CCFLARE_CODEX_SINGLE_ORCHESTRATION_ROOT";
export const ORCHESTRATION_SESSION_TTL_MS =
	TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT;
export const ORCHESTRATION_MAX_SESSIONS = 2_048;

export type OrchestrationAdmission =
	| "root"
	| "non_root"
	| "no_session"
	| "no_conversation"
	| "no_orchestration_tools"
	| "disabled";

interface ElectionEntry {
	conversationId: string;
	lastActiveAt: number;
}

interface ElectionStoreOptions {
	clock?: () => number;
	ttlMs?: number;
	maxSessions?: number;
}

/**
 * Diagnostic-only, read-only view of a session's current entry. Taken before
 * admit() would mutate it, so a caller can report how long the existing root
 * had been idle and whether the instructions that won it still match.
 */
export interface ElectionSnapshot {
	readonly conversationId: string;
	readonly lastActiveAt: number;
	/**
	 * Instructions text last recorded for this session's root via
	 * recordRootInstructions(). Empty string if never recorded.
	 */
	readonly instructions: string;
}

/**
 * Synchronous process-local election. JavaScript's run-to-completion semantics
 * make the first immediate caller the sole winner without an async race window.
 */
export class OrchestrationElectionStore {
	private readonly entries = new Map<string, ElectionEntry>();
	/**
	 * Diagnostic-only companion to entries, keyed by the same sessionId. Never
	 * read by admit() and never influences an admission outcome; it exists
	 * solely so peek() can report whether a later, non-matching turn's
	 * instructions still line up with whatever last won the root.
	 */
	private readonly rootInstructions = new Map<string, string>();
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

	admit(sessionId: string, conversationId: string): "root" | "non_root" {
		const now = this.clock();
		this.pruneExpired(now);
		const existing = this.entries.get(sessionId);
		if (existing) {
			existing.lastActiveAt = now;
			return existing.conversationId === conversationId ? "root" : "non_root";
		}
		if (this.entries.size >= this.maxSessions) this.evictLeastRecentlyActive();
		this.entries.set(sessionId, { conversationId, lastActiveAt: now });
		return "root";
	}

	reset(): void {
		this.entries.clear();
		this.rootInstructions.clear();
	}

	/**
	 * Diagnostic-only, read-only peek at a session's current entry. Never
	 * mutates state and is not part of admit()'s decision path; callers use it
	 * immediately before admit() to capture "this session already had an
	 * elected root" for observability.
	 */
	peek(sessionId: string): ElectionSnapshot | undefined {
		const existing = this.entries.get(sessionId);
		if (!existing) return undefined;
		return {
			conversationId: existing.conversationId,
			lastActiveAt: existing.lastActiveAt,
			instructions: this.rootInstructions.get(sessionId) ?? "",
		};
	}

	/**
	 * Diagnostic-only. Records the instructions text observed alongside a
	 * "root" admission for this session. Never called from admit() and never
	 * consulted by it; exists purely so peek() can surface whether a later
	 * turn's instructions still match what won the root.
	 */
	recordRootInstructions(sessionId: string, instructions: string): void {
		this.rootInstructions.set(sessionId, instructions);
	}

	private pruneExpired(now: number): void {
		for (const [sessionId, entry] of this.entries) {
			if (now - entry.lastActiveAt >= this.ttlMs) {
				this.entries.delete(sessionId);
				this.rootInstructions.delete(sessionId);
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
			this.rootInstructions.delete(oldestSession);
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
): "root" | "non_root" {
	return processElectionStore.admit(sessionId, conversationId);
}

/**
 * Diagnostic-only, read-only peek at a session's current entry. See
 * OrchestrationElectionStore.peek for the contract; never affects election
 * outcomes.
 */
export function peekOrchestrationRoot(
	sessionId: string,
): ElectionSnapshot | undefined {
	return processElectionStore.peek(sessionId);
}

/**
 * Diagnostic-only. See OrchestrationElectionStore.recordRootInstructions.
 */
export function recordOrchestrationRootInstructions(
	sessionId: string,
	instructions: string,
): void {
	processElectionStore.recordRootInstructions(sessionId, instructions);
}

export function resetOrchestrationElectionForTest(): void {
	processElectionStore.reset();
}
