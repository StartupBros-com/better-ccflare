import { minimumRoutableTier } from "@better-ccflare/core";
import type {
	Account,
	RequestMeta,
	RoutingCandidateMetadata,
} from "@better-ccflare/types";

const DEFAULT_MAX_ENTRIES = 10_000;

const PRESSURE_RANK = {
	cold: 0,
	steady: 1,
	warm: 2,
	hot: 3,
	urgent: 4,
	critical: 5,
} as const;

interface CandidatePair {
	account: Account;
	routing: RoutingCandidateMetadata;
}

function compareRoutingClass(
	owner: CandidatePair,
	best: CandidatePair,
	meta: RequestMeta,
): number {
	if (owner.routing.tier !== best.routing.tier) {
		return owner.routing.tier - best.routing.tier;
	}
	const ownerPressure =
		owner.routing.quotaPressure ??
		meta.quotaPressureByAccountId?.get(owner.account.id);
	const bestPressure =
		best.routing.quotaPressure ??
		meta.quotaPressureByAccountId?.get(best.account.id);
	if (
		!ownerPressure ||
		!bestPressure ||
		ownerPressure.comparisonKey === null ||
		bestPressure.comparisonKey === null ||
		ownerPressure.comparisonKey !== bestPressure.comparisonKey
	) {
		return 0;
	}
	return PRESSURE_RANK[bestPressure.band] - PRESSURE_RANK[ownerPressure.band];
}

function alignCurrentCandidates(
	accounts: Account[],
	meta: RequestMeta,
): RoutingCandidateMetadata[] {
	const explicit = meta.routingCandidates;
	if (
		explicit?.length === accounts.length &&
		explicit.every(
			(candidate, index) => candidate.accountId === accounts[index]?.id,
		)
	) {
		return [...explicit];
	}

	const catalog = meta.routingCandidateCatalog ?? [];
	const usedCandidateIds = new Set<string>();
	const duplicateCounts = new Map<string, number>();
	return accounts.map((account, ordinal) => {
		const configured = catalog.find(
			(candidate) =>
				candidate.accountId === account.id &&
				!usedCandidateIds.has(candidate.candidateId),
		);
		if (configured) {
			usedCandidateIds.add(configured.candidateId);
			return configured;
		}
		const occurrence = duplicateCounts.get(account.id) ?? 0;
		duplicateCounts.set(account.id, occurrence + 1);
		return {
			candidateId:
				occurrence === 0
					? `account:${account.id}`
					: `account:${account.id}#${occurrence}`,
			accountId: account.id,
			tier: account.priority,
			ordinal,
			comboSlotId: null,
			modelOverride: null,
			quotaPressure: null,
		};
	});
}

/**
 * Applies xAI request-scoped cache ownership without changing ineligible
 * provider positions. Missing owners remain mapped only for legal snapback
 * from a strictly better configured tier.
 */
export class CacheAffinityOrderer {
	private readonly affinity = new Map<
		string,
		{ candidateId: string; assignedAt: number }
	>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries = DEFAULT_MAX_ENTRIES,
	) {}

	order(accounts: Account[], meta: RequestMeta): Account[] {
		const key = meta.cacheAffinityKey;
		const eligibleIds = meta.xaiCacheEligibleAccountIds;
		if (
			!meta.xaiCacheNativeActive ||
			!key ||
			!eligibleIds ||
			eligibleIds.size === 0
		) {
			return accounts;
		}

		const currentCandidates = alignCurrentCandidates(accounts, meta);
		const pairs: CandidatePair[] = accounts.map((account, index) => ({
			account,
			routing: currentCandidates[index] as RoutingCandidateMetadata,
		}));
		meta.routingCandidates = currentCandidates;

		const now = Date.now();
		const existing = this.affinity.get(key);
		if (existing && now - existing.assignedAt >= this.ttlMs) {
			this.affinity.delete(key);
		}

		const eligible = pairs.filter((pair) => eligibleIds.has(pair.account.id));
		if (eligible.length === 0) return accounts;

		let mapping = this.affinity.get(key);
		if (!mapping) {
			const owner = eligible[0];
			if (!owner) return accounts;
			this.evictOldestIfFull();
			mapping = {
				candidateId: owner.routing.candidateId,
				assignedAt: now,
			};
			this.affinity.set(key, mapping);
		}

		const best = eligible[0];
		if (!best) return accounts;
		const owner = eligible.find(
			(pair) => pair.routing.candidateId === mapping.candidateId,
		);
		if (!owner) {
			const catalogOwner = meta.routingCandidateCatalog?.find(
				(candidate) => candidate.candidateId === mapping?.candidateId,
			);
			const bestTier =
				minimumRoutableTier(eligible.map((pair) => pair.routing.tier)) ??
				best.routing.tier;
			if (catalogOwner && catalogOwner.tier < bestTier) {
				// Legal snapback: only a configured strictly-better owner survives a
				// transient absence. Refresh while the conversation remains active.
				mapping.assignedAt = now;
				return accounts;
			}

			// Equal/worse (or removed) unavailable owners are stale ownership, not
			// cache affinity. The current authoritative candidate becomes owner.
			mapping.candidateId = best.routing.candidateId;
			mapping.assignedAt = now;
			return accounts;
		}

		const ownerVsBest = compareRoutingClass(owner, best, meta);
		if (ownerVsBest > 0) {
			// A routable better tier, or a comparable higher-pressure candidate
			// inside the same tier, replaces the old owner immediately.
			mapping.candidateId = best.routing.candidateId;
			mapping.assignedAt = now;
			return accounts;
		}
		mapping.assignedAt = now;

		const ownerIndex = eligible.indexOf(owner);
		const orderedEligible = [
			owner,
			...eligible.slice(0, ownerIndex),
			...eligible.slice(ownerIndex + 1),
		];
		let eligibleIndex = 0;
		const orderedPairs = pairs.map((pair) =>
			eligibleIds.has(pair.account.id)
				? (orderedEligible[eligibleIndex++] ?? pair)
				: pair,
		);
		meta.routingCandidates = orderedPairs.map((pair) => pair.routing);
		return orderedPairs.map((pair) => pair.account);
	}

	private evictOldestIfFull(): void {
		if (this.affinity.size < this.maxEntries) return;
		let oldestKey: string | undefined;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.affinity) {
			if (entry.assignedAt < oldestAt) {
				oldestKey = key;
				oldestAt = entry.assignedAt;
			}
		}
		if (oldestKey) this.affinity.delete(oldestKey);
	}
}
