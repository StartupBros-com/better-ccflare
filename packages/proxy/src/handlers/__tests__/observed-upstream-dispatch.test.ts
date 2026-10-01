import { describe, expect, test } from "bun:test";
import type { Provider } from "@better-ccflare/providers";
import { forwardObservedUpstream } from "../observed-upstream";

const context = {
	requestId: "synthetic",
	account: null,
	sourceBody: null,
	sourceHeaders: new Headers(),
	nativeResponses: true,
	signal: new AbortController().signal,
};
describe("observational physical dispatch callback", () => {
	test.each([
		"http",
		"websocket",
	] as const)("marks authorized %s dispatch separately from SSE response", async (transport) => {
		const events: string[] = [];
		const provider = {
			observeUpstream: async () => ({
				dispatched: (value: string) => events.push(value),
				response: (response: Response) => response,
				error: () => {},
			}),
		} as unknown as Provider;
		const response = new Response("unchanged", {
			headers: { "content-type": "text/event-stream" },
		});
		const result = await forwardObservedUpstream(
			provider,
			new Request("https://example.invalid"),
			context,
			async (mark) => {
				expect(events).toEqual([]);
				mark(transport);
				return response;
			},
		);
		expect(result).toBe(response);
		expect(events).toEqual([transport]);
	});
	test("throwing dispatch observation cannot alter inference or mark a vetoed send", async () => {
		let called = 0;
		const provider = {
			observeUpstream: async () => ({
				dispatched: () => {
					called++;
					throw new Error("diagnostic");
				},
				response: (response: Response) => response,
				error: () => {},
			}),
		} as unknown as Provider;
		const original = new Response("unchanged");
		expect(
			await forwardObservedUpstream(
				provider,
				new Request("https://example.invalid"),
				context,
				async (mark) => {
					mark("http");
					return original;
				},
			),
		).toBe(original);
		expect(called).toBe(1);
		const veto = new Error("gate-veto");
		await expect(
			forwardObservedUpstream(
				provider,
				new Request("https://example.invalid"),
				context,
				async () => {
					throw veto;
				},
			),
		).rejects.toBe(veto);
		expect(called).toBe(1);
	});
});
