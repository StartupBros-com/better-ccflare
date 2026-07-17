#!/usr/bin/env node
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const listenHost = process.env.GUARD_HOST || "127.0.0.1";
const listenPort = Number(process.env.GUARD_PORT || process.env.PORT || 8788);
const upstreamBase = process.env.CCFLARE_UPSTREAM || "http://127.0.0.1:8789";
const maxActive = Number(process.env.GUARD_MAX_ACTIVE || 4);
const maxQueue = Number(process.env.GUARD_MAX_QUEUE || 500);
const maxWaitMs = Number(process.env.GUARD_MAX_WAIT_MS || 30 * 60 * 1000);
const jitterMs = Number(process.env.GUARD_RETRY_JITTER_MS || 15_000);
// Keep this above better-ccflare's CCFLARE_SHUTDOWN_DRAIN_MS so the guard
// does not sever active client SSE streams while upstream is draining.
const shutdownGraceMs = Number(
	process.env.GUARD_SHUTDOWN_GRACE_MS || 75_000,
);

const counters = {
	startedAt: new Date().toISOString(),
	total: 0,
	queued: 0,
	retried: 0,
	poolExhausted: 0,
	overload529: 0,
	upstream429: 0,
	queueFull: 0,
	aborted: 0,
};

let active = 0;
const queue = [];

function log(event, data = {}) {
	console.log(
		JSON.stringify({
			ts: new Date().toISOString(),
			event,
			active,
			queue: queue.length,
			...data,
		}),
	);
}

function abortError() {
	const err = new Error("client aborted");
	err.name = "AbortError";
	return err;
}

function acquire(id, signal) {
	if (active < maxActive) {
		active += 1;
		return Promise.resolve({ queuedMs: 0 });
	}
	if (queue.length >= maxQueue) {
		counters.queueFull += 1;
		const err = new Error("guard queue full");
		err.code = "GUARD_QUEUE_FULL";
		return Promise.reject(err);
	}
	counters.queued += 1;
	const enqueuedAt = Date.now();
	return new Promise((resolve, reject) => {
		const entry = { id, enqueuedAt, resolve: null };
		const abort = () => {
			const index = queue.indexOf(entry);
			if (index !== -1) queue.splice(index, 1);
			reject(abortError());
		};
		entry.resolve = (slot) => {
			signal?.removeEventListener("abort", abort);
			resolve(slot);
		};
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

function release() {
	active = Math.max(0, active - 1);
	const next = queue.shift();
	if (next) {
		active += 1;
		next.resolve({ queuedMs: Date.now() - next.enqueuedAt });
	}
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		const abort = () => {
			clearTimeout(timer);
			const err = new Error("client aborted");
			err.name = "AbortError";
			reject(err);
		};
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function parseRetryAfter(value) {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return null;
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function retryDecision(status, headers, text) {
	const body = parseJson(text);
	const retryAfter = parseRetryAfter(headers.get("retry-after"));

	// Deliberate policy rejections from our own upstream (session governor)
	// are not transient capacity: hand them to the client immediately so it
	// can back off itself, instead of retry-holding the connection for the
	// full budget window.
	if (headers.get("x-better-ccflare-governor")) {
		counters.governorRejected = (counters.governorRejected || 0) + 1;
		return { retry: false, reason: "governor_rejected" };
	}

	if (status === 503 && body?.error?.type === "pool_exhausted") {
		counters.poolExhausted += 1;
		const candidates = [];
		if (retryAfter != null) candidates.push(retryAfter);
		if (body.error.next_available_at)
			candidates.push(
				Math.max(0, Date.parse(body.error.next_available_at) - Date.now()),
			);
		for (const account of body.error.accounts || []) {
			if (account.available_at)
				candidates.push(
					Math.max(0, Date.parse(account.available_at) - Date.now()),
				);
		}
		const finite = candidates.filter(Number.isFinite);
		return {
			retry: true,
			reason: "pool_exhausted",
			delayMs: finite.length ? Math.min(...finite) : 15_000,
		};
	}

	if (status === 529 || /overloaded_error|overloaded/i.test(text)) {
		counters.overload529 += 1;
		return {
			retry: true,
			reason: "upstream_529",
			delayMs: retryAfter ?? 30_000,
		};
	}

	if (status === 429) {
		counters.upstream429 += 1;
		return {
			retry: true,
			reason: "upstream_429",
			delayMs: retryAfter ?? 60_000,
		};
	}

	if ([500, 502, 503, 504].includes(status)) {
		return {
			retry: true,
			reason: `upstream_${status}`,
			delayMs: retryAfter ?? 15_000,
		};
	}

	return { retry: false, reason: null, delayMs: 0 };
}

function requestHeaders(req, bodyLength) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		const lower = key.toLowerCase();
		if (
			[
				"connection",
				"keep-alive",
				"proxy-authenticate",
				"proxy-authorization",
				"te",
				"trailer",
				"transfer-encoding",
				"upgrade",
				"host",
				"content-length",
			].includes(lower)
		)
			continue;
		if (Array.isArray(value)) headers.set(key, value.join(", "));
		else if (value != null) headers.set(key, String(value));
	}
	if (bodyLength > 0) headers.set("content-length", String(bodyLength));
	return headers;
}

function responseHeaders(fetchHeaders, bodyLength = null) {
	const out = {};
	fetchHeaders.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (
			[
				"connection",
				"keep-alive",
				"proxy-authenticate",
				"proxy-authorization",
				"te",
				"trailer",
				"transfer-encoding",
				"upgrade",
			].includes(lower)
		)
			return;
		if (bodyLength != null && lower === "content-length") return;
		out[key] = value;
	});
	if (bodyLength != null) out["content-length"] = String(bodyLength);
	return out;
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function isLimitedPath(req) {
	const url = req.url || "";
	return (
		(url.startsWith("/v1/messages") &&
			!url.startsWith("/v1/messages/count_tokens")) ||
		url.startsWith("/v1/complete")
	);
}

async function fetchUpstream(req, body, signal) {
	const url = new URL(req.url || "/", upstreamBase);
	const init = {
		method: req.method,
		headers: requestHeaders(req, body.length),
		redirect: "manual",
		signal,
	};
	if (!["GET", "HEAD"].includes(req.method || "GET")) init.body = body;
	return fetch(url, init);
}

async function sendFinalResponse(res, upstreamRes) {
	res.writeHead(upstreamRes.status, responseHeaders(upstreamRes.headers));
	if (!upstreamRes.body) {
		res.end();
		return;
	}
	await pipeline(Readable.fromWeb(upstreamRes.body), res);
}

async function sendBufferedResponse(res, upstreamRes, buffer) {
	res.writeHead(
		upstreamRes.status,
		responseHeaders(upstreamRes.headers, buffer.length),
	);
	res.end(buffer);
}

async function handleLimited(req, res, body, signal) {
	const id = randomUUID();
	counters.total += 1;
	const started = Date.now();
	let slot;
	try {
		slot = await acquire(id, signal);
	} catch (err) {
		if (err.name === "AbortError" || signal.aborted) {
			counters.aborted += 1;
			log("client_aborted", { id, attempt: 0, elapsedMs: Date.now() - started });
			return;
		}
		res.writeHead(503, {
			"content-type": "application/json",
			"retry-after": "30",
		});
		res.end(
			JSON.stringify({
				type: "error",
				error: {
					type: "guard_queue_full",
					message: "local guard queue is full",
				},
			}),
		);
		return;
	}

	let attempt = 0;
	try {
		while (true) {
			attempt += 1;
			const upstreamRes = await fetchUpstream(req, body, signal);
			const shouldStreamImmediately =
				upstreamRes.ok ||
				![429, 500, 502, 503, 504, 529].includes(upstreamRes.status);
			if (shouldStreamImmediately) {
				log("proxy_success", {
					id,
					attempt,
					status: upstreamRes.status,
					queuedMs: slot.queuedMs,
					elapsedMs: Date.now() - started,
				});
				await sendFinalResponse(res, upstreamRes);
				return;
			}

			const arrayBuffer = await upstreamRes.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			const text = buffer.toString("utf8");
			const decision = retryDecision(
				upstreamRes.status,
				upstreamRes.headers,
				text,
			);
			const elapsed = Date.now() - started;
			if (!decision.retry || elapsed >= maxWaitMs) {
				log("proxy_final_error", {
					id,
					attempt,
					status: upstreamRes.status,
					reason: decision.reason,
					elapsedMs: elapsed,
				});
				await sendBufferedResponse(res, upstreamRes, buffer);
				return;
			}

			counters.retried += 1;
			const jitter = Math.floor(Math.random() * jitterMs);
			const delayMs = Math.min(
				decision.delayMs + jitter,
				Math.max(0, maxWaitMs - elapsed),
			);
			log("proxy_retry_wait", {
				id,
				attempt,
				status: upstreamRes.status,
				reason: decision.reason,
				delayMs,
				elapsedMs: elapsed,
			});
			await sleep(delayMs, signal);
		}
	} catch (err) {
		if (err.name === "AbortError" || signal.aborted) {
			counters.aborted += 1;
			log("client_aborted", { id, attempt, elapsedMs: Date.now() - started });
			return;
		}
		log("proxy_exception", { id, attempt, message: err.message });
		if (res.headersSent) {
			res.destroy(err);
		} else {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					type: "error",
					error: { type: "guard_upstream_error", message: err.message },
				}),
			);
		}
	} finally {
		release();
	}
}

