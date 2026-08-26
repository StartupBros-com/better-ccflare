import { Logger } from "@better-ccflare/logger";
import type { UsageData } from "../../usage-fetcher";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_PING_MODEL,
	CODEX_USER_AGENT,
	CODEX_VERSION,
	isCodexSubscriptionEndpoint,
	resolveCodexEndpoint,
} from "./provider";
import { parseCodexUsageHeaders } from "./usage";

const log = new Logger("CodexOnDemandFetch");

const REQUEST_TIMEOUT_MS = 10_000;

export interface CodexUsageRefreshFetchResult {
	/** Parsed usage windows, or null when no usage headers were returned. */
	data: UsageData | null;
	/**
	 * A synthetic response carrying only the upstream status and headers.
	 * The original body is cancelled to minimise quota consumption, so this
	 * object is safe to pass to header-only consumers like `parseRateLimit`.
	 */
	response: Response;
}

/**
 * Send a minimal Codex `/responses` request whose only purpose is to elicit
 * the `x-codex-*` rate-limit/usage headers that the upstream attaches to
 * every response. The request body is intentionally tiny (a single character
 * input at the lowest reasoning effort the models accept), and the response is
 * aborted and its body cancelled as soon as headers are captured. The
 * subscription API rejects `max_output_tokens`; custom API-compatible endpoints
 * retain the legacy one-token cap.
 *
 * The ChatGPT backend DOES expose a free usage-introspection endpoint
 * (`wham/usage`, see api-usage.ts's `fetchCodexUsageData`), used to poll
 * subscription accounts without spending quota. This quota-consuming ping
 * remains in use for custom OpenAI-compatible endpoints (which have no
 * wham/usage equivalent) and as a fallback when the free endpoint fails.
 *
 * `model` exists because a wrong model name is rejected before quota accounting,
 * producing no usage headers. Callers with an account model listing should pass
 * its weakest accepted model; callers without one fall back to CODEX_PING_MODEL.
 */
export async function fetchCodexUsageOnDemand(
	accessToken: string,
	endpoint: string = CODEX_DEFAULT_ENDPOINT,
	model: string = CODEX_PING_MODEL,
): Promise<CodexUsageRefreshFetchResult> {
	if (!accessToken || accessToken.trim() === "") {
		throw new Error(
			"fetchCodexUsageOnDemand requires a non-empty access token",
		);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const resolvedEndpoint = resolveCodexEndpoint(endpoint);

	const requestBody: Record<string, unknown> = {
		// Blank input is the same missing-model failure as a stale model name.
		model: model.trim() || CODEX_PING_MODEL,
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: "." }],
			},
		],
		stream: true,
		store: false,
		// "minimal" is rejected by current models; "low" is accepted across the
		// measured catalog and is the cheapest portable probe effort.
		reasoning: { effort: "low" },
		instructions: "ping",
	};
	if (!isCodexSubscriptionEndpoint(resolvedEndpoint)) {
		requestBody.max_output_tokens = 1;
	}

	try {
		const upstream = await fetch(resolvedEndpoint, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Version: CODEX_VERSION,
				"Openai-Beta": "responses=experimental",
				"User-Agent": CODEX_USER_AGENT,
				originator: "codex_cli_rs",
				Accept: "text/event-stream",
			},
			body: JSON.stringify(requestBody),
		});

		const headersSnapshot = new Headers(upstream.headers);
		const status = upstream.status;
		const statusText = upstream.statusText;

		// Snapshot status, headers, and usage before aborting so cleanup cannot
		// erase the response callers need to persist quota state.
		const data = parseCodexUsageHeaders(headersSnapshot);
		controller.abort();
		try {
			await upstream.body?.cancel();
		} catch (error) {
			log.debug("Codex on-demand response body cancel threw:", error);
		}

		const response = new Response(null, {
			status,
			statusText,
			headers: headersSnapshot,
		});

		return { data, response };
	} finally {
		clearTimeout(timeoutId);
	}
}
