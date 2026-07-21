import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	CODEX_RESPONSES_WEBSOCKET_URL,
	CODEX_WS_ACCOUNT_IDS_ENV,
	CODEX_WS_IDLE_TTL_MS_ENV,
	CODEX_WS_MAX_AGE_MS_ENV,
	CODEX_WS_MAX_GLOBAL_ENV,
	CODEX_WS_MAX_PER_ACCOUNT_ENV,
	CODEX_WS_MODELS_ENV,
	CODEX_WS_PERCENT_ENV,
	CODEX_WS_TELEMETRY_WARN_ENV,
	type CodexWebSocketLike,
	type CodexWebSocketObservation,
	type CodexWebSocketOptions,
	CodexWebSocketTransport,
	isCodexWebSocketAssigned,
	readCodexWebSocketTelemetryWarn,
} from "../codex-websocket-transport";

const ENV_NAMES = [
	CODEX_WS_PERCENT_ENV,
	CODEX_WS_ACCOUNT_IDS_ENV,
	CODEX_WS_MODELS_ENV,
	CODEX_WS_MAX_GLOBAL_ENV,
	CODEX_WS_MAX_PER_ACCOUNT_ENV,
	CODEX_WS_IDLE_TTL_MS_ENV,
	CODEX_WS_MAX_AGE_MS_ENV,
	CODEX_WS_TELEMETRY_WARN_ENV,
	"CCFLARE_CODEX_WS_HANDSHAKE_TIMEOUT_MS",
	"CCFLARE_CODEX_WS_FIRST_EVENT_TIMEOUT_MS",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const name of ENV_NAMES) {
		originalEnv.set(name, process.env[name]);
		delete process.env[name];
	}
});

afterEach(() => {
	for (const name of ENV_NAMES) {
		const value = originalEnv.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	originalEnv.clear();
});

function closeEvent(code = 1006, reason = "closed"): Event {
	const event = new Event("close");
	Object.defineProperties(event, {
		code: { value: code },
		reason: { value: reason },
	});
	return event;
}

class FakeWebSocket extends EventTarget implements CodexWebSocketLike {
	readyState = 0;
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	onSend?: (socket: FakeWebSocket, data: string) => void;

	open(): void {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}

	emitJson(value: unknown): void {
		this.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify(value) }),
		);
	}

	emitRaw(value: string): void {
		this.dispatchEvent(new MessageEvent("message", { data: value }));
	}

	emitError(): void {
		this.dispatchEvent(new Event("error"));
	}

	emitClose(code = 1006, reason = "closed"): void {
		this.readyState = 3;
		this.dispatchEvent(closeEvent(code, reason));
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.sent.push(data);
		this.onSend?.(this, data);
	}

	close(code?: number, reason?: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3;
	}
}

interface Harness {
	transport: CodexWebSocketTransport;
	sockets: FakeWebSocket[];
	connections: Array<{ url: string; options: CodexWebSocketOptions }>;
	observations: CodexWebSocketObservation[];
}

function harness(
	opts: {
		now?: () => number;
		configureSocket?: (socket: FakeWebSocket, index: number) => void;
		autoOpen?: boolean;
	} = {},
): Harness {
	const sockets: FakeWebSocket[] = [];
	const connections: Array<{ url: string; options: CodexWebSocketOptions }> =
		[];
	const observations: CodexWebSocketObservation[] = [];
	const transport = new CodexWebSocketTransport({
		now: opts.now,
		observe: (observation) => observations.push(observation),
		applyCloudflareCookies: (_url, headers) =>
			headers.set("cookie", "__cf_bm=current-cloudflare-cookie"),
		createWebSocket: (url, options) => {
			const socket = new FakeWebSocket();
			const index = sockets.length;
			sockets.push(socket);
			connections.push({ url, options });
			opts.configureSocket?.(socket, index);
			if (opts.autoOpen !== false) queueMicrotask(() => socket.open());
			return socket;
		},
	});
	return { transport, sockets, connections, observations };
}

