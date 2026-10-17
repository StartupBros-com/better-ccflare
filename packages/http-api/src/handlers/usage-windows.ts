// packages/http-api/src/handlers/usage-windows.ts
import {
	BadRequest,
	errorResponse,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	type OpenUsageWindowRecord,
	readUsageWindows,
	type UsageWindowRecord,
} from "../services/usage-window-read";
import type { APIContext } from "../types";

export type {
	OpenUsageWindowRecord,
	UsageWindowRecord,
} from "../services/usage-window-read";

const log = new Logger("UsageWindowsHandler");

/** The only window key the ledger writes today (issue #252, task P1.3) —
 * used as the default when `window_key` is omitted from the query. */
const DEFAULT_WINDOW_KEY = "seven_day";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

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
					results.push({
						accountId: account.id,
						accountName: account.name,
						provider: account.provider,
						...(await readUsageWindows(
							context.dbOps,
							account.id,
							windowKey,
							limit,
							nowMs,
							{ existingWindows: allWindows },
						)),
					});
				}
				const response: FleetUsageWindowsResponse = { accounts: results };
				return jsonResponse(response);
			}

			const account = await context.dbOps.getAccount(accountParam);
			if (!account) {
				return errorResponse(NotFound(`Account not found: ${accountParam}`));
			}

			const response: AccountUsageWindowsResponse = {
				accountId: account.id,
				accountName: account.name,
				provider: account.provider,
				...(await readUsageWindows(
					context.dbOps,
					account.id,
					windowKey,
					limit,
					nowMs,
				)),
			};
			return jsonResponse(response);
		} catch (error) {
			log.error("Usage windows error:", error);
			return errorResponse(error);
		}
	};
}
