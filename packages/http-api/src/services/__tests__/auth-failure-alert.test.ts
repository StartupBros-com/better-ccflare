import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import {
	alertEvents,
	authFailureEvents,
	requestEvents,
} from "@better-ccflare/core";
import type { BunSqlAdapter as BunSqlAdapterType } from "@better-ccflare/database";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent, RequestResponse } from "@better-ccflare/types";
import { AlertService } from "../alerts";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for auth-failure alert processing");
}

function makeConfig(
	overrides: Partial<{
		requestTokens: number;
		tokensPerHour: number;
		anomalyEnabled: boolean;
		anomalyIntervalMinutes: number;
		webhookUrl: string;
	}> = {},
): Config {
	// Generic get/set backing store: getAlertsConfig() always calls
	// config.get() for usageWindowValueDropThreshold now (see
	// getUsageWindowValueDropThreshold in ../alerts.ts, issue #252 task
	// P1.6), so every fake Config needs this even though none of the tests
	// below exercise that alert directly.
	const store = new Map<string, string | number | boolean>();
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => overrides.tokensPerHour ?? 0,
		getAlertRequestTokens: () => overrides.requestTokens ?? 0,
		getAlertUsageWindowThresholdPercent: () => 0,
		getAlertAnomalyEnabled: () => overrides.anomalyEnabled ?? false,
		getAlertAnomalyIntervalMinutes: () =>
			overrides.anomalyIntervalMinutes ?? 15,
		getAlertAnomalyBaselineWindowMinutes: () => 1440,
		getAlertAnomalyLoopMinRequests: () => 25,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () =>
			overrides.webhookUrl ?? "http://127.0.0.1:9999/webhook",
		get: (
			key: string,
			defaultValue?: string | number | boolean,
		): string | number | boolean | undefined => {
			if (store.has(key)) return store.get(key);
			if (defaultValue !== undefined) {
				store.set(key, defaultValue);
				return defaultValue;
			}
			return undefined;
		},
		set: (key: string, value: string | number | boolean): void => {
			store.set(key, value);
		},
	}) as unknown as Config;
}

class SynchronizedDuplicateReadSqliteAdapter extends BunSqlAdapter {
	private duplicateReads = 0;
	private releaseDuplicateReads!: () => void;
	private readonly duplicateReadsComplete = new Promise<void>((resolve) => {
		this.releaseDuplicateReads = resolve;
	});

	override async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
		const result = await super.get<T>(sql, params);
		if (/SELECT id FROM alerts WHERE id = \?/i.test(sql)) {
			this.duplicateReads++;
			if (this.duplicateReads === 2) this.releaseDuplicateReads();
			await this.duplicateReadsComplete;
		}
		return result;
	}
}

