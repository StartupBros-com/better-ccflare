#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import http from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DEFAULT_GUARD_POLICY_ID,
	evaluateGuardRetry,
	recoveryHeaderStatus,
} from "./ccflare-guard-policy.mjs";

export const DEFAULT_GUARD_SOURCE_ID = "better-ccflare-source-guard-v1";
export const DEFAULT_GUARD_MAX_ATTEMPTS = 3;
export const DEFAULT_GUARD_TOTAL_DEADLINE_MS = 600_000;
export const DEFAULT_GUARD_RETRY_ATTEMPT_HEADROOM_MS = 30_000;
export const DEFAULT_GUARD_MAX_RECOVERY_SLEEP_MS = 120_000;
export const MAX_GUARD_RECOVERY_SILENCE_MS = 120_000;
export const DEFAULT_GUARD_RETRY_JITTER_MS = 2_000;
export const DEFAULT_GUARD_MAX_INSPECTION_BYTES = 64 * 1_024;
export const DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS = 120_000;
// P1 ordering: once the reserved marker confirms a trusted finite recovery,
// retry is already authorized (see recoveryHeaderStatus). Any
// further body read is purely a bounded, best-effort delay hint, capped
// short so a stalled or slow body can never meaningfully erode the
// request's overall deadline.
export const DEFAULT_GUARD_DELAY_INSPECTION_TIMEOUT_MS = 5_000;
// P1 spoofing (guard side): the legacy body-only pool_exhausted fallback is
// a temporary rolling-upgrade escape hatch, OFF by default. See
// evaluateGuardRetry's docstring in ccflare-guard-policy.mjs for the
// rationale.
export const DEFAULT_GUARD_ALLOW_LEGACY_POOL_BODY = false;
export const GUARD_REQUEST_ID_HEADER = "x-better-ccflare-guard-request-id";

// Bound the only response-content state retained by the guard. The observer
// never logs event data (which can include provider or user content); it emits
// only fixed classification tokens, bounded counters, and a strictly validated
// error-type token.
const MAX_SSE_OUTCOME_EVENT_BYTES = 16 * 1_024;
const MAX_SSE_COMPATIBILITY_ALIAS_COUNT = 255;
const SAFE_SSE_ERROR_TYPES = new Set([
	"api_error",
	"authentication_error",
	"billing_error",
	"invalid_request_error",
	"not_found_error",
	"overloaded_error",
	"permission_error",
	"rate_limit_error",
	"service_unavailable_error",
	"timeout_error",
]);

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const GUARD_MODULE_PATH = fileURLToPath(import.meta.url);
const POLICY_MODULE_PATH = fileURLToPath(
	new URL("./ccflare-guard-policy.mjs", import.meta.url),
);

function fileIdentity(path) {
	try {
		const actualPath = realpathSync(path);
		if (!statSync(actualPath).isFile()) return null;
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1_024);
		const descriptor = openSync(actualPath, "r");
		try {
			while (true) {
				const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			closeSync(descriptor);
		}
		return {
			path: actualPath,
			sha256: hash.digest("hex"),
		};
	} catch {
		return null;
	}
}

function processExecutableIdentity(pid, procRoot) {
	if (!Number.isSafeInteger(pid) || pid <= 1) return null;
	return fileIdentity(`${procRoot}/${pid}/exe`);
}

function parentRunnerIdentity(pid, procRoot) {
	if (!Number.isSafeInteger(pid) || pid <= 1) return null;
	try {
		const args = readFileSync(`${procRoot}/${pid}/cmdline`)
			.toString("utf8")
			.split("\0")
			.filter(Boolean);
		const script = args
			.slice(1)
			.map((candidate) => fileIdentity(candidate))
			.find((identity) => identity?.path.endsWith("run-ccflare-stack.sh"));
		return script || null;
	} catch {
		return null;
	}
}

export function inspectRuntimeIdentity(options = {}) {
	const procRoot = options.procRoot || "/proc";
	const runnerPid = options.runnerPid ?? process.ppid;
	const guardPid = options.guardPid ?? process.pid;
	const parsedUpstreamPid = Number(options.upstreamPid);
	const upstreamPid = Number.isSafeInteger(parsedUpstreamPid)
		? parsedUpstreamPid
		: null;
	return {
		process: {
			guardPid,
			runnerPid,
			upstreamPid,
		},
		artifacts: {
			binary: processExecutableIdentity(upstreamPid, procRoot),
			runner: parentRunnerIdentity(runnerPid, procRoot),
			guard: fileIdentity(options.guardPath || GUARD_MODULE_PATH),
			policy: fileIdentity(options.policyPath || POLICY_MODULE_PATH),
		},
	};
}

function configuredNumber(value, fallback) {
	if (value == null || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function configuredBoundedInteger(value, fallback, { name, min, max }) {
	if (value == null || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return parsed;
}

function configuredBoolean(value, fallback) {
	if (value == null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function abortError() {
	const error = new Error("client aborted");
	error.name = "AbortError";
	return error;
}

function deadlineError() {
	const error = new Error("guard request deadline exceeded");
	error.name = "AbortError";
	error.code = "GUARD_DEADLINE_EXCEEDED";
	return error;
}

function combineAbortSignals(signals) {
	const controller = new AbortController();
	const listeners = [];
	for (const signal of signals) {
		const abort = () => {
			if (!controller.signal.aborted) {
				controller.abort(signal.reason || abortError());
			}
		};
		if (signal.aborted) {
			abort();
			break;
		}
		signal.addEventListener("abort", abort, { once: true });
		listeners.push([signal, abort]);
	}
	return {
		signal: controller.signal,
		dispose() {
			for (const [signal, abort] of listeners) {
				signal.removeEventListener("abort", abort);
			}
		},
	};
}

function requestHeaders(req, bodyLength, guardRequestId) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		const lower = key.toLowerCase();
		if (
			HOP_BY_HOP_HEADERS.has(lower) ||
			lower === "host" ||
			lower === "content-length"
		) {
			continue;
		}
		if (Array.isArray(value)) headers.set(key, value.join(", "));
		else if (value != null) headers.set(key, String(value));
	}
	// This listener is the trust boundary for the private correlation header.
	// Always overwrite a client-supplied value with this request's UUID.
	headers.set(GUARD_REQUEST_ID_HEADER, guardRequestId);
	if (bodyLength > 0) headers.set("content-length", String(bodyLength));
	return headers;
}

function responseHeaders(fetchHeaders, bodyLength = null) {
	const headers = {};
	fetchHeaders.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower)) return;
		if (bodyLength != null && lower === "content-length") return;
		headers[key] = value;
	});
	if (bodyLength != null) headers["content-length"] = String(bodyLength);
	return headers;
}

async function readBody(req, signal) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let settled = false;
		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (callback) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onData = (chunk) => chunks.push(Buffer.from(chunk));
		const onEnd = () => finish(() => resolve(Buffer.concat(chunks)));
		const onError = (error) => finish(() => reject(error));
		const onAbort = () => {
			finish(() => reject(signal.reason || abortError()));
			// Keep the connection usable long enough to return a finite deadline
			// response while discarding any remaining upload bytes.
			req.resume();
		};

		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function isLimitedPath(req) {
	const url = req.url || "";
	return (
		(url.startsWith("/v1/messages") &&
			!url.startsWith("/v1/messages/count_tokens")) ||
		url.startsWith("/v1/complete")
	);
}

function requiresAnthropicMessageStop(req) {
	return (req.url || "").split("?", 1)[0] === "/v1/messages";
}

function responseBodyIdleTimeoutError() {
	const error = new Error("upstream response body idle timeout");
	error.code = "GUARD_RESPONSE_IDLE_TIMEOUT";
	return error;
}

