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
