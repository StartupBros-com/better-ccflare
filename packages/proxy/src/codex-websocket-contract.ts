import { createHash } from "node:crypto";

export const CODEX_RESPONSES_WEBSOCKET_URL =
	"wss://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_HTTP_URL =
	"https://chatgpt.com/backend-api/codex/responses";

export const CODEX_WS_PERCENT_ENV = "CCFLARE_CODEX_WS_PERCENT";
export const CODEX_WS_ACCOUNT_IDS_ENV = "CCFLARE_CODEX_WS_ACCOUNT_IDS";
export const CODEX_WS_MODELS_ENV = "CCFLARE_CODEX_WS_MODELS";
export const CODEX_WS_COHORT_IDS_ENV = "CCFLARE_CODEX_WS_COHORT_IDS";
export const CODEX_WS_OBSERVE_ONLY_ENV = "CCFLARE_CODEX_WS_OBSERVE_ONLY";
export const CODEX_WS_MAX_GLOBAL_ENV = "CCFLARE_CODEX_WS_MAX_GLOBAL";
export const CODEX_WS_MAX_PER_ACCOUNT_ENV = "CCFLARE_CODEX_WS_MAX_PER_ACCOUNT";
export const CODEX_WS_IDLE_TTL_MS_ENV = "CCFLARE_CODEX_WS_IDLE_TTL_MS";
export const CODEX_WS_MAX_AGE_MS_ENV = "CCFLARE_CODEX_WS_MAX_AGE_MS";
export const CODEX_WS_TELEMETRY_WARN_ENV = "CCFLARE_CODEX_WS_TELEMETRY_WARN";
const CODEX_WS_HANDSHAKE_TIMEOUT_MS_ENV =
	"CCFLARE_CODEX_WS_HANDSHAKE_TIMEOUT_MS";
const CODEX_WS_FIRST_EVENT_TIMEOUT_MS_ENV =
	"CCFLARE_CODEX_WS_FIRST_EVENT_TIMEOUT_MS";

const DEFAULT_MAX_GLOBAL = 32;
const DEFAULT_MAX_PER_ACCOUNT = 8;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 54 * 60 * 1000;
const MAX_SOCKET_AGE_MS = 55 * 60 * 1000 - 1;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 60_000;
const MAX_FIRST_EVENT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_GLOBAL_POOL = 256;
const MAX_PER_ACCOUNT_POOL = 64;
const ASSIGNMENT_DOMAIN = "better-ccflare:codex-ws-assignment:v1\0";
const COHORT_DOMAIN = "better-ccflare:codex-ws-cohort:v1\0";

export interface CodexWebSocketOptions {
	headers: Record<string, string>;
}