function isEventStreamResponse(response) {
	return (
		response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
		"text/event-stream"
	);
}

function semanticErrorTypeFromData(data) {
	try {
		const payload = JSON.parse(data);
		const candidate = payload?.error?.type ?? payload?.type;
		return typeof candidate === "string" && SAFE_SSE_ERROR_TYPES.has(candidate)
			? candidate
			: "unknown_error";
	} catch {
		return "unknown_error";
	}
}

/**
 * Incrementally recognizes SSE field framing without retaining response
 * content beyond one bounded event. A string such as "event: error" inside a
 * data field cannot trigger this observer: only an actual `event` field on a
 * dispatched SSE event is considered.
 */
function createSseOutcomeObserver({ requireMessageStop = false } = {}) {
	const decoder = new TextDecoder();
	let pendingLine = "";
	let eventName = "";
	let eventData = "";
	let eventBytes = 0;
	let dataLineSeen = false;
	let parserDisabled = false;
	let malformedSeen = false;
	let malformedReason = null;
	let limitExceeded = false;
	let messageStopSeen = false;
	let errorType = null;
	let compatibilityAliasCount = 0;
	let finished = false;

	const markMalformed = (reason) => {
		malformedSeen = true;
		malformedReason ??= reason;
	};

	const recordCompatibilityAlias = () => {
		compatibilityAliasCount = Math.min(
			MAX_SSE_COMPATIBILITY_ALIAS_COUNT,
			compatibilityAliasCount + 1,
		);
	};

	const resetEvent = () => {
		eventName = "";
		eventData = "";
		eventBytes = 0;
		dataLineSeen = false;
	};

	const disableParserForLimit = () => {
		parserDisabled = true;
		limitExceeded = true;
		pendingLine = "";
		resetEvent();
	};

	const dispatchEvent = () => {
		// The Anthropic provider deliberately passes through this transport
		// sentinel. It is benign framing, but it is not message_stop evidence.
		if (eventName === "" && dataLineSeen && eventData === "[DONE]") {
			resetEvent();
			return;
		}
		let payload;
		let payloadType;
		if (dataLineSeen) {
			try {
				payload = JSON.parse(eventData);
				payloadType =
					typeof payload === "object" && payload !== null
						? payload.type
						: undefined;
			} catch {
				markMalformed("invalid_json");
			}
		}
		const isCompatibilityPing =
			eventName === "message" &&
			dataLineSeen &&
			typeof payload === "object" &&
			payload !== null &&
			payloadType === "ping";
		const eventTypeMismatch =
			eventName !== "" &&
			typeof payloadType === "string" &&
			eventName !== payloadType;
		const resolvedType =
			eventName || (typeof payloadType === "string" ? payloadType : "");

		if (eventName === "error") {
			if (eventTypeMismatch) markMalformed("event_type_mismatch");
			errorType ??= semanticErrorTypeFromData(eventData);
		} else if (resolvedType === "message_stop") {
			const validMessageStop =
				dataLineSeen &&
				typeof payload === "object" &&
				payload !== null &&
				payloadType === "message_stop" &&
				(eventName === "" || eventName === "message_stop");
			if (validMessageStop) messageStopSeen = true;
			else markMalformed("invalid_message_stop");
		} else if (isCompatibilityPing) {
			recordCompatibilityAlias();
		} else if (eventTypeMismatch) {
			markMalformed("event_type_mismatch");
		}
		resetEvent();
	};

	const consumeLine = (rawLine) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") {
			dispatchEvent();
			return;
		}
		if (line.startsWith(":")) return;

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") {
			const valueBytes = Buffer.byteLength(value);
			if (eventBytes + valueBytes > MAX_SSE_OUTCOME_EVENT_BYTES) {
				disableParserForLimit();
				return;
			}
			eventName = value;
			eventBytes += valueBytes;
			return;
		}
		if (field !== "data") return;

		const separatorBytes = dataLineSeen ? 1 : 0;
		const valueBytes = Buffer.byteLength(value);
		if (
			eventBytes + separatorBytes + valueBytes >
			MAX_SSE_OUTCOME_EVENT_BYTES
		) {
			disableParserForLimit();
			return;
		}
		eventData += `${dataLineSeen ? "\n" : ""}${value}`;
		dataLineSeen = true;
		eventBytes += separatorBytes + valueBytes;
	};

	const consumeText = (text) => {
		if (parserDisabled) return;
		let start = 0;
		while (true) {
			const newline = text.indexOf("\n", start);
			if (newline === -1) break;
			const fragment = text.slice(start, newline);
			const completeLine = pendingLine + fragment;
			pendingLine = "";
			if (Buffer.byteLength(completeLine) > MAX_SSE_OUTCOME_EVENT_BYTES) {
				disableParserForLimit();
				return;
			}
			consumeLine(completeLine);
			if (parserDisabled) return;
			start = newline + 1;
		}

		const tail = text.slice(start);
		if (tail === "") return;
		if (
			Buffer.byteLength(pendingLine) + Buffer.byteLength(tail) >
			MAX_SSE_OUTCOME_EVENT_BYTES
		) {
			disableParserForLimit();
			return;
		}
		pendingLine += tail;
	};

	return {
		record(chunk) {
			if (parserDisabled) return;
			consumeText(decoder.decode(chunk, { stream: true }));
		},
		finish() {
			finished = true;
			if (!parserDisabled) consumeText(decoder.decode());
			// A terminal-looking tail is not protocol evidence: SSE dispatch requires
			// a blank line. Retain only the fact that framing was incomplete.
			if (
				!parserDisabled &&
				(pendingLine.trim() !== "" ||
					eventName !== "" ||
					dataLineSeen)
			) {
				markMalformed("unterminated_event");
			}
			pendingLine = "";
			resetEvent();
		},
		snapshot() {
			const semanticParseState = limitExceeded
				? "limit_exceeded"
				: malformedSeen
					? "malformed"
					: "clean";
			const parseReasonFields =
				malformedReason === null
					? {}
					: { semanticParseReason: malformedReason };
			const compatibilityFields =
				compatibilityAliasCount === 0
					? {}
					: {
							semanticCompatibilityAlias: "message_ping",
							semanticCompatibilityAliasCount: compatibilityAliasCount,
						};
			if (errorType !== null) {
				return {
						semanticEvent: "error",
						semanticErrorType: errorType,
						semanticParseState,
						...parseReasonFields,
						...compatibilityFields,
					};
			}
			// Once bounded observation stops, absence of message_stop is unknown,
			// not evidence that the upstream omitted it. Preserve any error already
			// observed above, but never manufacture incomplete_eof after the cap.
			if (
				requireMessageStop &&
				finished &&
				!messageStopSeen &&
				!limitExceeded
			) {
				return {
					semanticEvent: "incomplete_eof",
					semanticErrorType: "anthropic_incomplete_eof",
					semanticParseState,
					...parseReasonFields,
					...compatibilityFields,
				};
			}
			return semanticParseState === "clean"
				? compatibilityFields
				: {
						semanticParseState,
						...parseReasonFields,
						...compatibilityFields,
					};
		},
	};
}

