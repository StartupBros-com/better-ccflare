import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import { BunSqlAdapter } from "../../../../database/src/adapters/bun-sql-adapter";
import { runMigrations } from "../../../../database/src/migrations";
import { RequestRepository } from "../../../../database/src/repositories/request.repository";
import { UsageWindowsRepository } from "../../../../database/src/repositories/usage-windows.repository";
import { UsageWindowLedger } from "../usage-window-ledger";
import { valueOpenWindow } from "../usage-window-read";

test("backfill re-aggregates closed source totals and guards a concurrent change", async () => {
	const sql = new Database(":memory:");
	runMigrations(sql);
	const adapter = new BunSqlAdapter(sql);
	const windows = new UsageWindowsRepository(adapter);
	const requests = new RequestRepository(adapter);
	const facade = {
		closeUsageWindow: windows.closeWindow.bind(windows),
		listUsageWindows: windows.listWindows.bind(windows),
		aggregateTokensByModel: requests.aggregateTokensByModel.bind(requests),
		getUsageWindowsRepository: () => windows,
		getOldestRequestTimestamp:
			DatabaseOperations.prototype.getOldestRequestTimestamp.bind({
				adapter,
			} as unknown as DatabaseOperations),
	} as unknown as DatabaseOperations;
	sql.run(
		"INSERT INTO requests(id,timestamp,method,path,account_used,model,input_tokens,billing_type) VALUES ('proxy',0,'POST','/v1/messages','a','unknown',7,'plan')",
	);
	const ledger = new UsageWindowLedger(facade);
	const w = await windows.openWindow({
		accountId: "a",
		windowKey: "seven_day",
		startedAt: 0,
		resetsAt: 2000,
		grantType: "natural",
	});
	await ledger.closeAndValue(w, 2000);
	sql.run(
		`INSERT INTO external_usage_events(id,account_id,source_kind,event_ts,timestamp,model,input_tokens,cache_read_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,is_fallback_model,session_id,ingested_at) VALUES ('e','a','cloud',1000,'one','unknown',100,20,30,10,150,0,'s',0)`,
	);
	expect(
		await ledger.reaggregateClosedWindows([{ accountId: "a", eventTs: 1000 }]),
	).toEqual({ rewritten: 1, skippedRetention: 0, failed: 0 });
	const updated = (await windows.listWindows())[0];
	expect(updated.inputTokens).toBe(107);
	expect(updated.unpricedTokens).toBe(157);
	expect(updated.requestCount).toBe(1);
	expect(
		await windows.reaggregateClosedWindow(
			w.id,
			{
				valueUsd: 1,
				inputTokens: 1,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				outputTokens: 0,
				requestCount: 1,
				modelBreakdown: {},
				unpricedTokens: 0,
				projectionVersion: "stale",
			},
			{ ...updated, inputTokens: 99 },
		),
	).toBe(false);
});

test("open reads and close include external usage while unknown models remain unpriced", async () => {
	const sql = new Database(":memory:");
	runMigrations(sql);
	const adapter = new BunSqlAdapter(sql);
	const windows = new UsageWindowsRepository(adapter);
	const requests = new RequestRepository(adapter);
	const facade = {
		closeUsageWindow: windows.closeWindow.bind(windows),
		aggregateTokensByModel: requests.aggregateTokensByModel.bind(requests),
	} as unknown as DatabaseOperations;
	const window = await windows.openWindow({
		accountId: "a",
		windowKey: "seven_day",
		startedAt: 0,
		resetsAt: 2000,
		grantType: "natural",
	});
	sql.run(
		`INSERT INTO external_usage_events(id,account_id,source_kind,event_ts,timestamp,model,input_tokens,cache_read_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,is_fallback_model,session_id,ingested_at) VALUES ('e','a','cloud',1000,'one','unknown',100,20,30,10,150,0,'s',0)`,
	);
	expect((await valueOpenWindow(facade, window, 2000)).unpricedTokens).toBe(
		150,
	);
	expect(await new UsageWindowLedger(facade).closeAndValue(window, 2000)).toBe(
		true,
	);
	const closed = (await windows.listWindows())[0];
	expect(closed.inputTokens).toBe(100);
	expect(closed.outputTokens).toBe(30);
	expect(closed.requestCount).toBe(0);
	expect(closed.unpricedTokens).toBe(150);
});

