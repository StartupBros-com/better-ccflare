/**
 * Prompt-cache affinity headers for the ChatGPT-subscription Codex backend.
 *
 * The backend derives Responses prompt-cache affinity from the `session-id`
 * request header, not from the body's `prompt_cache_key` alone. The official
 * client (openai/codex, `core/src/client.rs` `responses_session_id`, and the
 * bc5957ea "Preserve parent cache affinity for ephemeral forks" change) sends
 * `session-id` equal to its prompt cache key on every Responses request and
 * WebSocket handshake, plus `thread-id` and an `x-codex-routing-hint` of
 * `model=<model>` so the request lands on the pool that already holds the
 * cached prefix.
 *
 * Without these headers a byte-identical continuation on the same account
 * and key was measured landing cold ~45% of the time (Sept 20-23, 2026
 * production traces) while the CLI on the same days stayed above 93%.
 *
 * One function owns the contract for every physical dispatch: the HTTP
 * request built by `CodexProvider.transformRequestBody`, and the WebSocket
 * handshake, which copies that request's headers.
 */

export const CODEX_SESSION_ID_HEADER = "session-id";
export const CODEX_THREAD_ID_HEADER = "thread-id";
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
/** Set to "0" to restore the pre-contract behavior (headers left untouched). */
export const CODEX_AFFINITY_HEADERS_ENV = "CCFLARE_CODEX_AFFINITY_HEADERS";

export const CODEX_AFFINITY_HEADER_NAMES = [
	CODEX_SESSION_ID_HEADER,
	CODEX_THREAD_ID_HEADER,
	CODEX_ROUTING_HINT_HEADER,
] as const;

/** Visible ASCII only, bounded: the backend expects an opaque token. */
const HEADER_TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;

export interface CodexAffinityHeaderInput {
	/** Prompt cache key sent in the body; null when the request is ineligible. */
	promptCacheKey: string | null | undefined;
	/** Physical Codex model after mapping, used for the routing hint. */
	physicalModel: string | null | undefined;
	/** Only the ChatGPT subscription backend honors these headers. */
	subscriptionEndpoint: boolean;
	/**
	 * A native Responses client (Codex CLI through the proxy) already carries
	 * its own session identity, which is exactly what it would have sent
	 * upstream itself. Legacy `/v1/messages` clients never do, and must not be
	 * allowed to steer another conversation's affinity.
	 */
	preserveClientSessionIdentity: boolean;
}

export interface CodexAffinityHeaderDecision {
	/** Where the `session-id`/`thread-id` values came from; null when unset. */
	sessionIdentity: "derived" | "client" | null;
	/** Whether `x-codex-routing-hint` was set. */
	routingHint: boolean;
}

export function codexAffinityHeadersEnabled(): boolean {
	return process.env[CODEX_AFFINITY_HEADERS_ENV] !== "0";
}

function headerToken(value: string | null | undefined): string | null {
	return typeof value === "string" && HEADER_TOKEN_PATTERN.test(value)
		? value
		: null;
}

/**
 * Mutates `headers` in place so one call covers HTTP and the handshake copy.
 * Fails closed: on the subscription endpoint the provider owns every
 * affinity header, so a client-supplied value is replaced or removed unless
 * the caller explicitly preserves a native client's own identity.
 */
export function applyCodexAffinityHeaders(
	headers: Headers,
	input: CodexAffinityHeaderInput,
): CodexAffinityHeaderDecision {
	const none: CodexAffinityHeaderDecision = {
		sessionIdentity: null,
		routingHint: false,
	};
	if (!codexAffinityHeadersEnabled() || !input.subscriptionEndpoint) {
		return none;
	}

	const clientSession = headerToken(headers.get(CODEX_SESSION_ID_HEADER));
	const clientThread = headerToken(headers.get(CODEX_THREAD_ID_HEADER));
	for (const name of CODEX_AFFINITY_HEADER_NAMES) headers.delete(name);

	const decision: CodexAffinityHeaderDecision = { ...none };
	const derivedKey = headerToken(input.promptCacheKey);
	if (input.preserveClientSessionIdentity && clientSession) {
		headers.set(CODEX_SESSION_ID_HEADER, clientSession);
		headers.set(CODEX_THREAD_ID_HEADER, clientThread ?? clientSession);
		decision.sessionIdentity = "client";
	} else if (derivedKey) {
		headers.set(CODEX_SESSION_ID_HEADER, derivedKey);
		headers.set(CODEX_THREAD_ID_HEADER, derivedKey);
		decision.sessionIdentity = "derived";
	}

	const model = headerToken(input.physicalModel);
	if (model) {
		headers.set(CODEX_ROUTING_HINT_HEADER, `model=${model}`);
		decision.routingHint = true;
	}
	return decision;
}
