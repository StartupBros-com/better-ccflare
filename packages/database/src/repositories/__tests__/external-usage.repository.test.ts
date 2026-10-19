import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import {
	type ExternalUsageEvent,
	ExternalUsageRepository,
} from "../external-usage.repository";
import { RequestRepository } from "../request.repository";

let db: Database;
let repo: ExternalUsageRepository;
const event = (
	overrides: Partial<ExternalUsageEvent> = {},
): ExternalUsageEvent => ({
	sourceKind: "rollout",
	eventTs: 1000,
	timestamp: "1970-01-01T00:00:01Z",
	model: "gpt-6-astra",
	inputTokens: 100,
	cacheReadInputTokens: 20,
	outputTokens: 30,
	reasoningOutputTokens: 10,
	totalTokens: 150,
	isFallbackModel: false,
	rateLimitResetsAt: 100,
	planType: "pro",
	limitId: "codex",
	creditsHasCredits: true,
	creditsBalance: "18763.0107080000",
	primaryUsedPercent: 100,
	sessionId: "session",
	...overrides,
});
function window(account: string, reset: number) {
	db.run(
		"INSERT INTO accounts (id,name,provider,created_at) VALUES (?,?, 'codex',0) ON CONFLICT DO NOTHING",
		[account, account],
	);
	db.run(
		"INSERT INTO usage_windows (id,account_id,window_key,started_at,resets_at,grant_type) VALUES (?,?,'seven_day',0,?,'natural')",
		[account + reset, account, reset * 1000],
	);
}
beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	repo = new ExternalUsageRepository(new BunSqlAdapter(db));
});
test("same rollout in two homes counts once by the global key", async () => {
	window("a", 100);
	expect(
		(await repo.ingest([event(), event({ sessionId: "copy" })])).inserted,
	).toBe(1);
	const sums = await new RequestRepository(
		new BunSqlAdapter(db),
	).aggregateTokensByModel("a", 0, 2000);
	expect(sums[0].inputTokens).toBe(100);
	expect(sums[0].requestCount).toBe(0);
});
test("ambiguous event with no session votes stays unattributed", async () => {
	window("a", 99);
	window("b", 101);
	await repo.ingest([event()]);
	expect(
		db.query("SELECT account_id FROM external_usage_events").get(),
	).toEqual({ account_id: null });
});
test("exact wins near; unique near wins; session majority resolves no signal", async () => {
	window("a", 100);
	window("b", 102);
	await repo.ingest([
		event(),
		event({ timestamp: "two", eventTs: 1001, rateLimitResetsAt: 99 }),
		event({ timestamp: "three", eventTs: 1002, rateLimitResetsAt: null }),
	]);
	expect(
		db.query("SELECT DISTINCT account_id FROM external_usage_events").all(),
	).toEqual([{ account_id: "a" }]);
});
test("later windows re-resolve NULL rows without re-inserting", async () => {
	await repo.ingest([event()]);
	window("a", 100);
	const result = await repo.ingest([]);
	expect(result.reattributed).toBe(1);
	expect(result.affected).toEqual([{ accountId: "a", eventTs: 1000 }]);
});
test("cloud configured account and half-open bounds merge with request totals", async () => {
	await repo.ingest([
		event({ sourceKind: "cloud", accountId: "a" }),
		event({
			sourceKind: "cloud",
			accountId: "a",
			eventTs: 2000,
			timestamp: "end",
		}),
	]);
	const sums = await new RequestRepository(
		new BunSqlAdapter(db),
	).aggregateTokensByModel("a", 1000, 2000);
	expect(sums[0].inputTokens).toBe(100);
	expect(sums[0].cacheReadInputTokens).toBe(20);
});