describe("AlertService auth_failure events", () => {
	let sqlite: Database;
	let service: AlertService;
	let originalFetch: typeof globalThis.fetch;
	let alertListener: ((event: unknown) => void) | null;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		originalFetch = globalThis.fetch;
		alertListener = null;
	});

	afterEach(() => {
		service.stop();
		globalThis.fetch = originalFetch;
		if (alertListener) {
			alertEvents.off("event", alertListener);
		}
		sqlite.close();
	});

	it("persists, emits, and delivers one critical webhook per cooldown bucket", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const emitted: unknown[] = [];
		alertListener = (event) => emitted.push(event);
		alertEvents.on("event", alertListener);
		service.start();

		const event = {
			accountId: "account-1",
			accountName: "Backup account",
			provider: "anthropic",
			reason: "invalid_grant",
		};
		authFailureEvents.emit("event", event);

		await waitFor(() => fetchMock.mock.calls.length === 1);
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.type).toBe("auth_failure");
		expect(alerts[0]?.severity).toBe("critical");
		expect(alerts[0]?.account).toBe("Backup account");
		expect(emitted).toHaveLength(1);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const webhook = JSON.parse(String(init.body));
		expect(webhook.alert.type).toBe("auth_failure");

		authFailureEvents.emit("event", event);
		await Bun.sleep(20);

		expect(await service.listAlerts()).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(emitted).toHaveLength(1);
	});

	it("atomically emits one alert for synchronized concurrent duplicate writes", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const emitted: unknown[] = [];
		alertListener = (event) => emitted.push(event);
		alertEvents.on("event", alertListener);
		service = new AlertService(
			new SynchronizedDuplicateReadSqliteAdapter(sqlite),
			makeConfig({ requestTokens: 1 }),
		);
		service.start();

		const request: RequestResponse = {
			id: "duplicate-request",
			timestamp: new Date().toISOString(),
			method: "POST",
			path: "/v1/messages",
			accountUsed: "account-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTimeMs: 100,
			failoverAttempts: 0,
			model: "claude-3",
			totalTokens: 1_000_000,
			inputTokens: 1_000_000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			project: null,
		};

		await Promise.all([
			service.evaluateRequest(request),
			service.evaluateRequest(request),
		]);
		await waitFor(() => fetchMock.mock.calls.length >= 1);

		expect(await service.listAlerts()).toHaveLength(1);
		expect(emitted).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

/**
 * Fake adapter that records the SQL sent to `.runWithChanges()`. Simulates the
 * PostgreSQL dialect (isSQLite === false) so we can assert the dialect-aware
 * conflict clause without a live PG server.
 */
class RecordingPgAdapter implements BunSqlAdapterType {
	readonly isSQLite = false;
	readonly runStatements: string[] = [];

	async get<T>(_sql: string, _params?: unknown[]): Promise<T | null> {
		return null;
	}
	async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
		return [];
	}
	async run(sql: string, _params?: unknown[]): Promise<void> {
		this.runStatements.push(sql);
		// Reject if the caller sent SQLite-only syntax — mirrors PG's behavior.
		if (/INSERT OR IGNORE/i.test(sql)) {
			throw new Error('syntax error at or near "OR"');
		}
	}
	async runWithChanges(sql: string, _params?: unknown[]): Promise<number> {
		this.runStatements.push(sql);
		// Reject if the caller sent SQLite-only syntax — mirrors PG's behavior.
		if (/INSERT OR IGNORE/i.test(sql)) {
			throw new Error('syntax error at or near "OR"');
		}
		return 1;
	}
}

/**
 * Fake adapter that always fails on `.runWithChanges()`, to verify a
 * persistence failure is swallowed and never rejects the event-handler promise
 * (which would crash the proxy — the original v3.5.40 incident).
 */
class FailingPgAdapter extends RecordingPgAdapter {
	writeAttempts = 0;

	override async runWithChanges(
		_sql: string,
		_params?: unknown[],
	): Promise<number> {
		this.writeAttempts++;
		throw new Error("simulated PG outage");
	}
}

