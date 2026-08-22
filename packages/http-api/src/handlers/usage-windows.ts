// packages/http-api/src/handlers/usage-windows.ts
import { valueWindowAggregates } from "@better-ccflare/core";
import type { UsageWindow } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { APIContext } from "../types";

const log = new Logger("UsageWindowsHandler");

/** The only window key the ledger writes today (issue #252, task P1.3) —
 * used as the default when `window_key` is omitted from the query. */
const DEFAULT_WINDOW_KEY = "seven_day";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const HOUR_MS = 60 * 60 * 1000;

/** One closed-or-open `usage_windows` row, camelCased 1:1 — every ledger
 * column the issue asked for, including the parsed `modelBreakdown`. */
export interface UsageWindowRecord {
	id: string;
	accountId: string;
	windowKey: string;
	startedAt: number;
	resetsAt: number;
	closedAt: number | null;
	grantType: string;
	peakUtilization: number;
	first100At: number | null;
	valueUsd: number | null;
	inputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	outputTokens: number | null;
	requestCount: number | null;
	modelBreakdown: Record<string, unknown> | null;
	unpricedTokens: number | null;
	projectionVersion: string | null;
}

/** The still-open window, with its value computed live rather than read
 * from a (necessarily NULL, since it hasn't closed yet) `value_usd` column. */
export interface OpenUsageWindowRecord extends UsageWindowRecord {
	valueSoFarUsd: number;
	utilization: number;
	ageHours: number;
}

export interface AccountUsageWindowsResponse {
	accountId: string;
	accountName: string;
	provider: string;
	windows: UsageWindowRecord[];
	openWindow: OpenUsageWindowRecord | null;
}

export interface FleetUsageWindowsResponse {
	accounts: AccountUsageWindowsResponse[];
}

function toRecord(window: UsageWindow): UsageWindowRecord {
	return {
		id: window.id,
		accountId: window.accountId,
		windowKey: window.windowKey,
		startedAt: window.startedAt,
		resetsAt: window.resetsAt,
		closedAt: window.closedAt,
		grantType: window.grantType,
		peakUtilization: window.peakUtilization,
		first100At: window.first100At,
		valueUsd: window.valueUsd,
		inputTokens: window.inputTokens,
		cacheReadInputTokens: window.cacheReadInputTokens,
		cacheCreationInputTokens: window.cacheCreationInputTokens,
		outputTokens: window.outputTokens,
		requestCount: window.requestCount,
		modelBreakdown: window.modelBreakdown,
		unpricedTokens: window.unpricedTokens,
		projectionVersion: window.projectionVersion,
	};
}

/** Parses & validates the `limit` query param, throwing a `BadRequest`
 * HttpError (caught by the handler below) on anything malformed or out of
 * range, rather than silently clamping — an operator asking for `limit=abc`
 * should see a 400, not a quietly-substituted default. */
function parseLimit(raw: string | null): number {
	if (raw == null) return DEFAULT_LIMIT;
	if (!/^\d+$/.test(raw)) {
		throw BadRequest(`limit must be a positive integer, got: ${raw}`);
	}
	const n = Number(raw);
	if (n < 1 || n > MAX_LIMIT) {
		throw BadRequest(`limit must be between 1 and ${MAX_LIMIT}, got: ${n}`);
	}
	return n;
}

/**
 * Splits one account's ledger rows for `windowKey` into the most recent
 * `limit` CLOSED windows (already priced, ordered `resets_at` desc — the
 * repository's own order, preserved by this filter) and the single open
 * window (if any), then live-values that open window.
 *
 * The open window's value is computed with the exact same inputs and
 * era-keying as `UsageWindowLedger.closeAndValue` uses when it eventually
 * closes this same window: `aggregateTokensByModel(accountId, startedAt,
 * nowMs)` fed through `valueWindowAggregates(aggregates, startedAt)` —
 * priced at the window's grant time, not "now", so a mid-window price change
 * never retroactively re-prices usage that already happened under the old
 * rate.
 */
async function buildAccountResponse(
	context: APIContext,
	account: Pick<Account, "id" | "name" | "provider">,
	allWindows: readonly UsageWindow[],
	limit: number,
	nowMs: number,
): Promise<AccountUsageWindowsResponse> {
	const open = allWindows.find((w) => w.closedAt == null) ?? null;
	const closed = allWindows.filter((w) => w.closedAt != null).slice(0, limit);

	let openWindow: OpenUsageWindowRecord | null = null;
	if (open) {
		const aggregates = await context.dbOps.aggregateTokensByModel(
			account.id,
			open.startedAt,
			nowMs,
		);
		const valuation = valueWindowAggregates(aggregates, open.startedAt);
		openWindow = {
			...toRecord(open),
			valueSoFarUsd: valuation.valueUsd,
			utilization: open.peakUtilization,
			ageHours: (nowMs - open.startedAt) / HOUR_MS,
		};
	}

	return {
		accountId: account.id,
		accountName: account.name,
		provider: account.provider,
		windows: closed.map(toRecord),
		openWindow,
	};
}

/**
 * GET /api/usage-windows?account=<id|all>&window_key=<key>&limit=<n> — the
 * Window Value Ledger's read side (issue #252, task P1.5): closed, priced
 * windows plus the live-valued open window, for one account or every
 * account that has ledger history for `window_key`.
 *
 * Mirrors createUsageHistoryHandler's registration/auth pattern: no auth is
 * done here directly, the router's AuthService gates the route before this
 * handler ever runs (see router.ts's `/api/usage-history` registration for
 * the sibling wiring this copies).
 */
export function createUsageWindowsHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const accountParam = searchParams.get("account");
		const windowKey = searchParams.get("window_key") ?? DEFAULT_WINDOW_KEY;

		let limit: number;
		try {
			limit = parseLimit(searchParams.get("limit"));
		} catch (error) {
			return errorResponse(error);
		}

		try {
			const nowMs = Date.now();

			// account=all (or the param omitted entirely) requests the fleet-wide
			// view: one entry per account that has at least one ledger row for
			// this window_key.
			if (!accountParam || accountParam === "all") {
				const accounts = await context.dbOps.getAllAccounts();
				const results: AccountUsageWindowsResponse[] = [];
				for (const account of accounts) {
					const allWindows = await context.dbOps.listUsageWindows({
						accountId: account.id,
						windowKey,
					});
					if (allWindows.length === 0) continue;
					results.push(
						await buildAccountResponse(
							context,
							account,
							allWindows,
							limit,
							nowMs,
						),
					);
				}
				const response: FleetUsageWindowsResponse = { accounts: results };
				return jsonResponse(response);
			}

			const account = await context.dbOps.getAccount(accountParam);
			if (!account) {
				return errorResponse(NotFound(`Account not found: ${accountParam}`));
			}

			const allWindows = await context.dbOps.listUsageWindows({
				accountId: account.id,
				windowKey,
			});
			const response = await buildAccountResponse(
				context,
				account,
				allWindows,
				limit,
				nowMs,
			);
			return jsonResponse(response);
		} catch (error) {
			log.error("Usage windows error:", error);
			return errorResponse(error);
		}
	};
}
