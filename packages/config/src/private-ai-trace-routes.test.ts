import { afterEach, expect, test } from "bun:test";
import { getPrivateAiTraceRoutes } from "./index";

const original = process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
const accountId = "12345678-1234-4234-8234-123456789abc";
afterEach(() => {
	if (original === undefined) delete process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
	else process.env.PRIVATE_AI_TRACE_ROUTES_JSON = original;
});

test("private trace routes default off and accept only explicit account origins", () => {
	delete process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
	expect(getPrivateAiTraceRoutes().size).toBe(0);
	process.env.PRIVATE_AI_TRACE_ROUTES_JSON = JSON.stringify({
		[accountId]: "https://private.example:8443",
	});
	expect(getPrivateAiTraceRoutes().get(accountId)).toBe(
		"https://private.example:8443",
	);
});

test("invalid optional route config disables the entire map without throwing", () => {
	for (const raw of [
		"{",
		"null",
		"[]",
		"true",
		'"text"',
		JSON.stringify({ invalid: "https://private.example" }),
		...[
			42,
			null,
			"not-a-url",
			"file:///tmp",
			"https://private.example/path",
			"https://user:password@private.example",
			"https://private.example?query=1",
			"https://private.example#fragment",
			"https://private.example/",
		].map((origin) => JSON.stringify({ [accountId]: origin })),
		JSON.stringify({
			[accountId]: "https://private.example",
			invalid: "https://other.example",
		}),
	]) {
		process.env.PRIVATE_AI_TRACE_ROUTES_JSON = raw;
		expect(getPrivateAiTraceRoutes().size).toBe(0);
	}
});
