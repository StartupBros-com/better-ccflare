import { heapSize, memoryUsage as jscMemoryUsage } from "bun:jsc";
import {
	closeSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PHASES = [
	"idle",
	"maintenance-idle",
	"body-equal-1",
	"body-equal-2",
	"body-peak",
	"body-equal-after-peak",
	"rewrite-retry-control",
	"response-cancellation",
	"slow-reader-abort",
	"deferred-reasoning",
	"writer-busy",
	"writer-settled",
	"post-quiet",
	"closed",
] as const;
type Phase = (typeof PHASES)[number];
const OWNER_KEYS = [
	"bodyBytes",
	"requestCount",
	"activeLeases",
	"reservedBytes",
	"queuedRequests",
	"workersAcquired",
	"workersRetired",
	"workersLive",
	"objectUrlsAcquired",
	"objectUrlsRevoked",
	"objectUrlsLive",
	"activeJobs",
	"queuedJobs",
	"payloadBytesPending",
	"metadataQueuedJobs",
	"payloadQueuedJobs",
	"maintenanceBusy",
	"pendingReasoningBytes",
	"peakPendingReasoningBytes",
	"functionCallBytes",
	"cancelled",
	"aborted",
	"completed",
	"childReaped",
] as const;
type Owners = Partial<Record<(typeof OWNER_KEYS)[number], number>>;
function number(value: number) {
	return Number.isFinite(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
		: 0;
}
function swapBytes() {
	const raw = readFileSync("/proc/self/status", "utf8");
	return Number(/^VmSwap:\s*(\d+) kB$/m.exec(raw)?.[1] ?? 0) * 1024;
}

/** Append-only fsynced receipts survive SIGKILL; a phase is never a process-exit claim. */
export class ResourcePhaseRecorder {
	private records = 0;
	private bytes = 0;
	constructor(private path: string) {
		const fd = openSync(path, "wx", 0o600);
		fsyncSync(fd);
		closeSync(fd);
	}
	record(phase: Phase, owners: Owners, workloadComplete = false) {
		if (!PHASES.includes(phase)) throw new Error("unknown resource phase");
		if (workloadComplete && phase !== "closed")
			throw new Error("only closed phase can complete the workload");
		if (this.records >= 32) throw new Error("resource record budget exhausted");
		const fields: Owners = {},
			workload: Owners = {};
		for (const key of OWNER_KEYS)
			if (owners[key] !== undefined) {
				const target =
					key === "bodyBytes" || key === "requestCount" ? workload : fields;
				target[key] = number(owners[key] ?? 0);
			}
		const jsc = jscMemoryUsage();
		const value = {
			schema: "ccflare.resource_phase.v1",
			phase,
			complete: true,
			...(workloadComplete ? { workloadComplete: true } : {}),
			runtime: {
				bun: Bun.version,
				platform: process.platform,
				build: /^[0-9a-f]{40}$/.test(process.env.PROXY_MEMORY_BUILD_SHA ?? "")
					? process.env.PROXY_MEMORY_BUILD_SHA
					: "unknown",
				ownerEpoch: process.pid,
			},
			memory: process.memoryUsage(),
			swapBytes: swapBytes(),
			jsc: {
				heapSize: heapSize(),
				current: jsc.current,
				peak: jsc.peak,
				currentCommit: jsc.currentCommit,
				peakCommit: jsc.peakCommit,
				pageFaults: jsc.pageFaults,
			},
			owners: fields,
			workload,
			forcedGc: false,
		};
		const line = JSON.stringify(value) + "\n";
		if (this.bytes + Buffer.byteLength(line) > 256 * 1024)
			throw new Error("resource byte budget exhausted");
		const fd = openSync(this.path, "a");
		try {
			writeSync(fd, line);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.records++;
		this.bytes += Buffer.byteLength(line);
		return value;
	}
}
function verifyEnvelope() {
	if (process.platform !== "linux")
		throw new Error("resource diagnostic requires Linux private namespace");
	const interfaces = readFileSync("/proc/self/net/dev", "utf8")
		.trim()
		.split("\n")
		.slice(2)
		.map((line) => line.split(":")[0].trim());
	if (interfaces.some((name) => name !== "lo"))
		throw new Error("resource diagnostic requires private loopback interface");
	const net = readFileSync("/proc/self/net/route", "utf8")
		.trim()
		.split("\n")
		.slice(1);
	if (net.length)
		throw new Error(
			"resource diagnostic requires loopback-only network namespace",
		);
	const group = readFileSync("/proc/self/cgroup", "utf8")
		.split("\n")
		.find((l) => l.startsWith("0::"))
		?.slice(3);
	if (!group)
		throw new Error("resource diagnostic requires cgroup v2 envelope");
	const base = join("/sys/fs/cgroup", group);
	const limit = (name: string) =>
		Number(readFileSync(join(base, name), "utf8").trim());
	if (
		!(
			limit("memory.max") <= 512 * 1024 * 1024 &&
			limit("memory.swap.max") === 0 &&
			limit("pids.max") <= 64
		)
	)
		throw new Error("resource diagnostic exceeds reviewed envelope");
}
function balances(status: {
	workersAcquired: number;
	workersRetired: number;
	objectUrlsAcquired: number;
	objectUrlsRevoked: number;
	activeJobs: number;
	queuedJobs: number;
}): Owners {
	return {
		...status,
		workersLive: status.workersAcquired - status.workersRetired,
		objectUrlsLive: status.objectUrlsAcquired - status.objectUrlsRevoked,
	};
}

/** Real loopback chunks, paused reader, and exact caller-owned transport abort. */
export async function runSlowReaderAbortControl(): Promise<Owners> {
	const { BodyAdmissionController, withBodyAdmission } = await import(
		"../apps/server/src/body-admission"
	);
	const admission = new BodyAdmissionController({ budgetBytes: 1024 * 1024 });
	const abort = new AbortController();
	let aborted = 0,
		completed = 0,
		terminal = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			request.signal.addEventListener(
				"abort",
				() => {
					if (!terminal) {
						terminal = true;
						aborted++;
					}
				},
				{ once: true },
			);
			let sent = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(c) {
						await Bun.sleep(10);
						if (terminal) return;
						c.enqueue(new Uint8Array(64 * 1024));
						sent++;
						if (sent === 100) {
							terminal = true;
							completed++;
							c.close();
						}
					},
					cancel() {
						if (!terminal) {
							terminal = true;
							aborted++;
						}
					},
				}),
			);
		},
	});
	try {
		const url = `http://127.0.0.1:${server.port}/slow-reader`;
		const request = new Request(url, {
			method: "POST",
			body: "x",
			headers: { "content-length": "1" },
			signal: abort.signal,
		});
		const response = await withBodyAdmission(request, admission, () =>
			fetch(url, {
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]),
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("slow reader missing response");
		try {
			const first = await reader.read();
			if (first.done) throw new Error("slow reader completed before pause");
			await Bun.sleep(50);
			abort.abort();
			try {
				await reader.read();
			} catch {}
			await reader.cancel().catch(() => {});
		} finally {
			reader.releaseLock();
		}
		for (
			let i = 0;
			i < 50 && (!aborted || admission.snapshot().activeLeases);
			i++
		)
			await Bun.sleep(5);
		const snapshot = admission.snapshot();
		if (!aborted || snapshot.activeLeases || snapshot.reservedBytes)
			throw new Error("slow reader ownership did not retire");
		return {
			activeLeases: snapshot.activeLeases,
			reservedBytes: snapshot.reservedBytes,
			queuedRequests: snapshot.queuedRequests,
			aborted,
			completed,
		};
	} finally {
		abort.abort();
		await server.stop(true);
	}
}

