import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import {
	getResponseDrainTransport,
	registerResponseDrainTransport,
	transferResponseDrainTransport,
} from "@better-ccflare/providers/stream-drain";
import { AnthropicProvider } from "../../../../providers/src/providers/anthropic/provider";
import { cancelDiscardedResponseBody } from "../discard-body-cancel";
import { makeProxyRequest } from "../request-handler";

const { wrapAnthropicPrecommitGatedResponse } = await import(
	"../proxy-operations"
);

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

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
		const transportSignals: AbortSignal[] = [];
		let fetchCount = 0;
		globalThis.fetch = mock(async (_input, init) => {
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) {
				throw new Error("expected fetch signal");
			}
			transportSignals.push(signal);
			fetchCount++;
			if (fetchCount === 1) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						signal.addEventListener(
							"abort",
							() => controller.error(signal.reason),
							{ once: true },
						);
					},
				});
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("later attempt");
		});

		const firstRaw = await makeProxyRequest(
			"https://provider.test/v1/messages",
			"GET",
			new Headers(),
			undefined,
			false,
		);
		const taggedRawResponse = new Response(firstRaw.body, {
			status: firstRaw.status,
			statusText: firstRaw.statusText,
			headers: new Headers(firstRaw.headers),
		});
		transferResponseDrainTransport(firstRaw, taggedRawResponse);
		const transformed = await new AnthropicProvider().processResponse(
			taggedRawResponse,
			null,
			new Headers(),
		);
		const laterResponse = await makeProxyRequest(
			"https://provider.test/v1/messages",
			"GET",
			new Headers(),
			undefined,
			false,
		);

		cancelDiscardedResponseBody(transformed, { deadlineMs: 10 });
		await Bun.sleep(50);

		expect(transportSignals[0]?.aborted).toBe(true);
		expect(transportSignals[1]?.aborted).toBe(false);
		expect(await laterResponse.text()).toBe("later attempt");
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