async function handlePassthrough(req, res, body, signal) {
	try {
		const upstreamRes = await fetchUpstream(req, body, signal);
		await sendFinalResponse(res, upstreamRes);
	} catch (err) {
		if (res.headersSent) {
			res.destroy(err);
		} else {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					type: "error",
					error: { type: "guard_upstream_error", message: err.message },
				}),
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
				listenHost,
				listenPort,
				upstreamBase,
				maxActive,
				active,
				queued: queue.length,
				counters,
			}),
		);
		return;
	}

	const controller = new AbortController();
	req.on("aborted", () => controller.abort());
	res.on("close", () => {
		if (res.writableEnded) return;
		controller.abort();
	});

	let body;
	try {
		body = await readBody(req);
	} catch (err) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				type: "error",
				error: { type: "guard_bad_request", message: err.message },
			}),
		);
		return;
	}

	if (isLimitedPath(req))
		await handleLimited(req, res, body, controller.signal);
	else await handlePassthrough(req, res, body, controller.signal);
});

const sockets = new Set();
server.on("connection", (socket) => {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
});

server.listen(listenPort, listenHost, () => {
	log("guard_started", {
		listenHost,
		listenPort,
		upstreamBase,
		maxActive,
		maxQueue,
		maxWaitMs,
	});
});

function shutdown(signal) {
	log("guard_shutdown", { signal, openSockets: sockets.size });
	server.close(() => process.exit(0));
	server.closeIdleConnections?.();
	setTimeout(() => {
		log("guard_force_close", {
			signal,
			openSockets: sockets.size,
			shutdownGraceMs,
		});
		server.closeAllConnections?.();
		for (const socket of sockets) socket.destroy();
		process.exit(0);
	}, shutdownGraceMs).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
