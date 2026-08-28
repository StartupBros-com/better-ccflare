#!/usr/bin/env bun
/**
 * Informational lifecycle-and-memory harness for proxy request bodies.
 *
 * The configurable body workload runs through prepareRequestBody(),
 * RequestBodyContext, a configurable fake provider transform, and real loopback
 * Bun HTTP/fetch. Request decoding and validation run in a separate Bun child,
 * so parent process samples exclude the validating server's memory. Response-
 * lifecycle controls stay separate so response chunk bytes cannot masquerade
 * as request-body allocation work. No external accounts or global fetch mocks
 * are used.
 *
 * Run:
 *   bun bench/proxy-request-memory-harness.ts
 *   PROXY_MEMORY_BODY_BYTES=1048576 PROXY_MEMORY_CONCURRENCY=1 bun bench/proxy-request-memory-harness.ts
 *   PROXY_MEMORY_TRANSFORM_MODE=passthrough bun bench/proxy-request-memory-harness.ts
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
import { proxyWithAccount } from "../packages/proxy/src/handlers/proxy-operations";
import type { ProxyContext } from "../packages/proxy/src/handlers/proxy-types";
import {
	createRequestMetadata,
	makeProxyRequest,
	prepareRequestBody,
} from "../packages/proxy/src/handlers/request-handler";
import { RequestBodyContext } from "../packages/proxy/src/request-body-context";
import type {
	RequestBodyUpstreamReadyMessage,
	RequestBodyUpstreamState,
} from "./fixtures/proxy-request-memory-upstream";
import {
	REQUEST_BODY_UPSTREAM_PATH,
	REQUEST_BODY_UPSTREAM_READY_TYPE,
	REQUEST_BODY_UPSTREAM_STATS_PATH,
} from "./fixtures/proxy-request-memory-upstream";

export type { RequestBodyUpstreamState } from "./fixtures/proxy-request-memory-upstream";

type Mode = "finite" | "hanging";
type NumericRecord = Record<string, number>;

export type ProxyMemoryTransformMode =
	| "passthrough"
	| "clone-rewrite"
	| "consume-rebuild";

type RequestBodyPhaseName =
	| "pre-body-baseline"
	| "exact-size-body-generated"
	| "inbound-request-constructed"
	| "prepare-request-body-complete"
	| "request-body-context-constructed"
	| "request-body-context-parsed"
	| "provider-before-transform"
	| "provider-passthrough-return"
	| "provider-clone-text-read"
	| "provider-source-text-read"
	| "provider-json-parsed"
	| "provider-stringify-request-rebuilt"
	| "loopback-response-received"
	| "proxy-with-account-complete"
	| "response-consumed"
	| "post-gc-settled";

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

export type RequestBodyPhaseSample = {
	name: RequestBodyPhaseName;
	observationCount: number;
	absolute: Sample;
	deltaFromWaveBaseline: SampleDelta;
	rssArithmeticRemainder: {
		absolute: number;
		deltaFromWaveBaseline: number;
	};
};

type ResponseLifecycleResult = {
	upstream: LifecycleUpstreamCounts;
	bodyAdmission: ReturnType<BodyAdmissionController["snapshot"]>;
};

export type RequestBodyUpstreamProcessState = {
	pid: number;
	ready: boolean;
	statsFetched: boolean;
	terminationRequested: boolean;
	exited: boolean;
	exitCode: number;
};

export type ProxyRequestBodyWorkloadResult = {
	bun: string;
	platform: string;
	bodyBytes: number;
	concurrency: number;
	transformMode: ProxyMemoryTransformMode;
	expectedModel: string;
	memoryAccounting: {
		rssArithmeticRemainder: string;
		arrayBuffers: string;
		phaseDeltas: string;
		childIsolation: string;
	};
	phases: RequestBodyPhaseSample[];
	generatedBodyBytes: number[];
	responses: Array<{ status: number; responseBytes: number }>;
	upstream: RequestBodyUpstreamState;
	upstreamProcess: RequestBodyUpstreamProcessState;
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
	transformMode?: ProxyMemoryTransformMode;
	onSample?: (observed: Sample) => void;
};

const encoder = new TextEncoder();
const MEBIBYTE = 1024 * 1024;
const DEFAULT_PROXY_MEMORY_BODY_BYTES = 64 * 1024;
const DEFAULT_SOAK_PROXY_MEMORY_BODY_BYTES = 4 * MEBIBYTE;
const CHILD_STARTUP_TIMEOUT_MS = 5_000;
const CHILD_STATS_TIMEOUT_MS = 5_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
const CHILD_STDERR_TIMEOUT_MS = 1_000;
const REQUEST_BODY_UPSTREAM_FIXTURE = `${import.meta.dir}/fixtures/proxy-request-memory-upstream.ts`;
const PROXY_MEMORY_TRANSFORM_MODES: readonly ProxyMemoryTransformMode[] = [
	"passthrough",
	"clone-rewrite",
	"consume-rebuild",
];

// These are intentionally equal in UTF-8 byte length, so a provider model
// rewrite/rebuild preserves the configured body boundary observed upstream.
export const BODY_MODEL_BEFORE_TRANSFORM = "claude-memory-probe";
export const BODY_MODEL_AFTER_TRANSFORM = "bridge-memory-probe";

const CLONE_REWRITE_PHASE_ORDER: readonly RequestBodyPhaseName[] = [
	"pre-body-baseline",
	"exact-size-body-generated",
	"inbound-request-constructed",
	"prepare-request-body-complete",
	"request-body-context-constructed",
	"request-body-context-parsed",
	"provider-before-transform",
	"provider-clone-text-read",
	"provider-json-parsed",
	"provider-stringify-request-rebuilt",
	"loopback-response-received",
	"proxy-with-account-complete",
	"response-consumed",
	"post-gc-settled",
];

const PASSTHROUGH_PHASE_ORDER: readonly RequestBodyPhaseName[] = [
	"pre-body-baseline",
	"exact-size-body-generated",
	"inbound-request-constructed",
	"prepare-request-body-complete",
	"request-body-context-constructed",
	"request-body-context-parsed",
	"provider-before-transform",
	"provider-passthrough-return",
	"loopback-response-received",
	"proxy-with-account-complete",
	"response-consumed",
	"post-gc-settled",
];

const CONSUME_REBUILD_PHASE_ORDER: readonly RequestBodyPhaseName[] = [
	"pre-body-baseline",
	"exact-size-body-generated",
	"inbound-request-constructed",
	"prepare-request-body-complete",
	"request-body-context-constructed",
	"request-body-context-parsed",
	"provider-before-transform",
	"provider-source-text-read",
	"provider-json-parsed",
	"provider-stringify-request-rebuilt",
	"loopback-response-received",
	"proxy-with-account-complete",
	"response-consumed",
	"post-gc-settled",
];

const MEMORY_ACCOUNTING_NOTES = {
	rssArithmeticRemainder:
		"rss - heapTotal - external; arithmetic accounting remainder only, not native memory or a root-cause attribution",
	arrayBuffers:
		"arrayBuffers is a subset of external and is reported separately, never added to external",
	phaseDeltas:
		"each phase delta is relative to its wave baseline; phase deltas are not additive",
	childIsolation:
		"process.memoryUsage() and heapStats() sample only the parent harness; request-body decoding and validation run in a separate child process, so child process memory is excluded",
} as const;

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

function isProxyMemoryTransformMode(
	value: unknown,
): value is ProxyMemoryTransformMode {
	return PROXY_MEMORY_TRANSFORM_MODES.includes(
		value as ProxyMemoryTransformMode,
	);
}

function configuredTransformMode(): ProxyMemoryTransformMode {
	const value = process.env.PROXY_MEMORY_TRANSFORM_MODE ?? "clone-rewrite";
	if (!isProxyMemoryTransformMode(value)) {
		throw new Error(
			`PROXY_MEMORY_TRANSFORM_MODE must be one of ${PROXY_MEMORY_TRANSFORM_MODES.join(", ")}; got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

function expectedModelForMode(mode: ProxyMemoryTransformMode): string {
	return mode === "passthrough"
		? BODY_MODEL_BEFORE_TRANSFORM
		: BODY_MODEL_AFTER_TRANSFORM;
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
const discardDeadlineMs = positiveInteger(
	"PROXY_MEMORY_DISCARD_DEADLINE_MS",
	20,
);
const transformMode = configuredTransformMode();

function numericFields(value: unknown): NumericRecord {
	if (!value || typeof value !== "object") return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(
			([, field]) => typeof field === "number" && Number.isFinite(field),
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

function rssArithmeticRemainder(observed: Sample): number {
	return (
		(observed.memory.rss ?? 0) -
		(observed.memory.heapTotal ?? 0) -
		(observed.memory.external ?? 0)
	);
}

type PhaseAccumulator = {
	observationCount: number;
	representative: Sample;
};

function createPhaseRecorder(
	baseline: Sample,
	phaseOrder: readonly RequestBodyPhaseName[],
	onSample: ((observed: Sample) => void) | undefined,
): {
	record: (name: RequestBodyPhaseName, observed?: Sample) => void;
	finish: () => RequestBodyPhaseSample[];
} {
	const accumulated = new Map<RequestBodyPhaseName, PhaseAccumulator>();
	const allowedPhases = new Set(phaseOrder);
	const record = (name: RequestBodyPhaseName, observed = sample()) => {
		if (!allowedPhases.has(name)) {
			throw new Error(`unexpected memory phase for transform mode: ${name}`);
		}
		onSample?.(observed);
		const existing = accumulated.get(name);
		if (!existing) {
			accumulated.set(name, {
				observationCount: 1,
				representative: observed,
			});
			return;
		}
		existing.observationCount += 1;
		// Keep one coherent, actually observed sample. Fieldwise maxima remain in
		// WaveResult.peak; a synthetic per-field maximum would not describe any
		// real phase observation.
		if (
			(observed.memory.rss ?? 0) > (existing.representative.memory.rss ?? 0)
		) {
			existing.representative = observed;
		}
	};
	return {
		record,
		finish: () =>
			phaseOrder.map((name) => {
				const phase = accumulated.get(name);
				if (!phase) throw new Error(`memory phase was not observed: ${name}`);
				const absoluteRemainder = rssArithmeticRemainder(phase.representative);
				return {
					name,
					observationCount: phase.observationCount,
					absolute: phase.representative,
					deltaFromWaveBaseline: sampleDelta(baseline, phase.representative),
					rssArithmeticRemainder: {
						absolute: absoluteRemainder,
						deltaFromWaveBaseline:
							absoluteRemainder - rssArithmeticRemainder(baseline),
					},
				};
			}),
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

type RequestBodyUpstreamChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

type MutableRequestBodyUpstreamProcessState = Omit<
	RequestBodyUpstreamProcessState,
	"exitCode"
> & {
	exitCode: number | null;
};

type ManagedRequestBodyUpstream = {
	url: string;
	pid: number;
	fetchStats: () => Promise<RequestBodyUpstreamState>;
	stop: () => Promise<RequestBodyUpstreamProcessState>;
};

async function withDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number,
	description: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([operation, deadline]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function errorDescription(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}

async function readRequestBodyUpstreamReady(
	stdout: ReadableStream<Uint8Array>,
): Promise<RequestBodyUpstreamReadyMessage> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (buffered.length <= 4_096) {
			const { done, value } = await reader.read();
			if (done) {
				throw new Error("child stdout closed before its ready message");
			}
			buffered += decoder.decode(value, { stream: true });
			const newline = buffered.indexOf("\n");
			if (newline < 0) continue;
			const parsed = JSON.parse(
				buffered.slice(0, newline),
			) as Partial<RequestBodyUpstreamReadyMessage>;
			if (
				parsed.type !== REQUEST_BODY_UPSTREAM_READY_TYPE ||
				!Number.isSafeInteger(parsed.port) ||
				(parsed.port ?? 0) <= 0 ||
				(parsed.port ?? 0) > 65_535
			) {
				throw new Error("child emitted an invalid ready message");
			}
			return parsed as RequestBodyUpstreamReadyMessage;
		}
		throw new Error("child ready message exceeded 4096 bytes");
	} finally {
		reader.releaseLock();
	}
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseRequestBodyUpstreamState(
	value: unknown,
): RequestBodyUpstreamState {
	if (!value || typeof value !== "object") {
		throw new Error("child stats response was not an object");
	}
	const stats = value as Record<string, unknown>;
	const responseStream = stats.responseStream;
	if (
		!Array.isArray(stats.receivedBodyBytes) ||
		!stats.receivedBodyBytes.every(isNonNegativeInteger) ||
		!Array.isArray(stats.receivedModels) ||
		!stats.receivedModels.every(
			(model) => typeof model === "string" || model === null,
		) ||
		!isNonNegativeInteger(stats.requests) ||
		!isNonNegativeInteger(stats.completed) ||
		!isNonNegativeInteger(stats.cancelled) ||
		!isNonNegativeInteger(stats.aborted) ||
		!responseStream ||
		typeof responseStream !== "object"
	) {
		throw new Error("child stats response had an invalid shape");
	}
	const stream = responseStream as Record<string, unknown>;
	if (
		!isNonNegativeInteger(stream.pulls) ||
		!isNonNegativeInteger(stream.completed) ||
		!isNonNegativeInteger(stream.cancelled) ||
		!isNonNegativeInteger(stream.aborted)
	) {
		throw new Error("child response lifecycle stats had an invalid shape");
	}
	return {
		requests: stats.requests,
		receivedBodyBytes: [...stats.receivedBodyBytes],
		receivedModels: [...stats.receivedModels],
		completed: stats.completed,
		cancelled: stats.cancelled,
		aborted: stats.aborted,
		responseStream: {
			pulls: stream.pulls,
			completed: stream.completed,
			cancelled: stream.cancelled,
			aborted: stream.aborted,
		},
	};
}

async function terminateRequestBodyUpstream(
	child: RequestBodyUpstreamChild,
	stderrPromise: Promise<string>,
	lifecycle: MutableRequestBodyUpstreamProcessState,
): Promise<RequestBodyUpstreamProcessState> {
	const exitedBeforeTermination = child.exitCode !== null;
	lifecycle.terminationRequested = true;
	let gracefulShutdownError: unknown;
	if (!exitedBeforeTermination) {
		child.kill("SIGTERM");
	}
	let exitCode: number;
	try {
		exitCode = await withDeadline(
			child.exited,
			CHILD_SHUTDOWN_TIMEOUT_MS,
			`request-body upstream child ${child.pid} shutdown`,
		);
	} catch (error) {
		gracefulShutdownError = error;
		if (child.exitCode === null) child.kill("SIGKILL");
		exitCode = await withDeadline(
			child.exited,
			CHILD_SHUTDOWN_TIMEOUT_MS,
			`request-body upstream child ${child.pid} forced shutdown`,
		);
	}
	lifecycle.exited = true;
	lifecycle.exitCode = exitCode;
	const stderr = await withDeadline(
		stderrPromise,
		CHILD_STDERR_TIMEOUT_MS,
		`request-body upstream child ${child.pid} stderr close`,
	);
	if (
		exitedBeforeTermination ||
		gracefulShutdownError !== undefined ||
		exitCode !== 0 ||
		stderr.trim().length > 0
	) {
		const details = [
			exitedBeforeTermination ? "child exited before parent termination" : null,
			gracefulShutdownError === undefined
				? null
				: errorDescription(gracefulShutdownError),
			`exitCode=${exitCode}`,
			stderr.trim() ? `stderr=${stderr.trim()}` : null,
		].filter((detail): detail is string => detail !== null);
		throw new Error(
			`request-body upstream child ${child.pid} failed: ${details.join("; ")}`,
		);
	}
	return {
		pid: lifecycle.pid,
		ready: lifecycle.ready,
		statsFetched: lifecycle.statsFetched,
		terminationRequested: lifecycle.terminationRequested,
		exited: lifecycle.exited,
		exitCode,
	};
}

async function startRequestBodyUpstream(options: {
	bodyBytes: number;
	expectedModel: string;
}): Promise<ManagedRequestBodyUpstream> {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			REQUEST_BODY_UPSTREAM_FIXTURE,
			String(options.bodyBytes),
			options.expectedModel,
		],
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderrPromise = new Response(child.stderr).text();
	const lifecycle: MutableRequestBodyUpstreamProcessState = {
		pid: child.pid,
		ready: false,
		statsFetched: false,
		terminationRequested: false,
		exited: false,
		exitCode: null,
	};
	let stopPromise: Promise<RequestBodyUpstreamProcessState> | undefined;
	const stop = (): Promise<RequestBodyUpstreamProcessState> => {
		stopPromise ??= terminateRequestBodyUpstream(
			child,
			stderrPromise,
			lifecycle,
		);
		return stopPromise;
	};

	let ready: RequestBodyUpstreamReadyMessage;
	try {
		const startup = await withDeadline(
			Promise.race([
				readRequestBodyUpstreamReady(child.stdout).then((message) => ({
					kind: "ready" as const,
					message,
				})),
				child.exited.then((exitCode) => ({
					kind: "exit" as const,
					exitCode,
				})),
			]),
			CHILD_STARTUP_TIMEOUT_MS,
			`request-body upstream child ${child.pid} startup`,
		);
		if (startup.kind === "exit") {
			throw new Error(
				`request-body upstream child ${child.pid} exited during startup with code ${startup.exitCode}`,
			);
		}
		ready = startup.message;
		lifecycle.ready = true;
	} catch (startupError) {
		try {
			await stop();
		} catch (cleanupError) {
			throw new AggregateError(
				[startupError, cleanupError],
				`request-body upstream child ${child.pid} failed to start and clean up`,
			);
		}
		throw startupError;
	}

	const origin = `http://127.0.0.1:${ready.port}`;
	return {
		url: `${origin}${REQUEST_BODY_UPSTREAM_PATH}`,
		pid: child.pid,
		async fetchStats() {
			if (child.exitCode !== null) {
				throw new Error(
					`request-body upstream child ${child.pid} exited before stats collection with code ${child.exitCode}`,
				);
			}
			const abort = new AbortController();
			try {
				const rawStats = await withDeadline(
					(async () => {
						const response = await fetch(
							`${origin}${REQUEST_BODY_UPSTREAM_STATS_PATH}`,
							{ signal: abort.signal },
						);
						if (!response.ok) {
							throw new Error(
								`child stats endpoint returned HTTP ${response.status}`,
							);
						}
						return response.json();
					})(),
					CHILD_STATS_TIMEOUT_MS,
					`request-body upstream child ${child.pid} stats collection`,
				);
				const stats = parseRequestBodyUpstreamState(rawStats);
				lifecycle.statsFetched = true;
				return stats;
			} finally {
				abort.abort();
			}
		},
		stop,
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
async function transformForLoopbackWithPhases(
	request: Request,
	transformMode: ProxyMemoryTransformMode,
	recordPhase: (name: RequestBodyPhaseName) => void,
): Promise<Request> {
	recordPhase("provider-before-transform");
	if (transformMode === "passthrough") {
		recordPhase("provider-passthrough-return");
		return request;
	}
	const sourceBody =
		transformMode === "consume-rebuild"
			? await request.text()
			: await request.clone().text();
	recordPhase(
		transformMode === "consume-rebuild"
			? "provider-source-text-read"
			: "provider-clone-text-read",
	);
	const body = JSON.parse(sourceBody) as Record<string, unknown>;
	recordPhase("provider-json-parsed");
	if (body.model !== BODY_MODEL_BEFORE_TRANSFORM) {
		throw new Error(`unexpected source model ${String(body.model)}`);
	}
	body.model = BODY_MODEL_AFTER_TRANSFORM;
	const rebuiltBody = JSON.stringify(body);
	if (
		Buffer.byteLength(rebuiltBody, "utf8") !==
		Buffer.byteLength(sourceBody, "utf8")
	) {
		throw new Error(
			"model rewrite changed the configured request-body boundary",
		);
	}
	const rebuilt = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: rebuiltBody,
		signal: request.signal,
	});
	recordPhase("provider-stringify-request-rebuilt");
	return rebuilt;
}

function makeMemoryProxyContext(
	upstreamUrl: string,
	transformMode: ProxyMemoryTransformMode,
	recordPhase: (name: RequestBodyPhaseName) => void,
): ProxyContext {
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
			transformRequestBody: (request: Request) =>
				transformForLoopbackWithPhases(request, transformMode, recordPhase),
			processResponse: async (response: Response) => {
				// The body was decoded and validated before this bodyless response was
				// sent, but that work happened entirely in the isolated child process.
				recordPhase("loopback-response-received");
				return response;
			},
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
	const {
		bodyBytes,
		concurrency,
		onSample,
		transformMode = "clone-rewrite",
	} = options;
	if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
		throw new Error("concurrency must be a positive integer");
	}
	if (!isProxyMemoryTransformMode(transformMode)) {
		throw new Error(
			`unsupported proxy memory transform mode: ${transformMode}`,
		);
	}
	const expectedModel = expectedModelForMode(transformMode);
	const upstream = await startRequestBodyUpstream({
		bodyBytes,
		expectedModel,
	});
	const generatedBodyBytes: number[] = [];
	let phaseRecorder: ReturnType<typeof createPhaseRecorder> | undefined;
	let responses: Array<{ status: number; responseBytes: number }> | undefined;
	let snapshot: RequestBodyUpstreamState | undefined;
	let upstreamProcess: RequestBodyUpstreamProcessState | undefined;
	let workloadFailed = false;
	let workloadError: unknown;
	let cleanupFailed = false;
	let cleanupError: unknown;
	try {
		// Establish the baseline only after the child has reached its explicit
		// ready state. Child RSS is never part of process.memoryUsage(), and the
		// parent's small subprocess bookkeeping is now present in every phase.
		const baseline = await settle();
		phaseRecorder = createPhaseRecorder(
			baseline,
			transformMode === "passthrough"
				? PASSTHROUGH_PHASE_ORDER
				: transformMode === "consume-rebuild"
					? CONSUME_REBUILD_PHASE_ORDER
					: CLONE_REWRITE_PHASE_ORDER,
			onSample,
		);
		phaseRecorder.record("pre-body-baseline", baseline);
		const account = makeMemoryAccount();
		const ctx = makeMemoryProxyContext(
			upstream.url,
			transformMode,
			phaseRecorder.record,
		);
		responses = await Promise.all(
			Array.from({ length: concurrency }, async () => {
				const generated = createClaudeRequestBody(bodyBytes);
				generatedBodyBytes.push(generated.byteLength);
				phaseRecorder.record("exact-size-body-generated");
				const request = new Request("http://proxy.memory.local/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-better-ccflare-auto-refresh": "true",
						"x-better-ccflare-internal-probe-secret": "memory-loopback-secret",
					},
					body: generated,
				});
				phaseRecorder.record("inbound-request-constructed");
				// Materialize the actual inbound Request before the provider-level path
				// builds, clones, rewrites, and fetches its outbound Request.
				const prepared = await prepareRequestBody(request);
				if (!prepared.buffer || prepared.buffer.byteLength !== bodyBytes) {
					throw new Error(
						"prepared request body did not preserve its boundary",
					);
				}
				phaseRecorder.record("prepare-request-body-complete");
				const bodyContext = new RequestBodyContext(prepared.buffer);
				phaseRecorder.record("request-body-context-constructed");
				const parsedBody = bodyContext.getParsedJson();
				if (
					!parsedBody ||
					bodyContext.getModel() !== BODY_MODEL_BEFORE_TRANSFORM
				) {
					throw new Error(
						"request body context did not parse the source model",
					);
				}
				phaseRecorder.record("request-body-context-parsed");
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
					bodyContext,
				);
				phaseRecorder.record("proxy-with-account-complete");
				if (!response) {
					throw new Error(
						`isolated loopback proxy request did not return a response (child pid ${upstream.pid})`,
					);
				}
				const responseText = await response.text();
				phaseRecorder.record("response-consumed");
				return {
					status: response.status,
					responseBytes: encoder.encode(responseText).byteLength,
				};
			}),
		);
		snapshot = await upstream.fetchStats();
		if (
			snapshot.requests !== concurrency ||
			snapshot.receivedBodyBytes.length !== concurrency ||
			snapshot.receivedBodyBytes.some(
				(receivedBytes) => receivedBytes !== bodyBytes,
			) ||
			snapshot.receivedModels.length !== concurrency ||
			snapshot.receivedModels.some(
				(receivedModel) => receivedModel !== expectedModel,
			) ||
			snapshot.completed !== concurrency ||
			snapshot.cancelled !== 0 ||
			snapshot.aborted !== 0 ||
			responses.length !== concurrency ||
			responses.some(
				(response) => response.status !== 204 || response.responseBytes !== 0,
			)
		) {
			throw new Error(
				`isolated loopback request-body oracle mismatch: ${JSON.stringify({ responses, upstream: snapshot })}`,
			);
		}
		phaseRecorder.record("post-gc-settled", await settle());
	} catch (error) {
		workloadFailed = true;
		workloadError = error;
	} finally {
		try {
			upstreamProcess = await upstream.stop();
		} catch (error) {
			cleanupFailed = true;
			cleanupError = error;
		}
	}
	if (workloadFailed) {
		if (cleanupFailed) {
			throw new AggregateError(
				[workloadError, cleanupError],
				`request-body workload and isolated child cleanup both failed (child pid ${upstream.pid})`,
			);
		}
		throw workloadError;
	}
	if (cleanupFailed) throw cleanupError;
	if (!phaseRecorder || !responses || !snapshot || !upstreamProcess) {
		throw new Error("request-body workload completed without terminal state");
	}
	return {
		bun: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		bodyBytes,
		concurrency,
		transformMode,
		expectedModel,
		memoryAccounting: { ...MEMORY_ACCOUNTING_NOTES },
		phases: phaseRecorder.finish(),
		generatedBodyBytes,
		responses,
		upstream: snapshot,
		upstreamProcess,
	};
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
		await eventually(
			() => upstream.counts.aborted + upstream.counts.cancelled >= 1,
		);
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
		cancelDiscardedResponseBody(hangingDiscard, {
			deadlineMs: discardDeadlineMs,
		});
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
	let before: Sample | undefined;
	let peak: Sample | undefined;
	const observePeak = (observed?: Sample) => {
		const current = observed ?? sample();
		before ??= current;
		peak = peak ? maxSample(peak, current) : current;
	};
	const requestBody = await runProxyRequestBodyWorkload({
		bodyBytes,
		concurrency,
		transformMode,
		onSample: observePeak,
	});
	if (!before || !peak) {
		throw new Error("request-body workload produced no memory samples");
	}
	const waveBefore = before;
	observePeak();
	const responseLifecycle = await runResponseLifecycleModes(observePeak);
	observePeak();
	const settled = await settle();
	if (!peak) throw new Error("memory peak was not observed");
	return {
		wave,
		before: waveBefore,
		peak,
		settled,
		deltas: {
			peakFromBefore: sampleDelta(waveBefore, peak),
			settledFromBefore: sampleDelta(waveBefore, settled),
		},
		requestBody,
		responseLifecycle,
	};
}

function formatMebibytes(bytes: number | undefined): string {
	return ((bytes ?? 0) / MEBIBYTE).toFixed(1);
}

function formatSignedMebibytes(bytes: number | undefined): string {
	const value = (bytes ?? 0) / MEBIBYTE;
	return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function renderTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index].length)),
	);
	const format = (cells: string[]) =>
		cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
	console.log(format(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(format(row));
}

function printTable(results: WaveResult[]): void {
	const headers = [
		"wave",
		"mode",
		"body MiB",
		"conc",
		"peak Δ heap MiB",
		"settled Δ heap MiB",
		"peak Δ RSS MiB",
		"settled Δ RSS MiB",
		"physical success",
		"response c/c/a",
		"leases",
	];
	const rows = results.map((result) => [
		String(result.wave),
		result.requestBody.transformMode,
		formatMebibytes(result.requestBody.bodyBytes),
		String(result.requestBody.concurrency),
		formatMebibytes(result.deltas.peakFromBefore.memory.heapUsed),
		formatMebibytes(result.deltas.settledFromBefore.memory.heapUsed),
		formatMebibytes(result.deltas.peakFromBefore.memory.rss),
		formatMebibytes(result.deltas.settledFromBefore.memory.rss),
		`${result.requestBody.upstream.completed}/${result.requestBody.upstream.requests}`,
		`${result.responseLifecycle.upstream.completed}/${result.responseLifecycle.upstream.cancelled}/${result.responseLifecycle.upstream.aborted}`,
		`${result.responseLifecycle.bodyAdmission.activeLeases}/${result.responseLifecycle.bodyAdmission.counters.released}`,
	]);
	renderTable(headers, rows);
}

function printPhaseJson(results: WaveResult[]): void {
	for (const result of results) {
		for (const phase of result.requestBody.phases) {
			console.log(
				JSON.stringify({
					type: "proxy-request-memory-phase",
					wave: result.wave,
					bun: result.requestBody.bun,
					platform: result.requestBody.platform,
					bodyBytes: result.requestBody.bodyBytes,
					concurrency: result.requestBody.concurrency,
					transformMode: result.requestBody.transformMode,
					expectedModel: result.requestBody.expectedModel,
					phase,
				}),
			);
		}
	}
}

function printAttributionTable(results: WaveResult[]): void {
	const headers = [
		"wave",
		"mode",
		"body MiB",
		"conc",
		"phase",
		"obs",
		"RSS MiB",
		"Δ RSS",
		"Δ heap",
		"Δ external",
		"Δ arrayBuffers",
		"Δ RSS arithmetic remainder",
	];
	const rows = results.flatMap((result) =>
		result.requestBody.phases.map((phase) => [
			String(result.wave),
			result.requestBody.transformMode,
			formatMebibytes(result.requestBody.bodyBytes),
			String(result.requestBody.concurrency),
			phase.name,
			String(phase.observationCount),
			formatMebibytes(phase.absolute.memory.rss),
			formatSignedMebibytes(phase.deltaFromWaveBaseline.memory.rss),
			formatSignedMebibytes(phase.deltaFromWaveBaseline.memory.heapUsed),
			formatSignedMebibytes(phase.deltaFromWaveBaseline.memory.external),
			formatSignedMebibytes(phase.deltaFromWaveBaseline.memory.arrayBuffers),
			formatSignedMebibytes(phase.rssArithmeticRemainder.deltaFromWaveBaseline),
		]),
	);
	console.log(
		"Request-body phase attribution (all deltas from wave baseline):",
	);
	renderTable(headers, rows);
	console.log(
		`Accounting note: ${MEMORY_ACCOUNTING_NOTES.rssArithmeticRemainder}.`,
	);
	console.log(`Accounting note: ${MEMORY_ACCOUNTING_NOTES.arrayBuffers}.`);
	console.log(`Accounting note: ${MEMORY_ACCOUNTING_NOTES.phaseDeltas}.`);
	console.log(`Isolation note: ${MEMORY_ACCOUNTING_NOTES.childIsolation}.`);
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
				transformMode,
				expectedModel: expectedModelForMode(transformMode),
				responseChunkBytes,
				discardDeadlineMs,
				soak,
			},
			memoryAccounting: MEMORY_ACCOUNTING_NOTES,
			modes: [
				`request-body-materialize-${transformMode}-isolated-loopback`,
				"full-drain",
				"client-abort",
				"finite-discard-drain",
				"hanging-discard-deadline",
				"lazy-retry-not-taken",
			],
		}),
	);
	const results: WaveResult[] = [];
	for (let wave = 1; wave <= waves; wave += 1)
		results.push(await runWave(wave));
	printPhaseJson(results);
	console.log(JSON.stringify({ results }));
	printTable(results);
	printAttributionTable(results);
}

if (import.meta.main) {
	main()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error("proxy request memory harness crashed:", error);
			process.exit(1);
		});
}