describe("AlertService persistAndEmit (issue #326)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function makeHighTokenRequest(): RequestResponse {
		return {
			id: "req-1",
			timestamp: new Date().toISOString(),
			method: "POST",
			path: "/v1/messages",
			accountUsed: "account-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTimeMs: 100,
			failoverAttempts: 0,
			model: "claude-3",
			totalTokens: 1_000_000,
			inputTokens: 1_000_000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			project: null,
		};
	}

	it("uses PostgreSQL ON CONFLICT syntax instead of INSERT OR IGNORE", async () => {
		const adapter = new RecordingPgAdapter();
		const service = new AlertService(
			adapter as unknown as BunSqlAdapterType,
			makeConfig({ requestTokens: 1 }),
		);
		service.start();
		try {
			await service.evaluateRequest(makeHighTokenRequest());
			const insertStmt = adapter.runStatements.find((s) =>
				/INTO alerts/.test(s),
			);
			expect(insertStmt).toBeDefined();
			expect(insertStmt).toMatch(/ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
			expect(insertStmt).not.toMatch(/INSERT OR IGNORE/i);
		} finally {
			service.stop();
		}
	});

	it("swallows persistence failures instead of crashing the proxy", async () => {
		const adapter = new FailingPgAdapter();
		const service = new AlertService(
			adapter as unknown as BunSqlAdapterType,
			makeConfig({ requestTokens: 1 }),
		);
		service.start();
		try {
			// Must not throw — the listener is invoked from an async event
			// handler whose rejection would crash Bun with exit code 1.
			await expect(
				service.evaluateRequest(makeHighTokenRequest()),
			).resolves.toBeUndefined();
		} finally {
			service.stop();
		}
	});

	it("swallows auth-failure insert failures without emitting or delivering a webhook", async () => {
		const adapter = new FailingPgAdapter();
		const service = new AlertService(
			adapter as unknown as BunSqlAdapterType,
			makeConfig(),
		);
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const emitted = mock((_event: unknown) => undefined);
		const unhandledRejection = mock(
			(_reason: unknown, _promise: Promise<unknown>) => undefined,
		);
		alertEvents.on("event", emitted);
		process.on("unhandledRejection", unhandledRejection);
		service.start();

		try {
			authFailureEvents.emit("event", {
				accountId: "account-write-failure",
				accountName: "Write failure account",
				provider: "anthropic",
				reason: "invalid_grant",
			});
			await waitFor(() => adapter.writeAttempts === 1);
			await Bun.sleep(20);

			expect(unhandledRejection).not.toHaveBeenCalled();
			expect(emitted).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			service.stop();
			alertEvents.off("event", emitted);
			process.off("unhandledRejection", unhandledRejection);
		}
	});
});

class RecoveringPgAdapter implements BunSqlAdapterType {
	readonly isSQLite = false;
	failAggregate = true;
	failAnomaly = true;
	getCalls = 0;
	queryCalls = 0;
	writeAttempts = 0;

	async get<T>(_sql: string, _params?: unknown[]): Promise<T | null> {
		this.getCalls++;
		if (this.failAggregate) {
			throw new Error("PG query timeout after 8000ms: SELECT SUM(...)");
		}
		return null;
	}

	async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
		this.queryCalls++;
		if (this.failAnomaly) {
			throw new Error("PG query timeout after 8000ms: SELECT requests");
		}
		return [];
	}

	async run(_sql: string, _params?: unknown[]): Promise<void> {}

	async runWithChanges(_sql: string, _params?: unknown[]): Promise<number> {
		this.writeAttempts++;
		return 1;
	}
}

function highTokenRequest(id: string): RequestResponse {
	return {
		id,
		timestamp: new Date().toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "account-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 100,
		failoverAttempts: 0,
		model: "claude-3",
		totalTokens: 10,
		inputTokens: 10,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		project: null,
	};
}

