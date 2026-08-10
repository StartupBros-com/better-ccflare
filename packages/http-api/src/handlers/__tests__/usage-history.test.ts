import { describe, expect, it } from "bun:test";
import type { UsageSnapshotRow } from "@better-ccflare/types";
import { createUsageHistoryHandler } from "../usage-history";

// Captures the opts passed to getUsageHistory so we can assert filter forwarding.
function makeContext(rows: UsageSnapshotRow[]) {
	const calls: Array<{
		accountId: string;
		windowKey?: string;
		since?: number;
	}> = [];
	const context = {
		dbOps: {
			getUsageHistory: async (opts: {
				accountId: string;
				windowKey?: string;
				since?: number;
			}) => {
				calls.push(opts);
				return rows;
			},
			getAllAccounts: async () => [],
		},
	} as unknown as import("../../types").APIContext;
	return { context, calls };
}

// Fleet mode: a per-account rows table plus an accounts list, both served
// through the same dbOps facade the handler already uses for single-account
// queries (getAllAccounts + getUsageHistory per account — no repository change).
function makeFleetContext(
	accounts: Array<{ id: string; name: string; rows: UsageSnapshotRow[] }>,
) {
	const calls: Array<{
		accountId: string;
		windowKey?: string;
		since?: number;
	}> = [];
	const context = {
		dbOps: {
			getAllAccounts: async () =>
				accounts.map((a) => ({ id: a.id, name: a.name })),
			getUsageHistory: async (opts: {
				accountId: string;
				windowKey?: string;
				since?: number;
			}) => {
				calls.push(opts);
				return accounts.find((a) => a.id === opts.accountId)?.rows ?? [];
			},
		},
	} as unknown as import("../../types").APIContext;
	return { context, calls };
}

