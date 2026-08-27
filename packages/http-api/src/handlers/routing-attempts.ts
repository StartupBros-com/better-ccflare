import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import {
	ROUTING_ATTEMPT_SUMMARY_WINDOWS,
	type RoutingAttemptSummary,
	type RoutingAttemptSummaryWindow,
} from "@better-ccflare/types";

export interface RoutingAttemptSummaryReader {
	getRoutingAttemptSummary(input: {
		window: RoutingAttemptSummaryWindow;
		now?: number;
	}): Promise<RoutingAttemptSummary>;
}

function parseWindow(
	params: URLSearchParams,
): RoutingAttemptSummaryWindow | null {
	const values = params.getAll("window");
	if (values.length === 0) return "24h";
	if (values.length !== 1) return null;
	const [window] = values;
	return Object.hasOwn(ROUTING_ATTEMPT_SUMMARY_WINDOWS, window)
		? (window as RoutingAttemptSummaryWindow)
		: null;
}

/**
 * Serves a bounded, identifier-free aggregate of persisted upstream routing
 * events. A routing attempt is not a terminal client failure: the same logical
 * request can recover after one or more attempts.
 */
export function createRoutingAttemptsSummaryHandler(
	reader: RoutingAttemptSummaryReader,
) {
	return async (url: URL): Promise<Response> => {
		const window = parseWindow(url.searchParams);
		if (!window) {
			return errorResponse(
				BadRequest("window must be exactly one of: 1h, 24h, 7d"),
			);
		}

		const now = Date.now();
		const summary = await reader.getRoutingAttemptSummary({ window, now });
		return jsonResponse({
			...summary,
			window,
			generatedAt: new Date(now).toISOString(),
			windowStart: new Date(
				now - ROUTING_ATTEMPT_SUMMARY_WINDOWS[window],
			).toISOString(),
			windowEnd: new Date(now).toISOString(),
		});
	};
}
