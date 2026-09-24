import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@better-ccflare/config";
import { type AlertEvt, alertEvents } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	CacheHealthRepository,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { logBus } from "@better-ccflare/logger";
import {
	CACHE_HEALTH_BUCKET_MS as BUCKET,
	type LogEvent,
	CACHE_HEALTH_SETTLEMENT_MS as SETTLE,
} from "@better-ccflare/types";
import {
	CACHE_TEST_TIME as START,
	seedCacheAccount,
	seedCacheRequest,
} from "../../../../database/src/repositories/__tests__/cache-health-contract";
import { createAlertsStreamHandler } from "../../handlers/alerts";
import { AlertService } from "../alerts";

// Every request is a local persisted fixture. Every fetch is intercepted before
// a service starts; this suite must never send inference or a real webhook.
const DESTINATION = "https://discord.com/api/webhooks/fixture/fake-secret";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("cache health persisted alert pipeline", () => {
	let database: Database;
	let db: BunSqlAdapter;
	let config: Config;
	let directory: string;
	let service: AlertService;
	let services: AlertService[];
	let originalFetch: typeof fetch;
	let environment: Record<string, string | undefined>;
	let deliveries: {
		url: string;
		body: { content: string; allowed_mentions: { parse: string[] } };
		signal?: AbortSignal | null;
	}[];
	let events: AlertEvt[];
	const listener = (event: AlertEvt) => events.push(event);

	beforeEach(async () => {
		environment = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key.startsWith("ALERT_")),
		);
		for (const key of Object.keys(environment)) delete process.env[key];
		directory = mkdtempSync(join(tmpdir(), "cache-health-integration-"));
		config = new Config(join(directory, "config.json"));
		config.setAlertWebhookUrl(DESTINATION);
		database = new Database(":memory:");
		runMigrations(database);
		ensureSchema(database);
		db = new BunSqlAdapter(database);
		await seedCacheAccount(db);
		await db.run("UPDATE accounts SET name = ? WHERE id = ?", [
			"Work @everyone 🚀",
			"cache-a",
		]);
		originalFetch = globalThis.fetch;
		deliveries = [];
		globalThis.fetch = mock(async (input, init) => {
			deliveries.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
				signal: init?.signal,
			});
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		events = [];
		alertEvents.on("event", listener);
		service = new AlertService(db, config);
		services = [service];
		service.start();
	});
	afterEach(async () => {
		await Promise.all(services.map((item) => item.stop()));
		mock.restore();
		alertEvents.off("event", listener);
		globalThis.fetch = originalFetch;
		database.close();
		rmSync(directory, { recursive: true, force: true });
		for (const key of Object.keys(process.env))
			if (key.startsWith("ALERT_")) delete process.env[key];
		Object.assign(process.env, environment);
	});

	async function sample(
		bucket: number,
		reuse = 80,
		count = 10,
		overrides: Record<string, unknown> = {},
	) {
		for (let i = 0; i < count; i++) {
			await seedCacheRequest(
				db,
				`${bucket}-${Object.keys(overrides)
					.map((key) => String(overrides[key]))
					.join("-")}-${i}`,
				{
					timestamp: START + bucket * BUCKET + i,
					input_tokens: 10_000 - reuse * 100,
					cache_read_input_tokens: reuse * 100,
					...overrides,
				},
			);
		}
	}
	const tick = (completed: number) =>
		service.evaluateCacheHealth(START + completed * BUCKET + SETTLE);
	const history = () => service.listAlerts(100);

	it("requires distinct settled buckets, persists cold streaks, resumes after restart and publishes actual SSE/Discord once", async () => {
		const stream = createAlertsStreamHandler()(
			new Request("http://fixture/stream"),
		);
		const reader = stream.body?.getReader();
		try {
			await reader.read(); // connected frame
			await sample(0, 0);
			await service.evaluateCacheHealth(START + BUCKET + SETTLE - 1);
			expect(await history()).toEqual([]);
			await tick(1);
			await tick(1);
			expect(await history()).toEqual([]);
			expect(
				(
					await new CacheHealthRepository(db).loadStates(
						START + BUCKET + SETTLE,
					)
				).find((s) => s.scope.kind === "account")?.revision,
			).toBe(1);
			await service.stop();
			service = new AlertService(db, config);
			services.push(service);
			service.start();
			await sample(1, 0);
			await sample(2, 0);
			await tick(3);
			await tick(3);
			const alerts = await history();
			expect(alerts).toHaveLength(1); // redundant single-account parent omitted
			expect(alerts[0]).toMatchObject({
				type: "cache_efficiency_low",
				account: "Work @everyone 🚀",
				model: "observed",
				value: 0,
				threshold: 90,
				requestId: null,
				project: null,
			});
			expect(alerts[0].message).toContain(new Date(START).toISOString());
			expect(alerts[0].message).toContain(
				new Date(START + 3 * BUCKET).toISOString(),
			);
			expect(alerts[0].message).toContain("300000");
			expect(alerts[0].message).toContain("zero-hit");
			expect(alerts[0].message).toContain("coverage");
			expect(events).toHaveLength(1);
			const frame = await reader.read();
			expect(
				JSON.parse(new TextDecoder().decode(frame.value).slice(6)).payload.id,
			).toBe(alerts[0].id);
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0].body.allowed_mentions).toEqual({ parse: [] });
			expect(deliveries[0].body.content).toContain("RECORDED");
			expect(Array.from(deliveries[0].body.content).length).toBeLessThanOrEqual(
				2000,
			);
		} finally {
			await reader.cancel();
		}
	});

	it("aggregates provider volume before floors, excluding unsupported and internal rows", async () => {
		await seedCacheAccount(db, "cache-b");
		await seedCacheAccount(db, "unsupported");
		for (let bucket = 0; bucket < 3; bucket++) {
			await sample(bucket, 80, 5);
			await sample(bucket, 80, 5, { account_used: "cache-b" });
			await sample(bucket, 0, 20, {
				account_used: "unsupported",
				cache_health_native: 0,
			});
			await sample(bucket, 0, 20, { internal_origin: 1 });
			await sample(bucket, 0, 9, { model: "isolated" });
		}
		await tick(3);
		expect(await history()).toHaveLength(1);
		expect((await history())[0]).toMatchObject({
			account: null,
			model: "observed",
			value: 80,
		});
		expect((await history())[0].message).toContain("Work @everyone 🚀");
		expect((await history())[0].message).not.toContain("unsupported");
	});

	it("remembers earlier positive enrollment when later catchup buckets are zero", async () => {
		for (let bucket = 0; bucket < 3; bucket++)
			await sample(bucket, bucket === 0 ? 1 : 0, 10, {
				cache_health_native: 0,
				routed_provider: "compatible",
			});
		await tick(3);
		const states = await new CacheHealthRepository(db).loadStates(
			START + 3 * BUCKET + SETTLE,
		);
		expect(states.find((s) => s.scope.kind === "provider")?.lastBucketEnd).toBe(
			START + 3 * BUCKET,
		);
		expect(await history()).toHaveLength(1);
	});

	it("retains learned non-native eligibility across 48 idle hours and alerts on three fresh zero-hit buckets", async () => {
		const route = {
			cache_health_native: 0,
			routed_provider: "openai-compatible",
		};
		const repo = new CacheHealthRepository(db);
		// Learn through recorded positive reads, then leave an incomplete streak.
		for (const [bucket, reuse] of [95, 95, 80, 80].entries()) {
			await sample(bucket, reuse, 10, route);
			await tick(bucket + 1);
		}
		const before = (await repo.loadStates(START + 4 * BUCKET + SETTLE)).find(
			(s) => s.scope.kind === "account",
		)!;
		expect(before).toMatchObject({
			enrolled: true,
			reuse: { incident: null, bad: { buckets: 2 } },
		});
		expect(before.healthyEnds).toHaveLength(2);
		expect(before.reportingEnd).not.toBeNull();
		expect(await history()).toEqual([]);
		await service.stop();
		const resumed = 4 + (48 * 60) / 10;
		const later = START + resumed * BUCKET + SETTLE;
		const loaded = await repo.loadStates(later);
		const retained = loaded.find((s) => s.scope.kind === "account")!;
		expect(retained).toMatchObject({
			enrolled: true,
			revision: before.revision,
			lastBucketEnd: before.lastBucketEnd,
			healthyEnds: [],
			reportingEnd: null,
			reuse: { sequence: 0, incident: null, bad: null, recovery: null },
			telemetry: { sequence: 0, incident: null, bad: null, recovery: null },
		});
		service = new AlertService(db, config);
		services.push(service);
		service.start();
		for (let offset = 0; offset < 3; offset++) {
			await sample(resumed + offset, 0, 10, route);
			await tick(resumed + offset + 1);
			const states = await repo.loadStates(
				START + (resumed + offset + 1) * BUCKET + SETTLE,
			);
			expect(states.find((s) => s.scope.kind === "account")).toMatchObject({
				enrolled: true,
				revision: before.revision + offset + 1,
			});
			// The provider is still eligible even though every fresh read is zero.
			expect(
				states.find((s) => s.scope.kind === "provider")?.lastBucketEnd,
			).toBe(START + (resumed + offset + 1) * BUCKET);
			if (offset < 2) expect(await history()).toEqual([]); // old streak/baseline cannot open early
		}
		const [alert] = await history();
		expect(await history()).toHaveLength(1);
		expect(alert).toMatchObject({
			type: "cache_efficiency_low",
			account: "Work @everyone 🚀",
			model: "observed",
			value: 0,
		});
		expect(alert.message).toContain(
			new Date(START + resumed * BUCKET).toISOString(),
		);
		expect(alert.message).toContain("300000");
		expect(events).toHaveLength(1);
		await tick(resumed + 3);
		expect(await history()).toHaveLength(1);
	});

	it("keeps incident sequences and alert ids distinct after recovery and 48 idle hours", async () => {
		const route = {
			cache_health_native: 0,
			routed_provider: "openai-compatible",
		};
		for (const [bucket, reuse] of [80, 80, 80, 95, 95].entries()) {
			await sample(bucket, reuse, 10, route);
			await tick(bucket + 1);
		}
		const repo = new CacheHealthRepository(db);
		const resumed = 5 + (48 * 60) / 10;
		const retained = (
			await repo.loadStates(START + resumed * BUCKET + SETTLE)
		).find((s) => s.scope.kind === "account")!;
		expect(retained).toMatchObject({
			enrolled: true,
			reuse: { sequence: 1, incident: null, bad: null, recovery: null },
		});
		expect((await history()).map((a) => a.type).sort()).toEqual([
			"cache_efficiency_low",
			"cache_efficiency_recovered",
		]);
		for (let offset = 0; offset < 3; offset++) {
			await sample(resumed + offset, 0, 10, route);
			await tick(resumed + offset + 1);
			if (offset < 2) expect(await history()).toHaveLength(2);
		}
		const alerts = await history();
		expect(
			alerts.filter((a) => a.type === "cache_efficiency_low"),
		).toHaveLength(2);
		expect(new Set(alerts.map((a) => a.id)).size).toBe(3);
		const account = (
			await repo.loadStates(START + (resumed + 3) * BUCKET + SETTLE)
		).find((s) => s.scope.kind === "account")!;
		expect(account.reuse).toMatchObject({
			sequence: 2,
			incident: { sequence: 2 },
		});
	});

	it("expires never-positive routes and invalidates idle enrollment after account recreation", async () => {
		const route = {
			cache_health_native: 0,
			routed_provider: "openai-compatible",
		};
		await sample(0, 95, 10, route);
		await sample(0, 0, 10, { ...route, model: "unclassified" });
		await tick(1);
		const repo = new CacheHealthRepository(db);
		const laterBucket = 1 + (48 * 60) / 10;
		const later = START + laterBucket * BUCKET + SETTLE;
		const retained = await repo.loadStates(later);
		expect(retained.filter((s) => s.scope.kind === "account")).toHaveLength(1);
		expect(retained.some((s) => s.scope.model === "unclassified")).toBe(false);
		expect(
			retained.find((s) => s.scope.kind === "provider")?.contributors,
		).toEqual([{ accountId: "cache-a", accountGeneration: 1 }]);
		await db.run("DELETE FROM accounts WHERE id = ?", ["cache-a"]);
		await seedCacheAccount(db, "cache-a", 2);
		await tick(laterBucket); // service also removes the old provider generation
		expect(await repo.loadStates(later)).toEqual([]);
		for (let offset = 0; offset < 3; offset++) {
			await sample(laterBucket + offset, 0, 10, {
				...route,
				account_generation: 2,
			});
			await tick(laterBucket + offset + 1);
		}
		const states = await repo.loadStates(
			START + (laterBucket + 3) * BUCKET + SETTLE,
		);
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({
			scope: { kind: "account", accountGeneration: 2 },
			enrolled: false,
			reuse: { incident: null, bad: null },
		});
		expect(await history()).toEqual([]);
		expect(events).toEqual([]);
	});

	it("retains long-duration streaks beyond bounded catchup and breaks them at traffic gaps", async () => {
		config.setAlertCacheHealthDurationMinutes(40);
		for (let bucket = 0; bucket < 4; bucket++) {
			await sample(bucket);
			await tick(bucket + 1);
			if (bucket < 3) expect(await history()).toEqual([]);
		}
		expect(await history()).toHaveLength(1);
		await tick(8); // no traffic never resolves an incident
		expect(await history()).toHaveLength(1);
		await sample(8, 95);
		await tick(9);
		await sample(10, 95);
		await tick(11);
		expect(await history()).toHaveLength(1); // gap broke recovery
		await sample(11, 95);
		await tick(12);
		expect(
			(await history()).filter((a) => a.type === "cache_efficiency_recovered"),
		).toHaveLength(1);
	});

	it("does not hide a newly affected account after suppressing a single-account parent", async () => {
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		await tick(3);
		await seedCacheAccount(db, "cache-b");
		for (let bucket = 3; bucket < 6; bucket++) {
			await sample(bucket);
			await sample(bucket, 80, 10, { account_used: "cache-b" });
		}
		await tick(6);
		expect(
			(await history()).filter((a) => a.type === "cache_efficiency_low"),
		).toHaveLength(3);
		expect((await history()).some((a) => a.account === "cache-b")).toBe(true);
		expect((await history()).some((a) => a.account === null)).toBe(true);
	});

	it("publishes recovery of an earlier real provider incident even if recovery has one contributor", async () => {
		await seedCacheAccount(db, "cache-b");
		for (let bucket = 0; bucket < 3; bucket++) {
			await sample(bucket, 80, 5);
			await sample(bucket, 80, 5, { account_used: "cache-b" });
		}
		await tick(3);
		await sample(3, 95);
		await sample(4, 95);
		await tick(5);
		expect(
			(await history())
				.filter((a) => a.account === null)
				.map((a) => a.type)
				.sort(),
		).toEqual(["cache_efficiency_low", "cache_efficiency_recovered"]);
	});

	it("tracks telemetry restoration separately from still-poor reuse", async () => {
		await sample(0, 95);
		await tick(1);
		for (let bucket = 1; bucket < 4; bucket++) {
			await sample(bucket, 80);
			await tick(bucket + 1);
		}
		for (let bucket = 4; bucket < 7; bucket++) {
			await sample(bucket, 0, 10, {
				input_tokens: null,
				cache_read_input_tokens: null,
				prompt_tokens: null,
			});
			await tick(bucket + 1);
		}
		expect(
			(await history()).find((a) => a.type === "cache_telemetry_gap")?.message,
		).toContain("unavailable in request records");
		for (let bucket = 7; bucket < 9; bucket++) {
			await sample(bucket, 80);
			await tick(bucket + 1);
		}
		expect((await history()).map((a) => a.type).sort()).toEqual([
			"cache_efficiency_low",
			"cache_efficiency_recovered",
			"cache_telemetry_gap",
		]);
		const account = (
			await new CacheHealthRepository(db).loadStates(
				START + 9 * BUCKET + SETTLE,
			)
		).find((s) => s.scope.kind === "account");
		expect(account?.reuse.incident).not.toBeNull();
		expect(account?.telemetry.incident).toBeNull();
	});

	it("only the atomic CAS winner emits; a losing scope reloads on a later tick", async () => {
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		const rival = new AlertService(db, config);
		services.push(rival);
		rival.start();
		await Promise.all([
			tick(3),
			rival.evaluateCacheHealth(START + 3 * BUCKET + SETTLE),
		]);
		await tick(3);
		expect(await history()).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(deliveries).toHaveLength(1);
	});

	it("rolls back failed alert insertions and retries without losing the persisted streak", async () => {
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		database.run(
			"CREATE TRIGGER fail_cache_alert BEFORE INSERT ON alerts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
		);
		await tick(3); // contained, no unhandled rejection
		expect(await history()).toEqual([]);
		expect(events).toEqual([]);
		database.run("DROP TRIGGER fail_cache_alert");
		await tick(3);
		expect(await history()).toHaveLength(1);
	});

	it("keeps history and SSE when the unchanged webhook allowlist excludes cache types", async () => {
		config.setAlertWebhookTypes("auth_failure,model_routing_drift");
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		await tick(3);
		expect(await history()).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(deliveries).toEqual([]);
		expect(config.getAlertWebhookUrl()).toBe(DESTINATION);
		expect(config.get("alert_webhook_types")).toBe(
			"auth_failure,model_routing_drift",
		);
	});

	it.each([
		429,
		503,
		"network",
	])("contains delivery failure %s without exposing a URL or replaying history", async (failure) => {
		const logs: LogEvent[] = [];
		const capture = (event: LogEvent) => logs.push(event);
		logBus.on("log", capture);
		globalThis.fetch = mock(async () => {
			if (failure === "network")
				throw new Error(`fetch failed: ${DESTINATION}`);
			return new Response(null, { status: failure });
		}) as unknown as typeof fetch;
		try {
			for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
			await tick(3);
			await tick(3);
			expect(await history()).toHaveLength(1);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(logs)).not.toContain("fake-secret");
		} finally {
			logBus.off("log", capture);
		}
	});

	it.each([
		"stop",
		"disable",
		"destination",
		"allowlist",
		"policy",
		"environment",
	])("invalidates an in-flight scan on %s and never overlaps scans", async (change) => {
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		const entered = deferred();
		const release = deferred();
		const original = CacheHealthRepository.prototype.fetchBuckets;
		const fetchBuckets = spyOn(
			CacheHealthRepository.prototype,
			"fetchBuckets",
		).mockImplementation(async function (
			this: CacheHealthRepository,
			start,
			end,
		) {
			entered.resolve();
			await release.promise;
			return original.call(this, start, end);
		});
		const pending = tick(3);
		await entered.promise;
		const concurrent = tick(3);
		let stopping: Promise<void> | undefined;
		if (change === "stop") stopping = service.stop();
		if (change === "disable") config.setAlertCacheHealthEnabled(false);
		if (change === "destination")
			config.setAlertWebhookUrl("https://example.com/new-destination");
		if (change === "allowlist") config.setAlertWebhookTypes("auth_failure");
		if (change === "policy") config.setAlertCacheHealthThresholdPercent(70);
		if (change === "environment")
			process.env.ALERT_CACHE_HEALTH_THRESHOLD_PERCENT = "70";
		release.resolve();
		await Promise.all([pending, concurrent, stopping]);
		expect(fetchBuckets).toHaveBeenCalledTimes(1);
		expect(await history()).toEqual([]);
		expect(
			await new CacheHealthRepository(db).loadStates(
				START + 3 * BUCKET + SETTLE,
			),
		).toEqual([]);
		expect(deliveries).toEqual([]);
	});

	it("reads finalized persisted rows after settlement instead of request-summary estimates", async () => {
		await sample(0, 80, 10, { success: false });
		await service.evaluateCacheHealth(START + BUCKET + SETTLE - 1);
		await db.run(
			"UPDATE requests SET success = ? WHERE timestamp >= ? AND timestamp < ?",
			[true, START, START + BUCKET],
		);
		await tick(1);
		await sample(1);
		await sample(2);
		await tick(3);
		expect(await history()).toHaveLength(1);
		expect((await history())[0].message).toContain("30 measured / 30 eligible");
	});

	it("disables independently of anomaly detection, stops immediately and restarts idempotently", async () => {
		const fetchBuckets = spyOn(CacheHealthRepository.prototype, "fetchBuckets");
		config.setAlertCacheHealthEnabled(false);
		await tick(3);
		expect(fetchBuckets).not.toHaveBeenCalled();
		config.setAlertCacheHealthEnabled(true);
		service.start();
		service.start();
		await tick(3);
		expect(fetchBuckets).toHaveBeenCalledTimes(1);
		await service.stop();
		await tick(3);
		expect(fetchBuckets).toHaveBeenCalledTimes(1);
		service.start();
		await tick(3);
		expect(fetchBuckets).toHaveBeenCalledTimes(2);
	});

	it("does not stitch incomplete streaks across policy changes", async () => {
		await sample(0);
		await sample(1);
		await tick(2);
		config.setAlertCacheHealthThresholdPercent(85);
		await sample(2);
		await tick(3);
		expect(await history()).toEqual([]);
		await sample(3);
		await sample(4);
		await tick(5);
		expect(await history()).toHaveLength(1);
	});

	it("keeps exact elapsed six-hour reminders with fresh traffic and only one escalation", async () => {
		await sample(0, 95);
		await sample(1, 95);
		await tick(2);
		for (let bucket = 2; bucket < 5; bucket++) await sample(bucket, 80);
		await tick(5);
		expect((await history()).map((a) => a.type)).toEqual([
			"cache_efficiency_low",
		]);
		await sample(5, 40);
		await tick(6);
		await sample(6, 40);
		await tick(7);
		expect(
			(await history()).filter((a) => a.type === "cache_efficiency_critical"),
		).toHaveLength(1);
		await sample(41, 40);
		const due = START + 42 * BUCKET + SETTLE;
		await service.evaluateCacheHealth(due - 1);
		expect(await history()).toHaveLength(2);
		await service.evaluateCacheHealth(due);
		expect(await history()).toHaveLength(3);
		expect(
			(await history()).filter((a) => a.type === "cache_efficiency_critical"),
		).toHaveLength(2);
		await service.evaluateCacheHealth(due + 6 * 60 * 60_000);
		expect(await history()).toHaveLength(3); // no fresh traffic, no reminder
	});

	it("derives critical and recovery thresholds from the warning setting", async () => {
		config.setAlertCacheHealthThresholdPercent(40);
		await sample(0, 45);
		await sample(1, 45);
		await tick(2);
		await sample(2, 41);
		await tick(3);
		expect(await history()).toEqual([]); // below 50 alone is insufficient
		await sample(3, 39);
		await tick(4);
		expect((await history())[0]).toMatchObject({
			type: "cache_efficiency_critical",
			threshold: 40,
		});
		await sample(4, 42);
		await sample(5, 42);
		await tick(6);
		expect(
			(await history()).find((a) => a.type === "cache_efficiency_recovered")
				?.threshold,
		).toBe(42);
	});

	it("caps recovery at 100 percent and never widens the three-bucket startup window", async () => {
		config.setAlertCacheHealthThresholdPercent(99);
		for (let bucket = 0; bucket < 6; bucket++) await sample(bucket, 98);
		await tick(6);
		const states = await new CacheHealthRepository(db).loadStates(
			START + 6 * BUCKET + SETTLE,
		);
		expect(states.find((s) => s.scope.kind === "account")?.revision).toBe(3);
		expect((await history())[0].message).toContain(
			new Date(START + 3 * BUCKET).toISOString(),
		);
		await sample(6, 100);
		await sample(7, 100);
		await tick(8);
		expect(
			(await history()).find((a) => a.type === "cache_efficiency_recovered")
				?.threshold,
		).toBe(100);
	});

	it("ignores account-generation changes during a scan and retries a contained query failure", async () => {
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		const original = CacheHealthRepository.prototype.fetchBuckets;
		const fetchBuckets = spyOn(
			CacheHealthRepository.prototype,
			"fetchBuckets",
		).mockImplementationOnce(async () => {
			throw new Error("fixture unavailable");
		});
		await tick(3);
		expect(await history()).toEqual([]);
		fetchBuckets.mockImplementationOnce(async function (
			this: CacheHealthRepository,
			start,
			end,
		) {
			const rows = await original.call(this, start, end);
			await db.run("UPDATE accounts SET created_at = 2 WHERE id = ?", [
				"cache-a",
			]);
			return rows;
		});
		await tick(3);
		expect(await history()).toEqual([]);
		expect(events).toEqual([]);
		await tick(3);
		expect(
			await new CacheHealthRepository(db).loadStates(
				START + 3 * BUCKET + SETTLE,
			),
		).toEqual([]);
	});

	it("awaits an admitted commit on stop and suppresses publication after it settles", async () => {
		await sample(0);
		await sample(1);
		await tick(2);
		await sample(2);
		const entered = deferred();
		const release = deferred();
		const commit = CacheHealthRepository.prototype.commit;
		spyOn(CacheHealthRepository.prototype, "commit").mockImplementationOnce(
			async function (this: CacheHealthRepository, revision, state, alerts) {
				entered.resolve();
				await release.promise;
				return commit.call(this, revision, state, alerts);
			},
		);
		const pending = tick(3);
		await entered.promise;
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release.resolve();
		await Promise.all([pending, stopping]);
		expect(stopped).toBe(true);
		expect(await history()).toHaveLength(1); // atomic batch already admitted
		expect(events).toEqual([]);
		expect(deliveries).toEqual([]);
	});

	it("cancels a pending webhook on reconfiguration without resending to the new destination", async () => {
		const entered = deferred();
		let aborted = false;
		globalThis.fetch = mock(async (_input, init) => {
			entered.resolve();
			await new Promise<void>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new Error("fixture aborted"));
					},
					{ once: true },
				);
			});
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		const pending = tick(3);
		await entered.promise;
		config.setAlertWebhookUrl("https://example.com/new-destination");
		await pending;
		expect(aborted).toBe(true);
		await tick(3);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("registers one five-minute callback and contains errors on subsequent timer ticks", async () => {
		await service.stop();
		let callback: (() => void) | undefined;
		const timer = { unref() {} } as ReturnType<typeof setInterval>;
		const interval = spyOn(globalThis, "setInterval").mockImplementation(((
			run: () => void,
		) => {
			callback = run;
			return timer;
		}) as typeof setInterval);
		const clear = spyOn(globalThis, "clearInterval").mockImplementation(
			() => {},
		);
		const clock = spyOn(Date, "now").mockReturnValue(
			START + 3 * BUCKET + SETTLE,
		);
		try {
			service.start();
			service.start();
			expect(interval).toHaveBeenCalledTimes(1);
			expect(interval.mock.calls[0][1]).toBe(5 * 60_000);
			for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
			spyOn(
				CacheHealthRepository.prototype,
				"fetchBuckets",
			).mockRejectedValueOnce(new Error("fixture"));
			callback?.();
			await service.evaluateCacheHealth();
			expect(await history()).toEqual([]);
			callback?.();
			await service.evaluateCacheHealth();
			expect(await history()).toHaveLength(1);
			await service.stop();
			expect(clear).toHaveBeenCalledWith(timer);
			callback?.();
			expect(await history()).toHaveLength(1);
		} finally {
			await service.stop();
			clock.mockRestore();
			interval.mockRestore();
			clear.mockRestore();
		}
	});

	it("keeps legacy Config doubles and generic-webhook bodies compatible", async () => {
		const legacy = Object.assign(new EventEmitter(), {
			get: (_key: string, fallback: unknown) => fallback,
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 90,
			getAlertAnomalyEnabled: () => false,
			getAlertAnomalyIntervalMinutes: () => 15,
			getAlertAnomalyBaselineWindowMinutes: () => 1440,
			getAlertAnomalyLoopMinRequests: () => 25,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
		const oldService = new AlertService(db, legacy);
		services.push(oldService);
		oldService.start();
		const scan = spyOn(CacheHealthRepository.prototype, "fetchBuckets");
		await oldService.evaluateCacheHealth(START);
		expect(scan).not.toHaveBeenCalled();
		config.setAlertWebhookUrl("https://example.com/generic");
		for (let bucket = 0; bucket < 3; bucket++) await sample(bucket);
		await tick(3);
		expect(deliveries[0].body).toEqual({
			type: "alert",
			alert: (await history())[0],
		});
	});

	it("prunes deleted generations, including provider state, before a recreated account enrolls", async () => {
		await seedCacheAccount(db, "cache-b");
		for (let bucket = 0; bucket < 3; bucket++) {
			await sample(bucket, 80, 5);
			await sample(bucket, 80, 5, { account_used: "cache-b" });
		}
		await tick(3);
		await db.run("DELETE FROM accounts WHERE id = ?", ["cache-b"]);
		await tick(6);
		expect(
			(
				await new CacheHealthRepository(db).loadStates(
					START + 6 * BUCKET + SETTLE,
				)
			).some((s) => s.scope.kind === "provider"),
		).toBe(false);
		await db.run("UPDATE accounts SET created_at = 2 WHERE id = ?", [
			"cache-a",
		]);
		await sample(6, 0, 10, { account_generation: 2 });
		await tick(7);
		expect(await history()).toHaveLength(1); // old history remains, no cold critical
	});
});
