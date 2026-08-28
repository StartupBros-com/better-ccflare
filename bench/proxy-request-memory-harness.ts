#!/usr/bin/env bun
/**
 * Informational lifecycle-and-memory harness for proxy request bodies.
 *
 * The configurable body workload runs through prepareRequestBody(),
 * RequestBodyContext, a model-rewriting provider transform, and real loopback
 * Bun HTTP/fetch. Response-lifecycle controls stay separate so response chunk
 * bytes cannot masquerade as request-body allocation work. No external
 * accounts or global fetch mocks are used.
 *
 * Run:
 *   bun bench/proxy-request-memory-harness.ts
 *   PROXY_MEMORY_BODY_BYTES=1048576 PROXY_MEMORY_CONCURRENCY=1 bun bench/proxy-request-memory-harness.ts
 *   PROXY_MEMORY_SOAK=1 PROXY_MEMORY_BODY_BYTES=4194304 bun bench/proxy-request-memory-harness.ts
 *
 * Soak profiles support 1 MiB (1048576), 4 MiB (4194304), and 8 MiB
 * (8388608) bodies. This harness reports measurements but deliberately does
 * not enforce allocator or RSS thresholds.
 */
// @ts-expect-error bun:jsc's heapStats is available at runtime but incomplete in Bun's types.
import { heapStats } from "bun:jsc";
import type { Account } from "@better-ccflare/types";
import {
	BodyAdmissionController,
	withBodyAdmission,
} from "../apps/server/src/body-admission";
import {
	cancelDiscardedResponseBody,
	drainBody,
} from "../packages/proxy/src/handlers/discard-body-cancel";
import {
	createRequestMetadata,
	makeProxyRequest,
	prepareRequestBody,
} from "../packages/proxy/src/handlers/request-handler";
import { proxyWithAccount } from "../packages/proxy/src/handlers/proxy-operations";
import type { ProxyContext } from "../packages/proxy/src/handlers/proxy-types";
import { RequestBodyContext } from "../packages/proxy/src/request-body-context";

type Mode = "finite" | "hanging";
type NumericRecord = Record<string, number>;

type LifecycleUpstreamCounts = {
	requests: number;
	completed: number;
	cancelled: number;
	aborted: number;
	pulls: number;
};

type Sample = {
	memory: NumericRecord;
	heapStats: NumericRecord;
};

type SampleDelta = {
	memory: NumericRecord;
	heapStats: NumericRecord;
};

type ResponseLifecycleResult = {
	upstream: LifecycleUpstreamCounts;
	bodyAdmission: ReturnType<BodyAdmissionController["snapshot"]>;
};

export type RequestBodyUpstreamState = {
	requests: number;
	receivedBodyBytes: number[];
	receivedModels: Array<string | null>;
	completed: number;
	cancelled: number;
	aborted: number;
	responseStream: {
		pulls: number;
		completed: number;
		cancelled: number;
		aborted: number;
	};
};

export type ProxyRequestBodyWorkloadResult = {
	bodyBytes: number;
	concurrency: number;
	generatedBodyBytes: number[];
	responses: Array<{ status: number; responseBytes: number }>;
	upstream: RequestBodyUpstreamState;
};

type WaveResult = {
	wave: number;
	before: Sample;
	peak: Sample;
	settled: Sample;
	deltas: {
		peakFromBefore: SampleDelta;
		settledFromBefore: SampleDelta;
	};
	requestBody: ProxyRequestBodyWorkloadResult;
	responseLifecycle: ResponseLifecycleResult;
};

