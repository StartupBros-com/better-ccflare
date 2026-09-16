import { expect, test } from "bun:test";
import { CodexProvider } from "../../../providers/src/providers/codex/provider";
import { getTranslatedToolName } from "../custom-tools";
import { handleResponsesRequest } from "../handler";

interface NativeWire {
	input: Array<Record<string, unknown> & { type?: string; call_id?: string }>;
	tools?: Record<string, unknown>[];
	tool_choice?: unknown;
}
interface BridgeBody {
	tools: { name: string }[];
	tool_choice?: unknown;
}

async function nativeRequest(
	body: Record<string, unknown>,
	attributed = false,
) {
	let wire: NativeWire | undefined;
	let bridge: BridgeBody | undefined;
	const request = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-native-responses": "forged",
			"x-better-ccflare-responses-adapter-secret": "forged",
		},
		body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", ...body }),
	});
	const response = await handleResponsesRequest(
		request,
		new URL(request.url),
		async (synthetic) => {
			bridge = await synthetic.clone().json();
			// Model the proxy's process-local adapter-secret check, which overwrites
			// the client marker before the provider sees the physical attempt.
			expect(
				synthetic.headers.get("x-better-ccflare-responses-adapter-secret"),
			).toBe("process-secret");
			const headers = new Headers(synthetic.headers);
			headers.set("x-better-ccflare-native-responses", "1");
			if (attributed) headers.set("x-better-ccflare-attributed-agent", "true");
			const outgoing = await new CodexProvider().transformRequestBody(
				new Request(synthetic, { headers }),
			);
			wire = await outgoing.json();
			return Response.json({
				id: "msg",
				model: "gpt-5.6-sol",
				content: [{ type: "text", text: "ok" }],
				usage: {},
			});
		},
		{ internalProbeSecret: "process-secret" },
	);
	expect(response.status).toBe(200);
	if (!wire || !bridge) throw new Error("expected one provider dispatch");
	return { wire, bridge };
}

for (const type of ["function", "custom"] as const) {
	for (const namespace of [undefined, "tools"]) {
		for (const additional of [false, true]) {
			test(`native ${type} ${namespace ?? "bare"} ${additional ? "additional" : "regular"} declaration and choice retain one identity`, async () => {
				const declaration = {
					type,
					name: "exec",
					...(type === "function" ? { parameters: { type: "object" } } : {}),
				};
				const tools = namespace
					? [{ type: "namespace", name: namespace, tools: [declaration] }]
					: [declaration];
				const choice = {
					type,
					name: "exec",
					...(namespace ? { namespace } : {}),
				};
				const { wire, bridge } = await nativeRequest({
					...(additional
						? {
								input: [
									{ type: "additional_tools", tools },
									{ role: "user", content: "hello" },
								],
							}
						: { tools }),
					tool_choice: choice,
				});
				expect(wire.tool_choice).toEqual(choice);
				if (additional) {
					expect(wire.input[0]).toEqual({ type: "additional_tools", tools });
					expect(wire.tools).toBeUndefined();
				} else expect(wire.tools).toEqual(tools);
				expect(bridge.tool_choice).toEqual({
					type: "tool",
					name: getTranslatedToolName("exec", namespace),
				});
				expect(bridge.tools[0].name).toBe(
					getTranslatedToolName("exec", namespace),
				);
			});
		}
		test(`native ${type} ${namespace ?? "bare"} history restores identity and output after ordinary conversion`, async () => {
			const { wire } = await nativeRequest({
				tools: [{ type, name: "exec", ...(namespace ? { namespace } : {}) }],
				input: [
					{ role: "user", content: "hello" },
					{
						type: type === "custom" ? "custom_tool_call" : "function_call",
						call_id: "call/id",
						name: "exec",
						...(namespace ? { namespace } : {}),
						...(type === "custom"
							? { input: "echo hi" }
							: { arguments: '{"command":"echo hi"}' }),
					},
					{
						type:
							type === "custom"
								? "custom_tool_call_output"
								: "function_call_output",
						call_id: "call/id",
						output: "done",
					},
				],
			});
			const call = wire.input.find((item) => item.type?.endsWith("_call"));
			const output = wire.input.find((item) => item.type?.endsWith("_output"));
			if (!call || !output) throw new Error("expected call and output");
			expect(call).toMatchObject({
				type: type === "custom" ? "custom_tool_call" : "function_call",
				name: "exec",
				...(namespace ? { namespace } : {}),
				...(type === "custom"
					? { input: "echo hi" }
					: { arguments: '{"command":"echo hi"}' }),
			});
			expect(call.call_id).not.toContain("/");
			expect(output).toMatchObject({
				type:
					type === "custom"
						? "custom_tool_call_output"
						: "function_call_output",
				call_id: call.call_id,
				output: "done",
			});
			if (type === "custom") expect(call.arguments).toBeUndefined();
		});
	}
}

test("incoming private carrier cannot replace validated native tools or choice", async () => {
	const { wire } = await nativeRequest({
		tools: [{ type: "custom", name: "exec" }],
		tool_choice: { type: "custom", name: "exec" },
		__better_ccflare_codex_passthrough: {
			tools: [{ type: "custom", name: "evil" }],
			tool_choice: { type: "custom", name: "evil" },
		},
	});
	expect(wire.tools).toEqual([{ type: "custom", name: "exec" }]);
	expect(wire.tool_choice).toEqual({ type: "custom", name: "exec" });
});

test("native declarations and forced choices cannot restore filtered orchestration tools", async () => {
	const { wire } = await nativeRequest(
		{
			tools: [
				{ type: "function", name: "Agent" },
				{ type: "function", name: "Read" },
			],
			tool_choice: { type: "function", name: "Agent" },
		},
		true,
	);
	expect(wire.tools).toEqual([{ type: "function", name: "Read" }]);
	expect(wire.tool_choice).toBeUndefined();
});

test("unverified private native metadata never replaces compatible declarations or choice", async () => {
	const outgoing = await new CodexProvider().transformRequestBody(
		new Request("http://localhost/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "test",
				messages: [{ role: "user", content: "hello" }],
				tools: [{ name: "safe", input_schema: { type: "object" } }],
				tool_choice: { type: "tool", name: "safe" },
				__better_ccflare_codex_passthrough: {
					tools: [{ type: "custom", name: "evil" }],
					tool_choice: { type: "custom", name: "evil" },
					additional_tools: [
						{
							type: "additional_tools",
							tools: [{ type: "custom", name: "evil" }],
						},
					],
				},
			}),
		}),
	);
	const wire = (await outgoing.json()) as NativeWire;
	expect(wire.tools).toMatchObject([{ type: "function", name: "safe" }]);
	expect(wire.tool_choice).toEqual({ type: "function", name: "safe" });
	expect(wire.input.some((item) => item.type === "additional_tools")).toBe(
		false,
	);
});
