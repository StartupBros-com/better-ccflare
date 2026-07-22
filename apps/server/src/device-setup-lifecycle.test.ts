import { describe, expect, it, mock } from "bun:test";

// Server unit tests exercise exported pure lifecycle helpers without booting a
// database. The production database barrel imports generated worker modules,
// which intentionally do not exist until the build step runs.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class {},
	DatabaseFactory: {},
	initPayloadEncryption: async () => {},
}));

class MockHttpApiService {}

mock.module("@better-ccflare/http-api", () => ({
	AlertService: MockHttpApiService,
	APIRouter: MockHttpApiService,
	AuthService: MockHttpApiService,
	createServerDeviceSetupCoordinator: () => ({
		tick: async () => {},
		dispose: () => {},
		drain: async () => {},
	}),
}));
mock.module("@better-ccflare/openai-responses-adapter", () => ({
	handleResponsesRequest: async () => new Response(),
}));
mock.module("@better-ccflare/providers", () => ({
	CODEX_DEFAULT_ENDPOINT: "https://example.invalid",
	fetchCodexUsageOnDemand: async () => null,
	getOAuthProvider: () => ({ getOAuthConfig: () => ({ clientId: "test" }) }),
	getProvider: () => null,
	getRepresentativeUtilizationForProvider: () => null,
	usageCache: { clear: () => {} },
}));
mock.module("@better-ccflare/providers/bedrock", () => ({
	canUseInferenceProfileDynamic: async () => false,
	parseBedrockConfig: () => null,
	translateModelName: (model: string) => model,
}));
mock.module("@better-ccflare/proxy", () => {
	class Scheduler {
		stop() {}
	}
	return {
		AutoRefreshScheduler: Scheduler,
		CacheAffinityOrderer: class {},
		CacheKeepaliveScheduler: Scheduler,
		clearAccountRefreshCache: () => {},
		drainUsageCollector: async () => {},
		getModelCatalog: () => null,
		getUsageCollectorHealth: () => null,
		getValidAccessToken: async () => null,
		handleProxy: async () => new Response(),
		initModelCatalogRefresh: () => () => {},
		initProxy: () => {},
		refreshModelCatalog: async () => ({ success: true }),
		registerCodexUsageRefresher: () => {},
		registerPollingRestarter: () => {},
		registerRefreshClearer: () => {},
		startGlobalTokenHealthChecks: () => {},
		startIntegrityScheduler: () => () => {},
		stopGlobalTokenHealthChecks: () => {},
		unregisterCodexUsageRefresher: () => {},
	};
});

