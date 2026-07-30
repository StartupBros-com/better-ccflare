import { getSessionAffinityAntiThrashWindowMs } from "@better-ccflare/core";
import type {
	AffinityOwnerDirective,
	AffinityOwnerSnapshot,
} from "@better-ccflare/types";
import type {
	AnthropicDegradedCohortKey,
	AnthropicDegradedProtectionState,
} from "./anthropic-degraded-mode";

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_EVIDENCE_WINDOW_MS = 30_000;
const DEFAULT_MAINTENANCE_BUDGET = 8;
const SATURATING_COUNTER_MAX = Number.MAX_SAFE_INTEGER;

type OverlayStage = "evidence" | "protected" | "hold-down";

interface DeadlineNode {
	readonly key: string;
	priority: number;
	tieBreaker: number;
}

interface OverlayEntry {
	readonly cohortKey: AnthropicDegradedCohortKey;
	readonly laneKey: string;
	readonly owner: AffinityOwnerSnapshot;
	readonly insertionOrder: number;
	stage: OverlayStage;
	expiresAt: number;
	touchedAt: number;
}

/**
 * Small keyed min-heap used for deadline cleanup and evidence eviction.
 * Updating an existing key is O(log N), so refreshes do not accumulate stale
 * heap nodes that would later turn one routing decision into an unbounded sweep.
 */
class KeyedDeadlineIndex {
	private readonly nodes: DeadlineNode[] = [];
	private readonly positions = new Map<string, number>();

	clear(): void {
		this.nodes.length = 0;
		this.positions.clear();
	}

	peek(): DeadlineNode | null {
		return this.nodes[0] ?? null;
	}

	upsert(key: string, priority: number, tieBreaker: number): void {
		const existingPosition = this.positions.get(key);
		if (existingPosition === undefined) {
			const position = this.nodes.length;
			this.nodes.push({ key, priority, tieBreaker });
			this.positions.set(key, position);
			this.bubbleUp(position);
			return;
		}

		const node = this.nodes[existingPosition];
		if (
			!node ||
			(node.priority === priority && node.tieBreaker === tieBreaker)
		) {
			return;
		}
		node.priority = priority;
		node.tieBreaker = tieBreaker;
		if (!this.bubbleUp(existingPosition)) {
			this.bubbleDown(existingPosition);
		}
	}

	remove(key: string): boolean {
		const position = this.positions.get(key);
		if (position === undefined) return false;
		this.removeAt(position);
		return true;
	}

	private compare(left: DeadlineNode, right: DeadlineNode): number {
		if (left.priority !== right.priority) {
			return left.priority < right.priority ? -1 : 1;
		}
		if (left.tieBreaker !== right.tieBreaker) {
			return left.tieBreaker < right.tieBreaker ? -1 : 1;
		}
		if (left.key === right.key) return 0;
		return left.key < right.key ? -1 : 1;
	}

	private swap(left: number, right: number): void {
		const leftNode = this.nodes[left];
		const rightNode = this.nodes[right];
		if (!leftNode || !rightNode) return;
		this.nodes[left] = rightNode;
		this.nodes[right] = leftNode;
		this.positions.set(rightNode.key, left);
		this.positions.set(leftNode.key, right);
	}

	private bubbleUp(start: number): boolean {
		let position = start;
		let moved = false;
		while (position > 0) {
			const parent = Math.floor((position - 1) / 2);
			const node = this.nodes[position];
			const parentNode = this.nodes[parent];
			if (!node || !parentNode || this.compare(node, parentNode) >= 0) break;
			this.swap(position, parent);
			position = parent;
			moved = true;
		}
		return moved;
	}

	private bubbleDown(start: number): void {
		let position = start;
		while (true) {
			const left = position * 2 + 1;
			const right = left + 1;
			let smallest = position;

			const leftNode = this.nodes[left];
			const smallestNode = this.nodes[smallest];
			if (
				leftNode &&
				smallestNode &&
				this.compare(leftNode, smallestNode) < 0
			) {
				smallest = left;
			}

			const rightNode = this.nodes[right];
			const currentSmallestNode = this.nodes[smallest];
			if (
				rightNode &&
				currentSmallestNode &&
				this.compare(rightNode, currentSmallestNode) < 0
			) {
				smallest = right;
			}

			if (smallest === position) return;
			this.swap(position, smallest);
			position = smallest;
		}
	}

	private removeAt(position: number): DeadlineNode | null {
		const removed = this.nodes[position];
		if (!removed) return null;

		const replacement = this.nodes.pop();
		this.positions.delete(removed.key);
		if (!replacement || position === this.nodes.length) return removed;

		this.nodes[position] = replacement;
		this.positions.set(replacement.key, position);
		if (!this.bubbleUp(position)) this.bubbleDown(position);
		return removed;
	}
}

export interface DegradedOwnerOverlayOptions {
	readonly maxEntries?: number;
	readonly evidenceWindowMs?: number;
	readonly holdDownMs?: number;
	readonly now?: () => number;
}

