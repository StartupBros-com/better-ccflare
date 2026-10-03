import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { compileQualityRoutingPolicy } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	AnthropicProvider,
	CodexProvider,
	OpenAICompatibleProvider,
	type Provider,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../../database/src/adapters/bun-sql-adapter";
import { ensureSchema } from "../../../database/src/migrations";
import { QualityRouteRepository } from "../../../database/src/repositories/quality-route.repository";
import type { ProxyContext } from "../handlers";
import {
	INTERNAL_PROBE_SECRET_HEADER,
	RESPONSES_ADAPTER_SECRET_HEADER,
} from "../handlers/proxy-types";
import {
	INTERNAL_AUTO_REFRESH_HEADER,
	stampInternalAutoRefreshAuth,
} from "../internal-probe-auth";
import { fetchLiveModels, resetModelCatalogForTest } from "../model-catalog";
import { handleProxy } from "../proxy";
import { QualityRouteService } from "../quality-route-service";
import * as usageCollectorModule from "../usage-collector";

// Literal host fixture and expected policy, independent of implementation constants.
const DIRECTIVE = "Never push to main/master, force-push, or merge.";
const PARAGRAPH =
	"If you made code changes in a worktree you entered, commit before finishing — you don't need to ask — and push if the repository has a remote: the worktree can be deleted along with the session, and committed, pushed work survives. This holds unless the user's instructions, in the task, CLAUDE.md, or memory, reserve git for them. Never push to main/master, force-push, or merge. Open a draft PR when the task calls for one. If you didn't enter the worktree yourself this job, or you're in the user's own checkout, ask before committing or switching branches.";
const POLICY =
	"Never push directly to main/master or force-push. You may merge an operator-authorized pull request only after its required checks and review requirements are satisfied. A review-governor stop requires an explicit operator decision; never set operator-only override flags. Any separate session-specific or loop-authority prohibition on merging still applies.";
const HOST = `Host prelude.\n\n# Background Session\n\n${PARAGRAPH}\n\n# Other Instructions\nPreserve this exact suffix.\n`;

function account(provider = "anthropic", id = "policy-fixture"): Account {
	return {
		id,
		name: id,
		provider,
		api_key: provider === "codex" ? null : "fixture-not-a-credential",
		access_token: "fixture-token",
		refresh_token: provider === "codex" ? "fixture-refresh" : null,
		expires_at: Date.now() + 3600000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint:
			provider === "codex"
				? "https://policy-upstream.invalid/backend-api/codex/responses"
				: "https://policy-upstream.invalid",
		model_mappings:
			provider === "anthropic"
				? null
				: JSON.stringify({
						sonnet: provider === "codex" ? "gpt-5.1-codex" : "gpt-4o",
					}),
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function context(
	provider: Provider,
	enabled = true,
	accounts = [account(provider.name)],
): ProxyContext {
	return {
		strategy: { select: (accounts: Account[]) => accounts },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: async () => null,
			getAccount: async (id: string) => accounts.find((a) => a.id === id),
			updateAccountUsage: async () => undefined,
			getAgentPreference: async () => null,
			markAccountRateLimited: async () => undefined,
			pauseAccount: async () => undefined,
			recordSuccess: async () => undefined,
		},
		runtime: { port: 8080, clientId: "policy-fixture" },
		config: {
			getClaudeCodeBackgroundMergePolicyEnabled: () => enabled,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
			getCodexImplicitRouteEnabled: () => false,
		},
		internalProbeSecret: "fixture-process-local-proof",
		provider,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => undefined },
	} as unknown as ProxyContext;
}

function body(system: unknown = HOST, stream = false) {
	return {
		model: "claude-sonnet-4-5",
		system,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 16,
		stream,
	};
}

