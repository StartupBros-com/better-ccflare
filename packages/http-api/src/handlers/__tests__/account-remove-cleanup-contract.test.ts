import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";

const removeAccountById = mock(async () => ({
	success: true,
	message: "removed",
}));
const stopPolling = spyOn(usageCache, "stopPolling").mockImplementation(
	() => {},
);
const deleteUsageCache = spyOn(usageCache, "delete").mockImplementation(
	() => {},
);
const clearAccountRefreshCache = mock(() => {});
const clearAutoRefreshTrackingForAccount = mock(() => {});
const clearPendingRotationForDeletedAccount = mock(() => {});

mock.module("@better-ccflare/cli-commands", () => ({ removeAccountById }));
mock.module("@better-ccflare/proxy", () => ({
	clearAccountRefreshCache,
	clearAutoRefreshTrackingForAccount,
	clearPendingRotationForDeletedAccount,
	getBindingConstraint: () => undefined,
	getUsageThrottleStatus: () => undefined,
	refreshCodexUsageForAccount: async () => ({ success: false }),
	restartUsagePollingForAccount: async () => false,
}));

const { createAccountReloadHandler, createAccountRemoveHandler } = await import(
	"../accounts"
);

function request(confirm: string): Request {
	return new Request("http://localhost/api/accounts/account-1", {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ confirm }),
	});
}

function dbOps(account: { name: string; provider?: string } | undefined) {
	return {
		getAdapter: () => ({
			get: mock(async () => account),
		}),
	};
}

afterEach(() => {
	removeAccountById.mockClear();
	stopPolling.mockClear();
	deleteUsageCache.mockClear();
	clearAccountRefreshCache.mockClear();
	clearAutoRefreshTrackingForAccount.mockClear();
	clearPendingRotationForDeletedAccount.mockClear();
});

describe("createAccountRemoveHandler cleanup contract", () => {
	it("cleans all account-local lifecycle owners only after an exact-ID deletion succeeds", async () => {
		const callOrder: string[] = [];
		removeAccountById.mockImplementationOnce(async () => {
			callOrder.push("remove");
			return { success: true, message: "removed" };
		});
		stopPolling.mockImplementationOnce(() => callOrder.push("stopPolling"));
		clearAccountRefreshCache.mockImplementationOnce(() =>
			callOrder.push("clearRefreshCache"),
		);
		clearAutoRefreshTrackingForAccount.mockImplementationOnce(() =>
			callOrder.push("clearAutoRefreshTracking"),
		);
		clearPendingRotationForDeletedAccount.mockImplementationOnce(() =>
			callOrder.push("clearPendingRotation"),
		);
		const handler = createAccountRemoveHandler(
			dbOps({ name: "same-name" }) as never,
		);

		const response = await handler(request("same-name"), "account-1");

		expect(callOrder).toEqual([
			"remove",
			"stopPolling",
			"clearRefreshCache",
			"clearAutoRefreshTracking",
			"clearPendingRotation",
		]);

		// The cleanup calls above must happen after the command confirms deletion.
		// This assertion stays adjacent to the result so failed deletions remain covered below.

		expect(response.ok).toBe(true);
		expect(removeAccountById).toHaveBeenCalledWith(
			expect.anything(),
			"account-1",
		);
		expect(stopPolling).toHaveBeenCalledTimes(1);
		expect(stopPolling).toHaveBeenCalledWith("account-1");
		expect(clearAccountRefreshCache).toHaveBeenCalledWith("account-1");
		expect(clearAutoRefreshTrackingForAccount).toHaveBeenCalledWith(
			"account-1",
		);
		expect(clearPendingRotationForDeletedAccount).toHaveBeenCalledWith(
			"account-1",
		);
	});

	it("reload clears request caches without stopping deletion-only lifecycle owners", async () => {
		const handler = createAccountReloadHandler(
			dbOps({ name: "same-name", provider: "anthropic" }) as never,
		);

		const response = await handler(
			new Request("http://localhost/api/accounts/account-1/reload", {
				method: "POST",
			}),
			"account-1",
		);

		expect(response.ok).toBe(true);
		expect(clearAccountRefreshCache).toHaveBeenCalledWith("account-1");
		expect(deleteUsageCache).toHaveBeenCalledWith("account-1");
		expect(stopPolling).not.toHaveBeenCalled();
		expect(clearAutoRefreshTrackingForAccount).not.toHaveBeenCalled();
		expect(clearPendingRotationForDeletedAccount).not.toHaveBeenCalled();
	});

	it("does not clean lifecycle owners when the row is missing, confirmation fails, or deletion fails", async () => {
		const missingHandler = createAccountRemoveHandler(
			dbOps(undefined) as never,
		);
		expect(
			(await missingHandler(request("same-name"), "account-1")).status,
		).toBe(404);

		const mismatchedHandler = createAccountRemoveHandler(
			dbOps({ name: "same-name" }) as never,
		);
		expect(
			(await mismatchedHandler(request("wrong"), "account-1")).status,
		).toBe(400);

		removeAccountById.mockResolvedValueOnce({
			success: false,
			message: "not found",
		});
		expect(
			(await mismatchedHandler(request("same-name"), "account-1")).status,
		).toBe(404);

		expect(stopPolling).not.toHaveBeenCalled();
		expect(clearAccountRefreshCache).not.toHaveBeenCalled();
		expect(clearAutoRefreshTrackingForAccount).not.toHaveBeenCalled();
		expect(clearPendingRotationForDeletedAccount).not.toHaveBeenCalled();
	});
});