function createRawResponseTelemetry(attemptStartedAt, now) {
	let rawResponseChunkCount = 0;
	let rawResponseBytes = 0;
	let firstChunkAt = null;
	let lastChunkAt = null;
	let maxInterChunkGapMs = 0;
	let sseOutcomeObserver = null;

	return {
		enableSseOutcomeObservation(options) {
			sseOutcomeObserver ??= createSseOutcomeObserver(options);
		},
		record(chunk) {
			const observedAt = now();
			if (firstChunkAt == null) firstChunkAt = observedAt;
			if (lastChunkAt != null) {
				maxInterChunkGapMs = Math.max(
					maxInterChunkGapMs,
					Math.max(0, observedAt - lastChunkAt),
				);
			}
			lastChunkAt = observedAt;
			rawResponseChunkCount += 1;
			rawResponseBytes += chunk?.byteLength ?? chunk?.length ?? 0;
			sseOutcomeObserver?.record(chunk);
		},
		finish() {
			sseOutcomeObserver?.finish();
		},
		snapshot() {
			const observedAt = now();
			return {
				rawResponseChunkCount,
				rawResponseBytes,
				firstBodyByteMs:
					firstChunkAt == null
						? null
						: Math.max(0, firstChunkAt - attemptStartedAt),
				maxInterChunkGapMs,
				lastChunkAgeMs:
					lastChunkAt == null ? null : Math.max(0, observedAt - lastChunkAt),
				...sseOutcomeObserver?.snapshot(),
			};
		},
	};
}

function withRawResponseTelemetry(response, telemetry, options = {}) {
	if (isEventStreamResponse(response)) {
		telemetry.enableSseOutcomeObservation(options);
	}
	if (!response.body) {
		telemetry.finish();
		return response;
	}
	const body = response.body.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				telemetry.record(chunk);
				controller.enqueue(chunk);
			},
			flush() {
				telemetry.finish();
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function rawResponseTelemetryFields(telemetry) {
	return telemetry ? telemetry.snapshot() : {};
}

function responseBodyIdleWatchdog(timeoutMs, onTimeout) {
	let timer = null;
	let watchdog;
	const arm = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const error = responseBodyIdleTimeoutError();
			try {
				Promise.resolve(onTimeout?.(error)).catch(() => {});
			} catch {
				// Preserve the idle-timeout error if cancellation itself fails.
			}
			watchdog.destroy(error);
		}, timeoutMs);
		timer.unref?.();
	};

	watchdog = new Transform({
		transform(chunk, _encoding, callback) {
			arm();
			callback(null, chunk);
		},
		destroy(error, callback) {
			if (timer) clearTimeout(timer);
			timer = null;
			callback(error);
		},
	});
	arm();
	return watchdog;
}

async function pipelineResponseBody(
	source,
	res,
	responseIdleTimeoutMs,
	onTimeout,
) {
	await pipeline(
		source,
		responseBodyIdleWatchdog(responseIdleTimeoutMs, onTimeout),
		res,
	);
}

async function sendFinalResponse(
	res,
	upstreamResponse,
	beginResponse,
	responseIdleTimeoutMs,
) {
	beginResponse();
	res.writeHead(
		upstreamResponse.status,
		responseHeaders(upstreamResponse.headers),
	);
	if (!upstreamResponse.body) {
		res.end();
		return;
	}
	await pipelineResponseBody(
		Readable.fromWeb(upstreamResponse.body),
		res,
		responseIdleTimeoutMs,
	);
}

async function sendBufferedResponse(
	res,
	upstreamResponse,
	buffer,
	beginResponse,
) {
	beginResponse();
	res.writeHead(
		upstreamResponse.status,
		responseHeaders(upstreamResponse.headers, buffer.length),
	);
	res.end(buffer);
}

const SOFT_INSPECTION_TIMEOUT = Symbol("soft-inspection-timeout");

// signal aborting rejects a pending read only when it is the SAME signal
// that was passed to the original fetch() call (undici couples a fetch's
// signal to its response body for the request's whole lifecycle); an
// unrelated AbortController never does. softSignal exists for exactly that
// case: a bounded, best-effort peek (P1 ordering) that must be able to give
// up on a stalled body on its OWN short timeout, without that timeout being
// mistaken for the caller's real deadline/client abort. The soft timeout
// races, but never cancels, the in-flight read: ownership of the prefix,
// pending read, and tail is returned together so a terminal response can be
// reconstructed byte-for-byte or a retry can explicitly cancel it.
async function readResponseForInspection(response, maxBytes, signal, softSignal) {
	if (!response.body) {
		return { oversized: false, buffer: Buffer.alloc(0) };
	}

	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		return { oversized: true, untouched: true };
	}

	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	let resolveSoftAbort;
	const softAbortPromise = softSignal
		? new Promise((resolve) => {
			resolveSoftAbort = resolve;
		})
		: null;
	const onSoftAbort = () => {
		resolveSoftAbort?.(SOFT_INSPECTION_TIMEOUT);
	};
	if (softSignal) {
		if (softSignal.aborted) onSoftAbort();
		else softSignal.addEventListener("abort", onSoftAbort, { once: true });
	}
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason || abortError();
			if (softSignal?.aborted) {
				if (bytes === 0) {
					reader.releaseLock();
					return {
						oversized: false,
						incomplete: true,
						untouched: true,
					};
				}
				return {
					oversized: false,
					incomplete: true,
					untouched: false,
					reader,
					prefix: chunks,
					pendingRead: null,
				};
			}
			const pendingRead = reader.read();
			const result = softAbortPromise
				? await Promise.race([pendingRead, softAbortPromise])
				: await pendingRead;
			if (result === SOFT_INSPECTION_TIMEOUT) {
				return {
					oversized: false,
					incomplete: true,
					untouched: false,
					reader,
					prefix: chunks,
					pendingRead,
				};
			}
			const { done, value } = result;
			if (done) {
				reader.releaseLock();
				return {
					oversized: false,
					buffer: Buffer.concat(chunks, bytes),
				};
			}
			const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			if (bytes + chunk.length > maxBytes) {
				return {
					oversized: true,
					untouched: false,
					reader,
					prefix: chunks,
					overflow: chunk,
				};
			}
			chunks.push(chunk);
			bytes += chunk.length;
		}
	} catch (error) {
		try {
			await reader.cancel(error);
		} catch {
			// Preserve the original read/abort failure.
		}
		try {
			reader.releaseLock();
		} catch {
			// A concurrent stream failure may already have released ownership.
		}
		throw error;
	} finally {
		softSignal?.removeEventListener("abort", onSoftAbort);
	}
}

async function cancelInspectedResponse(response, inspection) {
	if (inspection?.reader) {
		try {
			await inspection.reader.cancel();
		} catch {
			// Best-effort: the fetch signal may already have cancelled the body.
		}
		try {
			await inspection.pendingRead;
		} catch {
			// Settling the saved read prevents an unhandled rejection after cancel.
		}
		try {
			inspection.reader.releaseLock();
		} catch {
			// The reader may already have released after a concurrent failure.
		}
		return;
	}
	try {
		await response.body?.cancel();
	} catch {
		// Best-effort: a completed or concurrently cancelled body needs no cleanup.
	}
}

async function sendPartiallyReadResponse(
	res,
	upstreamResponse,
	inspection,
	beginResponse,
	responseIdleTimeoutMs,
) {
	if (inspection.untouched) {
		await sendFinalResponse(
			res,
			upstreamResponse,
			beginResponse,
			responseIdleTimeoutMs,
		);
		return;
	}

	async function* chunks() {
		let completed = false;
		let pendingRead = inspection.pendingRead;
		try {
			for (const chunk of inspection.prefix || []) yield chunk;
			if (inspection.overflow) yield inspection.overflow;
			while (true) {
				const result = pendingRead
					? await pendingRead
					: await inspection.reader.read();
				pendingRead = null;
				const { done, value } = result;
				if (done) {
					completed = true;
					return;
				}
				yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			}
		} finally {
			if (!completed) {
				try {
					await inspection.reader.cancel();
				} catch {
					// The idle watchdog/client may already have cancelled the stream.
				}
			}
			try {
				inspection.reader.releaseLock();
			} catch {
				// The stream may already have released ownership after an error.
			}
		}
	}

	beginResponse();
	res.writeHead(
		upstreamResponse.status,
		responseHeaders(upstreamResponse.headers),
	);
	await pipelineResponseBody(
		Readable.from(chunks()),
		res,
		responseIdleTimeoutMs,
		(error) => inspection.reader.cancel(error),
	);
}

