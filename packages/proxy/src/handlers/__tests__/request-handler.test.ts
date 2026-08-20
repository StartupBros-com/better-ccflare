/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	CodexProvider,
	OpenAICompatibleProvider,
} from "@better-ccflare/providers";
import { prepareRequestBody, validateProviderPath } from "../request-handler";

describe("validateProviderPath", () => {
	it("accepts count_tokens for OpenAI-compatible provider", () => {
		expect(() =>
			validateProviderPath(
				new OpenAICompatibleProvider(),
				"/v1/messages/count_tokens",
			),
		).not.toThrow();
	});

	it("accepts count_tokens for Codex provider", () => {
		expect(() =>
			validateProviderPath(new CodexProvider(), "/v1/messages/count_tokens"),
		).not.toThrow();
	});
});

describe("prepareRequestBody", () => {
	it("replays the admitted binary body for each provider attempt", async () => {
		const payload = new Uint8Array([0, 255, 195, 169]);
		const request = new Request("https://proxy.test/v1/messages", {
			method: "POST",
			body: payload,
		});

		const prepared = await prepareRequestBody(request);
		const firstReplay = await new Response(
			prepared.createStream(),
		).arrayBuffer();
		const secondReplay = await new Response(
			prepared.createStream(),
		).arrayBuffer();

		expect([...new Uint8Array(prepared.buffer as ArrayBuffer)]).toEqual([
			...payload,
		]);
		expect([...new Uint8Array(firstReplay)]).toEqual([...payload]);
		expect([...new Uint8Array(secondReplay)]).toEqual([...payload]);
	});

	it("cancels a pending body admission when the client aborts", async () => {
		const controller = new AbortController();
		const reason = new DOMException("client disconnected", "AbortError");
		let startReading: (() => void) | undefined;
		const reading = new Promise<void>((resolve) => {
			startReading = resolve;
		});
		let cancellations = 0;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				startReading?.();
				return new Promise<void>(() => {});
			},
			cancel() {
				cancellations += 1;
			},
		});
		const request = new Request("https://proxy.test/v1/messages", {
			method: "POST",
			body,
			signal: controller.signal,
		});

		const prepared = prepareRequestBody(request);
		await reading;
		controller.abort(reason);

		await expect(prepared).rejects.toBe(reason);
		expect(cancellations).toBe(1);
	});
});