type RequestBodyWorkloadOptions = {
	bodyBytes: number;
	concurrency: number;
	onSample?: () => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MEBIBYTE = 1024 * 1024;
const DEFAULT_PROXY_MEMORY_BODY_BYTES = 64 * 1024;
const DEFAULT_SOAK_PROXY_MEMORY_BODY_BYTES = 4 * MEBIBYTE;

// These are intentionally equal in UTF-8 byte length, so a provider model
// rewrite/rebuild preserves the configured body boundary observed upstream.
export const BODY_MODEL_BEFORE_TRANSFORM = "claude-memory-probe";
export const BODY_MODEL_AFTER_TRANSFORM = "bridge-memory-probe";

if (BODY_MODEL_BEFORE_TRANSFORM.length !== BODY_MODEL_AFTER_TRANSFORM.length) {
	throw new Error("memory harness model rewrite must preserve byte length");
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

const soak = process.env.PROXY_MEMORY_SOAK === "1";
const waves = positiveInteger("PROXY_MEMORY_WAVES", soak ? 50 : 3);
const concurrency = positiveInteger("PROXY_MEMORY_CONCURRENCY", 4);
const bodyBytes = positiveInteger(
	"PROXY_MEMORY_BODY_BYTES",
	soak ? DEFAULT_SOAK_PROXY_MEMORY_BODY_BYTES : DEFAULT_PROXY_MEMORY_BODY_BYTES,
);
// Keep the original flag as a compatibility alias while naming the response
// control precisely. It must never size the request-body workload.
const responseChunkBytes = positiveInteger(
	"PROXY_MEMORY_RESPONSE_CHUNK_BYTES",
	positiveInteger("PROXY_MEMORY_CHUNK_BYTES", 16 * 1024),
);
const discardDeadlineMs = positiveInteger("PROXY_MEMORY_DISCARD_DEADLINE_MS", 20);

function numericFields(value: unknown): NumericRecord {
	if (!value || typeof value !== "object") return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, field]) => typeof field === "number",
		),
	) as NumericRecord;
}

function sample(): Sample {
	return {
		memory: numericFields(process.memoryUsage()),
		heapStats: numericFields(heapStats()),
	};
}

function forceGc(): void {
	if (typeof Bun.gc === "function") Bun.gc(true);
}

async function settle(): Promise<Sample> {
	let previous = -1;
	let current = sample();
	for (let iteration = 0; iteration < 10; iteration += 1) {
		await Bun.sleep(0);
		forceGc();
		current = sample();
		if (
			previous >= 0 &&
			Math.abs(current.memory.heapUsed - previous) < 256 * 1024
		) {
			return current;
		}
		previous = current.memory.heapUsed;
	}
	return current;
}

function maxRecord(current: NumericRecord, next: NumericRecord): NumericRecord {
	return Object.fromEntries(
		new Set([...Object.keys(current), ...Object.keys(next)])
			.values()
			.map((key) => [key, Math.max(current[key] ?? 0, next[key] ?? 0)]),
	);
}

function maxSample(current: Sample, next: Sample): Sample {
	return {
		memory: maxRecord(current.memory, next.memory),
		heapStats: maxRecord(current.heapStats, next.heapStats),
	};
}

function subtractRecord(from: NumericRecord, to: NumericRecord): NumericRecord {
	return Object.fromEntries(
		new Set([...Object.keys(from), ...Object.keys(to)])
			.values()
			.map((key) => [key, (to[key] ?? 0) - (from[key] ?? 0)]),
	);
}

function sampleDelta(before: Sample, after: Sample): SampleDelta {
	return {
		memory: subtractRecord(before.memory, after.memory),
		heapStats: subtractRecord(before.heapStats, after.heapStats),
	};
}

