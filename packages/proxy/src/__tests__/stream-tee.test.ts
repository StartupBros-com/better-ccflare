import { describe, expect, it, mock } from "bun:test";
import { teeStream } from "../stream-tee";

describe("teeStream terminal lifecycle", () => {
	it("reports downstream cancellation once and suppresses a pending pull completion", async () => {
		const terminalOrder: string[] = [];
		const upstreamCancel = mock(() => {
			terminalOrder.push("upstream_cancel");
		});
		const onClose = mock(() => undefined);
		const onError = mock(() => undefined);
		const onCancel = mock(() => {
			terminalOrder.push("on_cancel");
		});
		const upstream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise(() => undefined);
			},
			cancel: upstreamCancel,
		});
		const reader = teeStream(upstream, {
			onClose,
			onError,
			onCancel,
		}).getReader();

		const pendingRead = reader.read();
		await Promise.resolve();
		await reader.cancel("client disconnected");
		await pendingRead;
		await Promise.resolve();

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledWith("client disconnected");
		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(upstreamCancel).toHaveBeenCalledWith("client disconnected");
		expect(terminalOrder).toEqual(["on_cancel", "upstream_cancel"]);
		expect(onClose).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	it("still cancels upstream when the cancellation analytics callback throws", async () => {
		const upstreamCancel = mock(() => undefined);
		const upstream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise(() => undefined);
			},
			cancel: upstreamCancel,
		});
		const reader = teeStream(upstream, {
			onCancel() {
				throw new Error("analytics failed");
			},
		}).getReader();

		void reader.read();
		await Promise.resolve();
		await expect(reader.cancel("gone")).resolves.toBeUndefined();

		expect(upstreamCancel).toHaveBeenCalledTimes(1);
		expect(upstreamCancel).toHaveBeenCalledWith("gone");
	});
});
