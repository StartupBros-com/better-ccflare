import { QualityRouteError } from "@better-ccflare/database";
import type { QualityRouteService } from "@better-ccflare/proxy";
import type { QualitySessionControlStatus } from "../types";

const MAX_BODY_BYTES = 4096;
class ControlBodyError extends Error {
	constructor(readonly status: number) {
		super("Invalid quality control body");
	}
}
async function readRetryBody(req: Request): Promise<{
	incarnation: string;
	expectedIntentRevision: number;
	idempotencyToken: string;
}> {
	if (
		req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
		"application/json"
	)
		throw new ControlBodyError(415);
	if (req.headers.has("content-encoding")) throw new ControlBodyError(415);
	const declared = req.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
	)
		throw new ControlBodyError(413);
	const reader = req.body?.getReader();
	if (!reader) throw new ControlBodyError(400);
	const buffer = new Uint8Array(MAX_BODY_BYTES);
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (size + chunk.value.byteLength > MAX_BODY_BYTES) {
				void reader.cancel().catch(() => {});
				throw new ControlBodyError(413);
			}
			buffer.set(chunk.value, size);
			size += chunk.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				buffer.subarray(0, size),
			),
		);
	} catch {
		throw new ControlBodyError(400);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ControlBodyError(400);
	const body = value as Record<string, unknown>;
	if (
		Object.keys(body).length !== 3 ||
		typeof body.incarnation !== "string" ||
		body.incarnation.length < 1 ||
		body.incarnation.length > 256 ||
		typeof body.idempotencyToken !== "string" ||
		body.idempotencyToken.length < 1 ||
		body.idempotencyToken.length > 512 ||
		typeof body.expectedIntentRevision !== "number" ||
		!Number.isSafeInteger(body.expectedIntentRevision) ||
		body.expectedIntentRevision < 1
	)
		throw new ControlBodyError(400);
	return {
		incarnation: body.incarnation,
		expectedIntentRevision: body.expectedIntentRevision,
		idempotencyToken: body.idempotencyToken,
	};
}

/** Reserve the namespace, including malformed siblings, from proxy fallthrough. */
export function isQualityControlPath(path: string): boolean {
	// Decode ASCII escapes for classification only, even if a later segment has
	// invalid encoding. The handler still requires the exact literal route shape.
	const classified = path.replace(/%([0-9a-f]{2})/gi, (_escape, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
	return classified.startsWith("/v1/quality-routing");
}
function reply(status: number, body: unknown): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
export async function handleQualityControl(
	req: Request,
	path: string,
	principalId: string | undefined,
	service: QualityRouteService | undefined,
): Promise<Response> {
	if (!principalId) return reply(401, { status: "denied" });
	const parts = path.split("/");
	if (
		parts[1] !== "v1" ||
		parts[2] !== "quality-routing" ||
		parts[3] !== "sessions" ||
		(parts.length !== 5 &&
			!(parts.length === 6 && parts[5] === "retry-preferred"))
	)
		return reply(404, { status: "unknown" });
	let sessionId: string;
	try {
		sessionId = decodeURIComponent(parts[4] ?? "");
	} catch {
		return reply(400, { status: "invalid" });
	}
	if (
		!sessionId ||
		sessionId.length > 256 ||
		[...sessionId].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x20 || code === 0x7f || "/%\\?#".includes(character);
		})
	)
		return reply(400, { status: "invalid" });
	if (
		(parts.length === 5 && req.method !== "GET") ||
		(parts.length === 6 && req.method !== "POST")
	)
		return reply(405, { status: "method-not-allowed" });
	if (!service) return reply(404, { status: "disabled" });
	const session = { verified: true as const, principalId, sessionId };
	if (parts.length === 6) {
		try {
			const payload = await readRetryBody(req);
			// One repository transaction owns replay/conflict semantics; never pre-read or dispatch.
			return reply(200, await service.retryPreferred({ ...payload, session }));
		} catch (error) {
			if (error instanceof ControlBodyError)
				return reply(error.status, { status: "invalid" });
			if (error instanceof QualityRouteError)
				return reply(
					error.code === "unavailable"
						? 404
						: error.code === "capacity"
							? 429
							: 409,
					{ status: error.code === "unavailable" ? "unknown" : error.code },
				);
			throw error;
		}
	}
	const state = await service.status(session);
	if (!state) return reply(404, { status: "unknown" });
	const root = state.conversations.find(
		(conversation) => conversation.key === "$root",
	);
	const inFlight = state.unresolved.some(
		(item) => item.identity.conversation === "$root",
	);
	return reply(200, {
		status: "known",
		incarnation: state.incarnation,
		intentRevision: state.intentRevision,
		preference: state.preference,
		expiresAt: state.expiresAt,
		pending: root?.pending ?? false,
		lastSuccessfulHome: root?.home ?? null,
		conversations: state.conversations,
		unresolved: state.unresolved,
		decisionState: inFlight
			? "in-flight"
			: root?.decision
				? "settled"
				: root?.pending
					? "pending"
					: "none",
		decision: inFlight ? null : (root?.decision?.value ?? null),
		decisionRequestId: inFlight ? null : (root?.decision?.requestId ?? null),
		lastSuccessfulDecision: root?.lastSuccessfulDecision?.value ?? null,
		lastSuccessfulDecisionRequestId:
			root?.lastSuccessfulDecision?.requestId ?? null,
	} satisfies QualitySessionControlStatus);
}
