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

interface FleetCall {
	accountIds: string[];
	windowKey?: string;
	since?: number;
	until?: number;
	bucketMs?: number;
	pointBudget?: number;
}

/**
 * Fleet mode: the handler makes ONE set-based call to `getFleetUsageHistory`
 * for the whole fleet (#137). This stub stands in for the repository — it
 * concatenates the seeded rows for the requested accounts and applies the same
 * windowKey filter the SQL does, so handler-level assertions stay about
 * grouping/naming/ordering rather than re-testing the query.
 */
function makeFleetContext(
	accounts: Array<{ id: string; name: string; rows: UsageSnapshotRow[] }>,
	truncation?: Partial<{
		truncated: boolean;
		omittedAccountCount: number;
		omittedSeriesCount: number;
	}>,
) {
	const calls: FleetCall[] = [];
	const context = {
		dbOps: {
			getAllAccounts: async () =>
				accounts.map((a) => ({ id: a.id, name: a.name })),
			getFleetUsageHistory: async (opts: FleetCall) => {
				calls.push(opts);
				const requested = new Set(opts.accountIds);
				const rows = accounts
					.filter((a) => requested.has(a.id))
					.flatMap((a) => a.rows)
					.filter((r) => !opts.windowKey || r.windowKey === opts.windowKey);
				return {
					rows,
					truncated: truncation?.truncated ?? false,
					omittedAccountCount: truncation?.omittedAccountCount ?? 0,
					omittedSeriesCount: truncation?.omittedSeriesCount ?? 0,
					returnedPointCount: rows.length,
				};
			},
			// Present but must never be called in fleet mode — the per-account
			// fan-out this replaced is exactly the regression being fenced.
			getUsageHistory: async () => {
				throw new Error(
					"fleet mode must not issue per-account getUsageHistory calls",
				);
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

		it("issues exactly one set-based query for the whole fleet", async () => {
			const { context, calls } = makeFleetContext([
				{ id: "acc1", name: "Acc One", rows: [] },
				{ id: "acc2", name: "Acc Two", rows: [] },
				{ id: "acc3", name: "Acc Three", rows: [] },
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));

			expect(res.status).toBe(200);
			// One call regardless of fleet size — the whole point of #137. The
			// stubbed getUsageHistory throws, so a per-account fan-out would 500.
			expect(calls).toHaveLength(1);
			expect([...calls[0].accountIds].sort()).toEqual(["acc1", "acc2", "acc3"]);
		});

		it("forwards the window filter and range start on the single query", async () => {
			const { context, calls } = makeFleetContext([
				{ id: "acc1", name: "Acc One", rows: [] },
				{ id: "acc2", name: "Acc Two", rows: [] },
			]);
			const handler = createUsageHistoryHandler(context);
			const before = Date.now();
			await handler(
				new URLSearchParams("account=all&range=7d&window=seven_day_opus"),
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].windowKey).toBe("seven_day_opus");
			// `since` is the range start, and bucketing stays server-side so the
			// database bounds the work before rows leave it.
			expect(calls[0].since).toBeLessThanOrEqual(before - 6 * 24 * 60 * 60_000);
			expect(calls[0].bucketMs).toBeGreaterThanOrEqual(60_000);
		});

		it("reports a healthy non-truncated fleet as complete", async () => {
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
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as {
				truncated: boolean;
				omittedAccountCount: number;
				omittedSeriesCount: number;
				returnedPointCount: number;
				partial: boolean;
				failedAccounts: string[];
			};
			expect(body.truncated).toBe(false);
			expect(body.omittedAccountCount).toBe(0);
			expect(body.omittedSeriesCount).toBe(0);
			expect(body.returnedPointCount).toBe(1);
			// Compat fields the dashboard/API clients still parse.
			expect(body.partial).toBe(false);
			expect(body.failedAccounts).toEqual([]);
		});

		it("surfaces budget truncation metadata instead of presenting a budgeted fleet as complete", async () => {
			const { context } = makeFleetContext(
				[
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
				],
				{ truncated: true, omittedAccountCount: 3, omittedSeriesCount: 7 },
			);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as {
				truncated: boolean;
				omittedAccountCount: number;
				omittedSeriesCount: number;
				returnedPointCount: number;
				accounts: unknown[];
			};
			// Truncated is NOT partial: nothing failed, the response is just capped.
			expect(body.truncated).toBe(true);
			expect(body.omittedAccountCount).toBe(3);
			expect(body.omittedSeriesCount).toBe(7);
			expect(body.returnedPointCount).toBe(1);
			expect(body.accounts).toHaveLength(1);
		});

		it("names accounts from the already-loaded account list without extra queries", async () => {
			const { context, calls } = makeFleetContext([
				{
					id: "acc-z",
					name: "Alpha",
					rows: [
						{
							accountId: "acc-z",
							timestamp: 0,
							windowKey: "five_hour",
							utilization: 10,
							resetsAt: null,
						},
					],
				},
				{
					id: "acc-a",
					name: "Zulu",
					rows: [
						{
							accountId: "acc-a",
							timestamp: 0,
							windowKey: "five_hour",
							utilization: 20,
							resetsAt: null,
						},
					],
				},
			]);
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as {
				accounts: { accountId: string; accountName: string }[];
			};
			// Still one query: names come from the account list, not per-series reads.
			expect(calls).toHaveLength(1);
			// Deterministic account ordering by display name, not by row order.
			expect(body.accounts.map((a) => a.accountName)).toEqual([
				"Alpha",
				"Zulu",
			]);
			expect(body.accounts.map((a) => a.accountId)).toEqual(["acc-z", "acc-a"]);
		});

		it("falls back to the account id when the fleet returns an unknown account", async () => {
			const context = {
				dbOps: {
					getAllAccounts: async () => [],
					getFleetUsageHistory: async () => ({
						rows: [
							{
								accountId: "ghost",
								timestamp: 0,
								windowKey: "five_hour",
								utilization: 10,
								resetsAt: null,
							},
						],
						truncated: false,
						omittedAccountCount: 0,
						omittedSeriesCount: 0,
						returnedPointCount: 1,
					}),
				},
			} as unknown as import("../../types").APIContext;
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			const body = (await res.json()) as {
				accounts: { accountId: string; accountName: string }[];
			};
			// A deleted-mid-flight account must not crash or render as blank.
			expect(body.accounts[0].accountName).toBe("ghost");
		});

		it("returns 500 when the fleet query fails rather than an empty fleet", async () => {
			const context = {
				dbOps: {
					getAllAccounts: async () => [{ id: "acc1", name: "Acc One" }],
					getFleetUsageHistory: async () => {
						throw new Error("db down");
					},
				},
			} as unknown as import("../../types").APIContext;
			const handler = createUsageHistoryHandler(context);
			const res = await handler(new URLSearchParams("account=all"));
			// An empty 200 would render as "no account has any usage", which is a lie.
			expect(res.status).toBe(500);
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
						points: {
							t: number;
							utilization: number;
							resetsAt: number | null;
						}[];
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
