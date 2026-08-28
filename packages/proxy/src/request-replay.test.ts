import { describe, expect, test } from "bun:test";

import {
	createRequestReplay,
	materializeRequestForTransport,
} from "./request-replay";

describe("request replay materialization", () => {
	test("consumes the source once and builds independent outbound and replay requests", async () => {
		const controller = new AbortController();
		const body = JSON.stringify({ model: "source-model", value: "payload" });
		const source = new Request("http://loopback.test/v1/messages?probe=1", {
			method: "POST",
			headers: {
				"content-length": "999",
				"content-type": "application/json",
				"x-preserve": "yes",
			},
			body,
			signal: controller.signal,
		});

		const materialized = await materializeRequestForTransport(source);

		expect(source.bodyUsed).toBe(true);
		expect(materialized.replay.bodyText).toBe(body);
		expect(materialized.request.url).toBe(source.url);
		expect(materialized.request.method).toBe("POST");
		expect(materialized.request.headers.get("content-type")).toBe(
			"application/json",
		);
		expect(materialized.request.headers.get("x-preserve")).toBe("yes");
		expect(materialized.request.headers.get("content-length")).toBeNull();
		expect(await materialized.request.text()).toBe(body);

		const firstReplay = materialized.replay.createRequest();
		const secondReplay = materialized.replay.createRequest();
		expect(await firstReplay.text()).toBe(body);
		expect(await secondReplay.text()).toBe(body);
		expect(secondReplay.headers.get("content-length")).toBeNull();

		controller.abort();
		expect(materialized.request.signal.aborted).toBe(true);
		expect(materialized.replay.createRequest().signal.aborted).toBe(true);
	});

	test("preserves null and empty body distinctions without stale content length", async () => {
		const withoutBody = await materializeRequestForTransport(
			new Request("http://loopback.test/no-body", {
				method: "POST",
				headers: { "content-length": "0" },
			}),
		);
		expect(withoutBody.replay.bodyText).toBeNull();
		expect(withoutBody.request.body).toBeNull();
		expect(withoutBody.request.headers.get("content-length")).toBeNull();
		expect(await withoutBody.replay.createRequest().text()).toBe("");

		const emptyBody = await materializeRequestForTransport(
			new Request("http://loopback.test/empty-body", {
				method: "POST",
				headers: { "content-length": "0" },
				body: "",
			}),
		);
		expect(emptyBody.replay.bodyText).toBe("");
		expect(emptyBody.request.headers.get("content-length")).toBeNull();
		expect(await emptyBody.request.text()).toBe("");
		expect(await emptyBody.replay.createRequest().text()).toBe("");
	});

	test("supports a lightweight metadata snapshot with replacement body and headers", async () => {
		const source = new Request("http://loopback.test/retry", {
			method: "POST",
			headers: {
				"content-length": "7",
				"x-source": "source",
			},
			body: "source",
		});
		const replay = createRequestReplay(source, null);
		const retry = replay.createRequest({
			body: "replayed",
			headers: new Headers({ "content-length": "123", "x-retry": "yes" }),
		});

		expect(source.bodyUsed).toBe(false);
		expect(retry.url).toBe(source.url);
		expect(retry.method).toBe(source.method);
		expect(retry.headers.get("x-source")).toBeNull();
		expect(retry.headers.get("x-retry")).toBe("yes");
		expect(retry.headers.get("content-length")).toBeNull();
		expect(await retry.text()).toBe("replayed");
	});

	test("rejects a consumed source instead of silently replaying an unknown body", async () => {
		const source = new Request("http://loopback.test/consumed", {
			method: "POST",
			body: "already-consumed",
		});
		await source.text();

		await expect(materializeRequestForTransport(source)).rejects.toThrow();
	});
});
