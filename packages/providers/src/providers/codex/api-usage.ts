import { Logger } from "@better-ccflare/logger";
import type {
	UsageData,
	UsageFetchResult,
	UsageWindow,
} from "../../usage-fetcher";
import { CODEX_USER_AGENT } from "./provider";

const log = new Logger("CodexApiUsage");

const REQUEST_TIMEOUT_MS = 10_000;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

/** Primary usage-introspection endpoint (free, no quota consumed). */
export const CODEX_WHAM_USAGE_ENDPOINT =
	"https://chatgpt.com/backend-api/wham/usage";
/**
 * The wham/usage path has moved before; this is the historical fallback.
 * On a 404 from the primary endpoint, we retry here once and remember
 * whichever URL worked for subsequent calls.
 */
export const CODEX_WHAM_USAGE_FALLBACK_ENDPOINT =
	"https://chatgpt.com/api/codex/usage";

/** Module-level memory of whichever endpoint most recently worked. */
let resolvedUsageEndpoint: string = CODEX_WHAM_USAGE_ENDPOINT;

/**
 * The other of the two known usage paths. The 404 flip is symmetric (like
 * OnWatch's): whichever URL is current, a 404 probes its counterpart — so a
 * process pinned to one path can recover when that path dies later.
 */
function counterpartUsageEndpoint(endpoint: string): string {
	return endpoint === CODEX_WHAM_USAGE_ENDPOINT
		? CODEX_WHAM_USAGE_FALLBACK_ENDPOINT
		: CODEX_WHAM_USAGE_ENDPOINT;
}

/** Test-only: reset the remembered working endpoint back to the default. */
export function resetCodexUsageEndpointForTest(): void {
	resolvedUsageEndpoint = CODEX_WHAM_USAGE_ENDPOINT;
}

interface WhamUsageWindow {
	used_percent?: number | null;
	reset_at?: number | null;
	limit_window_seconds?: number | null;
}

interface WhamUsageRateLimit {
	primary_window?: WhamUsageWindow | null;
	secondary_window?: WhamUsageWindow | null;
}

interface WhamUsageResponse {
	plan_type?: string | null;
	rate_limit?: WhamUsageRateLimit | null;
	code_review_rate_limit?: WhamUsageRateLimit | null;
	credits?: { balance?: number | string | null } | null;
}

/**
 * Decode the `https://api.openai.com/auth` claim's `chatgpt_account_id` out
 * of a ChatGPT access token (a JWT) without verifying the signature — we
 * only need the workspace/team account id to attach to the usage request,
 * the same way OnWatch does. Never throws: malformed tokens simply yield
 * null and the request proceeds without the header (fine for personal
 * accounts).
 */