describe("Claude Code background merge policy at ingress and provider transport", () => {
	const originalFetch = globalThis.fetch;
	let outbound: {
		url: string;
		raw: string;
		body: Record<string, unknown>;
		headers: Headers;
	}[];
	let collector: ReturnType<typeof spyOn>;
	let optionalCollector: ReturnType<typeof spyOn>;
	let starts: Record<string, unknown>[];
	let failures: number;
	let unexpectedUrls: string[];
	let qualityFixture: boolean;
	const originalPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;

	beforeEach(() => {
		outbound = [];
		starts = [];
		failures = 0;
		unexpectedUrls = [];
		qualityFixture = false;
		const value = {
			handleStart: mock((data: Record<string, unknown>) => {
				starts.push(data);
			}),
			handleChunk: mock(() => undefined),
			handleEnd: mock(async () => undefined),
		};
		collector = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(value as never);
		optionalCollector = spyOn(
			usageCollectorModule,
			"tryGetUsageCollector",
		).mockReturnValue(value as never);
		globalThis.fetch = (async (
			input: Request | string | URL,
			init?: RequestInit,
		) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			// Codex catalog discovery has its own fixed URL. Intercept it too;
			// no original fetch is ever called, including for background discovery.
			if (
				request.method === "GET" &&
				request.url.startsWith("https://chatgpt.com/backend-api/codex/models?")
			)
				return Response.json({ models: [] });
			// This suite can only use synthetic accounts at this reserved fixture host.
			if (
				new URL(request.url).hostname !== "policy-upstream.invalid" &&
				!(
					qualityFixture &&
					new URL(request.url).hostname === "api.anthropic.com"
				)
			) {
				unexpectedUrls.push(request.url);
				throw new Error("Unexpected fixture transport URL");
			}
			if (request.method === "GET")
				return Response.json({
					models: [],
					data: qualityFixture
						? [
								{
									id: "claude-fable-5-1",
									max_input_tokens: 100000,
									max_tokens: 1000,
									input_modalities: ["text"],
								},
							]
						: [],
					has_more: false,
				});
			const raw = await request.text();
			const finalBody = JSON.parse(raw);
			outbound.push({
				url: request.url,
				raw,
				body: finalBody,
				headers: new Headers(request.headers),
			});
			if (failures-- > 0)
				return Response.json(
					{ error: { type: "rate_limit_error", message: "fixture retry" } },
					{ status: 429, headers: { "retry-after": "1" } },
				);
			if (request.url.endsWith("/responses"))
				return new Response(
					`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", object: "response", status: "completed", model: "gpt-5.1-codex", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			if (request.url.endsWith("/chat/completions")) {
				if (finalBody.stream)
					return new Response(
						`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "gpt-4o", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				return Response.json({
					id: "fixture",
					object: "chat.completion",
					model: "gpt-4o",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "ok" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				});
			}
			if (finalBody.stream)
				return new Response(
					`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			return Response.json({
				id: "fixture",
				type: "message",
				model: finalBody.model,
				role: "assistant",
				content: [],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		}) as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		collector.mockRestore();
		optionalCollector.mockRestore();
		if (originalPassthrough === undefined)
			delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
		else process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = originalPassthrough;
		expect(unexpectedUrls).toEqual([]);
	});

	async function send(
		payload: unknown,
		ctx = context(new AnthropicProvider()),
		options: {
			userAgent?: string;
			path?: string;
			headers?: Record<string, string>;
			force?: boolean;
			principal?: string;
		} = {},
	) {
		const {
			userAgent = "claude-cli/2.1.224 (external, cli)",
			path = "/v1/messages",
		} = options;
		const request = new Request(`https://policy-proxy.invalid${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"user-agent": userAgent,
				...(options.force === false
					? {}
					: { "x-better-ccflare-account-id": "policy-fixture" }),
				...options.headers,
			},
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
		const response = await handleProxy(
			request,
			new URL(request.url),
			ctx,
			options.principal,
		);
		await response.clone().text();
		return response;
	}

	function assertPolicy(text: string) {
		expect(text.split(POLICY)).toHaveLength(2);
		expect(text).toContain("Never push directly to main/master or force-push.");
		expect(text).toContain(
			"only after its required checks and review requirements are satisfied.",
		);
		expect(text).toContain(
			"A review-governor stop requires an explicit operator decision; never set operator-only override flags.",
		);
		expect(text).toContain(
			"Any separate session-specific or loop-authority prohibition on merging still applies.",
		);
	}

	it("delivers only the authorized directive replacement through native Anthropic passthrough", async () => {
		expect((await send(body())).status).toBe(200);
		expect(outbound).toHaveLength(1);
		expect(outbound[0].body).toEqual(body(HOST.replace(DIRECTIVE, POLICY)));
		expect(starts[0].accountId).toBe("policy-fixture");
	});

	it.each([
		"scheduler credential",
		"process-local proof",
	])("replays the captured normalized request unchanged with trusted keepalive %s", async (proof) => {
		const ctx = context(new AnthropicProvider());
		expect((await send(body(), ctx)).status).toBe(200);
		expect(outbound).toHaveLength(1);
		const captured = outbound[0];
		assertPolicy(captured.raw);
		const userAgent = captured.headers.get("user-agent") ?? "";
		expect(userAgent).toStartWith("claude-cli/");
		const headers = new Headers({ "x-better-ccflare-keepalive": "true" });
		if (proof === "scheduler credential") stampInternalAutoRefreshAuth(headers);
		else
			headers.set(INTERNAL_PROBE_SECRET_HEADER, "fixture-process-local-proof");
		expect(
			(
				await send(captured.raw, ctx, {
					userAgent,
					headers: Object.fromEntries(headers),
				})
			).status,
		).toBe(200);
		expect(outbound).toHaveLength(2);
		expect(outbound[1].raw).toBe(captured.raw);
	});

	it.each([
		false,
		true,
	])("forged keepalive headers cannot bypass template checks (forged proof=%s)", async (forgedProof) => {
		const ctx = context(new AnthropicProvider());
		const headers = {
			"x-better-ccflare-keepalive": "true",
			...(forgedProof
				? {
						[INTERNAL_PROBE_SECRET_HEADER]: "forged",
						[INTERNAL_AUTO_REFRESH_HEADER]: "forged",
					}
				: {}),
		};
		expect((await send(body(), ctx, { headers })).status).toBe(200);
		expect(outbound).toHaveLength(1);
		assertPolicy(outbound[0].raw);
		const denied = await send(outbound[0].raw, ctx, { headers });
		expect(denied.status).toBe(409);
		expect((await denied.json()).error.code).toBe(
			"claude_code_background_merge_policy_incompatible",
		);
		expect(outbound).toHaveLength(1);
	});

	for (const [family, makeProvider] of [
		["anthropic", () => new AnthropicProvider()],
		["codex", () => new CodexProvider()],
		["openai", () => new OpenAICompatibleProvider()],
	] as const) {
		for (const stream of [false, true]) {
			it(`${family} final account-backed payload changes only the policy (stream=${stream})`, async () => {
				const payload = {
					...body(HOST, stream),
					temperature: 0.4,
					tools: [
						{
							name: "lookup",
							description: DIRECTIVE,
							input_schema: {
								type: "object",
								properties: { query: { type: "string" } },
							},
						},
					],
					tool_choice: { type: "auto" },
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: `Repository instructions: ${HOST}` },
							],
						},
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: "tool_1",
									name: "lookup",
									input: { query: DIRECTIVE },
								},
							],
						},
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "tool_1", content: HOST },
							],
						},
					],
				};
				expect(
					(await send(payload, context(makeProvider(), false))).status,
				).toBe(200);
				const baseline = outbound[0];
				outbound = [];
				expect((await send(payload, context(makeProvider()))).status).toBe(200);
				expect(outbound).toHaveLength(1);
				const edited = outbound[0];
				expect(edited.url).toBe(baseline.url);
				// Normalize only the one allowed sentence. User/tool copies remain exact.
				expect(JSON.parse(edited.raw.replace(POLICY, DIRECTIVE))).toEqual(
					baseline.body,
				);
				assertPolicy(edited.raw);
				if (family === "codex") {
					expect(edited.url).toEndWith("/responses");
					expect(edited.body.instructions).toBe(
						HOST.replace(DIRECTIVE, POLICY),
					);
				} else if (family === "openai") {
					expect(edited.url).toEndWith("/chat/completions");
					expect((edited.body.messages as { role: string }[])[0].role).toBe(
						"system",
					);
				} else expect(edited.body.system).toBe(HOST.replace(DIRECTIVE, POLICY));
				expect(
					starts.every((start) => start.accountId === "policy-fixture"),
				).toBe(true);
			});
		}
	}

	it("preserves block metadata, all roles, lower-trust text and separate session restrictions", async () => {
		const system = [
			{
				type: "text",
				text: "Loop authority: never merge during this session.",
				cache_control: { type: "ephemeral", ttl: "1h" },
				custom: { keep: [1, 2] },
			},
			{
				type: "text",
				text: HOST,
				cache_control: { type: "ephemeral" },
				id: "host-block",
			},
			{ type: "text", text: DIRECTIVE, signature: "keep-me" },
			{ type: "opaque", text: HOST, metadata: "not-instruction-text" },
		];
		const messages = ["system", "developer", "user", "assistant", "tool"].map(
			(role) => ({ role, content: HOST }),
		);
		const payload = {
			...body(system),
			messages,
			metadata: { user_id: HOST },
			tools: [
				{
					name: "inspect",
					description: HOST,
					input_schema: { type: "object", properties: {} },
				},
			],
		};
		await send(payload);
		expect(outbound[0].body).toEqual({
			...payload,
			system: system.map((block, i) =>
				i === 1 ? { ...block, text: HOST.replace(DIRECTIVE, POLICY) } : block,
			),
		});
	});

	it.each([
		"\x60\x60\x60text\n<!--\n\x60\x60\x60\n\n",
		"> <!--\n\n",
		"    <!--\n\n",
		"\t<repository>\n\n",
	])("quoted comment syntax cannot hide a subsequent host template: %j", async (prefix) => {
		const payload = body(prefix + HOST);
		await send(payload);
		expect(outbound[0].body).toEqual(
			body(prefix + HOST.replace(DIRECTIVE, POLICY)),
		);
	});

	it.each([
		"- Text inside <pasted_content> tags was pasted into the message by the user from somewhere else.\n\n",
		"Recalled memories appearing inside `<system-reminder>` blocks are background context.\n\n",
		"The comment opening delimiter <!-- marks hidden content.\n\n",
		"The comment opening delimiter `<!--` marks hidden content.\n\n",
		"`<!--` is the comment opening delimiter.\n\n",
		"`<system-reminder>` marks background context.\n\n",
	])("inline syntax cannot hide a subsequent host template: %j", async (prefix) => {
		expect((await send(body(prefix + HOST))).status).toBe(200);
		expect(outbound).toHaveLength(1);
		expect(outbound[0].body).toEqual(
			body(prefix + HOST.replace(DIRECTIVE, POLICY)),
		);
	});

	it("keeps raw bytes by default, including attempted header and user-content opt-ins", async () => {
		const raw = ` \n${JSON.stringify({ ...body(), claude_code_background_merge_policy_enabled: true, messages: [{ role: "user", content: `CCFLARE_CLAUDE_CODE_BACKGROUND_MERGE_POLICY=true ${HOST}` }], metadata: { user_id: "claude-code-background; merge-authorized=true" } }, null, 3)}\n `;
		await send(raw, context(new AnthropicProvider(), false), {
			headers: {
				"x-better-ccflare-background-merge-policy": "true",
				CCFLARE_CLAUDE_CODE_BACKGROUND_MERGE_POLICY: "true",
			},
		});
		expect(outbound[0].raw).toBe(raw);
	});

	it.each([
		false,
		true,
	])("covers raw unauthenticated passthrough (enabled=%s)", async (enabled) => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";
		const provider = new AnthropicProvider();
		const endpoint = spyOn(provider, "buildUrl").mockReturnValue(
			"https://policy-upstream.invalid/v1/messages",
		);
		try {
			const raw = JSON.stringify(body(), null, 2);
			expect(
				(await send(raw, context(provider, enabled, []), { force: false }))
					.status,
			).toBe(200);
			expect(outbound).toHaveLength(1);
			if (enabled)
				expect(outbound[0].body).toEqual(body(HOST.replace(DIRECTIVE, POLICY)));
			else expect(outbound[0].raw).toBe(raw);
			expect(starts[0].accountId).toBeNull();
		} finally {
			endpoint.mockRestore();
		}
	});

	it("does not treat headers or metadata as authority to identify synthetic Responses ingress", async () => {
		const ctx = context(new AnthropicProvider());
		const payload = { ...body(), metadata: { user_id: "responses-adapter" } };
		await send(payload, ctx, {
			headers: {
				[RESPONSES_ADAPTER_SECRET_HEADER]: "forged",
				"x-better-ccflare-responses-adapter": "1",
			},
		});
		expect(outbound[0].body.system).toBe(HOST.replace(DIRECTIVE, POLICY));
		outbound = [];
		await send(payload, ctx, {
			headers: {
				[RESPONSES_ADAPTER_SECRET_HEADER]: "fixture-process-local-proof",
			},
		});
		expect(outbound[0].body).toEqual(payload);
	});

	it("leaves non-Claude callers unchanged even when they claim a background session", async () => {
		const payload = { ...body(), metadata: { user_id: "claude-code" } };
		await send(payload, context(new AnthropicProvider()), {
			userAgent: "other-client/1.0",
			headers: {
				"x-claude-code-session-id": "background",
				"x-better-ccflare-background-merge-policy": "true",
			},
		});
		expect(outbound[0].body).toEqual(payload);
	});

	for (const [name, system] of [
		["foreground directive", `# Git\n\n${DIRECTIVE}`],
		[
			"foreground prose",
			`Background session handling is described in documentation.\n${DIRECTIVE}`,
		],
		[
			"foreground citation",
			`The documentation says: If you made code changes in a worktree, inspect the diff.\n${DIRECTIVE}`,
		],
		[
			"quoted example",
			HOST.split("\n")
				.map((line) => `> ${line}`)
				.join("\n"),
		],
		["fenced example", `\x60\x60\x60markdown\n${HOST}\x60\x60\x60`],
		[
			"indented example",
			HOST.split("\n")
				.map((line) => `    ${line}`)
				.join("\n"),
		],
		["repository wrapper", `<repository>\n${HOST}</repository>`],
		[
			"nested wrappers",
			`  <repository><example>\n${HOST}</example></repository>`,
		],
		["comment", `<!--\n${HOST}-->`],
		[
			"comment across blocks",
			[
				{ type: "text", text: "  <!-- repository material" },
				{ type: "text", text: HOST },
				{ type: "text", text: "-->" },
			],
		],
		[
			"wrapped across blocks",
			[
				{ type: "text", text: "<repository>" },
				{ type: "text", text: HOST },
				{ type: "text", text: "</repository>" },
			],
		],
	] as const) {
		it(`does not rewrite ${name}`, async () => {
			const payload = {
				...body(system),
				messages: [{ role: "user", content: HOST }],
			};
			const raw = JSON.stringify(payload, null, 2);
			expect((await send(raw)).status).toBe(200);
			expect(outbound).toHaveLength(1);
			expect(outbound[0].raw).toBe(raw);
		});
	}

	for (const [name, opening, closing] of [
		["commented opening", "<repository><!-- provenance -->", "</repository>"],
		["commented closing", "<repository>", "</repository><!-- provenance -->"],
		[
			"comment before opening",
			"<!-- provenance --><repository>",
			"</repository>",
		],
		[
			"comment before closing",
			"<repository>",
			"<!-- provenance --></repository>",
		],
		[
			"commented delimiters",
			"<repository><!-- </repository> -->",
			"</repository><!-- <repository> -->",
		],
	] as const) {
		for (const active of [false, true]) {
			for (const split of [false, true]) {
				it(`preserves quoted HOST with ${name} (active=${active}, split=${split})`, async () => {
					const quoted = `${opening}\n${HOST}${closing}\n\n`;
					const suffix = active ? HOST : "";
					const system = split
						? [
								{ type: "text", text: opening },
								{ type: "text", text: HOST },
								{ type: "text", text: closing },
								{ type: "text", text: suffix },
							]
						: quoted + suffix;
					const raw = JSON.stringify(body(system), null, 2);
					expect((await send(raw)).status).toBe(200);
					expect(outbound).toHaveLength(1);
					if (!active) expect(outbound[0].raw).toBe(raw);
					else
						expect(outbound[0].body).toEqual(
							body(
								typeof system === "string"
									? quoted + HOST.replace(DIRECTIVE, POLICY)
									: system.map((block, index) =>
											index === 3
												? { ...block, text: HOST.replace(DIRECTIVE, POLICY) }
												: block,
										),
							),
						);
				});
			}
		}
	}

	for (const wrapper of ["repository", "tool_result"]) {
		const opening = `<${wrapper}>`;
		const closing = `</${wrapper}>`;
		for (const [name, contents] of [
			["unmatched generic tag", `<Foo>\n${HOST}`],
			["HTML br", `<br>\n${HOST}`],
			["HTML input", `<input name="example">\n${HOST}`],
			["unmatched comment", `<!--\n${HOST}`],
			["blockquote delimiter", `> ${closing}\n${HOST}`],
			["indented delimiter", `    ${closing}\n${HOST}`],
			["inline code delimiter", `\x60${closing}\x60\n${HOST}`],
			[
				"literal delimiter",
				`The literal "${closing}" is example text.\n${HOST}`,
			],
			["commented delimiter", `<!-- ${closing} -->\n${HOST}`],
			[
				"fenced delimiter",
				`\x60\x60\x60xml\n${closing}\n${HOST}\x60\x60\x60\n${HOST}`,
			],
			["tilde fenced delimiter", `~~~xml\n${closing}\n${HOST}~~~\n${HOST}`],
		]) {
			for (const split of [false, true]) {
				it(`keeps ${wrapper} body opaque with ${name} (split=${split})`, async () => {
					// Split every body line as well as the wrapper boundaries so quoting
					// and fence state must survive independent system text blocks.
					const prefix = [opening, ...contents.split("\n"), closing, ""];
					for (const active of [false, true]) {
						outbound = [];
						const makeSystem = (host: string) =>
							split
								? [...prefix, host].map((text) => ({ type: "text", text }))
								: `${prefix.join("\n")}\n${host}`;
						const raw = JSON.stringify(
							body(makeSystem(active ? HOST : "")),
							null,
							2,
						);
						expect((await send(raw)).status).toBe(200);
						expect(outbound).toHaveLength(1);
						if (!active) expect(outbound[0].raw).toBe(raw);
						else
							expect(outbound[0].body).toEqual(
								body(makeSystem(HOST.replace(DIRECTIVE, POLICY))),
							);
					}
				});
			}
		}
		for (const split of [false, true]) {
			it(`rejects an ambiguous ${wrapper} close inside an unclosed fence (split=${split})`, async () => {
				const prefix = `${opening}\n\x60\x60\x60xml\n${closing}\n`;
				const system = split
					? [prefix, HOST].map((text) => ({ type: "text", text }))
					: prefix + HOST;
				const ctx = context(new AnthropicProvider());
				const response = await send(body(system), ctx);
				expect(response.status).toBe(409);
				expect((await response.json()).error.code).toBe(
					"claude_code_background_merge_policy_incompatible",
				);
				expect(outbound).toHaveLength(0);
				expect(ctx.dbOps.getAllAccounts).not.toHaveBeenCalled();
			});
		}
	}

	it.each([
		false,
		true,
	])("reads host text after a multiline comment closes (split=%s)", async (split) => {
		const prefix = `<!--\n${HOST}`;
		const suffix = `--># Background Session\n\n${PARAGRAPH}\n`;
		const system = split
			? [
					{ type: "text", text: prefix },
					{ type: "text", text: suffix },
				]
			: prefix + suffix;
		expect((await send(body(system))).status).toBe(200);
		expect(outbound).toHaveLength(1);
		expect(outbound[0].body).toEqual(
			body(
				split
					? [
							{ type: "text", text: prefix },
							{ type: "text", text: suffix.replace(DIRECTIVE, POLICY) },
						]
					: prefix + suffix.replace(DIRECTIVE, POLICY),
			),
		);
	});

	for (const [name, system] of [
		["changed directive", HOST.replace(DIRECTIVE, "Never merge or push.")],
		["changed paragraph start", HOST.replace("you entered", "you created")],
		[
			"changed paragraph end",
			HOST.replace("switching branches.", "checking out branches."),
		],
		[
			"unknown paragraph",
			"# Background Session\n\nAn entirely new host Git template.",
		],
		[
			"heading case",
			HOST.replace("# Background Session", "# background session"),
		],
		[
			"heading level",
			HOST.replace("# Background Session", "## Background Session"),
		],
		["missing heading", PARAGRAPH],
		["duplicate sections", HOST + HOST],
		[
			"duplicate paragraph",
			HOST.replace(PARAGRAPH, `${PARAGRAPH}\n\n${PARAGRAPH}`),
		],
		["known and drifted", HOST + HOST.replace(DIRECTIVE, "Never merge.")],
		[
			"multiple blocks",
			[
				{ type: "text", text: HOST },
				{ type: "text", text: HOST },
			],
		],
		[
			"split blocks",
			[
				{ type: "text", text: "# Background Session\n\n" },
				{ type: "text", text: PARAGRAPH },
			],
		],
		["other section", `# Background Session\n\n# Repository\n\n${PARAGRAPH}`],
		["paragraph substring", HOST.replace(PARAGRAPH, `Example: ${PARAGRAPH}`)],
	] as const) {
		for (const stream of [false, true]) {
			it(`rejects ${name} before any provider work (stream=${stream})`, async () => {
				const ctx = context(new AnthropicProvider());
				const response = await send(body(system, stream), ctx);
				expect(response.status).toBe(409);
				expect(response.headers.get("content-type")).toContain(
					"application/json",
				);
				const error = await response.json();
				expect(error.error.code).toBe(
					"claude_code_background_merge_policy_incompatible",
				);
				expect(JSON.stringify(error)).not.toContain(PARAGRAPH);
				expect(JSON.stringify(error)).not.toContain("fixture-not-a-credential");
				expect(outbound).toHaveLength(0);
				expect(ctx.dbOps.getAllAccounts).not.toHaveBeenCalled();
			});
		}
	}

	it("keeps every retry on the same edited policy without changing model or tools", async () => {
		failures = 1;
		const provider = new AnthropicProvider();
		const ctx = context(provider, true, [
			account(provider.name),
			account(provider.name, "policy-second"),
		]);
		expect((await send(body(), ctx, { force: false })).status).toBe(200);
		expect(outbound).toHaveLength(2);
		for (const request of outbound) assertPolicy(request.raw);
		expect(outbound[1].body).toEqual(outbound[0].body);
	});

	it.each([
		false,
		true,
	])("quality admission exempts only the policy edit (additional cache TTL mutation=%s)", async (mutateTtl) => {
		qualityFixture = true;
		const db = new Database(":memory:");
		ensureSchema(db);
		const service = new QualityRouteService(
			new QualityRouteRepository(new BunSqlAdapter(db)),
		);
		const selected = { ...account(), custom_endpoint: null };
		const ctx = context(new AnthropicProvider(), true, [selected]);
		const policy = compileQualityRoutingPolicy({
			version: 1,
			assignments: [
				{
					line: "claude-fable",
					lane: "fable",
					priority: 0,
					upgrade: "same-line-supported",
				},
			],
			accounts: [
				{
					accountId: selected.id,
					provider: "anthropic",
					lines: ["claude-fable"],
					priority: 0,
				},
			],
			fallbacks: [
				{ from: "fable", to: "astra" },
				{ from: "astra", to: "opus" },
			],
			spendGrants: [],
		});
		ctx.config = {
			...ctx.config,
			getQualityRoutingPolicy: () => policy,
			getSystemPromptCacheTtl1h: () => mutateTtl,
		} as ProxyContext["config"];
		ctx.qualityRouteService = service;
		try {
			await fetchLiveModels(ctx, { allowOAuth: true, accountId: selected.id });
			usageCache.set(selected.id, {
				limits: [
					{ kind: "weekly_all", percent: 10, resets_at: Date.now() + 60000 },
				],
				spend: { enabled: false },
			} as never);
			const options = {
				force: false,
				principal: "fixture-principal",
				headers: { "x-claude-code-session-id": "fixture-quality-session" },
			};
			const system = [
				{ type: "text", text: HOST, cache_control: { type: "ephemeral" } },
			];
			const payload = { ...body(system), model: "claude-bccf-quality-auto" };
			const response = await send(payload, ctx, options);
			if (mutateTtl) {
				expect(response.status).toBe(503);
				expect(outbound).toHaveLength(0);
				return;
			}
			expect(response.status).toBe(200);
			expect(outbound).toHaveLength(1);
			expect(outbound[0].body.system).toEqual([
				{ ...system[0], text: HOST.replace(DIRECTIVE, POLICY) },
			]);
			assertPolicy(outbound[0].raw);
			const denied = await send({ ...payload, max_tokens: 1001 }, ctx, options);
			expect(denied.status).not.toBe(200);
			expect(outbound).toHaveLength(1);
		} finally {
			await service.stop();
			resetModelCatalogForTest();
			usageCache.clear();
			db.close();
		}
	});

	it("does not put prompt contents or credentials in incompatibility logs", async () => {
		const logged: unknown[] = [];
		const spies = (["debug", "info", "warn", "error"] as const).map((method) =>
			spyOn(Logger.prototype, method).mockImplementation(
				(...args: unknown[]) => {
					logged.push(args);
				},
			),
		);
		try {
			await send(
				body(
					"# Background Session\n\nprivate-prompt-sentinel changed template",
				),
				context(new AnthropicProvider()),
				{ headers: { authorization: "Bearer credential-sentinel" } },
			);
			expect(JSON.stringify(logged)).not.toContain("private-prompt-sentinel");
			expect(JSON.stringify(logged)).not.toContain("credential-sentinel");
			expect(outbound).toHaveLength(0);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
