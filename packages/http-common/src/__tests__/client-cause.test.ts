import { expect, it, spyOn } from "bun:test";
import { HttpError } from "@better-ccflare/errors";
import { HttpClient } from "../client";
import { errorResponse } from "../responses";

it("preserves the exact fetch AbortError while keeping the HTTP error response unchanged", async () => {
	const cause = new DOMException("synthetic aborted request", "AbortError");
	const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(cause);
	try {
		let caught: unknown;
		try {
			await new HttpClient().request("http://fixture.invalid");
		} catch (error) {
			caught = error;
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(caught).toBeInstanceOf(HttpError);
		expect((caught as Error).cause).toBe(cause);
		const response = errorResponse(caught);
		expect(response.status).toBe(408);
		expect(await response.json()).toEqual({ error: "Request timeout" });
	} finally {
		fetchSpy.mockRestore();
	}
});