export function extractChatGptAccountId(accessToken: string): string | null {
	try {
		const segments = accessToken.split(".");
		if (segments.length !== 3) return null;
		const payloadSegment = segments[1];
		if (!payloadSegment) return null;
		const json = Buffer.from(payloadSegment, "base64url").toString("utf8");
		const payload = JSON.parse(json) as Record<string, unknown>;
		const authClaim = payload["https://api.openai.com/auth"];
		if (
			authClaim &&
			typeof authClaim === "object" &&
			!Array.isArray(authClaim)
		) {
			const chatgptAccountId = (authClaim as Record<string, unknown>)
				.chatgpt_account_id;
			if (typeof chatgptAccountId === "string" && chatgptAccountId !== "") {
				return chatgptAccountId;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function toUsageWindow(window: WhamUsageWindow): UsageWindow {
	const utilization =
		typeof window.used_percent === "number" &&
		Number.isFinite(window.used_percent)
			? window.used_percent
			: 0;
	const resetsAt =
		typeof window.reset_at === "number" &&
		Number.isFinite(window.reset_at) &&
		window.reset_at > 0
			? new Date(window.reset_at * 1000).toISOString()
			: null;
	return { utilization, resets_at: resetsAt };
}

function emptyWindow(): UsageWindow {
	return { utilization: 0, resets_at: null };
}

function determineWindowSlot(
	window: WhamUsageWindow,
	planType: string | null,
): "five_hour" | "seven_day" {
	if (planType && planType.trim().toLowerCase() === "free") {
		return "seven_day";
	}
	if (
		typeof window.limit_window_seconds === "number" &&
		window.limit_window_seconds >= SEVEN_DAY_SECONDS
	) {
		return "seven_day";
	}
	return "five_hour";
}

function coerceCreditsBalance(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Map a `wham/usage` response body onto better-ccflare's provider-agnostic
 * UsageData shape. Mirrors OnWatch's codexPrimaryQuotaName heuristic for
 * deciding whether a lone primary window represents the 5h or 7d window.
 */
export function mapWhamUsageResponse(
	body: WhamUsageResponse,
): UsageData | null {
	const planType = typeof body.plan_type === "string" ? body.plan_type : null;
	const primary = body.rate_limit?.primary_window ?? null;
	const secondary = body.rate_limit?.secondary_window ?? null;

	let fiveHour: UsageWindow | null = null;
	let sevenDay: UsageWindow | null = null;

	if (primary && secondary) {
		fiveHour = toUsageWindow(primary);
		sevenDay = toUsageWindow(secondary);
	} else if (primary) {
		if (determineWindowSlot(primary, planType) === "seven_day") {
			sevenDay = toUsageWindow(primary);
		} else {
			fiveHour = toUsageWindow(primary);
		}
	} else if (secondary) {
		// A lone secondary window is always the weekly quota (OnWatch maps
		// SecondaryWindow to seven_day unconditionally, no heuristic).
		sevenDay = toUsageWindow(secondary);
	}

	if (!fiveHour && !sevenDay) {
		return null;
	}

	const data: UsageData = {
		five_hour: fiveHour ?? emptyWindow(),
		seven_day: sevenDay ?? emptyWindow(),
	};

	if (planType) {
		data.plan_type = planType;
	}

	if (body.credits && typeof body.credits === "object") {
		data.credits_balance = coerceCreditsBalance(body.credits.balance);
	}

	// Stored as flat scalars, NOT a window-shaped object: the representative
	// utilization/window helpers treat every `{utilization}` property as an
	// account-level window, and a maxed-out code-review quota must not read
	// as chat-quota exhaustion.
	const codeReviewPrimary = body.code_review_rate_limit?.primary_window;
	if (codeReviewPrimary) {
		const codeReview = toUsageWindow(codeReviewPrimary);
		data.code_review_used_percent = codeReview.utilization;
		data.code_review_resets_at = codeReview.resets_at;
	}

	return data;
}

async function requestWhamUsage(
	endpoint: string,
	accessToken: string,
	chatgptAccountId: string | null,
	signal: AbortSignal,
): Promise<Response> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"User-Agent": CODEX_USER_AGENT,
	};
	if (chatgptAccountId) {
		// Both conventions seen in the wild for this endpoint: codex-rs sends
		// chatgpt-account-id; OnWatch sends X-Account-Id (plus a case-variant
		// of the former). Headers are cheap — send both.
		headers["chatgpt-account-id"] = chatgptAccountId;
		headers["X-Account-Id"] = chatgptAccountId;
	}
	return fetch(endpoint, {
		method: "GET",
		headers,
		signal,
	});
}

/**
 * Fetch Codex/ChatGPT subscription usage from the free `wham/usage`
 * introspection endpoint (no quota consumed, unlike the on-demand ping in
 * on-demand-fetch.ts). Falls back to the legacy `/api/codex/usage` path
 * once, remembering whichever URL worked for subsequent calls.
 */
export async function fetchCodexUsageData(
	accessToken: string,
	externalSignal?: AbortSignal,
): Promise<UsageFetchResult> {
	if (!accessToken || accessToken.trim() === "") {
		return { data: null, retryAfterMs: null };
	}

	const chatgptAccountId = extractChatGptAccountId(accessToken);

	// One deadline covers the request(s) AND body consumption: fetch resolves
	// at headers, so a peer that streams headers then stalls the body would
	// otherwise hang response.json() forever with no timer — permanently
	// wedging the per-account in-flight dedup and the polling loop.
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	externalSignal?.addEventListener("abort", abort, { once: true });
	if (externalSignal?.aborted) controller.abort();
	// Snapshot the module global BEFORE any await: a concurrent call may flip
	// it mid-flight, and the 404 counterpart must derive from the URL this
	// call actually tried, not from whatever the global says afterwards.
	const attemptedEndpoint = resolvedUsageEndpoint;

	try {
		let response = await requestWhamUsage(
			attemptedEndpoint,
			accessToken,
			chatgptAccountId,
			controller.signal,
		);
		if (response.status === 404) {
			const alternate = counterpartUsageEndpoint(attemptedEndpoint);
			log.warn(
				`Codex usage endpoint 404 at ${attemptedEndpoint}, retrying at ${alternate}`,
			);
			try {
				await response.body?.cancel();
			} catch {
				// Best-effort: an uncancellable 404 body must not block the retry.
			}
			response = await requestWhamUsage(
				alternate,
				accessToken,
				chatgptAccountId,
				controller.signal,
			);
			if (response.ok) {
				resolvedUsageEndpoint = alternate;
			}
		}

		if (!response.ok) {
			let retryAfterMs: number | null = null;
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				if (retryAfter) {
					const seconds = Number(retryAfter);
					if (Number.isFinite(seconds) && seconds > 0) {
						retryAfterMs = Math.round(seconds * 1000);
						log.warn(
							`Codex usage endpoint rate-limited, retry-after: ${seconds}s`,
						);
					}
				}
			}
			log.warn(
				`Failed to fetch Codex usage data: ${response.status} ${response.statusText}`,
			);
			return { data: null, retryAfterMs };
		}

		let body: WhamUsageResponse;
		try {
			body = (await response.json()) as WhamUsageResponse;
		} catch (error) {
			log.error("Failed to parse Codex usage response JSON:", error);
			return { data: null, retryAfterMs: null };
		}

		return { data: mapWhamUsageResponse(body), retryAfterMs: null };
	} catch (error) {
		const errorMessage =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null
					? JSON.stringify(error)
					: String(error);
		log.error(
			"Error fetching Codex usage data:",
			errorMessage || "Unknown error",
		);
		return { data: null, retryAfterMs: null };
	} finally {
		clearTimeout(timeoutId);
		externalSignal?.removeEventListener("abort", abort);
	}
}
