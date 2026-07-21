import { Logger } from "@better-ccflare/logger";
import { chatGptCloudflareCookieJar } from "./chatgpt-cloudflare-cookies";
import {
	CODEX_RESPONSES_WEBSOCKET_URL,
	type CodexWebSocketAttemptInput,
	type CodexWebSocketAttemptResult,
	type CodexWebSocketCounters,
	type CodexWebSocketFactory,
	type CodexWebSocketFailureCategory,
	type CodexWebSocketFallbackReason,
	type CodexWebSocketLike,
	type CodexWebSocketObservation,
	type CodexWebSocketOptions,
	type CodexWebSocketParsedRequest,
	type CodexWebSocketReceipt,
	type CodexWebSocketRuntimeConfig,
	type CodexWebSocketStats,
	isCodexWebSocketAssigned,
	isOfficialCodexSubscriptionUrl,
	readCodexWebSocketPercent,
	readCodexWebSocketRuntimeConfig,
	readCodexWebSocketTelemetryWarn,
} from "./codex-websocket-contract";
import {
	buildCodexWebSocketHandshakeHeaders,
	CODEX_WEBSOCKET_ERROR_EVENT_TYPES,
	CODEX_WEBSOCKET_TERMINAL_EVENT_TYPES,
	CodexWebSocketPreWriteFailure,
	closeCodexWebSocketSafely,
	codexWebSocketMessageText,
	createCodexWebSocketNoReplayResponse,
	defaultCodexWebSocketFactory,
	encodeCodexWebSocketSseEvent,
	getCodexWebSocketCloseCode,
	getCodexWebSocketResponseId,
	isCodexWebSocketOutputEvent,
} from "./codex-websocket-wire";
import { opaqueRuntimeId } from "./opaque-runtime-id";

export type {
	CodexWebSocketAttemptInput,
	CodexWebSocketAttemptResult,
	CodexWebSocketCounters,
	CodexWebSocketFactory,
	CodexWebSocketFailureCategory,
	CodexWebSocketFallbackReason,
	CodexWebSocketLike,
	CodexWebSocketObservation,
	CodexWebSocketOptions,
	CodexWebSocketReceipt,
	CodexWebSocketStats,
} from "./codex-websocket-contract";
export {
	CODEX_RESPONSES_WEBSOCKET_URL,
	CODEX_WS_ACCOUNT_IDS_ENV,
	CODEX_WS_IDLE_TTL_MS_ENV,
	CODEX_WS_MAX_AGE_MS_ENV,
	CODEX_WS_MAX_GLOBAL_ENV,
	CODEX_WS_MAX_PER_ACCOUNT_ENV,
	CODEX_WS_MODELS_ENV,
	CODEX_WS_PERCENT_ENV,
	CODEX_WS_TELEMETRY_WARN_ENV,
	isCodexWebSocketAssigned,
	readCodexWebSocketTelemetryWarn,
} from "./codex-websocket-contract";
export { createCodexWebSocketNoReplayResponse } from "./codex-websocket-wire";

const log = new Logger("CodexWebSocketTransport");

const MAX_STICKY_HTTP = 2_048;
const MAX_RECENT_OBSERVATIONS = 128;
// Keep the WebSocket reader from outrunning a paused or abandoned HTTP client.
// These are intentionally internal until the canary provides enough evidence to
// justify widening or exposing them as operational knobs.
const MAX_BUFFERED_FRAMES = 256;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

interface InternalCodexWebSocketReceipt extends CodexWebSocketReceipt {
	readonly requestId: string;
	readonly attemptId: string;
	observationRecorded: boolean;
}

interface ActiveRequest {
	receipt: InternalCodexWebSocketReceipt;
	signal: AbortSignal;
	controller: ReadableStreamDefaultController<Uint8Array>;
	stream: ReadableStream<Uint8Array>;
	startedAt: number;
	frameWrittenAt: number;
	handshakeMs: number | null;
	firstSettled: boolean;
	closed: boolean;
	responseId: string | null;
	firstEventMs: number | null;
	createdMs: number | null;
	firstOutputMs: number | null;
	terminalMs: number | null;
	pendingFrames: Uint8Array[];
	pendingBytes: number;
	streamQueuedByteLengths: number[];
	streamQueuedBytes: number;
	streamClosePending: boolean;
	firstTimer?: ReturnType<typeof setTimeout>;
	messageChain: Promise<void>;
	resolveFirst: (result: Response | null) => void;
	rejectFirst: (reason: unknown) => void;
	firstPromise: Promise<Response | null>;
	abortListener: () => void;
}