for (const oldest of [null, 1001]) {
	test(`retention guard preserves closed value and clears pending when oldest=${oldest}`, async () => {
		const sql = new Database(":memory:");
		runMigrations(sql);
		const windows = new UsageWindowsRepository(new BunSqlAdapter(sql));
		const window = await windows.openWindow({
			accountId: "a",
			windowKey: "seven_day",
			startedAt: 1000,
			resetsAt: 2000,
			grantType: "natural",
		});
		const requests = new RequestRepository(new BunSqlAdapter(sql));
		const facade = {
			closeUsageWindow: windows.closeWindow.bind(windows),
			listUsageWindows: windows.listWindows.bind(windows),
			aggregateTokensByModel: requests.aggregateTokensByModel.bind(requests),
			getUsageWindowsRepository: () => windows,
			getOldestRequestTimestamp: async () => oldest,
		} as unknown as DatabaseOperations;
		const ledger = new UsageWindowLedger(facade);
		await ledger.closeAndValue(window, 2000);
		sql.run(
			"INSERT INTO external_usage_pending_windows(window_id,revision) VALUES (?,?)",
			[window.id, "r"],
		);
		const before = (await windows.listWindows())[0];
		expect(
			await ledger.reaggregateClosedWindows([
				{ accountId: "a", eventTs: 1500 },
			]),
		).toEqual({ rewritten: 0, skippedRetention: 1, failed: 0 });
		expect((await windows.listWindows())[0]).toEqual(before);
		expect(await windows.pendingExternalRevision(window.id)).toBeNull();
		sql.close();
	});
}
test("another account's retained request does not authorize rebuilding a window that lost its own requests", async () => {
	const sql = new Database(":memory:");
	runMigrations(sql);
	const adapter = new BunSqlAdapter(sql);
	const windows = new UsageWindowsRepository(adapter);
	const requests = new RequestRepository(adapter);
	const facade = {
		closeUsageWindow: windows.closeWindow.bind(windows),
		listUsageWindows: windows.listWindows.bind(windows),
		aggregateTokensByModel: requests.aggregateTokensByModel.bind(requests),
		getUsageWindowsRepository: () => windows,
		getOldestRequestTimestamp:
			DatabaseOperations.prototype.getOldestRequestTimestamp.bind({
				adapter,
			} as unknown as DatabaseOperations),
	} as unknown as DatabaseOperations;
	sql.run(
		"INSERT INTO requests(id,timestamp,method,path,account_used,model,input_tokens,billing_type) VALUES ('a-old',0,'POST','/v1/messages','a','unknown',7,'plan'),('b-own',1500,'POST','/v1/messages','b','unknown',9,'plan'),('c-own',1500,'POST','/v1/messages','c','unknown',11,'plan')",
	);
	const ledger = new UsageWindowLedger(facade);
	for (const accountId of ["a", "b", "c"]) {
		const w = await windows.openWindow({
			accountId,
			windowKey: "seven_day",
			startedAt: accountId === "a" ? 0 : 1000,
			resetsAt: 2000,
			grantType: "natural",
		});
		await ledger.closeAndValue(w, 2000);
		sql.run(
			`INSERT INTO external_usage_events(id,account_id,source_kind,event_ts,timestamp,model,input_tokens,cache_read_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,is_fallback_model,session_id,ingested_at) VALUES (?,?,'cloud',1600,?,'unknown',100,20,30,10,150,0,'s',0)`,
			[`e-${accountId}`, accountId, `t-${accountId}`],
		);
	}
	// a's request at 0 keeps the global oldest ahead of every window start, but b has
	// lost the request its closed window counted and c's stored count is unknown.
	sql.run("DELETE FROM requests WHERE account_used='b'");
	sql.run("UPDATE usage_windows SET request_count=NULL WHERE account_id='c'");
	const byAccount = async () =>
		new Map((await windows.listWindows()).map((w) => [w.accountId, w]));
	const before = await byAccount();
	expect(
		await ledger.reaggregateClosedWindows(
			["a", "b", "c"].map((accountId) => ({ accountId, eventTs: 1600 })),
		),
	).toEqual({ rewritten: 1, skippedRetention: 2, failed: 0 });
	const after = await byAccount();
	expect(after.get("a")?.inputTokens).toBe(107);
	expect(after.get("a")?.requestCount).toBe(1);
	expect(after.get("b")).toEqual(before.get("b"));
	expect(after.get("c")).toEqual(before.get("c"));
	sql.close();
});
test("a failed aggregate leaves pending and continues to the next account", async () => {
	const sql = new Database(":memory:");
	runMigrations(sql);
	const windows = new UsageWindowsRepository(new BunSqlAdapter(sql));
	const requests = new RequestRepository(new BunSqlAdapter(sql));
	const facade = {
		closeUsageWindow: windows.closeWindow.bind(windows),
		listUsageWindows: windows.listWindows.bind(windows),
		aggregateTokensByModel: requests.aggregateTokensByModel.bind(requests),
		getUsageWindowsRepository: () => windows,
		getOldestRequestTimestamp: async () => 0,
	} as unknown as DatabaseOperations;
	const ledger = new UsageWindowLedger(facade);
	const ids: string[] = [];
	for (const accountId of ["a", "b"]) {
		const w = await windows.openWindow({
			accountId,
			windowKey: "seven_day",
			startedAt: 0,
			resetsAt: 2000,
			grantType: "natural",
		});
		await ledger.closeAndValue(w, 2000);
		ids.push(w.id);
		sql.run(
			"INSERT INTO external_usage_pending_windows(window_id,revision) VALUES (?,?)",
			[w.id, "r"],
		);
	}
	const spy = spyOn(facade, "aggregateTokensByModel").mockImplementation(
		async (account) => {
			if (account === "a") throw new Error("broken aggregate");
			return [];
		},
	);
	expect(
		await ledger.reaggregateClosedWindows([
			{ accountId: "a", eventTs: 1000 },
			{ accountId: "b", eventTs: 1000 },
		]),
	).toEqual({ rewritten: 1, skippedRetention: 0, failed: 1 });
	expect(await windows.pendingExternalRevision(ids[0])).toBe("r");
	expect(await windows.pendingExternalRevision(ids[1])).toBeNull();
	spy.mockRestore();
	sql.close();
});

test("oldest request facade returns null for empty storage and the global minimum", async () => {
	const sql = new Database(":memory:");
	runMigrations(sql);
	const adapter = new BunSqlAdapter(sql);
	const oldest = DatabaseOperations.prototype.getOldestRequestTimestamp.bind({
		adapter,
	} as unknown as DatabaseOperations);
	expect(await oldest()).toBeNull();
	sql.run(
		"INSERT INTO requests(id,timestamp,method,path) VALUES ('new',200,'POST','/v1/messages'),('old',100,'GET','/other')",
	);
	expect(await oldest()).toBe(100);
	sql.close();
});
