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
 * Synchronous process-local election. JavaScript's run-to-completion semantics
 * make the first immediate caller the sole winner without an async race window.
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
	}

	private pruneExpired(now: number): void {
		for (const [sessionId, entry] of this.entries) {
			if (now - entry.lastActiveAt >= this.ttlMs)
				this.entries.delete(sessionId);
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
		if (oldestSession !== undefined) this.entries.delete(oldestSession);
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

export function resetOrchestrationElectionForTest(): void {
	processElectionStore.reset();
}
