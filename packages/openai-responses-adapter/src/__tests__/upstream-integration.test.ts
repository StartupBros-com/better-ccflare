import { expect, test } from "bun:test";
import { CodexProvider } from "../../../providers/src/providers/codex/provider";
import { handleResponsesRequest } from "../handler";

test("native client fields cross the trusted carrier without accepting a client response id", async () => {
	const fields = {
		stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
		client_metadata: { turn_id: "integration-turn" },
		access_programs: { cyber: "standard" },
	};
	let wire: Record<string, unknown> | undefined;
	const request = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "gpt-5.6-sol",
			input: "hello",
			previous_response_id: "untrusted",
			...fields,
		}),
	});
	await handleResponsesRequest(
		request,
		new URL(request.url),
		async (synthetic) => {
			const provider = new CodexProvider();
			const outgoing = await provider.transformRequestBody(synthetic, null);
			wire = (await outgoing.json()) as Record<string, unknown>;
			return Response.json({
				id: "msg",
				model: "gpt-5.6-sol",
				content: [{ type: "text", text: "ok" }],
				usage: {},
			});
		},
		{},
	);
	expect(wire).toMatchObject(fields);
	expect(wire?.previous_response_id).toBeUndefined();
});
