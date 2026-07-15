import type { Account, RequestMeta } from "@better-ccflare/types";

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Applies request-scoped cache ownership without changing the base strategy's
 * ordering of ineligible accounts. Missing owners remain mapped for snap-back.
 */
export class CacheAffinityOrderer {
	private readonly affinity = new Map<
		string,
		{ accountId: string; assignedAt: number }
	>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries = DEFAULT_MAX_ENTRIES,
	) {}

	order(accounts: Account[], meta: RequestMeta): Account[] {
		const key = meta.cacheAffinityKey;
		const eligibleIds = meta.xaiCacheEligibleAccountIds;
		if (!key || !eligibleIds || eligibleIds.size === 0) return accounts;

		const now = Date.now();
		const existing = this.affinity.get(key);
		if (existing && now - existing.assignedAt >= this.ttlMs) {
			this.affinity.delete(key);
		}

		const eligible = accounts.filter((account) => eligibleIds.has(account.id));
		if (eligible.length === 0) return accounts;

		let mapping = this.affinity.get(key);
		if (!mapping) {
			const owner = eligible[0];
			if (!owner) return accounts;
			this.evictOldestIfFull();
			mapping = { accountId: owner.id, assignedAt: now };
			this.affinity.set(key, mapping);
		}

		const owner = eligible.find((account) => account.id === mapping.accountId);
		if (!owner) return accounts;
		mapping.assignedAt = now;

		const ownerIndex = eligible.indexOf(owner);
		const orderedEligible = [
			owner,
			...eligible.slice(0, ownerIndex),
			...eligible.slice(ownerIndex + 1),
		];
		let eligibleIndex = 0;
		return accounts.map((account) =>
			eligibleIds.has(account.id)
				? (orderedEligible[eligibleIndex++] ?? account)
				: account,
		);
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
