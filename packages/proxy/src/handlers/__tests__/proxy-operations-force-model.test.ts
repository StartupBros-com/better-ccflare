import { describe, expect, test } from "bun:test";
import { forceModelInTransformedRequest } from "../proxy-operations";

describe("forceModelInTransformedRequest ownership", () => {
	test("preserves malformed bodies after consuming and rebuilding the source", async () => {
		const source = new Request("http://loopback.test/v1/messages", {
			method: "POST",
			headers: {
				"content-length": "999",
				"content-type": "application/json",
				"x-preserve": "yes",
			},
			body: "{not-json",
		});

		const rebuilt = await forceModelInTransformedRequest(source, "target-model");

		expect(source.bodyUsed).toBe(true);
		expect(rebuilt).not.toBe(source);
		expect(rebuilt.headers.get("x-preserve")).toBe("yes");
		expect(rebuilt.headers.get("content-length")).toBeNull();
		expect(await rebuilt.text()).toBe("{not-json");
	});
});