/** Create an exact-size, Claude Messages-shaped JSON payload. */
export function createClaudeRequestBody(bodyBytes: number): ArrayBuffer {
	if (!Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) {
		throw new Error("bodyBytes must be a positive integer");
	}
	const body: {
		model: string;
		max_tokens: number;
		stream: boolean;
		metadata: { user_id: string };
		messages: Array<{ role: string; content: string }>;
	} = {
		model: BODY_MODEL_BEFORE_TRANSFORM,
		max_tokens: 1,
		stream: false,
		metadata: { user_id: "proxy-memory-harness" },
		messages: [{ role: "user", content: "" }],
	};
	const emptyBodyBytes = encoder.encode(JSON.stringify(body)).byteLength;
	const contentBytes = bodyBytes - emptyBodyBytes;
	if (contentBytes < 0) {
		throw new Error(
			`bodyBytes ${bodyBytes} is smaller than the Claude JSON envelope ${emptyBodyBytes}`,
		);
	}
	body.messages[0].content = "x".repeat(contentBytes);
	const bytes = encoder.encode(JSON.stringify(body));
	if (bytes.byteLength !== bodyBytes) {
		throw new Error(
			`Claude JSON body boundary mismatch: expected ${bodyBytes}, got ${bytes.byteLength}`,
		);
	}
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function snapshotRequestBodyUpstream(
	state: RequestBodyUpstreamState,
): RequestBodyUpstreamState {
	return {
		...state,
		receivedBodyBytes: [...state.receivedBodyBytes],
		receivedModels: [...state.receivedModels],
		responseStream: { ...state.responseStream },
	};
}

function startRequestBodyUpstream(): {
	url: string;
	state: RequestBodyUpstreamState;
	stop: () => void;
} {
	const state: RequestBodyUpstreamState = {
		requests: 0,
		receivedBodyBytes: [],
		receivedModels: [],
		completed: 0,
		cancelled: 0,
		aborted: 0,
		responseStream: {
			pulls: 0,
			completed: 0,
			cancelled: 0,
			aborted: 0,
		},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			state.requests += 1;
			request.signal.addEventListener(
				"abort",
				() => {
					state.aborted += 1;
				},
				{ once: true },
			);
			try {
				const received = new Uint8Array(await request.arrayBuffer());
				state.receivedBodyBytes.push(received.byteLength);
				const parsed = JSON.parse(decoder.decode(received)) as Record<
					string,
					unknown
				>;
				state.receivedModels.push(
					typeof parsed.model === "string" ? parsed.model : null,
				);
				state.completed += 1;
				// This success intentionally has no response body. Request-body workload
				// asserts zero response-stream lifecycle activity separately.
				return new Response(null, { status: 204 });
			} catch (error) {
				state.cancelled += 1;
				throw error;
			}
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1/messages`,
		state,
		stop: () => server.stop(true),
	};
}

function makeMemoryAccount(): Account {
	return {
		id: "memory-loopback-account",
		name: "memory-loopback",
		provider: "memory-loopback" as Account["provider"],
		api_key: "loopback-only",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		requires_reauth: false,
	};
}

/**
 * Rebuild the request after a model rewrite, mirroring real provider transforms
 * that materialize a cloned body before creating a fresh Request object.
 */
async function rewriteModelForLoopback(request: Request): Promise<Request> {
	const sourceBody = await request.clone().text();
	const body = JSON.parse(sourceBody) as Record<string, unknown>;
	if (body.model !== BODY_MODEL_BEFORE_TRANSFORM) {
		throw new Error(`unexpected source model ${String(body.model)}`);
	}
	body.model = BODY_MODEL_AFTER_TRANSFORM;
	const rebuiltBody = JSON.stringify(body);
	if (encoder.encode(rebuiltBody).byteLength !== encoder.encode(sourceBody).byteLength) {
		throw new Error("model rewrite changed the configured request-body boundary");
	}
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: rebuiltBody,
		signal: request.signal,
	});
}

function makeMemoryProxyContext(upstreamUrl: string): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: async () => ({
				consecutiveRateLimits: 0,
				applied: true,
			}),
			saveRequest: async () => undefined,
			updateAccountUsage: async () => undefined,
			getAdapter: () => ({
				run: async () => undefined,
				get: async () => null,
			}),
		} as never,
		runtime: { port: 0, clientId: "proxy-memory-harness" } as never,
		provider: {
			name: "memory-loopback",
			canHandle: (path: string) => path === "/v1/messages",
			buildUrl: () => upstreamUrl,
			prepareHeaders: (headers: Headers) => new Headers(headers),
			transformRequestBody: rewriteModelForLoopback,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({ isRateLimited: false }),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => undefined } as never,
		config: { getStorePayloads: () => false } as never,
		internalProbeSecret: "memory-loopback-secret",
	} as ProxyContext;
}

/**
 * Send exactly one transformed physical request per concurrent worker through
 * the proxy's body materialization and loopback fetch seam. It never wraps the
 * request in BodyAdmissionController or creates a response stream.
 */
export async function runProxyRequestBodyWorkload(
	options: RequestBodyWorkloadOptions,
): Promise<ProxyRequestBodyWorkloadResult> {
	const { bodyBytes, concurrency, onSample } = options;
	if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
		throw new Error("concurrency must be a positive integer");
	}
	const upstream = startRequestBodyUpstream();
	const account = makeMemoryAccount();
	const ctx = makeMemoryProxyContext(upstream.url);
	const generatedBodyBytes: number[] = [];
	try {
		const responses = await Promise.all(
			Array.from({ length: concurrency }, async () => {
				const generated = createClaudeRequestBody(bodyBytes);
				generatedBodyBytes.push(generated.byteLength);
				onSample?.();
				const request = new Request("http://proxy.memory.local/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-auto-refresh": "true",
						"x-better-ccflare-internal-probe-secret": "memory-loopback-secret",
					},
					body: generated,
				});
				// Materialize the actual inbound Request before the provider-level path
				// builds, clones, rewrites, and fetches its outbound Request.
				const prepared = await prepareRequestBody(request);
				if (!prepared.buffer || prepared.buffer.byteLength !== bodyBytes) {
					throw new Error("prepared request body did not preserve its boundary");
				}
				onSample?.();
				const requestUrl = new URL(request.url);
				const response = await proxyWithAccount(
					request,
					requestUrl,
					account,
					createRequestMetadata(request, requestUrl),
					prepared.buffer,
					prepared.createStream,
					0,
					ctx,
					undefined,
					undefined,
					undefined,
					new RequestBodyContext(prepared.buffer),
				);
				if (!response) {
					throw new Error(
						`loopback proxy request did not return a response: ${JSON.stringify(snapshotRequestBodyUpstream(upstream.state))}`,
					);
				}
				const responseText = await response.text();
				onSample?.();
				return {
					status: response.status,
					responseBytes: encoder.encode(responseText).byteLength,
				};
			}),
		);
		const snapshot = snapshotRequestBodyUpstream(upstream.state);
		if (
			snapshot.requests !== concurrency ||
			snapshot.completed !== concurrency ||
			snapshot.cancelled !== 0 ||
			snapshot.aborted !== 0
		) {
			throw new Error(
				`loopback request-body lifecycle mismatch: ${JSON.stringify(snapshot)}`,
			);
		}
		return {
			bodyBytes,
			concurrency,
			generatedBodyBytes,
			responses,
			upstream: snapshot,
		};
	} finally {
		upstream.stop();
	}
}

function startLifecycleUpstream(responseBytes: number): {
	url: (mode: Mode) => string;
	counts: LifecycleUpstreamCounts;
	stop: () => void;
} {
	const counts: LifecycleUpstreamCounts = {
		requests: 0,
		completed: 0,
		cancelled: 0,
		aborted: 0,
		pulls: 0,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			counts.requests += 1;
			request.signal.addEventListener(
				"abort",
				() => {
					counts.aborted += 1;
				},
				{ once: true },
			);
			const mode = new URL(request.url).pathname.slice(1) as Mode;
			let sent = false;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						counts.pulls += 1;
						if (sent) return;
						sent = true;
						controller.enqueue(encoder.encode("x".repeat(responseBytes)));
						if (mode === "finite") {
							counts.completed += 1;
							controller.close();
						}
					},
					cancel() {
						counts.cancelled += 1;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return {
		url: (mode) => `http://127.0.0.1:${server.port}/${mode}`,
		counts,
		stop: () => server.stop(true),
	};
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("upstream did not reach a terminal state");
}

async function readOne(response: Response): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("expected response stream");
	await reader.read();
	reader.releaseLock();
}