test("session voting counts only direct reset evidence across incremental scans", async () => {
	window("a", 100);
	window("b", 200);
	await repo.ingest([
		event(),
		...Array.from({ length: 10 }, (_, i) =>
			event({ timestamp: `voted-${i}`, rateLimitResetsAt: null }),
		),
	]);
	await repo.ingest([
		event({ timestamp: "b1", rateLimitResetsAt: 200 }),
		event({ timestamp: "b2", rateLimitResetsAt: 200 }),
		event({ timestamp: "new-unresolved", rateLimitResetsAt: null }),
	]);
	expect(
		db
			.query(
				"SELECT account_id FROM external_usage_events WHERE timestamp='new-unresolved'",
			)
			.get(),
	).toEqual({ account_id: "b" });
});
test("external prompt threshold classifies each event and excludes reasoning double count", async () => {
	await repo.ingest([
		event({
			sourceKind: "cloud",
			accountId: "a",
			inputTokens: 100001,
			cacheReadInputTokens: 0,
			outputTokens: 20,
			reasoningOutputTokens: 15,
			totalTokens: 100021,
		}),
		event({
			sourceKind: "cloud",
			accountId: "a",
			timestamp: "small",
			inputTokens: 100000,
			cacheReadInputTokens: 0,
			outputTokens: 10,
			reasoningOutputTokens: 5,
			totalTokens: 100010,
		}),
	]);
	const [sum] = await new RequestRepository(
		new BunSqlAdapter(db),
	).aggregateTokensByModel("a", 0, 2000);
	expect(sum.outputTokens).toBe(30);
	expect(sum.longContext.requestCount).toBe(0);
	expect(sum.longContext.inputTokens).toBe(100001);
});
test("ingest retains durable closed window repair requests across process restarts", async () => {
	window("a", 100);
	db.run("UPDATE usage_windows SET closed_at=100000 WHERE account_id='a'");
	await repo.ingest([event()]);
	const restarted = new ExternalUsageRepository(new BunSqlAdapter(db));
	expect((await restarted.ingest([])).affected).toEqual([
		{ accountId: "a", eventTs: 0 },
	]);
});
test("source index round trips nanosecond metadata and stores no message bodies", async () => {
	const source = {
		path: "/tmp/home/sessions/rollout-safe.jsonl",
		size: 123,
		mtimeNs: "1792000000000000000",
		sessionId: "s",
		parentId: null,
		sessionTimestamp: "2026-10-18T00:00:00Z",
		lastScannedAt: 10,
	};
	await repo.saveSource(source);
	await repo.saveSource({ ...source, size: 124 });
	expect(await repo.getSources()).toEqual([{ ...source, size: 124 }]);
});
test("configured cloud evidence can attribute a NULL duplicate without counting it twice", async () => {
	await repo.ingest([event()]);
	const result = await repo.ingest([
		event({ sourceKind: "cloud", accountId: "a" }),
	]);
	expect(result.inserted).toBe(0);
	expect(result.reattributed).toBe(1);
	expect(
		db.query("SELECT account_id FROM external_usage_events").all(),
	).toEqual([{ account_id: "a" }]);
});
test("source replacement removes newly recognized replay but preserves cross-home copies", async () => {
	window("a", 100);
	await repo.replaceSources([
		{ path: "home1", events: [event(), event({ timestamp: "own" })] },
		{ path: "home2", events: [event()] },
	]);
	await repo.replaceSources([
		{ path: "home1", events: [event({ timestamp: "own" })] },
	]);
	expect(
		db.query("SELECT COUNT(*) AS count FROM external_usage_events").get(),
	).toEqual({ count: 2 });
	await repo.replaceSources([{ path: "home2", events: [] }]);
	expect(db.query("SELECT timestamp FROM external_usage_events").all()).toEqual(
		[{ timestamp: "own" }],
	);
});

test("scan lease excludes other processes and fences expired owner's writes", async () => {
	const other = new ExternalUsageRepository(new BunSqlAdapter(db));
	expect(await repo.acquireScanLease("first", Date.now(), 10000)).toBe(true);
	expect(await other.acquireScanLease("second", Date.now(), 10000)).toBe(false);
	await repo.ingest([event()]);
	db.run(
		"UPDATE external_usage_scan_lease SET expires_at=0 WHERE owner='first'",
	);
	expect(await other.acquireScanLease("second", Date.now(), 10000)).toBe(true);
	await expect(
		repo.replaceSources([{ path: "source", events: [] }]),
	).rejects.toThrow();
	await expect(
		repo.saveSource({
			path: "source",
			size: 0,
			mtimeNs: "0",
			sessionId: null,
			parentId: null,
			sessionTimestamp: null,
			lastScannedAt: 0,
		}),
	).rejects.toThrow();
	expect(await repo.renewScanLease("first")).toBe(false);
	await repo.releaseScanLease("first");
	expect(
		await new ExternalUsageRepository(new BunSqlAdapter(db)).acquireScanLease(
			"third",
		),
	).toBe(false);
	await other.releaseScanLease("second");
	expect(await repo.acquireScanLease("first")).toBe(true);
});

