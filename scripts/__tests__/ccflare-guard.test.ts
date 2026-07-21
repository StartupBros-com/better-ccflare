import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import http, { type Server } from "node:http";
import net from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { GUARD_REQUEST_ID_HEADER } from "../../packages/proxy/src/handlers/internal-transport-headers";
import { createRequestMetadata } from "../../packages/proxy/src/handlers/request-handler";

import {
	DEFAULT_GUARD_MAX_ATTEMPTS,
	DEFAULT_GUARD_MAX_INSPECTION_BYTES,
	DEFAULT_GUARD_MAX_RECOVERY_SLEEP_MS,
	DEFAULT_GUARD_RETRY_ATTEMPT_HEADROOM_MS,
	DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS,
	DEFAULT_GUARD_RETRY_JITTER_MS,
	DEFAULT_GUARD_SOURCE_ID,
	DEFAULT_GUARD_TOTAL_DEADLINE_MS,
	MAX_GUARD_RECOVERY_SILENCE_MS,
	createGuard,
	planRecoveryAction,
} from "../ccflare-guard.mjs";

const servers: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	await Promise.all(
		children.splice(0).map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode != null || child.signalCode != null) {
						resolve();
						return;
					}
					child.once("exit", () => resolve());
					child.kill("SIGKILL");
				}),
		),
	);
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections?.();
					server.close(() => resolve());
				}),
		),
	);
});

async function allocatePort() {
	const probe = http.createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve());
	});
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("missing address");
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return address.port;
}

