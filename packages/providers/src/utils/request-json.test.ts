import { describe, expect, it, spyOn } from "bun:test";
import {
	transformRequestBodyModel,
	transformRequestBodyModelForce,
} from "./model-mapping";
import { readRequestJson } from "./request-json";

const body = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "hello" }],
	max_tokens: 16,
};

function makeRequest(): Request {
	return new Request("http://test.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("readRequestJson", () => {
	it("returns the parsed body and leaves the original request unconsumed", async () => {
		const request = makeRequest();

		expect(await readRequestJson(request)).toEqual(body);
		expect(request.bodyUsed).toBe(false);
		expect(await request.json()).toEqual(body);
	});

	it("rejects a non-JSON body", async () => {
		const request = new Request("http://test.com/v1/messages", {
			method: "POST",
			body: "not json",
		});

		await expect(readRequestJson(request)).rejects.toThrow();
		expect(request.bodyUsed).toBe(false);
	});

	// Regression guard for #382. The leak is specific to `.json()` on a cloned
	// Request under Bun 1.3.x. readRequestJson itself reads via a single
	// `clone().text()` — never `.json()`.
	it("never reads a cloned Request through .json()", async () => {
		const jsonSpy = spyOn(Request.prototype, "json");
		const textSpy = spyOn(Request.prototype, "text");
		try {
			await readRequestJson(makeRequest());

			expect(jsonSpy).not.toHaveBeenCalled();
			expect(textSpy).toHaveBeenCalledTimes(1);
		} finally {
			jsonSpy.mockRestore();
			textSpy.mockRestore();
		}
	});

	// The fork's model-mapping path is STRONGER than readRequestJson: it reads
	// the body via a single `arrayBuffer()` call and rebuilds the Request from
	// the bytes (see readBodyForTransform in ./model-mapping), avoiding
	// `request.clone()` entirely rather than relying on `.text()` release
	// semantics. This guards that the stronger contract survives — neither
	// `.json()` nor `.text()` may be used by the mapping path.
	it("the model-mapping path reads the body via arrayBuffer, never .json() or .text()", async () => {
		const jsonSpy = spyOn(Request.prototype, "json");
		const textSpy = spyOn(Request.prototype, "text");
		const arrayBufferSpy = spyOn(Request.prototype, "arrayBuffer");
		try {
			await transformRequestBodyModel(makeRequest(), undefined, (model) =>
				model === body.model ? "mapped-model" : model,
			);
			await transformRequestBodyModelForce(makeRequest(), "forced-model");

			expect(jsonSpy).not.toHaveBeenCalled();
			expect(textSpy).not.toHaveBeenCalled();
			expect(arrayBufferSpy).toHaveBeenCalledTimes(2);
		} finally {
			jsonSpy.mockRestore();
			textSpy.mockRestore();
			arrayBufferSpy.mockRestore();
		}
	});
});
