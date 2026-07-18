/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import { makeProxyRequest } from "../request-handler";

interface ScheduledTimer {
	callback: TimerHandler;
	args: unknown[];
	delay: number | undefined;
	cleared: boolean;
	fired: boolean;
}

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

let nextTimerId = 1;
let scheduledTimers: Map<number, ScheduledTimer>;

function installControllableTimers(): void {
	nextTimerId = 1;
	scheduledTimers = new Map();

	globalThis.setTimeout = ((
		callback: TimerHandler,
		delay?: number,
		...args: unknown[]
	) => {
		const id = nextTimerId++;
		scheduledTimers.set(id, {
			callback,
			args,
			delay,
			cleared: false,
			fired: false,
		});
		return id;
	}) as typeof setTimeout;

	globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
		const timer = scheduledTimers.get(Number(id));
		if (timer) timer.cleared = true;
	}) as typeof clearTimeout;
}

function firePendingTimers(): void {
	for (const timer of scheduledTimers.values()) {
		if (timer.cleared || timer.fired) continue;
		timer.fired = true;
		if (typeof timer.callback === "function") {
			timer.callback(...timer.args);
		}
	}
}

function signalFromFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): AbortSignal {
	const signal = input instanceof Request ? input.signal : init?.signal;
	if (!signal) throw new Error("Expected upstream fetch to receive a signal");
	return signal;
}

function waitForAbort(signal: AbortSignal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

function proxyGet(signal?: AbortSignal): Promise<Response> {
	return makeProxyRequest(
		"https://provider.test/v1/messages",
		"GET",
		undefined,
		undefined,
		false,
		signal,
	);
}

describe("makeProxyRequest abort lifecycle", () => {
	beforeEach(() => {
		installControllableTimers();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	});

	it("enforces the response-header timeout even with an external signal", async () => {
		const externalController = new AbortController();
		let fetchSignal: AbortSignal | undefined;
		globalThis.fetch = (async (input, init) => {
			fetchSignal = signalFromFetch(input, init);
			return waitForAbort(fetchSignal);
		}) as typeof fetch;

		const responsePromise = proxyGet(externalController.signal);
		await Promise.resolve();

		expect([...scheduledTimers.values()].map((timer) => timer.delay)).toEqual([
			TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,
		]);
		firePendingTimers();

		await expect(responsePromise).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchSignal?.aborted).toBe(true);
		expect(externalController.signal.aborted).toBe(false);
	});

	it("preserves an external abort reason before response headers", async () => {
		const externalController = new AbortController();
		const abortReason = new DOMException("client disconnected", "AbortError");
		externalController.abort(abortReason);
		let fetchSignal: AbortSignal | undefined;
		globalThis.fetch = (async (input, init) => {
			fetchSignal = signalFromFetch(input, init);
			return waitForAbort(fetchSignal);
		}) as typeof fetch;

		const responsePromise = proxyGet(externalController.signal);

		await expect(responsePromise).rejects.toBe(abortReason);
		expect(fetchSignal?.aborted).toBe(true);
		expect(fetchSignal?.reason).toBe(abortReason);
		expect([...scheduledTimers.values()]).toHaveLength(1);
		expect([...scheduledTimers.values()][0]?.cleared).toBe(true);
	});

	it("keeps an external abort connected after response headers", async () => {
		const externalController = new AbortController();
		const abortReason = new DOMException("client disconnected", "AbortError");
		const firstChunk = new TextEncoder().encode("event: message_start\n\n");
		globalThis.fetch = (async (input, init) => {
			const signal = signalFromFetch(input, init);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(firstChunk);
					if (signal.aborted) {
						controller.error(signal.reason);
						return;
					}
					signal.addEventListener(
						"abort",
						() => controller.error(signal.reason),
						{ once: true },
					);
				},
			});
			return new Response(body);
		}) as typeof fetch;

		const response = await proxyGet(externalController.signal);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		expect(await reader?.read()).toEqual({ done: false, value: firstChunk });

		const pendingRead = reader?.read();
		externalController.abort(abortReason);

		await expect(pendingRead).rejects.toBe(abortReason);
	});

	it("clears the header timer without disconnecting a healthy body", async () => {
		const externalController = new AbortController();
		let fetchSignal: AbortSignal | undefined;
		globalThis.fetch = (async (input, init) => {
			fetchSignal = signalFromFetch(input, init);
			return new Response("healthy");
		}) as typeof fetch;

		const response = await proxyGet(externalController.signal);
		const timers = [...scheduledTimers.values()];
		expect(timers).toHaveLength(1);
		expect(timers[0]?.cleared).toBe(true);

		firePendingTimers();

		expect(fetchSignal?.aborted).toBe(false);
		expect(await response.text()).toBe("healthy");
		externalController.abort();
	});

	it("retains the response-header timeout without an external signal", async () => {
		let fetchSignal: AbortSignal | undefined;
		globalThis.fetch = (async (input, init) => {
			fetchSignal = signalFromFetch(input, init);
			return new Response("ok");
		}) as typeof fetch;

		const response = await proxyGet();

		expect(fetchSignal).toBeDefined();
		expect(fetchSignal?.aborted).toBe(false);
		expect([...scheduledTimers.values()]).toHaveLength(1);
		expect([...scheduledTimers.values()][0]?.cleared).toBe(true);
		expect(await response.text()).toBe("ok");
	});
});