const { DEVICE_SETUP_RECOVERY_INTERVAL_MS, startDeviceSetupRecoveryLifecycle } =
	await import("./server");

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("device setup recovery lifecycle", () => {
	it("runs one bounded startup tick before scheduling periodic recovery", async () => {
		let tickCount = 0;
		let scheduled: (() => void) | null = null;
		let scheduledInterval = 0;
		const startup = deferred();
		const lifecyclePromise = startDeviceSetupRecoveryLifecycle(
			{
				tick: async () => {
					tickCount += 1;
					await startup.promise;
				},
				dispose: () => {},
				drain: async () => {},
			},
			{
				schedule: (callback, intervalMs) => {
					scheduled = callback;
					scheduledInterval = intervalMs;
					return 1;
				},
				cancel: () => {},
			},
		);

		expect(tickCount).toBe(1);
		expect(scheduled).toBeNull();
		startup.resolve();
		await lifecyclePromise;
		expect(scheduled).not.toBeNull();
		expect(scheduledInterval).toBe(DEVICE_SETUP_RECOVERY_INTERVAL_MS);
	});

	it("prevents overlapping periodic ticks", async () => {
		let tickCount = 0;
		let scheduled: (() => void | Promise<void>) | null = null;
		const periodic = deferred();
		const stop = await startDeviceSetupRecoveryLifecycle(
			{
				tick: async () => {
					tickCount += 1;
					if (tickCount === 2) await periodic.promise;
				},
				dispose: () => {},
				drain: async () => {},
			},
			{
				schedule: (callback) => {
					scheduled = callback;
					return 1;
				},
				cancel: () => {},
			},
		);

		if (!scheduled) throw new Error("recovery callback was not scheduled");
		const firstPeriodicTick = scheduled();
		await Promise.resolve();
		const coalescedTick = scheduled();
		await Promise.resolve();
		expect(tickCount).toBe(2);

		periodic.resolve();
		await firstPeriodicTick;
		await coalescedTick;
		await scheduled();
		expect(tickCount).toBe(3);
		await stop();
	});

	it("awaits an in-flight recovery tick before shutdown may close shared resources", async () => {
		let scheduled: (() => void | Promise<void>) | null = null;
		let tickCount = 0;
		let disposed = false;
		let drained = false;
		let databaseClosed = false;
		const periodic = deferred();
		const stop = await startDeviceSetupRecoveryLifecycle(
			{
				tick: async () => {
					tickCount += 1;
					if (tickCount === 2) await periodic.promise;
				},
				dispose: () => {
					disposed = true;
				},
				drain: async () => {
					drained = true;
				},
			},
			{
				schedule: (callback) => {
					scheduled = callback;
					return 1;
				},
				cancel: () => {},
			},
		);

		if (!scheduled) throw new Error("recovery callback was not scheduled");
		const inFlightTick = scheduled();
		await Promise.resolve();
		const shutdown = stop().then(() => {
			databaseClosed = true;
		});
		await Promise.resolve();

		expect(disposed).toBe(true);
		expect(drained).toBe(false);
		expect(databaseClosed).toBe(false);

		periodic.resolve();
		await inFlightTick;
		await shutdown;
		expect(drained).toBe(true);
		expect(databaseClosed).toBe(true);

		await scheduled();
		expect(tickCount).toBe(2);
	});

	it("stops scheduling and disposes exactly once without restarting provider authorization", async () => {
		let tickCount = 0;
		let initQwenCount = 0;
		let initCodexCount = 0;
		let disposeCount = 0;
		let cancelCount = 0;
		let scheduled: (() => void) | null = null;
		const coordinator = {
			tick: async () => {
				tickCount += 1;
			},
			dispose: () => {
				disposeCount += 1;
			},
			drain: async () => {},
			initQwen: async () => {
				initQwenCount += 1;
			},
			initCodex: async () => {
				initCodexCount += 1;
			},
		};
		const stop = await startDeviceSetupRecoveryLifecycle(coordinator, {
			schedule: (callback) => {
				scheduled = callback;
				return 1;
			},
			cancel: () => {
				cancelCount += 1;
			},
		});

		expect(tickCount).toBe(1);
		expect(initQwenCount).toBe(0);
		expect(initCodexCount).toBe(0);
		await Promise.all([stop(), stop()]);
		expect(disposeCount).toBe(1);
		expect(cancelCount).toBe(1);

		if (!scheduled) throw new Error("recovery callback was not scheduled");
		scheduled();
		await Promise.resolve();
		expect(tickCount).toBe(1);
	});

	it("contains tick failures and keeps the periodic recovery trigger alive", async () => {
		let tickCount = 0;
		let scheduled: (() => void) | null = null;
		const errors: unknown[] = [];
		const stop = await startDeviceSetupRecoveryLifecycle(
			{
				tick: async () => {
					tickCount += 1;
					if (tickCount === 1) throw new Error("startup recovery failed");
				},
				dispose: () => {},
				drain: async () => {},
			},
			{
				schedule: (callback) => {
					scheduled = callback;
					return 1;
				},
				cancel: () => {},
				onError: (error) => errors.push(error),
			},
		);

		expect(errors).toHaveLength(1);
		if (!scheduled) throw new Error("recovery callback was not scheduled");
		scheduled();
		await Promise.resolve();
		expect(tickCount).toBe(2);
		await stop();
	});
});
