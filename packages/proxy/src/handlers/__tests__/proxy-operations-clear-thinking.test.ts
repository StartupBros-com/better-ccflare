import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Anthropic account fixture: clear_thinking context management is
// Anthropic-specific (Claude Code sends it on newer model families).
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-anthropic-1",
		name: "claude-pro",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(providerName = "anthropic"): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(1),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: providerName,
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://api.anthropic.com/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function encodeBody(body: object): ArrayBuffer {
	const encoded = new TextEncoder().encode(JSON.stringify(body));
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const CLEAR_THINKING_ERROR_MESSAGE =
	"`clear_thinking_20251015` strategy requires `thinking` to be enabled or adaptive";

function clearThinkingRejectionResponse(onCancel?: () => void): Response {
	const response = jsonResponse(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message: CLEAR_THINKING_ERROR_MESSAGE,
			},
		},
		400,
	);

	if (onCancel && response.body) {
		const cancel = response.body.cancel.bind(response.body);
		response.body.cancel = (...args) => {
			onCancel();
			return cancel(...args);
		};
	}

	return response;
}

function invalidSignatureResponse(): Response {
	return jsonResponse(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"messages.1.content.0: Invalid `signature` in `thinking` block",
			},
		},
		400,
	);
}

function successResponse(model: string): Response {
	return jsonResponse(
		{
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		},
		200,
	);
}

// Conversation history with a thinking block from a previous model/turn.
function messagesWithThinkingHistory() {
	return [
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pondering...", signature: "sig-abc" },
				{ type: "text", text: "hi there" },
			],
		},
		{ role: "user", content: "continue" },
	];
}

async function runProxyCapturingBodies(
	requestBody: object,
	responses: Response[],
	account = makeAccount(),
	ctx = makeProxyContext(),
	cloneResponses = true,
): Promise<{
	result: Response | null;
	upstreamBodies: Array<Record<string, unknown>>;
}> {
	const upstreamBodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		const bodyText = await req.text().catch(() => "{}");
		upstreamBodies.push(JSON.parse(bodyText));
		const response =
			responses[Math.min(upstreamBodies.length, responses.length) - 1];
		return cloneResponses ? response.clone() : response;
	});

	const bodyBuffer = encodeBody(requestBody);
	const req = makeRequest(bodyBuffer);

	// proxyWithAccount reaches forwardToClient on success, which requires
	// UsageCollector initialization (not wired in unit tests). Catch that
	// specific error while still verifying the retry behaviour via the
	// captured upstream bodies.
	let result: Response | null = null;
	try {
		result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
	}

	return { result, upstreamBodies };
}

