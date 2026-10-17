import {
	type PublicSubscriptionMapping,
	parsePublicSubscriptionsConfig,
} from "../services/public-subscriptions-config";
import {
	readUsageWindows,
	type UsageWindowRecord,
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
				window.closedAt > now)) ||
		(valueUsd !== null && (!Number.isFinite(valueUsd) || valueUsd < 0))
	)
		throw new Error("Unavailable");
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

/** A read-only, explicitly enrolled projection. Public requests never select accounts or periods. */
export function createPublicSubscriptionValueHandler(
	context: APIContext,
	options: { getConfig?: () => string | undefined; now?: () => number } = {},
) {
	const getConfig =
		options.getConfig ??
		(() => process.env.BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS);
	const now = options.now ?? Date.now;
	let configKey: string | undefined;
	let cache:
		| { fingerprint: string; expiresAt: number; body: PublicSubscriptionValue }
		| undefined;
	let flight:
		| { fingerprint: string; promise: Promise<PublicSubscriptionValue> }
		| undefined;
	let requestFlight:
		| { raw: string | undefined; promise: Promise<Response> }
		| undefined;

	async function inspect(mappings: PublicSubscriptionMapping[], at: number) {
		const states = await Promise.all(
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
				// Check generation after the awaited reads as replacement may occur
				// while the observation/history queries are in flight.
				const account = await context.dbOps.getAccount(mapping.accountId);
				if (!account || account.created_at !== mapping.accountCreatedAt)
					throw new Error("Unavailable");
				const observed = snapshot?.timestamp;
				const sourceObservedAt =
					observed !== undefined &&
					timestamp(observed) &&
					observed >= mapping.accountCreatedAt &&
					observed <= at + CLOCK_SKEW_MS
						? observed
						: null;
				return { mapping, sourceObservedAt, open, closed };
			}),
		);
		return { states, fingerprint: JSON.stringify(states) };
	}

	const handle = async (): Promise<Response> => {
		const raw = getConfig();
		if (raw !== configKey) {
			configKey = raw;
			cache = undefined;
			flight = undefined;
		}
		const config = parsePublicSubscriptionsConfig(raw);
		if (config.status === "disabled")
			return response({ error: "Not found" }, 404);
		if (config.status === "invalid")
			return response({ error: "Unavailable" }, 503);
		try {
			const at = now();
			if (!timestamp(at)) throw new Error("Unavailable");
			const inspected = await inspect(config.mappings, at);
			let body: PublicSubscriptionValue;
			if (
				cache &&
				cache.fingerprint === inspected.fingerprint &&
				at >= cache.body.generatedAt &&
				at < cache.expiresAt
			)
				body = cache.body;
			else {
				if (!flight || flight.fingerprint !== inspected.fingerprint) {
					const promise = (async (): Promise<PublicSubscriptionValue> => {
						const subscriptions = await Promise.all(
							inspected.states.map(async ({ mapping, sourceObservedAt }) => {
								const windows = await readUsageWindows(
									context.dbOps,
									mapping.accountId,
									"seven_day",
									8,
									at,
									{
										bounded: true,
										activeOnly: true,
										accountCreatedAt: mapping.accountCreatedAt,
									},
								);
								return {
									id: mapping.id,
									label: mapping.label,
									sourceObservedAt,
									current: windows.openWindow
										? publicWindow(
												windows.openWindow,
												windows.openWindow.valueSoFarUsd,
												at,
											)
										: null,
									completed: windows.windows.map((window) =>
										publicWindow(window, window.valueUsd, at),
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
					})();
					flight = { fingerprint: inspected.fingerprint, promise };
				}
				const pending = flight;
				try {
					body = await pending.promise;
				} finally {
					if (flight === pending) flight = undefined;
				}
			}
			// Validate after every await: neither a revoked mapping nor a replaced/cleared
			// generation can return a response assembled before the change.
			if (getConfig() !== raw) throw new Error("Unavailable");
			const finalAt = now();
			if (!timestamp(finalAt)) throw new Error("Unavailable");
			const verified = await inspect(config.mappings, finalAt);
			const responseAt = now();
			if (
				getConfig() !== raw ||
				!timestamp(responseAt) ||
				verified.fingerprint !== inspected.fingerprint ||
				responseAt < body.generatedAt ||
				responseAt >= body.generatedAt + CACHE_MS ||
				body.subscriptions.some(
					(entry) => entry.current && responseAt >= entry.current.resetsAt,
				)
			)
				throw new Error("Unavailable");
			cache = {
				fingerprint: inspected.fingerprint,
				body,
				expiresAt: Math.min(
					body.generatedAt + CACHE_MS,
					...body.subscriptions.flatMap((entry) =>
						entry.current ? [entry.current.resetsAt] : [],
					),
				),
			};
			return response(body);
		} catch {
			cache = undefined;
			return response({ error: "Unavailable" }, 503);
		}
	};
	return async (): Promise<Response> => {
		try {
			const raw = getConfig();
			if (!requestFlight || requestFlight.raw !== raw) {
				requestFlight = { raw, promise: handle() };
			}
			const pending = requestFlight;
			try {
				const result = await pending.promise;
				if (getConfig() !== raw) return response({ error: "Unavailable" }, 503);
				const responseAt = now();
				if (
					result.status === 200 &&
					(!timestamp(responseAt) ||
						!cache ||
						responseAt < cache.body.generatedAt ||
						responseAt >= cache.expiresAt)
				)
					return response({ error: "Unavailable" }, 503);
				return result.clone();
			} finally {
				if (requestFlight === pending) requestFlight = undefined;
			}
		} catch {
			cache = undefined;
			return response({ error: "Unavailable" }, 503);
		}
	};
}
