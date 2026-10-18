import { Logger } from "@better-ccflare/logger";
import { getPublicRosterGeneration } from "../services/public-subscription-roster";
import {
	isValidPublicId,
	isValidPublicLabel,
	MAX_PUBLIC_SUBSCRIPTIONS,
	type PublicSubscriptionMapping,
	parsePublicSubscriptionsConfig,
} from "../services/public-subscriptions-config";
import {
	toUsageWindowRecord,
	type UsageWindowRecord,
	valueOpenWindow,
} from "../services/usage-window-read";
import type { APIContext } from "../types";

interface PublicValueWindow {
	startedAt: number;
	resetsAt: number;
	closedAt: number | null;
	valueUsd: number | null;
	pricingCoverage: "complete" | "partial" | "unknown";
	partialFirstObservation: boolean;
}
interface PublicSubscriptionValue {
	schemaVersion: 1;
	valueBasis: "api_equivalent_usd";
	windowKey: "seven_day";
	generatedAt: number;
	subscriptions: Array<{
		id: string;
		label: string;
		sourceObservedAt: number | null;
		current: PublicValueWindow | null;
		completed: PublicValueWindow[];
	}>;
}

const CACHE_MS = 60_000;
/** Source clocks may lead this server by at most five seconds. */
const CLOCK_SKEW_MS = 5_000;
const timestamp = (value: number): boolean =>
	Number.isSafeInteger(value) && value >= 0;
function publicWindow(
	window: UsageWindowRecord,
	valueUsd: number | null,
	now: number,
): PublicValueWindow {
	if (
		!timestamp(window.startedAt) ||
		!timestamp(window.resetsAt) ||
		window.resetsAt <= window.startedAt ||
		window.startedAt > now ||
		(window.closedAt !== null &&
			(!timestamp(window.closedAt) ||
				window.closedAt < window.startedAt ||
				window.closedAt > now + CLOCK_SKEW_MS)) ||
		(valueUsd !== null && (!Number.isFinite(valueUsd) || valueUsd < 0))
	)
		throw new FeedUnavailable("invalid_window");
	const unpriced = window.unpricedTokens;
	return {
		startedAt: window.startedAt,
		resetsAt: window.resetsAt,
		closedAt: window.closedAt,
		valueUsd,
		pricingCoverage:
			unpriced !== null && unpriced > 0
				? "partial"
				: unpriced === 0 && valueUsd !== null
					? "complete"
					: "unknown",
		partialFirstObservation: window.grantType === "first_observed",
	};
}