export interface CodexWebSocketLike extends EventTarget {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type CodexWebSocketFactory = (
	url: string,
	options: CodexWebSocketOptions,
) => CodexWebSocketLike;

export type CodexWebSocketFailureCategory =
	| "abort"
	| "buffer_overflow"
	| "handshake_close"
	| "handshake_error"
	| "handshake_timeout"
	| "malformed_frame"
	| "post_write_close"
	| "post_write_error"
	| "post_write_timeout"
	| "semantic_stall"
	| "stream_cancelled";

export type CodexWebSocketFallbackReason =
	| CodexWebSocketFailureCategory
	| "cohort_control"
	| "connection_busy"
	| "connection_opening"
	| "cohort_not_allowlisted"
	| "global_cap"
	| "lane_identity_busy"
	| "per_account_cap"
	| "send_failed_before_write"
	| "observe_only"
	| "sticky_http"
	| "upstream_terminal_error";

export interface CodexWebSocketObservation {
	requestId: string;
	attemptId: string;
	assignment: "treatment" | "control";
	effectiveTransport: "websocket" | "http";
	accountId: string;
	model: string;
	cohortId: string;
	connectionId: string | null;
	connectionNew: boolean | null;
	connectionReused: boolean | null;
	connectionAgeMs: number | null;
	poolSize: number;
	busy: boolean;
	handshakeMs: number | null;
	handshakeFailure: string | null;
	frameWritten: boolean;
	firstEventMs: number | null;
	createdMs: number | null;
	firstOutputMs: number | null;
	terminalMs: number | null;
	closeCode: number | null;
	closeCategory: string | null;
	fallbackReason: CodexWebSocketFallbackReason | null;
	fallbackAllowedBeforeWrite: boolean;
	stickyHttp: boolean;
	inputTokens: number | null;
	cachedReadTokens: number | null;
	cacheWriteTokens: number | null;
	cacheWriteMeasurementAvailable: boolean;
}

export interface CodexWebSocketCounters {
	requests: number;
	assigned: number;
	controls: number;
	connectionsOpened: number;
	connectionsReused: number;
	busyHttpBypass: number;
	preWriteHttpFallbacks: number;
	postWriteFailures: number;
	stickyHttpBypass: number;
	evictions: number;
	aborts: number;
	terminals: number;
	observeOnly: number;
	cohortNotAllowlisted: number;
}

export interface CodexWebSocketCacheStats {
	measuredTerminals: number;
	inputTokens: number;
	cachedReadTokens: number;
	cacheWriteMeasuredTerminals: number;
	cacheWriteUnavailableTerminals: number;
	cacheWriteTokens: number;
}

export interface CodexWebSocketStats {
	percent: number;
	accountAllowlistSize: number;
	modelAllowlistSize: number;
	poolSize: number;
	stickyHttpSize: number;
	counters: CodexWebSocketCounters;
	cache: CodexWebSocketCacheStats;
	pool: Array<{
		connectionId: string;
		accountId: string;
		model: string;
		busy: boolean;
		ageMs: number;
		idleMs: number;
	}>;
	recent: CodexWebSocketObservation[];
}

export interface CodexWebSocketReceipt {
	readonly connectionId: string;
	readonly cohortId: string;
	readonly reused: boolean;
	frameWritten: boolean;
	stickyHttp: boolean;
	markPostWriteFailure(category: CodexWebSocketFailureCategory): void;
}

export interface CodexWebSocketAttemptResult {
	response: Response;
	receipt: CodexWebSocketReceipt;
}

export interface CodexWebSocketAttemptInput {
	/** Proxy request correlation ID also written to Codex usage/cache traces. */
	requestId: string;
	/** Concrete transport attempt ID also written to Codex usage/cache traces. */
	attemptId: string;
	accountId: string;
	providerName: string;
	/**
	 * Server-derived, restart-stable logical conversation digest. This is
	 * deliberately independent of prompt_cache_key because session-key cache
	 * experiments can share one cache key across sibling conversations.
	 */
	conversationIdentity?: string | null;
	request: Request;
	signal: AbortSignal;
	/** Called synchronously after send() succeeds, before waiting for any event. */
	onFrameWritten?: (receipt: CodexWebSocketReceipt) => void;
}

export interface CodexWebSocketParsedRequest {
	model: string;
	promptCacheKey: string;
	assignmentKey: string;
	laneKey: string;
	poolKey: string;
	stickyKey: string;
	cohortId: string;
	framePayload: Record<string, unknown>;
}

export interface CodexWebSocketRuntimeConfig {
	percent: number;
	observeOnly: boolean;
	accountIds: Set<string>;
	models: Set<string>;
	cohortIds: Set<string>;
	maxGlobal: number;
	maxPerAccount: number;
	idleTtlMs: number;
	maxAgeMs: number;
	handshakeTimeoutMs: number;
	firstEventTimeoutMs: number;
}

function boundedInteger(
	raw: string | undefined,
	fallback: number,
	maximum: number,
): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, maximum);
}

export function readCodexWebSocketPercent(): number {
	const raw = process.env[CODEX_WS_PERCENT_ENV];
	if (raw === undefined || !/^\d+$/.test(raw)) return 0;
	return Math.min(Number.parseInt(raw, 10), 100);
}

