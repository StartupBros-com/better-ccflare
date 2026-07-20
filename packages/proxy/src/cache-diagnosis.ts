/**
 * Privacy-safe prompt-cache diagnostics metadata.
 *
 * The former implementation retained complete request bodies and headers and
 * could replay them through the inference proxy. That made a debug feature a
 * second request-body store and an automated inference caller. The supported
 * contract is now deliberately read-only: when enabled, retain only bounded,
 * opaque per-session counters and timestamps. No prompt, header, model, or raw
 * session material is retained, and this module has no network path.
 */
import { opaqueRuntimeId } from "./opaque-runtime-id";

export const CACHE_DIAG_ENV = "CCFLARE_CACHE_DIAG";
/** Sessions tracked at once; least-recently observed is evicted beyond this. */
const MAX_TRACKED_SESSIONS = 8;

interface DiagnosisMetadata {
	requestCount: number;
	lastCapturedAt: number;
}

const sessions = new Map<string, DiagnosisMetadata>();

export function cacheDiagEnabled(): boolean {
	return process.env[CACHE_DIAG_ENV] === "1";
}

/**
 * Record only that a non-empty request was observed for an opaque session.
 * The body and headers are intentionally neither inspected nor retained.
 */
export function recordDiagnosisCandidate(
	sessionKey: string | null | undefined,
	body: ArrayBuffer | null,
	_headers: Headers,
): void {
	if (!cacheDiagEnabled() || !sessionKey || !body || body.byteLength === 0) {
		return;
	}

	const sessionId = opaqueRuntimeId("diag", sessionKey);
	const existing = sessions.get(sessionId);
	if (existing) {
		sessions.delete(sessionId);
		sessions.set(sessionId, {
			requestCount: Math.min(
				Number.MAX_SAFE_INTEGER,
				existing.requestCount + 1,
			),
			lastCapturedAt: Date.now(),
		});
		return;
	}

	if (sessions.size >= MAX_TRACKED_SESSIONS) {
		const oldest = sessions.keys().next().value;
		if (oldest !== undefined) sessions.delete(oldest);
	}
	sessions.set(sessionId, { requestCount: 1, lastCapturedAt: Date.now() });
}

export interface DiagnosisSessionInfo {
	session_id: string;
	request_count: number;
	has_pair: boolean;
	last_captured_at: string;
}

export function listDiagnosisSessions(): DiagnosisSessionInfo[] {
	return [...sessions.entries()].map(([sessionId, metadata]) => ({
		session_id: sessionId,
		request_count: metadata.requestCount,
		has_pair: metadata.requestCount >= 2,
		last_captured_at: new Date(metadata.lastCapturedAt).toISOString(),
	}));
}

/**
 * HTTP handler for POST /api/debug/cache-diagnosis.
 *
 * POST is retained for compatibility, but the operation is read-only and
 * never consumes its request body or performs a fetch.
 */
export async function handleCacheDiagnosisRequest(
	_req: Request,
): Promise<Response> {
	if (!cacheDiagEnabled()) {
		return json(
			{ status: "disabled", replay_enabled: false, sessions: [] },
			409,
		);
	}
	return json(
		{
			status: "metadata_only",
			replay_enabled: false,
			sessions: listDiagnosisSessions(),
		},
		200,
	);
}

/** Test and operational reset hook: clear retained metadata. */
export function resetCacheDiagnosis(): void {
	sessions.clear();
}

function json(payload: unknown, status: number): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