export interface DegradedOwnerDirectiveInput {
	readonly laneKey: string | null;
	readonly cohortKey: AnthropicDegradedCohortKey | null;
	readonly state: AnthropicDegradedProtectionState;
	readonly requestKind: "small" | "large";
	readonly owner: AffinityOwnerSnapshot | null;
	readonly enforced: boolean;
	/** Present for a coordinator `recovering` snapshot. */
	readonly recoveringUntil?: number;
}

export interface DegradedOwnerEvidenceInput {
	readonly laneKey: string | null;
	readonly cohortKey: AnthropicDegradedCohortKey | null;
	readonly owner: AffinityOwnerSnapshot | null;
}

/**
 * Bounded, server-owned bridge between proxy degraded-cohort state and generic
 * load-balancer ownership directives. It never stores caller session values in
 * logs and has no module-global state.
 */
export class DegradedOwnerOverlay {
	private readonly entries = new Map<string, OverlayEntry>();
	private readonly cohortEntries = new Map<
		AnthropicDegradedCohortKey,
		Set<string>
	>();
	private readonly expiryIndex = new KeyedDeadlineIndex();
	private readonly evidenceIndex = new KeyedDeadlineIndex();
	private readonly maxEntries: number;
	private readonly evidenceWindowMs: number;
	private readonly holdDownMs: number;
	private readonly nowSource: () => number;
	private dropped = 0;
	private nextInsertionOrder = 0;

	constructor(options: DegradedOwnerOverlayOptions = {}) {
		this.maxEntries = Math.max(
			0,
			Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
		);
		this.evidenceWindowMs = Math.max(
			1,
			Math.floor(options.evidenceWindowMs ?? DEFAULT_EVIDENCE_WINDOW_MS),
		);
		this.holdDownMs = Math.max(
			0,
			Math.floor(options.holdDownMs ?? getSessionAffinityAntiThrashWindowMs()),
		);
		this.nowSource = options.now ?? Date.now;
	}

	get size(): number {
		this.removeAllExpired(this.now());
		return this.entries.size;
	}

	get droppedEntries(): number {
		return this.dropped;
	}

	clear(): void {
		this.entries.clear();
		this.cohortEntries.clear();
		this.expiryIndex.clear();
		this.evidenceIndex.clear();
		this.dropped = 0;
		this.nextInsertionOrder = 0;
	}

	/**
	 * Read a retained owner without refreshing, promoting, pruning, or otherwise
	 * mutating overlay state. Expired entries are treated as absent.
	 */
	peekRetainedOwner(
		laneKey: string | null,
		cohortKey: AnthropicDegradedCohortKey | null,
	): AffinityOwnerSnapshot | null {
		if (!laneKey || !cohortKey) return null;
		const entry = this.entries.get(this.key(laneKey, cohortKey));
		if (!entry || entry.expiresAt <= this.now()) return null;
		return { ...entry.owner };
	}

	private now(): number {
		const value = this.nowSource();
		return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
	}

	private key(laneKey: string, cohortKey: AnthropicDegradedCohortKey): string {
		return JSON.stringify([laneKey, cohortKey]);
	}

	private removeEntry(key: string): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.entries.delete(key);
		this.expiryIndex.remove(key);
		this.evidenceIndex.remove(key);

