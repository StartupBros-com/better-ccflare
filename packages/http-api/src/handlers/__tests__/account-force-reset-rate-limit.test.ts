import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";

// This focused unit test does not need DatabaseOperations' worker-backed runtime.
// Mock the package before loading the handler so a source checkout can run it
// without generating any inline worker artifacts.
mock.module("@better-ccflare/database", () => ({
	DatabaseOperations: class DatabaseOperations {},
	DatabaseFactory: class DatabaseFactory {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

mock.module("@better-ccflare/cli-commands", () => ({
	pauseAccount: mock(async () => ({ success: true })),
	removeAccount: mock(async () => ({ success: true })),
	resumeAccount: mock(async () => ({ success: true })),
}));

mock.module("@better-ccflare/proxy", () => ({
	clearAccountRefreshCache: mock(() => {}),
	getUsageThrottleStatus: mock(() => ({ throttled: false })),
	refreshCodexUsageForAccount: mock(async () => false),
	restartUsagePollingForAccount: mock(() => {}),
}));

const { usageCache } = await import("@better-ccflare/providers");
const { createAccountForceResetRateLimitHandler } = await import("../accounts");

function handledRejectedPromise<T>(error: Error): Promise<T> {
	const promise = Promise.reject<T>(error);
	void promise.catch(() => {});
	return promise;
}

function makeDbOps(reset: () => Promise<boolean>): DatabaseOperations {
	return {
		getAdapter: () => ({
			get: mock(async () => ({
				id: "account-id",
				name: "account-name",
				provider: "anthropic",
				access_token: "test-token",
			})),
		}),
		forceResetAccountRateLimit: mock(reset),
	} as unknown as DatabaseOperations;
}

describe("account force-reset rate-limit handler", () => {
	afterEach(() => {
		mock.restore();
	});

	it("awaits the persisted reset before refreshing usage or returning success", async () => {
		const events: string[] = [];
		let resolveReset: (value: boolean) => void = () => {};
		const resetPromise = new Promise<boolean>((resolve) => {
			resolveReset = resolve;
		});
		const dbOps = makeDbOps(() => resetPromise);
		const clearScopedDepletions = spyOn(
			usageCache,
			"clearReactiveScopedDepletions",
		).mockImplementation(() => {
			events.push("clear-scoped-depletions");
		});
		const refreshNow = spyOn(usageCache, "refreshNow").mockImplementation(
			async () => {
				events.push("refresh-usage");
				return true;
			},
		);
		const handler = createAccountForceResetRateLimitHandler(dbOps);

		let settled = false;
		const responsePromise = handler(
			new Request(
				"http://localhost/api/accounts/account-id/force-reset-rate-limit",
				{
					method: "POST",
				},
			),
			"account-id",
		).then((response) => {
			settled = true;
			return response;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(refreshNow).not.toHaveBeenCalled();
		expect(clearScopedDepletions).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(settled).toBe(false);

		resolveReset(true);
		const response = await responsePromise;
		expect(response.ok).toBe(true);
		expect(clearScopedDepletions).toHaveBeenCalledWith("account-id");
		expect(refreshNow).toHaveBeenCalledWith("account-id");
		expect(events).toEqual(["clear-scoped-depletions", "refresh-usage"]);
	});

	it("surfaces an asynchronous reset rejection without refreshing usage", async () => {
		spyOn(console, "error").mockImplementation(() => {});
		const dbOps = makeDbOps(() =>
			handledRejectedPromise(new Error("persisted reset failed")),
		);
		const refreshNow = spyOn(usageCache, "refreshNow").mockResolvedValue(true);
		const clearScopedDepletions = spyOn(
			usageCache,
			"clearReactiveScopedDepletions",
		);
		const handler = createAccountForceResetRateLimitHandler(dbOps);

		const response = await handler(
			new Request(
				"http://localhost/api/accounts/account-id/force-reset-rate-limit",
				{
					method: "POST",
				},
			),
			"account-id",
		);

		expect(response.ok).toBe(false);
		expect(await response.text()).toContain("persisted reset failed");
		expect(refreshNow).not.toHaveBeenCalled();
		expect(clearScopedDepletions).not.toHaveBeenCalled();
	});
});