interface PoolEntry {
	poolKey: string;
	laneKey: string;
	stickyKey: string;
	connectionId: string;
	accountId: string;
	model: string;
	socket: CodexWebSocketLike;
	createdAt: number;
	lastUsedAt: number;
	busy: boolean;
	closed: boolean;
	lastResponseId: string | null;
	active?: ActiveRequest;
	messageListener: (event: Event) => void;
	errorListener: () => void;
	closeListener: (event: Event) => void;
}

export interface CodexWebSocketTransportOptionsForTests {
	createWebSocket?: CodexWebSocketFactory;
	now?: () => number;
	observe?: (observation: CodexWebSocketObservation) => void;
	applyCloudflareCookies?: (url: string, headers: Headers) => void;
}

export class CodexWebSocketTransport {
	private readonly pool = new Map<string, PoolEntry>();
	private readonly openingLanes = new Set<string>();
	private readonly openingReservations = new Map<string, string>();
	private readonly stickyHttp = new Map<string, number>();
	private readonly recent: CodexWebSocketObservation[] = [];
	private readonly createWebSocket: CodexWebSocketFactory;
	private readonly now: () => number;
	private readonly observe?: (observation: CodexWebSocketObservation) => void;
	private readonly applyCloudflareCookies: (
		url: string,
		headers: Headers,
	) => void;
	private readonly shutdownController = new AbortController();
	private shuttingDown = false;
	private readonly counters: CodexWebSocketCounters = {
		requests: 0,
		assigned: 0,
		controls: 0,
		connectionsOpened: 0,
		connectionsReused: 0,
		busyHttpBypass: 0,
		preWriteHttpFallbacks: 0,
		postWriteFailures: 0,
		stickyHttpBypass: 0,
		evictions: 0,
		aborts: 0,
		terminals: 0,
	};

	constructor(options: CodexWebSocketTransportOptionsForTests = {}) {
		this.createWebSocket =
			options.createWebSocket ?? defaultCodexWebSocketFactory;
		this.now = options.now ?? Date.now;
		this.observe = options.observe;
		this.applyCloudflareCookies =
			options.applyCloudflareCookies ??
			((url, headers) =>
				chatGptCloudflareCookieJar.applyCookieHeader(url, headers));
	}

	async tryRequest(
		input: CodexWebSocketAttemptInput,
	): Promise<CodexWebSocketAttemptResult | null> {
		this.counters.requests++;
		const config = readCodexWebSocketRuntimeConfig();
		if (this.shuttingDown || config.percent <= 0) {
			this.retireIdle("kill_switch");
			return null;
		}
		if (input.signal.aborted) throw input.signal.reason;
		// Run lifecycle cleanup before request/allowlist/body eligibility can
		// return. This makes config disablement effective even when the current
		// request is no longer eligible for the lane it is retiring.
		this.sweepExpired(config);
		if (
			input.providerName !== "codex" ||
			input.request.method !== "POST" ||
			!isOfficialCodexSubscriptionUrl(input.request.url)
		) {
			return null;
		}

		const parsed = await this.parseRequest(input, config);
		if (!parsed) return null;
		if (this.stickyHttp.has(parsed.stickyKey)) {
			this.touchSticky(parsed.stickyKey);
			this.counters.stickyHttpBypass++;
			this.record({
				...this.emptyObservation(input, parsed.model, parsed.cohortId),
				fallbackReason: "sticky_http",
				stickyHttp: true,
			});
			return null;
		}
		if (
			!isCodexWebSocketAssigned(
				input.accountId,
				parsed.promptCacheKey,
				config.percent,
			)
		) {
			this.counters.controls++;
			this.record({
				...this.emptyObservation(input, parsed.model, parsed.cohortId),
				assignment: "control",
				fallbackReason: "cohort_control",
			});
			return null;
		}
		this.counters.assigned++;
		if (this.openingLanes.has(parsed.laneKey)) {
			this.counters.busyHttpBypass++;
			this.record({
				...this.emptyObservation(input, parsed.model, parsed.cohortId),
				busy: true,
				fallbackReason: "connection_opening",
			});
			return null;
		}

		let entry = this.pool.get(parsed.poolKey);
		if (entry && (entry.closed || entry.socket.readyState !== 1)) {
			this.evict(entry, "unavailable");
			entry = undefined;
		}
		if (entry?.busy) {
			this.counters.busyHttpBypass++;
			this.record({
				...this.emptyObservation(input, parsed.model, parsed.cohortId),
				connectionId: entry.connectionId,
				connectionNew: false,
				connectionReused: false,
				connectionAgeMs: this.now() - entry.createdAt,
				busy: true,
				fallbackReason: "connection_busy",
			});
			return null;
		}

		for (const candidate of [...this.pool.values()]) {
			if (
				candidate.laneKey === parsed.laneKey &&
				candidate.poolKey !== parsed.poolKey
			) {
				if (candidate.busy) {
					this.counters.busyHttpBypass++;
					this.record({
						...this.emptyObservation(input, parsed.model, parsed.cohortId),
						connectionId: candidate.connectionId,
						connectionNew: false,
						connectionReused: false,
						connectionAgeMs: this.now() - candidate.createdAt,
						busy: true,
						fallbackReason: "lane_identity_busy",
					});
					return null;
				}
				this.evict(candidate, "lane_identity_changed");
			}
		}

		let handshakeMs: number | null = null;
		let reused = true;
		if (!entry) {
			reused = false;
			const capFallback = this.reserveOpening(input.accountId, parsed, config);
			if (capFallback) {
				this.counters.preWriteHttpFallbacks++;
				this.record({
					...this.emptyObservation(input, parsed.model, parsed.cohortId),
					fallbackReason: capFallback,
					fallbackAllowedBeforeWrite: true,
				});
				return null;
			}
			const openedAt = this.now();
			this.openingLanes.add(parsed.laneKey);
			try {
				entry = await this.openEntry(input, parsed, config);
				handshakeMs = this.now() - openedAt;
			} catch (error) {
				if (input.signal.aborted) throw input.signal.reason;
				const category =
					error instanceof CodexWebSocketPreWriteFailure
						? error.category
						: "handshake_error";
				this.counters.preWriteHttpFallbacks++;
				this.record({
					...this.emptyObservation(input, parsed.model, parsed.cohortId),
					handshakeMs: this.now() - openedAt,
					handshakeFailure: category,
					fallbackReason: category,
					fallbackAllowedBeforeWrite: true,
				});
				return null;
			} finally {
				this.openingLanes.delete(parsed.laneKey);
				this.openingReservations.delete(parsed.laneKey);
			}
			this.counters.connectionsOpened++;
		} else {
			this.counters.connectionsReused++;
			this.touchEntry(entry);
		}

		return this.sendRequest(input, parsed, entry, reused, handshakeMs, config);
	}

