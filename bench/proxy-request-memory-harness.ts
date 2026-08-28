#!/usr/bin/env bun
/**
 * Informational lifecycle-and-memory harness for proxy request bodies.
 *
 * Uses an in-process port-0 Bun.serve upstream and real Bun fetches only: no
 * external accounts, no global fetch mocking, and no allocator threshold.
 * The fast profile deliberately completes in seconds. Set PROXY_MEMORY_SOAK=1
 * to opt into a longer allocator-sensitive run.
 *
 * Run:
 *   bun bench/proxy-request-memory-harness.ts
 *   PROXY_MEMORY_SOAK=1 PROXY_MEMORY_WAVES=50 bun bench/proxy-request-memory-harness.ts
 */
// @ts-expect-error bun:jsc's heapStats is available at runtime but incomplete in Bun's types.
import { heapStats } from "bun:jsc";
import {
	BodyAdmissionController,
	withBodyAdmission,
} from "../apps/server/src/body-admission";
import {
	cancelDiscardedResponseBody,
	drainBody,
} from "../packages/proxy/src/handlers/discard-body-cancel";
import { makeProxyRequest } from "../packages/proxy/src/handlers/request-handler";

type Mode = "finite" | "hanging";
type NumericRecord = Record<string, number>;

type UpstreamCounts = {
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

type WaveResult = {
	wave: number;
	before: Sample;
	peak: Sample;
	settled: Sample;
	upstream: UpstreamCounts;
	bodyAdmission: ReturnType<BodyAdmissionController["snapshot"]>;
};

const encoder = new TextEncoder();
const waves = Number.parseInt(
	process.env.PROXY_MEMORY_WAVES ?? (process.env.PROXY_MEMORY_SOAK === "1" ? "50" : "3"),
	10,
);
const concurrency = Number.parseInt(process.env.PROXY_MEMORY_CONCURRENCY ?? "4", 10);
const chunkBytes = Number.parseInt(process.env.PROXY_MEMORY_CHUNK_BYTES ?? "16384", 10);
const discardDeadlineMs = Number.parseInt(
	process.env.PROXY_MEMORY_DISCARD_DEADLINE_MS ?? "20",
	10,
);

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

function maxSample(current: Sample, next: Sample): Sample {
	const maxFields = (left: NumericRecord, right: NumericRecord): NumericRecord =>
		Object.fromEntries(
			new Set([...Object.keys(left), ...Object.keys(right)])
				.values()
				.map((key) => [key, Math.max(left[key] ?? 0, right[key] ?? 0)]),
		);
	return {
		memory: maxFields(current.memory, next.memory),
		heapStats: maxFields(current.heapStats, next.heapStats),
	};
}

function startUpstream(): { url: (mode: Mode) => string; counts: UpstreamCounts; stop: () => void } {
	const counts: UpstreamCounts = {
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
						controller.enqueue(encoder.encode("x".repeat(chunkBytes)));
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

async function runWave(wave: number): Promise<WaveResult> {
	const upstream = startUpstream();
	const admission = new BodyAdmissionController({ budgetBytes: 1024 * 1024 });
	const before = await settle();
	let peak = before;
	const observePeak = () => {
		peak = maxSample(peak, sample());
	};
	try {
		// Full drain is forwarded through the lease wrapper so its exact release
		// count and final ownership state are included in every wave.
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
				observePeak();
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
		observePeak();

		// A finite discarded response is drained chunk-by-chunk, not materialized.
		const finiteDiscard = await makeProxyRequest(
			upstream.url("finite"),
			"POST",
			new Headers(),
		);
		if (!finiteDiscard.body) throw new Error("expected finite discard body");
		await drainBody(finiteDiscard.body);
		observePeak();

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
		observePeak();

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
		observePeak();

		return {
			wave,
			before,
			peak,
			settled: await settle(),
			upstream: { ...upstream.counts },
			bodyAdmission: admission.snapshot(),
		};
	} finally {
		upstream.stop();
	}
}

function printTable(results: WaveResult[]): void {
	const headers = [
		"wave",
		"peak heapUsed MiB",
		"settled heapUsed MiB",
		"peak RSS MiB",
		"requests",
		"complete/cancel/abort",
		"leases",
	];
	const rows = results.map((result) => [
		String(result.wave),
		(result.peak.memory.heapUsed / 1024 / 1024).toFixed(1),
		(result.settled.memory.heapUsed / 1024 / 1024).toFixed(1),
		(result.peak.memory.rss / 1024 / 1024).toFixed(1),
		String(result.upstream.requests),
		`${result.upstream.completed}/${result.upstream.cancelled}/${result.upstream.aborted}`,
		`${result.bodyAdmission.activeLeases}/${result.bodyAdmission.counters.released}`,
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
				chunkBytes,
				discardDeadlineMs,
				soak: process.env.PROXY_MEMORY_SOAK === "1",
			},
			modes: [
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

main().catch((error) => {
	console.error("proxy request memory harness crashed:", error);
	process.exit(1);
});
