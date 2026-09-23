import { afterEach, describe, expect, test } from "bun:test";
import {
	CODEX_AFFINITY_HEADERS_ENV,
	CODEX_ROUTING_HINT_HEADER,
	CODEX_SESSION_ID_HEADER,
	CODEX_THREAD_ID_HEADER,
} from "./affinity-headers";
import { resetOrchestrationElectionForTest } from "./orchestration-election";
import {
	CODEX_DEFAULT_ENDPOINT,
	CODEX_NATIVE_RESPONSES_HEADER,
	CodexProvider,
} from "./provider";

const account = {
	id: "account-a",
	name: "codex-test",
	provider: "codex",
	custom_endpoint: null,
	model_mappings: JSON.stringify({ sonnet: "gpt-5.6-sol" }),
} as Parameters<CodexProvider["transformRequestBody"]>[1];
const sessionId = "11111111-1111-4111-8111-111111111111";
const physicalModel = "gpt-5.6-sol";

function requestFor(
	extraHeaders: Record<string, string> = {},
	options: { url?: string; session?: string | null } = {},
): Request {
	const { url = CODEX_DEFAULT_ENDPOINT, session = sessionId } = options;
	return new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-request-id": "req-1",
			"x-better-ccflare-attempt-id": "att-1",
			"x-better-ccflare-attempt-ordinal": "1",
			"x-better-ccflare-attempt-cause": "initial",
			"x-better-ccflare-final-model": physicalModel,
			...extraHeaders,
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			max_tokens: 100,
			stream: true,
			system: "Keep the same turn.",
			...(session
				? { metadata: { user_id: JSON.stringify({ session_id: session }) } }
				: {}),
			messages: [{ role: "user", content: "inspect the cache" }],
		}),
	});
}

async function transform(request: Request) {
	const provider = new CodexProvider();
	const transformed = await provider.transformRequestBody(request, account);
	const body = JSON.parse(await transformed.text()) as {
		prompt_cache_key?: string;
		model: string;
	};
	return { headers: transformed.headers, body };
}

afterEach(() => {
	delete process.env[CODEX_AFFINITY_HEADERS_ENV];
	resetOrchestrationElectionForTest();
});

describe("CodexProvider cache affinity headers", () => {
	test("legacy /v1/messages: session-id and thread-id carry the prompt_cache_key and the hint names the physical model", async () => {
		const { headers, body } = await transform(requestFor());
		expect(typeof body.prompt_cache_key).toBe("string");
		expect(body.model).toBe(physicalModel);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(body.prompt_cache_key);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe(body.prompt_cache_key);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(
			`model=${physicalModel}`,
		);
	});

	test("consecutive turns of one conversation share the same session-id", async () => {
		const first = await transform(requestFor());
		const second = await transform(requestFor());
		expect(second.headers.get(CODEX_SESSION_ID_HEADER)).toBe(
			first.headers.get(CODEX_SESSION_ID_HEADER),
		);
	});

	test("a legacy client cannot steer affinity with its own headers", async () => {
		const { headers, body } = await transform(
			requestFor({
				[CODEX_SESSION_ID_HEADER]: "client-session",
				[CODEX_THREAD_ID_HEADER]: "client-thread",
				[CODEX_ROUTING_HINT_HEADER]: "model=gpt-6-astra",
			}),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(body.prompt_cache_key);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe(body.prompt_cache_key);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(
			`model=${physicalModel}`,
		);
	});

	test("native /v1/responses keeps the client's own identity while the hint follows the resolved model", async () => {
		const { headers } = await transform(
			requestFor({
				[CODEX_NATIVE_RESPONSES_HEADER]: "1",
				[CODEX_SESSION_ID_HEADER]: "01a0cde1-10f5-73b3-ab86-91727aaef071",
				[CODEX_THREAD_ID_HEADER]: "01a0cde1-a61d-7263-a120-d3ed3423b2b5",
				[CODEX_ROUTING_HINT_HEADER]: "model=gpt-6-astra",
			}),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe(
			"01a0cde1-10f5-73b3-ab86-91727aaef071",
		);
		expect(headers.get(CODEX_THREAD_ID_HEADER)).toBe(
			"01a0cde1-a61d-7263-a120-d3ed3423b2b5",
		);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(
			`model=${physicalModel}`,
		);
	});

	test("without a session id there is no key and no session headers, but the hint still routes", async () => {
		const { headers, body } = await transform(
			requestFor(
				{ [CODEX_SESSION_ID_HEADER]: "client-session" },
				{
					session: null,
				},
			),
		);
		expect(body.prompt_cache_key).toBeUndefined();
		expect(headers.has(CODEX_SESSION_ID_HEADER)).toBe(false);
		expect(headers.has(CODEX_THREAD_ID_HEADER)).toBe(false);
		expect(headers.get(CODEX_ROUTING_HINT_HEADER)).toBe(
			`model=${physicalModel}`,
		);
	});

	test("off the subscription endpoint the headers are left untouched", async () => {
		const { headers } = await transform(
			requestFor(
				{ [CODEX_SESSION_ID_HEADER]: "client-session" },
				{ url: "https://api.openai.com/v1/responses" },
			),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe("client-session");
		expect(headers.has(CODEX_ROUTING_HINT_HEADER)).toBe(false);
	});

	test("kill switch restores pass-through", async () => {
		process.env[CODEX_AFFINITY_HEADERS_ENV] = "0";
		const { headers } = await transform(
			requestFor({ [CODEX_SESSION_ID_HEADER]: "client-session" }),
		);
		expect(headers.get(CODEX_SESSION_ID_HEADER)).toBe("client-session");
		expect(headers.has(CODEX_ROUTING_HINT_HEADER)).toBe(false);
	});
});