	getStats(): CodexWebSocketStats {
		const now = this.now();
		const config = readCodexWebSocketRuntimeConfig();
		return {
			percent: config.percent,
			accountAllowlistSize: config.accountIds.size,
			modelAllowlistSize: config.models.size,
			poolSize: this.pool.size,
			stickyHttpSize: this.stickyHttp.size,
			counters: { ...this.counters },
			pool: [...this.pool.values()].map((entry) => ({
				connectionId: entry.connectionId,
				accountId: entry.accountId,
				model: entry.model,
				busy: entry.busy,
				ageMs: Math.max(0, now - entry.createdAt),
				idleMs: Math.max(0, now - entry.lastUsedAt),
			})),
			recent: this.recent.map((entry) => ({ ...entry })),
		};
	}

	shutdown(): void {
		this.shuttingDown = true;
		this.shutdownController.abort();
		for (const entry of [...this.pool.values()]) {
			const active = entry.active;
			if (active?.receipt.frameWritten) {
				this.failAfterWrite(
					entry,
					active,
					entry.stickyKey,
					"post_write_close",
					502,
				);
			} else {
				this.evict(entry, "shutdown", true);
			}
		}
	}

	private async parseRequest(
		input: CodexWebSocketAttemptInput,
		config: CodexWebSocketRuntimeConfig,
	): Promise<CodexWebSocketParsedRequest | null> {
		if (!config.accountIds.has(input.accountId)) return null;
		let payload: Record<string, unknown>;
		try {
			payload = (await input.request.clone().json()) as Record<string, unknown>;
		} catch {
			return null;
		}
		const model = typeof payload.model === "string" ? payload.model : "";
		const promptCacheKey =
			typeof payload.prompt_cache_key === "string"
				? payload.prompt_cache_key
				: "";
		if (
			payload.stream !== true ||
			!model ||
			!promptCacheKey ||
			!config.models.has(model.toLowerCase())
		) {
			return null;
		}
		const authorization = input.request.headers.get("authorization") ?? "";
		if (!authorization) return null;
		const authFingerprint = opaqueRuntimeId("codex-ws-auth", authorization);
		const framePayload = { ...payload };
		delete framePayload.previous_response_id;
		const laneKey = opaqueRuntimeId(
			"codex-ws-lane",
			input.accountId,
			promptCacheKey,
		);
		const poolKey = opaqueRuntimeId(
			"codex-ws-connection",
			input.accountId,
			promptCacheKey,
			model,
			authFingerprint,
		);
		return {
			model,
			promptCacheKey,
			laneKey,
			poolKey,
			stickyKey: opaqueRuntimeId(
				"codex-ws-sticky",
				input.accountId,
				promptCacheKey,
			),
			cohortId: opaqueRuntimeId(
				"codex-ws-cohort",
				input.accountId,
				promptCacheKey,
			),
			// Delay the only full-history reserialization until after cohort, sticky,
			// busy, identity, and capacity fallbacks have all been ruled out.
			framePayload,
		};
	}

