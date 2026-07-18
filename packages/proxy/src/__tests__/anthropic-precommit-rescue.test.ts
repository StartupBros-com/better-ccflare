import { describe, expect, it, mock } from "bun:test";
import {
	ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
	ANTHROPIC_PRECOMMIT_RESCUE_PARTIAL_ERROR_FRAME,
	ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
	coordinateAnthropicPreCommitRescue,
	createAnthropicPreCommitRescueActivation,
} from "../anthropic-precommit-rescue";

const encoder = new TextEncoder();

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function successfulSse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"x-upstream-route": "winner",
		},
	});
}

describe("coordinateAnthropicPreCommitRescue", () => {
	it("returns a response that settles before activation byte-for-byte with its status and headers", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const original = new Response("fast", {
			status: 202,
			headers: { "x-fast-path": "preserved" },
		});
		const abortRouting = mock((_reason?: unknown) => undefined);

		const response = await coordinateAnthropicPreCommitRescue({
			response: Promise.resolve(original),
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 10,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 50,
			},
		});

		expect(response).toBe(original);
		expect(response.status).toBe(202);
		expect(response.headers.get("x-fast-path")).toBe("preserved");
		expect(await response.text()).toBe("fast");
		expect(abortRouting).not.toHaveBeenCalled();
	});

	it("lets an already-settled response win an activation race without committing rescue", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const original = successfulSse("same-turn winner");
		activation.activate();

		const response = await coordinateAnthropicPreCommitRescue({
			response: Promise.resolve(original),
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 10,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 50,
			},
		});

		expect(response).toBe(original);
		expect(
			response.headers.get("x-better-ccflare-precommit-rescue"),
		).toBeNull();
	});

	it("keeps a slow sequential recovery alive with protocol pings and exposes only the gated winner", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		activation.activate();

		const responsePromise = coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 5,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		await delay(18);
		eventual.resolve(
			successfulSse('event: message_start\ndata: {"winner":true}\n\n'),
		);

		const response = await responsePromise;
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("x-upstream-route")).toBeNull();
		expect(body).toStartWith(ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME);
		expect(body).not.toContain("stalled-primary-private-prelude");
		expect(body).toEndWith('event: message_start\ndata: {"winner":true}\n\n');
		expect(abortRouting).not.toHaveBeenCalled();
	});

	it("translates a delayed terminal non-200 into one sanitized SSE error", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		activation.activate();
		const responsePromise = coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		await delay(5);
		eventual.resolve(
			new Response('{"private":"upstream failure"}', { status: 503 }),
		);

		const body = await (await responsePromise).text();
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(body).not.toContain("private");
	});

	it("closes promptly with one sanitized error when discarded-body cancellation never settles", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const releaseCancellation = deferred<void>();
		let cancelCount = 0;
		activation.activate();
		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelCount++;
						return releaseCancellation.promise;
					},
				}),
				{
					status: 503,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const timedOut = Symbol("timed out");
		const read = response.text();
		const body = await Promise.race([
			read,
			delay(100).then((): typeof timedOut => timedOut),
		]);
		releaseCancellation.resolve();

		expect(body).not.toBe(timedOut);
		if (body === timedOut) return;
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(cancelCount).toBe(1);
	});

	for (const terminal of ["rejection", "non-sse"] as const) {
		it(`sanitizes a delayed ${terminal} without leaking its error, headers, or body`, async () => {
			const activation = createAnthropicPreCommitRescueActivation();
			const eventual = deferred<Response>();
			activation.activate();
			const responsePromise = coordinateAnthropicPreCommitRescue({
				response: eventual.promise,
				activation: activation.promise,
				abortRouting: () => undefined,
				config: {
					activationGraceMs: 1,
					pingIntervalMs: 5,
					commitmentDeadlineMs: 100,
				},
			});
			await delay(5);
			if (terminal === "rejection") {
				eventual.reject(new Error("private rejected route detail"));
			} else {
				eventual.resolve(
					new Response("private successful JSON body", {
						status: 200,
						headers: {
							"content-type": "application/json",
							"x-private-route": "must-not-escape",
						},
					}),
				);
			}

			const response = await responsePromise;
			const body = await response.text();
			expect(response.headers.get("x-private-route")).toBeNull();
			expect(body.match(/event: error/g)).toHaveLength(1);
			expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
			expect(body).not.toContain("private");
		});
	}

	it("stops rescue pings before forwarding the first winner byte", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		activation.activate();
		const responsePromise = coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 3,
				commitmentDeadlineMs: 100,
			},
		});
		await delay(10);
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("winner-first-byte"));
						setTimeout(() => controller.close(), 20);
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			),
		);

		const body = await (await responsePromise).text();
		const winnerIndex = body.indexOf("winner-first-byte");
		expect(winnerIndex).toBeGreaterThan(0);
		expect(body.slice(winnerIndex)).not.toContain(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
	});

	it("does not pull winner chunks until a queued rescue ping leaves downstream capacity", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const winnerPulled = deferred<void>();
		let winnerPullCount = 0;
		activation.activate();
		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 10,
				commitmentDeadlineMs: 100,
			},
		});
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const initialPing = await reader?.read();
		expect(new TextDecoder().decode(initialPing?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);

		// Consuming the initial ping starts one outer pull, which waits for the
		// routed winner. While it waits, the interval fills the single available
		// downstream queue slot with another ping. Resolving the winner must then
		// hit the desiredSize guard instead of overfilling that bounded queue.
		await delay(20);
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							winnerPullCount++;
							controller.enqueue(encoder.encode(`chunk-${winnerPullCount}`));
							winnerPulled.resolve();
						},
					},
					{
						highWaterMark: 0,
					},
				),
				{
					headers: { "content-type": "text/event-stream" },
				},
			),
		);
		await delay(5);
		expect(winnerPullCount).toBe(0);

		const bufferedPing = await reader?.read();
		expect(new TextDecoder().decode(bufferedPing?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
		await winnerPulled.promise;
		expect(winnerPullCount).toBe(1);
		await delay(5);
		expect(winnerPullCount).toBe(1);

		await reader?.cancel("test complete");
	});

	it("turns a winner reader failure into one sanitized terminal SSE error", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		activation.activate();
		const responsePromise = coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		await delay(5);
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error("private reader error"));
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			),
		);

		const body = await (await responsePromise).text();
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(body).not.toContain("private reader error");
	});

	it("uses a distinct sanitized error when a winner reader fails after partial output", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		activation.activate();
		const responsePromise = coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		await delay(5);
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
							),
						);
					},
					pull(controller) {
						controller.error(new Error("private winner failure"));
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			),
		);

		const body = await (await responsePromise).text();
		expect(body).toContain('"text":"partial"');
		expect(body.match(/event: error/g)).toHaveLength(1);
		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_PARTIAL_ERROR_FRAME);
		expect(body).not.toContain("No compatible account route committed");
		expect(body).not.toContain("private winner failure");
	});

	it("aborts routing exactly once when the rescued downstream cancels", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		let winnerCancelCount = 0;
		activation.activate();

		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		await response.body?.cancel("downstream closed");
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("late winner"));
					},
					cancel() {
						winnerCancelCount++;
					},
				}),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			),
		);
		await delay(5);

		expect(abortRouting).toHaveBeenCalledTimes(1);
		expect(winnerCancelCount).toBe(1);
	});

	it("cancels an acquired winner reader and routing once without blocking downstream cancellation", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const releaseWinnerCancellation = deferred<void>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		let winnerCancelCount = 0;
		activation.activate();

		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(encoder.encode("winner chunk"));
					},
					cancel() {
						winnerCancelCount++;
						return releaseWinnerCancellation.promise;
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			),
		);

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const ping = await reader?.read();
		expect(new TextDecoder().decode(ping?.value)).toBe(
			ANTHROPIC_PRECOMMIT_RESCUE_PING_FRAME,
		);
		const winner = await reader?.read();
		expect(new TextDecoder().decode(winner?.value)).toBe("winner chunk");

		const timedOut = Symbol("timed out");
		const cancellation = reader?.cancel("downstream closed");
		const cancellationResult = await Promise.race([
			cancellation,
			delay(100).then((): typeof timedOut => timedOut),
		]);
		releaseWinnerCancellation.resolve();

		expect(cancellationResult).not.toBe(timedOut);
		expect(abortRouting).toHaveBeenCalledTimes(1);
		expect(winnerCancelCount).toBe(1);
	});

	it("consumes a late routing rejection after downstream cancellation", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		activation.activate();
		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});

		await response.body?.cancel("downstream closed");
		eventual.reject(new Error("late private rejection"));
		await delay(5);
		expect(abortRouting).toHaveBeenCalledTimes(1);
	});

	it("ends a rescue at its bounded commitment deadline and aborts routing once", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		activation.activate();

		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 20,
			},
		});
		const body = await response.text();

		expect(body).toEndWith(ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME);
		expect(abortRouting).toHaveBeenCalledTimes(1);
	});

	it("cancels a response that resolves after the rescue deadline exactly once", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		let lateBodyCancelCount = 0;
		activation.activate();

		const response = await coordinateAnthropicPreCommitRescue({
			response: eventual.promise,
			activation: activation.promise,
			abortRouting,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 20,
			},
		});
		const body = await response.text();
		expect(body.match(/event: error/g)).toHaveLength(1);

		eventual.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						lateBodyCancelCount++;
					},
				}),
				{
					headers: { "content-type": "text/event-stream" },
				},
			),
		);
		await delay(5);

		expect(abortRouting).toHaveBeenCalledTimes(1);
		expect(lateBodyCancelCount).toBe(1);
	});

	it("consumes a routing rejection that arrives after the rescue deadline", async () => {
		const activation = createAnthropicPreCommitRescueActivation();
		const eventual = deferred<Response>();
		const abortRouting = mock((_reason?: unknown) => undefined);
		const unhandledRejection = mock(
			(_reason: unknown, _promise: Promise<unknown>) => undefined,
		);
		activation.activate();
		process.on("unhandledRejection", unhandledRejection);

		try {
			const response = await coordinateAnthropicPreCommitRescue({
				response: eventual.promise,
				activation: activation.promise,
				abortRouting,
				config: {
					activationGraceMs: 1,
					pingIntervalMs: 5,
					commitmentDeadlineMs: 20,
				},
			});
			await response.text();

			eventual.reject(new Error("late private rejection"));
			await delay(5);
			expect(unhandledRejection).not.toHaveBeenCalled();
			expect(abortRouting).toHaveBeenCalledTimes(1);
		} finally {
			process.off("unhandledRejection", unhandledRejection);
		}
	});
});