/** Finite matched controls. Run under timeout -k1s39s +512MiB/0swap/64PID +unshare-Urn. */
export async function runBoundedResourceDiagnostic() {
	verifyEnvelope();
	const checkpoint = process.env.PROXY_MEMORY_CHECKPOINT;
	if (!checkpoint) throw new Error("PROXY_MEMORY_CHECKPOINT is required");
	const r = new ResourcePhaseRecorder(checkpoint);
	const started = performance.now();
	const assertTime = () => {
		if (performance.now() - started > 30_000)
			throw new Error("resource diagnostic work budget expired");
	};
	const [
		{ Database },
		{ MaintenanceWorkerOwner },
		{ AsyncDbWriter },
		harness,
		{ CodexProvider },
	] = await Promise.all([
		import("bun:sqlite"),
		import("../packages/database/src/maintenance-worker-owner"),
		import("../packages/database/src/async-writer"),
		import("./proxy-request-memory-harness"),
		import("../packages/providers/src/providers/codex/provider"),
	]);
	const dir = mkdtempSync(join(tmpdir(), "ccflare-resource-controls-"));
	const dbPath = join(dir, "control.db"),
		db = new Database(dbPath);
	db.exec(
		"PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(1)",
	);
	const workerPath = join(
		import.meta.dir,
		"fixtures/proxy-resource-maintenance-worker.ts",
	);
	const owner = new MaintenanceWorkerOwner(workerPath, {
		embeddedCode: Buffer.from(readFileSync(workerPath)).toString("base64"),
		jobTimeoutMs: 1000,
		retirementTimeoutMs: 1000,
	});
	const writer = new AsyncDbWriter();
	let releaseJob: () => void = () => {};
	try {
		r.record("idle", {});
		await Bun.sleep(50);
		for (let i = 0; i < 3; i++) {
			const result = await owner.run({ path: dbPath });
			if (!result.ok || result.walBusy)
				throw new Error("idle maintenance control failed");
		}
		const baseline = balances(owner.getStatus());
		if (baseline.workersLive !== 1 || baseline.objectUrlsLive !== 1)
			throw new Error("maintenance idle baseline mismatch");
		r.record("maintenance-idle", baseline);
		const wave = async (
			phase: Phase,
			bodyBytes: number,
			transformMode: "passthrough" | "clone-rewrite" | "consume-rebuild",
		) => {
			assertTime();
			const result = await harness.runProxyRequestBodyWorkload({
				bodyBytes,
				concurrency: 1,
				transformMode,
				samplingMode: "normal-gc",
			});
			if (
				!result.upstreamProcess.exited ||
				result.upstreamProcess.exitCode !== 0
			)
				throw new Error("request child not reaped");
			await Bun.sleep(50);
			r.record(phase, {
				bodyBytes,
				requestCount: result.upstream.requests,
				childReaped: 1,
				...balances(owner.getStatus()),
			});
		};
		await wave("body-equal-1", 2 * 1024 * 1024, "passthrough");
		await wave("body-equal-2", 2 * 1024 * 1024, "passthrough");
		await wave("body-peak", 8 * 1024 * 1024, "passthrough");
		await wave("body-equal-after-peak", 2 * 1024 * 1024, "passthrough");
		// Two separate equal-size physical operations characterize body reuse/rewrite;
		// this does NOT claim to exercise account failover policy.
		await wave("rewrite-retry-control", 2 * 1024 * 1024, "clone-rewrite");
		await wave("rewrite-retry-control", 2 * 1024 * 1024, "consume-rebuild");
		assertTime();
		const lifecycle = await harness.runResponseLifecycleModes(() => {});
		if (
			lifecycle.bodyAdmission.activeLeases ||
			lifecycle.bodyAdmission.reservedBytes
		)
			throw new Error("response lease imbalance");
		r.record("response-cancellation", {
			...lifecycle.bodyAdmission,
			...lifecycle.upstream,
		});
		r.record("slow-reader-abort", await runSlowReaderAbortControl());
		const frame = (event: string, data: unknown) =>
			`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		const frames = [
			frame("response.output_item.added", {
				output_index: 0,
				item: { type: "function_call", name: "Read", call_id: "offline" },
			}),
			...Array.from({ length: 16 }, () =>
				frame("response.output_item.done", {
					output_index: 1,
					item: {
						type: "reasoning",
						id: "offline",
						encrypted_content: "x".repeat(16 * 1024),
					},
				}),
			),
			frame("response.function_call_arguments.delta", {
				output_index: 0,
				delta: "{}",
			}),
			frame("response.output_item.done", {
				output_index: 0,
				item: { type: "function_call", call_id: "offline" },
			}),
			frame("response.completed", {
				response: { usage: { input_tokens: 1, output_tokens: 1 } },
			}),
		];
		const provider = new CodexProvider();
		let index = 0,
			peak = 0,
			pending = 0,
			functionBytes = 0;
		const internal = provider as unknown as {
			handleCodexEvent: (...args: unknown[]) => Promise<void>;
		};
		const original = internal.handleCodexEvent.bind(provider);
		internal.handleCodexEvent = async (...args) => {
			await original(...args);
			const state = args[2] as {
				pendingReasoningBytes: number;
				functionCallBytesTotal: number;
			};
			pending = state.pendingReasoningBytes;
			functionBytes = state.functionCallBytesTotal;
			peak = Math.max(peak, pending);
		};
		const response = await provider.processResponse(
			new Response(
				new ReadableStream({
					pull(c) {
						if (index < frames.length)
							c.enqueue(new TextEncoder().encode(frames[index++]));
						else c.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
			null,
		);
		await response.text();
		if (!peak || pending || functionBytes)
			throw new Error("deferred reasoning terminal imbalance");
		r.record("deferred-reasoning", {
			pendingReasoningBytes: pending,
			peakPendingReasoningBytes: peak,
			functionCallBytes: functionBytes,
		});
		assertTime();
		db.exec("BEGIN IMMEDIATE; INSERT INTO fixture VALUES(2)");
		const busy = await owner.run({ path: dbPath });
		db.exec("ROLLBACK");
		if (!busy.ok || !busy.walBusy)
			throw new Error("SQLite busy control not established");
		const blocked = new Promise<void>((resolve) => {
			releaseJob = resolve;
		});
		if (!writer.enqueuePayload("offline", 2 * 1024 * 1024, () => blocked))
			throw new Error("writer control admission rejected");
		await Bun.sleep(5);
		r.record("writer-busy", {
			...writer.getHealth(),
			maintenanceBusy: busy.walBusy ?? 0,
		});
		releaseJob();
		await writer.dispose();
		if (writer.getHealth().payloadBytesPending !== 0)
			throw new Error("writer terminal imbalance");
		r.record("writer-settled", { ...writer.getHealth() });
		await Bun.sleep(50);
		r.record("post-quiet", balances(owner.getStatus()));
		await owner.close();
		db.close();
	} finally {
		releaseJob();
		await writer.dispose();
		await owner.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
	const closed = balances(owner.getStatus());
	if (
		closed.workersLive ||
		closed.objectUrlsLive ||
		closed.activeJobs ||
		closed.queuedJobs
	)
		throw new Error("maintenance terminal imbalance");
	r.record("closed", closed, true);
}
