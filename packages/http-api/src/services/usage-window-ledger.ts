import {
	VALUE_PRICING_VERSION,
	valueWindowAggregates,
} from "@better-ccflare/core";
import type { DatabaseOperations, UsageWindow } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
import type { AlertService } from "./alerts";

const log = new Logger("UsageWindowLedger");

/**
 * Only this exact window key is ledgered (issue #252, task P1.3). `five_hour`
 * has no stable long-lived value story yet; `seven_day_<modelFamily>` and any
 * other slug variant, plus legacy junk keys from older provider payloads, are
 * deliberately out of scope — whitelisting a single literal key is safer than
 * trying to enumerate everything to exclude.
 */
const LEDGER_WINDOW_KEY = "seven_day";

/**
 * A provider's reported `resets_at` for the SAME underlying window jitters by
 * a few seconds between polls (clock skew, rounding in the upstream API).
 * Two snapshots whose resets_at differ by no more than this are treated as
 * the same window; anything larger is a genuine rollover or bonus reset.
 * Sized well above observed jitter (seconds) and well below the smallest
 * real gap between distinct windows (hours), per the 2026-08 audit.
 */
const CLUSTER_TOLERANCE_MS = 120_000;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tracks the value of each account's rolling 'seven_day' usage window: opens
 * a ledger row the first time a window is observed, keeps it updated as
 * utilization rises, and closes + prices it the moment the provider reports
 * a different window (a rollover or an early/bonus reset) — see
 * `observeSnapshot` for the exact clustering/grant-type rules.
 *
 * Instantiated once alongside `AlertService` and driven from the same usage
 * poll callbacks in apps/server/src/server.ts, right after
 * `evaluateUsageSnapshot`. Every public entry point mirrors AlertService's
 * resilience contract: a single window's failure is logged and swallowed,
 * never allowed to break the poll loop or take down sibling accounts/windows.
 *
 * `alertService` is optional (mirrors this class's own tests, which
 * construct it without one) and drives the `usage_window_value_drop` alert
 * (issue #252, task P1.6): closeAndValue calls back into
 * `alertService.evaluateClosedWindow` right after a successful close, with
 * the same swallow-and-log isolation as every other window-level failure in
 * this class — an alert failure must never surface as a closeAndValue
 * failure.
 */
export class UsageWindowLedger {
	constructor(
		private readonly dbOps: DatabaseOperations,
		private readonly alertService?: AlertService,
	) {}

	/**
	 * Processes one poll's worth of canonical usage windows for `accountId`.
	 * Non-'seven_day' keys and windows with no resets_at are skipped outright
	 * (no ledger row, no error). Each remaining window is handled inside its
	 * own try/catch so one bad window (or one account, since this is called
	 * once per account per poll) can never cancel the rest of the poll loop —
	 * matches `AlertService.evaluateUsageSnapshot`'s per-window resilience.
	 */
	async observeSnapshot(
		accountId: string,
		windows: readonly CanonicalUsageWindow[],
		timestampMs: number,
	): Promise<void> {
		for (const window of windows) {
			if (window.windowKey !== LEDGER_WINDOW_KEY) continue;
			if (window.resetsAtMs == null) continue;
			try {
				await this.observeWindow(
					accountId,
					window.resetsAtMs,
					window.utilization,
					timestampMs,
				);
			} catch (error) {
				log.warn(
					`Usage window ledger failed for account ${accountId}/${window.windowKey}: ${error}`,
				);
			}
		}
	}

	/**
	 * Decision table (see class doc for the resilience contract around this):
	 *
	 *  | open window?        | condition                                             | result                                    |
	 *  |----------------------|--------------------------------------------------------|--------------------------------------------|
	 *  | none                 | (any)                                                   | open: grant_type='first_observed'          |
	 *  | same cluster         | \|resetsAtMs - open.resetsAt\| <= 120_000ms             | recordUsageWindowUtilization on open       |
	 *  | different cluster    | open.resetsAt - 120_000 > timestampMs (old had runway)  | close old, open: grant_type='early_reset'  |
	 *  | different cluster    | open.resetsAt - 120_000 <= timestampMs (old was due)    | close old, open: grant_type='natural'      |
	 */
	private async observeWindow(
		accountId: string,
		resetsAtMs: number,
		utilization: number,
		timestampMs: number,
	): Promise<void> {
		const open = await this.dbOps.getOpenUsageWindow(
			accountId,
			LEDGER_WINDOW_KEY,
		);

		if (open) {
			if (Math.abs(resetsAtMs - open.resetsAt) <= CLUSTER_TOLERANCE_MS) {
				await this.dbOps.recordUsageWindowUtilization(
					open.id,
					utilization,
					timestampMs,
				);
				return;
			}

			// Different cluster: the open window's life ends here, priced through
			// to the moment this new cluster was first observed.
			await this.closeAndValue(open, timestampMs, timestampMs);

			// The old window still had days of runway left when a new cluster
			// showed up -> the provider granted an early/bonus reset. If the old
			// window's own reset time had already arrived (or was about to),
			// this is just the ordinary weekly rollover.
			const grantType =
				open.resetsAt - CLUSTER_TOLERANCE_MS > timestampMs
					? "early_reset"
					: "natural";

			const next = await this.dbOps.openUsageWindow({
				accountId,
				windowKey: LEDGER_WINDOW_KEY,
				startedAt: timestampMs,
				resetsAt: resetsAtMs,
				grantType,
			});
			await this.dbOps.recordUsageWindowUtilization(
				next.id,
				utilization,
				timestampMs,
			);
			return;
		}

		// No open window for this account/key at all: this is the very first
		// observation. Back-date started_at to the natural 7-day cycle start
		// implied by resets_at, but never into the future relative to the
		// moment we're observing it at — a window cannot start after the
		// instant it was first seen.
		const naturalStart = resetsAtMs - SEVEN_DAYS_MS;
		const startedAt = Math.min(naturalStart, timestampMs);
		const next = await this.dbOps.openUsageWindow({
			accountId,
			windowKey: LEDGER_WINDOW_KEY,
			startedAt,
			resetsAt: resetsAtMs,
			grantType: "first_observed",
		});
		await this.dbOps.recordUsageWindowUtilization(
			next.id,
			utilization,
			timestampMs,
		);
	}

	/**
	 * Closes `window` and records its final valuation, computed from every
	 * plan-billed `/v1/messages` request in `[window.startedAt, upperBoundMs)`
	 * where `upperBoundMs` is `newStartedAtMs` when a successor window is
	 * being opened in the same beat (so the two windows partition time with
	 * no gap or overlap), else `closedAtMs` (a trailing close with no
	 * successor yet, e.g. from a future backfill CLI).
	 *
	 * Pricing is looked up at `window.startedAt`, NOT at close time: a
	 * window's value reflects the list price in force when it was GRANTED, so
	 * a mid-window price change never retroactively re-prices usage that
	 * already happened under the old rate. This is a deliberate design
	 * choice, not an oversight — keep it if this method is ever touched.
	 *
	 * Exposed as a public method (not inlined into observeWindow) specifically
	 * so the planned historical backfill CLI (issue #252, later task) can
	 * reuse this exact logic against closed-but-unpriced legacy windows.
	 */
	async closeAndValue(
		window: UsageWindow,
		closedAtMs: number,
		newStartedAtMs?: number,
	): Promise<boolean> {
		const upperBoundMs = newStartedAtMs ?? closedAtMs;
		const aggregates = await this.dbOps.aggregateTokensByModel(
			window.accountId,
			window.startedAt,
			upperBoundMs,
		);
		const valuation = valueWindowAggregates(aggregates, window.startedAt);
		const closeInput = {
			closedAt: closedAtMs,
			valueUsd: valuation.valueUsd,
			inputTokens: valuation.inputTokens,
			cacheReadInputTokens: valuation.cacheReadInputTokens,
			cacheCreationInputTokens: valuation.cacheCreationInputTokens,
			outputTokens: valuation.outputTokens,
			requestCount: valuation.requestCount,
			modelBreakdown: valuation.modelBreakdown,
			unpricedTokens: valuation.unpricedTokens,
			projectionVersion: VALUE_PRICING_VERSION,
		};
		const closed = await this.dbOps.closeUsageWindow(window.id, closeInput);
		if (closed && this.alertService) {
			// Isolation, not detachment: awaited so the guarantee ("an alert
			// failure must never break the ledger") is deterministic and
			// testable, matching observeWindow's own try/catch above rather
			// than an un-awaited promise this class can't otherwise observe.
			try {
				const closedWindow: UsageWindow = { ...window, ...closeInput };
				await this.notifyClosedWindow(closedWindow);
			} catch (error) {
				log.warn(
					`usage_window_value_drop evaluation failed for account ${window.accountId} window ${window.id}: ${error}`,
				);
			}
		}
		return closed;
	}

	/**
	 * Resolves the account's CURRENT name (not a closure-captured one — the
	 * same "resolve at dispatch" rule server.ts's alert-evaluation callback
	 * already follows for usage_window_threshold/usage_window_exhaustion_
	 * projected) and hands the closed window to AlertService for the
	 * usage_window_value_drop evaluation.
	 */
	private async notifyClosedWindow(closedWindow: UsageWindow): Promise<void> {
		if (!this.alertService) return;
		const account = await this.dbOps.getAccount(closedWindow.accountId);
		await this.alertService.evaluateClosedWindow(
			closedWindow,
			account?.name ?? closedWindow.accountId,
		);
	}
}