		const cohort = this.cohortEntries.get(entry.cohortKey);
		if (cohort) {
			cohort.delete(key);
			if (cohort.size === 0) this.cohortEntries.delete(entry.cohortKey);
		}
		return true;
	}

	private getLiveEntry(key: string, now: number): OverlayEntry | undefined {
		const entry = this.entries.get(key);
		if (!entry || entry.expiresAt > now) return entry;
		this.removeEntry(key);
		return undefined;
	}

	private indexEntry(key: string, entry: OverlayEntry): void {
		if (Number.isFinite(entry.expiresAt)) {
			this.expiryIndex.upsert(key, entry.expiresAt, entry.insertionOrder);
		} else {
			this.expiryIndex.remove(key);
		}

		if (entry.stage === "evidence") {
			this.evidenceIndex.upsert(key, entry.touchedAt, entry.insertionOrder);
		} else {
			this.evidenceIndex.remove(key);
		}
	}

	private performMaintenance(
		now: number,
		budget = DEFAULT_MAINTENANCE_BUDGET,
	): void {
		for (let processed = 0; processed < budget; processed += 1) {
			const deadline = this.expiryIndex.peek();
			if (!deadline || deadline.priority > now) return;
			this.removeEntry(deadline.key);
		}
	}

	private removeAllExpired(now: number): void {
		while (true) {
			const deadline = this.expiryIndex.peek();
			if (!deadline || deadline.priority > now) return;
			this.removeEntry(deadline.key);
		}
	}

	private reserveSlot(now: number): boolean {
		this.performMaintenance(now);
		if (this.entries.size < this.maxEntries) return true;

		const oldestEvidence = this.evidenceIndex.peek();
		if (oldestEvidence) {
			this.removeEntry(oldestEvidence.key);
			return true;
		}

		this.dropped = Math.min(SATURATING_COUNTER_MAX, this.dropped + 1);
		return false;
	}

	private install(
		laneKey: string,
		cohortKey: AnthropicDegradedCohortKey,
		owner: AffinityOwnerSnapshot,
		stage: OverlayStage,
		expiresAt: number,
		now: number,
	): OverlayEntry | null {
		const key = this.key(laneKey, cohortKey);
		const existing = this.getLiveEntry(key, now);
		if (existing) return existing;
		if (!this.reserveSlot(now)) return null;
		const entry: OverlayEntry = {
			laneKey,
			cohortKey,
			owner: { ...owner },
			insertionOrder: this.nextInsertionOrder,
			stage,
			expiresAt,
			touchedAt: now,
		};
		this.nextInsertionOrder = Math.min(
			SATURATING_COUNTER_MAX,
			this.nextInsertionOrder + 1,
		);
		this.entries.set(key, entry);
		let cohort = this.cohortEntries.get(cohortKey);
		if (!cohort) {
			cohort = new Set<string>();
			this.cohortEntries.set(cohortKey, cohort);
		}
		cohort.add(key);
		this.indexEntry(key, entry);
		return entry;
	}

	/**
	 * Retain the first owner captured by a qualifying large overload. If a
	 * second account later establishes quorum, this pre-selection snapshot is
	 * still authoritative even if ordinary fallback selection ran meanwhile.
	 */
	retainQualifyingOwner(input: DegradedOwnerEvidenceInput): boolean {
		if (!input.laneKey || !input.cohortKey || !input.owner) return false;
		const now = this.now();
		const key = this.key(input.laneKey, input.cohortKey);
		const existing = this.getLiveEntry(key, now);
		this.performMaintenance(now);
		if (existing) {
			existing.touchedAt = now;
			if (existing.stage === "evidence") {
				existing.expiresAt = now + this.evidenceWindowMs;
			}
			this.indexEntry(key, existing);
			return true;
		}
		return (
			this.install(
				input.laneKey,
				input.cohortKey,
				input.owner,
				"evidence",
				now + this.evidenceWindowMs,
				now,
			) !== null
		);
	}

	/**
	 * Return one request-local directive without exposing cohort state to the
	 * load-balancer package.
	 */
	materializeDirective(
		input: DegradedOwnerDirectiveInput,
	): AffinityOwnerDirective | null {
		if (!input.enforced || !input.laneKey || !input.cohortKey) return null;
		const now = this.now();
		const key = this.key(input.laneKey, input.cohortKey);
		let entry = this.getLiveEntry(key, now);
		this.performMaintenance(now);
		const protectedState =
			input.state === "open" ||
			input.state === "probing" ||
			input.state === "recovering";

		if (!protectedState) {
			if (entry?.stage === "hold-down" && entry.expiresAt > now) {
				entry.touchedAt = now;
				return { kind: "retain-owner", owner: entry.owner };
			}
			if (entry) this.removeEntry(key);
			return null;
		}

		if (!entry && input.owner) {
			const installed = this.install(
				input.laneKey,
				input.cohortKey,
				input.owner,
				"protected",
				Number.POSITIVE_INFINITY,
				now,
			);
			if (installed === null) {
				return {
					kind: "retain-owner",
					owner: { ...input.owner },
				};
			}
			entry = installed;
		}

		if (entry) {
			entry.touchedAt = now;
			if (input.state === "recovering" && input.recoveringUntil !== undefined) {
				entry.stage = "hold-down";
				entry.expiresAt =
					Math.max(now, Math.floor(input.recoveringUntil)) + this.holdDownMs;
			} else {
				entry.stage = "protected";
				entry.expiresAt = Number.POSITIVE_INFINITY;
			}
			this.indexEntry(key, entry);
			return { kind: "retain-owner", owner: entry.owner };
		}

		return input.requestKind === "large"
			? { kind: "defer-owner-assignment" }
			: null;
	}

	/** Start post-recovery retention for every lane in one cohort. */
	retainAfterRecovery(
		cohortKey: AnthropicDegradedCohortKey,
		recoveringUntil: number,
	): void {
		const now = this.now();
		const expiresAt =
			Math.max(now, Math.floor(recoveringUntil)) + this.holdDownMs;
		const cohort = this.cohortEntries.get(cohortKey);
		if (!cohort) {
			this.performMaintenance(now);
			return;
		}
		for (const key of cohort) {
			const entry = this.getLiveEntry(key, now);
			if (!entry) continue;
			entry.stage = "hold-down";
			entry.expiresAt = expiresAt;
			entry.touchedAt = now;
			this.indexEntry(key, entry);
		}
		this.performMaintenance(now);
	}

	/** Remove one stale or non-overload-invalid owner without touching siblings. */
	invalidateOwner(
		laneKey: string,
		cohortKey: AnthropicDegradedCohortKey,
	): boolean {
		return this.removeEntry(this.key(laneKey, cohortKey));
	}
}
