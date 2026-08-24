import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "@better-ccflare/database";
import { DatabaseOperations } from "@better-ccflare/database";
import { UsageWindowLedger } from "@better-ccflare/http-api";
import type { Account, CanonicalUsageWindow } from "@better-ccflare/types";

/**
 * Mirrors UsageWindowLedger's private `LEDGER_WINDOW_KEY` (issue #252, task
 * P1.3) — the only window key the ledger ever acts on. Duplicated here as a
 * literal (not imported: the ledger deliberately doesn't export it) rather
 * than made configurable, since replaying any other key through the ledger
 * would be silently discarded by `observeSnapshot` anyway.
 */
const WINDOW_KEY = "seven_day";

export interface RebuildWindowsOptions {
	/** Only replay raw snapshots at or after this timestamp. Default: 0 (all history). */
	sinceMs?: number;
	/** Replay against a throwaway clone of the database; write nothing to the real one. */
	dryRun?: boolean;
}

export interface RebuildWindowsRow {
	id: string;
	startedAt: number;
	resetsAt: number;
	closedAt: number | null;
	grantType: string;
	valueUsd: number | null;
	/** True when this window row did not exist before this run. */
	isNew: boolean;
	/** True when this window was open before this run and got closed during it. */
	wasClosedThisRun: boolean;
}

export interface AccountRebuildSummary {
	accountId: string;
	accountName: string;
	provider: string;
	/** Snapshots actually replayed this run (after the --since / resume floor). */
	snapshotCount: number;
	/** Effective lower bound used for this account's replay (see resume note below). */
	resumedFromMs: number;
	windows: RebuildWindowsRow[];
}

export interface RebuildWindowsResult {
	dryRun: boolean;
	sinceMs: number;
	accountsScanned: number;
	accounts: AccountRebuildSummary[];
	totalWindowsCreated: number;
	totalWindowsClosed: number;
	totalValueUsd: number;
}

interface DryRunClone {
	dbOps: DatabaseOperations;
	cleanup: () => Promise<void>;
}

/**
 * Clones the live SQLite file into a throwaway temp copy via `VACUUM INTO`,
 * then opens a full DatabaseOperations against the copy so --dry-run can run
 * the real write path (the ledger genuinely opens/updates/closes/prices
 * windows) without ever touching the source database.
 *
 * VACUUM INTO instead of a transaction rollback: BunSqlAdapter.transaction()
 * is a documented no-op for SQLite — it runs its callback entirely outside
 * any real transaction — so a rollback-based approach would provide no
 * isolation here. VACUUM INTO works from both a file-backed and an
 * in-memory source database; only PostgreSQL has no equivalent.
 */