describe("AlertService fire-and-forget failures", () => {
	let unhandled: unknown[];
	let unhandledListener: (reason: unknown) => void;
	let logs: LogEvent[];
	let logListener: (event: LogEvent) => void;

	beforeEach(() => {
		unhandled = [];
		unhandledListener = (reason) => unhandled.push(reason);
		process.on("unhandledRejection", unhandledListener);
		logs = [];
		logListener = (event) => logs.push(event);
		logBus.on("log", logListener);
	});

	afterEach(() => {
		process.off("unhandledRejection", unhandledListener);
		logBus.off("log", logListener);
	});

	it("logs a request aggregate rejection and processes a later summary", async () => {
		const adapter = new RecoveringPgAdapter();
		const service = new AlertService(
			adapter,
			makeConfig({ requestTokens: 1, tokensPerHour: 1, webhookUrl: "" }),
		);
		const emitted = mock((_event: unknown) => undefined);
		alertEvents.on("event", emitted);
		service.start();
		try {
			requestEvents.emit("event", {
				type: "summary",
				payload: highTokenRequest("request-times-out"),
			});
			await waitFor(() => unhandled.length > 0 || logs.length > 0);

			expect(unhandled).toHaveLength(0);
			expect(
				logs.some(
					(event) =>
						event.level === "ERROR" &&
						event.msg.includes("request-times-out") &&
						event.msg.includes("PG query timeout"),
				),
			).toBe(true);

			adapter.failAggregate = false;
			requestEvents.emit("event", {
				type: "summary",
				payload: highTokenRequest("request-recovers"),
			});
			await waitFor(() => adapter.writeAttempts === 1);
			expect(emitted).toHaveBeenCalledTimes(1);
		} finally {
			service.stop();
			alertEvents.off("event", emitted);
		}
	});

	it("catches the real registered anomaly timer callback and restarts cleanly", async () => {
		const adapter = new RecoveringPgAdapter();
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const callbacks: Array<() => void> = [];
		const handles: object[] = [];
		const cleared: unknown[] = [];
		globalThis.setInterval = ((callback: () => void) => {
			callbacks.push(callback);
			const handle = {};
			handles.push(handle);
			return handle;
		}) as unknown as typeof setInterval;
		globalThis.clearInterval = ((handle: unknown) => {
			cleared.push(handle);
		}) as unknown as typeof clearInterval;
		const requestListenersBefore = requestEvents.listenerCount("event");
		const authListenersBefore = authFailureEvents.listenerCount("event");
		const service = new AlertService(
			adapter,
			makeConfig({ anomalyEnabled: true, webhookUrl: "" }),
		);
		try {
			service.start();
			expect(callbacks).toHaveLength(1);
			expect(requestEvents.listenerCount("event")).toBe(
				requestListenersBefore + 1,
			);
			expect(authFailureEvents.listenerCount("event")).toBe(
				authListenersBefore + 1,
			);

			callbacks[0]?.();
			await waitFor(() => unhandled.length > 0 || logs.length > 0);
			expect(unhandled).toHaveLength(0);
			expect(
				logs.some(
					(event) =>
						event.level === "ERROR" &&
						event.msg.includes("Anomaly evaluation failed") &&
						event.msg.includes("PG query timeout"),
				),
			).toBe(true);

			adapter.failAnomaly = false;
			callbacks[0]?.();
			await waitFor(() => adapter.queryCalls === 2);

			service.stop();
			expect(cleared).toEqual([handles[0]]);
			expect(requestEvents.listenerCount("event")).toBe(requestListenersBefore);
			expect(authFailureEvents.listenerCount("event")).toBe(
				authListenersBefore,
			);

			service.start();
			expect(callbacks).toHaveLength(2);
			expect(requestEvents.listenerCount("event")).toBe(
				requestListenersBefore + 1,
			);
			expect(authFailureEvents.listenerCount("event")).toBe(
				authListenersBefore + 1,
			);
			callbacks[1]?.();
			await waitFor(() => adapter.queryCalls === 3);
		} finally {
			service.stop();
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	it("logs an auth-failure cooldown lookup rejection and handles the next event", async () => {
		const adapter = new RecoveringPgAdapter();
		const config = makeConfig({ webhookUrl: "" });
		let failCooldownLookup = false;
		config.getAlertCooldownMinutes = () => {
			if (failCooldownLookup) throw new Error("cooldown lookup unavailable");
			return 60;
		};
		const emitted = mock((_event: unknown) => undefined);
		alertEvents.on("event", emitted);
		const service = new AlertService(adapter, config);
		service.start();
		try {
			failCooldownLookup = true;
			authFailureEvents.emit("event", {
				accountId: "account-auth",
				accountName: "Auth account",
				provider: "anthropic",
				reason: "invalid_grant",
			});
			await waitFor(() => unhandled.length > 0 || logs.length > 0);
			expect(unhandled).toHaveLength(0);
			expect(
				logs.some(
					(event) =>
						event.level === "ERROR" &&
						event.msg.includes("account-auth") &&
						event.msg.includes("cooldown lookup unavailable"),
				),
			).toBe(true);

			failCooldownLookup = false;
			authFailureEvents.emit("event", {
				accountId: "account-auth-recovered",
				accountName: "Recovered auth account",
				provider: "anthropic",
				reason: "invalid_grant",
			});
			await waitFor(() => adapter.writeAttempts === 1);
			expect(emitted).toHaveBeenCalledTimes(1);
		} finally {
			service.stop();
			alertEvents.off("event", emitted);
		}
	});
});