function response(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

class FeedUnavailable extends Error {
	constructor(
		readonly reason: string,
		readonly publicId?: string,
	) {
		super(reason);
	}
}
const log = new Logger("PublicSubscriptionValueHandler");

/** A read-only, explicitly enrolled projection. Public requests never select accounts or periods. */
export function createPublicSubscriptionValueHandler(
	context: APIContext,
	options: {
		getConfig?: () => string | undefined;
		now?: () => number;
		/** Roster generation for the DB-backed ("accounts") mode cache key. */
		getRosterGeneration?: () => number;
	} = {},
) {
	const getConfig =
		options.getConfig ??
		(() => process.env.BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS);
	const now = options.now ?? Date.now;
	const getGeneration =
		options.getRosterGeneration ?? getPublicRosterGeneration;
	const loggedConfigs = new Set<string | undefined>();
	const loggedFailures = new Map<string, number>();
	const refreshes = new Map<
		string | undefined,
		Promise<PublicSubscriptionValue>
	>();
	let cache:
		| {
				raw: string | undefined;
				body: PublicSubscriptionValue;
				expiresAt: number;
		  }
		| undefined;

	function logFailure(error: unknown) {
		const reason =
			error instanceof FeedUnavailable ? error.reason : "unexpected";
		// A broken clock must not prevent diagnostics, or hide the original error.
		let at = 0;
		try {
			const value = now();
			if (timestamp(value)) at = value;
		} catch {
			/* log the original failure */
		}
		const previous = loggedFailures.get(reason);
		if (previous !== undefined && at >= previous && at - previous < CACHE_MS)
			return;
		loggedFailures.set(reason, at);
		if (error instanceof FeedUnavailable)
			log.warn("Public subscription value unavailable", {
				reason,
				...(error.publicId ? { id: error.publicId } : {}),
			});
		else log.error("Public subscription value unavailable: unexpected", error);
	}

	/**
	 * Reads the published roster. Called only from refresh (a cache miss), so the
	 * database is never queried per public request. Anything malformed fails the
	 * whole feed closed.
	 */
	async function readRoster(): Promise<PublicSubscriptionMapping[]> {
		const rows = await context.dbOps.listPublishedPublicValue(
			MAX_PUBLIC_SUBSCRIPTIONS + 1,
		);
		if (rows.length > MAX_PUBLIC_SUBSCRIPTIONS)
			throw new FeedUnavailable("too_many");
		const ids = new Set<string>();
		const labels = new Set<string>();
		const mappings: PublicSubscriptionMapping[] = [];
		for (const row of rows) {
			const label = row.public_value_label;
			const id = row.public_value_id;
			const createdAt = Number(row.created_at);
			if (!isValidPublicLabel(label)) throw new FeedUnavailable("bad_label");
			if (!isValidPublicId(id)) throw new FeedUnavailable("bad_id");
			if (!timestamp(createdAt))
				throw new FeedUnavailable("bad_account_created_at", id);
			const labelKey = label.toLowerCase();
			if (ids.has(id)) throw new FeedUnavailable("duplicate_id", id);
			if (labels.has(labelKey))
				throw new FeedUnavailable("duplicate_label", id);
			ids.add(id);
			labels.add(labelKey);
			mappings.push({
				accountId: row.id,
				accountCreatedAt: createdAt,
				id,
				label,
			});
		}
		return mappings.sort(
			(a, b) =>
				(a.label.toLowerCase() < b.label.toLowerCase()
					? -1
					: a.label.toLowerCase() > b.label.toLowerCase()
						? 1
						: 0) || a.accountCreatedAt - b.accountCreatedAt,
		);
	}

	async function refresh(
		source: PublicSubscriptionMapping[] | "accounts",
		at: number,
	): Promise<PublicSubscriptionValue> {
		const fromRoster = source === "accounts";
		const mappings = fromRoster ? await readRoster() : source;
		const subscriptions = await Promise.all(
			mappings.map(async (mapping) => {
				const [snapshot, open, closed] = await Promise.all([
					context.dbOps.getLatestUsageSnapshot(mapping.accountId, "seven_day"),
					context.dbOps.getOpenUsageWindow(mapping.accountId, "seven_day"),
					context.dbOps.listUsageWindows({
						accountId: mapping.accountId,
						windowKey: "seven_day",
						closedOnly: true,
						limit: 8,
						startedAtOrAfter: mapping.accountCreatedAt,
					}),
				]);
				const current =
					open &&
					open.startedAt >= mapping.accountCreatedAt &&
					open.startedAt <= at &&
					at < open.resetsAt
						? await valueOpenWindow(context.dbOps, open, at)
						: null;
				// Check generation after every read, including live valuation: replaced
				// accounts must never publish rows belonging to their prior generation.
				const account = await context.dbOps.getAccount(mapping.accountId);
				if (!account || account.created_at !== mapping.accountCreatedAt)
					throw new FeedUnavailable("generation_mismatch", mapping.id);
				// Roster mode: the row must still be published exactly as read.
				if (
					fromRoster &&
					(account.public_value_enabled !== true ||
						account.public_value_label !== mapping.label ||
						account.public_value_id !== mapping.id)
				)
					throw new FeedUnavailable("roster_changed", mapping.id);
				const observed = snapshot?.timestamp;
				return {
					id: mapping.id,
					label: mapping.label,
					sourceObservedAt:
						observed !== undefined &&
						timestamp(observed) &&
						observed >= mapping.accountCreatedAt &&
						observed <= at + CLOCK_SKEW_MS
							? observed
							: null,
					current: current
						? publicWindow(current, current.valueSoFarUsd, at)
						: null,
					completed: closed.map((window) =>
						publicWindow(toUsageWindowRecord(window), window.valueUsd, at),
					),
				};
			}),
		);
		return {
			schemaVersion: 1,
			valueBasis: "api_equivalent_usd",
			windowKey: "seven_day",
			generatedAt: at,
			subscriptions,
		};
	}

	return async (): Promise<Response> => {
		try {
			const raw = getConfig();
			const config = parsePublicSubscriptionsConfig(raw);
			if (config.status === "disabled")
				return response({ error: "Not found" }, 404);
			if (!loggedConfigs.has(raw)) {
				loggedConfigs.add(raw);
				if (config.status === "invalid")
					log.warn("Invalid public subscriptions config", {
						reason: config.reason,
						...(config.index === undefined ? {} : { index: config.index }),
					});
				else if (config.status === "accounts")
					log.info("Public subscriptions enabled from the account roster");
				else
					log.info("Public subscriptions enabled", {
						subscriptions: config.mappings.length,
					});
			}
			if (config.status === "invalid")
				return response({ error: "Unavailable" }, 503);
			// Roster mode keys the cache on the write generation so an admin write
			// is visible on the next request, and never shares a key with env JSON.
			const generation = config.status === "accounts" ? getGeneration() : 0;
			const key = config.status === "accounts" ? `accounts:${generation}` : raw;
			const at = now();
			if (!timestamp(at)) throw new FeedUnavailable("clock");
			let entry = cache;
			if (
				!entry ||
				entry.raw !== key ||
				at < entry.body.generatedAt ||
				at >= entry.expiresAt
			) {
				let pending = refreshes.get(key);
				if (!pending) {
					pending = refresh(
						config.status === "accounts" ? "accounts" : config.mappings,
						at,
					);
					refreshes.set(key, pending);
				}
				let body: PublicSubscriptionValue;
				try {
					body = await pending;
				} finally {
					if (refreshes.get(key) === pending) refreshes.delete(key);
				}
				if (getConfig() !== raw) throw new FeedUnavailable("config_changed");
				if (config.status === "accounts" && getGeneration() !== generation)
					throw new FeedUnavailable("roster_changed");
				entry = {
					raw: key,
					body,
					expiresAt: Math.min(
						body.generatedAt + CACHE_MS,
						...body.subscriptions.flatMap((subscription) =>
							subscription.current ? [subscription.current.resetsAt] : [],
						),
					),
				};
			}
			const responseAt = now();
			if (!timestamp(responseAt)) throw new FeedUnavailable("clock");
			if (responseAt < entry.body.generatedAt || responseAt >= entry.expiresAt)
				throw new FeedUnavailable("expired");
			cache = entry;
			return response(entry.body);
		} catch (error) {
			logFailure(error);
			return response({ error: "Unavailable" }, 503);
		}
	};
}
