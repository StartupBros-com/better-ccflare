import { expect, test } from "bun:test";
import { handleResponsesRequest } from "../handler";

for (const additional of [false, true]) {
	test(`rejects expanded ${additional ? "additional" : "regular"} tools within the handler byte limit`, async () => {
		const tools = [
			{
				type: "namespace",
				name: "tools",
				description: "x".repeat(1000),
				tools: Array.from({ length: 16 }, (_, i) => ({
					type: "function",
					name: `tool_${i}`,
				})),
			},
		];
		const raw = JSON.stringify({
			model: "test",
			input: additional
				? [
						{ type: "additional_tools", tools },
						{ type: "message", role: "user", content: "hello" },
					]
				: "hello",
			...(additional ? {} : { tools }),
		});
		const requestBodyLimit = 4096;
		expect(Buffer.byteLength(raw)).toBeLessThan(requestBodyLimit);
		const request = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: raw,
		});
		let calls = 0;
		let admitted = false;
		const response = await handleResponsesRequest(
			request,
			new URL(request.url),
			async () => {
				calls++;
				return Response.json({});
			},
			{},
			undefined,
			undefined,
			{
				requestBodyLimit,
				onBodySizeKnown: () => {
					admitted = true;
				},
			},
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			error: {
				type: "invalid_request_error",
				message: "Request body too large",
			},
		});
		expect(calls).toBe(0);
		expect(admitted).toBe(false);
	});
}

for (const description of [
	123,
	["untyped description"],
	{ text: "untyped description" },
]) {
	test(`rejects namespace description shape ${JSON.stringify(description)} before dispatch`, async () => {
		const request = new Request("http://localhost/v1/responses", {
			method: "POST",
			body: JSON.stringify({
				model: "test",
				input: "hello",
				tools: [
					{
						type: "namespace",
						name: "tools",
						description,
						tools: [{ type: "function", name: "exec" }],
					},
				],
			}),
		});
		let calls = 0;
		const response = await handleResponsesRequest(
			request,
			new URL(request.url),
			async () => {
				calls++;
				return Response.json({});
			},
			{},
		);
		expect(response.status).toBe(400);
		expect(calls).toBe(0);
	});
}
