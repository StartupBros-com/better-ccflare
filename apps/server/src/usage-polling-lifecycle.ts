export type UsagePollingLease = {
	accountId: string;
	generation: number;
	createdAt: number;
};

type LeaseState<Timer> = {
	lease: UsagePollingLease;
	retryTimer: Timer | null;
	staggerTimer: Timer | null;
};

export interface UsagePollingLifecycleOptions<Timer> {
	schedule(callback: () => void, delayMs: number): Timer;
	cancel(timer: Timer): void;
}

export interface ServerLifecycleUnregistrars {
	unregisterCodexUsageRefresher(serverId: string): void;
	unregisterPollingRestarter(serverId: string): void;
	unregisterRefreshClearer(serverId: string): void;
	unregisterAutoRefreshTrackingClearer(serverId: string): void;
}

/** Unregister every server-keyed callback before stopping its local owners. */
export function unregisterServerLifecycleCallbacks(
	serverId: string,
	unregistrars: ServerLifecycleUnregistrars,
): void {
	unregistrars.unregisterCodexUsageRefresher(serverId);
	unregistrars.unregisterPollingRestarter(serverId);
	unregistrars.unregisterRefreshClearer(serverId);
	unregistrars.unregisterAutoRefreshTrackingClearer(serverId);
}

/**
 * Owns the timers for refresh-backed usage polling. Every replacement receives a
 * new lease, so a late callback can only retire its own state, never a newer
 * registration for the same account id.
 */
export class UsagePollingLifecycle<Timer> {
	private nextGeneration = 0;
	private states = new Map<string, LeaseState<Timer>>();

	constructor(private readonly timers: UsagePollingLifecycleOptions<Timer>) {}

	replace(accountId: string, createdAt: number): UsagePollingLease {
		const previous = this.states.get(accountId);
		if (previous) this.retireLease(previous.lease);
		const lease = {
			accountId,
			generation: ++this.nextGeneration,
			createdAt,
		};
		this.states.set(accountId, {
			lease,
			retryTimer: null,
			staggerTimer: null,
		});
		return lease;
	}

	/**
	 * Retire only when this exact lease still owns the account. State is removed
	 * before timers are cancelled so a synchronously-observable cancellation
	 * cannot find or replace it.
	 */
	retireLease(lease: UsagePollingLease): boolean {
		const state = this.states.get(lease.accountId);
		if (state?.lease !== lease) return false;
		this.states.delete(lease.accountId);
		if (state.retryTimer !== null) this.timers.cancel(state.retryTimer);
		if (state.staggerTimer !== null) this.timers.cancel(state.staggerTimer);
		return true;
	}

	retire(accountId: string): void {
		const lease = this.states.get(accountId)?.lease;
		if (lease) this.retireLease(lease);
	}

	retireAll(): void {
		for (const state of [...this.states.values()])
			this.retireLease(state.lease);
	}

	isCurrent(lease: UsagePollingLease): boolean {
		return this.states.get(lease.accountId)?.lease === lease;
	}

	scheduleRetry(
		lease: UsagePollingLease,
		delayMs: number,
		callback: () => void,
	): void {
		this.schedule(lease, "retryTimer", delayMs, callback);
	}

	scheduleStagger(
		lease: UsagePollingLease,
		delayMs: number,
		callback: () => void,
	): void {
		this.schedule(lease, "staggerTimer", delayMs, callback);
	}

	private schedule(
		lease: UsagePollingLease,
		kind: "retryTimer" | "staggerTimer",
		delayMs: number,
		callback: () => void,
	): void {
		const state = this.states.get(lease.accountId);
		if (!this.isCurrent(lease) || !state) return;
		const previous = state[kind];
		if (previous !== null) this.timers.cancel(previous);
		let timer: Timer;
		timer = this.timers.schedule(() => {
			const current = this.states.get(lease.accountId);
			if (current?.lease !== lease || current[kind] !== timer) return;
			current[kind] = null;
			callback();
		}, delayMs);
		state[kind] = timer;
	}
}

/** Check that an asynchronous poll still belongs to the same durable account row. */
export async function isCurrentUsagePollingAccount(
	lease: UsagePollingLease,
	getAccount: (
		accountId: string,
	) => Promise<{ created_at: number | null } | null | undefined>,
): Promise<boolean> {
	const current = await getAccount(lease.accountId);
	return current?.created_at === lease.createdAt;
}

/** Bind deletion cleanup to this server's concrete polling and scheduler owners. */
export function createUsagePollingTrackingClearer<Timer>(
	lifecycle: UsagePollingLifecycle<Timer>,
	scheduler: { clearAccountTracking(accountId: string): void },
): (accountId: string) => void {
	return (accountId) => {
		lifecycle.retire(accountId);
		scheduler.clearAccountTracking(accountId);
	};
}
