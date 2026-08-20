import { describe, expect, test } from "bun:test";
import { MAX_REQUEST_BODY_BYTES } from "@better-ccflare/core";
import {
	BODY_ADMISSION_RESERVATION_MULTIPLIER,
	BodyAdmissionController,
	BodyAdmissionQueueFullError,
	BodyAdmissionShuttingDownError,
	bodyAdmissionReservationBytes,
} from "./body-admission";

const MiB = 1024 * 1024;

describe("bodyAdmissionReservationBytes", () => {
	test("weights canonical unencoded Content-Length by eight without exceeding 32 MiB", () => {
		expect(
			bodyAdmissionReservationBytes(
				new Headers({ "content-length": String(1 * MiB) }),
			),
		).toBe(8 * MiB);
		expect(
			bodyAdmissionReservationBytes(
				new Headers({ "content-length": String(MAX_REQUEST_BODY_BYTES) }),
			),
		).toBe(8 * MAX_REQUEST_BODY_BYTES);
		expect(
			bodyAdmissionReservationBytes(new Headers({ "content-length": "0" })),
		).toBe(0);
	});

	test("reserves the complete budget for unsafe metadata and all encoded bodies", () => {
		const full = 256 * MiB;
		for (const headers of [
			new Headers(),
			new Headers({ "content-length": "-1" }),
			new Headers({ "content-length": "1.5" }),
			new Headers({ "content-length": "01" }),
			new Headers({ "content-length": String(Number.MAX_SAFE_INTEGER + 1) }),
			new Headers({ "content-length": String(MAX_REQUEST_BODY_BYTES + 1) }),
			new Headers({ "content-length": "1", "transfer-encoding": "chunked" }),
			...["gzip", "br", "deflate", "zstd", "identity, gzip", "identity;"].map(
				(contentEncoding) =>
					new Headers({
						"content-length": "1",
						"content-encoding": contentEncoding,
					}),
			),
		]) {
			expect(bodyAdmissionReservationBytes(headers)).toBe(full);
		}
	});
});

describe("BodyAdmissionController", () => {
	test("admits weighted reservations independently up to its budget", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 8 * MiB });
		const leases = await Promise.all(
			Array.from({ length: 8 }, () => controller.acquire(1 * MiB)),
		);
		expect(controller.snapshot()).toMatchObject({
			budgetBytes: 8 * MiB,
			reservedBytes: 8 * MiB,
			activeLeases: 8,
			peakReservedBytes: 8 * MiB,
			peakActiveLeases: 8,
			counters: { admitted: 8, queued: 0 },
		});
		for (const lease of leases) lease.release();
		expect(controller.snapshot().reservedBytes).toBe(0);
	});

	test("waits at full capacity, drains FIFO, and counts a queue-full rejection", async () => {
		const controller = new BodyAdmissionController({
			budgetBytes: 2,
			queueLimit: 2,
		});
		const first = await controller.acquire(2);
		const second = controller.acquire(2);
		const third = controller.acquire(2);
		await expect(controller.acquire(2)).rejects.toBeInstanceOf(
			BodyAdmissionQueueFullError,
		);
		expect(controller.snapshot()).toMatchObject({
			queuedRequests: 2,
			counters: { admitted: 1, queued: 2, queueFull: 1 },
		});

		first.release();
		const secondLease = await second;
		let thirdSettled = false;
		void third.then(() => {
			thirdSettled = true;
		});
		await Promise.resolve();
		expect(thirdSettled).toBe(false);
		secondLease.release();
		const thirdLease = await third;
		thirdLease.release();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			queuedRequests: 0,
		});
	});

	test("removes aborted queued work without invoking an admission and makes releases idempotent", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 1 });
		const held = await controller.acquire(1);
		const aborter = new AbortController();
		const queued = controller.acquire(1, aborter.signal);
		aborter.abort(new DOMException("gone", "AbortError"));
		await expect(queued).rejects.toThrow("gone");
		expect(controller.snapshot()).toMatchObject({
			queuedRequests: 0,
			counters: { queued: 1, queueAborted: 1 },
		});
		held.release();
		held.release();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			counters: { released: 1 },
		});
	});

	test("reduces a live lease once, drains its queued head, and ignores increases or release races", async () => {
		const controller = new BodyAdmissionController({
			budgetBytes: 10,
			queueLimit: 2,
		});
		const held = await controller.acquire(10);
		const head = controller.acquire(6);
		const tail = controller.acquire(2);

		held.reduceTo(4);
		const headLease = await head;
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 10,
			activeLeases: 2,
			queuedRequests: 1,
		});

		held.reduceTo(4);
		held.reduceTo(8);
		expect(controller.snapshot().reservedBytes).toBe(10);
		headLease.release();
		const tailLease = await tail;
		expect(controller.snapshot().reservedBytes).toBe(6);

		held.release();
		held.reduceTo(0);
		held.release();
		tailLease.release();
		expect(controller.snapshot()).toMatchObject({
			reservedBytes: 0,
			activeLeases: 0,
			counters: { released: 3 },
		});
	});

	test("keeps a 32 MiB translated body at the full reservation", async () => {
		const budgetBytes = 8 * MAX_REQUEST_BODY_BYTES;
		const controller = new BodyAdmissionController({ budgetBytes });
		const lease = await controller.acquire(budgetBytes);

		lease.reduceTo(
			Math.min(
				budgetBytes,
				MAX_REQUEST_BODY_BYTES * BODY_ADMISSION_RESERVATION_MULTIPLIER,
			),
		);
		expect(controller.snapshot().reservedBytes).toBe(budgetBytes);
		lease.release();
	});

	test("preserves FIFO when a reduction cannot admit the queued head", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 10 });
		const held = await controller.acquire(10);
		const head = controller.acquire(7);
		const tail = controller.acquire(4);
		let tailAdmitted = false;
		void tail.then(() => {
			tailAdmitted = true;
		});

		held.reduceTo(4);
		await Promise.resolve();
		expect(tailAdmitted).toBe(false);
		held.release();
		const headLease = await head;
		await Promise.resolve();
		expect(tailAdmitted).toBe(false);
		headLease.release();
		const tailLease = await tail;
		tailLease.release();
	});

	test("rejects queued and subsequent work once shutdown begins", async () => {
		const controller = new BodyAdmissionController({ budgetBytes: 1 });
		const held = await controller.acquire(1);
		const queued = controller.acquire(1);
		controller.shutdown();
		await expect(queued).rejects.toBeInstanceOf(BodyAdmissionShuttingDownError);
		await expect(controller.acquire(1)).rejects.toBeInstanceOf(
			BodyAdmissionShuttingDownError,
		);
		held.release();
		expect(controller.snapshot()).toMatchObject({
			activeLeases: 0,
			reservedBytes: 0,
		});
	});
});
