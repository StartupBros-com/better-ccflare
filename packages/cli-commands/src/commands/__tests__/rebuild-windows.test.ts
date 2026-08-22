import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@better-ccflare/database";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
import {
	formatRebuildWindowsReport,
	type RebuildWindowsResult,
	rebuildWindows,
} from "../rebuild-windows";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = "acct-1";

function sevenDay(
	utilization: number,
	resetsAtMs: number | null,
): CanonicalUsageWindow {
	return {
		windowKey: "seven_day",
		utilization,
		resetsAtMs,
		scope: "account",
		modelFamily: null,
		active: true,
	};
}

async function seedAccount(
	dbOps: DatabaseOperations,
	opts: { id: string; name: string; provider?: string; createdAt?: number },
): Promise<void> {
	await dbOps
		.getAdapter()
		.run(
			`INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)`,
			[opts.id, opts.name, opts.provider ?? "anthropic", opts.createdAt ?? 0],
		);
}

async function seedSnapshot(
	dbOps: DatabaseOperations,
	accountId: string,
	utilization: number,
	resetsAtMs: number | null,
	timestampMs: number,
): Promise<void> {
	await dbOps.recordUsageSnapshot(
		accountId,
		[sevenDay(utilization, resetsAtMs)],
		timestampMs,
	);
}

