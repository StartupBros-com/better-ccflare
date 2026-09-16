import { expect, test } from "bun:test";
import { getTranslatedToolName } from "../custom-tools";
import { handleResponsesRequest } from "../handler";
import { translateRequestToAnthropic } from "../request-translator";
import type { ResponseItem, ResponsesRequest } from "../types";

const declarations = [
	{
		type: "namespace",
		name: "tools",
		tools: [
			{ type: "custom", name: "exec" },
			{ type: "function", name: "lookup", parameters: { type: "object" } },
		],
	},
];

async function requestWithChoice(
	choice: unknown,
	tools: unknown[] = declarations,
	additional = false,
) {
	let calls = 0;
	let outbound: Record<string, unknown> | undefined;
	const request = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "test",
			input: additional
				? [
						{ type: "additional_tools", tools },
						{ type: "message", role: "user", content: "hello" },
					]
				: "hello",
			...(additional ? {} : { tools }),
			tool_choice: choice,
		}),
	});
	const response = await handleResponsesRequest(
		request,
		new URL(request.url),
		async (synthetic) => {
			calls++;
			outbound = (await synthetic.json()) as Record<string, unknown>;
			return Response.json({
				id: "msg",
				model: "test",
				content: [{ type: "text", text: "ok" }],
				usage: {},
			});
		},
		{},
	);
	return { response, calls, outbound };
}

for (const choice of [
	{ type: "custom", namespace: "tools" },
	{ type: "custom", name: 123, namespace: "tools" },
	{ type: "custom", name: "", namespace: "tools" },
	{ type: "custom", name: "exec", namespace: 123 },
	{ type: "custom", name: "exec", namespace: null },
	{ type: "custom", name: "exec", namespace: "" },
	{ type: "custom", name: "exec", namespace: "wrong" },
	{ type: "function", name: "exec", namespace: "tools" },
	{ type: "function", name: "exec", namespace: "wrong" },
	{ type: "custom", name: "lookup", namespace: "tools" },
	{ type: "custom", name: "exec" },
	{ type: "function", name: "lookup" },
	null,
	[],
	{},
	4,
	"unknown-choice",
]) {
	test(`rejects malformed or undeclared forced choice ${JSON.stringify(choice)} before provider dispatch`, async () => {
		const { response, calls } = await requestWithChoice(choice);
		expect(response.status).toBe(400);
		expect(calls).toBe(0);
		expect(await response.json()).toMatchObject({
			type: "error",
			error: { type: "invalid_request_error" },
		});
	});
}

for (const kind of ["custom", "function"] as const) {
	for (const additional of [false, true]) {
		test(`honors exact ${kind} identity from ${additional ? "additional" : "regular"} tools`, async () => {
			const name = kind === "custom" ? "exec" : "lookup";
			const { response, calls, outbound } = await requestWithChoice(
				{ type: kind, name, namespace: "tools" },
				declarations,
				additional,
			);
			expect(response.status).toBe(200);
			expect(calls).toBe(1);
			expect(outbound?.tool_choice).toEqual({
				type: "tool",
				name: getTranslatedToolName(name, "tools"),
			});
		});
	}
	test(`honors an exact top-level ${kind} choice`, async () => {
		const { response, outbound } = await requestWithChoice(
			{ type: kind, name: "exec" },
			[{ type: kind, name: "exec" }],
		);
		expect(response.status).toBe(200);
		expect(outbound?.tool_choice).toEqual({ type: "tool", name: "exec" });
	});
}

test("validates the effective declaration kind after namespace deduplication", async () => {
	const tools = [
		...declarations,
		{ type: "function", name: "exec", namespace: "tools" },
	];
	expect(
		(
			await requestWithChoice(
				{ type: "custom", name: "exec", namespace: "tools" },
				tools,
			)
		).response.status,
	).toBe(400);
	expect(
		(
			await requestWithChoice(
				{ type: "function", name: "exec", namespace: "tools" },
				tools,
			)
		).response.status,
	).toBe(200);
});

test("direct translator safely ignores malformed named-choice shapes", () => {
	for (const choice of [
		null,
		{ type: "custom", namespace: "tools" },
		{ type: "function", name: 123, namespace: "tools" },
	]) {
		const input = {
			model: "test",
			input: [{ type: "message", role: "user", content: "hello" }],
			tools: declarations,
			tool_choice: choice,
		} as unknown as ResponsesRequest & { input: ResponseItem[] };
		expect(() => translateRequestToAnthropic(input)).not.toThrow();
		expect(translateRequestToAnthropic(input).tool_choice).toBeUndefined();
	}
});
