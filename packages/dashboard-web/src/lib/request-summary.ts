import type { RequestPayload, RequestSummary } from "../api";

/**
 * Build a lightweight RequestPayload from a RequestSummary.
 *
 * The list view only needs metadata; full bodies (which can be ~256KB each)
 * are lazy-loaded by RequestDetailsModal and CopyButton via /api/requests/payload/:id.
 * `meta.bodiesOmitted` signals to consumers that the bodies must be hydrated.
 */
export function summaryToPlaceholder(summary: RequestSummary): RequestPayload {
	// `accountUsed` is the resolved account name when the JOIN succeeds, else
	// the raw account ID. We put it in accountName so the row renders the
	// friendly name; the ID-only fallback is rare (only after account deletion).
	const accountName = summary.accountUsed ?? undefined;
	return {
		id: summary.id,
		request: { headers: {}, body: null },
		response:
			summary.statusCode != null
				? { status: summary.statusCode, headers: {}, body: null }
				: null,
		error: summary.errorMessage ?? undefined,
		meta: {
			accountName,
			timestamp: new Date(summary.timestamp).getTime(),
			success: summary.success,
			pending: false,
			path: summary.path,
			method: summary.method,
			agentUsed: summary.agentUsed,
			agentAttributionSource: summary.agentAttributionSource,
			project: summary.project,
			projectAttributionSource: summary.projectAttributionSource,
			// Server derives this from statusCode === 429 so the list view can
			// render the Rate Limited badge without lazy-loading the body.
			rateLimited: summary.rateLimited,
			bodiesOmitted: true,
		},
	};
}

// Apply a terminal summary without replacing the pending row's attribution or
// already-loaded headers/bodies. The summary stays separate for tokens and cost.
export function applyRequestSummary(
	request: RequestPayload,
	summary: RequestSummary,
): RequestPayload {
	return {
		...request,
		response:
			summary.statusCode != null
				? {
						...(request.response ?? { headers: {}, body: null }),
						status: summary.statusCode,
					}
				: null,
		error: summary.errorMessage ?? undefined,
		meta: {
			...request.meta,
			agentUsed: summary.agentUsed ?? request.meta.agentUsed,
			agentAttributionSource:
				summary.agentAttributionSource ?? request.meta.agentAttributionSource,
			project: summary.project ?? request.meta.project,
			projectAttributionSource:
				summary.projectAttributionSource ??
				request.meta.projectAttributionSource,
			pending: false,
			success: summary.success,
			rateLimited: summary.rateLimited,
			bodiesOmitted: true,
		},
	};
}
