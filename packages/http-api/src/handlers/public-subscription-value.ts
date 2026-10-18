import { Logger } from "@better-ccflare/logger";
import {
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
	options: { getConfig?: () => string | undefined; now?: () => number } = {},
) {
	const getConfig =
		options.getConfig ??
		(() => process.env.BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS);
	const now = options.now ?? Date.now;
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

	async function refresh(
		mappings: PublicSubscriptionMapping[],
		at: number,
	): Promise<PublicSubscriptionValue> {
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
				else
					log.info("Public subscriptions enabled", {
						subscriptions: config.mappings.length,
					});
			}
			if (config.status === "invalid")
				return response({ error: "Unavailable" }, 503);
			const at = now();
			if (!timestamp(at)) throw new FeedUnavailable("clock");
			let entry = cache;
			if (
				!entry ||
				entry.raw !== raw ||
				at < entry.body.generatedAt ||
				at >= entry.expiresAt
			) {
				let pending = refreshes.get(raw);
				if (!pending) {
					pending = refresh(config.mappings, at);
					refreshes.set(raw, pending);
				}
				let body: PublicSubscriptionValue;
				try {
					body = await pending;
				} finally {
					if (refreshes.get(raw) === pending) refreshes.delete(raw);
				}
				if (getConfig() !== raw) throw new FeedUnavailable("config_changed");
				entry = {
					raw,
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
