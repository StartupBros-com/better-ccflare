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
} from "./ccflare-guard-policy.mjs";

export const DEFAULT_GUARD_SOURCE_ID = "better-ccflare-source-guard-v1";
export const DEFAULT_GUARD_MAX_ATTEMPTS = 3;
export const DEFAULT_GUARD_TOTAL_DEADLINE_MS = 120_000;
export const DEFAULT_GUARD_RETRY_JITTER_MS = 2_000;
export const DEFAULT_GUARD_MAX_INSPECTION_BYTES = 64 * 1_024;
export const DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS = 120_000;

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

function requestHeaders(req, bodyLength) {
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

function responseBodyIdleTimeoutError() {
	const error = new Error("upstream response body idle timeout");
	error.code = "GUARD_RESPONSE_IDLE_TIMEOUT";
	return error;
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

async function readResponseForInspection(response, maxBytes, signal) {
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
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason || abortError();
			const { done, value } = await reader.read();
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
		throw error;
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
		try {
			for (const chunk of inspection.prefix) yield chunk;
			yield inspection.overflow;
			while (true) {
				const { done, value } = await inspection.reader.read();
				if (done) return;
				yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			}
		} finally {
			inspection.reader.releaseLock();
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
	const shutdownGraceMs = configuredNumber(
		options.shutdownGraceMs ?? env.GUARD_SHUTDOWN_GRACE_MS,
		75_000,
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
		attemptsExhausted: 0,
		oversizedInspectionBodies: 0,
		responseBodyIdleTimeouts: 0,
	};
	let active = 0;
	const queue = [];

	function log(event, data = {}) {
		logger(
			JSON.stringify({
				ts: new Date(now()).toISOString(),
				event,
				active,
				queue: queue.length,
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

	async function fetchUpstream(req, body, signal, upstreamTarget) {
		const init = {
			method: req.method,
			headers: requestHeaders(req, body.length),
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

	function handleAbort(error, res, context, attempt) {
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
			});
			return true;
		}
		return false;
	}

	function handleResponseBodyIdleTimeout(error, res, context, attempt) {
		if (error?.code !== "GUARD_RESPONSE_IDLE_TIMEOUT") return false;
		counters.responseBodyIdleTimeouts += 1;
		log("response_body_idle_timeout", {
			id: context.id,
			attempt,
			elapsedMs: now() - context.acceptedAt,
			responseIdleTimeoutMs,
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

	async function handleLimited(req, res, body, context, upstreamTarget) {
		const { id } = context;
		counters.total += 1;
		let attempt = 0;
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
					upstreamResponse = await fetchUpstream(
						req,
						body,
						context.signal,
						upstreamTarget,
					);
				} catch (error) {
					lease.release();
					throw error;
				}

				// Only a 503 can satisfy the narrow whole-pool policy. Every other
				// status, including raw 402/429/529 and generic 5xx, is streamed
				// through without buffering or a second upstream request.
				if (upstreamResponse.status !== 503) {
					recordForwardedStatus(upstreamResponse.status);
					log("proxy_response", {
						id,
						attempt,
						status: upstreamResponse.status,
						queuedMs: lease.queuedMs,
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
					log("proxy_final_error", {
						id,
						attempt,
						status: upstreamResponse.status,
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
				});
				const elapsedMs = now() - context.acceptedAt;
				if (!decision.retry) {
					log("proxy_final_error", {
						id,
						attempt,
						status: upstreamResponse.status,
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
				if (attempt >= maxAttempts) {
					sendAttemptsExhausted(res, context, attempt);
					return;
				}
				context.ensureBudget();
				counters.retried += 1;
				const jitter = Math.floor(random() * jitterMs);
				const delayMs = Math.min(
					decision.delayMs + jitter,
					context.remainingMs(),
				);
				log("proxy_retry_wait", {
					id,
					attempt,
					status: upstreamResponse.status,
					reason: decision.reason,
					recoverySource: decision.recoverySource,
					delayMs,
					elapsedMs,
				});
				await sleep(delayMs, context.signal);
			}
		} catch (error) {
			if (handleResponseBodyIdleTimeout(error, res, context, attempt)) return;
			if (handleAbort(error, res, context, attempt)) return;
			log("proxy_exception", { id, attempt, message: error.message });
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
		try {
			context.ensureBudget();
			const upstreamResponse = await fetchUpstream(
				req,
				body,
				context.signal,
				upstreamTarget,
			);
			await sendFinalResponse(
				res,
				upstreamResponse,
				context.beginResponse,
				responseIdleTimeoutMs,
			);
		} catch (error) {
			if (handleResponseBodyIdleTimeout(error, res, context, 1)) return;
			if (handleAbort(error, res, context, 1)) return;
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
					maxAttempts,
					totalDeadlineMs,
					jitterMs,
					maxInspectionBytes,
					responseIdleTimeoutMs,
					runtime: {
						...runtimeIdentity,
						limits: {
							totalDeadlineMs,
							maxAttempts,
							jitterMs,
							maxInspectionBytes,
							responseIdleTimeoutMs,
							maxActive,
							maxQueue,
						},
					},
					active,
					queued: queue.length,
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
			if (!handleAbort(error, res, context, 0)) {
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
					maxAttempts,
					totalDeadlineMs,
					maxInspectionBytes,
					responseIdleTimeoutMs,
				});
				resolve(address);
			});
		});
	}

	function shutdown(signal, { exitProcess = false } = {}) {
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
			get active() {
				return active;
			},
			get queued() {
				return queue.length;
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