export function readCodexWebSocketTelemetryWarn(): boolean {
	const raw = process.env[CODEX_WS_TELEMETRY_WARN_ENV];
	return raw === "1" || raw?.toLowerCase() === "true";
}

function strictBoolean(raw: string | undefined): boolean {
	return raw === "1" || raw?.toLowerCase() === "true";
}

function csvSet(raw: string | undefined, lowercase = false): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean)
			.map((value) => (lowercase ? value.toLowerCase() : value)),
	);
}

export function readCodexWebSocketRuntimeConfig(): CodexWebSocketRuntimeConfig {
	return {
		percent: readCodexWebSocketPercent(),
		observeOnly: strictBoolean(process.env[CODEX_WS_OBSERVE_ONLY_ENV]),
		accountIds: csvSet(process.env[CODEX_WS_ACCOUNT_IDS_ENV]),
		models: csvSet(process.env[CODEX_WS_MODELS_ENV], true),
		cohortIds: csvSet(process.env[CODEX_WS_COHORT_IDS_ENV]),
		maxGlobal: boundedInteger(
			process.env[CODEX_WS_MAX_GLOBAL_ENV],
			DEFAULT_MAX_GLOBAL,
			MAX_GLOBAL_POOL,
		),
		maxPerAccount: boundedInteger(
			process.env[CODEX_WS_MAX_PER_ACCOUNT_ENV],
			DEFAULT_MAX_PER_ACCOUNT,
			MAX_PER_ACCOUNT_POOL,
		),
		idleTtlMs: boundedInteger(
			process.env[CODEX_WS_IDLE_TTL_MS_ENV],
			DEFAULT_IDLE_TTL_MS,
			MAX_SOCKET_AGE_MS,
		),
		maxAgeMs: boundedInteger(
			process.env[CODEX_WS_MAX_AGE_MS_ENV],
			DEFAULT_MAX_AGE_MS,
			MAX_SOCKET_AGE_MS,
		),
		handshakeTimeoutMs: boundedInteger(
			process.env[CODEX_WS_HANDSHAKE_TIMEOUT_MS_ENV],
			DEFAULT_HANDSHAKE_TIMEOUT_MS,
			MAX_HANDSHAKE_TIMEOUT_MS,
		),
		firstEventTimeoutMs: boundedInteger(
			process.env[CODEX_WS_FIRST_EVENT_TIMEOUT_MS_ENV],
			DEFAULT_FIRST_EVENT_TIMEOUT_MS,
			MAX_FIRST_EVENT_TIMEOUT_MS,
		),
	};
}

/** Stable assignment that never exposes the raw account or conversation key. */
export function isCodexWebSocketAssigned(
	accountId: string,
	conversationKey: string,
	percent = readCodexWebSocketPercent(),
): boolean {
	if (!accountId || !conversationKey || percent <= 0) return false;
	if (percent >= 100) return true;
	const bucket = createHash("sha256")
		.update(ASSIGNMENT_DOMAIN)
		.update(accountId)
		.update("\0")
		.update(conversationKey)
		.digest()
		.readUInt16BE(0);
	return bucket % 100 < percent;
}

/**
 * Stable across service restarts so an observe-only cohort can be selected in
 * a systemd drop-in before the treatment restart. The source conversation key
 * is already a server-derived prompt-cache digest and is never emitted.
 */
export function codexWebSocketCohortId(
	accountId: string,
	conversationKey: string,
): string {
	return createHash("sha256")
		.update(COHORT_DOMAIN)
		.update(accountId)
		.update("\0")
		.update(conversationKey)
		.digest("hex")
		.slice(0, 16);
}

export function isOfficialCodexSubscriptionUrl(url: string): boolean {
	try {
		return new URL(url).href === CODEX_RESPONSES_HTTP_URL;
	} catch {
		return false;
	}
}