describe("proxyWithAccount clear_thinking context-management handling", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("thinking-signature retry also strips clear_thinking edits when disabling thinking", async () => {
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-opus-4-8",
				max_tokens: 100,
				thinking: { type: "adaptive" },
				context_management: {
					edits: [{ type: "clear_thinking_20251015" }],
				},
				messages: messagesWithThinkingHistory(),
			},
			[invalidSignatureResponse(), successResponse("claude-opus-4-8")],
		);

		expect(upstreamBodies).toHaveLength(2);

		// Original request went out untouched.
		expect(upstreamBodies[0].thinking).toEqual({ type: "adaptive" });
		expect(upstreamBodies[0].context_management).toBeDefined();

		// Retry disabled thinking AND removed the clear_thinking edit, since the
		// combination of a clear_thinking edit with thinking disabled is a
		// guaranteed 400 ("requires `thinking` to be enabled or adaptive").
		const retryBody = upstreamBodies[1];
		expect(retryBody.thinking).toBeUndefined();
		expect(retryBody.context_management).toBeUndefined();

		// Thinking blocks were filtered from history.
		const assistantMessages = (
			retryBody.messages as Array<{
				role: string;
				content: string | Array<{ type: string }>;
			}>
		).filter((m) => m.role === "assistant");
		for (const msg of assistantMessages) {
			if (Array.isArray(msg.content)) {
				expect(msg.content.some((b) => b.type === "thinking")).toBe(false);
			}
		}
	});

	it("strips clear_thinking edits before the first send when thinking is explicitly disabled", async () => {
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-opus-4-8",
				max_tokens: 100,
				thinking: { type: "disabled" },
				context_management: {
					edits: [
						{ type: "clear_tool_uses_20250919" },
						{ type: "clear_thinking_20251015" },
					],
				},
				messages: messagesWithThinkingHistory(),
			},
			[successResponse("claude-opus-4-8")],
		);

		// The invalid combination never reaches Claude: the pre-send guard
		// strips the edit, so the very first upstream call succeeds.
		expect(upstreamBodies).toHaveLength(1);

		const sentBody = upstreamBodies[0];
		// Only the clear_thinking edit is removed; other edits are preserved.
		expect(sentBody.context_management).toEqual({
			edits: [{ type: "clear_tool_uses_20250919" }],
		});
		// Messages (including historical thinking blocks) are untouched.
		expect(sentBody.messages).toEqual(messagesWithThinkingHistory());
		// The explicit disabled config itself is preserved as sent.
		expect(sentBody.thinking).toEqual({ type: "disabled" });
	});

	it("keeps clear_thinking edits pre-send when thinking is omitted (default-thinking models accept them)", async () => {
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-sonnet-5",
				max_tokens: 100,
				// No thinking config: on model families where thinking defaults on
				// (adaptive), Claude accepts the edit, so the guard must not strip.
				context_management: {
					edits: [{ type: "clear_thinking_20251015" }],
				},
				messages: messagesWithThinkingHistory(),
			},
			[successResponse("claude-sonnet-5")],
		);

		expect(upstreamBodies).toHaveLength(1);
		expect(upstreamBodies[0].context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015" }],
		});
		expect(upstreamBodies[0].thinking).toBeUndefined();
	});

	it("reactively strips the edit when thinking is omitted and Claude rejects the combination", async () => {
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-opus-4-8",
				max_tokens: 100,
				// No thinking config, e.g. Claude Code switched models mid-session
				// to a family where omitted thinking means disabled, but kept
				// sending the clear_thinking edit. The static guard cannot know the
				// model's default, so the first send goes out intact and the
				// reactive retry unwedges the session after the 400.
				context_management: {
					edits: [
						{ type: "clear_tool_uses_20250919" },
						{ type: "clear_thinking_20251015" },
					],
				},
				messages: messagesWithThinkingHistory(),
			},
			[clearThinkingRejectionResponse(), successResponse("claude-opus-4-8")],
		);

		expect(upstreamBodies).toHaveLength(2);
		// First send kept the client's request intact.
		expect(upstreamBodies[0].context_management).toEqual({
			edits: [
				{ type: "clear_tool_uses_20250919" },
				{ type: "clear_thinking_20251015" },
			],
		});
		// Retry removed only the clear_thinking edit; other edits, messages,
		// and the (absent) thinking config are untouched.
		expect(upstreamBodies[1].context_management).toEqual({
			edits: [{ type: "clear_tool_uses_20250919" }],
		});
		expect(upstreamBodies[1].messages).toEqual(messagesWithThinkingHistory());
		expect(upstreamBodies[1].thinking).toBeUndefined();
	});

	it("drops context_management entirely when clear_thinking was its only edit", async () => {
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-opus-4-8",
				max_tokens: 100,
				thinking: { type: "disabled" },
				context_management: {
					edits: [{ type: "clear_thinking_20251015" }],
				},
				messages: [{ role: "user", content: "hello" }],
			},
			[successResponse("claude-opus-4-8")],
		);

		expect(upstreamBodies).toHaveLength(1);
		expect(upstreamBodies[0].context_management).toBeUndefined();
		// The explicit disabled config itself is preserved as sent.
		expect(upstreamBodies[0].thinking).toEqual({ type: "disabled" });
	});

	it("keeps the edit pre-send when thinking is enabled, but retries stripped if Claude still rejects it", async () => {
		let rejectedBodyCancelled = false;
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-opus-4-8",
				max_tokens: 100,
				// Thinking looks enabled, so the pre-send guard must NOT strip.
				// If Claude rejects the combination anyway (semantics the static
				// check cannot see), the reactive retry strips the edit.
				thinking: { type: "adaptive" },
				context_management: {
					edits: [{ type: "clear_thinking_20251015" }],
				},
				messages: [{ role: "user", content: "hello" }],
			},
			[
				clearThinkingRejectionResponse(() => {
					rejectedBodyCancelled = true;
				}),
				successResponse("claude-opus-4-8"),
			],
			makeAccount(),
			makeProxyContext(),
			false,
		);

		expect(upstreamBodies).toHaveLength(2);
		expect(rejectedBodyCancelled).toBe(true);
		// First send kept the client's request intact.
		expect(upstreamBodies[0].context_management).toBeDefined();
		// Reactive retry stripped only the edit; thinking config is untouched.
		expect(upstreamBodies[1].context_management).toBeUndefined();
		expect(upstreamBodies[1].thinking).toEqual({ type: "adaptive" });
		expect(upstreamBodies[1].messages).toEqual([
			{ role: "user", content: "hello" },
		]);
	});

	it("does not retry when there is no clear_thinking edit to strip", async () => {
		const { upstreamBodies } = await runProxyCapturingBodies(
			{
				model: "claude-opus-4-8",
				max_tokens: 100,
				messages: [{ role: "user", content: "hello" }],
			},
			[clearThinkingRejectionResponse()],
		);

		// No edit to strip means no retry: exactly one upstream call. The 400
		// continues down the normal response pipeline (forwardToClient needs
		// UsageCollector, which is not wired in unit tests, so the returned
		// response is not asserted here).
		expect(upstreamBodies).toHaveLength(1);
	});
});