	private async openEntry(
		input: CodexWebSocketAttemptInput,
		parsed: CodexWebSocketParsedRequest,
		config: CodexWebSocketRuntimeConfig,
	): Promise<PoolEntry> {
		const headers = buildCodexWebSocketHandshakeHeaders(
			input.request,
			this.applyCloudflareCookies,
		);
		const options: CodexWebSocketOptions = {
			headers: Object.fromEntries(headers.entries()),
		};
		const socket = this.createWebSocket(CODEX_RESPONSES_WEBSOCKET_URL, options);
		try {
			await this.waitForOpen(socket, input.signal, config.handshakeTimeoutMs);
		} catch (error) {
			closeCodexWebSocketSafely(socket, 1000);
			throw error;
		}

		const now = this.now();
		const entry: PoolEntry = {
			poolKey: parsed.poolKey,
			laneKey: parsed.laneKey,
			stickyKey: parsed.stickyKey,
			connectionId: opaqueRuntimeId(
				"codex-ws-socket",
				parsed.poolKey,
				crypto.randomUUID(),
			),
			accountId: input.accountId,
			model: parsed.model,
			socket,
			createdAt: now,
			lastUsedAt: now,
			busy: false,
			closed: false,
			lastResponseId: null,
			messageListener: () => undefined,
			errorListener: () => undefined,
			closeListener: () => undefined,
		};
		entry.messageListener = (event) => this.onMessage(entry, event);
		entry.errorListener = () => this.onSocketFailure(entry, "post_write_error");
		entry.closeListener = (event) =>
			this.onSocketFailure(
				entry,
				"post_write_close",
				getCodexWebSocketCloseCode(event),
			);
		socket.addEventListener("message", entry.messageListener);
		socket.addEventListener("error", entry.errorListener);
		socket.addEventListener("close", entry.closeListener);
		this.pool.set(entry.poolKey, entry);
		return entry;
	}

