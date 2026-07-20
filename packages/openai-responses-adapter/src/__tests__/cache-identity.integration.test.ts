import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { CodexProvider } from "../../../providers/src/providers/codex/provider";
import {
	XAI_CACHE_NATIVE_ENV,
	XAI_CONV_ID_HEADER,
} from "../../../providers/src/providers/xai/cache-native";
import { XaiProvider } from "../../../providers/src/providers/xai/provider";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_cache_identity",
	type: "message",
	role: "assistant",
	model: "claude-sonnet-4-5",
	content: [{ type: "text", text: "ok" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 1 },
});

const SESSION_UUID = "11111111-1111-4111-8111-111111111111";

function request(
	overrides: Record<string, unknown> = {},
	headers: Record<string, string> = {},
): Request {
	return new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			model: "gpt-5",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "same first turn" }],
				},
			],
			stream: false,
			...overrides,
		}),
	});
}

async function captureSyntheticRequest(source: Request): Promise<Request> {
	let forwarded: Request | null = null;
	const capture: HandleProxyFn = async (synthetic) => {
		forwarded = synthetic;
		return new Response(ANTHROPIC_MESSAGE_BODY, {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};

	const response = await handleResponsesRequest(
		source,
		new URL(source.url),
		capture,
		{},
	);
	expect(response.status).toBe(200);
	expect(forwarded).not.toBeNull();
	return forwarded as unknown as Request;
}

async function canonicalUserId(source: Request): Promise<string | undefined> {
	const synthetic = await captureSyntheticRequest(source);
	const body = (await synthetic.json()) as {
		metadata?: { user_id?: string };
	};
	return body.metadata?.user_id;
}

async function codexCacheKey(source: Request): Promise<string | undefined> {
	const synthetic = await captureSyntheticRequest(source);
	const transformed = await new CodexProvider().transformRequestBody(synthetic);
	const body = (await transformed.json()) as { prompt_cache_key?: string };
	return body.prompt_cache_key;
}

const xaiAccount = {
	id: "xai-cache-integration",
	name: "xai-cache-integration",
	provider: "xai",
	custom_endpoint: null,
	model_mappings: null,
} as Account;

async function xaiCacheKey(source: Request): Promise<string | null> {
	const synthetic = await captureSyntheticRequest(source);
	const transformed = await new XaiProvider().transformRequestBody(
		synthetic,
		xaiAccount,
	);
	return transformed.headers.get(XAI_CONV_ID_HEADER);
}

describe("Responses cache identity protocol bridge", () => {
	let originalXaiCacheNative: string | undefined;
	let originalCodexCacheKey: string | undefined;

	beforeEach(() => {
		originalXaiCacheNative = process.env[XAI_CACHE_NATIVE_ENV];
		originalCodexCacheKey = process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		process.env[XAI_CACHE_NATIVE_ENV] = "1";
		process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = "1";
	});

	afterEach(() => {
		if (originalXaiCacheNative === undefined) {
			delete process.env[XAI_CACHE_NATIVE_ENV];
		} else {
			process.env[XAI_CACHE_NATIVE_ENV] = originalXaiCacheNative;
		}
		if (originalCodexCacheKey === undefined) {
			delete process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY;
		} else {
			process.env.CCFLARE_CODEX_PROMPT_CACHE_KEY = originalCodexCacheKey;
		}
	});

	it("gives Codex and xAI stable, distinct native keys for arbitrary prompt_cache_key values", async () => {
		const arbitrary = 'customer/session: 🔐 {"not":"a UUID"}';
		const other = "customer/session: other";

		const codexFirst = await codexCacheKey(
			request({ prompt_cache_key: arbitrary }),
		);
		const codexRepeated = await codexCacheKey(
			request({ prompt_cache_key: arbitrary }),
		);
		const codexOther = await codexCacheKey(
			request({ prompt_cache_key: other }),
		);
		expect(codexFirst).toMatch(/^ccflare-convo-[0-9a-f]{48}$/);
		expect(codexRepeated).toBe(codexFirst);
		expect(codexOther).not.toBe(codexFirst);

		const xaiFirst = await xaiCacheKey(
			request({ prompt_cache_key: arbitrary }),
		);
		const xaiRepeated = await xaiCacheKey(
			request({ prompt_cache_key: arbitrary }),
		);
		const xaiOther = await xaiCacheKey(request({ prompt_cache_key: other }));
		expect(xaiFirst).toMatch(/^ccflare-xai-[0-9a-f]{48}$/);
		expect(xaiRepeated).toBe(xaiFirst);
		expect(xaiOther).not.toBe(xaiFirst);

		const userId = await canonicalUserId(
			request({ prompt_cache_key: arbitrary }),
		);
		expect(userId).not.toContain(arbitrary);
		expect(JSON.parse(userId ?? "{}").session_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("uses prompt_cache_key, then session_id, then x-session-id precedence", async () => {
		const bodyWins = await canonicalUserId(
			request(
				{ prompt_cache_key: "body-session" },
				{ session_id: "primary-header", "x-session-id": "legacy-header" },
			),
		);
		expect(bodyWins).toBe(
			await canonicalUserId(request({ prompt_cache_key: "body-session" })),
		);

		const primaryHeaderWins = await canonicalUserId(
			request({}, { session_id: "primary-header", "x-session-id": "legacy" }),
		);
		expect(primaryHeaderWins).toBe(
			await canonicalUserId(request({}, { session_id: "primary-header" })),
		);
		expect(primaryHeaderWins).not.toBe(
			await canonicalUserId(request({}, { "x-session-id": "legacy" })),
		);

		const emptyBodyFallsBack = await canonicalUserId(
			request({ prompt_cache_key: "" }, { session_id: "primary-header" }),
		);
		expect(emptyBodyFallsBack).toBe(primaryHeaderWins);
	});

	it("preserves valid Claude session metadata and replaces malformed metadata only when an explicit identity exists", async () => {
		const existingUserId = JSON.stringify({
			session_id: SESSION_UUID,
			client: "existing-client",
		});
		expect(
			await canonicalUserId(request({ metadata: { user_id: existingUserId } })),
		).toBe(existingUserId);

		const bridged = await canonicalUserId(
			request({
				prompt_cache_key: "opaque-but-valid-identity",
				metadata: { user_id: "not-json" },
			}),
		);
		expect(bridged).not.toBe("not-json");
		expect(JSON.parse(bridged ?? "{}").session_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			await canonicalUserId(request({ metadata: { user_id: "not-json" } })),
		).toBeUndefined();
	});

	it("does not forward raw session headers after canonicalization", async () => {
		const rawHeader = "not-a-uuid-and-private";
		const synthetic = await captureSyntheticRequest(
			request({}, { session_id: rawHeader, "x-session-id": "legacy-private" }),
		);

		expect(synthetic.headers.get("session_id")).toBeNull();
		expect(synthetic.headers.get("x-session-id")).toBeNull();
		const serialized = await synthetic.text();
		expect(serialized).not.toContain(rawHeader);
		expect(serialized).not.toContain("legacy-private");
	});
});
