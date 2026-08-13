import { describe, expect, it } from "bun:test";
import {
	MAX_OAUTH_ERROR_INPUT_LENGTH,
	readBoundedOAuthResponseText,
} from "../oauth-response";

describe("readBoundedOAuthResponseText", () => {
	it("retains a normal structured OAuth error body", async () => {
		const payload = JSON.stringify({
			error: "invalid_grant",
			error_description: "refresh token expired",
		});
		const result = await readBoundedOAuthResponseText(new Response(payload));

		expect(result.text).toBe(payload);
		expect(result.bytesRead).toBe(new TextEncoder().encode(payload).byteLength);
		expect(result.truncated).toBe(false);
	});

	it("stops and cancels when an oversized chunk crosses the byte ceiling", async () => {
		let reads = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads += 1;
				if (reads === 1) {
					controller.enqueue(
						new TextEncoder().encode(
							`{"error":"invalid_grant","padding":"${"x".repeat(MAX_OAUTH_ERROR_INPUT_LENGTH)}"}`,
						),
					);
					return;
				}
				throw new Error(
					"the reader should cancel before requesting another chunk",
				);
			},
			cancel() {
				cancelled = true;
			},
		});

		const result = await readBoundedOAuthResponseText(
			new Response(stream, { status: 400 }),
		);

		expect(result.bytesRead).toBe(MAX_OAUTH_ERROR_INPUT_LENGTH);
		expect(result.text.length).toBeLessThanOrEqual(
			MAX_OAUTH_ERROR_INPUT_LENGTH,
		);
		expect(result.truncated).toBe(true);
		expect(cancelled).toBe(true);
		expect(reads).toBe(1);
	});

	it("conservatively marks an exact-boundary body as truncated", async () => {
		const payload = "x".repeat(MAX_OAUTH_ERROR_INPUT_LENGTH);
		const result = await readBoundedOAuthResponseText(new Response(payload));

		// The helper conservatively marks a chunk that exactly fills the bound as
		// truncated because it cannot issue an extra read without risking an
		// oversized allocation. This is the safe contract callers rely on.
		expect(result.bytesRead).toBe(MAX_OAUTH_ERROR_INPUT_LENGTH);
		expect(result.truncated).toBe(true);
	});
});
