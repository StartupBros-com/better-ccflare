import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "../usage-fetcher";

const originalFetch = globalThis.fetch;
let nextAccountId = 0;
let activeAccountId: string | undefined;

function accountId(): string {
	activeAccountId = `usage-generation-test-${++nextAccountId}`;
	return activeAccountId;
}

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function codexResponse(utilization: number): Response {
	return new Response(
		JSON.stringify({
			plan_type: "plus",
			rate_limit: {
				primary_window: {
					used_percent: utilization,
					reset_at: 1_900_000_000,
					limit_window_seconds: 18000,
				},
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function nanogptResponse(percentUsed: number): Response {
	return new Response(
		JSON.stringify({
			active: true,
			limits: { daily: 100, monthly: 1000 },
			enforceDailyLimit: true,
			daily: {
				used: percentUsed,
				remaining: 1 - percentUsed,
				percentUsed,
				resetAt: 1_900_000_000_000,
			},
			monthly: {
				used: percentUsed,
				remaining: 1 - percentUsed,
				percentUsed,
				resetAt: 1_900_000_000_000,
			},
			state: "active",
			graceUntil: null,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function waitForMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	if (activeAccountId) {
		usageCache.stopPolling(activeAccountId);
		usageCache.delete(activeAccountId);
		activeAccountId = undefined;
	}
	globalThis.fetch = originalFetch;
});

describe.serial("UsageCache polling generations", () => {
	it.serial(
		"does not let a stale generation publish data or invoke its callback",
		async () => {
			const ACCOUNT_ID = accountId();
			const oldFetch = deferred<Response>();
			const newFetch = deferred<Response>();
			const snapshots: string[] = [];
			let fetchCount = 0;
			globalThis.fetch = (() => {
				fetchCount++;
				return fetchCount === 1 ? oldFetch.promise : newFetch.promise;
			}) as unknown as typeof fetch;

			usageCache.startPolling(
				ACCOUNT_ID,
				"old-token",
				"codex",
				60_000,
				undefined,
				undefined,
				undefined,
				() => snapshots.push("old"),
			);
			usageCache.stopPolling(ACCOUNT_ID);
			usageCache.startPolling(
				ACCOUNT_ID,
				"new-token",
				"codex",
				60_000,
				undefined,
				undefined,
				undefined,
				() => snapshots.push("new"),
			);

			oldFetch.resolve(codexResponse(10));
			await waitForMicrotasks();
			expect(usageCache.get(ACCOUNT_ID)).toBeNull();
			expect(snapshots).toEqual([]);

			newFetch.resolve(codexResponse(20));
			await waitForMicrotasks();
			expect(usageCache.get(ACCOUNT_ID)).toMatchObject({
				five_hour: { utilization: 20 },
			});
			expect(snapshots).toEqual(["new"]);
		},
	);

	it.serial(
		"does not let stale completion delete the replacement in-flight fetch",
		async () => {
			const ACCOUNT_ID = accountId();
			const oldFetch = deferred<Response>();
			const replacementFetch = deferred<Response>();
			let fetchCount = 0;
			globalThis.fetch = (() => {
				fetchCount++;
				return fetchCount === 1 ? oldFetch.promise : replacementFetch.promise;
			}) as unknown as typeof fetch;

			usageCache.startPolling(ACCOUNT_ID, "old-token", "codex", 60_000);
			usageCache.stopPolling(ACCOUNT_ID);
			usageCache.startPolling(ACCOUNT_ID, "new-token", "codex", 60_000);

			oldFetch.resolve(codexResponse(10));
			await waitForMicrotasks();
			const refresh = usageCache.refreshNow(ACCOUNT_ID);
			expect(fetchCount).toBe(2);

			replacementFetch.resolve(codexResponse(20));
			expect(await refresh).toBe(true);
		},
	);

	it.serial("ignores stale failure state and rescheduling", async () => {
		const ACCOUNT_ID = accountId();
		const oldFetch = deferred<Response>();
		const replacementFetch = deferred<Response>();
		let fetchCount = 0;
		globalThis.fetch = (() => {
			fetchCount++;
			return fetchCount === 1
				? oldFetch.promise
				: fetchCount === 2
					? replacementFetch.promise
					: Promise.resolve(codexResponse(30));
		}) as unknown as typeof fetch;

		usageCache.startPolling(ACCOUNT_ID, "old-token", "codex", 0);
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.startPolling(ACCOUNT_ID, "new-token", "codex", 60_000);

		oldFetch.resolve(new Response(null, { status: 500 }));
		await waitForMicrotasks();
		expect(fetchCount).toBe(2);

		replacementFetch.resolve(codexResponse(20));
		await waitForMicrotasks();
		expect(fetchCount).toBe(2);
	});

	it.serial(
		"makes refreshNow generation-safe when stop starts a replacement",
		async () => {
			const ACCOUNT_ID = accountId();
			const oldFetch = deferred<Response>();
			const replacementFetch = deferred<Response>();
			let fetchCount = 0;
			globalThis.fetch = (() => {
				fetchCount++;
				return fetchCount === 1 ? oldFetch.promise : replacementFetch.promise;
			}) as unknown as typeof fetch;

			usageCache.startPolling(ACCOUNT_ID, "old-token", "codex", 60_000);
			const refresh = usageCache.refreshNow(ACCOUNT_ID);
			usageCache.stopPolling(ACCOUNT_ID);
			usageCache.startPolling(ACCOUNT_ID, "new-token", "codex", 60_000);

			oldFetch.resolve(codexResponse(10));
			expect(await refresh).toBe(false);
			await waitForMicrotasks();
			expect(usageCache.get(ACCOUNT_ID)).toBeNull();

			replacementFetch.resolve(codexResponse(20));
		},
	);

	it.serial(
		"does not let a stale API-key generation publish data",
		async () => {
			const ACCOUNT_ID = accountId();
			const oldFetch = deferred<Response>();
			const newFetch = deferred<Response>();
			const snapshots: string[] = [];
			let fetchCount = 0;
			globalThis.fetch = (() => {
				fetchCount++;
				return fetchCount === 1 ? oldFetch.promise : newFetch.promise;
			}) as unknown as typeof fetch;

			usageCache.startPolling(
				ACCOUNT_ID,
				"old-key",
				"nanogpt",
				60_000,
				undefined,
				undefined,
				undefined,
				() => snapshots.push("old"),
			);
			usageCache.stopPolling(ACCOUNT_ID);
			usageCache.startPolling(
				ACCOUNT_ID,
				"new-key",
				"nanogpt",
				60_000,
				undefined,
				undefined,
				undefined,
				() => snapshots.push("new"),
			);

			oldFetch.resolve(nanogptResponse(0.1));
			await waitForMicrotasks();
			expect(usageCache.get(ACCOUNT_ID)).toBeNull();
			expect(snapshots).toEqual([]);

			newFetch.resolve(nanogptResponse(0.2));
			await waitForMicrotasks();
			expect(usageCache.get(ACCOUNT_ID)).toMatchObject({
				daily: { percentUsed: 0.2 },
			});
			expect(snapshots).toEqual(["new"]);
		},
	);

	it.serial("aborts the stopped registration's provider fetch", async () => {
		const ACCOUNT_ID = accountId();
		const pending = deferred<Response>();
		let observedSignal: AbortSignal | null = null;
		globalThis.fetch = ((_input, init) => {
			observedSignal = init?.signal ?? null;
			return pending.promise;
		}) as unknown as typeof fetch;

		usageCache.startPolling(ACCOUNT_ID, "token", "codex", 60_000);
		await waitForMicrotasks();
		usageCache.stopPolling(ACCOUNT_ID);

		expect(observedSignal?.aborted).toBe(true);
		pending.resolve(codexResponse(10));
	});
});