	private waitForOpen(
		socket: CodexWebSocketLike,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const shutdownSignal = this.shutdownController.signal;
			const finish = (error?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
				socket.removeEventListener("close", onClose);
				signal.removeEventListener("abort", onAbort);
				shutdownSignal.removeEventListener("abort", onShutdown);
				if (error === undefined) resolve();
				else reject(error);
			};
			const onOpen = () => finish();
			const onError = () =>
				finish(new CodexWebSocketPreWriteFailure("handshake_error"));
			const onClose = () =>
				finish(new CodexWebSocketPreWriteFailure("handshake_close"));
			const onAbort = () => finish(signal.reason);
			const onShutdown = () =>
				finish(new CodexWebSocketPreWriteFailure("handshake_close"));
			const timer = setTimeout(
				() => finish(new CodexWebSocketPreWriteFailure("handshake_timeout")),
				timeoutMs,
			);
			socket.addEventListener("open", onOpen, { once: true });
			socket.addEventListener("error", onError, { once: true });
			socket.addEventListener("close", onClose, { once: true });
			signal.addEventListener("abort", onAbort, { once: true });
			shutdownSignal.addEventListener("abort", onShutdown, { once: true });
			if (signal.aborted) onAbort();
			else if (shutdownSignal.aborted) onShutdown();
		});
	}

	private async sendRequest(
		input: CodexWebSocketAttemptInput,
		parsed: CodexWebSocketParsedRequest,
		entry: PoolEntry,
		reused: boolean,
		handshakeMs: number | null,
		config: CodexWebSocketRuntimeConfig,
	): Promise<CodexWebSocketAttemptResult | null> {
		if (input.signal.aborted) throw input.signal.reason;
		const { accountId } = input;
		const { cohortId, model, stickyKey } = parsed;
		entry.busy = true;
		let resolveFirst!: (result: Response | null) => void;
		let rejectFirst!: (reason: unknown) => void;
		const firstPromise = new Promise<Response | null>((resolve, reject) => {
			resolveFirst = resolve;
			rejectFirst = reject;
		});
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const receipt: InternalCodexWebSocketReceipt = {
			requestId: input.requestId,
			attemptId: input.attemptId,
			observationRecorded: false,
			connectionId: entry.connectionId,
			cohortId,
			reused,
			frameWritten: false,
			stickyHttp: false,
			markPostWriteFailure: (category) => {
				if (!receipt.stickyHttp) {
					this.markSticky(stickyKey);
					receipt.stickyHttp = true;
					this.counters.postWriteFailures++;
				}
				const activeRequest = entry.active;
				if (activeRequest && !activeRequest.closed) {
					if (!activeRequest.firstSettled) {
						activeRequest.firstSettled = true;
						const status =
							category === "semantic_stall" || category === "post_write_timeout"
								? 504
								: 502;
						activeRequest.resolveFirst(
							createCodexWebSocketNoReplayResponse(status, category),
						);
					}
					this.finishActive(entry, activeRequest, true);
					this.recordActive(entry, activeRequest, category);
				} else {
					this.recordReceiptFailure(accountId, model, entry, receipt, category);
				}
				this.evict(entry, category, true);
			},
		};
		let active!: ActiveRequest;
		const stream = new ReadableStream<Uint8Array>(
			{
				start(streamController) {
					controller = streamController;
				},
				pull: () => {
					if (active) {
						// A pull after enqueue means the previously queued chunk has been
						// consumed (or an empty stream is awaiting its first chunk).
						const consumed = active.streamQueuedByteLengths.shift();
						if (consumed !== undefined) active.streamQueuedBytes -= consumed;
						this.flushActive(active);
					}
				},
				cancel: () => {
					receipt.markPostWriteFailure("stream_cancelled");
				},
			},
			{ highWaterMark: 1 },
		);
		active = {
			receipt,
			signal: input.signal,
			controller,
			stream,
			startedAt: this.now(),
			frameWrittenAt: this.now(),
			handshakeMs,
			firstSettled: false,
			closed: false,
			responseId: null,
			firstEventMs: null,
			createdMs: null,
			firstOutputMs: null,
			terminalMs: null,
			pendingFrames: [],
			pendingBytes: 0,
			streamQueuedByteLengths: [],
			streamQueuedBytes: 0,
			streamClosePending: false,
			messageChain: Promise.resolve(),
			resolveFirst,
			rejectFirst,
			firstPromise,
			abortListener: () => undefined,
		};
		active.abortListener = () => {
			if (active.closed) return;
			this.counters.aborts++;
			if (receipt.frameWritten) {
				this.markSticky(stickyKey);
				receipt.stickyHttp = true;
			}
			this.finishActive(entry, active, true);
			this.recordActive(entry, active, "abort");
			this.evict(entry, "abort");
			if (!active.firstSettled) {
				active.firstSettled = true;
				active.rejectFirst(active.signal.reason);
			}
		};
		input.signal.addEventListener("abort", active.abortListener, {
			once: true,
		});
		entry.active = active;
		try {
			const frame = JSON.stringify({
				...parsed.framePayload,
				type: "response.create",
			});
			entry.socket.send(frame);
			// WebSocket.send() synchronously queues/copies the frame. Drop the only
			// canary-owned full-history serialization before awaiting the first event.
			parsed.framePayload = {};
		} catch {
			this.finishActive(entry, active, true);
			this.evict(entry, "send_failed");
			this.counters.preWriteHttpFallbacks++;
			this.record({
				...this.emptyObservation(input, model, cohortId),
				connectionId: entry.connectionId,
				connectionNew: !reused,
				connectionReused: reused,
				connectionAgeMs: this.now() - entry.createdAt,
				handshakeMs,
				fallbackReason: "send_failed_before_write",
				fallbackAllowedBeforeWrite: true,
			});
			return null;
		}
		receipt.frameWritten = true;
		active.frameWrittenAt = this.now();
		try {
			input.onFrameWritten?.(receipt);
		} catch {
			this.failAfterWrite(entry, active, stickyKey, "post_write_error", 502);
			const finalResponse = await active.firstPromise;
			return finalResponse ? { response: finalResponse, receipt } : null;
		}

		active.firstTimer = setTimeout(() => {
			if (active.firstSettled || entry.active !== active) return;
			this.failAfterWrite(entry, active, stickyKey, "post_write_timeout", 504);
		}, config.firstEventTimeoutMs);
		if (input.signal.aborted) active.abortListener();

		const earlyError = await active.firstPromise;
		if (earlyError) return { response: earlyError, receipt };
		return {
			response: new Response(active.stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
			receipt,
		};
	}

	private onMessage(entry: PoolEntry, event: Event): void {
		const active = entry.active;
		if (!active || active.closed || entry.closed) return;
		active.messageChain = active.messageChain
			.then(async () => {
				if (entry.active !== active || active.closed) return;
				const raw = await codexWebSocketMessageText(
					(event as MessageEvent<unknown>).data,
				);
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					this.failAfterWrite(
						entry,
						active,
						entry.stickyKey,
						"malformed_frame",
						502,
					);
					return;
				}
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (!type) {
					this.failAfterWrite(
						entry,
						active,
						entry.stickyKey,
						"malformed_frame",
						502,
					);
					return;
				}
				const responseId = getCodexWebSocketResponseId(parsed);
				if (
					responseId &&
					entry.lastResponseId === responseId &&
					active.responseId === null
				) {
					return;
				}
				if (
					active.responseId &&
					responseId &&
					active.responseId !== responseId
				) {
					return;
				}
				if (type === "response.created" && responseId) {
					active.responseId = responseId;
				}

				const elapsed = this.now() - active.frameWrittenAt;
				if (active.firstEventMs === null) active.firstEventMs = elapsed;
				if (type === "response.created" && active.createdMs === null) {
					active.createdMs = elapsed;
				}
				if (
					isCodexWebSocketOutputEvent(type) &&
					active.firstOutputMs === null
				) {
					active.firstOutputMs = elapsed;
				}
				if (
					!this.enqueueActiveFrame(
						entry,
						active,
						encodeCodexWebSocketSseEvent(type, parsed),
					)
				) {
					return;
				}
				if (!active.firstSettled) {
					active.firstSettled = true;
					if (active.firstTimer) clearTimeout(active.firstTimer);
					active.resolveFirst(null);
				}
				if (CODEX_WEBSOCKET_TERMINAL_EVENT_TYPES.has(type)) {
					active.terminalMs = elapsed;
					entry.lastResponseId = active.responseId ?? responseId;
					this.counters.terminals++;
					let terminalFailure: string | null = null;
					if (CODEX_WEBSOCKET_ERROR_EVENT_TYPES.has(type)) {
						terminalFailure = type;
						if (!active.receipt.stickyHttp) {
							this.markSticky(entry.stickyKey);
							active.receipt.stickyHttp = true;
							this.counters.postWriteFailures++;
						}
					}
					this.finishActive(entry, active, true, true);
					this.recordActive(entry, active, terminalFailure);
					if (
						CODEX_WEBSOCKET_ERROR_EVENT_TYPES.has(type) ||
						readCodexWebSocketPercent() <= 0
					) {
						this.evict(
							entry,
							CODEX_WEBSOCKET_ERROR_EVENT_TYPES.has(type)
								? type
								: "kill_switch",
						);
					}
				}
			})
			.catch(() => {
				if (entry.active === active && !active.closed) {
					this.failAfterWrite(
						entry,
						active,
						entry.stickyKey,
						"malformed_frame",
						502,
					);
				}
			});
	}

	private onSocketFailure(
		entry: PoolEntry,
		category: "post_write_close" | "post_write_error",
		code: number | null = null,
	): void {
		if (entry.closed) return;
		const active = entry.active;
		if (active?.receipt.frameWritten) {
			this.failAfterWrite(entry, active, entry.stickyKey, category, 502, code);
			return;
		}
		this.evict(entry, category);
	}

	private failAfterWrite(
		entry: PoolEntry,
		active: ActiveRequest,
		stickyKey: string,
		category: CodexWebSocketFailureCategory,
		status: 502 | 504,
		code: number | null = null,
	): void {
		if (active.closed) return;
		this.markSticky(stickyKey);
		active.receipt.stickyHttp = true;
		this.counters.postWriteFailures++;
		if (!active.firstSettled) {
			active.firstSettled = true;
			active.resolveFirst(
				createCodexWebSocketNoReplayResponse(status, category),
			);
		}
		this.finishActive(entry, active, true);
		this.recordActive(entry, active, category, code);
		this.evict(entry, category);
	}

	private finishActive(
		entry: PoolEntry,
		active: ActiveRequest,
		closeStream: boolean,
		drainQueuedFrames = false,
	): void {
		if (active.closed) return;
		active.closed = true;
		if (active.firstTimer) clearTimeout(active.firstTimer);
		active.signal.removeEventListener("abort", active.abortListener);
		if (entry.active === active) entry.active = undefined;
		entry.busy = false;
		entry.lastUsedAt = this.now();
		if (closeStream && drainQueuedFrames) {
			active.streamClosePending = true;
			this.flushActive(active);
		} else if (closeStream) {
			active.pendingFrames = [];
			active.pendingBytes = 0;
			active.streamQueuedByteLengths = [];
			active.streamQueuedBytes = 0;
			try {
				active.controller.close();
			} catch {
				// The downstream may already have cancelled this stream.
			}
		}
		this.touchEntry(entry);
	}

	private enqueueActiveFrame(
		entry: PoolEntry,
		active: ActiveRequest,
		frame: Uint8Array,
	): boolean {
		if (
			frame.byteLength > MAX_BUFFERED_BYTES ||
			active.pendingFrames.length + active.streamQueuedByteLengths.length >=
				MAX_BUFFERED_FRAMES ||
			active.pendingBytes + active.streamQueuedBytes + frame.byteLength >
				MAX_BUFFERED_BYTES
		) {
			this.failAfterWrite(
				entry,
				active,
				entry.stickyKey,
				"buffer_overflow",
				502,
			);
			return false;
		}
		active.pendingFrames.push(frame);
		active.pendingBytes += frame.byteLength;
		this.flushActive(active);
		return !active.closed;
	}

	private flushActive(active: ActiveRequest): void {
		try {
			while (
				active.pendingFrames.length > 0 &&
				(active.controller.desiredSize ?? 0) > 0
			) {
				const frame = active.pendingFrames.shift();
				if (!frame) break;
				active.pendingBytes -= frame.byteLength;
				active.controller.enqueue(frame);
				active.streamQueuedByteLengths.push(frame.byteLength);
				active.streamQueuedBytes += frame.byteLength;
			}
			if (active.streamClosePending && active.pendingFrames.length === 0) {
				active.streamClosePending = false;
				active.controller.close();
			}
		} catch {
			active.pendingFrames = [];
			active.pendingBytes = 0;
			active.streamQueuedByteLengths = [];
			active.streamQueuedBytes = 0;
			active.streamClosePending = false;
		}
	}

	private recordReceiptFailure(
		accountId: string,
		model: string,
		entry: PoolEntry,
		receipt: InternalCodexWebSocketReceipt,
		failure: CodexWebSocketFailureCategory,
	): void {
		if (receipt.observationRecorded) return;
		receipt.observationRecorded = true;
		this.record({
			...this.emptyObservation(
				{
					requestId: receipt.requestId,
					attemptId: receipt.attemptId,
					accountId,
				},
				model,
				receipt.cohortId,
			),
			effectiveTransport: "websocket",
			connectionId: receipt.connectionId,
			connectionNew: !receipt.reused,
			connectionReused: receipt.reused,
			connectionAgeMs: this.now() - entry.createdAt,
			frameWritten: receipt.frameWritten,
			closeCategory: failure,
			fallbackReason: failure,
			stickyHttp: receipt.stickyHttp,
		});
	}

	private recordActive(
		entry: PoolEntry,
		active: ActiveRequest,
		failure: string | null,
		code: number | null = null,
	): void {
		if (active.receipt.observationRecorded) return;
		active.receipt.observationRecorded = true;
		this.record({
			requestId: active.receipt.requestId,
			attemptId: active.receipt.attemptId,
			assignment: "treatment",
			effectiveTransport: "websocket",
			accountId: entry.accountId,
			model: entry.model,
			cohortId: active.receipt.cohortId,
			connectionId: entry.connectionId,
			connectionNew: !active.receipt.reused,
			connectionReused: active.receipt.reused,
			connectionAgeMs: this.now() - entry.createdAt,
			poolSize: this.pool.size,
			busy: false,
			handshakeMs: active.handshakeMs,
			handshakeFailure: null,
			frameWritten: active.receipt.frameWritten,
			firstEventMs: active.firstEventMs,
			createdMs: active.createdMs,
			firstOutputMs: active.firstOutputMs,
			terminalMs: active.terminalMs,
			closeCode: code,
			closeCategory: failure,
			fallbackReason: this.normalizeTerminalFallback(failure),
			fallbackAllowedBeforeWrite: false,
			stickyHttp: active.receipt.stickyHttp,
		});
	}

	private emptyObservation(
		input: Pick<
			CodexWebSocketAttemptInput,
			"requestId" | "attemptId" | "accountId"
		>,
		model: string,
		cohortId: string,
	): CodexWebSocketObservation {
		return {
			requestId: input.requestId,
			attemptId: input.attemptId,
			assignment: "treatment",
			effectiveTransport: "http",
			accountId: input.accountId,
			model,
			cohortId,
			connectionId: null,
			connectionNew: null,
			connectionReused: null,
			connectionAgeMs: null,
			poolSize: this.pool.size,
			busy: false,
			handshakeMs: null,
			handshakeFailure: null,
			frameWritten: false,
			firstEventMs: null,
			createdMs: null,
			firstOutputMs: null,
			terminalMs: null,
			closeCode: null,
			closeCategory: null,
			fallbackReason: null,
			fallbackAllowedBeforeWrite: false,
			stickyHttp: false,
		};
	}

	private normalizeTerminalFallback(
		failure: string | null,
	): CodexWebSocketFallbackReason | null {
		if (failure === null) return null;
		if (
			failure === "error" ||
			failure === "response.failed" ||
			failure === "response.incomplete"
		) {
			return "upstream_terminal_error";
		}
		return failure as CodexWebSocketFailureCategory;
	}

	private record(observation: CodexWebSocketObservation): void {
		this.recent.push({ ...observation, poolSize: this.pool.size });
		if (this.recent.length > MAX_RECENT_OBSERVATIONS) this.recent.shift();
		try {
			if (this.observe) this.observe(observation);
			else if (readCodexWebSocketTelemetryWarn()) {
				// Production dogfood runs commonly pin LOG_LEVEL=warn. This explicit,
				// default-off escalation keeps canary records joinable without widening
				// logging for any other subsystem.
				log.warn("codex_ws_transport", observation);
			} else log.info("codex_ws_transport", observation);
		} catch {
			// Canary telemetry is best-effort and must never alter routing semantics.
		}
	}

	private markSticky(key: string): void {
		this.stickyHttp.delete(key);
		this.stickyHttp.set(key, this.now());
		while (this.stickyHttp.size > MAX_STICKY_HTTP) {
			const oldest = this.stickyHttp.keys().next().value;
			if (oldest === undefined) break;
			this.stickyHttp.delete(oldest);
		}
	}

	private touchSticky(key: string): void {
		const value = this.stickyHttp.get(key);
		if (value === undefined) return;
		this.stickyHttp.delete(key);
		this.stickyHttp.set(key, value);
	}

	private touchEntry(entry: PoolEntry): void {
		if (entry.closed || !this.pool.has(entry.poolKey)) return;
		this.pool.delete(entry.poolKey);
		this.pool.set(entry.poolKey, entry);
	}

	private sweepExpired(config: CodexWebSocketRuntimeConfig): void {
		const now = this.now();
		for (const entry of [...this.pool.values()]) {
			if (entry.busy) continue;
			if (
				!config.accountIds.has(entry.accountId) ||
				!config.models.has(entry.model.toLowerCase())
			) {
				this.evict(entry, "allowlist_removed");
			} else if (now - entry.createdAt >= config.maxAgeMs) {
				this.evict(entry, "max_age");
			} else if (now - entry.lastUsedAt >= config.idleTtlMs) {
				this.evict(entry, "idle_ttl");
			}
		}
	}

	private retireIdle(reason: string): void {
		for (const entry of [...this.pool.values()]) {
			if (!entry.busy) this.evict(entry, reason);
		}
	}

	private reserveOpening(
		accountId: string,
		parsed: CodexWebSocketParsedRequest,
		config: CodexWebSocketRuntimeConfig,
	): "global_cap" | "per_account_cap" | null {
		const evictOldestIdle = (accountId?: string): boolean => {
			const candidate = [...this.pool.values()]
				.filter(
					(entry) =>
						!entry.busy && (!accountId || entry.accountId === accountId),
				)
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
			if (!candidate) return false;
			this.evict(candidate, accountId ? "per_account_lru" : "global_lru");
			return true;
		};
		const accountOccupancy = () =>
			[...this.pool.values()].filter((entry) => entry.accountId === accountId)
				.length +
			[...this.openingReservations.values()].filter(
				(reservedAccountId) => reservedAccountId === accountId,
			).length;
		const globalOccupancy = () =>
			this.pool.size + this.openingReservations.size;

		while (accountOccupancy() >= config.maxPerAccount) {
			if (!evictOldestIdle(accountId)) return "per_account_cap";
		}
		while (globalOccupancy() >= config.maxGlobal) {
			if (!evictOldestIdle()) return "global_cap";
		}
		this.openingReservations.set(parsed.laneKey, accountId);
		return null;
	}

	private evict(entry: PoolEntry, _reason: string, force = false): void {
		if (entry.closed) return;
		if (entry.busy && !force) {
			// Max-age, TTL, and ordinary LRU never interrupt in-flight work.
			return;
		}
		entry.closed = true;
		this.pool.delete(entry.poolKey);
		entry.socket.removeEventListener("message", entry.messageListener);
		entry.socket.removeEventListener("error", entry.errorListener);
		entry.socket.removeEventListener("close", entry.closeListener);
		if (force && entry.active) {
			this.finishActive(entry, entry.active, true);
		}
		closeCodexWebSocketSafely(entry.socket);
		this.counters.evictions++;
	}
}

export const codexWebSocketTransport = new CodexWebSocketTransport();
