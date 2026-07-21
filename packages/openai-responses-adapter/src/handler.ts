import crypto from "node:crypto";
import { Logger } from "@better-ccflare/logger";
import {
	RECOVERY_SCOPE_HEADER,
	RECOVERY_STATUS_EXHAUSTED,
	RECOVERY_STATUS_HEADER,
	recoveryScopeForCode,
} from "@better-ccflare/types/routing-recovery";
import { translateRequestToAnthropic } from "./request-translator";
import { translateAnthropicResponseToResponses } from "./response-translator";
import { translateAnthropicStreamToResponses } from "./stream-translator";
import type { HandleProxyFn, ResponseItem, ResponsesRequest } from "./types";

const log = new Logger("openai-responses-adapter");

const SESSION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSES_SESSION_ID_DOMAIN =
	"better-ccflare:responses-session-identity:v1\0";

function validSessionMetadataUserId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const sessionId = (parsed as Record<string, unknown>).session_id;
		return typeof sessionId === "string" && SESSION_UUID_RE.test(sessionId)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Bridge opaque Responses identities into the Claude metadata contract already
 * consumed by routing affinity and provider-native cache-key derivation.
 *
 * UUIDv8 is used because this is a private, SHA-256-derived identifier rather
 * than an RFC UUIDv5 (which specifically prescribes SHA-1). The source value is
 * never copied into the translated body.
 */
