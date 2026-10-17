import { describe, expect, it } from "bun:test";
import {
	buildContinuationBody,
	createAdvisorEmulationDispatch,
	deriveInternalRequestId,
	type InternalDispatchRequest,
	interpretAdvisorSubCallResponse,
} from "./dispatch";

const ID = "srvtoolu_bccf_call_1";
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("advisor emulation dispatch", () => {
	it("derives per-kind request ids", () => {
		expect(deriveInternalRequestId("req", "adv", 2)).toBe("req:adv2");
		expect(deriveInternalRequestId("req", "cont", 1)).toBe("req:cont1");
	});

	it("projects the in-flight pair into the continuation tail", () => {
		const body = buildContinuationBody(
			{ model: "m", messages: [{ role: "user", content: "hi" }] },
			[
				{ type: "text", text: "Checking." },
				{ type: "server_tool_use", id: ID, name: "advisor", input: {} },
				{
					type: "advisor_tool_result",
					tool_use_id: ID,
					content: { type: "advisor_result", text: "advice" },
				},
			],
		) as { messages: Array<{ role: string; content: unknown }> };
		expect(body.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(body.messages[1]?.content).toEqual([
			{ type: "text", text: "Checking." },
			{ type: "tool_use", id: ID, name: "advisor", input: {} },
		]);
		expect(body.messages[2]?.content).toEqual([
			{ type: "tool_result", tool_use_id: ID, content: "advice" },
		]);
	});

	it("maps sub-call responses to outcomes", async () => {
		const ok = await interpretAdvisorSubCallResponse(
			json({
				type: "message",
				content: [{ type: "text", text: " go " }],
				usage: { input_tokens: 4, output_tokens: 2 },
			}),
			"gpt-6-astra",
		);
		expect(ok.content).toEqual({ type: "advisor_result", text: "go" });
		expect(ok.usage).toEqual({ input_tokens: 4, output_tokens: 2 });

		const limited = await interpretAdvisorSubCallResponse(
			json({ error: { type: "rate_limit_error" } }, 429),
			"gpt-6-astra",
		);
		expect(limited.content).toEqual({
			type: "advisor_tool_result_error",
			error_code: "too_many_requests",
		});

		const tooLong = await interpretAdvisorSubCallResponse(
			json({ error: { code: "context_length_exceeded" } }, 400),
			"gpt-6-astra",
		);
		expect(tooLong.content).toMatchObject({ error_code: "prompt_too_long" });

		const empty = await interpretAdvisorSubCallResponse(
			json({ type: "message", content: [] }),
			"gpt-6-astra",
		);
		expect(empty.content).toMatchObject({ error_code: "unavailable" });

		const folded = await interpretAdvisorSubCallResponse(
			json({ type: "error", error: { type: "overloaded_error" } }),
			"gpt-6-astra",
		);
		expect(folded.content).toMatchObject({ error_code: "overloaded" });
	});

	it("sends a toolless advisor body and a stream:true continuation with derived ordinals", async () => {
		const sent: InternalDispatchRequest[] = [];
		const dispatch = createAdvisorEmulationDispatch({
			workerBody: {
				model: "m",
				stream: true,
				tools: [{ name: "advisor" }],
				messages: [{ role: "user", content: "hi" }],
			},
			decision: { advisorModel: "gpt-6-astra", declarationModel: "fable" },
			cacheKeySeed: "s",
			workerModel: "gpt-5.6-sol",
			send: async (request) => {
				sent.push(request);
				return request.kind === "adv"
					? json({ type: "message", content: [{ type: "text", text: "ok" }] })
					: new Response("x");
			},
		});
		const signal = new AbortController().signal;
		await dispatch.runAdvisor({
			round: 1,
			inflightAssistantContent: [],
			signal,
		});
		await dispatch.runContinuation({
			round: 1,
			inflightAssistantContent: [{ type: "text", text: "t" }],
			signal,
		});
		expect(sent.map((s) => `${s.kind}${s.ordinal}`)).toEqual(["adv1", "cont1"]);
		expect(sent[0]?.body.tools).toBeUndefined();
		expect(sent[0]?.body.model).toBe("gpt-6-astra");
		expect(sent[0]?.finalModel).toBe("gpt-6-astra");
		expect(sent[1]?.body.stream).toBe(true);
		expect(sent[1]?.body.tools).toEqual([{ name: "advisor" }]);
		expect(sent[1]?.finalModel).toBe("gpt-5.6-sol");
	});
});
