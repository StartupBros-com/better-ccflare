import { describe, expect, it } from "bun:test";
import {
	createUsagePollingTrackingClearer,
	isCurrentUsagePollingAccount,
	UsagePollingLifecycle,
	unregisterServerLifecycleCallbacks,
} from "./usage-polling-lifecycle";

type Timer = { callback: () => void; cancelled: boolean };

function makeTimers() {
	const timers: Timer[] = [];
	return {
		timers,
		schedule(callback: () => void): Timer {
			const timer = { callback, cancelled: false };
			timers.push(timer);
			return timer;
		},
		cancel(timer: Timer) {
			timer.cancelled = true;
		},
	};
}

describe("UsagePollingLifecycle", () => {
	it("cancels both pending retry and staggered-start timers when an account is retired", () => {
		const clock = makeTimers();
		const lifecycle = new UsagePollingLifecycle<Timer>({
			schedule: (callback) => clock.schedule(callback),
			cancel: (timer) => clock.cancel(timer),
		});
		const lease = lifecycle.replace("account-1", 10);
		lifecycle.scheduleStagger(lease, 5_000, () => {});
		lifecycle.scheduleRetry(lease, 5_000, () => {});

		lifecycle.retire("account-1");

		expect(clock.timers).toHaveLength(2);
		expect(clock.timers.every((timer) => timer.cancelled)).toBe(true);
		expect(lifecycle.isCurrent(lease)).toBe(false);
	});

	it("cancels zero-valued timers when replacing and retiring a lease", () => {
		const cancelled: number[] = [];
		const lifecycle = new UsagePollingLifecycle<number>({
			schedule: () => 0,
			cancel: (timer) => cancelled.push(timer),
		});
		const lease = lifecycle.replace("account-1", 10);
		lifecycle.scheduleRetry(lease, 5_000, () => {});
		lifecycle.scheduleRetry(lease, 5_000, () => {});

		expect(cancelled).toEqual([0]);
		expect(lifecycle.retireLease(lease)).toBe(true);
		expect(cancelled).toEqual([0, 0]);
	});

	it("does not let an old retry callback delete or replace a newer generation", () => {
		const clock = makeTimers();
		const lifecycle = new UsagePollingLifecycle<Timer>({
			schedule: (callback) => clock.schedule(callback),
			cancel: (timer) => clock.cancel(timer),
		});
		const oldLease = lifecycle.replace("account-1", 10);
		lifecycle.scheduleRetry(oldLease, 5_000, () => {
			throw new Error("stale callback ran");
		});
		const oldTimer = clock.timers[0];
		const freshLease = lifecycle.replace("account-1", 20);
		let freshRan = false;
		lifecycle.scheduleRetry(freshLease, 5_000, () => {
			freshRan = true;
		});

		oldTimer.callback();
		expect(lifecycle.isCurrent(freshLease)).toBe(true);
		clock.timers[1].callback();
		expect(freshRan).toBe(true);
	});

	it("retires only the exact current lease after a same-ID replacement", () => {
		const clock = makeTimers();
		const lifecycle = new UsagePollingLifecycle<Timer>({
			schedule: (callback) => clock.schedule(callback),
			cancel: (timer) => clock.cancel(timer),
		});
		const oldLease = lifecycle.replace("account-1", 10);
		lifecycle.scheduleRetry(oldLease, 5_000, () => {});
		const freshLease = lifecycle.replace("account-1", 20);
		lifecycle.scheduleStagger(freshLease, 5_000, () => {});

		expect(lifecycle.retireLease(oldLease)).toBe(false);
		expect(lifecycle.isCurrent(freshLease)).toBe(true);
		expect(clock.timers[1].cancelled).toBe(false);
		expect(lifecycle.retireLease(freshLease)).toBe(true);
		expect(clock.timers[1].cancelled).toBe(true);
	});

	it("gates polling on the current row rather than a deleted or same-ID replacement", async () => {
		const lease = { accountId: "account-1", generation: 1, createdAt: 10 };
		expect(
			await isCurrentUsagePollingAccount(lease, async () => undefined),
		).toBe(false);
		expect(
			await isCurrentUsagePollingAccount(lease, async () => ({
				created_at: 20,
			})),
		).toBe(false);
		expect(
			await isCurrentUsagePollingAccount(lease, async () => ({
				created_at: 10,
			})),
		).toBe(true);
	});

	it("binds account-removal cleanup to the registered scheduler and lifecycle owners", () => {
		const clock = makeTimers();
		const activeLifecycle = new UsagePollingLifecycle<Timer>({
			schedule: (callback) => clock.schedule(callback),
			cancel: (timer) => clock.cancel(timer),
		});
		const replacementLifecycle = new UsagePollingLifecycle<Timer>({
			schedule: (callback) => clock.schedule(callback),
			cancel: (timer) => clock.cancel(timer),
		});
		const activeLease = activeLifecycle.replace("account-1", 10);
		const replacementLease = replacementLifecycle.replace("account-1", 20);
		activeLifecycle.scheduleRetry(activeLease, 5_000, () => {});
		replacementLifecycle.scheduleRetry(replacementLease, 5_000, () => {});
		const activeCleared: string[] = [];
		const replacementCleared: string[] = [];
		const clearer = createUsagePollingTrackingClearer(activeLifecycle, {
			clearAccountTracking(accountId) {
				activeCleared.push(accountId);
			},
		});
		const replacementScheduler = {
			clearAccountTracking(accountId: string) {
				replacementCleared.push(accountId);
			},
		};
		void replacementScheduler;

		clearer("account-1");

		expect(activeLifecycle.isCurrent(activeLease)).toBe(false);
		expect(replacementLifecycle.isCurrent(replacementLease)).toBe(true);
		expect(clock.timers[0].cancelled).toBe(true);
		expect(clock.timers[1].cancelled).toBe(false);
		expect(activeCleared).toEqual(["account-1"]);
		expect(replacementCleared).toEqual([]);
	});

	it("unregisters every server-keyed lifecycle callback before owner shutdown", () => {
		const calls: string[] = [];
		unregisterServerLifecycleCallbacks("server-8080", {
			unregisterCodexUsageRefresher(serverId) {
				calls.push(`codex:${serverId}`);
			},
			unregisterPollingRestarter(serverId) {
				calls.push(`polling:${serverId}`);
			},
			unregisterRefreshClearer(serverId) {
				calls.push(`refresh:${serverId}`);
			},
			unregisterAutoRefreshTrackingClearer(serverId) {
				calls.push(`tracking:${serverId}`);
			},
		});

		expect(calls).toEqual([
			"codex:server-8080",
			"polling:server-8080",
			"refresh:server-8080",
			"tracking:server-8080",
		]);
	});
});
