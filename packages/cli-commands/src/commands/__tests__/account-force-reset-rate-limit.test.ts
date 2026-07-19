import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";

// This focused unit test only needs the command's DatabaseOperations contract,
// not the worker-backed database runtime.
mock.module("@better-ccflare/database", () => ({
	DatabaseOperations: class DatabaseOperations {},
	DatabaseFactory: class DatabaseFactory {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { forceResetRateLimit } = await import("../account");

function handledRejectedPromise<T>(error: Error): Promise<T> {
	const promise = Promise.reject<T>(error);
	void promise.catch(() => {});
	return promise;
}

function makeConfig(): Config {
	return {
		getRuntime: () => ({ port: 8080 }),
	} as unknown as Config;
}

function makeDbOps(reset: () => Promise<boolean>): DatabaseOperations {
	return {
		getAdapter: () => ({
			get: mock(async () => ({ id: "account-id", name: "account-name" })),
		}),
		forceResetAccountRateLimit: mock(reset),
		// Make notification return before trying any localhost HTTP request.
		getActiveApiKeys: mock(async () => [{ id: "admin-key" }]),
	} as unknown as DatabaseOperations;
}

describe("forceResetRateLimit", () => {
	afterEach(() => {
		mock.restore();
	});

	it("awaits the persisted reset before reporting success", async () => {
		spyOn(console, "warn").mockImplementation(() => {});
		let resolveReset: (value: boolean) => void = () => {};
		const resetPromise = new Promise<boolean>((resolve) => {
			resolveReset = resolve;
		});
		const dbOps = makeDbOps(() => resetPromise);

		let settled = false;
		const resultPromise = forceResetRateLimit(
			dbOps,
			"account-name",
			makeConfig(),
		).then((result) => {
			settled = true;
			return result;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(dbOps.getActiveApiKeys).not.toHaveBeenCalled();

		resolveReset(true);
		const result = await resultPromise;
		expect(result.success).toBe(true);
		expect(dbOps.getActiveApiKeys).toHaveBeenCalledTimes(1);
	});

	it("surfaces an asynchronous reset rejection before server notification", async () => {
		spyOn(console, "warn").mockImplementation(() => {});
		const dbOps = makeDbOps(() =>
			handledRejectedPromise(new Error("persisted reset failed")),
		);

		await expect(
			forceResetRateLimit(dbOps, "account-name", makeConfig()),
		).rejects.toThrow("persisted reset failed");
		expect(dbOps.getActiveApiKeys).not.toHaveBeenCalled();
	});
});
