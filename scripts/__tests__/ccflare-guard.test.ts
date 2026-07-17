import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import http, { type Server } from "node:http";
import net from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_GUARD_MAX_ATTEMPTS,
	DEFAULT_GUARD_MAX_INSPECTION_BYTES,
	DEFAULT_GUARD_RESPONSE_IDLE_TIMEOUT_MS,
	DEFAULT_GUARD_RETRY_JITTER_MS,
	DEFAULT_GUARD_SOURCE_ID,
	DEFAULT_GUARD_TOTAL_DEADLINE_MS,
	createGuard,
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
				maxAttempts: 3,
				jitterMs: 0,
				maxInspectionBytes: 64 * 1_024,
			},
		});
		expect(DEFAULT_GUARD_MAX_ATTEMPTS).toBe(3);
		expect(DEFAULT_GUARD_TOTAL_DEADLINE_MS).toBe(120_000);
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

	test("bounds a stalled partially inspected oversized response body", async () => {
		let fetchCalls = 0;
		let cancelCalls = 0;
		let stalledController: ReadableStreamDefaultController<Uint8Array> | null =
			null;
		const { baseUrl, guard } = await startGuard("http://127.0.0.1:8789", {
			maxActive: 1,
			maxInspectionBytes: 8,
			totalDeadlineMs: 200,
			responseIdleTimeoutMs: 30,
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
								"x-better-ccflare-pool-status": "exhausted",
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
		const { baseUrl } = await startGuard(upstreamBase);

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ model: "fixture" }),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("stream-ok");
		expect(attempts).toBe(2);
	});

	test.each([
		{
			name: "generic 503",
			status: 503,
			headers: { "retry-after": "0.01" },
			body: { error: { type: "service_unavailable" } },
		},
		{
			name: "indefinite pool exhaustion",
			status: 503,
			headers: { "x-better-ccflare-pool-status": "exhausted" },
			body: { error: { type: "pool_exhausted" } },
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

	test("bounds marked pool retries by the configured attempt count", async () => {
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
		const { baseUrl } = await startGuard(upstreamBase, {
			maxAttempts: 3,
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
					"x-better-ccflare-pool-status": "exhausted",
				});
				res.write('{"error":{"type":"pool_exhausted"},"padding":"');
				setTimeout(() => res.end('later"}'), 180);
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

	test("does not start another attempt when retry sleep reaches the deadline", async () => {
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
							next_available_at: new Date(Date.now() + 1_000).toISOString(),
						},
					}),
				);
			}),
		);
		const { baseUrl } = await startGuard(upstreamBase, {
			totalDeadlineMs: 60,
			maxAttempts: 3,
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
	});

	test("streams an oversized marked 503 once instead of buffering or retrying it", async () => {
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
		});

		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(503);
		expect(await response.text()).toBe(body);
		expect(attempts).toBe(1);
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

});
