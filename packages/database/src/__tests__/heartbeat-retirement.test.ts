import { describe, expect, it } from "bun:test";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { startHeartbeatLoop } from "../multi-instance-guard";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function turns() {
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

describe("heartbeat loop retirement", () => {
	it("holds a pending cleanup and shares the same failed stop without repeating it", async () => {
		const clearing = deferred();
		let calls = 0;
		const adapter = {
			run: async () => {
				calls++;
				await clearing.promise;
			},
		} as unknown as BunSqlAdapter;
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 100_000,
			settlementTimeoutMs: 10,
		});
		const stopped = stop();
		try {
			await expect(stopped).rejects.toThrow("heartbeat retirement unconfirmed");
			expect(stop()).toBe(stopped);
			expect(calls).toBe(1);
		} finally {
			clearing.resolve();
			await stopped.catch(() => {});
		}
	});
	it("serializes ticks and waits for an in-flight write before deleting its row", async () => {
		const writing = deferred();
		const calls: string[] = [];
		const adapter = {
			run: async (sql: string) => {
				calls.push(sql.startsWith("DELETE") ? "delete" : "write");
				if (!sql.startsWith("DELETE")) await writing.promise;
			},
		} as unknown as BunSqlAdapter;
		const stop = startHeartbeatLoop(adapter, { intervalMs: 1 });
		try {
			await turns();
			expect(calls).toEqual(["write"]);
			const stopped = stop();
			expect(stop()).toBe(stopped);
			await turns();
			expect(calls).toEqual(["write"]);
			writing.resolve();
			await stopped;
			expect(calls).toEqual(["write", "delete"]);
			await turns();
			expect(calls).toHaveLength(2);
		} finally {
			writing.resolve();
			await stop();
		}
	});
	it("holds unresolved write ownership after its finite stop budget", async () => {
		const writing = deferred();
		const calls: string[] = [];
		const adapter = {
			run: async (sql: string) => {
				calls.push(sql.startsWith("DELETE") ? "delete" : "write");
				if (!sql.startsWith("DELETE")) await writing.promise;
			},
		} as unknown as BunSqlAdapter;
		const stop = startHeartbeatLoop(adapter, {
			intervalMs: 1,
			settlementTimeoutMs: 10,
		});
		await turns();
		try {
			await expect(stop()).rejects.toThrow("heartbeat retirement unconfirmed");
			expect(calls).toEqual(["write"]);
		} finally {
			writing.resolve();
			await stop().catch(() => {});
		}
	});
});
