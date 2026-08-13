import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { RequestMeta } from "@better-ccflare/types";
import { ANTHROPIC_DRAIN_DEADLINE_MS } from "../../anthropic-terminal-recovery";
import { proxyUnauthenticated } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

const originalFetch = globalThis.fetch;

function fetchSignal(
	input: RequestInfo | URL,
	init?: RequestInit,
): AbortSignal {
	const signal = input instanceof Request ? input.signal : init?.signal;
	if (!signal) throw new Error("Expected upstream fetch to receive a signal");
	return signal;
}

describe("proxyUnauthenticated abort lifecycle", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("propagates caller abort to the string-target request without wrapping it as 502", async () => {
		const caller = new AbortController();
		const abortReason = new DOMException("client disconnected", "AbortError");
		let upstreamSignal: AbortSignal | undefined;
		let rejectUpstream: ((reason: unknown) => void) | undefined;

		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			upstreamSignal = fetchSignal(input, init);
			return new Promise<Response>((_resolve, reject) => {
				rejectUpstream = reject;
				if (upstreamSignal?.aborted) {
					reject(upstreamSignal.reason);
					return;
				}
				upstreamSignal?.addEventListener(
					"abort",
					() => reject(upstreamSignal?.reason),
					{ once: true },
				);
			});
		}) as typeof fetch;

		const req = new Request("https://proxy.test/v1/messages", {
			method: "GET",
			signal: caller.signal,
		});
		const requestMeta: RequestMeta = {
			id: "abort-test",
			method: req.method,
			path: "/v1/messages",
			timestamp: Date.now(),
		};
		const ctx = {
			provider: {
				name: "test-provider",
				buildUrl: (path: string, search: string) =>
					`https://provider.test${path}${search}`,
				prepareHeaders: (headers: Headers) => new Headers(headers),
			},
		} as unknown as ProxyContext;

		const responsePromise = proxyUnauthenticated(
			req,
			new URL(req.url),
			requestMeta,
			null,
			() => undefined,
			ctx,
		);
		await Promise.resolve();
		expect(upstreamSignal).toBeDefined();

		caller.abort(abortReason);
		await Promise.resolve();
		const abortPropagated = upstreamSignal?.aborted === true;
		if (!abortPropagated) rejectUpstream?.(abortReason);
		const rejection = await responsePromise.then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(abortPropagated).toBe(true);
		expect(upstreamSignal?.reason).toBe(req.signal.reason);
		expect(rejection).toBe(req.signal.reason);
	});

	it("aborts the exact unauthenticated fetch signal when terminal draining reaches its deadline", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [callback, delay, ...rest] = args;
			return originalSetTimeout(
				callback,
				delay === ANTHROPIC_DRAIN_DEADLINE_MS ? 10 : delay,
				...rest,
			);
		}) as typeof setTimeout);
		let upstreamSignal: AbortSignal | undefined;
		globalThis.fetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				upstreamSignal = fetchSignal(input, init);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
								),
							);
							// Stay open until the drain deadline aborts the fetch signal.
						},
					}),
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		) as unknown as typeof globalThis.fetch;

		try {
			const req = new Request("https://proxy.test/v1/messages", {
				method: "POST",
				headers: {
					"x-better-ccflare-auto-refresh": "true",
					"x-better-ccflare-internal-probe-secret": "test-secret",
				},
			});
			const requestMeta: RequestMeta = {
				id: "unauthenticated-drain-abort",
				method: req.method,
				path: "/v1/messages",
				timestamp: Date.now(),
			};
			const ctx = {
				strategy: {},
				dbOps: {},
				runtime: { port: 8080, clientId: "test" },
				provider: {
					name: "test-provider",
					buildUrl: (path: string, search: string) =>
						`https://provider.test${path}${search}`,
					prepareHeaders: (headers: Headers) => new Headers(headers),
					isStreamingResponse: () => true,
				},
				refreshInFlight: new Map(),
				asyncWriter: {},
				config: { getStorePayloads: () => false },
				internalProbeSecret: "test-secret",
			} as unknown as ProxyContext;

			const response = await proxyUnauthenticated(
				req,
				new URL(req.url),
				requestMeta,
				null,
				() => undefined,
				ctx,
			);
			expect(upstreamSignal).toBeDefined();
			expect(upstreamSignal?.aborted).toBe(false);
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			await expect(reader?.read()).resolves.toMatchObject({ done: false });
			await reader?.cancel("client disconnect");

			expect(upstreamSignal?.aborted).toBe(true);
		} finally {
			timeoutSpy.mockRestore();
		}
	});
});