async function startProductionNodeGuard(upstreamBase: string) {
	const listenPort = await allocatePort();
	const guardPath = fileURLToPath(
		new URL("../ccflare-guard.mjs", import.meta.url),
	);
	const child = spawn(process.env.GUARD_NODE_BIN || "node", [guardPath], {
		cwd: process.platform === "win32" ? process.env.SystemRoot : undefined,
		env: {
			...process.env,
			CCFLARE_UPSTREAM: upstreamBase,
			GUARD_HOST: "127.0.0.1",
			GUARD_PORT: String(listenPort),
			GUARD_MAX_ACTIVE: "1",
			GUARD_MAX_QUEUE: "10",
			GUARD_MAX_WAIT_MS: "2000",
			GUARD_RETRY_ATTEMPT_HEADROOM_MS: "10",
			GUARD_RETRY_JITTER_MS: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	children.push(child);

	const events: Array<Record<string, unknown>> = [];
	let stderr = "";
	createInterface({ input: child.stdout! }).on("line", (line) => {
		try {
			events.push(JSON.parse(line));
		} catch {
			// Ignore non-JSON runtime noise when matching structured guard events.
		}
	});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	async function waitForEvent(event: string, timeoutMs = 2_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = events.findIndex((entry) => entry.event === event);
			if (index !== -1) return events.splice(index, 1)[0];
			if (child.exitCode != null || child.signalCode != null) {
				throw new Error(
					`guard exited before ${event}: ${stderr || child.exitCode}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`timed out waiting for ${event}: ${stderr}`);
	}

	await waitForEvent("guard_started");
	return {
		baseUrl: `http://127.0.0.1:${listenPort}`,
		child,
		waitForEvent,
	};
}

async function listen(server: Server) {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing address");
	return `http://127.0.0.1:${address.port}`;
}

async function startGuard(
	upstreamBase: string,
	overrides: Record<string, unknown> = {},
) {
	const guard = createGuard({
		listenHost: "127.0.0.1",
		listenPort: 0,
		upstreamBase,
		maxActive: 4,
		maxQueue: 10,
		maxWaitMs: 1_000,
		retryAttemptHeadroomMs: 10,
		jitterMs: 0,
		logger: () => {},
		...overrides,
	});
	servers.push(guard.server);
	const address = await guard.listen();
	return {
		guard,
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function openRawRequest(baseUrl: string, payload: string) {
	const guardUrl = new URL(baseUrl);
	const socket = net.createConnection({
		host: guardUrl.hostname,
		port: Number(guardUrl.port),
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.on("error", () => {});
	socket.write(payload);
	return socket;
}

async function readRawResponse(socket: net.Socket, timeoutMs = 1_000) {
	let response = "";
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timed out reading raw response: ${response}`));
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			response += chunk.toString();
			if (response.includes("guard_deadline_exceeded")) {
				cleanup();
				resolve(response);
			}
		};
		const onClose = () => {
			cleanup();
			resolve(response);
		};
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("close", onClose);
		};
		socket.on("data", onData);
		socket.on("close", onClose);
	});
}

async function readRawResponsesUntil(
	socket: net.Socket,
	marker: string,
	timeoutMs = 2_000,
) {
	let response = "";
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`timed out reading raw responses: ${response}`));
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			response += chunk.toString();
			if (response.includes(marker)) {
				cleanup();
				resolve(response);
			}
		};
		const onClose = () => {
			cleanup();
			resolve(response);
		};
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("close", onClose);
		};
		socket.on("data", onData);
		socket.on("close", onClose);
	});
}

async function waitForHealth(
	baseUrl: string,
	predicate: (health: Record<string, any>) => boolean,
	timeoutMs = 1_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const health = await fetch(`${baseUrl}/_guard/health`).then((response) =>
			response.json(),
		);
		if (predicate(health)) return health;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for guard health condition");
}

describe("source-controlled guard", () => {
	test("enforces the request-wide recovery silence hard maximum at the exact boundary", () => {
		expect(MAX_GUARD_RECOVERY_SILENCE_MS).toBe(120_000);
		expect(() =>
			createGuard({ maxRecoverySleepMs: 120_000, logger: () => {} }),
		).not.toThrow();
		expect(() =>
			createGuard({ maxRecoverySleepMs: 60_000, logger: () => {} }),
		).not.toThrow();
		for (const value of [120_001, 180_000, 0, "invalid"]) {
			expect(() =>
				createGuard({ maxRecoverySleepMs: value, logger: () => {} }),
			).toThrow(/GUARD_MAX_RECOVERY_SLEEP_MS/);
		}
	});

	test("plans recovery against elapsed request silence, not each sleep in isolation", () => {
		expect(
			planRecoveryAction({
				recoveryDelayMs: 100,
				elapsedMs: 0,
				remainingMs: 1_000,
				retryAttemptHeadroomMs: 20,
				recoverySilenceBudgetMs: 120,
				jitterMs: 0,
				random: () => 0,
			}),
		).toMatchObject({ kind: "retry", delayMs: 100 });
		expect(
			planRecoveryAction({
				recoveryDelayMs: 31,
				elapsedMs: 70,
				remainingMs: 930,
				retryAttemptHeadroomMs: 20,
				recoverySilenceBudgetMs: 120,
				jitterMs: 0,
				random: () => 0,
			}),
		).toEqual({
			kind: "forward",
			reason: "recovery_silence_budget_exceeded",
		});
		expect(
			planRecoveryAction({
				recoveryDelayMs: Number.NaN,
				elapsedMs: 0,
				remainingMs: 1_000,
				retryAttemptHeadroomMs: 20,
				recoverySilenceBudgetMs: 120,
				jitterMs: 0,
				random: () => 0,
			}),
		).toEqual({ kind: "forward", reason: "recovery_delay_invalid" });
	});
	test("publishes stable source and policy identities in health", async () => {
		const { baseUrl } = await startGuard("http://127.0.0.1:1", {
			sourceId: "test-source-sha",
			policyId: "test-policy",
		});

		const response = await fetch(`${baseUrl}/_guard/health`);
		const health = await response.json();

		expect(response.status).toBe(200);
		expect(DEFAULT_GUARD_SOURCE_ID).toBe("better-ccflare-source-guard-v1");
		expect(health).toMatchObject({
			status: "ok",
			sourceId: "test-source-sha",
			policyId: "test-policy",
		});
		const guardPath = realpathSync(
			fileURLToPath(new URL("../ccflare-guard.mjs", import.meta.url)),
		);
		const policyPath = realpathSync(
			fileURLToPath(new URL("../ccflare-guard-policy.mjs", import.meta.url)),
		);
		expect(health.runtime).toMatchObject({
			artifacts: {
				guard: {
					path: guardPath,
					sha256: createHash("sha256")
						.update(readFileSync(guardPath))
						.digest("hex"),
				},
				policy: {
					path: policyPath,
					sha256: createHash("sha256")
						.update(readFileSync(policyPath))
						.digest("hex"),
				},
			},
			limits: {
				totalDeadlineMs: 1_000,
				retryAttemptHeadroomMs: 10,
				maxRecoverySleepMs: 120_000,
				shutdownGraceMs: 600_000,
				maxAttempts: 3,
				jitterMs: 0,
				maxInspectionBytes: 64 * 1_024,
			},
		});
		expect(DEFAULT_GUARD_MAX_ATTEMPTS).toBe(3);
		expect(DEFAULT_GUARD_TOTAL_DEADLINE_MS).toBe(600_000);
		expect(DEFAULT_GUARD_RETRY_ATTEMPT_HEADROOM_MS).toBe(30_000);
		expect(DEFAULT_GUARD_MAX_RECOVERY_SLEEP_MS).toBe(120_000);
		expect(DEFAULT_GUARD_RETRY_JITTER_MS).toBe(2_000);
		expect(DEFAULT_GUARD_MAX_INSPECTION_BYTES).toBe(64 * 1_024);
		expect(DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS).toBe(120_000);
	});

	test.each([
		{
			name: "absolute-form",
			target: "http://attacker.invalid/collect?source=absolute",
		},
		{
			name: "scheme-relative",
			target: "//attacker.invalid/collect?source=scheme-relative",
		},
		{
			name: "backslash host override",
			target: "/\\attacker.invalid/collect?source=backslash",
		},
	])("rejects $name request targets before forwarding", async ({ target }) => {
		const forwarded: Array<{ url: string; authorization: string | null }> = [];
		const { baseUrl } = await startGuard("http://127.0.0.1:8789", {
			fetchImpl: async (url: URL, init: RequestInit) => {
				forwarded.push({
					url: String(url),
					authorization: new Headers(init.headers).get("authorization"),
				});
				return new Response("unexpected fetch", { status: 200 });
			},
		});
		const guardUrl = new URL(baseUrl);
		const socket = await openRawRequest(
			baseUrl,
			`GET ${target} HTTP/1.1\r\n` +
				`Host: ${guardUrl.host}\r\n` +
				"Authorization: Bearer must-not-forward\r\n" +
				"Connection: close\r\n\r\n",
		);

		const response = await readRawResponse(socket);

		expect(response).toContain("HTTP/1.1 400");
		expect(response).toContain("guard_invalid_request_target");
		expect(forwarded).toEqual([]);
	});

	test("forwards an origin-form admin path and query to the pinned upstream", async () => {
		const forwarded: Array<{ url: string; authorization: string | null }> = [];
		const { baseUrl } = await startGuard("http://127.0.0.1:8789", {
			fetchImpl: async (url: URL, init: RequestInit) => {
				forwarded.push({
					url: String(url),
					authorization: new Headers(init.headers).get("authorization"),
				});
				return new Response("forwarded", {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			},
		});
		const guardUrl = new URL(baseUrl);
		const socket = await openRawRequest(
			baseUrl,
			"GET /api/accounts?model=opus%2Ffable&lane=primary HTTP/1.1\r\n" +
				`Host: ${guardUrl.host}\r\n` +
				"Authorization: Bearer intended-upstream-only\r\n" +
				"Connection: close\r\n\r\n",
		);

		const response = await readRawResponse(socket);

		expect(response).toContain("HTTP/1.1 200");
		expect(response).toContain("forwarded");
		expect(forwarded).toEqual([
			{
				url: "http://127.0.0.1:8789/api/accounts?model=opus%2Ffable&lane=primary",
				authorization: "Bearer intended-upstream-only",
			},
		]);
	});

	test("overwrites client correlation metadata and joins guard and proxy request IDs", async () => {
		const spoofedId = "11111111-1111-4111-8111-111111111111";
		const events: Array<Record<string, unknown>> = [];
		let forwardedId: string | null = null;
		let proxyRequestId: string | null = null;
		const { baseUrl } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async (url: URL, init: RequestInit) => {
				const headers = new Headers(init.headers);
				forwardedId = headers.get(GUARD_REQUEST_ID_HEADER);
				const request = new Request(url, {
					method: init.method,
					headers,
				});
				proxyRequestId = createRequestMetadata(request, new URL(url)).id;
				return new Response("forwarded", { status: 200 });
			},
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[GUARD_REQUEST_ID_HEADER]: spoofedId,
			},
			body: "{}",
		});
		expect(await response.text()).toBe("forwarded");

		const guardEvent = events.find((event) => event.event === "proxy_response");
		expect(forwardedId).not.toBe(spoofedId);
		expect(forwardedId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(proxyRequestId).toBe(forwardedId);
		expect(guardEvent?.id).toBe(forwardedId);
		expect(response.headers.get(GUARD_REQUEST_ID_HEADER)).toBeNull();
	});

	test("aborts a stalled response body and releases its active lease", async () => {
		let fetchCalls = 0;
		let cancelCalls = 0;
		let stalledController: ReadableStreamDefaultController<Uint8Array> | null =
			null;
		const events: string[] = [];
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			maxActive: 1,
			totalDeadlineMs: 200,
			responseIdleTimeoutMs: 30,
			logger: (line: string) => events.push(JSON.parse(line).event),
			fetchImpl: async () => {
				fetchCalls += 1;
				if (fetchCalls === 1) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stalledController = controller;
								controller.enqueue(Buffer.from("first-prefix"));
							},
							cancel() {
								cancelCalls += 1;
							},
						}),
						{ status: 200 },
					);
				}
				return new Response("second-ok", { status: 200 });
			},
		});
		const firstAbort = new AbortController();
		const firstResponse = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "first",
			signal: firstAbort.signal,
		});
		const firstBody = firstResponse.text().catch((error) => error);

		try {
			await waitFor(() => guard.state.active === 1);
			const secondResponsePromise = fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "second",
			});
			await waitFor(() => guard.state.queued === 1);

			const secondResponse = await secondResponsePromise;
			expect(secondResponse.status).toBe(200);
			expect(await secondResponse.text()).toBe("second-ok");
			await waitFor(() => guard.state.active === 0);
			expect(fetchCalls).toBe(2);
			expect(cancelCalls).toBe(1);
			expect(guard.state.counters.responseBodyIdleTimeouts).toBe(1);
			expect(guard.state.counters.aborted).toBe(0);
			expect(events).toContain("response_body_idle_timeout");
		} finally {
			firstAbort.abort();
			try {
				stalledController?.close();
			} catch {
				// The watchdog may already have cancelled the source.
			}
			await firstBody;
		}
	});

	// P2: a response that begins (status 200 sent) but whose body then stalls
	// past the idle watchdog must not be recorded as a success -- the guard
	// only knows the response actually completed once sendFinalResponse
	// resolves. Recording success before that (as the pre-fix code did)
	// would mislabel a client-visible failure as a success in the guard's
	// own logs and health counters.
	test("does not record outcome success for a 200 whose body delivery fails via the idle watchdog", async () => {
		const events: Array<Record<string, unknown>> = [];
		let cancelCalls = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			totalDeadlineMs: 200,
			responseIdleTimeoutMs: 30,
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(Buffer.from("partial"));
							// Never enqueues again or closes; the idle watchdog must
							// trip instead of the body ever completing.
						},
						cancel() {
							cancelCalls += 1;
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(200);
		const bodyResult = await response.text().catch((error) => error);
		expect(bodyResult).toBeInstanceOf(Error);

		await waitFor(() => guard.state.active === 0);
		expect(cancelCalls).toBe(1);
		expect(guard.state.counters.responseBodyIdleTimeouts).toBe(1);
		expect(guard.state.counters.success).toBe(0);
		expect(
			events.find((event) => event.event === "response_body_idle_timeout"),
		).not.toHaveProperty("semanticEvent");
		expect(
			events.some(
				(event) =>
					event.event === "proxy_response" && event.outcome === "success",
			),
		).toBe(false);
	});

	test("resets the response idle watchdog for each healthy chunk", async () => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const chunks = ["one-", "two-", "three-", "done"];
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			totalDeadlineMs: 45,
			responseIdleTimeoutMs: 35,
			fetchImpl: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							let index = 0;
							const emit = () => {
								controller.enqueue(Buffer.from(chunks[index]));
								index += 1;
								if (index === chunks.length) {
									controller.close();
									return;
								}
								timer = setTimeout(emit, 20);
							};
							emit();
						},
						cancel() {
							if (timer) clearTimeout(timer);
						},
					}),
					{ status: 200 },
				),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(chunks.join(""));
		await waitFor(() => guard.state.active === 0);
		expect(guard.state.counters.responseBodyIdleTimeouts).toBe(0);
		const health = await fetch(`${baseUrl}/_guard/health`).then((result) =>
			result.json(),
		);
		expect(health.responseIdleTimeoutMs).toBe(35);
		expect(health.runtime.limits.responseIdleTimeoutMs).toBe(35);
	});

	test("logs privacy-safe raw chunk telemetry while treating pings as activity, not completion", async () => {
		const events: Array<Record<string, unknown>> = [];
		const chunks = [": ping\n\n", ": ping\n\n", "data: final\n\n"];
		let fetchCalls = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			responseIdleTimeoutMs: 35,
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () => {
				fetchCalls += 1;
				let index = 0;
				return new Response(
					new ReadableStream<Uint8Array>({
						async pull(controller) {
							if (index > 0) {
								await new Promise((resolve) => setTimeout(resolve, 20));
							}
							controller.enqueue(Buffer.from(chunks[index]));
							index += 1;
							if (index === chunks.length) controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			},
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(chunks.join(""));
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		const firstBodyByteMs = completion?.firstBodyByteMs;
		const maxInterChunkGapMs = completion?.maxInterChunkGapMs;
		const lastChunkAgeMs = completion?.lastChunkAgeMs;
		expect(completion).toMatchObject({
			attempt: 1,
			status: 200,
			outcome: "final_error",
			semanticEvent: "incomplete_eof",
			semanticErrorType: "anthropic_incomplete_eof",
			rawResponseChunkCount: chunks.length,
			rawResponseBytes: Buffer.byteLength(chunks.join("")),
			firstBodyByteMs: expect.any(Number),
			maxInterChunkGapMs: expect.any(Number),
			lastChunkAgeMs: expect.any(Number),
		});
		expect(Number(firstBodyByteMs)).toBeGreaterThanOrEqual(0);
		expect(Number(maxInterChunkGapMs)).toBeGreaterThanOrEqual(10);
		expect(Number(lastChunkAgeMs)).toBeGreaterThanOrEqual(0);
		expect(fetchCalls).toBe(1);
		expect(guard.state.counters.success).toBe(0);
		expect(guard.state.counters.finalError).toBe(1);
		expect(guard.state.counters.retried).toBe(0);
		expect(guard.state.counters.responseBodyIdleTimeouts).toBe(0);
	});

	test("classifies a split Anthropic SSE error event as a final error without logging its raw message", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateMessage = "private-upstream-details-must-not-be-logged";
		const chunks = [
			"event: er",
			'ror\r\ndata: {"type":"error","error":{"type":"service_unavailable_error","message":"',
			`${privateMessage}"}}\r\n\r\n`,
		];
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () => {
				let index = 0;
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(Buffer.from(chunks[index]));
							index += 1;
							if (index === chunks.length) controller.close();
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					},
				);
			},
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(chunks.join(""));
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({
			status: 200,
			outcome: "final_error",
			semanticEvent: "error",
			semanticErrorType: "service_unavailable_error",
			rawResponseChunkCount: chunks.length,
			rawResponseBytes: Buffer.byteLength(chunks.join("")),
		});
		expect(JSON.stringify(completion)).not.toContain(privateMessage);
		expect(completion).not.toHaveProperty("semanticErrorMessage");
		expect(guard.state.counters.success).toBe(0);
		expect(guard.state.counters.finalError).toBe(1);
	});

	test("keeps ping and message_stop Anthropic SSE responses successful", async () => {
		const events: Array<Record<string, unknown>> = [];
		const body = [
			": ping",
			"",
			"event: ping",
			'data: {"type":"ping"}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
			"",
			"",
		].join("\n");
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		expect(
			events.find((event) => event.event === "proxy_response"),
		).toMatchObject({ status: 200, outcome: "success" });
		expect(guard.state.counters.success).toBe(1);
		expect(guard.state.counters.finalError).toBe(0);
	});

	test("accepts only the Claude Code message/ping compatibility alias with bounded privacy-safe telemetry", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateAliasValue = "private-compat-ping-value";
		const privateMismatchValue = "private-mismatched-event-value";
		const aliasFrame = `event: message\ndata: {"type":"ping","private":"${privateAliasValue}"}\n\n`;
		const messageStop =
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const bodies = [
			`${aliasFrame.repeat(300)}${messageStop}`,
			`event: message\ndata: {"type":"content_block_delta","private":"${privateMismatchValue}"}\n\n${messageStop}`,
			aliasFrame,
		];
		let fetchIndex = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(bodies[fetchIndex++], {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		for (const expectedBody of bodies) {
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "{}",
			});
			expect(await response.text()).toBe(expectedBody);
		}
		await waitFor(() => guard.state.active === 0);

		const completions = events.filter(
			(event) => event.event === "proxy_response",
		);
		expect(completions).toHaveLength(3);
		expect(completions[0]).toMatchObject({
			status: 200,
			outcome: "success",
			semanticCompatibilityAlias: "message_ping",
			semanticCompatibilityAliasCount: 255,
		});
		expect(completions[0]).not.toHaveProperty("semanticParseState");
		expect(completions[0]).not.toHaveProperty("semanticParseReason");
		expect(completions[1]).toMatchObject({
			status: 200,
			outcome: "success",
			semanticParseState: "malformed",
			semanticParseReason: "event_type_mismatch",
		});
		expect(completions[1]).not.toHaveProperty(
			"semanticCompatibilityAliasCount",
		);
		expect(completions[2]).toMatchObject({
			status: 200,
			outcome: "final_error",
			semanticEvent: "incomplete_eof",
			semanticErrorType: "anthropic_incomplete_eof",
			semanticParseState: "clean",
			semanticCompatibilityAlias: "message_ping",
			semanticCompatibilityAliasCount: 1,
		});
		expect(JSON.stringify(completions)).not.toContain(privateAliasValue);
		expect(JSON.stringify(completions)).not.toContain(privateMismatchValue);
		expect(guard.state.counters.success).toBe(2);
		expect(guard.state.counters.finalError).toBe(1);
	});

	test("reports only fixed privacy-safe malformed SSE reasons", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateValues = [
			"private-invalid-json",
			"private-event-mismatch",
			"private-invalid-message-stop",
			"private-unterminated-event",
		];
		const messageStop =
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const bodies = [
			`event: ping\ndata: {"type":"ping","private":"${privateValues[0]}"\n\n${messageStop}`,
			`event: message\ndata: {"type":"content_block_delta","private":"${privateValues[1]}"}\n\n${messageStop}`,
			`event: message_stop\ndata: {"type":"ping","private":"${privateValues[2]}"}\n\n${messageStop}`,
			`event: ping\ndata: {"type":"ping","private":"${privateValues[3]}"}`,
		];
		let fetchIndex = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(bodies[fetchIndex++], {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		for (const expectedBody of bodies) {
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "{}",
			});
			expect(await response.text()).toBe(expectedBody);
		}
		await waitFor(() => guard.state.active === 0);

		const completions = events.filter(
			(event) => event.event === "proxy_response",
		);
		expect(completions.map((event) => event.semanticParseReason)).toEqual([
			"invalid_json",
			"event_type_mismatch",
			"invalid_message_stop",
			"unterminated_event",
		]);
		for (const completion of completions) {
			expect(completion.semanticParseState).toBe("malformed");
			expect([
				"invalid_json",
				"event_type_mismatch",
				"invalid_message_stop",
				"unterminated_event",
			]).toContain(completion.semanticParseReason);
		}
		for (const privateValue of privateValues) {
			expect(JSON.stringify(completions)).not.toContain(privateValue);
		}
	});

	test("accepts a bare DONE sentinel after message_stop without marking the stream malformed", async () => {
		const events: Array<Record<string, unknown>> = [];
		const body =
			'event: message_stop\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n';
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({ status: 200, outcome: "success" });
		expect(completion).not.toHaveProperty("semanticParseState");
		expect(completion).not.toHaveProperty("semanticEvent");
		expect(guard.state.counters.success).toBe(1);
		expect(guard.state.counters.finalError).toBe(0);
	});

	test("does not treat a bare DONE sentinel as Anthropic completion evidence", async () => {
		const events: Array<Record<string, unknown>> = [];
		const body = "data: [DONE]\n\n";
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({
			status: 200,
			outcome: "final_error",
			semanticEvent: "incomplete_eof",
			semanticErrorType: "anthropic_incomplete_eof",
			semanticParseState: "clean",
		});
		expect(guard.state.counters.success).toBe(0);
		expect(guard.state.counters.finalError).toBe(1);
	});

	test("classifies clean Anthropic Messages EOF without a dispatched message_stop as incomplete", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateTail = "unterminated-private-terminal-tail";
		const bodies = [
			"",
			': ping\n\nevent: ping\ndata: {"type":"ping"}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
			`event: message_stop\ndata: {"type":"message_stop","private":"${privateTail}"}`,
		];
		let fetchIndex = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(bodies[fetchIndex++], {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		for (const expectedBody of bodies) {
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "{}",
			});
			expect(await response.text()).toBe(expectedBody);
		}
		await waitFor(() => guard.state.active === 0);

		const completions = events.filter(
			(event) => event.event === "proxy_response",
		);
		expect(completions).toHaveLength(bodies.length);
		for (const completion of completions) {
			expect(completion).toMatchObject({
				status: 200,
				outcome: "final_error",
				semanticEvent: "incomplete_eof",
				semanticErrorType: "anthropic_incomplete_eof",
			});
		}
		expect(JSON.stringify(completions)).not.toContain(privateTail);
		expect(guard.state.counters.success).toBe(0);
		expect(guard.state.counters.finalError).toBe(bodies.length);
	});

	test("does not require message_stop for the legacy complete SSE path", async () => {
		const events: Array<Record<string, unknown>> = [];
		const body = 'event: ping\ndata: {"type":"ping"}\n\n';
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/complete`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		expect(
			events.find((event) => event.event === "proxy_response"),
		).toMatchObject({ status: 200, outcome: "success" });
		expect(guard.state.counters.success).toBe(1);
	});

	test("recognizes a CRLF message_stop across arbitrary UTF-8 byte splits", async () => {
		const events: Array<Record<string, unknown>> = [];
		const body =
			': ping 🌍\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
		const bytes = new TextEncoder().encode(body);
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () => {
				let offset = 0;
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(bytes.slice(offset, offset + 1));
							offset += 1;
							if (offset === bytes.length) controller.close();
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		expect(
			events.find((event) => event.event === "proxy_response"),
		).toMatchObject({ status: 200, outcome: "success" });
		expect(guard.state.counters.success).toBe(1);
	});

	test("treats a valid oversized SSE event as inconclusive instead of manufacturing incomplete EOF", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateOversizedValue = `private-${"x".repeat(20_000)}`;
		const body =
			"event: content_block_delta\n" +
			`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${privateOversizedValue}"}}\n\n` +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({
			status: 200,
			outcome: "success",
			semanticParseState: "limit_exceeded",
		});
		expect(completion).not.toHaveProperty("semanticEvent");
		expect(completion).not.toHaveProperty("semanticErrorType");
		expect(JSON.stringify(completion)).not.toContain(privateOversizedValue);
		expect(guard.state.counters.success).toBe(1);
		expect(guard.state.counters.finalError).toBe(0);
	});

	test("preserves an observed SSE error if a later event exceeds the observer limit", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateOversizedValue = `private-${"x".repeat(20_000)}`;
		const body =
			'event: error\ndata: {"type":"error","error":{"type":"service_unavailable_error"}}\n\n' +
			"event: content_block_delta\n" +
			`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${privateOversizedValue}"}}\n\n`;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({
			status: 200,
			outcome: "final_error",
			semanticEvent: "error",
			semanticErrorType: "service_unavailable_error",
			semanticParseState: "limit_exceeded",
		});
		expect(JSON.stringify(completion)).not.toContain(privateOversizedValue);
		expect(guard.state.counters.success).toBe(0);
		expect(guard.state.counters.finalError).toBe(1);
	});

	test("maps an unrecognized provider error type to an opaque safe category", async () => {
		const events: Array<Record<string, unknown>> = [];
		const privateType = "customer_secret_123";
		const body = `event: error\ndata: {"type":"error","error":{"type":"${privateType}"}}\n\n`;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe(body);
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({
			status: 200,
			outcome: "final_error",
			semanticEvent: "error",
			semanticErrorType: "unknown_error",
		});
		expect(JSON.stringify(completion)).not.toContain(privateType);
	});

	test("does not treat error-shaped text inside SSE data or a non-SSE body as an error event", async () => {
		const events: Array<Record<string, unknown>> = [];
		let fetchCalls = 0;
		const sseBody = [
			"event: content_block_delta",
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"event: error"}}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
			"",
			"",
		].join("\n");
		const nonSseBody = 'event: error\ndata: {"type":"error"}\n\n';
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () => {
				fetchCalls += 1;
				return fetchCalls === 1
					? new Response(sseBody, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						})
					: new Response(nonSseBody, {
							status: 200,
							headers: { "content-type": "text/plain" },
						});
			},
		});

		for (const expectedBody of [sseBody, nonSseBody]) {
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "{}",
			});
			expect(await response.text()).toBe(expectedBody);
		}
		await waitFor(() => guard.state.active === 0);

		const completions = events.filter(
			(event) => event.event === "proxy_response",
		);
		expect(completions).toHaveLength(2);
		expect(completions.every((event) => event.outcome === "success")).toBe(
			true,
		);
		expect(guard.state.counters.success).toBe(2);
		expect(guard.state.counters.finalError).toBe(0);
	});

	test("logs the last raw chunk age when the response body idle watchdog fires", async () => {
		const events: Array<Record<string, unknown>> = [];
		const partial = "partial-before-stall";
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			responseIdleTimeoutMs: 30,
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(Buffer.from(partial));
						},
					}),
					{ status: 200 },
				),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		await response.text().catch(() => null);
		await waitFor(() => guard.state.active === 0);

		const timeout = events.find(
			(event) => event.event === "response_body_idle_timeout",
		);
		const lastChunkAgeMs = timeout?.lastChunkAgeMs;
		expect(timeout).toMatchObject({
			attempt: 1,
			rawResponseChunkCount: 1,
			rawResponseBytes: Buffer.byteLength(partial),
			firstBodyByteMs: expect.any(Number),
			maxInterChunkGapMs: 0,
			lastChunkAgeMs: expect.any(Number),
		});
		expect(Number(lastChunkAgeMs)).toBeGreaterThanOrEqual(25);
	});

	test("logs raw body telemetry on client abort without replaying the committed response", async () => {
		let fetchCalls = 0;
		const partial = "committed-partial";
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				fetchCalls += 1;
				res.writeHead(200, { "content-type": "text/plain" });
				res.write(partial);
			}),
		);
		const { baseUrl, waitForEvent } =
			await startProductionNodeGuard(upstreamBase);
		const guardUrl = new URL(baseUrl);
		const socket = await openRawRequest(
			baseUrl,
			"POST /v1/messages HTTP/1.1\r\n" +
				`Host: ${guardUrl.host}\r\n` +
				"Content-Length: 2\r\n\r\n" +
				"{}",
		);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for committed response")),
				500,
			);
			const onData = (chunk: Buffer) => {
				if (!chunk.toString().includes(partial)) return;
				clearTimeout(timer);
				socket.off("data", onData);
				resolve();
			};
			socket.on("data", onData);
		});
		socket.destroy();
		const clientAbort = await waitForEvent("client_aborted");
		expect(clientAbort).toMatchObject({
			attempt: 1,
			rawResponseChunkCount: 1,
			rawResponseBytes: Buffer.byteLength(partial),
			firstBodyByteMs: expect.any(Number),
			maxInterChunkGapMs: 0,
			lastChunkAgeMs: expect.any(Number),
		});
		expect(fetchCalls).toBe(1);
	});

	test("logs empty raw body telemetry on an upstream error without replaying", async () => {
		const events: Array<Record<string, unknown>> = [];
		let fetchCalls = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () => {
				fetchCalls += 1;
				throw new Error("test upstream error before headers");
			},
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(502);
		await waitFor(() => guard.state.active === 0);

		const upstreamError = events.find(
			(event) => event.event === "proxy_exception",
		);
		expect(upstreamError).toMatchObject({
			attempt: 1,
			message: "test upstream error before headers",
			rawResponseChunkCount: 0,
			rawResponseBytes: 0,
			firstBodyByteMs: null,
			maxInterChunkGapMs: 0,
			lastChunkAgeMs: null,
		});
		expect(fetchCalls).toBe(1);
		expect(guard.state.counters.retried).toBe(0);
	});

	test("resets raw body telemetry for each authorized retry attempt", async () => {
		const events: Array<Record<string, unknown>> = [];
		let fetchCalls = 0;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			maxAttempts: 2,
			logger: (line: string) => events.push(JSON.parse(line)),
			fetchImpl: async () => {
				fetchCalls += 1;
				if (fetchCalls === 1) {
					return new Response("retry-body-that-must-not-leak", {
						status: 503,
						headers: { "x-better-ccflare-pool-status": "exhausted" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(await response.text()).toBe("ok");
		await waitFor(() => guard.state.active === 0);

		const completion = events.find(
			(event) => event.event === "proxy_response",
		);
		expect(completion).toMatchObject({
			attempt: 2,
			rawResponseChunkCount: 1,
			rawResponseBytes: 2,
		});
		expect(fetchCalls).toBe(2);
		expect(guard.state.counters.retried).toBe(1);
	});

	// P1 spoofing (guard side): the legacy body-only fallback (no header) is
	// opt-in via allowLegacyPoolBody. This test exercises that fallback's
	// oversized/stalled-body bounding, which is otherwise identical to the
	// pre-R17-header-time behavior. A header-confirmed 503 no longer buffers
	// the body at all before authorizing retry (see the retry-focused tests
	// below), so this scenario is only reachable with the header absent.
	test("bounds a stalled partially inspected oversized response body (legacy body-only fallback)", async () => {
		let fetchCalls = 0;
		let cancelCalls = 0;
		let stalledController: ReadableStreamDefaultController<Uint8Array> | null =
			null;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			maxActive: 1,
			maxInspectionBytes: 8,
			totalDeadlineMs: 200,
			responseIdleTimeoutMs: 30,
			allowLegacyPoolBody: true,
			fetchImpl: async () => {
				fetchCalls += 1;
				if (fetchCalls === 1) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stalledController = controller;
								controller.enqueue(Buffer.from("oversized-prefix"));
							},
							cancel() {
								cancelCalls += 1;
							},
						}),
						{
							status: 503,
							headers: {
								"content-type": "application/json",
							},
						},
					);
				}
				return new Response("second-ok", { status: 200 });
			},
		});
		const firstAbort = new AbortController();
		const firstResponse = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "first",
			signal: firstAbort.signal,
		});
		const firstBody = firstResponse.text().catch((error) => error);

		try {
			expect(firstResponse.status).toBe(503);
			await waitFor(() => guard.state.active === 1);
			const secondResponsePromise = fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "second",
			});
			await waitFor(() => guard.state.queued === 1);

			const secondResponse = await secondResponsePromise;
			expect(secondResponse.status).toBe(200);
			expect(await secondResponse.text()).toBe("second-ok");
			await waitFor(() => guard.state.active === 0);
			expect(fetchCalls).toBe(2);
			expect(cancelCalls).toBe(1);
			expect(guard.state.counters.responseBodyIdleTimeouts).toBe(1);
		} finally {
			firstAbort.abort();
			try {
				stalledController?.close();
			} catch {
				// The watchdog may already have cancelled the source.
			}
			await firstBody;
		}
	});

	test("retries only a marked whole-pool response with finite recovery", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.end(
						JSON.stringify({
							type: "error",
							error: {
								type: "pool_exhausted",
								next_available_at: new Date(Date.now() + 100).toISOString(),
							},
						}),
					);
					return;
				}
				res.writeHead(200, { "content-type": "text/plain" });
				res.write("stream-");
				setTimeout(() => res.end("ok"), 5);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase);

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "fixture" }),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("stream-ok");
		expect(attempts).toBe(2);
		expect(guard.state.counters.poolExhausted).toBe(1);
		expect(guard.state.counters.retried).toBe(1);
		expect(guard.state.counters.success).toBe(1);
		expect(guard.state.counters.finalError).toBe(0);
	});

	// P1 spoofing (guard side, default posture): any upstream 503 body can be
	// shaped like pool_exhausted. Without the header, and without the
	// operator explicitly opting into the rolling-upgrade escape hatch, that
	// body-only shape must never authorize a retry -- it is forwarded to the
	// client exactly once, unmodified, never replayed.
	test("forwards a body-only pool_exhausted 503 exactly once when the header is absent and the legacy flag is off by default", async () => {
		let attempts = 0;
		const responseBody = JSON.stringify({
			type: "error",
			error: {
				type: "pool_exhausted",
				next_available_at: new Date(Date.now() + 100).toISOString(),
			},
		});
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, { "content-type": "application/json" });
				res.end(responseBody);
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase);

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(await response.text()).toBe(responseBody);
		expect(attempts).toBe(1);
	});

	test.each([
		{
			name: "generic 503",
			status: 503,
			headers: { "retry-after": "0.01" },
			body: { error: { type: "service_unavailable" } },
		},
		{
			name: "raw 529 overload",
			status: 529,
			headers: { "retry-after": "0.01" },
			body: { error: { type: "overloaded_error" } },
		},
	])("forwards $name exactly once", async ({ status, headers, body }) => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(status, {
					"content-type": "application/json",
					...headers,
				});
				res.end(JSON.stringify(body));
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase);

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual(body);
		expect(attempts).toBe(1);
	});

	// R17: the header alone is authoritative, so a 503 marked exhausted with no
	// concrete recovery signal (no Retry-After, no next_available_at) is still
	// retried rather than forwarded as final. Delay resolution falls back to
	// no wait, and R19's bounded attempt count is what keeps this finite.
	test("retries a header-confirmed pool exhaustion with no recovery signal at no delay until attempts are exhausted", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, {
					"content-type": "application/json",
					"x-better-ccflare-pool-status": "exhausted",
				});
				res.end(JSON.stringify({ error: { type: "pool_exhausted" } }));
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			maxAttempts: 3,
			totalDeadlineMs: 2_000,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: "guard_retry_attempts_exhausted" },
		});
		expect(attempts).toBe(3);
	});

	// R21: the guard's own proxy_response/proxy_final_error log events and
	// counters must label a terminal upstream error unambiguously, unlike the
	// legacy guard's `proxy_success` event, which fired for any status outside
	// a specific retry-candidate list (including 400/402/403/404), so a 402
	// insufficient-balance error could be mistaken for a success in the logs.
	test("logs and counts a terminal client error as outcome final_error, never success", async () => {
		const events: Array<Record<string, unknown>> = [];
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				res.writeHead(402, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { type: "insufficient_balance" } }));
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(402);
		const proxyResponseEvents = events.filter(
			(event) => event.event === "proxy_response",
		);
		expect(proxyResponseEvents).toHaveLength(1);
		expect(proxyResponseEvents[0]).toMatchObject({
			status: 402,
			outcome: "final_error",
		});
		expect(events.some((event) => event.outcome === "success")).toBe(false);
		expect(guard.state.counters.finalError).toBe(1);
		expect(guard.state.counters.success).toBe(0);
	});

	test("logs and counts a 2xx response as outcome success", async () => {
		const events: Array<Record<string, unknown>> = [];
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(200);
		const proxyResponseEvents = events.filter(
			(event) => event.event === "proxy_response",
		);
		expect(proxyResponseEvents).toHaveLength(1);
		expect(proxyResponseEvents[0]).toMatchObject({
			status: 200,
			outcome: "success",
		});
		expect(events.some((event) => event.outcome === "final_error")).toBe(
			false,
		);
		expect(guard.state.counters.success).toBe(1);
		expect(guard.state.counters.finalError).toBe(0);
	});

	// R21: a non-retryable 503 (the header/body do not confirm pool
	// exhaustion) is forwarded exactly once via proxy_final_error, and that
	// path must be labeled final_error too, not just the proxy_response path.
	test("logs and counts a non-retryable 503 as outcome final_error via proxy_final_error", async () => {
		const events: Array<Record<string, unknown>> = [];
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { type: "service_unavailable" } }));
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		const finalErrorEvents = events.filter(
			(event) => event.event === "proxy_final_error",
		);
		expect(finalErrorEvents).toHaveLength(1);
		expect(finalErrorEvents[0]).toMatchObject({
			status: 503,
			outcome: "final_error",
		});
		expect(guard.state.counters.finalError).toBe(1);
		expect(guard.state.counters.success).toBe(0);
	});

	test("retains the active-request queue bound", async () => {
		let active = 0;
		let peakActive = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				active += 1;
				peakActive = Math.max(peakActive, active);
				setTimeout(() => {
					active -= 1;
					res.end("ok");
				}, 20);
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, { maxActive: 1 });

		const responses = await Promise.all([
			fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "one" }),
			fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "two" }),
		]);

		expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
			"ok",
			"ok",
		]);
		expect(peakActive).toBe(1);
	});

	test("releases the attempt slot while a pool retry sleeps", async () => {
		const order: string[] = [];
		let aAttempts = 0;
		const upstreamBase = await listen(
			http.createServer((req, res) => {
				const id = String(req.headers["x-request-id"]);
				if (id === "A") {
					aAttempts += 1;
					order.push(`A${aAttempts}`);
					if (aAttempts === 1) {
						res.writeHead(503, {
							"content-type": "application/json",
							"x-better-ccflare-pool-status": "exhausted",
						});
						res.end(
							JSON.stringify({
								error: {
									type: "pool_exhausted",
									next_available_at: new Date(
										Date.now() + 400,
									).toISOString(),
								},
							}),
						);
						return;
					}
					res.end("A-ok");
					return;
				}
				order.push("B");
				res.end("B-ok");
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			maxActive: 1,
			totalDeadlineMs: 1_000,
			maxAttempts: 3,
		});

		const aResponse = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "A" },
			body: "A",
		});
		await waitFor(() => order.includes("A1"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const bResponse = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "B" },
			body: "B",
			signal: AbortSignal.timeout(250),
		});

		expect(await bResponse.text()).toBe("B-ok");
		expect(await (await aResponse).text()).toBe("A-ok");
		expect(order).toEqual(["A1", "B", "A2"]);
	});

	test("bounds recovery sleepers, exposes cardinality, and releases admission on abort", async () => {
		const attempts = new Map<string, number>();
		const upstreamBase = await listen(
			http.createServer((req, res) => {
				const id = String(req.headers["x-request-id"]);
				const attempt = (attempts.get(id) ?? 0) + 1;
				attempts.set(id, attempt);
				if (attempt === 1) {
					const delayMs = id === "A" ? 500 : 20;
					res.writeHead(503, {
						"content-type": "application/json",
						"x-better-ccflare-pool-status": "exhausted",
						"x-better-ccflare-recovery-scope": "model",
					});
					res.end(
						JSON.stringify({
							error: {
								type: "model_pool_exhausted",
								next_available_at: new Date(
									Date.now() + delayMs,
								).toISOString(),
							},
						}),
					);
					return;
				}
				res.end(`${id}-ok`);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			maxActive: 4,
			maxRecoveryWaits: 1,
			maxRecoverySleepMs: 1_000,
			totalDeadlineMs: 5_000,
			maxAttempts: 2,
		});

		const controller = new AbortController();
		const aResponse = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "A" },
			body: "A",
			signal: controller.signal,
		}).catch((error) => error);
		await waitFor(() => guard.state.recoveryWaits.current === 1);

		const rejected = await Promise.all(
			["B", "C", "D"].map((id) =>
				fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: { "x-request-id": id },
					body: id,
				}),
			),
		);
		expect(rejected.map((response) => response.status)).toEqual([503, 503, 503]);
		expect(guard.state.recoveryWaits).toEqual({
			configured: 1,
			current: 1,
			peak: 1,
		});
		expect(guard.state.counters.recoveryWaitCapacityFull).toBe(3);
		expect(guard.state.counters.recoveryWaitRejectedByScope.model).toBe(3);
		expect(["B", "C", "D"].map((id) => attempts.get(id))).toEqual([1, 1, 1]);

		controller.abort();
		await aResponse;
		await waitFor(() => guard.state.recoveryWaits.current === 0);
		expect(guard.state.counters.recoveryWaitReleased).toBe(1);

		const recovered = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "E" },
			body: "E",
		});
		expect(await recovered.text()).toBe("E-ok");
		expect(guard.state.recoveryWaits.current).toBe(0);
		expect(guard.state.counters.recoveryWaitAdmitted).toBe(2);
		expect(guard.state.counters.recoveryWaitReleased).toBe(2);

		const health = (await (
			await fetch(`${baseUrl}/_guard/health`)
		).json()) as {
			recoveryWaits: { configured: number; current: number; peak: number };
		};
		expect(health.recoveryWaits).toEqual({ configured: 1, current: 0, peak: 1 });
	});

	test("releases a recovery-wait lease when shutdown force-closes the client", async () => {
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				res.writeHead(503, {
					"content-type": "application/json",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "pool",
				});
				res.end(
					JSON.stringify({
						error: {
							type: "pool_exhausted",
							next_available_at: new Date(Date.now() + 500).toISOString(),
						},
					}),
				);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			maxRecoveryWaits: 1,
			maxRecoverySleepMs: 1_000,
			retryAttemptHeadroomMs: 10,
			totalDeadlineMs: 2_000,
			shutdownGraceMs: 20,
		});

		const pending = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		}).catch((error) => error);
		await waitFor(() => guard.state.recoveryWaits.current === 1);
		guard.shutdown("test");
		await pending;
		await waitFor(() => guard.state.recoveryWaits.current === 0);
		expect(guard.state.counters.recoveryWaitReleased).toBe(1);
	});

	test("bounds marked pool retries by the configured attempt count", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, {
					"content-type": "application/json",
					"x-better-ccflare-pool-status": "exhausted",
				});
				res.end(
					JSON.stringify({
						error: {
							type: "pool_exhausted",
							next_available_at: new Date(Date.now() + 30).toISOString(),
						},
					}),
				);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
			maxAttempts: 3,
			retryAttemptHeadroomMs: 50,
			totalDeadlineMs: 2_000,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBeNull();
		expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(await response.json()).toMatchObject({
			error: { type: "guard_retry_attempts_exhausted" },
		});
		expect(attempts).toBe(3);
		expect(
			events.filter((event) => event.event === "proxy_retry_wait"),
		).toHaveLength(2);
		expect(guard.state.counters.poolExhausted).toBe(3);
		expect(guard.state.counters.retried).toBe(2);
		expect(guard.state.counters.attemptsExhausted).toBe(1);
		expect(guard.state.counters.recoveryBeyondDeadline).toBe(0);
	});

	test("the absolute deadline covers a slow inbound request body", async () => {
		const { baseUrl } = await startGuard("http://127.0.0.1:1", {
			totalDeadlineMs: 50,
		});
		const url = new URL(baseUrl);
		const socket = await openRawRequest(
			baseUrl,
			"POST /v1/messages HTTP/1.1\r\n" +
				`Host: ${url.host}\r\n` +
				"Content-Length: 10\r\n" +
				"Content-Type: text/plain\r\n\r\n" +
				"half",
		);

		const response = await readRawResponse(socket);
		expect(response).toContain("504 Gateway Timeout");
		expect(response).toContain("guard_deadline_exceeded");
		expect(response.toLowerCase()).not.toContain("retry-after");
		socket.destroy();
	});

	test("a queued request expires without consuming or leaking an attempt slot", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((req, res) => {
				attempts += 1;
				if (req.headers["x-request-id"] === "A") {
					res.writeHead(200, { "content-type": "text/plain" });
					res.write("A-");
					setTimeout(() => res.end("ok"), 180);
					return;
				}
				res.end("B-should-not-run");
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			maxActive: 1,
			totalDeadlineMs: 60,
		});

		const aResponse = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "A" },
			body: "A",
		});
		await waitFor(() => attempts === 1);
		const bResponse = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "B" },
			body: "B",
		});

		expect(bResponse.status).toBe(504);
		expect(await bResponse.json()).toMatchObject({
			error: { type: "guard_deadline_exceeded" },
		});
		expect(await (await aResponse).text()).toBe("A-ok");
		await waitFor(() => guard.state.active === 0 && guard.state.queued === 0);
		expect(attempts).toBe(1);
	});

	test("a client-aborted queue waiter is removed exactly once", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((req, res) => {
				attempts += 1;
				if (req.headers["x-request-id"] === "A") {
					res.writeHead(200, { "content-type": "text/plain" });
					res.write("A-");
					setTimeout(() => res.end("ok"), 120);
					return;
				}
				res.end("next-ok");
			}),
		);
		const { baseUrl, waitForEvent } =
			await startProductionNodeGuard(upstreamBase);

		const aResponse = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "A" },
			body: "A",
		});
		await waitFor(() => attempts === 1);
		const url = new URL(baseUrl);
		const bSocket = await openRawRequest(
			baseUrl,
			"POST /v1/messages HTTP/1.1\r\n" +
				`Host: ${url.host}\r\n` +
				"Content-Length: 1\r\n" +
				"X-Request-Id: B\r\n\r\n" +
				"B",
		);
		await waitForHealth(baseUrl, (health) => health.queued === 1);
		bSocket.destroy();
		await waitForEvent("client_aborted");
		await waitForHealth(baseUrl, (health) => health.queued === 0);

		expect(await (await aResponse).text()).toBe("A-ok");
		await waitForHealth(baseUrl, (health) => health.active === 0);
		const nextResponse = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-request-id": "C" },
			body: "C",
		});
		expect(await nextResponse.text()).toBe("next-ok");
		const health = await waitForHealth(
			baseUrl,
			(health) => health.active === 0 && health.queued === 0,
		);
		expect(attempts).toBe(2);
		expect(health.counters.aborted).toBe(1);
	});

	test("aborts an upstream fetch that never produces headers at the deadline", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer(() => {
				attempts += 1;
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			totalDeadlineMs: 50,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(504);
		expect(await response.json()).toMatchObject({
			error: { type: "guard_deadline_exceeded" },
		});
		expect(attempts).toBe(1);
		await waitFor(() => guard.state.active === 0);
	});

	test("the deadline also covers bounded candidate-body inspection", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, {
					"content-type": "application/json",
				});
				res.write('{"error":{"type":"pool_exhausted"},"padding":"');
				setTimeout(() => res.end('later"}'), 180);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			allowLegacyPoolBody: true,
			totalDeadlineMs: 50,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(504);
		expect(await response.json()).toMatchObject({
			error: { type: "guard_deadline_exceeded" },
		});
		expect(attempts).toBe(1);
		await waitFor(() => guard.state.active === 0);
	});

	test("immediately preserves an infeasible Retry-After response instead of waiting to the deadline", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const body = JSON.stringify({
			error: { type: "pool_exhausted" },
			padding: "x".repeat(4_096),
		});
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"retry-after": "1",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.write(body.slice(0, 64));
					setTimeout(() => res.end(body.slice(64)), 20);
					return;
				}
				res.end("recovered");
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
			maxAttempts: 3,
			maxInspectionBytes: 1_024,
			retryAttemptHeadroomMs: 100,
			totalDeadlineMs: 300,
		});

		const startedAt = Date.now();
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(await response.text()).toBe(body);
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(attempts).toBe(1);
		expect(
			events.find((event) => event.event === "proxy_final_error"),
		).toMatchObject({
			status: 503,
			outcome: "final_error",
			reason: "recovery_beyond_deadline",
			recoverySource: "retry-after",
		});
		expect(guard.state.counters.poolExhausted).toBe(1);
		expect(guard.state.counters.retried).toBe(0);
		expect(guard.state.counters.deadlineExceeded).toBe(0);
		expect(guard.state.counters.finalError).toBe(1);
	});

	test("forwards a finite model recovery above the request-wide silence ceiling without leaking its permit", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		let heldResponse: http.ServerResponse | null = null;
		const modelBody = JSON.stringify({
			type: "error",
			error: {
				type: "service_unavailable",
				code: "model_pool_exhausted",
				message: "Sonnet capacity is temporarily exhausted",
				next_available_at: new Date(Date.now() + 300_000).toISOString(),
			},
		});
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"retry-after": "300",
						"x-better-ccflare-pool-status": "exhausted",
						"x-better-ccflare-recovery-scope": "model",
					});
					heldResponse = res;
					res.write(modelBody);
					return;
				}
				res.end("next request admitted");
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
			maxActive: 1,
			maxRecoverySleepMs: 120_000,
			retryAttemptHeadroomMs: 30_000,
			totalDeadlineMs: 600_000,
		});

		const startedAt = Date.now();
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
			signal: AbortSignal.timeout(500),
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("300");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(attempts).toBe(1);
		await waitFor(() => guard.state.active === 0);

		// Keep the first response body open while proving that header-time trust
		// released the upstream attempt permit for an unrelated request.
		const next = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
			signal: AbortSignal.timeout(500),
		});
		expect(await next.text()).toBe("next request admitted");
		heldResponse?.end();
		expect(await response.text()).toBe(modelBody);
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(attempts).toBe(2);
		expect(guard.state.active).toBe(0);
		expect(guard.state.queued).toBe(0);
		expect(guard.state.counters.retried).toBe(0);
		expect(guard.state.counters.recoverySleepCapExceeded).toBe(1);
		expect(guard.state.counters.recoveryBeyondDeadline).toBe(0);
		expect(
			events.find((event) => event.event === "proxy_final_error"),
		).toMatchObject({
			status: 503,
			reason: "recovery_silence_budget_exceeded",
			recoverySource: "retry-after",
			recoveryDelayMs: 300_000,
			maxRecoverySleepMs: 120_000,
		});
	});

	test("retries a trusted finite model recovery below the single-sleep cap", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"retry-after": "1",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.end(
						JSON.stringify({
							type: "error",
							error: {
								type: "service_unavailable",
								code: "model_pool_exhausted",
								next_available_at: new Date(
									Date.now() + 1_000,
								).toISOString(),
							},
						}),
					);
					return;
				}
				res.end("recovered");
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
			maxAttempts: 2,
			maxRecoverySleepMs: 1_500,
			retryAttemptHeadroomMs: 300,
			totalDeadlineMs: 2_000,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("recovered");
		expect(attempts).toBe(2);
		expect(guard.state.counters.retried).toBe(1);
		expect(guard.state.counters.recoverySleepCapExceeded).toBe(0);
		expect(guard.state.active).toBe(0);
		expect(
			events.find((event) => event.event === "proxy_retry_wait"),
		).toMatchObject({
			recoverySource: "retry-after",
			delayMs: 1_000,
		});
	});

	test("forwards the current trusted 503 when consecutive recovery hints exceed one request-wide silence budget", async () => {
		let attempts = 0;
		const secondBody = JSON.stringify({
			type: "error",
			error: {
				type: "service_unavailable",
				code: "model_pool_exhausted",
				message: "preserve the second terminal",
			},
		});
		const upstreamBase = await listen(
			http.createServer(async (_req, res) => {
				attempts += 1;
				if (attempts === 2) {
					await new Promise((resolve) => setTimeout(resolve, 150));
				}
				const recoveryBody =
					attempts === 2
						? JSON.stringify({
								...JSON.parse(secondBody),
								error: {
									...JSON.parse(secondBody).error,
									next_available_at: new Date(
										Date.now() + 80,
									).toISOString(),
								},
							})
						: JSON.stringify({
								error: {
									type: "model_pool_exhausted",
									next_available_at: new Date(
										Date.now() + 80,
									).toISOString(),
								},
							});
				res.writeHead(503, {
					"content-type": "application/json",
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "model",
				});
				res.end(recoveryBody);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			maxAttempts: 3,
			maxRecoverySleepMs: 300,
			retryAttemptHeadroomMs: 30,
			totalDeadlineMs: 2_000,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(503);
		const terminal = (await response.json()) as {
			error: { message: string };
		};
		expect(terminal.error.message).toBe("preserve the second terminal");
		expect(attempts).toBe(2);
		expect(guard.state.counters.retried).toBe(1);
		expect(guard.state.counters.recoverySilenceBudgetExceeded).toBe(1);
		expect(guard.state.recoveryWaits.current).toBe(0);
	});

	test("preserves an infeasible original 503 before applying a one-attempt cap", async () => {
		let attempts = 0;
		const body = JSON.stringify({
			error: { type: "pool_exhausted", message: "retry later" },
		});
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, {
					"content-type": "application/json",
					"retry-after": "1",
					"x-better-ccflare-pool-status": "exhausted",
				});
				res.end(body);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			maxAttempts: 1,
			retryAttemptHeadroomMs: 100,
			totalDeadlineMs: 300,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(await response.text()).toBe(body);
		expect(attempts).toBe(1);
		expect(guard.state.counters.recoveryBeyondDeadline).toBe(1);
		expect(guard.state.counters.attemptsExhausted).toBe(0);
		expect(guard.state.counters.retried).toBe(0);
	});

	test.each([
		{ name: "trusted header", headers: true, allowLegacyPoolBody: false },
		{ name: "legacy body", headers: false, allowLegacyPoolBody: true },
	])(
		"preserves a body-only recovery hint above the request-wide silence ceiling on the $name path",
		async ({ headers, allowLegacyPoolBody }) => {
			const events: Array<Record<string, unknown>> = [];
			let attempts = 0;
			const body = JSON.stringify({
				error: {
					type: "pool_exhausted",
					next_available_at: new Date(Date.now() + 1_000).toISOString(),
				},
			});
			const upstreamBase = await listen(
				http.createServer((_req, res) => {
					attempts += 1;
					if (attempts === 1) {
						res.writeHead(503, {
							"content-type": "application/json",
							...(headers
								? { "x-better-ccflare-pool-status": "exhausted" }
								: {}),
						});
						res.end(body);
						return;
					}
					res.end("recovered");
				}),
			);
			const { baseUrl, guard } = await startGuard(upstreamBase, {
				allowLegacyPoolBody,
				logger: (line: string) => events.push(JSON.parse(line)),
				maxAttempts: 3,
				maxRecoverySleepMs: 300,
				retryAttemptHeadroomMs: 100,
				totalDeadlineMs: 2_000,
			});

			const startedAt = Date.now();
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				body: "{}",
			});

			expect(response.status).toBe(503);
			expect(await response.text()).toBe(body);
			expect(Date.now() - startedAt).toBeLessThan(250);
			expect(attempts).toBe(1);
			expect(
				events.find((event) => event.event === "proxy_final_error"),
			).toMatchObject({
				status: 503,
				outcome: "final_error",
				reason: "recovery_silence_budget_exceeded",
				recoverySource: "error.next_available_at",
			});
			expect(guard.state.counters.poolExhausted).toBe(1);
			expect(guard.state.counters.retried).toBe(0);
			expect(guard.state.counters.deadlineExceeded).toBe(0);
			expect(guard.state.counters.recoverySilenceBudgetExceeded).toBe(1);
			expect(guard.state.counters.finalError).toBe(1);
		},
	);

	test("reserves retry headroom and caps only optional jitter for a feasible recovery hint", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.end(
						JSON.stringify({
							error: {
								type: "pool_exhausted",
								next_available_at: new Date(
									Date.now() + 50,
								).toISOString(),
							},
						}),
					);
					return;
				}
				res.end("recovered");
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			jitterMs: 500,
			logger: (line: string) => events.push(JSON.parse(line)),
			maxAttempts: 3,
			random: () => 0.999,
			retryAttemptHeadroomMs: 150,
			totalDeadlineMs: 400,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("recovered");
		expect(attempts).toBe(2);
		const retryWait = events.find(
			(event) => event.event === "proxy_retry_wait",
		);
		expect(retryWait).toMatchObject({
			attempt: 1,
			recoverySource: "error.next_available_at",
		});
		expect(Number(retryWait?.delayMs)).toBeLessThanOrEqual(250);
		expect(guard.state.counters.retried).toBe(1);
		expect(guard.state.counters.deadlineExceeded).toBe(0);
		expect(guard.state.counters.success).toBe(1);
	});

	test("does not let an earlier body hint shorten the authoritative Retry-After minimum", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"retry-after": "1",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.end(
						JSON.stringify({
							error: {
								type: "pool_exhausted",
								next_available_at: new Date(
									Date.now() + 50,
								).toISOString(),
							},
						}),
					);
					return;
				}
				res.end("recovered");
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			logger: (line: string) => events.push(JSON.parse(line)),
			maxAttempts: 2,
			retryAttemptHeadroomMs: 300,
			totalDeadlineMs: 1_500,
		});

		const startedAt = Date.now();
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("recovered");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
		expect(Date.now() - startedAt).toBeLessThan(1_400);
		expect(attempts).toBe(2);
		expect(
			events.find((event) => event.event === "proxy_retry_wait"),
		).toMatchObject({ recoverySource: "retry-after", delayMs: 1_000 });
	});

	test("retains a feasible Retry-After delay when the bounded body peek times out", async () => {
		const events: Array<Record<string, unknown>> = [];
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"retry-after": "1",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.write('{"error":{"type":"pool_exhausted"}');
					return;
				}
				res.end("recovered");
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			delayInspectionTimeoutMs: 30,
			logger: (line: string) => events.push(JSON.parse(line)),
			maxAttempts: 2,
			retryAttemptHeadroomMs: 300,
			totalDeadlineMs: 1_600,
		});

		const startedAt = Date.now();
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		const elapsedMs = Date.now() - startedAt;

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("recovered");
		expect(attempts).toBe(2);
		expect(elapsedMs).toBeGreaterThanOrEqual(900);
		expect(elapsedMs).toBeLessThan(1_500);
		expect(
			events.find((event) => event.event === "proxy_retry_wait"),
		).toMatchObject({
			recoverySource: "retry-after",
			delayMs: 1_000,
		});
	});

	test("reconstructs the exact original 503 stream when a timed-out peek becomes infeasible", async () => {
		let attempts = 0;
		let clockSkewMs = 0;
		const body = "partial-prefix-late-tail";
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, {
					"content-type": "text/plain",
					"retry-after": "1",
					"x-better-ccflare-pool-status": "exhausted",
				});
				res.write("partial-prefix");
				setTimeout(() => {
					clockSkewMs = 400;
				}, 40);
				setTimeout(() => res.end("-late-tail"), 150);
			}),
		);
		const { baseUrl, guard } = await startGuard(upstreamBase, {
			delayInspectionTimeoutMs: 100,
			maxAttempts: 2,
			now: () => Date.now() + clockSkewMs,
			responseIdleTimeoutMs: 500,
			retryAttemptHeadroomMs: 300,
			totalDeadlineMs: 1_600,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(response.headers.get("retry-after")).toBe("1");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
		expect(await response.text()).toBe(body);
		expect(attempts).toBe(1);
		expect(guard.state.counters.recoveryBeyondDeadline).toBe(1);
		expect(guard.state.counters.retried).toBe(0);
		expect(guard.state.counters.deadlineExceeded).toBe(0);
	});

	// P1 ordering: the header alone settles retry authorization at header
	// time, before any body I/O. An oversized body (beyond the inspection
	// cap) must never cost a header-confirmed retry its authorization -- it
	// can only fail to enrich the delay hint. This replaces the prior
	// behavior, where an oversized body caused a header-confirmed 503 to be
	// forwarded as final (losing the retry the header explicitly granted).
	test("retries a header-confirmed 503 despite an oversized body, degrading to no delay hint", async () => {
		let attempts = 0;
		const body = JSON.stringify({
			error: {
				type: "pool_exhausted",
				next_available_at: new Date(Date.now() + 1_000).toISOString(),
			},
			padding: "x".repeat(70 * 1_024),
		});
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				res.writeHead(503, {
					"content-type": "application/json",
					"x-better-ccflare-pool-status": "exhausted",
				});
				for (let offset = 0; offset < body.length; offset += 8 * 1_024) {
					res.write(body.slice(offset, offset + 8 * 1_024));
				}
				res.end();
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			maxInspectionBytes: 64 * 1_024,
			maxAttempts: 2,
			totalDeadlineMs: 2_000,
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: "guard_retry_attempts_exhausted" },
		});
		expect(attempts).toBe(2);
	});

	// P1 ordering: a body that stalls past the bounded delay-inspection
	// timeout must not cost the header-confirmed retry, and must not burn
	// the request's overall deadline either -- only the short inspection
	// timeout is spent before the guard degrades to a zero delay hint and
	// retries.
	test("retries a header-confirmed 503 without waiting out a stalled body", async () => {
		let attempts = 0;
		const upstreamBase = await listen(
			http.createServer((_req, res) => {
				attempts += 1;
				if (attempts === 1) {
					res.writeHead(503, {
						"content-type": "application/json",
						"x-better-ccflare-pool-status": "exhausted",
					});
					res.write('{"error":{"type":"pool_exhausted"}');
					// Never completes within the test's lifetime; the socket is
					// destroyed by afterEach's server cleanup.
					return;
				}
				res.end("second-ok");
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			maxAttempts: 2,
			totalDeadlineMs: 2_000,
			delayInspectionTimeoutMs: 40,
		});

		const startedAt = Date.now();
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});
		const elapsedMs = Date.now() - startedAt;

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("second-ok");
		expect(attempts).toBe(2);
		// Well under the 2s deadline: proves the retry didn't wait for the
		// stalled body or the overall deadline, only the short peek timeout.
		expect(elapsedMs).toBeLessThan(500);
	});

	test("releases its active slot when a production Node client disconnects", async () => {
		const upstreamBase = await listen(
			http.createServer((req, res) => {
				if (req.headers["x-test-success"] === "true") {
					res.end("next-ok");
					return;
				}
				res.writeHead(503, {
					"content-type": "application/json",
					"x-better-ccflare-pool-status": "exhausted",
				});
				res.end(
					JSON.stringify({
						error: {
							type: "pool_exhausted",
							next_available_at: new Date(Date.now() + 1_000).toISOString(),
						},
					}),
				);
			}),
		);
		const { baseUrl, waitForEvent } =
			await startProductionNodeGuard(upstreamBase);

		const guardUrl = new URL(baseUrl);
		const socket = net.createConnection({
			host: guardUrl.hostname,
			port: Number(guardUrl.port),
		});
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.on("error", () => {});
		socket.write(
			"POST /v1/messages HTTP/1.1\r\n" +
				`Host: ${guardUrl.host}\r\n` +
				"Content-Length: 7\r\n" +
				"Content-Type: text/plain\r\n\r\n" +
				"waiting",
		);
		await waitForEvent("proxy_retry_wait");
		socket.destroy();
		await waitForEvent("client_aborted");

		const nextResponse = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "x-test-success": "true" },
			body: "next",
			signal: AbortSignal.timeout(1_000),
		});
		expect(await nextResponse.text()).toBe("next-ok");

		const health = await fetch(`${baseUrl}/_guard/health`).then((response) =>
			response.json(),
		);
		expect(health.active).toBe(0);
		expect(health.queued).toBe(0);
		expect(health.counters.aborted).toBe(1);
	});

	test("rejects a keep-alive request admitted after shutdown without forwarding it", async () => {
		const upstreamBodies: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const upstreamBase = await listen(
			http.createServer(async (req, res) => {
				let body = "";
				for await (const chunk of req) body += chunk.toString();
				upstreamBodies.push(body);
				if (upstreamBodies.length === 1) {
					await firstCanFinish;
					res.end("first-ok");
					return;
				}
				res.end("unexpected-second");
			}),
		);
		const { baseUrl, child, waitForEvent } =
			await startProductionNodeGuard(upstreamBase);
		const guardUrl = new URL(baseUrl);
		const socket = await openRawRequest(
			baseUrl,
			"POST /v1/messages HTTP/1.1\r\n" +
				`Host: ${guardUrl.host}\r\n` +
				"Content-Length: 5\r\n" +
				"Connection: keep-alive\r\n\r\n" +
				"first",
		);
		const rawResponses = readRawResponsesUntil(
			socket,
			'"message":"local guard is draining"',
		);

		await waitFor(() => upstreamBodies.length === 1);
		expect(child.kill("SIGTERM")).toBe(true);
		await waitForEvent("guard_shutdown");
		socket.write(
			"POST /v1/messages HTTP/1.1\r\n" +
				`Host: ${guardUrl.host}\r\n` +
				"Content-Length: 6\r\n" +
				"Connection: keep-alive\r\n\r\n" +
				"second",
		);
		const rejection = await waitForEvent("guard_draining");
		expect(upstreamBodies).toEqual(["first"]);
		expect(rejection).toMatchObject({
			event: "guard_draining",
			id: expect.any(String),
		});
		expect(JSON.stringify(rejection)).not.toContain("second");

		releaseFirst?.();
		const response = await rawResponses;

		expect(upstreamBodies).toEqual(["first"]);
		expect(response.match(/HTTP\/1\.1 /g)).toHaveLength(2);
		expect(response).toContain("HTTP/1.1 200");
		expect(response).toContain("first-ok");
		expect(response).toContain("HTTP/1.1 503");
		expect(response.toLowerCase()).toContain("retry-after: 1");
		expect(response.toLowerCase()).toContain("connection: close");
		expect(response).toContain('"type":"guard_draining"');
	});

	test("allows active and queued requests accepted before shutdown to drain", async () => {
		let attempts = 0;
		let releaseFirst: (() => void) | undefined;
		const firstCanFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const upstreamBase = await listen(
			http.createServer(async (_req, res) => {
				attempts += 1;
				if (attempts === 1) await firstCanFinish;
				res.end(`upstream-${attempts}`);
			}),
		);
		const { guard, baseUrl } = await startGuard(upstreamBase, {
			maxActive: 1,
			shutdownGraceMs: 5_000,
		});

		const activeResponse = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "active",
		});
		await waitFor(() => attempts === 1);
		const queuedResponse = fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "queued",
		});
		await waitFor(() => guard.state.queued === 1);

		guard.shutdown("SIGTERM");
		expect(guard.state.active).toBe(1);
		expect(guard.state.queued).toBe(1);
		releaseFirst?.();

		const [active, queued] = await Promise.all([
			activeResponse,
			queuedResponse,
		]);
		expect(active.status).toBe(200);
		expect(queued.status).toBe(200);
		expect(await active.text()).toBe("upstream-1");
		expect(await queued.text()).toBe("upstream-2");
		expect(attempts).toBe(2);
		await waitFor(() => guard.state.active === 0 && guard.state.queued === 0);
	});

});
