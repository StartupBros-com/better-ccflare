import { describe, expect, test } from "bun:test";
import { MAX_REQUEST_BODY_BYTES } from "@better-ccflare/core";
import {
	BODY_ADMISSION_RESERVATION_MULTIPLIER,
	BodyAdmissionController,
	MAX_BODY_ADMISSION_RESERVATION_BYTES,
	withBodyAdmission,
} from "./body-admission";
import { abortInflightStreams, trackStreamForShutdown } from "./server";

function post(
	body: string,
	headers: HeadersInit = {},
	signal?: AbortSignal,
): Request {
	return new Request("http://localhost/v1/messages", {
		method: "POST",
		headers,
		body,
		signal,
	});
}

function endlessResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				controller.enqueue(new TextEncoder().encode("tick"));
				await new Promise((resolve) => setTimeout(resolve, 20));
			},
		}),
	);
}

describe("withBodyAdmission", () => {
	test("does not let direct or Responses-style handlers start until their lease is admitted", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 8 });
		const held = await controller.acquire(8);
		let directCalled = false;
		let responsesCalled = false;
		const direct = withBodyAdmission(
			post("x", { "content-length": "1" }),
			controller,
			async () => {
				directCalled = true;
				return new Response("direct");
			},
		);
		const responses = withBodyAdmission(
			post("x", { "content-length": "1" }),
			controller,
			async () => {
				responsesCalled = true;
				return new Response("responses");
			},
		);
		await Promise.resolve();
		expect(directCalled).toBe(false);
		expect(responsesCalled).toBe(false);
		held.release();
		expect(await (await direct).text()).toBe("direct");
		expect(await (await responses).text()).toBe("responses");
	});

	test("keeps a full Responses lease through translation, then admits sized work while its stream remains open", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 16 });
		let responsesLease:
			| Parameters<Parameters<typeof withBodyAdmission>[2]>[0]
			| undefined;
		const responses = await withBodyAdmission(
			post("x", { "content-length": "1" }),
			controller,
			async (lease) => {
				responsesLease = lease;
				expect(controller.snapshot().reservedBytes).toBe(16);
				return endlessResponse();
			},
			{ forceFull: true },
		);
		let directStarted = false;
		const direct = withBodyAdmission(
			post("x", { "content-length": "1" }),
			controller,
			async () => {
				directStarted = true;
				return endlessResponse();
			},
		);
		await Promise.resolve();
		expect(directStarted).toBe(false);

		responsesLease?.reduceTo(8);
		const directResponse = await direct;
		expect(directStarted).toBe(true);
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 16,
			activeLeases: 2,
		});

		await responses.body?.cancel();
		await directResponse.body?.cancel();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
		});
	});

	test("holds the worst-case reservation for a forceFull Responses request under a larger budget, then downgrades to 8x the actual size once known", async () => {
		const budgetBytes = 1024 * 1024 * 1024; // 1 GiB, well above the worst-case cap
		const controller = new BodyAdmissionController({ budgetBytes });
		let responsesLease:
			| Parameters<Parameters<typeof withBodyAdmission>[2]>[0]
			| undefined;
		const responses = await withBodyAdmission(
			post("x", { "content-length": "1" }),
			controller,
			async (lease) => {
				responsesLease = lease;
				// Held at the capped worst case, not the whole 1 GiB budget, while
				// read + decompress + parse + translate are in flight.
				expect(controller.snapshot().reservedBytes).toBe(
					MAX_BODY_ADMISSION_RESERVATION_BYTES,
				);
				return endlessResponse();
			},
			{ forceFull: true },
		);

		// onBodySizeKnown fires once the actual body size is known and downgrades
		// the reservation to 8x that size, mirroring the Responses route call site.
		const actualBytes = 4096;
		responsesLease?.reduceTo(
			Math.min(
				controller.snapshot().budgetBytes,
				actualBytes * BODY_ADMISSION_RESERVATION_MULTIPLIER,
			),
		);
		expect(controller.snapshot().reservedBytes).toBe(
			actualBytes * BODY_ADMISSION_RESERVATION_MULTIPLIER,
		);

		await responses.body?.cancel();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
		});
	});

	test("admits four worst-case forceFull leases concurrently at the managed 1 GiB budget, queuing and draining a fifth FIFO", async () => {
		const budgetBytes = 1024 * 1024 * 1024; // 1 GiB
		const controller = new BodyAdmissionController({ budgetBytes });
		const started: boolean[] = [];
		const requests = Array.from({ length: 4 }, (_, index) =>
			withBodyAdmission(
				post("x", { "content-length": String(MAX_REQUEST_BODY_BYTES) }),
				controller,
				async () => {
					started[index] = true;
					return endlessResponse();
				},
				{ forceFull: true },
			),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(started).toEqual([true, true, true, true]);
		expect(controller.snapshot()).toMatchObject({
			activeLeases: 4,
			reservedBytes: 4 * MAX_BODY_ADMISSION_RESERVATION_BYTES,
			queuedRequests: 0,
		});

		let fifthStarted = false;
		const fifth = withBodyAdmission(
			post("x", { "content-length": String(MAX_REQUEST_BODY_BYTES) }),
			controller,
			async () => {
				fifthStarted = true;
				return endlessResponse();
			},
			{ forceFull: true },
		);
		await Promise.resolve();
		expect(fifthStarted).toBe(false);
		expect(controller.snapshot().queuedRequests).toBe(1);

		const responses = await Promise.all(requests);
		await responses[0].body?.cancel();
		await fifth.then(async (response) => {
			expect(fifthStarted).toBe(true);
			await response.body?.cancel();
		});
		for (const response of responses.slice(1)) await response.body?.cancel();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			queuedRequests: 0,
		});
	});

	test("releases a resized lease when handler work fails before a response exists", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 8 });
		await expect(
			withBodyAdmission(
				post("x", { "content-length": "1" }),
				controller,
				async (lease) => {
					lease.reduceTo(4);
					throw new Error("translation failed");
				},
				{ forceFull: true },
			),
		).rejects.toThrow("translation failed");
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			counters: { released: 1 },
		});
	});

	test("returns a bounded local 503 before body reads or provider work when admission is full", async () => {
		const controller = new BodyAdmissionController({
			budgetBytes: 8,
			queueLimit: 0,
		});
		const held = await controller.acquire(8);
		let called = false;
		const response = await withBodyAdmission(
			post("x", { "content-length": "1", "content-encoding": "gzip" }),
			controller,
			async () => {
				called = true;
				return new Response("unexpected");
			},
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(response.headers.get("content-length")).toBeNull();
		expect(called).toBe(false);
		expect(controller.snapshot().counters.queueFull).toBe(1);
		held.release();
	});

	test("preserves the exact downstream reader authority and releases no-body responses immediately", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 16 });
		const response = await withBodyAdmission(
			post("x", { "content-length": "1" }),
			controller,
			async () => new Response(null),
		);
		expect(response.body).toBeNull();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			counters: { admitted: 1, released: 1 },
		});
	});

	test("holds streaming responses through close, error, cancel, and shutdown exactly once", async () => {
		const closeController = new BodyAdmissionController({ budgetBytes: 8 });
		const closeResponse = await withBodyAdmission(
			post("x", { "content-length": "1" }),
			closeController,
			async () => new Response("ok"),
		);
		expect(closeController.snapshot().activeLeases).toBe(1);
		expect(await closeResponse.text()).toBe("ok");
		expect(closeController.snapshot().counters.released).toBe(1);

		const errorController = new BodyAdmissionController({ budgetBytes: 8 });
		const errorResponse = await withBodyAdmission(
			post("x", { "content-length": "1" }),
			errorController,
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("broken"));
						},
					}),
				),
		);
		await expect(errorResponse.text()).rejects.toThrow("broken");
		expect(errorController.snapshot().counters.released).toBe(1);

		const cancelController = new BodyAdmissionController({ budgetBytes: 8 });
		const cancelResponse = await withBodyAdmission(
			post("x", { "content-length": "1" }),
			cancelController,
			async () => endlessResponse(),
		);
		const cancelBody = cancelResponse.body;
		if (!cancelBody) throw new Error("Expected streaming response body");
		await cancelBody.cancel();
		expect(cancelController.snapshot().counters.released).toBe(1);

		const shutdownController = new BodyAdmissionController({ budgetBytes: 8 });
		const shutdownResponse = trackStreamForShutdown(
			await withBodyAdmission(
				post("x", { "content-length": "1" }),
				shutdownController,
				async () => endlessResponse(),
			),
		);
		expect(shutdownController.snapshot().activeLeases).toBe(1);
		const shutdownBody = shutdownResponse.body;
		if (!shutdownBody) throw new Error("Expected streaming response body");
		const shutdownReader = shutdownBody.getReader();
		await shutdownReader.read();
		const { aborted, settled } = abortInflightStreams();
		expect(aborted).toBe(1);
		await settled;
		expect(shutdownController.snapshot()).toMatchObject({
			activeLeases: 0,
			counters: { released: 1 },
		});
		void shutdownReader.cancel().catch(() => {});
		expect(shutdownController.snapshot().counters.released).toBe(1);
	});

	test("removes aborted queued requests without invoking their handler", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 8 });
		const held = await controller.acquire(8);
		const aborter = new AbortController();
		let called = false;
		const pending = withBodyAdmission(
			post("x", { "content-length": "1" }, aborter.signal),
			controller,
			async () => {
				called = true;
				return new Response("unexpected");
			},
		);
		aborter.abort();
		await expect(pending).rejects.toBeDefined();
		expect(called).toBe(false);
		held.release();
	});
});