function enableCanary(overrides: Record<string, string> = {}): void {
	process.env[CODEX_WS_PERCENT_ENV] = "100";
	process.env[CODEX_WS_ACCOUNT_IDS_ENV] = "acct-pro";
	process.env[CODEX_WS_MODELS_ENV] = "gpt-5.6-sol";
	for (const [key, value] of Object.entries(overrides))
		process.env[key] = value;
}

function request(
	opts: {
		cacheKey?: string;
		model?: string;
		auth?: string;
		bodyMarker?: string;
		url?: string;
		stream?: boolean;
	} = {},
): Request {
	return new Request(
		opts.url ?? "https://chatgpt.com/backend-api/codex/responses",
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${opts.auth ?? "secret-access-token"}`,
				connection: "keep-alive",
				"content-length": "999",
				"content-type": "application/json",
				cookie: "session=must-not-leak",
				"openai-beta": "responses=experimental",
				originator: "codex_cli_rs",
				"user-agent": "codex-cli/test",
				version: "0.144.4",
				"x-codex-turn-state": "must-not-leak-turn-state",
			},
			body: JSON.stringify({
				type: "must-not-override-response-create",
				model: opts.model ?? "gpt-5.6-sol",
				input: [
					{
						role: "user",
						content: [
							{
								type: "input_text",
								text: opts.bodyMarker ?? "private prompt body",
							},
						],
					},
				],
				prompt_cache_key: opts.cacheKey ?? "private-cache-key",
				previous_response_id: "must-not-be-forwarded",
				store: false,
				stream: opts.stream ?? true,
			}),
		},
	);
}

function attempt(
	transport: CodexWebSocketTransport,
	req = request(),
	opts: {
		accountId?: string;
		providerName?: string;
		signal?: AbortSignal;
		requestId?: string;
		attemptId?: string;
	} = {},
) {
	return transport.tryRequest({
		accountId: opts.accountId ?? "acct-pro",
		providerName: opts.providerName ?? "codex",
		request: req,
		signal: opts.signal ?? new AbortController().signal,
		requestId: opts.requestId ?? "request-default",
		attemptId: opts.attemptId ?? "attempt-default",
	});
}

describe("CodexWebSocketTransport eligibility", () => {
	test("is default-off, requires both allowlists, and assigns deterministic cohorts", async () => {
		const h = harness();
		expect(await attempt(h.transport)).toBeNull();
		expect(h.sockets).toHaveLength(0);
		expect(h.transport.getStats().poolSize).toBe(0);

		process.env[CODEX_WS_PERCENT_ENV] = "100";
		process.env[CODEX_WS_ACCOUNT_IDS_ENV] = "acct-pro";
		expect(await attempt(h.transport)).toBeNull();
		process.env[CODEX_WS_MODELS_ENV] = "gpt-5.6-sol";
		expect(
			await attempt(h.transport, request(), { accountId: "other" }),
		).toBeNull();
		expect(
			await attempt(h.transport, request({ model: "gpt-5.6-terra" })),
		).toBeNull();

		const assignments = new Set<boolean>();
		for (let index = 0; index < 500; index++) {
			const key = `conversation-${index}`;
			const first = isCodexWebSocketAssigned("acct-pro", key, 50);
			expect(isCodexWebSocketAssigned("acct-pro", key, 50)).toBe(first);
			assignments.add(first);
		}
		expect(assignments).toEqual(new Set([false, true]));
	});

	test("only escalates canary telemetry for explicit boolean opt-in values", () => {
		expect(readCodexWebSocketTelemetryWarn()).toBe(false);
		for (const enabled of ["1", "true", "TRUE"]) {
			process.env[CODEX_WS_TELEMETRY_WARN_ENV] = enabled;
			expect(readCodexWebSocketTelemetryWarn()).toBe(true);
		}
		for (const disabled of ["0", "false", "yes", " 1", "1 ", "garbage"]) {
			process.env[CODEX_WS_TELEMETRY_WARN_ENV] = disabled;
			expect(readCodexWebSocketTelemetryWarn()).toBe(false);
		}
	});

	test("percent zero retires idle sockets and creates no new pool state", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({ type: "response.created", response: { id: "r1" } });
						ws.emitJson({ type: "response.completed", response: { id: "r1" } });
					});
			},
		});
		const first = await attempt(h.transport);
		expect(first).not.toBeNull();
		await first?.response.text();
		expect(h.transport.getStats().poolSize).toBe(1);

		process.env[CODEX_WS_PERCENT_ENV] = "0";
		expect(await attempt(h.transport)).toBeNull();
		expect(h.sockets[0].closes).toHaveLength(1);
		expect(h.transport.getStats().poolSize).toBe(0);
	});

	test("retire sockets removed from the account or model allowlist", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({ type: "response.created", response: { id: "r1" } });
						ws.emitJson({ type: "response.completed", response: { id: "r1" } });
					});
			},
		});
		const first = await attempt(h.transport);
		await first?.response.text();
		expect(h.transport.getStats().poolSize).toBe(1);

		process.env[CODEX_WS_ACCOUNT_IDS_ENV] = "some-other-account";
		expect(await attempt(h.transport)).toBeNull();
		expect(h.sockets[0].closes).toHaveLength(1);
		expect(h.transport.getStats().poolSize).toBe(0);
	});

	test("emits joinable control observations with normalized outcomes", async () => {
		enableCanary({ [CODEX_WS_PERCENT_ENV]: "50" });
		const h = harness();
		let cacheKey = "";
		for (let index = 0; index < 1_000; index++) {
			const candidate = `control-${index}`;
			if (!isCodexWebSocketAssigned("acct-pro", candidate, 50)) {
				cacheKey = candidate;
				break;
			}
		}
		expect(cacheKey).not.toBe("");
		expect(
			await attempt(h.transport, request({ cacheKey }), {
				requestId: "request-control",
				attemptId: "attempt-control",
			}),
		).toBeNull();
		expect(h.observations).toEqual([
			expect.objectContaining({
				requestId: "request-control",
				attemptId: "attempt-control",
				assignment: "control",
				effectiveTransport: "http",
				fallbackReason: "cohort_control",
			}),
		]);
	});
});

describe("CodexWebSocketTransport wire contract", () => {
	test("sends the full Responses request once with exact safe handshake headers", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({ type: "response.created", response: { id: "r1" } });
						ws.emitJson({
							type: "response.output_text.delta",
							delta: "hello",
						});
						ws.emitJson({ type: "response.completed", response: { id: "r1" } });
					});
			},
		});
		const result = await attempt(h.transport);
		expect(result).not.toBeNull();
		const stream = await result?.response.text();

		expect(h.connections[0].url).toBe(CODEX_RESPONSES_WEBSOCKET_URL);
		const headers = new Headers(h.connections[0].options.headers);
		expect(headers.get("authorization")).toBe("Bearer secret-access-token");
		expect(headers.get("openai-beta")).toBe("responses_websockets=2026-02-06");
		expect(headers.get("version")).toBe("0.144.4");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("cookie")).toBe("__cf_bm=current-cloudflare-cookie");
		for (const name of [
			"connection",
			"content-length",
			"content-type",
			"x-codex-turn-state",
		]) {
			expect(headers.has(name)).toBe(false);
		}

		expect(h.sockets[0].sent).toHaveLength(1);
		const frame = JSON.parse(h.sockets[0].sent[0]);
		expect(frame.type).toBe("response.create");
		expect(frame.model).toBe("gpt-5.6-sol");
		expect(frame.stream).toBe(true);
		expect(frame.prompt_cache_key).toBe("private-cache-key");
		expect(frame.input[0].content[0].text).toBe("private prompt body");
		expect(frame).not.toHaveProperty("previous_response_id");
		expect(stream).toContain("event: response.created");
		expect(stream).toContain("event: response.output_text.delta");
		expect(stream).toContain("event: response.completed");
		expect(stream?.indexOf("response.created")).toBeLessThan(
			stream?.indexOf("response.completed") ?? -1,
		);
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-default",
				attemptId: "attempt-default",
				assignment: "treatment",
				effectiveTransport: "websocket",
				handshakeMs: expect.any(Number),
				frameWritten: true,
				fallbackReason: null,
			}),
		);
	});

	test("rejects non-exact subscription URLs, non-streaming, and non-POST requests", async () => {
		enableCanary();
		const h = harness();
		expect(
			await attempt(
				h.transport,
				request({ url: "https://api.openai.com/v1/responses" }),
			),
		).toBeNull();
		expect(
			await attempt(
				h.transport,
				request({
					url: "https://chatgpt.com/backend-api/codex/responses?transport=ws",
				}),
			),
		).toBeNull();
		expect(
			await attempt(
				h.transport,
				request({ url: "https://chatgpt.com/backend-api/codex/responses/" }),
			),
		).toBeNull();
		expect(await attempt(h.transport, request({ stream: false }))).toBeNull();
		const get = new Request("https://chatgpt.com/backend-api/codex/responses", {
			method: "GET",
		});
		expect(await attempt(h.transport, get)).toBeNull();
		expect(h.sockets).toHaveLength(0);
	});
});

describe("CodexWebSocketTransport replay boundary", () => {
	test("reserves per-account and global capacity before concurrent handshakes", async () => {
		enableCanary({
			[CODEX_WS_MAX_GLOBAL_ENV]: "4",
			[CODEX_WS_MAX_PER_ACCOUNT_ENV]: "1",
		});
		const perAccount = harness({ autoOpen: false });
		const firstPerAccount = attempt(
			perAccount.transport,
			request({ cacheKey: "lane-1" }),
			{ requestId: "request-cap-1", attemptId: "attempt-cap-1" },
		);
		await Bun.sleep(0);
		expect(
			await attempt(perAccount.transport, request({ cacheKey: "lane-2" }), {
				requestId: "request-cap-2",
				attemptId: "attempt-cap-2",
			}),
		).toBeNull();
		expect(perAccount.sockets).toHaveLength(1);
		expect(perAccount.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-cap-2",
				attemptId: "attempt-cap-2",
				fallbackReason: "per_account_cap",
			}),
		);
		perAccount.sockets[0].emitError();
		expect(await firstPerAccount).toBeNull();

		enableCanary({
			[CODEX_WS_ACCOUNT_IDS_ENV]: "acct-pro,acct-two",
			[CODEX_WS_MAX_GLOBAL_ENV]: "1",
			[CODEX_WS_MAX_PER_ACCOUNT_ENV]: "2",
		});
		const global = harness({ autoOpen: false });
		const firstGlobal = attempt(
			global.transport,
			request({ cacheKey: "global-lane-1" }),
			{ requestId: "request-global-1", attemptId: "attempt-global-1" },
		);
		await Bun.sleep(0);
		expect(
			await attempt(global.transport, request({ cacheKey: "global-lane-2" }), {
				accountId: "acct-two",
				requestId: "request-global-2",
				attemptId: "attempt-global-2",
			}),
		).toBeNull();
		expect(global.sockets).toHaveLength(1);
		expect(global.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-global-2",
				attemptId: "attempt-global-2",
				fallbackReason: "global_cap",
			}),
		);
		global.sockets[0].emitError();
		expect(await firstGlobal).toBeNull();
	});

	test("bypasses a concurrent request while the same lane handshake is pending", async () => {
		enableCanary();
		const h = harness({ autoOpen: false });
		const first = attempt(h.transport, request(), {
			requestId: "request-opening-1",
			attemptId: "attempt-opening-1",
		});
		await Bun.sleep(0);
		const second = attempt(h.transport, request(), {
			requestId: "request-opening-2",
			attemptId: "attempt-opening-2",
		});
		await Bun.sleep(0);

		for (const socket of h.sockets) socket.emitError();
		expect(await Promise.all([first, second])).toEqual([null, null]);
		expect(h.sockets).toHaveLength(1);
		expect(h.transport.getStats().counters.busyHttpBypass).toBe(1);
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-opening-2",
				attemptId: "attempt-opening-2",
				fallbackReason: "connection_opening",
			}),
		);
	});

	test("reuses sequentially but sends busy traffic to HTTP without queueing", async () => {
		enableCanary();
		const h = harness();
		const firstPromise = attempt(h.transport, request(), {
			requestId: "request-busy-1",
			attemptId: "attempt-busy-1",
		});
		await Bun.sleep(0);
		h.sockets[0].onSend = () => {};
		// The send happens immediately after open; provide only a structural first frame.
		h.sockets[0].emitJson({ type: "response.created", response: { id: "r1" } });
		const first = await firstPromise;
		expect(first).not.toBeNull();
		expect(
			await attempt(h.transport, request(), {
				requestId: "request-busy-2",
				attemptId: "attempt-busy-2",
			}),
		).toBeNull();
		expect(h.sockets).toHaveLength(1);
		expect(h.transport.getStats().counters.busyHttpBypass).toBe(1);
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-busy-2",
				attemptId: "attempt-busy-2",
				fallbackReason: "connection_busy",
			}),
		);

		h.sockets[0].emitJson({
			type: "response.completed",
			response: { id: "r1" },
		});
		await first?.response.text();
		h.sockets[0].onSend = (socket) =>
			queueMicrotask(() => {
				socket.emitJson({ type: "response.created", response: { id: "r2" } });
				socket.emitJson({ type: "response.completed", response: { id: "r2" } });
			});
		const second = await attempt(h.transport);
		expect(second?.receipt.reused).toBe(true);
		await second?.response.text();
		expect(h.sockets).toHaveLength(1);
		expect(h.sockets[0].sent).toHaveLength(2);
	});

	test("observes a busy lane identity change instead of silently bypassing", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = () => undefined;
			},
		});
		const firstPending = attempt(h.transport, request(), {
			requestId: "request-identity-1",
			attemptId: "attempt-identity-1",
		});
		await Bun.sleep(0);
		h.sockets[0].emitJson({ type: "response.created", response: { id: "r1" } });
		const first = await firstPending;
		expect(first).not.toBeNull();
		expect(
			await attempt(h.transport, request({ auth: "rotated-token" }), {
				requestId: "request-identity-2",
				attemptId: "attempt-identity-2",
			}),
		).toBeNull();
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-identity-2",
				attemptId: "attempt-identity-2",
				fallbackReason: "lane_identity_busy",
			}),
		);
		h.sockets[0].emitJson({
			type: "response.completed",
			response: { id: "r1" },
		});
		await first?.response.text();
	});

	test("allows HTTP fallback only when handshake fails before response.create", async () => {
		enableCanary();
		const h = harness({ autoOpen: false });
		let frameWrittenCallbacks = 0;
		const pending = h.transport.tryRequest({
			accountId: "acct-pro",
			providerName: "codex",
			request: request(),
			signal: new AbortController().signal,
			requestId: "request-handshake",
			attemptId: "attempt-handshake",
			onFrameWritten: () => {
				frameWrittenCallbacks++;
			},
		});
		await Bun.sleep(0);
		h.sockets[0].emitError();
		expect(await pending).toBeNull();
		expect(frameWrittenCallbacks).toBe(0);
		expect(h.transport.getStats().counters.preWriteHttpFallbacks).toBe(1);
		expect(h.observations.at(-1)?.fallbackAllowedBeforeWrite).toBe(true);
		expect(h.observations.at(-1)).toMatchObject({
			requestId: "request-handshake",
			attemptId: "attempt-handshake",
			fallbackReason: "handshake_error",
		});
	});

	test("observes send failures as joinable pre-write HTTP fallbacks", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = () => {
					throw new Error("send failed");
				};
			},
		});
		expect(
			await attempt(h.transport, request(), {
				requestId: "request-send",
				attemptId: "attempt-send",
			}),
		).toBeNull();
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-send",
				attemptId: "attempt-send",
				fallbackReason: "send_failed_before_write",
				fallbackAllowedBeforeWrite: true,
			}),
		);
	});

	test("never treats a local post-send callback failure as HTTP-fallback-safe", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = () => undefined;
			},
		});
		const result = await h.transport.tryRequest({
			accountId: "acct-pro",
			providerName: "codex",
			request: request(),
			signal: new AbortController().signal,
			requestId: "request-callback",
			attemptId: "attempt-callback",
			onFrameWritten: () => {
				throw new Error("local callback failed");
			},
		});

		expect(h.sockets[0].sent).toHaveLength(1);
		expect(result?.response.status).toBe(502);
		expect(result?.receipt.stickyHttp).toBe(true);
		expect(await attempt(h.transport)).toBeNull();
		expect(h.transport.getStats().counters.preWriteHttpFallbacks).toBe(0);
	});

	test("settles an in-flight handshake when the caller vetoes replay after write", async () => {
		enableCanary({ CCFLARE_CODEX_WS_FIRST_EVENT_TIMEOUT_MS: "100" });
		const h = harness({
			configureSocket(socket) {
				socket.onSend = () => undefined;
			},
		});
		const pending = h.transport.tryRequest({
			accountId: "acct-pro",
			providerName: "codex",
			request: request(),
			signal: new AbortController().signal,
			requestId: "request-veto",
			attemptId: "attempt-veto",
			onFrameWritten: (receipt) => {
				queueMicrotask(() => receipt.markPostWriteFailure("semantic_stall"));
			},
		});

		const timeout = Symbol("timeout");
		const outcome = await Promise.race([
			pending,
			Bun.sleep(25).then(() => timeout),
		]);
		if (outcome === timeout) {
			h.transport.shutdown();
			await pending;
		}

		expect(outcome).not.toBe(timeout);
		expect(outcome?.response.status).toBe(504);
		expect(outcome?.receipt.stickyHttp).toBe(true);
		expect(h.transport.getStats().counters.postWriteFailures).toBe(1);
	});

	test("returns a final error and pins the conversation to HTTP after post-write close", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => ws.emitClose(1011, "boom"));
			},
		});
		const result = await attempt(h.transport);
		expect(result?.response.status).toBe(502);
		expect(await result?.response.json()).toMatchObject({
			type: "error",
			error: { type: "api_error" },
		});
		expect(result?.receipt.frameWritten).toBe(true);
		expect(result?.receipt.stickyHttp).toBe(true);
		expect(
			await attempt(h.transport, request(), {
				requestId: "request-sticky",
				attemptId: "attempt-sticky",
			}),
		).toBeNull();
		expect(h.sockets).toHaveLength(1);
		expect(h.transport.getStats().counters.postWriteFailures).toBe(1);
		expect(h.observations.at(-1)?.fallbackAllowedBeforeWrite).toBe(false);
		expect(h.observations.at(-1)).toMatchObject({
			requestId: "request-sticky",
			attemptId: "attempt-sticky",
			fallbackReason: "sticky_http",
		});
	});

	test("normalizes upstream terminal error observations without losing the exact category", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({
							type: "response.created",
							response: { id: "failed" },
						});
						ws.emitJson({
							type: "response.failed",
							response: { id: "failed" },
						});
					});
			},
		});
		const result = await attempt(h.transport, request(), {
			requestId: "request-terminal-error",
			attemptId: "attempt-terminal-error",
		});
		await result?.response.text();
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-terminal-error",
				attemptId: "attempt-terminal-error",
				closeCategory: "response.failed",
				fallbackReason: "upstream_terminal_error",
				stickyHttp: true,
			}),
		);
	});

	test("bounds queued WebSocket output and never replays a flooded slow reader", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() =>
						ws.emitJson({
							type: "response.created",
							response: { id: "flood" },
						}),
					);
			},
		});
		const result = await attempt(h.transport, request(), {
			requestId: "request-flood",
			attemptId: "attempt-flood",
		});
		expect(result).not.toBeNull();
		for (let index = 0; index < 300; index++) {
			h.sockets[0].emitJson({
				type: "response.output_text.delta",
				delta: "x",
				sequence_number: index,
			});
		}
		for (let index = 0; index < 20 && !result?.receipt.stickyHttp; index++) {
			await Bun.sleep(0);
		}
		expect(result?.receipt.stickyHttp).toBe(true);
		expect(h.transport.getStats().poolSize).toBe(0);
		expect(h.observations).toContainEqual(
			expect.objectContaining({
				requestId: "request-flood",
				attemptId: "attempt-flood",
				fallbackReason: "buffer_overflow",
				fallbackAllowedBeforeWrite: false,
				stickyHttp: true,
			}),
		);
		expect(
			await attempt(h.transport, request(), {
				requestId: "request-flood-retry",
				attemptId: "attempt-flood-retry",
			}),
		).toBeNull();
	});

	test("records at most one terminal observation per transport attempt", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({ type: "response.created", response: { id: "once" } });
						ws.emitJson({
							type: "response.completed",
							response: { id: "once" },
						});
					});
			},
		});
		const result = await attempt(h.transport, request(), {
			requestId: "request-once",
			attemptId: "attempt-once",
		});
		await result?.response.text();
		result?.receipt.markPostWriteFailure("semantic_stall");
		expect(
			h.observations.filter(
				(observation) => observation.attemptId === "attempt-once",
			),
		).toHaveLength(1);
	});

	test("post-write timeout is final and sticky with no replay", async () => {
		enableCanary({ CCFLARE_CODEX_WS_FIRST_EVENT_TIMEOUT_MS: "5" });
		const h = harness({
			configureSocket: (socket) => (socket.onSend = () => {}),
		});
		const result = await attempt(h.transport);
		expect(result?.response.status).toBe(504);
		expect(result?.receipt.stickyHttp).toBe(true);
		expect(await attempt(h.transport)).toBeNull();
		expect(h.sockets).toHaveLength(1);
	});

	test("abort closes the socket, preserves the signal reason, and never replays", async () => {
		enableCanary();
		const controller = new AbortController();
		let writtenReceipt: { frameWritten: boolean; stickyHttp: boolean } | null =
			null;
		const h = harness({
			configureSocket(socket) {
				socket.onSend = () =>
					queueMicrotask(() => controller.abort("deadline"));
			},
		});
		await expect(
			h.transport.tryRequest({
				accountId: "acct-pro",
				providerName: "codex",
				request: request(),
				signal: controller.signal,
				requestId: "request-abort",
				attemptId: "attempt-abort",
				onFrameWritten: (receipt) => {
					writtenReceipt = receipt;
				},
			}),
		).rejects.toBe("deadline");
		expect(writtenReceipt).toMatchObject({
			frameWritten: true,
			stickyHttp: true,
		});
		expect(h.sockets[0].closes).toHaveLength(1);
		expect(await attempt(h.transport)).toBeNull();
	});

	test("malformed frames cannot bleed into a later request", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) => queueMicrotask(() => ws.emitRaw("not-json"));
			},
		});
		const bad = await attempt(h.transport);
		expect(bad?.response.status).toBe(502);
		expect(await attempt(h.transport)).toBeNull();
		expect(h.sockets[0].sent).toHaveLength(1);
	});
});

describe("CodexWebSocketTransport pool lifecycle", () => {
	test("shutdown finalizes a sent request without replay when no event has arrived", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = () => undefined;
			},
		});
		const pending = attempt(h.transport);
		await Bun.sleep(0);
		h.transport.shutdown();

		const timeout = Symbol("timeout");
		const outcome = await Promise.race([
			pending,
			Bun.sleep(25).then(() => timeout),
		]);
		expect(outcome).not.toBe(timeout);
		expect(outcome?.response.status).toBe(502);
		expect(outcome?.receipt.stickyHttp).toBe(true);
		expect(h.sockets[0].closes).toHaveLength(1);
	});

	test("shutdown cancels a handshake that has not opened yet", async () => {
		enableCanary({ CCFLARE_CODEX_WS_HANDSHAKE_TIMEOUT_MS: "1000" });
		const h = harness({ autoOpen: false });
		const pending = attempt(h.transport);
		await Bun.sleep(0);
		h.transport.shutdown();

		const timeout = Symbol("timeout");
		const outcome = await Promise.race([
			pending,
			Bun.sleep(25).then(() => timeout),
		]);
		if (outcome === timeout) {
			h.sockets[0].emitError();
			await pending;
		}
		expect(outcome).toBeNull();
		expect(h.sockets[0].closes).toHaveLength(1);
	});

	test("separates account/model/auth and replaces changed model or auth lanes", async () => {
		enableCanary({
			[CODEX_WS_ACCOUNT_IDS_ENV]: "acct-pro,acct-two",
			[CODEX_WS_MODELS_ENV]: "gpt-5.6-sol,gpt-5.6-terra",
		});
		const h = harness({
			configureSocket(socket, index) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({
							type: "response.created",
							response: { id: `r${index}` },
						});
						ws.emitJson({
							type: "response.completed",
							response: { id: `r${index}` },
						});
					});
			},
		});
		const base = await attempt(h.transport);
		await base?.response.text();
		const authChanged = await attempt(
			h.transport,
			request({ auth: "rotated-token" }),
		);
		await authChanged?.response.text();
		expect(h.sockets[0].closes).toHaveLength(1);
		const modelChanged = await attempt(
			h.transport,
			request({ auth: "rotated-token", model: "gpt-5.6-terra" }),
		);
		await modelChanged?.response.text();
		expect(h.sockets[1].closes).toHaveLength(1);
		const accountChanged = await attempt(h.transport, request(), {
			accountId: "acct-two",
		});
		await accountChanged?.response.text();
		expect(h.sockets).toHaveLength(4);
	});

	test("evicts idle TTL, max-age, per-account, and global LRU entries", async () => {
		let now = 1_000;
		enableCanary({
			[CODEX_WS_IDLE_TTL_MS_ENV]: "10",
			[CODEX_WS_MAX_AGE_MS_ENV]: "30",
			[CODEX_WS_MAX_GLOBAL_ENV]: "2",
			[CODEX_WS_MAX_PER_ACCOUNT_ENV]: "2",
		});
		const h = harness({
			now: () => now,
			configureSocket(socket, index) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({
							type: "response.created",
							response: { id: `r${index}` },
						});
						ws.emitJson({
							type: "response.completed",
							response: { id: `r${index}` },
						});
					});
			},
		});
		const first = await attempt(h.transport, request({ cacheKey: "key-1" }));
		await first?.response.text();
		now += 11;
		const ttl = await attempt(h.transport, request({ cacheKey: "key-1" }));
		await ttl?.response.text();
		expect(h.sockets[0].closes).toHaveLength(1);

		now += 31;
		const aged = await attempt(h.transport, request({ cacheKey: "key-1" }));
		await aged?.response.text();
		expect(h.sockets[1].closes).toHaveLength(1);

		for (const key of ["key-2", "key-3"]) {
			const result = await attempt(h.transport, request({ cacheKey: key }));
			await result?.response.text();
		}
		expect(h.transport.getStats().poolSize).toBeLessThanOrEqual(2);
		expect(h.transport.getStats().counters.evictions).toBeGreaterThanOrEqual(3);
	});

	test("shutdown closes every socket and stats/log observations contain no secrets", async () => {
		enableCanary();
		const h = harness({
			configureSocket(socket) {
				socket.onSend = (ws) =>
					queueMicrotask(() => {
						ws.emitJson({ type: "response.created", response: { id: "r1" } });
						ws.emitJson({ type: "response.completed", response: { id: "r1" } });
					});
			},
		});
		const result = await attempt(h.transport);
		await result?.response.text();
		const serialized = JSON.stringify({
			stats: h.transport.getStats(),
			observations: h.observations,
		});
		for (const secret of [
			"secret-access-token",
			"private-cache-key",
			"private prompt body",
			"must-not-leak-turn-state",
			"current-cloudflare-cookie",
		]) {
			expect(serialized).not.toContain(secret);
		}
		h.transport.shutdown();
		expect(h.sockets[0].closes).toHaveLength(1);
		expect(h.transport.getStats().poolSize).toBe(0);
	});
});