describe("createUsageHistoryHandler", () => {
	it("groups rows by window and includes a prediction", async () => {
		const H = 60 * 60 * 1000;
		const rows: UsageSnapshotRow[] = [0, 1, 2, 3].map((h) => ({
			accountId: "acc1",
			timestamp: h * H,
			windowKey: "five_hour",
			utilization: 10 * h + 10,
			resetsAt: 20 * H,
		}));
		const { context } = makeContext(rows);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1&range=7d"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accountId: string;
			range: string;
			windows: {
				window: string;
				points: unknown[];
				prediction: { state: string };
			}[];
		};
		expect(body.accountId).toBe("acc1");
		expect(body.windows).toHaveLength(1);
		expect(body.windows[0].window).toBe("five_hour");
		expect(body.windows[0].points).toHaveLength(4);
		expect(body.windows[0].prediction.state).toBe("rising");
	});

	it("echoes the normalized range for an unknown value", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1&range=bogus"));
		const body = (await res.json()) as { range: string };
		expect(body.range).toBe("24h"); // unknown → getRangeConfig falls back to 24h
	});

	it("forwards the window filter to getUsageHistory", async () => {
		const { context, calls } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		await handler(new URLSearchParams("account=acc1&window=seven_day_opus"));
		expect(calls[0].accountId).toBe("acc1");
		expect(calls[0].windowKey).toBe("seven_day_opus");
	});

	it("returns an empty windows array when there are no rows", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1"));
		const body = (await res.json()) as { windows: unknown[] };
		expect(body.windows).toEqual([]);
	});

	describe("fleet mode (account=all or omitted)", () => {
		const H = 60 * 60 * 1000;

		it("returns a per-account fleet response for account=all", async () => {
			const { context } = makeFleetContext([
				{
					id: "acc1",
					name: "Acc One",
					rows: [
						{
							accountId: "acc1",
							timestamp: 0,
							windowKey: "five_hour",
							utilization: 10,
							resetsAt: null,
						},
						{
							accountId: "acc1",
							timestamp: H,
							windowKey: "seven_day",
							utilization: 20,
							resetsAt: null,
						},
					],
				},
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all&range=7d"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				range: string;
				accounts: {
					accountId: string;
					accountName: string;
					windows: { window: string; points: unknown[] }[];
				}[];
			};
			expect(body.range).toBe("7d");
			expect(body.accounts).toHaveLength(1);
			expect(body.accounts[0].accountId).toBe("acc1");
			expect(body.accounts[0].accountName).toBe("Acc One");
			const windowNames = body.accounts[0].windows.map((w) => w.window).sort();
			expect(windowNames).toEqual(["five_hour", "seven_day"]);
			// Fleet series carry no per-account prediction (chart-only payload).
			expect(body.accounts[0].windows[0]).not.toHaveProperty("prediction");
		});

		it("defaults to fleet mode when the account param is omitted entirely", async () => {
			const { context } = makeFleetContext([
				{
					id: "acc1",
					name: "Acc One",
					rows: [
						{
							accountId: "acc1",
							timestamp: 0,
							windowKey: "five_hour",
							utilization: 10,
							resetsAt: null,
						},
					],
				},
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams(""));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { accounts: unknown[] };
			expect(body.accounts).toHaveLength(1);
		});

		it("skips accounts with no snapshots in range", async () => {
			const { context } = makeFleetContext([
				{
					id: "acc1",
					name: "Has data",
					rows: [
						{
							accountId: "acc1",
							timestamp: 0,
							windowKey: "five_hour",
							utilization: 10,
							resetsAt: null,
						},
					],
				},
				{ id: "acc2", name: "No data", rows: [] },
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as {
				accounts: { accountId: string }[];
			};
			expect(body.accounts).toHaveLength(1);
			expect(body.accounts[0].accountId).toBe("acc1");
		});

		it("returns an empty accounts array when no account has any snapshots", async () => {
			const { context } = makeFleetContext([
				{ id: "acc1", name: "No data", rows: [] },
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as { accounts: unknown[] };
			expect(body.accounts).toEqual([]);
		});

		it("forwards the window filter to each per-account query", async () => {
			const { context, calls } = makeFleetContext([
				{ id: "acc1", name: "Acc One", rows: [] },
				{ id: "acc2", name: "Acc Two", rows: [] },
			]);
			const handler = createUsageHistoryHandler(context);
			await handler(new URLSearchParams("account=all&window=seven_day_opus"));
			expect(calls.map((c) => c.accountId).sort()).toEqual(["acc1", "acc2"]);
			for (const call of calls) {
				expect(call.windowKey).toBe("seven_day_opus");
			}
		});

		it("downsamples a series exceeding 500 points to at most 500, keeping the first and last point", async () => {
			const total = 800;
			const rows: UsageSnapshotRow[] = Array.from(
				{ length: total },
				(_, i) => ({
					accountId: "acc1",
					timestamp: i * 60_000,
					windowKey: "five_hour",
					utilization: i % 100,
					resetsAt: null,
				}),
			);
			const { context } = makeFleetContext([
				{ id: "acc1", name: "Acc One", rows },
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all&range=30d"));
			const body = (await res.json()) as {
				accounts: {
					windows: {
						window: string;
						points: { t: number; utilization: number }[];
					}[];
				}[];
			};
			const points = body.accounts[0].windows[0].points;
			expect(points.length).toBeLessThanOrEqual(500);
			expect(points[0]).toEqual({
				t: rows[0].timestamp,
				utilization: rows[0].utilization,
				resetsAt: rows[0].resetsAt,
			});
			const lastRow = rows[rows.length - 1];
			expect(points[points.length - 1]).toEqual({
				t: lastRow.timestamp,
				utilization: lastRow.utilization,
				resetsAt: lastRow.resetsAt,
			});
		});

		it("does not downsample a series at or under the 500-point cap", async () => {
			const rows: UsageSnapshotRow[] = Array.from({ length: 500 }, (_, i) => ({
				accountId: "acc1",
				timestamp: i * 60_000,
				windowKey: "five_hour",
				utilization: i % 100,
				resetsAt: null,
			}));
			const { context } = makeFleetContext([
				{ id: "acc1", name: "Acc One", rows },
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as {
				accounts: { windows: { points: unknown[] }[] }[];
			};
			expect(body.accounts[0].windows[0].points).toHaveLength(500);
		});
	});
});
