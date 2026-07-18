import { afterEach, describe, expect, it } from "bun:test";
import type { RequestMeta } from "@better-ccflare/types";
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
});
