/**
 * Deterministic ownership baseline for proxy response bodies.
 *
 * These tests intentionally do not gate allocator metrics. RSS and JSC heap
 * totals vary with Bun's allocator and GC scheduling; lifecycle ownership does
 * not. Each case uses a port-0 Bun.serve upstream and real fetch traffic, then
 * asserts the exact upstream and BodyAdmissionController terminal state.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	BodyAdmissionController,
	withBodyAdmission,
} from "../../../../apps/server/src/body-admission";
import type { RequestBodyUpstreamState } from "../../../../bench/fixtures/proxy-request-memory-upstream";
import {
	BODY_MODEL_AFTER_TRANSFORM,
	BODY_MODEL_BEFORE_TRANSFORM,
	createClaudeRequestBody,
	isHeapSettled,
	PROXY_MEMORY_CHILD_READY_TYPE,
	runProxyRequestBodyWorkload,
} from "../../../../bench/proxy-request-memory-harness";
import {
	cancelDiscardedResponseBody,
	drainBody,
} from "../handlers/discard-body-cancel";
import { makeProxyRequest } from "../handlers/request-handler";

type Mode = "finite" | "empty" | "hanging";

type Upstream = {
	url: (mode: Mode) => string;
	state: {
		requests: number;
		completed: number;
		cancelled: number;
		aborted: number;
		pulls: number;
	};
	stop: () => void;
};

const encoder = new TextEncoder();
const PROCESS_MEMORY_FIELDS = [
	"arrayBuffers",
	"external",
	"heapTotal",
	"heapUsed",
	"rss",
];
const HEAP_STATS_SCALAR_FIELDS = [
	"extraMemorySize",
	"globalObjectCount",
	"heapCapacity",
	"heapSize",
	"objectCount",
	"protectedGlobalObjectCount",
	"protectedObjectCount",
];

type RequestBodyWorkloadResult = Awaited<
	ReturnType<typeof runProxyRequestBodyWorkload>
>;

const HARNESS_PATH = `${import.meta.dir}/../../../../bench/proxy-request-memory-harness.ts`;

function expectNumericRecord(
	record: Record<string, number>,
	expectedFields: string[],
): void {
	expect(Object.keys(record).sort()).toEqual(expectedFields);
	expect(Object.values(record).every(Number.isFinite)).toBe(true);
}

function expectRequestBodyAttribution(
	result: RequestBodyWorkloadResult,
	bodyBytes: number,
	expectedModel: string,
	expectedPhaseNames: string[],
): void {
	expect(result).toMatchObject({
		bun: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		bodyBytes,
		concurrency: 1,
		expectedModel,
		generatedBodyBytes: [bodyBytes],
		responses: [{ status: 204, responseBytes: 0 }],
		upstream: {
			requests: 1,
			receivedBodyBytes: [bodyBytes],
			receivedModels: [expectedModel],
			completed: 1,
			cancelled: 0,
			aborted: 0,
			responseStream: {
				pulls: 0,
				completed: 0,
				cancelled: 0,
				aborted: 0,
			},
		},
	});
	expect(result.phases.map((phase) => phase.name)).toEqual(expectedPhaseNames);
	expect(result.memoryAccounting.rssArithmeticRemainder).toContain(
		"not native memory",
	);
	expect(result.memoryAccounting.arrayBuffers).toContain("subset of external");
	expect(result.memoryAccounting.phaseDeltas).toContain("not additive");
	expect(result.memoryAccounting.childIsolation).toContain(
		"child process memory is excluded",
	);
	expect(result.upstreamProcess).toMatchObject({
		ready: true,
		statsFetched: true,
		terminationRequested: true,
		exited: true,
		exitCode: 0,
	});
	expect(result.upstreamProcess.pid).toBeGreaterThan(0);
	expect(() => process.kill(result.upstreamProcess.pid, 0)).toThrow();

	const baseline = result.phases[0];
	const baselineRemainder = baseline.rssArithmeticRemainder.absolute;
	for (const phase of result.phases) {
		expect(phase.observationCount).toBe(1);
		expectNumericRecord(phase.absolute.memory, PROCESS_MEMORY_FIELDS);
		expectNumericRecord(phase.absolute.heapStats, HEAP_STATS_SCALAR_FIELDS);
		expectNumericRecord(
			phase.deltaFromWaveBaseline.memory,
			PROCESS_MEMORY_FIELDS,
		);
		expectNumericRecord(
			phase.deltaFromWaveBaseline.heapStats,
			HEAP_STATS_SCALAR_FIELDS,
		);
		expect(Number.isFinite(phase.rssArithmeticRemainder.absolute)).toBe(true);
		expect(
			Number.isFinite(phase.rssArithmeticRemainder.deltaFromWaveBaseline),
		).toBe(true);
		expect(phase.rssArithmeticRemainder.absolute).toBe(
			phase.absolute.memory.rss -
				phase.absolute.memory.heapTotal -
				phase.absolute.memory.external,
		);
		expect(phase.rssArithmeticRemainder.deltaFromWaveBaseline).toBe(
			phase.rssArithmeticRemainder.absolute - baselineRemainder,
		);
	}

	expect(
		Object.values(baseline.deltaFromWaveBaseline.memory).every(
			(value) => value === 0,
		),
	).toBe(true);
	expect(
		Object.values(baseline.deltaFromWaveBaseline.heapStats).every(
			(value) => value === 0,
		),
	).toBe(true);
	expect(baseline.rssArithmeticRemainder.deltaFromWaveBaseline).toBe(0);
}

function startUpstream(): Upstream {
	const state = {
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
			state.requests += 1;
			request.signal.addEventListener(
				"abort",
				() => {
					state.aborted += 1;
				},
				{ once: true },
			);
			const mode = new URL(request.url).pathname.slice(1) as Mode;
			if (mode === "empty") {
				state.completed += 1;
				return new Response(null, { status: 204 });
			}
			let sent = false;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						state.pulls += 1;
						if (!sent) {
							sent = true;
							controller.enqueue(encoder.encode("data: chunk\n\n"));
							if (mode === "finite") {
								state.completed += 1;
								controller.close();
							}
						}
					},
					cancel() {
						state.cancelled += 1;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return {
		url: (mode) => `http://127.0.0.1:${server.port}/${mode}`,
		state,
		stop: () => server.stop(true),
	};
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("fixture did not reach its expected terminal state");
}

async function readOne(response: Response): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("expected a streaming response");
	await reader.read();
	reader.releaseLock();
}

describe("proxy response-body ownership baseline", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("request body: forwards one boundary-sized transformed body without response lifecycle work", async () => {
		const bodyBytes = 4 * 1024;
		const generated = createClaudeRequestBody(bodyBytes);
		expect(generated.byteLength).toBe(bodyBytes);

		const result = await runProxyRequestBodyWorkload({
			bodyBytes,
			concurrency: 1,
			transformMode: "clone-rewrite",
		});
		expect(result.transformMode).toBe("clone-rewrite");
		expectRequestBodyAttribution(
			result,
			bodyBytes,
			BODY_MODEL_AFTER_TRANSFORM,
			[
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
				"post-gc-heap-settled",
			],
		);
	});

	it("request body: passthrough preserves the source model at an explicit provider boundary", async () => {
		const bodyBytes = 4 * 1024;
		const result = await runProxyRequestBodyWorkload({
			bodyBytes,
			concurrency: 1,
			transformMode: "passthrough",
		});

		expect(result.transformMode).toBe("passthrough");
		expectRequestBodyAttribution(
			result,
			bodyBytes,
			BODY_MODEL_BEFORE_TRANSFORM,
			[
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
				"post-gc-heap-settled",
			],
		);
	});

	it("request body: consume-rebuild attributes source consumption before rebuilding", async () => {
		const bodyBytes = 4 * 1024;
		const result = await runProxyRequestBodyWorkload({
			bodyBytes,
			concurrency: 1,
			transformMode: "consume-rebuild",
		});

		expect(result.transformMode).toBe("consume-rebuild");
		expectRequestBodyAttribution(
			result,
			bodyBytes,
			BODY_MODEL_AFTER_TRANSFORM,
			[
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
				"post-gc-heap-settled",
			],
		);
	});

	it("request body: aggregates every concurrent phase without inventing samples", async () => {
		const concurrency = 2;
		const bodyBytes = 4 * 1024;
		const result = await runProxyRequestBodyWorkload({
			bodyBytes,
			concurrency,
			transformMode: "passthrough",
		});

		expect(result.upstream).toMatchObject({
			requests: concurrency,
			receivedBodyBytes: [bodyBytes, bodyBytes],
			receivedModels: [
				BODY_MODEL_BEFORE_TRANSFORM,
				BODY_MODEL_BEFORE_TRANSFORM,
			],
			completed: concurrency,
			cancelled: 0,
			aborted: 0,
		});
		expect(result.upstreamProcess).toMatchObject({
			ready: true,
			statsFetched: true,
			terminationRequested: true,
			exited: true,
			exitCode: 0,
		});
		expect(() => process.kill(result.upstreamProcess.pid, 0)).toThrow();
		for (const phase of result.phases) {
			const expected =
				phase.name === "pre-body-baseline" ||
				phase.name === "post-gc-heap-settled"
					? 1
					: concurrency;
			expect(phase.observationCount).toBe(expected);
		}
	});

	it("request body: labels settling by its heapUsed-only predicate", () => {
		expect(isHeapSettled(1_000_000, 1_200_000)).toBe(true);
		expect(isHeapSettled(1_000_000, 1_300_000)).toBe(false);
		expect(isHeapSettled(-1, 0)).toBe(false);
		expect(["post-gc-heap-settled"].includes("post-gc-settled")).toBe(false);
	});

	it("request body: parent signals reap an active isolated upstream child", async () => {
		const subprocess = Bun.spawn({
			cmd: [process.execPath, HARNESS_PATH],
			env: {
				...process.env,
				PROXY_MEMORY_WAVES: "1",
				PROXY_MEMORY_CONCURRENCY: "1",
				PROXY_MEMORY_BODY_BYTES: "4096",
				PROXY_MEMORY_CHILD_RESPONSE_DELAY_MS: "5000",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = subprocess.stdout.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		let childPid: number | undefined;
		let childControlUrl: string | undefined;
		const deadline = Date.now() + 8_000;
		try {
			while (!childPid && Date.now() < deadline) {
				const remaining = deadline - Date.now();
				const chunk = await Promise.race([
					reader.read(),
					Bun.sleep(remaining).then(() => {
						throw new Error("timed out waiting for child-ready event");
					}),
				]);
				if (chunk.done)
					throw new Error("harness exited before child-ready event");
				buffered += decoder.decode(chunk.value, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					const event = JSON.parse(line) as Record<string, unknown>;
					if (event.type === PROXY_MEMORY_CHILD_READY_TYPE) {
						childPid = event.pid as number;
						childControlUrl = event.controlUrl as string;
						break;
					}
					newline = buffered.indexOf("\n");
				}
			}
			expect(childPid).toBeGreaterThan(0);
			expect(childControlUrl).toStartWith("http://127.0.0.1:");
			if (!childPid || !childControlUrl) {
				throw new Error("child-ready event lacked process control fields");
			}

			let active = false;
			while (!active && Date.now() < deadline) {
				const response = await fetch(childControlUrl, {
					signal: AbortSignal.timeout(500),
				});
				const stats = (await response.json()) as RequestBodyUpstreamState;
				active = stats.requests === 1 && stats.completed === 0;
				if (!active) await Bun.sleep(20);
			}
			expect(active).toBe(true);

			subprocess.kill("SIGTERM");
			const exitCode = await Promise.race([
				subprocess.exited,
				Bun.sleep(4_000).then(() => {
					throw new Error("timed out waiting for signalled harness exit");
				}),
			]);
			expect(exitCode).toBe(143);
			await eventually(() => {
				try {
					process.kill(childPid, 0);
					return false;
				} catch {
					return true;
				}
			});
		} finally {
			await reader.cancel().catch(() => undefined);
			if (subprocess.exitCode === null) subprocess.kill("SIGKILL");
			if (childPid) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// Already reaped by the parent, which is the expected path.
				}
			}
			await Promise.race([subprocess.exited, Bun.sleep(1_000)]);
		}
	}, 12_000);

	it("request body: rejects unknown transform modes before opening transport", async () => {
		await expect(
			runProxyRequestBodyWorkload({
				bodyBytes: 4 * 1024,
				concurrency: 1,
				transformMode: "unknown" as never,
			}),
		).rejects.toThrow("unsupported proxy memory transform mode: unknown");
	});

	it("success: fully drains one forwarded finite response and releases its admission lease", async () => {
		const upstream = startUpstream();
		cleanups.push(upstream.stop);
		const admission = new BodyAdmissionController({ budgetBytes: 1024 });
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

		expect(await response.text()).toContain("data: chunk");
		expect(upstream.state).toMatchObject({
			requests: 1,
			completed: 1,
			cancelled: 0,
			aborted: 0,
		});
		expect(admission.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			queuedRequests: 0,
			counters: { admitted: 1, released: 1 },
		});
	});

	it("boundary/empty: releases admission immediately when the upstream has no body", async () => {
		const upstream = startUpstream();
		cleanups.push(upstream.stop);
		const admission = new BodyAdmissionController({ budgetBytes: 1024 });
		const response = await withBodyAdmission(
			new Request(upstream.url("empty"), {
				method: "POST",
				body: "x",
				headers: { "content-length": "1" },
			}),
			admission,
			async () =>
				makeProxyRequest(upstream.url("empty"), "POST", new Headers()),
		);

		expect(response.status).toBe(204);
		// fetch represents an empty HTTP response as a closed stream; ownership is
		// nevertheless released before the caller receives it.
		expect(await response.text()).toBe("");
		expect(upstream.state).toMatchObject({ requests: 1, completed: 1 });
		expect(admission.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			counters: { admitted: 1, released: 1 },
		});
	});

	it("cancellation/error: caller abort reaches the live upstream transport", async () => {
		const upstream = startUpstream();
		cleanups.push(upstream.stop);
		const aborter = new AbortController();
		const response = await makeProxyRequest(
			upstream.url("hanging"),
			"POST",
			new Headers(),
			undefined,
			false,
			aborter.signal,
		);
		await readOne(response);
		aborter.abort();
		await eventually(
			() => upstream.state.aborted === 1 || upstream.state.cancelled === 1,
		);

		expect(upstream.state.requests).toBe(1);
		expect(
			upstream.state.aborted + upstream.state.cancelled,
		).toBeGreaterThanOrEqual(1);
	});

	it("integration: drains finite discards, deadlines hanging discards, and does not retry success", async () => {
		const upstream = startUpstream();
		cleanups.push(upstream.stop);

		const finite = await makeProxyRequest(
			upstream.url("finite"),
			"POST",
			new Headers(),
		);
		if (!finite.body) throw new Error("expected finite body");
		await drainBody(finite.body);
		expect(upstream.state).toMatchObject({
			requests: 1,
			completed: 1,
			cancelled: 0,
			aborted: 0,
		});

		const hanging = await makeProxyRequest(
			upstream.url("hanging"),
			"POST",
			new Headers(),
		);
		await readOne(hanging);
		cancelDiscardedResponseBody(hanging, { deadlineMs: 20 });
		await eventually(
			() => upstream.state.aborted === 1 || upstream.state.cancelled === 1,
		);

		// This successful request characterizes the lazy retry path: no retry is
		// scheduled merely because a response body was successfully consumed.
		const success = await makeProxyRequest(
			upstream.url("finite"),
			"POST",
			new Headers(),
		);
		await success.text();
		expect(upstream.state.requests).toBe(3);
		expect(upstream.state.completed).toBe(2);
	});
});
