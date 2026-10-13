import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { peekSseForZai1305, SSE_PEEK_TIMEOUT_MS } from "../zai-1305";

afterEach(() => mock.restore());
describe("Zai peek deadline ownership", () => {
	for (const mode of ["eof", "match", "error", "timeout"] as const) {
		it(`allocates one deadline and clears it on ${mode}`, async () => {
			const clock = Date.now();
			spyOn(Date, "now").mockReturnValue(clock);
			const timers = spyOn(globalThis, "setTimeout");
			const clears = spyOn(globalThis, "clearTimeout");
			let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
			const encoder = new TextEncoder();
			const source = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					if (mode === "timeout") return;
					if (mode === "error") {
						c.error(new Error("source failed"));
						return;
					}
					c.enqueue(encoder.encode(": keepalive\n\n"));
					c.enqueue(
						encoder.encode(
							mode === "match"
								? 'data: {"error":{"code":1305}}\n\n'
								: 'data: {"ok":true}\n\n',
						),
					);
					c.close();
				},
			});
			const response = new Response(source);
			try {
				expect(await peekSseForZai1305(response)).toBe(mode === "match");
				const indices = timers.mock.calls.flatMap((args, index) =>
					args[1] === SSE_PEEK_TIMEOUT_MS ? [index] : [],
				);
				expect(indices).toHaveLength(1);
				for (const index of indices)
					expect(clears).toHaveBeenCalledWith(timers.mock.results[index].value);
			} finally {
				if (mode === "timeout") controller?.close();
				await response.text().catch(() => {});
			}
		});
	}
});