function resolveUpstreamTarget(requestTarget, upstreamUrl) {
	if (
		typeof requestTarget !== "string" ||
		!requestTarget.startsWith("/") ||
		requestTarget.startsWith("//") ||
		requestTarget.includes("\\") ||
		requestTarget.includes("#")
	) {
		return null;
	}

	try {
		const resolved = new URL(requestTarget, upstreamUrl);
		return resolved.origin === upstreamUrl.origin ? resolved : null;
	} catch {
		return null;
	}
}

// R21: terminal upstream-driven responses are labeled unambiguously so a
// forwarded client error (e.g. a 402) can never be mistaken for a success in
// the guard's own logs and health counters, unlike the legacy guard's
// `proxy_success` event, which used to fire for any status outside a
// specific retry-candidate list, including 400/402/403/404.
export function outcomeForStatus(status) {
	return status >= 200 && status < 300 ? "success" : "final_error";
}

export function planRecoveryAction({
	recoveryDelayMs,
	elapsedMs,
	remainingMs,
	retryAttemptHeadroomMs,
	recoverySilenceBudgetMs,
	jitterMs,
	random,
}) {
	if (!Number.isFinite(recoveryDelayMs) || recoveryDelayMs < 0) {
		return { kind: "forward", reason: "recovery_delay_invalid" };
	}
	const silenceRemainingMs = recoverySilenceBudgetMs - elapsedMs;
	const deadlineDelayBudgetMs = remainingMs - retryAttemptHeadroomMs;
	const silenceDelayBudgetMs = silenceRemainingMs - retryAttemptHeadroomMs;
	if (silenceDelayBudgetMs < 0 || recoveryDelayMs > silenceDelayBudgetMs) {
		return {
			kind: "forward",
			reason: "recovery_silence_budget_exceeded",
		};
	}
	if (deadlineDelayBudgetMs < 0 || recoveryDelayMs > deadlineDelayBudgetMs) {
		return { kind: "forward", reason: "recovery_beyond_deadline" };
	}
	const availableDelayMs = Math.min(
		deadlineDelayBudgetMs,
		silenceDelayBudgetMs,
	);
	const requestedJitter = Math.max(0, Math.floor(random() * jitterMs));
	return {
		kind: "retry",
		availableDelayMs,
		delayMs:
			recoveryDelayMs +
			Math.min(requestedJitter, availableDelayMs - recoveryDelayMs),
	};
}