test("an ingest racing window closure retains a durable repair after restart", async () => {
	window("a", 100);
	await repo.ingest([event()]);
	expect(await repo.pendingAffected()).toEqual([]);
	db.run("UPDATE usage_windows SET closed_at=100000 WHERE account_id='a'");
	const restarted = new ExternalUsageRepository(new BunSqlAdapter(db));
	expect((await restarted.ingest([])).affected).toEqual([
		{ accountId: "a", eventTs: 0 },
	]);
});
test("bounded insert and provenance batches preserve dedupe across batch boundaries", async () => {
	const events = Array.from({ length: 600 }, (_, index) =>
		event({ timestamp: `event-${index}`, eventTs: index }),
	);
	const result = await repo.replaceSources([
		{ path: "/home-one/rollout.jsonl", events },
		{ path: "/home-two/rollout.jsonl", events },
	]);
	expect(result.inserted).toBe(600);
	expect((await repo.report()).reduce((sum, row) => sum + row.rows, 0)).toBe(
		600,
	);
	await repo.replaceSources([{ path: "/home-one/rollout.jsonl", events: [] }]);
	expect((await repo.report()).reduce((sum, row) => sum + row.rows, 0)).toBe(
		600,
	);
});

test("duplicates do not journal pending windows again", async () => {
	window("a", 100);
	await repo.ingest([event()]);
	db.run("DELETE FROM external_usage_pending_windows");
	expect((await repo.ingest([event()])).affected).toEqual([]);
	expect(
		db.query("SELECT COUNT(*) AS n FROM external_usage_pending_windows").get(),
	).toEqual({ n: 0 });
});

test("a vote yields to later exact evidence", async () => {
	window("a", 100);
	await repo.ingest([
		event(),
		event({ timestamp: "vote", rateLimitResetsAt: 200 }),
	]);
	expect(
		db
			.query(
				"SELECT attribution_basis FROM external_usage_events WHERE timestamp='vote'",
			)
			.get(),
	).toEqual({ attribution_basis: "vote" });
	window("b", 200);
	await repo.ingest([]);
	expect(
		db
			.query(
				"SELECT account_id,attribution_basis FROM external_usage_events WHERE timestamp='vote'",
			)
			.get(),
	).toEqual({ account_id: "b", attribution_basis: "exact" });
});

test("vote moves journal both accounts and ties retain the current vote", async () => {
	window("a", 100);
	window("b", 200);
	await repo.ingest([
		event(),
		event({ timestamp: "vote", rateLimitResetsAt: null }),
	]);
	db.run("DELETE FROM external_usage_pending_windows");
	await repo.ingest([
		event({ timestamp: "b1", rateLimitResetsAt: 200 }),
		event({ timestamp: "b2", rateLimitResetsAt: 200 }),
	]);
	expect(
		db
			.query(
				"SELECT account_id FROM external_usage_events WHERE timestamp='vote'",
			)
			.get(),
	).toEqual({ account_id: "b" });
	expect(
		db
			.query(
				"SELECT window_id FROM external_usage_pending_windows ORDER BY window_id",
			)
			.all(),
	).toEqual([{ window_id: "a100" }, { window_id: "b200" }]);
	await repo.ingest([event({ timestamp: "a2" })]);
	expect(
		db
			.query(
				"SELECT account_id FROM external_usage_events WHERE timestamp='vote'",
			)
			.get(),
	).toEqual({ account_id: "b" });
});

test("resolution batches and bounds assignments and skips unchanged ticks", async () => {
	const { spyOn } = await import("bun:test");
	const adapter = new BunSqlAdapter(db);
	repo = new ExternalUsageRepository(adapter);
	await repo.ingest(
		Array.from({ length: 2000 }, (_, i) =>
			event({
				timestamp: `bulk-${i}`,
				sessionId: `s-${i % 50}`,
				rateLimitResetsAt: i < 50 ? 100 : null,
			}),
		),
	);
	window("a", 100);
	db.run("UPDATE usage_windows SET started_at=500");
	await repo.ingest(
		[event({ timestamp: "old", eventTs: 100, rateLimitResetsAt: null })],
		{ resolve: false },
	);
	const batches = spyOn(adapter, "runBatchWithChanges");
	expect((await repo.ingest([])).reattributed).toBe(2000);
	expect(batches.mock.calls.length).toBeLessThanOrEqual(Math.ceil(2000 / 256));
	batches.mockRestore();
	const query = spyOn(adapter, "query");
	await repo.replaceSources([]);
	expect(
		query.mock.calls.filter(([sql]) =>
			String(sql).includes("SELECT id,session_id"),
		).length,
	).toBe(0);
	query.mockRestore();
	expect(
		db
			.query(
				"SELECT account_id FROM external_usage_events WHERE timestamp='old'",
			)
			.get(),
	).toEqual({ account_id: null });
});