async function runResponseLifecycleModes(
	onSample: () => void,
): Promise<ResponseLifecycleResult> {
	const upstream = startLifecycleUpstream(responseChunkBytes);
	const admission = new BodyAdmissionController({ budgetBytes: 1024 * 1024 });
	try {
		// This one-byte input is only the pre-existing response-ownership control;
		// it is deliberately isolated from the configured requestBody workload above.
		await Promise.all(
			Array.from({ length: concurrency }, async () => {
				const response = await withBodyAdmission(
					new Request(upstream.url("finite"), {
						method: "POST",
						body: "x",
						headers: { "content-length": "1" },
					}),
					admission,
					async () =>
						makeProxyRequest(upstream.url("finite"), "POST", new Headers()),
				);
				await response.text();
				onSample();
			}),
		);

		// Client abort after headers: the caller owns the transport cancellation.
		const clientAbort = new AbortController();
		const aborted = await makeProxyRequest(
			upstream.url("hanging"),
			"POST",
			new Headers(),
			undefined,
			false,
			clientAbort.signal,
		);
		await readOne(aborted);
		clientAbort.abort();
		await eventually(() => upstream.counts.aborted + upstream.counts.cancelled >= 1);
		onSample();

		// A finite discarded response is drained chunk-by-chunk, not materialized.
		const finiteDiscard = await makeProxyRequest(
			upstream.url("finite"),
			"POST",
			new Headers(),
		);
		if (!finiteDiscard.body) throw new Error("expected finite discard body");
		await drainBody(finiteDiscard.body);
		onSample();

		// The bounded discard deadline owns just this hanging fetch's transport.
		const hangingDiscard = await makeProxyRequest(
			upstream.url("hanging"),
			"POST",
			new Headers(),
		);
		await readOne(hangingDiscard);
		const disconnects = upstream.counts.aborted + upstream.counts.cancelled;
		cancelDiscardedResponseBody(hangingDiscard, { deadlineMs: discardDeadlineMs });
		await eventually(
			() => upstream.counts.aborted + upstream.counts.cancelled > disconnects,
		);
		onSample();

		// Successful lazy retry-not-taken characterization: exactly one request
		// occurs when no retry-triggering failure is observed.
		const beforeSuccess = upstream.counts.requests;
		const success = await makeProxyRequest(
			upstream.url("finite"),
			"POST",
			new Headers(),
		);
		await success.text();
		if (upstream.counts.requests !== beforeSuccess + 1) {
			throw new Error("success unexpectedly retried");
		}
		onSample();

		return {
			upstream: { ...upstream.counts },
			bodyAdmission: admission.snapshot(),
		};
	} finally {
		upstream.stop();
	}
}