function canonicalSessionUuid(value: string): string {
	const bytes = crypto
		.createHash("sha256")
		.update(RESPONSES_SESSION_ID_DOMAIN)
		.update(value)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	return values.find(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
}

function isCanonicalFiniteRetryAfter(value: string | null): value is string {
	if (value === null || !/^[1-9]\d*$/.test(value)) return false;
	const seconds = Number(value);
	return Number.isSafeInteger(seconds) && Number.isSafeInteger(seconds * 1_000);
}

export async function handleResponsesRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxyFn,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	// 1. Parse body — Codex CLI compresses request bodies (zstd, gzip, deflate).
	// Bun decompresses response bodies automatically but not request bodies,
	// so we decompress manually when content-encoding is present.
	let rawBody = await req.arrayBuffer();
	const contentEncoding = req.headers.get("content-encoding")?.toLowerCase();
	if (contentEncoding) {
		try {
			const bytes = new Uint8Array(rawBody);
			let decompressed: Uint8Array;
			if (contentEncoding === "zstd") {
				decompressed = Bun.zstdDecompressSync(bytes);
			} else if (contentEncoding === "gzip") {
				decompressed = Bun.gunzipSync(bytes);
			} else if (contentEncoding === "deflate") {
				decompressed = Bun.inflateSync(bytes);
			} else {
				log.warn(`Unsupported content-encoding: ${contentEncoding}`);
				decompressed = bytes;
			}
			rawBody = decompressed.buffer as ArrayBuffer;
		} catch (e) {
			log.warn(`Failed to decompress ${contentEncoding} request body: ${e}`);
		}
	}

	let body: ResponsesRequest;
	try {
		body = JSON.parse(new TextDecoder().decode(rawBody)) as ResponsesRequest;
	} catch {
		return new Response(
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "Invalid JSON body" },
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// 2. Validate & normalise `input` — OpenAI Responses API allows a plain string
	if (!body || (typeof body.input !== "string" && !Array.isArray(body.input))) {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "input: Field required",
				},
			}),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}
	if (typeof body.input === "string") {
		body = {
			...body,
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: body.input }],
				},
			],
		};
	}

	// `previous_response_id` is intentionally ignored. Codex only sends this
	// field over its WebSocket path (see codex-rs/core/src/client.rs:get_incremental_items).
	// For regular HTTP /v1/responses requests Codex always includes the full
	// conversation history in `input`, so there is nothing to resolve here.

	// 3. Generate response ID
	const responseId = `resp_${crypto.randomBytes(12).toString("hex")}`;

	// 4. Translate to Anthropic format
	const anthropicBody = translateRequestToAnthropic(
		body as typeof body & { input: ResponseItem[] },
	);

	// 4b. Preserve an existing valid Claude session envelope. Otherwise bridge
	// the Responses identity into that envelope with documented precedence.
	// Downstream routing and the Codex/xAI native cache implementations consume
	// this same metadata shape. Hashing prevents opaque client identifiers from
	// leaking into persisted payloads, logs, or provider requests.
	const existingMetadataUserId =
		validSessionMetadataUserId(anthropicBody.metadata?.user_id) ??
		validSessionMetadataUserId(body.metadata?.user_id);
	if (existingMetadataUserId) {
		anthropicBody.metadata = { user_id: existingMetadataUserId };
	} else {
		const sourceIdentity = firstNonEmptyString(
			body.prompt_cache_key,
			req.headers.get("session_id"),
			req.headers.get("x-session-id"),
		);
		if (sourceIdentity) {
			anthropicBody.metadata = {
				user_id: JSON.stringify({
					session_id: canonicalSessionUuid(sourceIdentity),
				}),
			};
		}
	}

	// 5. Build synthetic request targeting /v1/messages
	const messagesUrl = new URL(url.toString());
	messagesUrl.pathname = "/v1/messages";
	const syntheticHeaders = new Headers(req.headers);
	syntheticHeaders.set("content-type", "application/json");
	syntheticHeaders.delete("content-length");
	// The canonical body identity replaces these raw client identifiers. Keeping
	// them would widen their trust boundary and could forward them upstream.
	syntheticHeaders.delete("session_id");
	syntheticHeaders.delete("x-session-id");
	// Body is now decompressed plain JSON — remove the original encoding hint.
	syntheticHeaders.delete("content-encoding");
	// Required by Anthropic API — Codex CLI doesn't send this header.
	if (!syntheticHeaders.has("anthropic-version")) {
		syntheticHeaders.set("anthropic-version", "2023-06-01");
	}
	// claude-oauth accounts use Claude's OAuth tokens — Anthropic bans them
	// when used outside Claude CLI. Always exclude from Codex CLI traffic.
	syntheticHeaders.set("x-better-ccflare-exclude-providers", "anthropic-oauth");
	const syntheticReq = new Request(messagesUrl.toString(), {
		method: "POST",
		headers: syntheticHeaders,
		body: JSON.stringify(anthropicBody),
	});

	// 6. Forward to proxy
	log.info(`Forwarding responses request to ${messagesUrl.pathname}`);
	let anthropicResp: Response;
	try {
		anthropicResp = await handleProxy(
			syntheticReq,
			messagesUrl,
			ctx,
			apiKeyId,
			apiKeyName,
		);
	} catch (err) {
		const statusCode =
			typeof err === "object" &&
			err !== null &&
			"statusCode" in err &&
			typeof (err as { statusCode: unknown }).statusCode === "number"
				? (err as { statusCode: number }).statusCode
				: 503;
		const isUnavailable = statusCode === 503;
		return new Response(
			JSON.stringify({
				error: {
					message: isUnavailable
						? "Service temporarily unavailable. Please try again later."
						: "Proxy request failed",
					type: isUnavailable ? "server_error" : "api_error",
					code: isUnavailable ? "server_error" : "api_error",
				},
			}),
			{ status: statusCode, headers: { "Content-Type": "application/json" } },
		);
	}

	// 7. Translate non-200 Anthropic errors to OpenAI error shape
	if (anthropicResp.status !== 200) {
		let errorBody: {
			error: Record<string, unknown> & {
				message: string;
				type: string;
				code: string;
			};
		};
		let stableCode = "api_error";
		const contentType = anthropicResp.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			try {
				const anthropicError = (await anthropicResp.json()) as {
					type?: string;
					error?: Record<string, unknown> & {
						type?: string;
						code?: string;
						message?: string;
					};
				};
				const errType = anthropicError?.error?.type ?? "api_error";
				stableCode = anthropicError?.error?.code ?? errType;
				errorBody = {
					error: {
						...anthropicError?.error,
						message: anthropicError?.error?.message ?? "Unknown error",
						type: errType,
						code: stableCode,
					},
				};
			} catch {
				errorBody = {
					error: {
						message: "Unknown error",
						type: "api_error",
						code: "api_error",
					},
				};
			}
		} else {
			errorBody = {
				error: {
					message: "Unknown error",
					type: "api_error",
					code: "api_error",
				},
			};
		}
		const responseHeaders = new Headers({
			"content-type": "application/json",
		});
		// The local guard must only hold requests for positively recoverable
		// terminals. A finite model lane can recover on a different compatible
		// account just like the whole pool can. Preserve status, scope, and delay
		// atomically; never let partially marked errors inherit retry semantics.
		const retryAfter = anthropicResp.headers.get("retry-after");
		const poolStatus = anthropicResp.headers.get(RECOVERY_STATUS_HEADER);
		const recoveryScope = anthropicResp.headers.get(RECOVERY_SCOPE_HEADER);
		const expectedScope = recoveryScopeForCode(stableCode);
		if (
			anthropicResp.status === 503 &&
			expectedScope !== undefined &&
			poolStatus === RECOVERY_STATUS_EXHAUSTED &&
			recoveryScope === expectedScope &&
			isCanonicalFiniteRetryAfter(retryAfter)
		) {
			responseHeaders.set("retry-after", retryAfter);
			responseHeaders.set(RECOVERY_STATUS_HEADER, RECOVERY_STATUS_EXHAUSTED);
			responseHeaders.set(RECOVERY_SCOPE_HEADER, recoveryScope);
		}
		return new Response(JSON.stringify(errorBody), {
			status: anthropicResp.status,
			headers: responseHeaders,
		});
	}

	// 8. Stream path
	if (body.stream) {
		return translateAnthropicStreamToResponses(
			anthropicResp,
			responseId,
			body.model,
		);
	}

	// 9. Non-stream path
	let respBody: unknown;
	try {
		respBody = await anthropicResp.json();
	} catch {
		return new Response(
			JSON.stringify({
				error: {
					message: "Failed to parse upstream response",
					type: "api_error",
					code: "api_error",
				},
			}),
			{ status: 502, headers: { "Content-Type": "application/json" } },
		);
	}
	const translated = translateAnthropicResponseToResponses(
		respBody as Parameters<typeof translateAnthropicResponseToResponses>[0],
		responseId,
		body.model,
	);
	return new Response(JSON.stringify(translated), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