test("two proxy requests and three external events count two requests", async () => {
	for (let i = 0; i < 2; i++)
		db.run(
			"INSERT INTO requests(id,timestamp,method,path,status_code,account_used,billing_type,model,input_tokens,output_tokens) VALUES(?,1000,'POST','/v1/messages',200,'a','plan','gpt-6-astra',10,2)",
			[`r${i}`],
		);
	await repo.ingest(
		Array.from({ length: 3 }, (_, i) =>
			event({ timestamp: `e${i}`, sourceKind: "cloud", accountId: "a" }),
		),
	);
	const [sum] = await new RequestRepository(
		new BunSqlAdapter(db),
	).aggregateTokensByModel("a", 0, 2000);
	expect(sum.requestCount).toBe(2);
	expect(sum.inputTokens).toBe(320);
	expect(sum.outputTokens).toBe(94);
});

test("exact near and cloud bases are final during resolution", async () => {
	window("a", 100);
	await repo.ingest([
		event(),
		event({ timestamp: "near", rateLimitResetsAt: 99 }),
		event({ timestamp: "cloud", sourceKind: "cloud", accountId: "a" }),
	]);
	window("b", 99);
	await repo.ingest(
		Array.from({ length: 4 }, (_, i) =>
			event({ timestamp: `b-${i}`, rateLimitResetsAt: 99 }),
		),
	);
	expect(
		db
			.query(
				"SELECT timestamp,account_id,attribution_basis FROM external_usage_events WHERE timestamp IN ('1970-01-01T00:00:01Z','near','cloud') ORDER BY timestamp",
			)
			.all(),
	).toEqual([
		{
			timestamp: "1970-01-01T00:00:01Z",
			account_id: "a",
			attribution_basis: "exact",
		},
		{ timestamp: "cloud", account_id: "a", attribution_basis: "cloud" },
		{ timestamp: "near", account_id: "a", attribution_basis: "near" },
	]);
});

test("a cloud claim journals its window once and duplicates journal nothing", async () => {
	window("a", 100);
	await repo.ingest([event({ rateLimitResetsAt: null })]);
	expect(
		(await repo.ingest([event({ sourceKind: "cloud", accountId: "a" })]))
			.reattributed,
	).toBe(1);
	expect(
		db.query("SELECT attribution_basis FROM external_usage_events").get(),
	).toEqual({ attribution_basis: "cloud" });
	expect(
		db.query("SELECT COUNT(*) AS n FROM external_usage_pending_windows").get(),
	).toEqual({ n: 1 });
	db.run("DELETE FROM external_usage_pending_windows");
	const duplicate = await repo.ingest([
		event({ sourceKind: "cloud", accountId: "a" }),
	]);
	expect(duplicate.affected).toEqual([]);
	expect(
		db.query("SELECT COUNT(*) AS n FROM external_usage_pending_windows").get(),
	).toEqual({ n: 0 });
});

test("deleting direct evidence triggers a new vote without inserted rows", async () => {
	window("a", 100);
	window("b", 200);
	await repo.replaceSources([
		{ path: "a", events: [event(), event({ timestamp: "a2" })] },
		{ path: "b", events: [event({ timestamp: "b", rateLimitResetsAt: 200 })] },
		{
			path: "vote",
			events: [event({ timestamp: "vote", rateLimitResetsAt: null })],
		},
	]);
	expect(
		db
			.query(
				"SELECT account_id FROM external_usage_events WHERE timestamp='vote'",
			)
			.get(),
	).toEqual({ account_id: "a" });
	const result = await repo.replaceSources([{ path: "a", events: [] }]);
	expect(result.inserted).toBe(0);
	expect(result.reattributed).toBe(1);
	expect(
		db
			.query(
				"SELECT account_id FROM external_usage_events WHERE timestamp='vote'",
			)
			.get(),
	).toEqual({ account_id: "b" });
});