async function runWave(wave: number): Promise<WaveResult> {
	const before = await settle();
	let peak = before;
	const observePeak = () => {
		peak = maxSample(peak, sample());
	};
	const requestBody = await runProxyRequestBodyWorkload({
		bodyBytes,
		concurrency,
		onSample: observePeak,
	});
	observePeak();
	const responseLifecycle = await runResponseLifecycleModes(observePeak);
	observePeak();
	const settled = await settle();
	return {
		wave,
		before,
		peak,
		settled,
		deltas: {
			peakFromBefore: sampleDelta(before, peak),
			settledFromBefore: sampleDelta(before, settled),
		},
		requestBody,
		responseLifecycle,
	};
}

function formatMebibytes(bytes: number | undefined): string {
	return ((bytes ?? 0) / MEBIBYTE).toFixed(1);
}

function printTable(results: WaveResult[]): void {
	const headers = [
		"wave",
		"body MiB",
		"conc",
		"peak Δ heap MiB",
		"settled Δ heap MiB",
		"peak Δ RSS MiB",
		"physical success",
		"response c/c/a",
		"leases",
	];
	const rows = results.map((result) => [
		String(result.wave),
		formatMebibytes(result.requestBody.bodyBytes),
		String(result.requestBody.concurrency),
		formatMebibytes(result.deltas.peakFromBefore.memory.heapUsed),
		formatMebibytes(result.deltas.settledFromBefore.memory.heapUsed),
		formatMebibytes(result.deltas.peakFromBefore.memory.rss),
		`${result.requestBody.upstream.completed}/${result.requestBody.upstream.requests}`,
		`${result.responseLifecycle.upstream.completed}/${result.responseLifecycle.upstream.cancelled}/${result.responseLifecycle.upstream.aborted}`,
		`${result.responseLifecycle.bodyAdmission.activeLeases}/${result.responseLifecycle.bodyAdmission.counters.released}`,
	]);
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index].length)),
	);
	const format = (cells: string[]) =>
		cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
	console.log(format(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(format(row));
}

async function main(): Promise<void> {
	console.log(
		JSON.stringify({
			bun: Bun.version,
			platform: `${process.platform}/${process.arch}`,
			parameters: {
				waves,
				concurrency,
				bodyBytes,
				responseChunkBytes,
				discardDeadlineMs,
				soak,
			},
			modes: [
				"request-body-materialize-transform-loopback",
				"full-drain",
				"client-abort",
				"finite-discard-drain",
				"hanging-discard-deadline",
				"lazy-retry-not-taken",
			],
		}),
	);
	const results: WaveResult[] = [];
	for (let wave = 1; wave <= waves; wave += 1) results.push(await runWave(wave));
	console.log(JSON.stringify({ results }, null, 2));
	printTable(results);
}

if (import.meta.main) {
	main()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error("proxy request memory harness crashed:", error);
			process.exit(1);
		});
}