async function cloneForDryRun(
	source: DatabaseOperations,
): Promise<DryRunClone> {
	if (!source.isSQLite) {
		throw new Error(
			"--dry-run is only supported against SQLite (no VACUUM INTO clone path for PostgreSQL).",
		);
	}
	const dir = mkdtempSync(join(tmpdir(), "ccflare-rebuild-windows-dryrun-"));
	const clonePath = join(dir, "clone.db");
	source.getAdapter().getSQLiteDb().exec("VACUUM INTO ?", [clonePath]);
	const cloneDbOps = new DatabaseOperations(clonePath, { walMode: false });
	return {
		dbOps: cloneDbOps,
		cleanup: async () => {
			await cloneDbOps.dispose();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Replays one account's raw `seven_day` snapshot history through
 * `UsageWindowLedger.observeSnapshot` — the exact same clustering/grant-type
 * decision logic the live poll loop uses, reused rather than duplicated.
 *
 * Resume boundary: if the account already has an open `seven_day` window
 * (from live polling, or from a previous run of this command), replay never
 * goes further back than that window's `startedAt`. Feeding the ledger
 * snapshots from BEFORE the currently-open window's start would make
 * `getOpenUsageWindow` return that unrelated later window while we're
 * "replaying" an earlier moment in history, and the ledger would then close
 * it using a stale historical timestamp — corrupting the one window that's
 * supposed to stay open. Re-feeding snapshots at/after that boundary is safe
 * and is what actually makes reruns idempotent: opening the same window
 * again is a no-op (`openWindow`'s natural-key ON CONFLICT), and
 * re-recording utilization for already-seen data can only leave
 * `peak_utilization`/`first_100_at` unchanged.
 *
 * Returns null when there is nothing to report for this account (no open
 * window and no snapshots in range).
 */
async function replayAccount(
	target: DatabaseOperations,
	account: Pick<Account, "id" | "name" | "provider">,
	sinceMs: number,
): Promise<AccountRebuildSummary | null> {
	const openBefore = await target.getOpenUsageWindow(account.id, WINDOW_KEY);
	const resumedFromMs = Math.max(sinceMs, openBefore?.startedAt ?? 0);
	const snapshots = await target
		.getUsageHistoryRepository()
		.getRawSnapshots(account.id, WINDOW_KEY, resumedFromMs);

	// Nothing to replay and nothing already ledgered: skip this account
	// entirely rather than padding the report with an empty row.
	if (snapshots.length === 0 && !openBefore) return null;

	return replayWithSnapshots(target, account, resumedFromMs, snapshots);
}

async function replayWithSnapshots(
	target: DatabaseOperations,
	account: Pick<Account, "id" | "name" | "provider">,
	resumedFromMs: number,
	snapshots: Array<{
		timestampMs: number;
		utilization: number;
		resetsAtMs: number | null;
	}>,
): Promise<AccountRebuildSummary> {
	const before = await target.listUsageWindows({
		accountId: account.id,
		windowKey: WINDOW_KEY,
	});
	const beforeById = new Map<string, UsageWindow>(before.map((w) => [w.id, w]));

	const ledger = new UsageWindowLedger(target);
	for (const snap of snapshots) {
		if (snap.resetsAtMs == null) continue; // matches observeSnapshot's own skip
		const window: CanonicalUsageWindow = {
			windowKey: WINDOW_KEY,
			utilization: snap.utilization,
			resetsAtMs: snap.resetsAtMs,
			scope: "account",
			modelFamily: null,
			active: true,
		};
		await ledger.observeSnapshot(account.id, [window], snap.timestampMs);
	}

	const after = await target.listUsageWindows({
		accountId: account.id,
		windowKey: WINDOW_KEY,
	});
	const windows: RebuildWindowsRow[] = after
		.slice()
		.sort((a, b) => a.startedAt - b.startedAt)
		.map((w) => {
			const prior = beforeById.get(w.id);
			return {
				id: w.id,
				startedAt: w.startedAt,
				resetsAt: w.resetsAt,
				closedAt: w.closedAt,
				grantType: w.grantType,
				valueUsd: w.valueUsd,
				isNew: !prior,
				// Closed as a RESULT of this run: covers both "was open before,
				// closed during this run" and "created and closed within this
				// same run" (a full backfill routinely does both in one pass) —
				// anything closed now that wasn't ALREADY closed before this run
				// started (prior undefined counts as "not already closed").
				wasClosedThisRun: w.closedAt != null && prior?.closedAt == null,
			};
		});

	return {
		accountId: account.id,
		accountName: account.name,
		provider: account.provider,
		snapshotCount: snapshots.length,
		resumedFromMs,
		windows,
	};
}

/**
 * Rebuilds `seven_day` windows for every account from raw usage_snapshots
 * history, by replaying them through the live UsageWindowLedger decision
 * logic (issue #252, task P1.4). The last window observed in each account's
 * stream is left open — it stays as the account's current live window.
 */
export async function rebuildWindows(
	dbOps: DatabaseOperations,
	options: RebuildWindowsOptions = {},
): Promise<RebuildWindowsResult> {
	const sinceMs = options.sinceMs ?? 0;
	const dryRun = options.dryRun ?? false;

	let clone: DryRunClone | null = null;
	let target: DatabaseOperations = dbOps;
	if (dryRun) {
		clone = await cloneForDryRun(dbOps);
		target = clone.dbOps;
	}

	try {
		const accounts = await target.getAllAccounts();
		const summaries: AccountRebuildSummary[] = [];
		for (const account of accounts) {
			const summary = await replayAccount(target, account, sinceMs);
			if (summary) summaries.push(summary);
		}

		let totalWindowsCreated = 0;
		let totalWindowsClosed = 0;
		let totalValueUsd = 0;
		for (const summary of summaries) {
			for (const w of summary.windows) {
				if (w.isNew) totalWindowsCreated++;
				if (w.wasClosedThisRun) totalWindowsClosed++;
				if (w.closedAt != null && w.valueUsd != null) {
					totalValueUsd += w.valueUsd;
				}
			}
		}

		return {
			dryRun,
			sinceMs,
			accountsScanned: accounts.length,
			accounts: summaries,
			totalWindowsCreated,
			totalWindowsClosed,
			totalValueUsd,
		};
	} finally {
		if (clone) await clone.cleanup();
	}
}

function formatTimestamp(ms: number | null): string {
	if (ms == null) return "-";
	return new Date(ms).toISOString();
}

function formatCurrency(v: number | null): string {
	if (v == null) return "-";
	return `$${v.toFixed(2)}`;
}

function rowChangeLabel(row: RebuildWindowsRow): string {
	if (row.isNew) return "NEW";
	if (row.wasClosedThisRun) return "CLOSED";
	return "-";
}

/** Pure formatter — no I/O — so it can be unit-tested without a database. */
export function formatRebuildWindowsReport(
	result: RebuildWindowsResult,
): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("=== Window Value Ledger Rebuild ===");
	lines.push(
		`Mode: ${result.dryRun ? "DRY RUN (no writes)" : "LIVE (writes applied)"}` +
			(result.sinceMs > 0
				? ` | since: ${formatTimestamp(result.sinceMs)}`
				: ""),
	);
	lines.push(`Accounts scanned: ${result.accountsScanned}`);

	if (result.accounts.length === 0) {
		lines.push("");
		lines.push("No accounts had 'seven_day' usage history to replay.");
	}

	for (const account of result.accounts) {
		lines.push("");
		lines.push(
			`Account: ${account.accountName} (${account.provider}) — ${account.snapshotCount} snapshot(s) replayed`,
		);
		if (account.windows.length === 0) {
			lines.push("  (no windows)");
			continue;
		}
		lines.push(
			"  " +
				"started".padEnd(24) +
				"resets".padEnd(24) +
				"status".padEnd(8) +
				"grant_type".padEnd(16) +
				"change".padEnd(8) +
				"value_usd",
		);
		lines.push(`  ${"─".repeat(88)}`);
		for (const w of account.windows) {
			lines.push(
				"  " +
					formatTimestamp(w.startedAt).padEnd(24) +
					formatTimestamp(w.resetsAt).padEnd(24) +
					(w.closedAt == null ? "OPEN" : "CLOSED").padEnd(8) +
					w.grantType.padEnd(16) +
					rowChangeLabel(w).padEnd(8) +
					formatCurrency(w.valueUsd),
			);
		}
	}

	lines.push("");
	lines.push("=== Totals ===");
	lines.push(`Accounts with data: ${result.accounts.length}`);
	lines.push(`Windows created: ${result.totalWindowsCreated}`);
	lines.push(`Windows closed this run: ${result.totalWindowsClosed}`);
	lines.push(
		`Total value (closed windows shown): ${formatCurrency(result.totalValueUsd)}`,
	);
	lines.push("");

	return lines.join("\n");
}
