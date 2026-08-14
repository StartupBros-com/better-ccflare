import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	getResponseDrainTransport,
	registerResponseDrainTransport,
	transferResponseDrainTransport,
} from "@better-ccflare/providers/stream-drain";
import { AnthropicProvider } from "../../../../providers/src/providers/anthropic/provider";
import { makeProxyRequest } from "../request-handler";

// Keep this regression bound to the real helper even when a sibling suite uses
// Bun's process-global mock.module() for the canonical module specifier.
const { cancelDiscardedResponseBody } = await import(
	"../discard-body-cancel.ts?discard-body-deadline-test"
);
const { wrapAnthropicPrecommitGatedResponse } = await import(
	"../proxy-operations"
);

interface DrainDeadlineUpstream {
	url: string;
	firstDisconnected: Promise<void>;
	requestCount: number;
	secondRequestSignal: AbortSignal | undefined;
	stop: () => void;
}

function startDrainDeadlineUpstream(): DrainDeadlineUpstream {
	let requestCount = 0;
	let secondRequestSignal: AbortSignal | undefined;
	let resolveFirstDisconnected: () => void = () => {};
	const firstDisconnected = new Promise<void>((resolve) => {
		resolveFirstDisconnected = resolve;
	});
	let firstDisconnectRecorded = false;
	const recordFirstDisconnect = () => {
		if (firstDisconnectRecorded) return;
		firstDisconnectRecorded = true;
		resolveFirstDisconnected();
	};

	const server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			requestCount++;
			if (requestCount === 1) {
				request.signal.addEventListener("abort", recordFirstDisconnect, {
					once: true,
				});
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(": connection open\n\n"),
							);
						},
						cancel: recordFirstDisconnect,
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}

			if (requestCount === 2) {
				secondRequestSignal = request.signal;
				return new Response("later attempt");
			}

			return new Response("unexpected request", { status: 500 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}/v1/messages`,
		firstDisconnected,
		get requestCount() {
			return requestCount;
		},
		get secondRequestSignal() {
			return secondRequestSignal;
		},
		stop: () => server.stop(true),
	};
}

async function waitForDisconnect(
	disconnected: Promise<void>,
	timeoutMs = 2_000,
): Promise<void> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			disconnected,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error("upstream connection did not abort")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

async function cancelBody(response: Response | undefined): Promise<void> {
	try {
		await response?.body?.cancel();
	} catch {
		// The response may already be locked or errored during deadline cleanup.
	}
}

describe("discarded response drain deadline", () => {
	it("transfers the exact transport to a precommit-gated wrapper without reading the source body", () => {
		let bodyAccesses = 0;
		const source = new Proxy(
			new Response(null, {
				status: 202,
				statusText: "Accepted",
				headers: { "x-upstream": "preserved" },
			}),
			{
				get(target, property) {
					if (property === "body") bodyAccesses += 1;
					return Reflect.get(target, property, target);
				},
			},
		);
		const gatedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const transportAbort = new AbortController();
		registerResponseDrainTransport(source, transportAbort);

		const gated = wrapAnthropicPrecommitGatedResponse(source, gatedBody);

		expect(getResponseDrainTransport(gated)).toBe(transportAbort);
		expect(bodyAccesses).toBe(0);
		expect(gated.status).toBe(202);
		expect(gated.statusText).toBe("Accepted");
		expect(gated.headers.get("x-upstream")).toBe("preserved");
	});

	it("aborts only the fetch that owns a transformed discarded body", async () => {
		const upstream = startDrainDeadlineUpstream();
		let firstRaw: Response | undefined;
		let taggedRawResponse: Response | undefined;
		let transformed: Response | undefined;
		let laterResponse: Response | undefined;

		try {
			firstRaw = await makeProxyRequest(
				upstream.url,
				"GET",
				new Headers(),
				undefined,
				false,
			);
			const firstTransport = getResponseDrainTransport(firstRaw);
			taggedRawResponse = new Response(firstRaw.body, {
				status: firstRaw.status,
				statusText: firstRaw.statusText,
				headers: new Headers(firstRaw.headers),
			});
			transferResponseDrainTransport(firstRaw, taggedRawResponse);
			transformed = await new AnthropicProvider().processResponse(
				taggedRawResponse,
				null,
				new Headers(),
			);
			laterResponse = await makeProxyRequest(
				upstream.url,
				"GET",
				new Headers(),
				undefined,
				false,
			);
			const laterTransport = getResponseDrainTransport(laterResponse);

			expect(upstream.requestCount).toBe(2);
			expect(firstTransport?.signal.aborted).toBe(false);
			expect(laterTransport?.signal.aborted).toBe(false);

			cancelDiscardedResponseBody(transformed, { deadlineMs: 10 });
			await waitForDisconnect(upstream.firstDisconnected);

			expect(firstTransport?.signal.aborted).toBe(true);
			expect(laterTransport?.signal.aborted).toBe(false);
			expect(upstream.secondRequestSignal?.aborted).toBe(false);
			expect(await laterResponse.text()).toBe("later attempt");
		} finally {
			upstream.stop();
			await cancelBody(transformed);
			await cancelBody(taggedRawResponse);
			await cancelBody(firstRaw);
			await cancelBody(laterResponse);
		}
	});

	it("transfers ownership at every proxy-operations same-body boundary only", () => {
		const source = readFileSync(
			"packages/proxy/src/handlers/proxy-operations.ts",
			"utf8",
		);
		expect(source).toContain(
			"transferResponseDrainTransport(rawResponse, taggedRawResponse);",
		);
		expect(source).toContain(
			"transferResponseDrainTransport(retryRaw, retryTaggedRaw);",
		);
		expect(source).toContain(
			"transferResponseDrainTransport(rawResponse, rescueTaggedRaw);",
		);
		expect(
			source.match(
				/wrapAnthropicPrecommitGatedResponse\(response, gatedBody\)/g,
			),
		).toHaveLength(2);
		expect(source.match(/transferResponseDrainTransport\(/g)).toHaveLength(4);
		expect(source).not.toMatch(
			/transferResponseDrainTransport\([^,\n]*\.clone\(\)/,
		);
	});
});