async function seedRequest(
	dbOps: DatabaseOperations,
	opts: {
		id: string;
		timestamp: number;
		model: string;
		inputTokens?: number;
		outputTokens?: number;
		accountId?: string;
	},
): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			model, billing_type, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, ?, 'plan', ?, 0, 0, ?)`,
		[
			opts.id,
			opts.timestamp,
			opts.accountId ?? ACCOUNT_ID,
			opts.model,
			opts.inputTokens ?? 0,
			opts.outputTokens ?? 0,
		],
	);
}

// ---------------------------------------------------------------------------
// rebuildWindows — in-memory DB tests (no filesystem needed except --dry-run)
// ---------------------------------------------------------------------------

describe("rebuildWindows", () => {
	describe("basic replay", () => {
		let dbOps: DatabaseOperations;

		afterEach(async () => {
			await dbOps.dispose();
		});

		it("replays snapshots into an early_reset transition and prices the closed window", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });

			const t0 = Date.parse("2026-08-11T00:00:00Z");
			const oldResetsAt = t0 + 5 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 30, oldResetsAt, t0);

			// gpt-5.6-terra: input 2.0/M -> 1,000,000 input tokens = $2.00
			await seedRequest(dbOps, {
				id: "req-a",
				timestamp: t0 + 500,
				model: "gpt-5.6-terra",
				inputTokens: 1_000_000,
			});

			// Bonus/early reset: resets_at jumps forward while the old window
			// still had days of runway left.
			const t1 = t0 + 1_000;
			const newResetsAt = t1 + 7 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 0, newResetsAt, t1);

			const result = await rebuildWindows(dbOps, {});
			expect(result.dryRun).toBe(false);
			expect(result.accounts).toHaveLength(1);
			const account = result.accounts[0];
			expect(account.accountId).toBe(ACCOUNT_ID);
			expect(account.snapshotCount).toBe(2);
			expect(account.windows).toHaveLength(2);

			const closed = account.windows.find((w) => w.resetsAt === oldResetsAt);
			const opened = account.windows.find((w) => w.resetsAt === newResetsAt);
			expect(closed?.closedAt).toBe(t1);
			expect(closed?.grantType).toBe("first_observed");
			expect(closed?.valueUsd).toBeCloseTo(2.0, 10);
			expect(closed?.isNew).toBe(true);

			expect(opened?.closedAt).toBeNull();
			expect(opened?.grantType).toBe("early_reset");
			expect(opened?.isNew).toBe(true);

			expect(result.totalWindowsCreated).toBe(2);
			expect(result.totalWindowsClosed).toBe(1);
			expect(result.totalValueUsd).toBeCloseTo(2.0, 10);
		});

		it("leaves the final window in each account's stream open", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });
			const t0 = Date.parse("2026-08-05T00:00:00Z");
			const resetsAt = t0 + DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 5, resetsAt, t0);

			const result = await rebuildWindows(dbOps, {});
			expect(result.accounts[0].windows).toHaveLength(1);
			expect(result.accounts[0].windows[0].closedAt).toBeNull();
			expect(result.accounts[0].windows[0].grantType).toBe("first_observed");
		});

		it("skips accounts with no seven_day snapshot history and no existing window", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Empty" });
			const result = await rebuildWindows(dbOps, {});
			expect(result.accountsScanned).toBe(1);
			expect(result.accounts).toHaveLength(0);
		});
	});

	describe("idempotency", () => {
		let dbOps: DatabaseOperations;

		afterEach(async () => {
			await dbOps.dispose();
		});

		it("a second replay run with no new data leaves row count and closed-window aggregates unchanged", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });

			const t0 = Date.parse("2026-08-11T00:00:00Z");
			const oldResetsAt = t0 + 5 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 30, oldResetsAt, t0);
			await seedRequest(dbOps, {
				id: "req-a",
				timestamp: t0 + 500,
				model: "gpt-5.6-terra",
				inputTokens: 1_000_000,
			});
			const t1 = t0 + 1_000;
			const newResetsAt = t1 + 7 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 0, newResetsAt, t1);

			const first = await rebuildWindows(dbOps, {});
			const rowsAfterFirst = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});
			expect(rowsAfterFirst).toHaveLength(2);
			const closedAfterFirst = rowsAfterFirst.find((w) => w.closedAt != null);
			expect(closedAfterFirst?.valueUsd).toBeCloseTo(2.0, 10);

			const second = await rebuildWindows(dbOps, {});
			const rowsAfterSecond = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});

			// Same row count — no duplicates.
			expect(rowsAfterSecond).toHaveLength(rowsAfterFirst.length);
			// The closed window's aggregates are byte-identical to the first run.
			const closedAfterSecond = rowsAfterSecond.find((w) => w.closedAt != null);
			expect(closedAfterSecond).toEqual(closedAfterFirst);
			// The second run created/closed nothing new.
			expect(second.totalWindowsCreated).toBe(0);
			expect(second.totalWindowsClosed).toBe(0);
			expect(first.totalValueUsd).toBeCloseTo(second.totalValueUsd, 10);
		});

		it("resumes from the currently-open window's start on a second run, correctly extending it with newly arrived data without corrupting earlier closed windows", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });

			const t0 = Date.parse("2026-08-11T00:00:00Z");
			const oldResetsAt = t0 + 5 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 30, oldResetsAt, t0);
			await seedRequest(dbOps, {
				id: "req-a",
				timestamp: t0 + 500,
				model: "gpt-5.6-terra",
				inputTokens: 1_000_000,
			});
			const t1 = t0 + 1_000;
			const newResetsAt = t1 + 7 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 0, newResetsAt, t1);

			await rebuildWindows(dbOps, {});
			const rowsAfterFirst = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});
			const closedAfterFirst = rowsAfterFirst.find((w) => w.closedAt != null);

			// Simulate a later live poll: same cluster (same resets_at), higher
			// utilization, arriving after the first rebuild-windows run.
			const t2 = t1 + 60_000;
			await seedSnapshot(dbOps, ACCOUNT_ID, 42, newResetsAt, t2);

			const second = await rebuildWindows(dbOps, {});
			const rowsAfterSecond = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});

			// Still exactly 2 windows: the new poll only updates the open one.
			expect(rowsAfterSecond).toHaveLength(2);
			// The already-closed window is untouched byte-for-byte.
			const closedAfterSecond = rowsAfterSecond.find((w) => w.closedAt != null);
			expect(closedAfterSecond).toEqual(closedAfterFirst);
			// The still-open window picked up the new peak utilization and is
			// still open (NOT prematurely closed by the replay).
			const openAfterSecond = rowsAfterSecond.find((w) => w.closedAt == null);
			expect(openAfterSecond?.resetsAt).toBe(newResetsAt);
			expect(openAfterSecond?.peakUtilization).toBe(42);
			expect(openAfterSecond?.closedAt).toBeNull();
			expect(second.totalWindowsCreated).toBe(0);
			expect(second.totalWindowsClosed).toBe(0);
		});
	});

	describe("--since filtering", () => {
		let dbOps: DatabaseOperations;

		afterEach(async () => {
			await dbOps.dispose();
		});

		it("only replays snapshots at or after sinceMs", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });

			const t0 = Date.parse("2026-08-01T00:00:00Z");
			const resetsAt = t0 + 6 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 10, resetsAt, t0);
			await seedSnapshot(dbOps, ACCOUNT_ID, 20, resetsAt, t0 + DAY_MS);
			const t2 = t0 + 2 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 30, resetsAt, t2);

			const result = await rebuildWindows(dbOps, { sinceMs: t2 - 1 });
			expect(result.sinceMs).toBe(t2 - 1);
			expect(result.accounts[0].snapshotCount).toBe(1);
			// Only the last (>= since) snapshot was replayed, so peak reflects
			// only that one utilization value.
			expect(result.accounts[0].windows[0].id).toBeDefined();
			const windows = await dbOps.listUsageWindows({ accountId: ACCOUNT_ID });
			expect(windows).toHaveLength(1);
			expect(windows[0].peakUtilization).toBe(30);
		});
	});

	describe("--dry-run", () => {
		let tmpDir: string;
		let dbOps: DatabaseOperations;

		afterEach(async () => {
			await dbOps.dispose();
			if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		});

		it("reports what would happen without writing to the real database", async () => {
			tmpDir = mkdtempSync(join(tmpdir(), "ccflare-rebuild-windows-test-"));
			const dbPath = join(tmpDir, "source.db");
			dbOps = new DatabaseOperations(dbPath, { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });

			const t0 = Date.parse("2026-08-11T00:00:00Z");
			const oldResetsAt = t0 + 5 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 30, oldResetsAt, t0);
			await seedRequest(dbOps, {
				id: "req-a",
				timestamp: t0 + 500,
				model: "gpt-5.6-terra",
				inputTokens: 1_000_000,
			});
			const t1 = t0 + 1_000;
			const newResetsAt = t1 + 7 * DAY_MS;
			await seedSnapshot(dbOps, ACCOUNT_ID, 0, newResetsAt, t1);

			const rowsBefore = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});
			expect(rowsBefore).toHaveLength(0);

			const result = await rebuildWindows(dbOps, { dryRun: true });
			expect(result.dryRun).toBe(true);
			expect(result.accounts).toHaveLength(1);
			expect(result.accounts[0].windows).toHaveLength(2);
			expect(result.totalWindowsCreated).toBe(2);
			expect(result.totalValueUsd).toBeCloseTo(2.0, 10);

			// The REAL database was never written to.
			const rowsAfter = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});
			expect(rowsAfter).toHaveLength(0);
		});

		it("also works against an in-memory source (VACUUM INTO clones it to a temp file)", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			await seedAccount(dbOps, { id: ACCOUNT_ID, name: "Primary" });
			const t0 = Date.parse("2026-08-05T00:00:00Z");
			await seedSnapshot(dbOps, ACCOUNT_ID, 5, t0 + DAY_MS, t0);

			const result = await rebuildWindows(dbOps, { dryRun: true });
			expect(result.dryRun).toBe(true);
			expect(result.accounts).toHaveLength(1);
			expect(result.accounts[0].windows).toHaveLength(1);

			// The in-memory source itself is untouched.
			const rowsAfter = await dbOps.listUsageWindows({
				accountId: ACCOUNT_ID,
			});
			expect(rowsAfter).toHaveLength(0);
		});

		it("throws a clear error for a non-SQLite (PostgreSQL) source", async () => {
			dbOps = new DatabaseOperations(":memory:", { walMode: false });
			const fakePgDbOps = { isSQLite: false } as unknown as DatabaseOperations;
			await expect(
				rebuildWindows(fakePgDbOps, { dryRun: true }),
			).rejects.toThrow(/PostgreSQL/i);
		});
	});
});

// ---------------------------------------------------------------------------
// formatRebuildWindowsReport — pure formatter, no database needed.
// ---------------------------------------------------------------------------

describe("formatRebuildWindowsReport", () => {
	function baseResult(
		overrides: Partial<RebuildWindowsResult> = {},
	): RebuildWindowsResult {
		return {
			dryRun: false,
			sinceMs: 0,
			accountsScanned: 1,
			accounts: [],
			totalWindowsCreated: 0,
			totalWindowsClosed: 0,
			totalValueUsd: 0,
			...overrides,
		};
	}

	it("reports an empty run with no accounts", () => {
		const text = formatRebuildWindowsReport(baseResult());
		expect(text).toContain("No accounts had 'seven_day' usage history");
		expect(text).toContain("Windows created: 0");
	});

	it("labels dry-run mode and marks new/closed windows in the per-account table", () => {
		const t0 = Date.parse("2026-08-20T00:00:00Z");
		const text = formatRebuildWindowsReport(
			baseResult({
				dryRun: true,
				accounts: [
					{
						accountId: "acct-1",
						accountName: "Primary",
						provider: "anthropic",
						snapshotCount: 2,
						resumedFromMs: 0,
						windows: [
							{
								id: "w1",
								startedAt: t0,
								resetsAt: t0 + 5 * DAY_MS,
								closedAt: t0 + 5 * DAY_MS + 1,
								grantType: "early_reset",
								valueUsd: 1653.42,
								isNew: false,
								wasClosedThisRun: true,
							},
							{
								id: "w2",
								startedAt: t0 + 5 * DAY_MS + 1,
								resetsAt: t0 + 12 * DAY_MS,
								closedAt: null,
								grantType: "natural",
								valueUsd: null,
								isNew: true,
								wasClosedThisRun: false,
							},
						],
					},
				],
				totalWindowsCreated: 1,
				totalWindowsClosed: 1,
				totalValueUsd: 1653.42,
			}),
		);
		expect(text).toContain("DRY RUN");
		expect(text).toContain("Primary (anthropic)");
		expect(text).toContain("early_reset");
		expect(text).toContain("CLOSED");
		expect(text).toContain("OPEN");
		expect(text).toContain("NEW");
		expect(text).toContain("$1653.42");
		expect(text).toContain("Windows created: 1");
		expect(text).toContain("Windows closed this run: 1");
	});
});