export function createGuard(options = {}) {
	const env = options.env || process.env;
	const listenHost = options.listenHost ?? env.GUARD_HOST ?? "127.0.0.1";
	const listenPort = configuredNumber(
		options.listenPort ?? env.GUARD_PORT ?? env.PORT,
		8788,
	);
	const upstreamBase =
		options.upstreamBase ?? env.CCFLARE_UPSTREAM ?? "http://127.0.0.1:8789";
	const upstreamUrl = new URL(upstreamBase);
	const maxActive = Math.max(
		1,
		Math.floor(
			configuredNumber(options.maxActive ?? env.GUARD_MAX_ACTIVE, 4),
		),
	);
	const maxQueue = Math.max(
		0,
		Math.floor(
			configuredNumber(options.maxQueue ?? env.GUARD_MAX_QUEUE, 500),
		),
	);
	const maxRecoveryWaits = configuredBoundedInteger(
		options.maxRecoveryWaits ?? env.GUARD_MAX_RECOVERY_WAITS,
		maxActive,
		{
			name: "GUARD_MAX_RECOVERY_WAITS",
			min: 1,
			max: 1_000_000,
		},
	);
	const totalDeadlineMs = Math.max(
		1,
		configuredNumber(
			options.totalDeadlineMs ??
				env.GUARD_TOTAL_DEADLINE_MS ??
				options.maxWaitMs ??
				env.GUARD_MAX_WAIT_MS,
			DEFAULT_GUARD_TOTAL_DEADLINE_MS,
		),
	);
	const retryAttemptHeadroomMs = Math.max(
		1,
		Math.floor(
			configuredNumber(
				options.retryAttemptHeadroomMs ??
					env.GUARD_RETRY_ATTEMPT_HEADROOM_MS,
				DEFAULT_GUARD_RETRY_ATTEMPT_HEADROOM_MS,
			),
		),
	);
	const maxRecoverySleepMs = configuredBoundedInteger(
		options.maxRecoverySleepMs ?? env.GUARD_MAX_RECOVERY_SLEEP_MS,
		DEFAULT_GUARD_MAX_RECOVERY_SLEEP_MS,
		{
			name: "GUARD_MAX_RECOVERY_SLEEP_MS",
			min: 1,
			max: MAX_GUARD_RECOVERY_SILENCE_MS,
		},
	);
	const maxAttempts = Math.max(
		1,
		Math.floor(
			configuredNumber(
				options.maxAttempts ?? env.GUARD_MAX_ATTEMPTS,
				DEFAULT_GUARD_MAX_ATTEMPTS,
			),
		),
	);
	const jitterMs = Math.max(
		0,
		configuredNumber(
			options.jitterMs ?? env.GUARD_RETRY_JITTER_MS,
			DEFAULT_GUARD_RETRY_JITTER_MS,
		),
	);
	const maxInspectionBytes = Math.max(
		1,
		Math.floor(
			configuredNumber(
				options.maxInspectionBytes ?? env.GUARD_MAX_INSPECTION_BYTES,
				DEFAULT_GUARD_MAX_INSPECTION_BYTES,
			),
		),
	);
	const responseIdleTimeoutMs = Math.max(
		1,
		Math.floor(
			configuredNumber(
				options.responseIdleTimeoutMs ??
					env.GUARD_RESPONSE_IDLE_TIMEOUT_MS,
				DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS,
			),
		),
	);
	const delayInspectionTimeoutMs = Math.max(
		1,
		Math.floor(
			configuredNumber(
				options.delayInspectionTimeoutMs ??
					env.GUARD_DELAY_INSPECTION_TIMEOUT_MS,
				DEFAULT_GUARD_DELAY_INSPECTION_TIMEOUT_MS,
			),
		),
	);
	const allowLegacyPoolBody = configuredBoolean(
		options.allowLegacyPoolBody ?? env.GUARD_ALLOW_LEGACY_POOL_BODY,
		DEFAULT_GUARD_ALLOW_LEGACY_POOL_BODY,
	);
	const shutdownGraceMs = configuredNumber(
		options.shutdownGraceMs ?? env.GUARD_SHUTDOWN_GRACE_MS,
		600_000,
	);
	const sourceId =
		options.sourceId ?? env.GUARD_SOURCE_ID ?? DEFAULT_GUARD_SOURCE_ID;
	const policyId =
		options.policyId ?? env.GUARD_POLICY_ID ?? DEFAULT_GUARD_POLICY_ID;
	const fetchImpl = options.fetchImpl || fetch;
	const now = options.now || Date.now;
	const random = options.random || Math.random;
	const logger = options.logger || console.log;
	const runtimeIdentity = inspectRuntimeIdentity({
		upstreamPid: env.GUARD_UPSTREAM_PID,
		procRoot: options.procRoot,
		guardPath: options.guardPath,
		policyPath: options.policyPath,
		runnerPid: options.runnerPid,
		guardPid: options.guardPid,
	});

	const counters = {
		startedAt: new Date(now()).toISOString(),
		total: 0,
		queued: 0,
		retried: 0,
		poolExhausted: 0,
		overload529: 0,
		upstream429: 0,
		queueFull: 0,
		aborted: 0,
		deadlineExceeded: 0,
		recoveryBeyondDeadline: 0,
		recoverySleepCapExceeded: 0,
		recoverySilenceBudgetExceeded: 0,
		recoveryWaitCapacityFull: 0,
		recoveryWaitAdmitted: 0,
		recoveryWaitReleased: 0,
		recoveryByScope: { pool: 0, model: 0, legacy: 0 },
		recoveryWaitAdmittedByScope: { pool: 0, model: 0, legacy: 0 },
		recoveryWaitRejectedByScope: { pool: 0, model: 0, legacy: 0 },
		attemptsExhausted: 0,
		oversizedInspectionBodies: 0,
		responseBodyIdleTimeouts: 0,
		drainingRejected: 0,
		// R21: per-outcome counts for terminal upstream-driven responses logged
		// via proxy_response/proxy_final_error (see outcomeForStatus above).
		success: 0,
		finalError: 0,
	};
	let active = 0;
	let activeRecoveryWaits = 0;
	let peakRecoveryWaits = 0;
	let draining = false;
	const queue = [];

	function log(event, data = {}) {
		logger(
			JSON.stringify({
				ts: new Date(now()).toISOString(),
				event,
				active,
				queue: queue.length,
				recoveryWaits: activeRecoveryWaits,
				sourceId,
				policyId,
				...data,
			}),
		);
	}

	function grantLease(queuedMs) {
		active += 1;
		let released = false;
		return {
			queuedMs,
			release() {
				if (released) return;
				released = true;
				active = Math.max(0, active - 1);
				drainQueue();
			},
		};
	}

	function drainQueue() {
		while (active < maxActive && queue.length > 0) {
			const next = queue.shift();
			if (!next || next.settled) continue;
			next.settled = true;
			next.signal?.removeEventListener("abort", next.abort);
			next.resolve(grantLease(now() - next.enqueuedAt));
		}
	}

	function acquire(id, signal) {
		if (signal?.aborted) {
			return Promise.reject(signal.reason || abortError());
		}
		// Do not let a newly arriving retry jump ahead of an existing waiter.
		if (active < maxActive && queue.length === 0) {
			return Promise.resolve(grantLease(0));
		}
		if (queue.length >= maxQueue) {
			counters.queueFull += 1;
			const error = new Error("guard queue full");
			error.code = "GUARD_QUEUE_FULL";
			return Promise.reject(error);
		}

		counters.queued += 1;
		const enqueuedAt = now();
		return new Promise((resolve, reject) => {
			const entry = {
				id,
				enqueuedAt,
				resolve,
				reject,
				signal,
				abort: null,
				settled: false,
			};
			const abort = () => {
				if (entry.settled) return;
				entry.settled = true;
				const index = queue.indexOf(entry);
				if (index !== -1) queue.splice(index, 1);
				reject(signal?.reason || abortError());
			};
			entry.abort = abort;
			if (signal) {
				if (signal.aborted) {
					abort();
					return;
				}
				signal.addEventListener("abort", abort, { once: true });
			}
			queue.push(entry);
		});
	}

	function recoveryScopeKey(scope) {
		return scope === "pool" || scope === "model" ? scope : "legacy";
	}

	function recordTrustedRecovery(scope) {
		counters.recoveryByScope[recoveryScopeKey(scope)] += 1;
	}

	function tryAcquireRecoveryWait(scope) {
		const key = recoveryScopeKey(scope);
		if (activeRecoveryWaits >= maxRecoveryWaits) {
			counters.recoveryWaitCapacityFull += 1;
			counters.recoveryWaitRejectedByScope[key] += 1;
			return null;
		}
		activeRecoveryWaits += 1;
		peakRecoveryWaits = Math.max(peakRecoveryWaits, activeRecoveryWaits);
		counters.recoveryWaitAdmitted += 1;
		counters.recoveryWaitAdmittedByScope[key] += 1;
		let released = false;
		return {
			release() {
				if (released) return;
				released = true;
				activeRecoveryWaits = Math.max(0, activeRecoveryWaits - 1);
				counters.recoveryWaitReleased += 1;
			},
		};
	}

	function sleep(ms, signal) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const timer = setTimeout(finish, Math.max(0, ms));
			const abort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(signal?.reason || abortError());
			};
			if (signal) {
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
		});
	}

	async function fetchUpstream(
		req,
		body,
		signal,
		upstreamTarget,
		guardRequestId,
	) {
		const init = {
			method: req.method,
			headers: requestHeaders(req, body.length, guardRequestId),
			redirect: "manual",
			signal,
		};
		if (!["GET", "HEAD"].includes(req.method || "GET")) init.body = body;
		return fetchImpl(upstreamTarget, init);
	}

	function recordForwardedStatus(status) {
		if (status === 529) counters.overload529 += 1;
		if (status === 429) counters.upstream429 += 1;
	}

	function createRequestContext(req, res) {
		const acceptedAt = now();
		const deadlineAt = acceptedAt + totalDeadlineMs;
		const deadlineController = new AbortController();
		const clientController = new AbortController();
		const combined = combineAbortSignals([
			deadlineController.signal,
			clientController.signal,
		]);
		let abortCause = null;
		let responseBegun = false;
		let disposed = false;

		const expireDeadline = () => {
			if (responseBegun || deadlineController.signal.aborted) return;
			if (abortCause == null) abortCause = "deadline";
			deadlineController.abort(deadlineError());
		};
		const abortClient = () => {
			if (clientController.signal.aborted) return;
			if (abortCause == null) abortCause = "client";
			clientController.abort(abortError());
		};
		const onResponseClose = () => {
			if (!res.writableEnded) abortClient();
		};
		const onSocketClose = () => {
			if (!res.writableEnded) abortClient();
		};
		const deadlineTimer = setTimeout(
			expireDeadline,
			Math.max(0, totalDeadlineMs),
		);
		req.on("aborted", abortClient);
		res.on("close", onResponseClose);
		req.socket.on("close", onSocketClose);

		return {
			id: randomUUID(),
			acceptedAt,
			deadlineAt,
			signal: combined.signal,
			get abortCause() {
				return abortCause;
			},
			get responseBegun() {
				return responseBegun;
			},
			beginResponse() {
				if (responseBegun) return;
				responseBegun = true;
				clearTimeout(deadlineTimer);
			},
			expireDeadline,
			ensureBudget() {
				if (combined.signal.aborted) {
					throw combined.signal.reason || abortError();
				}
				if (now() >= deadlineAt) {
					expireDeadline();
					throw combined.signal.reason || deadlineError();
				}
			},
			remainingMs() {
				return Math.max(0, deadlineAt - now());
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				clearTimeout(deadlineTimer);
				req.off("aborted", abortClient);
				res.off("close", onResponseClose);
				req.socket.off("close", onSocketClose);
				combined.dispose();
			},
		};
	}

	function sendJsonError(res, context, status, type, message, headers = {}) {
		if (res.headersSent || res.destroyed) return;
		context.beginResponse();
		res.writeHead(status, {
			"content-type": "application/json",
			"cache-control": "no-store",
			...headers,
		});
		res.end(
			JSON.stringify({
				type: "error",
				error: { type, message },
			}),
		);
	}

	function handleAbort(error, res, context, attempt, responseTelemetry) {
		const elapsedMs = now() - context.acceptedAt;
		if (
			context.abortCause === "deadline" ||
			error?.code === "GUARD_DEADLINE_EXCEEDED"
		) {
			counters.deadlineExceeded += 1;
			log("guard_deadline_exceeded", {
				id: context.id,
				attempt,
				elapsedMs,
			});
			sendJsonError(
				res,
				context,
				504,
				"guard_deadline_exceeded",
				"local guard request deadline exceeded",
			);
			return true;
		}
		if (
			context.abortCause === "client" ||
			error?.name === "AbortError" ||
			context.signal.aborted
		) {
			counters.aborted += 1;
			log("client_aborted", {
				id: context.id,
				attempt,
				elapsedMs,
				...rawResponseTelemetryFields(responseTelemetry),
			});
			return true;
		}
		return false;
	}

	function handleResponseBodyIdleTimeout(
		error,
		res,
		context,
		attempt,
		responseTelemetry,
	) {
		if (error?.code !== "GUARD_RESPONSE_IDLE_TIMEOUT") return false;
		counters.responseBodyIdleTimeouts += 1;
		log("response_body_idle_timeout", {
			id: context.id,
			attempt,
			elapsedMs: now() - context.acceptedAt,
			responseIdleTimeoutMs,
			...rawResponseTelemetryFields(responseTelemetry),
		});
		if (!res.destroyed) res.destroy(error);
		return true;
	}

	function sendQueueFull(res, context) {
		sendJsonError(
			res,
			context,
			503,
			"guard_queue_full",
			"local guard queue is full",
			{ "retry-after": "30" },
		);
	}

	function sendAttemptsExhausted(res, context, attempt) {
		counters.attemptsExhausted += 1;
		log("guard_attempts_exhausted", {
			id: context.id,
			attempt,
			elapsedMs: now() - context.acceptedAt,
		});
		sendJsonError(
			res,
			context,
			503,
			"guard_retry_attempts_exhausted",
			"local guard retry attempt limit reached",
		);
	}

	async function forwardRecoveryWithoutRetry(
		res,
		context,
		attempt,
		upstreamResponse,
		{
			buffer,
			inspection,
			recoveryDelayMs,
			recoverySource,
			remainingMs,
			reason,
		},
	) {
		if (inspection?.oversized || inspection?.incomplete) {
			await sendPartiallyReadResponse(
				res,
				upstreamResponse,
				inspection,
				context.beginResponse,
				responseIdleTimeoutMs,
			);
		} else if (buffer === undefined) {
			await sendFinalResponse(
				res,
				upstreamResponse,
				context.beginResponse,
				responseIdleTimeoutMs,
			);
		} else {
			await sendBufferedResponse(
				res,
				upstreamResponse,
				buffer,
				context.beginResponse,
			);
		}
		switch (reason) {
			case "recovery_silence_budget_exceeded":
				counters.recoverySilenceBudgetExceeded += 1;
				// Compatibility counter retained for existing dashboards.
				counters.recoverySleepCapExceeded += 1;
				break;
			case "recovery_beyond_deadline":
				counters.recoveryBeyondDeadline += 1;
				break;
			case "recovery_wait_capacity_full":
			case "recovery_delay_invalid":
				break;
			default:
				throw new Error(`unknown recovery forward reason: ${reason}`);
		}
		counters.finalError += 1;
		log("proxy_final_error", {
			id: context.id,
			attempt,
			status: upstreamResponse.status,
			outcome: outcomeForStatus(upstreamResponse.status),
			reason,
			recoverySource,
			recoveryDelayMs,
			remainingMs,
			retryAttemptHeadroomMs,
			maxRecoverySleepMs,
			elapsedMs: now() - context.acceptedAt,
		});
	}

	async function handleLimited(req, res, body, context, upstreamTarget) {
		const { id } = context;
		counters.total += 1;
		let attempt = 0;
		let responseTelemetry = null;
		try {
			while (true) {
				context.ensureBudget();
				if (attempt >= maxAttempts) {
					sendAttemptsExhausted(res, context, attempt);
					return;
				}

				let lease;
				try {
					lease = await acquire(id, context.signal);
				} catch (error) {
					if (error?.code === "GUARD_QUEUE_FULL") {
						sendQueueFull(res, context);
						return;
					}
					throw error;
				}

				let upstreamResponse;
				try {
					// The absolute deadline and attempt budget are rechecked after the
					// fair queue wait, immediately before every upstream fetch.
					context.ensureBudget();
					if (attempt >= maxAttempts) {
						lease.release();
						sendAttemptsExhausted(res, context, attempt);
						return;
					}
					attempt += 1;
					responseTelemetry = createRawResponseTelemetry(now(), now);
					upstreamResponse = withRawResponseTelemetry(
						await fetchUpstream(
							req,
							body,
							context.signal,
							upstreamTarget,
							id,
						),
						responseTelemetry,
						{
							requireMessageStop: requiresAnthropicMessageStop(req),
						},
					);
				} catch (error) {
					lease.release();
					throw error;
				}

				// Only a 503 can satisfy the narrow trusted finite-recovery policy. Every other
				// status, including raw 402/429/529 and generic 5xx, is streamed
				// through without buffering or a second upstream request. R21/P2:
				// the outcome is counted and logged only after the send actually
				// resolves, so a response that begins but then fails mid-stream
				// (e.g. the idle watchdog) is never mislabeled a success; on
				// failure, the outer catch below records the real stop cause.
				if (upstreamResponse.status !== 503) {
					recordForwardedStatus(upstreamResponse.status);
					try {
						await sendFinalResponse(
							res,
							upstreamResponse,
							context.beginResponse,
							responseIdleTimeoutMs,
						);
					} finally {
						lease.release();
					}
					const telemetryFields =
						rawResponseTelemetryFields(responseTelemetry);
					const outcome =
						telemetryFields.semanticEvent === "error" ||
						telemetryFields.semanticEvent === "incomplete_eof"
							? "final_error"
							: outcomeForStatus(upstreamResponse.status);
					if (outcome === "success") {
						counters.success += 1;
					} else {
						counters.finalError += 1;
					}
					log("proxy_response", {
						id,
						attempt,
						status: upstreamResponse.status,
						outcome,
						queuedMs: lease.queuedMs,
						elapsedMs: now() - context.acceptedAt,
						...telemetryFields,
					});
					return;
				}

				// P1 ordering/spoofing: the header is classified at HEADER time,
				// before any body I/O, and settles retry authority on its own.
				// An oversized, stalled, or malformed body must never cost a
				// header-confirmed retry its authorization (ordering), and a
				// header-absent body must never silently grant one unless the
				// operator has explicitly opted into the legacy fallback
				// (spoofing).
				const headerDecision = recoveryHeaderStatus({
					status: upstreamResponse.status,
					headers: upstreamResponse.headers,
				});
				const headerStatus = headerDecision.kind;

				if (headerStatus === "confirmed") {
					// Retry is already authorized. Release the slot immediately:
					// nothing past this point should hold a concurrency permit
					// hostage to upstream body I/O.
					lease.release();

					const headerHint = evaluateGuardRetry({
						status: upstreamResponse.status,
						headers: upstreamResponse.headers,
						bodyText: "",
						nowMs: now(),
						allowLegacyBody: allowLegacyPoolBody,
					});
					let delayMs = headerHint.delayMs;
					let recoverySource = headerHint.recoverySource;
					const recoveryScope = headerDecision.scope;
					let inspection;
					const headerRemainingMs = context.remainingMs();
					const headerAction = planRecoveryAction({
						recoveryDelayMs: delayMs,
						elapsedMs: now() - context.acceptedAt,
						remainingMs: headerRemainingMs,
						retryAttemptHeadroomMs,
						recoverySilenceBudgetMs: maxRecoverySleepMs,
						jitterMs,
						random,
					});
					counters.poolExhausted += 1;
					recordTrustedRecovery(recoveryScope);

					// Preserve an infeasible trusted terminal untouched. The caller then
					// owns the visible retry cadence instead of timing out in guard silence.
					if (headerAction.kind === "forward") {
						await forwardRecoveryWithoutRetry(
							res,
							context,
							attempt,
							upstreamResponse,
							{
								recoveryDelayMs: delayMs,
								recoverySource,
								remainingMs: headerRemainingMs,
								reason: headerAction.reason,
							},
						);
						return;
					}

					// Preserve at least half of all spare retry budget during the
					// bounded peek. A complete body may reveal a later blocker, but
					// can never shorten the authoritative Retry-After minimum; an
					// incomplete body cannot change the seeded header-time hint.
					const inspectionSlackMs =
						headerAction.availableDelayMs - delayMs;
					const peekTimeoutMs = Math.min(
						delayInspectionTimeoutMs,
						Math.max(0, Math.floor(inspectionSlackMs / 2)),
					);
					if (peekTimeoutMs > 0) {
						const peekController = new AbortController();
						const peekTimer = setTimeout(
							() => peekController.abort(),
							peekTimeoutMs,
						);
						peekTimer.unref?.();
						try {
							inspection = await readResponseForInspection(
								upstreamResponse,
								maxInspectionBytes,
								context.signal,
								peekController.signal,
							);
							if (inspection.oversized) {
								counters.oversizedInspectionBodies += 1;
							} else if (!inspection.incomplete) {
								const hint = evaluateGuardRetry({
									status: upstreamResponse.status,
									headers: upstreamResponse.headers,
									bodyText: inspection.buffer.toString("utf8"),
									nowMs: now(),
									allowLegacyBody: allowLegacyPoolBody,
								});
								delayMs = hint.delayMs;
								recoverySource = hint.recoverySource;
							}
						} catch (error) {
							// A genuine deadline/client abort must still propagate; the
							// bounded peek's own short timeout (or any other body-read
							// error) keeps the seeded header hint.
							if (context.signal.aborted) throw error;
						} finally {
							clearTimeout(peekTimer);
						}
					}

					try {
						context.ensureBudget();
					} catch (error) {
						await cancelInspectedResponse(upstreamResponse, inspection);
						throw error;
					}
					const remainingMs = context.remainingMs();
					const action = planRecoveryAction({
						recoveryDelayMs: delayMs,
						elapsedMs: now() - context.acceptedAt,
						remainingMs,
						retryAttemptHeadroomMs,
						recoverySilenceBudgetMs: maxRecoverySleepMs,
						jitterMs,
						random,
					});
					if (action.kind === "forward") {
						await forwardRecoveryWithoutRetry(
							res,
							context,
							attempt,
							upstreamResponse,
							{
								buffer:
									inspection?.oversized || inspection?.incomplete
									? undefined
									: inspection?.buffer,
								inspection,
								recoveryDelayMs: delayMs,
								recoverySource,
								remainingMs,
								reason: action.reason,
							},
						);
						return;
					}
					if (attempt >= maxAttempts) {
						await cancelInspectedResponse(upstreamResponse, inspection);
						sendAttemptsExhausted(res, context, attempt);
						return;
					}
					const waitLease = tryAcquireRecoveryWait(recoveryScope);
					if (waitLease === null) {
						await forwardRecoveryWithoutRetry(
							res,
							context,
							attempt,
							upstreamResponse,
							{
								buffer:
									inspection?.oversized || inspection?.incomplete
										? undefined
										: inspection?.buffer,
								inspection,
								recoveryDelayMs: delayMs,
								recoverySource,
								remainingMs,
								reason: "recovery_wait_capacity_full",
							},
						);
						return;
					}
					try {
						await cancelInspectedResponse(upstreamResponse, inspection);
						counters.retried += 1;
						log("proxy_retry_wait", {
							id,
							attempt,
							status: upstreamResponse.status,
							reason: "trusted_finite_recovery",
							recoveryScope,
							recoverySource,
							delayMs: action.delayMs,
							elapsedMs: now() - context.acceptedAt,
						});
						await sleep(action.delayMs, context.signal);
					} finally {
						waitLease.release();
					}
					continue;
				}

				if (headerStatus === "absent" && allowLegacyPoolBody) {
					// Rolling-upgrade escape hatch: the header is absent (e.g. an
					// older, not-yet-redeployed proxy), and the operator has
					// explicitly opted into trusting a bounded, buffered body-shape
					// check instead. Unlike the confirmed-header path, no header
					// has authorized retry yet, so this read is governed by the
					// real deadline, not a short best-effort peek.
					let inspection;
					try {
						inspection = await readResponseForInspection(
							upstreamResponse,
							maxInspectionBytes,
							context.signal,
						);
					} catch (error) {
						lease.release();
						throw error;
					}
					if (inspection.oversized) {
						counters.oversizedInspectionBodies += 1;
						counters.finalError += 1;
						log("proxy_final_error", {
							id,
							attempt,
							status: upstreamResponse.status,
							outcome: outcomeForStatus(upstreamResponse.status),
							reason: "inspection_body_too_large",
							elapsedMs: now() - context.acceptedAt,
						});
						try {
							await sendPartiallyReadResponse(
								res,
								upstreamResponse,
								inspection,
								context.beginResponse,
								responseIdleTimeoutMs,
							);
						} finally {
							lease.release();
						}
						return;
					}

					lease.release();
					const buffer = inspection.buffer;
					const decision = evaluateGuardRetry({
						status: upstreamResponse.status,
						headers: upstreamResponse.headers,
						bodyText: buffer.toString("utf8"),
						nowMs: now(),
						allowLegacyBody: allowLegacyPoolBody,
					});
					const elapsedMs = now() - context.acceptedAt;
					if (!decision.retry) {
						counters.finalError += 1;
						log("proxy_final_error", {
							id,
							attempt,
							status: upstreamResponse.status,
							outcome: outcomeForStatus(upstreamResponse.status),
							reason: decision.reason,
							elapsedMs,
						});
						await sendBufferedResponse(
							res,
							upstreamResponse,
							buffer,
							context.beginResponse,
						);
						return;
					}

					counters.poolExhausted += 1;
					recordTrustedRecovery(decision.recoveryScope);
					context.ensureBudget();
					const remainingMs = context.remainingMs();
					const action = planRecoveryAction({
						recoveryDelayMs: decision.delayMs,
						elapsedMs: now() - context.acceptedAt,
						remainingMs,
						retryAttemptHeadroomMs,
						recoverySilenceBudgetMs: maxRecoverySleepMs,
						jitterMs,
						random,
					});
					if (action.kind === "forward") {
						await forwardRecoveryWithoutRetry(
							res,
							context,
							attempt,
							upstreamResponse,
							{
								buffer,
								recoveryDelayMs: decision.delayMs,
								recoverySource: decision.recoverySource,
								remainingMs,
								reason: action.reason,
							},
						);
						return;
					}
					if (attempt >= maxAttempts) {
						sendAttemptsExhausted(res, context, attempt);
						return;
					}
					const waitLease = tryAcquireRecoveryWait(decision.recoveryScope);
					if (waitLease === null) {
						await forwardRecoveryWithoutRetry(
							res,
							context,
							attempt,
							upstreamResponse,
							{
								buffer,
								recoveryDelayMs: decision.delayMs,
								recoverySource: decision.recoverySource,
								remainingMs,
								reason: "recovery_wait_capacity_full",
							},
						);
						return;
					}
					try {
						counters.retried += 1;
						log("proxy_retry_wait", {
							id,
							attempt,
							status: upstreamResponse.status,
							reason: decision.reason,
							recoveryScope: decision.recoveryScope,
							recoverySource: decision.recoverySource,
							delayMs: action.delayMs,
							elapsedMs,
						});
						await sleep(action.delayMs, context.signal);
					} finally {
						waitLease.release();
					}
					continue;
				}

				// Header denies exhaustion, or is absent and the legacy body-only
				// fallback is disabled (default): the retry decision needs no
				// body at all, so stream the response straight through rather
				// than buffering it under the inspection cap for nothing.
				counters.finalError += 1;
				log("proxy_final_error", {
					id,
					attempt,
					status: upstreamResponse.status,
					outcome: outcomeForStatus(upstreamResponse.status),
					reason:
						headerStatus === "denied"
							? "recovery_not_authorized"
							: "header_absent_legacy_body_disabled",
					elapsedMs: now() - context.acceptedAt,
				});
				try {
					await sendFinalResponse(
						res,
						upstreamResponse,
						context.beginResponse,
						responseIdleTimeoutMs,
					);
				} finally {
					lease.release();
				}
				return;
			}
		} catch (error) {
			if (
				handleResponseBodyIdleTimeout(
					error,
					res,
					context,
					attempt,
					responseTelemetry,
				)
			) {
				return;
			}
			if (handleAbort(error, res, context, attempt, responseTelemetry)) return;
			log("proxy_exception", {
				id,
				attempt,
				message: error.message,
				...rawResponseTelemetryFields(responseTelemetry),
			});
			if (res.headersSent) {
				res.destroy(error);
			} else {
				sendJsonError(
					res,
					context,
					502,
					"guard_upstream_error",
					error.message,
				);
			}
		}
	}

	async function handlePassthrough(req, res, body, context, upstreamTarget) {
		let responseTelemetry = null;
		try {
			context.ensureBudget();
			responseTelemetry = createRawResponseTelemetry(now(), now);
			const upstreamResponse = withRawResponseTelemetry(
				await fetchUpstream(
					req,
					body,
					context.signal,
					upstreamTarget,
					context.id,
				),
				responseTelemetry,
			);
			await sendFinalResponse(
				res,
				upstreamResponse,
				context.beginResponse,
				responseIdleTimeoutMs,
			);
		} catch (error) {
			if (
				handleResponseBodyIdleTimeout(
					error,
					res,
					context,
					1,
					responseTelemetry,
				)
			) {
				return;
			}
			if (handleAbort(error, res, context, 1, responseTelemetry)) return;
			log("proxy_exception", {
				id: context.id,
				attempt: 1,
				message: error.message,
				...rawResponseTelemetryFields(responseTelemetry),
			});
			if (res.headersSent) {
				res.destroy(error);
			} else {
				sendJsonError(
					res,
					context,
					502,
					"guard_upstream_error",
					error.message,
				);
			}
		}
	}

	const server = http.createServer(async (req, res) => {
		// server.close() stops accepting new TCP connections, but a connection
		// with an in-flight request can still present another keep-alive request.
		// Gate admission before reading its body or acquiring a concurrency lease
		// so shutdown cannot be prolonged by work accepted after the signal.
		if (draining) {
			const context = createRequestContext(req, res);
			counters.drainingRejected += 1;
			log("guard_draining", { id: context.id });
			req.resume();
			sendJsonError(
				res,
				context,
				503,
				"guard_draining",
				"local guard is draining",
				{
					"retry-after": "1",
					connection: "close",
				},
			);
			context.dispose();
			return;
		}

		if (req.url === "/_guard/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					status: "ok",
					sourceId,
					policyId,
					source: sourceId,
					policy: policyId,
					listenHost,
					listenPort,
					upstreamBase,
					maxActive,
					maxRecoveryWaits,
					maxAttempts,
					totalDeadlineMs,
					retryAttemptHeadroomMs,
					maxRecoverySleepMs,
					recoverySilenceBudgetMs: maxRecoverySleepMs,
					jitterMs,
					maxInspectionBytes,
					responseIdleTimeoutMs,
					delayInspectionTimeoutMs,
					allowLegacyPoolBody,
					shutdownGraceMs,
					draining,
					runtime: {
						...runtimeIdentity,
						limits: {
							totalDeadlineMs,
							retryAttemptHeadroomMs,
							maxRecoverySleepMs,
							recoverySilenceBudgetMs: maxRecoverySleepMs,
							maxAttempts,
							jitterMs,
							maxInspectionBytes,
							responseIdleTimeoutMs,
							delayInspectionTimeoutMs,
							allowLegacyPoolBody,
							shutdownGraceMs,
							maxActive,
							maxQueue,
							maxRecoveryWaits,
						},
					},
					active,
					queued: queue.length,
					recoveryWaits: {
						configured: maxRecoveryWaits,
						current: activeRecoveryWaits,
						peak: peakRecoveryWaits,
					},
					counters,
				}),
			);
			return;
		}

		const context = createRequestContext(req, res);
		const upstreamTarget = resolveUpstreamTarget(req.url, upstreamUrl);
		if (!upstreamTarget) {
			req.resume();
			sendJsonError(
				res,
				context,
				400,
				"guard_invalid_request_target",
				"request target must be a valid origin-form path",
			);
			context.dispose();
			return;
		}

		let body;
		try {
			body = await readBody(req, context.signal);
		} catch (error) {
			if (!handleAbort(error, res, context, 0, null)) {
				sendJsonError(
					res,
					context,
					400,
					"guard_bad_request",
					error.message,
				);
			}
			context.dispose();
			return;
		}

		try {
			if (isLimitedPath(req)) {
				await handleLimited(req, res, body, context, upstreamTarget);
			} else {
				await handlePassthrough(req, res, body, context, upstreamTarget);
			}
		} finally {
			context.dispose();
		}
	});

	const sockets = new Set();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	function listen() {
		return new Promise((resolve, reject) => {
			const onError = (error) => reject(error);
			server.once("error", onError);
			server.listen(listenPort, listenHost, () => {
				server.off("error", onError);
				const address = server.address();
				if (!address || typeof address === "string") {
					reject(new Error("guard did not bind a TCP address"));
					return;
				}
				log("guard_started", {
					listenHost,
					listenPort: address.port,
					upstreamBase,
					maxActive,
					maxQueue,
					maxRecoveryWaits,
					maxAttempts,
					totalDeadlineMs,
					retryAttemptHeadroomMs,
					maxRecoverySleepMs,
					maxInspectionBytes,
					responseIdleTimeoutMs,
					delayInspectionTimeoutMs,
					allowLegacyPoolBody,
				});
				resolve(address);
			});
		});
	}

	function shutdown(signal, { exitProcess = false } = {}) {
		// This state transition must precede server.close(): already-open sockets
		// may otherwise admit fresh work during the close/drain race.
		draining = true;
		log("guard_shutdown", { signal, openSockets: sockets.size });
		server.close(() => {
			if (exitProcess) process.exit(0);
		});
		server.closeIdleConnections?.();
		const timer = setTimeout(() => {
			log("guard_force_close", {
				signal,
				openSockets: sockets.size,
				shutdownGraceMs,
			});
			server.closeAllConnections?.();
			for (const socket of sockets) socket.destroy();
			if (exitProcess) process.exit(0);
		}, shutdownGraceMs);
		timer.unref();
	}

	return {
		server,
		listen,
		shutdown,
		state: {
			counters,
			get draining() {
				return draining;
			},
			get active() {
				return active;
			},
			get queued() {
				return queue.length;
			},
			get recoveryWaits() {
				return {
					configured: maxRecoveryWaits,
					current: activeRecoveryWaits,
					peak: peakRecoveryWaits,
				};
			},
		},
	};
}

const invokedPath = process.argv[1];
const isMain =
	typeof invokedPath === "string" &&
	import.meta.url === pathToFileURL(invokedPath).href;

if (isMain) {
	const guard = createGuard();
	guard.listen().catch((error) => {
		console.error(error);
		process.exit(1);
	});
	process.on("SIGTERM", () => guard.shutdown("SIGTERM", { exitProcess: true }));
	process.on("SIGINT", () => guard.shutdown("SIGINT", { exitProcess: true }));
}
