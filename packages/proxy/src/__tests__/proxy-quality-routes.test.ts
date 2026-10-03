import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileQualityRoutingPolicy } from "@better-ccflare/core";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import { getProvider, usageCache } from "@better-ccflare/providers";
import type {
	Account,
	APIContext,
	QualityVerifiedSession,
} from "@better-ccflare/types";
import { NodeCryptoUtils } from "@better-ccflare/types/api-key";
import { BunSqlAdapter } from "../../../database/src/adapters/bun-sql-adapter";
import { ensureSchema } from "../../../database/src/migrations";
import { QualityRouteRepository } from "../../../database/src/repositories/quality-route.repository";
import {
	createRequestPayloadHandler,
	createRequestsDetailHandler,
	createRequestsSummaryHandler,
} from "../../../http-api/src/handlers/requests";
import { APIRouter } from "../../../http-api/src/router";
import { AuthService } from "../../../http-api/src/services/auth-service";
import { AnthropicDegradedModeCoordinator } from "../anthropic-degraded-mode";
import {
	clearCodexModelCacheForTests,
	getCodexModels,
} from "../codex-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";
import { fetchLiveModels, resetModelCatalogForTest } from "../model-catalog";
import { ModelRouteSessionRegistry } from "../model-route-profiles";
import { handleProxy } from "../proxy";
import { compileQualityCandidates } from "../quality-route-candidates";
import { QualityRouteService } from "../quality-route-service";
import * as collectors from "../usage-collector";

const scope: QualityVerifiedSession = {
	verified: true,
	principalId: "test-principal",
	sessionId: "test-session",
};
const originalFetch = globalThis.fetch;
let db: Database;
let service: QualityRouteService;
let ctx: ProxyContext;
let accounts: Account[];
let sends: { model: string; authorization: string | null }[];
let upstream: () => Response;
let envelopes: Record<string, unknown>[];
let restores: (() => void)[];
function account(id: string): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: `synthetic-${id}`,
		access_token: null,
		refresh_token: null,
		expires_at: null,
		created_at: 1,
		request_count: 0,
		total_requests: 0,
		last_used: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}
function request(
	model = "claude-bccf-quality-auto",
	headers: Record<string, string> = {},
	body: Record<string, unknown> = {},
): Request {
	return new Request("https://proxy.invalid/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-claude-code-session-id": scope.sessionId,
			...headers,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 20,
			...body,
		}),
	});
}
async function send(
	req = request(),
	principal: string | null = scope.principalId,
) {
	return handleProxy(req, new URL(req.url), ctx, principal);
}
async function home(key = "$root") {
	return (await service.status(scope))?.conversations.find((c) => c.key === key)
		?.home?.target;
}
async function flush() {
	for (let i = 0; i < 20; i++)
		await new Promise((resolve) => setTimeout(resolve, 0));
}
const complete = () =>
	Response.json({
		id: "msg-test",
		type: "message",
		role: "assistant",
		model: "claude-fable-5-1",
		content: [{ type: "text", text: "ok" }],
		stop_reason: "end_turn",
		usage: { input_tokens: 1, output_tokens: 1 },
	});
beforeEach(async () => {
	db = new Database(":memory:");
	ensureSchema(db);
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
	);
	accounts = [account("a"), account("b")];
	sends = [];
	envelopes = [];
	upstream = complete;
	const policy = compileQualityRoutingPolicy({
		version: 1,
		assignments: [
			{
				line: "claude-fable",
				lane: "fable",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "claude-opus",
				lane: "opus",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "claude-sonnet",
				lane: "standard",
				priority: 0,
				upgrade: "same-line-supported",
			},
			{
				line: "claude-haiku",
				lane: "lightweight",
				priority: 0,
				upgrade: "same-line-supported",
			},
		],
		accounts: accounts.map((a) => ({
			accountId: a.id,
			provider: "anthropic",
			lines: ["claude-fable", "claude-opus", "claude-sonnet", "claude-haiku"],
			priority: 0,
		})),
		fallbacks: [
			{ from: "fable", to: "astra" },
			{ from: "astra", to: "opus" },
		],
		spendGrants: [],
	});
	const coordinator = new AnthropicDegradedModeCoordinator();
	ctx = {
		qualityRouteService: service,
		strategy: { select: async () => accounts },
		anthropicDegradedMode: coordinator,
		dbOps: {
			getAllAccounts: async () => accounts,
			getAccount: async (id: string) =>
				accounts.find((a) => a.id === id) ?? null,
			getAgentPreference: async () => null,
			getActiveComboForFamily: async () => null,
			recordSuccess: async () => {},
			incrementRequestCount: async () => {},
			updateAccount: async () => {},
		},
		config: {
			getQualityRoutingPolicy: () => policy,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		},
		runtime: { port: 8080, clientId: "synthetic" },
		provider: { name: "anthropic", canHandle: () => true },
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: () => {} },
	} as unknown as ProxyContext;
	const collector = {
		handleStart: () => {},
		handleChunk: () => {},
		handleEnd: async () => {},
	} as unknown as collectors.UsageCollector;
	restores = [
		spyOn(collectors, "getUsageCollector").mockReturnValue(collector),
		spyOn(collectors, "tryGetUsageCollector").mockReturnValue(collector),
	].map((s) => () => s.mockRestore());
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = input instanceof Request ? input : new Request(input, init);
			if (req.method === "GET")
				return Response.json({
					data: [
						"claude-fable-5-1",
						"claude-opus-5-5",
						"claude-sonnet-5-5",
						"claude-haiku-4-5",
					].map((id) => ({
						id,
						max_input_tokens: 100000,
						max_tokens: 1000,
						input_modalities: ["text"],
					})),
					has_more: false,
				});
			const body = (await req.json()) as { model: string };
			envelopes.push(body);
			sends.push({
				model: body.model,
				authorization:
					req.headers.get("x-api-key") ?? req.headers.get("authorization"),
			});
			return upstream();
		},
		{ preconnect: () => {} },
	) as typeof fetch;
	for (const a of accounts)
		await fetchLiveModels(ctx, { allowOAuth: true, accountId: a.id });
	for (const a of accounts)
		usageCache.set(a.id, {
			limits: [
				{ kind: "weekly_all", percent: 10, resets_at: Date.now() + 60000 },
			],
			spend: { enabled: false },
		} as never);
});
afterEach(async () => {
	await flush();
	await service.stop();
	globalThis.fetch = originalFetch;
	for (const restore of restores) restore();
	resetModelCatalogForTest();
	clearCodexModelCacheForTests();
	usageCache.clear();
	db.close();
});
it("one service connects verified inference enrollment, status, retry and next inference with no control sends", async () => {
	const directory = mkdtempSync(join(tmpdir(), "quality-lifecycle-"));
	const operations = new DatabaseOperations(join(directory, "test.db"));
	const writer = new AsyncDbWriter();
	const collector = new collectors.UsageCollector(
		operations,
		writer,
		() => false,
		() => {},
	);
	for (const restore of restores) restore();
	restores = [
		spyOn(collectors, "getUsageCollector").mockReturnValue(collector),
		spyOn(collectors, "tryGetUsageCollector").mockReturnValue(collector),
	].map((spy) => () => spy.mockRestore());
	ctx.dbOps = operations;
	ctx.asyncWriter = writer;
	try {
		for (const a of accounts)
			await operations
				.getAdapter()
				.run(
					"INSERT INTO accounts (id, name, provider, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
					[a.id, a.name, a.provider, a.api_key, 1],
				);
		const secret = "synthetic-lifecycle-credential";
		await operations.createApiKey({
			id: scope.principalId,
			name: "synthetic",
			hashedKey: await new NodeCryptoUtils().hashApiKey(secret),
			prefixLast8: secret.slice(-8),
			createdAt: Date.now(),
			isActive: true,
			role: "api-only",
		});
		service = new QualityRouteService(operations.getQualityRouteRepository());
		ctx.qualityRouteService = service;
		const router = new APIRouter({
			db: operations.getAdapter(),
			dbOps: operations,
			config: ctx.config,
			qualityRouteService: service,
			alertService: {
				listAlerts: async () => [],
				getUnacknowledgedCount: async () => 0,
				acknowledgeAlert: async () => true,
				acknowledgeAll: async () => {},
			},
		} as APIContext);
		const auth = new AuthService(operations);
		async function dispatch(req: Request) {
			const url = new URL(req.url);
			const routed = await router.handleRequest(url, req);
			if (routed) return routed;
			const identity = await auth.authenticateRequest(
				req,
				url.pathname,
				req.method,
			);
			expect(identity.apiKeyId).toBe(scope.principalId);
			return handleProxy(req, url, ctx, identity.apiKeyId);
		}
		const credential = { authorization: `Bearer ${secret}` };
		const first = await dispatch(request(undefined, credential));
		expect(first.status).toBe(200);
		await first.text();
		await flush();
		expect(sends.length).toBe(1);
		const url = `http://localhost/v1/quality-routing/sessions/${scope.sessionId}`;
		const status = (await (
			await dispatch(new Request(url, { headers: credential }))
		).json()) as {
			incarnation: string;
			intentRevision: number;
			pending: boolean;
			lastSuccessfulHome: unknown;
			decision: unknown;
			lastSuccessfulDecision: unknown;
		};
		expect(status.decision).toMatchObject({
			version: 1,
			requested: { kind: "main", preference: "auto" },
			selected: { lane: "fable" },
		});
		expect(status.lastSuccessfulDecision).toEqual(status.decision);
		expect(status.intentRevision).toBe(1);
		expect(status.pending).toBe(false);
		expect(status.lastSuccessfulHome).not.toBeNull();
		const body = JSON.stringify({
			incarnation: status.incarnation,
			expectedIntentRevision: status.intentRevision,
			idempotencyToken: "one-retry",
		});
		const retry = () =>
			dispatch(
				new Request(`${url}/retry-preferred`, {
					method: "POST",
					headers: { ...credential, "content-type": "application/json" },
					body,
				}),
			);
		const accepted = await (await retry()).json();
		expect(accepted).toMatchObject({ status: "ready", intentRevision: 2 });
		expect(await (await retry()).json()).toEqual(accepted);
		const pending = (await (
			await dispatch(new Request(url, { headers: credential }))
		).json()) as {
			pending: boolean;
			lastSuccessfulHome: unknown;
			decision: unknown;
			lastSuccessfulDecision: unknown;
		};
		expect(pending.decision).toBeNull();
		expect(pending.lastSuccessfulDecision).toEqual(status.decision);
		expect(pending.pending).toBe(true);
		expect(pending.lastSuccessfulHome).toEqual(status.lastSuccessfulHome);
		expect(sends.length).toBe(1);
		const next = await dispatch(request(undefined, credential));
		expect(next.status).toBe(200);
		await next.text();
		await flush();
		expect(sends.length).toBe(2);
		const settled = await service.status(scope);
		expect(settled?.intentRevision).toBe(2);
		expect(settled?.conversations[0]?.pending).toBe(false);
		expect(settled?.conversations[0]?.home?.intentRevision).toBe(2);
		await collector.drain();
		const history = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(history).toHaveLength(2);
		expect(history[0].qualityDecision).toMatchObject({
			version: 1,
			selected: {
				lane: "fable",
				accountId: "a",
				physicalModel: "claude-fable-5-1",
			},
			accounting: { kind: "estimate", source: "local-envelope-v1" },
		});
		expect(history[0].qualityDecision.selected.evidenceRef).toBeUndefined();
		expect(history[0].qualityDecision.selected.catalogRevision).toBeUndefined();
	} finally {
		await flush();
		await collector.drain();
		collector.dispose();
		await operations.close();
		rmSync(directory, { recursive: true });
	}
});
async function withRealQualityHistory(
	run: (
		operations: DatabaseOperations,
		collector: collectors.UsageCollector,
	) => Promise<void>,
) {
	const directory = mkdtempSync(join(tmpdir(), "quality-history-"));
	const operations = new DatabaseOperations(join(directory, "test.db"));
	const writer = new AsyncDbWriter();
	const collector = new collectors.UsageCollector(
		operations,
		writer,
		() => false,
		() => {},
	);
	for (const restore of restores) restore();
	restores = [
		spyOn(collectors, "getUsageCollector").mockReturnValue(collector),
		spyOn(collectors, "tryGetUsageCollector").mockReturnValue(collector),
	].map((spy) => () => spy.mockRestore());
	ctx.dbOps = operations;
	ctx.asyncWriter = writer;
	service = new QualityRouteService(operations.getQualityRouteRepository());
	ctx.qualityRouteService = service;
	try {
		for (const a of accounts)
			await operations
				.getAdapter()
				.run(
					"INSERT INTO accounts (id, name, provider, api_key, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[
						a.id,
						a.name,
						a.provider,
						a.api_key,
						a.access_token,
						a.expires_at,
						1,
					],
				);
		await run(operations, collector);
	} finally {
		await flush();
		await collector.drain();
		collector.dispose();
		await operations.close();
		rmSync(directory, { recursive: true });
	}
}

it.each([
	"success",
	"context-overflow",
	"missing-catalog",
])("first Auto fallback persists Astra winner after %s through real history", async (mode) => {
	let rejectContext = mode === "context-overflow";
	if (mode === "missing-catalog") resetModelCatalogForTest();
	const codex = {
		...account("c"),
		provider: "codex",
		api_key: null,
		access_token: "synthetic-codex",
		expires_at: Date.now() + 3600000,
	};
	accounts.push(codex);
	const base = ctx.config.getQualityRoutingPolicy();
	if (!base) throw new Error("Missing policy fixture");
	const policy = compileQualityRoutingPolicy({
		version: base.version,
		fallbacks: base.fallbacks,
		assignments: [
			...base.assignments,
			{
				line: "gpt-astra",
				lane: "astra",
				priority: 0,
				upgrade: "same-line-supported",
			},
		],
		accounts: [
			...base.accounts,
			{ accountId: "c", provider: "codex", lines: ["gpt-astra"], priority: 0 },
		],
		spendGrants: [
			{
				accountId: "c",
				line: "gpt-astra",
				authorization: "operator-approved",
				scope: "outside-subscription",
			},
		],
	});
	ctx.config.getQualityRoutingPolicy = () => policy;
	for (const a of accounts)
		usageCache.set(a.id, {
			limits: [
				{
					kind: "weekly_all",
					percent: a.id === "c" ? 10 : 100,
					resets_at: Date.now() + 60000,
				},
			],
			spend: { enabled: false },
		} as never);
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = input instanceof Request ? input : new Request(input, init);
			if (req.method === "GET")
				return Response.json({
					models: [
						{
							slug: "gpt-6-astra",
							context_window: 100000,
							max_context_window: 100000,
							max_output_tokens: 1000,
							input_modalities: ["text"],
						},
					],
				});
			const body = (await req.json()) as { model: string };
			sends.push({
				model: body.model,
				authorization: req.headers.get("authorization"),
			});
			if (rejectContext)
				return Response.json(
					{
						error: {
							code: "context_length_exceeded",
							message: "synthetic overflow",
						},
					},
					{ status: 400 },
				);
			return sse([
				{
					type: "response.created",
					response: { id: "resp-synthetic", model: body.model },
				},
				{ type: "response.output_text.delta", delta: "ok" },
				{
					type: "response.completed",
					response: {
						id: "resp-synthetic",
						model: body.model,
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			]);
		},
		{ preconnect: () => {} },
	) as typeof fetch;
	await withRealQualityHistory(async (operations, collector) => {
		await getCodexModels(codex.id, ctx);
		if (rejectContext) {
			const settlement = spyOn(service, "settleDispatch");
			try {
				const failed = await send();
				expect(failed.status).toBe(400);
				expect(await failed.json()).toMatchObject({
					error: { code: "context_length_exceeded" },
				});
				await flush();
				expect(sends).toHaveLength(1);
				expect(settlement).toHaveBeenCalledTimes(1);
				expect(settlement.mock.calls[0]?.[1]).toEqual({ kind: "failed" });
				expect((await service.status(scope))?.unresolved).toEqual([]);
				expect(await home()).toBeUndefined();
			} finally {
				settlement.mockRestore();
			}
			rejectContext = false;
		}
		const response = await send();
		expect({
			status: response.status,
			error: response.ok ? null : await response.clone().text(),
			state: response.ok ? null : await service.status(scope),
		}).toMatchObject({ status: 200 });
		await response.text();
		await flush();
		await collector.drain();
		expect(sends).toHaveLength(mode === "context-overflow" ? 2 : 1);
		const history = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(history).toHaveLength(mode === "context-overflow" ? 2 : 1);
		expect(history[0].qualityDecision).toMatchObject({
			requested: { kind: "main", preference: "auto" },
			selected: { accountId: "c", lane: "astra", physicalModel: "gpt-6-astra" },
			skippedLanes: [
				{
					lane: "fable",
					reasons: {
						[mode === "missing-catalog"
							? "evidence-missing"
							: "provider-capacity-exhausted"]: 2,
					},
				},
			],
			accounting: { kind: "estimate" },
		});
		expect(history[0].routeProvenance?.repinReason ?? null).toBeNull();
		const state = await service.status(scope);
		expect(state?.conversations[0]?.lastSuccessfulDecision?.requestId).toBe(
			history[0].id,
		);
		expect(state?.conversations[0]?.lastSuccessfulDecision?.value).toEqual(
			history[0].qualityDecision,
		);
		await operations.updateRequestUsage(history[0].id, {
			model: "gpt-6-astra",
			inputTokens: 15,
			outputTokens: 7,
		});
		const late = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(late[0].qualityDecision).toEqual(history[0].qualityDecision);
		const detail = await (
			await createRequestsDetailHandler(operations)()
		).json();
		expect(detail[0].qualityDecision).toEqual(history[0].qualityDecision);
		await operations.saveRequestPayload(history[0].id, {
			meta: {},
			qualityDecision: { secret: "must-not-escape" },
		});
		const payload = await (
			await createRequestPayloadHandler(operations)(history[0].id)
		).json();
		expect(payload.qualityDecision).toEqual(history[0].qualityDecision);
		await operations
			.getAdapter()
			.run("UPDATE requests SET quality_decision = ? WHERE id = ?", [
				"{malformed",
				history[0].id,
			]);
		const malformed = await (
			await createRequestPayloadHandler(operations)(history[0].id)
		).json();
		expect(malformed.qualityDecision).toBeNull();
	});
});

it("all rejected candidates persist a zero-send explanation without a selected home", async () => {
	for (const a of accounts)
		usageCache.set(a.id, {
			limits: [
				{ kind: "weekly_all", percent: 100, resets_at: Date.now() + 60000 },
			],
			spend: { enabled: false },
		} as never);
	await withRealQualityHistory(async (operations, collector) => {
		const response = await send();
		expect(response.status).toBe(503);
		await response.text();
		await flush();
		await collector.drain();
		expect(sends).toHaveLength(0);
		const history = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(history).toHaveLength(1);
		expect(history[0].accountUsed).toBeNull();
		expect(history[0].qualityDecision.selected).toBeNull();
		expect(history[0].qualityDecision.skippedLanes[0]).toEqual({
			lane: "fable",
			reasons: { "provider-capacity-exhausted": 2 },
		});
		const root = (await service.status(scope))?.conversations[0];
		expect(root?.home).toBeNull();
		expect(root?.decision?.value).toEqual(history[0].qualityDecision);
		expect(root?.decision?.requestId).toBe(history[0].id);
	});
});

it("adds enabled quality choices to local discovery without catalog or inference traffic", async () => {
	const local = [
		{
			id: "claude-bccf-route-existing",
			display_name: "Existing",
			description:
				"One pinned account, no fallback · subagents use the same account",
		},
	];
	// Fixture enrolls only the Fable, Opus, Sonnet and Haiku lines, no grants.
	const flowTail =
		", then error · keeps last working model · subscription only";
	ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry([
		{
			id: "existing",
			publicModelId: "claude-bccf-route-existing",
			discoveryModelId: "claude-bccf-route-existing",
			displayName: "Existing",
			accountId: "a",
			logicalModel: "claude-opus-5-5",
		},
	]);
	let fetches = 0;
	globalThis.fetch = Object.assign(
		async () => {
			fetches++;
			throw new Error("Discovery must be local");
		},
		{ preconnect: () => {} },
	) as typeof fetch;
	const response = await send(new Request("http://localhost/v1/models"));
	const body = (await response.json()) as {
		data: { id: string; display_name: string; description: string }[];
	};
	expect(body.data).toEqual([
		...local,
		{
			id: "claude-bccf-quality-auto",
			display_name: "Auto",
			description: `Fable → Opus${flowTail}`,
		},
		{
			id: "claude-bccf-quality-fable",
			display_name: "Fable-preferred",
			description: `Fable → Opus${flowTail}`,
		},
		{
			id: "claude-bccf-quality-astra",
			display_name: "Astra-preferred",
			description: `Opus${flowTail}`,
		},
		{
			id: "claude-bccf-quality-opus",
			display_name: "Opus-latest",
			description: `Opus${flowTail}`,
		},
	]);
	expect(fetches).toBe(0);
	const registry = ctx.modelRouteSessionRegistry;
	ctx.modelRouteSessionRegistry = undefined;
	expect(
		await (await send(new Request("http://localhost/v1/models"))).json(),
	).toEqual({ data: body.data.slice(1), has_more: false });
	ctx.modelRouteSessionRegistry = registry;
	ctx.qualityRouteService = undefined;
	expect(
		await (await send(new Request("http://localhost/v1/models"))).json(),
	).toEqual({ data: local, has_more: false });
	expect(fetches).toBe(0);
});
it("sends the exact physical model and settles a real SQLite home only after valid completion", async () => {
	const response = await send();
	expect(response.status).toBe(200);
	expect(await home()).toBeUndefined();
	await response.text();
	await flush();
	expect(sends).toEqual([
		{ model: "claude-fable-5-1", authorization: "synthetic-a" },
	]);
	expect((await home())?.physicalModel).toBe("claude-fable-5-1");
});
it("rejects unknown quality IDs and hard-route conflicts without provider sends or accepted intent", async () => {
	expect((await send(request("claude-bccf-quality-unknown"))).status).toBe(400);
	expect(
		(await send(request(undefined, { "x-better-ccflare-account-id": "a" })))
			.status,
	).toBe(400);
	expect(sends).toHaveLength(0);
	expect(await service.status(scope)).toBeNull();
});
it("preserves native adaptive thinking and effort through owned admission and durable completion", async () => {
	const body = {
		thinking: { type: "adaptive" },
		output_config: { effort: "high" },
		metadata: { user_id: "synthetic-claude-code" },
	};
	const response = await send(request(undefined, {}, body));
	expect(response.status).toBe(200);
	await response.text();
	await flush();
	expect(envelopes).toHaveLength(1);
	expect(envelopes[0]).toMatchObject(body);
	expect(await home()).toMatchObject({ physicalModel: "claude-fable-5-1" });
});

it.each([
	false,
	true,
])("preserves native context edits, deferred schemas (%s) and signed thinking history without discounts", async (defer_loading) => {
	const body = {
		thinking: { type: "adaptive" },
		context_management: {
			edits: [
				{ type: "clear_thinking_20251015" },
				{ type: "clear_tool_uses_20250919" },
			],
		},
		tools: [
			{
				name: "lookup",
				defer_loading,
				input_schema: {
					type: "object",
					properties: { query: { type: "string" } },
				},
			},
		],
		messages: [
			{ role: "user", content: "Find the answer" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Inspect previous results",
						signature: "synthetic-signed-history",
					},
					{
						type: "tool_use",
						id: "call-1",
						name: "lookup",
						input: { query: "answer" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-1", content: "42" },
				],
			},
		],
	};
	const response = await send(request(undefined, {}, body));
	expect(response.status).toBe(200);
	await response.text();
	await flush();
	expect(envelopes).toHaveLength(1);
	expect(envelopes[0]).toMatchObject(body);
	expect(await home()).toMatchObject({ physicalModel: "claude-fable-5-1" });
});

it.each([
	false,
	true,
])("counts all deferred schema bytes even with defer_loading=%s", async (defer_loading) => {
	const tool = {
		name: "lookup",
		defer_loading,
		input_schema: { type: "object", description: "x".repeat(90000) },
	};
	const response = await send(
		request(
			undefined,
			{},
			{
				tools: [tool],
				context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
			},
		),
	);
	expect(response.status).toBe(503);
	expect(sends).toHaveLength(0);
	expect(await home()).toBeUndefined();
});

it.each([
	{ thinking: { type: "adaptive", unknown: true } },
	{ output_config: { effort: "unlimited" } },
	{ output_config: { effort: "high", unknown: true } },
	{
		thinking: { type: "disabled" },
		context_management: { edits: [{ type: "clear_thinking_20251015" }] },
	},
	{ context_management: { edits: [{ type: "future_edit" }] } },
	{
		tools: [
			{ type: "custom", name: "lookup", input_schema: { type: "object" } },
		],
	},
	{
		tools: [
			{
				name: "lookup",
				input_schema: { type: "object" },
				defer_loading: "true",
			},
		],
	},
	{
		messages: [
			{
				role: "assistant",
				content: [{ type: "redacted_thinking", data: "opaque" }],
			},
		],
	},
	{
		messages: [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "history", signature: 1 }],
			},
		],
	},
])("does not broaden native admission to unknown or incompatible shapes: %j", async (body) => {
	const response = await send(request(undefined, {}, body));
	expect(response.status).toBe(503);
	expect(sends).toHaveLength(0);
	expect(await home()).toBeUndefined();
});

it("requires a verified API principal, not raw authorization", async () => {
	expect(
		(await send(request(undefined, { authorization: "Bearer spoof" }), null))
			.status,
	).toBe(400);
	expect(sends).toHaveLength(0);
});
it("HTTP 200 with invalid JSON cannot install a home", async () => {
	upstream = () =>
		new Response("{}", { headers: { "content-type": "application/json" } });
	await (await send()).text();
	await flush();
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
});
function sse(events: unknown[]) {
	return new Response(
		events
			.map(
				(event) =>
					`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
const startEvent = {
	type: "message_start",
	message: {
		id: "msg",
		type: "message",
		role: "assistant",
		model: "claude-fable-5-1",
		content: [],
		usage: { input_tokens: 1, output_tokens: 0 },
	},
};
const successEvents = [
	startEvent,
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "ok" },
	},
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 1 },
	},
	{ type: "message_stop" },
];
it.each([
	"auto",
	"fable",
	"astra",
	"opus",
])("preference %s begins on its approved suffix", async (preference) => {
	await (await send(request(`claude-bccf-quality-${preference}`))).text();
	await flush();
	expect(sends[0]?.model).toBe(
		preference === "auto" || preference === "fable"
			? "claude-fable-5-1"
			: "claude-opus-5-5",
	);
});
it("synthesized terminal recovery is not provider success evidence for a home", async () => {
	upstream = () => sse(successEvents.slice(0, -1));
	const response = await send(request(undefined, {}, { stream: true }));
	await response.text();
	await flush();
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
});
it("valid native terminal stream installs a home; HTTP headers alone do not", async () => {
	upstream = () => sse(successEvents);
	const response = await send(request(undefined, {}, { stream: true }));
	expect(await home()).toBeUndefined();
	await response.text();
	await flush();
	expect((await home())?.physicalModel).toBe("claude-fable-5-1");
	expect(sends).toHaveLength(1);
});
it.each([
	"eof",
	"error",
])("%s after stream output never replays or installs a home", async (kind) => {
	upstream = () =>
		sse([
			startEvent,
			successEvents[1],
			successEvents[2],
			...(kind === "error"
				? [
						{
							type: "error",
							error: { type: "overloaded_error", message: "synthetic" },
						},
					]
				: []),
		]);
	await (await send(request(undefined, {}, { stream: true }))).text();
	await flush();
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
});
it("downstream cancellation cannot install a home", async () => {
	upstream = () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(`data: ${JSON.stringify(startEvent)}\n\n`),
					);
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	const response = await send(request(undefined, {}, { stream: true }));
	await response.body?.cancel();
	await flush();
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
});
it("children get independent standard and light homes while root stream is running", async () => {
	upstream = () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(`data: ${JSON.stringify(startEvent)}\n\n`),
					);
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	const root = await send(request(undefined, {}, { stream: true }));
	expect(await home()).toBeUndefined();
	upstream = complete;
	for (const [id, model] of [
		["standard-child", "claude-sonnet-5-5"],
		["light-child", "claude-haiku-4-5"],
	])
		await (await send(request(model, { "x-claude-code-agent-id": id }))).text();
	await flush();
	const status = await service.status(scope);
	expect(
		status?.conversations
			.filter((c) => c.key !== "$root")
			.map((c) => c.home?.target.physicalModel),
	).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5"]);
	expect(sends.map((s) => s.model)).toEqual([
		"claude-fable-5-1",
		"claude-sonnet-5-5",
		"claude-haiku-4-5",
	]);
	await root.body?.cancel();
});
it("authorized marker-only worker is request-only and never gets a guessed home", async () => {
	await (await send()).text();
	await flush();
	const before = (await service.status(scope))?.conversations;
	for (let n = 0; n < 2; n++) {
		await (
			await send(
				request("claude-sonnet-5-5", {
					"x-anthropic-billing-header": "cc_is_subagent=true",
				}),
			)
		).text();
		await flush();
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
	}
	expect(sends.map((s) => s.model)).toEqual([
		"claude-fable-5-1",
		"claude-sonnet-5-5",
		"claude-sonnet-5-5",
	]);
	expect((await service.status(scope))?.conversations).toEqual(before);
});
it("marker-only proven no-work rejection settles its fence before safe account failover", async () => {
	await (await send()).text();
	await flush();
	const before = (await service.status(scope))?.conversations;
	upstream = () =>
		sends.length === 2
			? Response.json(
					{ error: { type: "rate_limit_error" } },
					{
						status: 429,
						headers: { "anthropic-ratelimit-unified-status": "rejected" },
					},
				)
			: complete();
	const response = await send(
		request("claude-sonnet-5-5", {
			"x-anthropic-billing-header": "cc_is_subagent=true",
		}),
	);
	expect(response.status).toBe(200);
	await response.text();
	await flush();
	expect(sends.slice(1)).toEqual([
		{ model: "claude-sonnet-5-5", authorization: "synthetic-a" },
		{ model: "claude-sonnet-5-5", authorization: "synthetic-b" },
	]);
	expect((await service.status(scope))?.unresolved).toHaveLength(0);
	expect((await service.status(scope))?.conversations).toEqual(before);
});
it("marker-only ambiguous send stays fenced across service and repository restart", async () => {
	await (await send()).text();
	await flush();
	const before = (await service.status(scope))?.conversations;
	const worker = () =>
		request("claude-sonnet-5-5", {
			"x-anthropic-billing-header": "cc_is_subagent=true",
		});
	upstream = () => {
		throw new Error("synthetic connection loss after write");
	};
	await (await send(worker())).text();
	await flush();
	expect(sends).toHaveLength(2);
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
	);
	ctx.qualityRouteService = service;
	await (await send(worker())).text();
	await flush();
	expect(sends).toHaveLength(2);
	expect((await service.status(scope))?.unresolved).toHaveLength(1);
	expect((await service.status(scope))?.conversations).toEqual(before);
});
it("request-only fallback records the actual winner without relabeling the healthy home", async () => {
	await withRealQualityHistory(async (operations, collector) => {
		await (await send()).text();
		await flush();
		expect((await home())?.accountId).toBe("a");
		await operations
			.getAdapter()
			.run("UPDATE accounts SET rate_limited_until = ? WHERE id = ?", [
				Date.now() + 60000,
				"a",
			]);
		await (await send()).text();
		await flush();
		await collector.drain();
		expect(sends[1]?.authorization).toBe("synthetic-b");
		expect((await home())?.accountId).toBe("a");
		const history = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(history).toHaveLength(2);
		expect(history[0].qualityDecision.selected.accountId).toBe("b");
		expect(history[1].qualityDecision.selected.accountId).toBe("a");
		const root = (await service.status(scope))?.conversations[0];
		expect(root?.lastSuccessfulDecision?.value.selected?.accountId).toBe("b");
		expect(root?.lastSuccessfulDecision?.requestId).toBe(history[0].id);
	});
});

it("healthy home survives priority changes and temporary request-only fallback", async () => {
	await (await send()).text();
	await flush();
	accounts[0].priority = 100;
	accounts[1].priority = 0;
	await (await send()).text();
	await flush();
	expect(sends[1]?.authorization).toBe("synthetic-a");
	accounts[0].rate_limited_until = Date.now() + 60000;
	await (await send()).text();
	await flush();
	expect(sends[2]?.authorization).toBe("synthetic-b");
	expect((await home())?.accountId).toBe("a");
	accounts[0].rate_limited_until = null;
	await (await send()).text();
	expect(sends[3]?.authorization).toBe("synthetic-a");
});
it.each([
	["quota", "preparation"],
	["unpause", "preparation"],
	["quota", "fence"],
	["unpause", "fence"],
	["quota", "status"],
	["unpause", "status"],
])("recovered home cannot be replaced by stale %s evidence during %s", async (cause, boundary) => {
	await (await send()).text();
	await flush();
	const originalHome = await home();
	const setQuota = (percent: number) =>
		usageCache.set("a", {
			limits: [{ kind: "weekly_all", percent, resets_at: Date.now() + 60000 }],
			spend: { enabled: false },
		} as never);
	if (cause === "quota") setQuota(100);
	else accounts[0] = { ...accounts[0], paused: true };
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const barrier = async () => {
		reached.resolve();
		await release.promise;
	};
	const provider = getProvider("anthropic");
	if (!provider?.transformRequestBody) throw new Error("missing provider");
	const transform = provider.transformRequestBody.bind(provider);
	const begin = service.beginDispatch.bind(service);
	const status = service.status.bind(service);
	let fenced = false;
	const spies = [
		spyOn(provider, "transformRequestBody").mockImplementation(
			async (...args) => {
				const result = await transform(...args);
				if (boundary === "preparation") await barrier();
				return result;
			},
		),
		spyOn(service, "beginDispatch").mockImplementation(async (...args) => {
			await begin(...args);
			fenced = true;
			if (boundary === "fence") await barrier();
		}),
		spyOn(service, "status").mockImplementation(async (...args) => {
			const result = await status(...args);
			if (boundary === "status" && fenced) await barrier();
			return result;
		}),
	];
	try {
		const pending = send();
		await reached.promise;
		if (cause === "quota") setQuota(10);
		else accounts[0] = { ...accounts[0], paused: false };
		release.resolve();
		const response = await pending;
		await response.text();
		await flush();
		expect(await home()).toEqual(originalHome);
		if (boundary === "preparation") {
			expect(response.status).toBe(200);
			expect(sends[1]?.authorization).toBe("synthetic-b");
		} else {
			expect(response.status).toBe(503);
			expect(sends).toHaveLength(1);
		}
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
	} finally {
		release.resolve();
		for (const spy of spies) spy.mockRestore();
	}
});

it("same-account Opus remains eligible when Fable scoped quota is exhausted", async () => {
	for (const a of accounts)
		usageCache.set(a.id, {
			limits: [
				{ kind: "weekly_all", percent: 10, resets_at: Date.now() + 60000 },
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: Date.now() + 60000,
					scope: { model: { display_name: "Fable" } },
				},
			],
			spend: { enabled: false },
		} as never);
	await (await send()).text();
	await flush();
	expect(sends).toEqual([
		{ model: "claude-opus-5-5", authorization: "synthetic-a" },
	]);
	expect((await home())?.lane).toBe("opus");
});
it("missing capabilities, output overflow, and removed enrollment produce zero sends", async () => {
	expect(
		(await send(request(undefined, {}, { max_tokens: 1001 }))).status,
	).toBe(503);
	expect(sends).toHaveLength(0);
	resetModelCatalogForTest();
	expect((await send()).status).toBe(503);
	expect(sends).toHaveLength(0);
});
it("persistent settlement failure retains a restart-visible fence without replay", async () => {
	const fail = spyOn(service, "settleDispatch").mockRejectedValue(
		new Error("synthetic SQLite write failure"),
	);
	await (await send()).text();
	await flush();
	expect(fail).toHaveBeenCalledTimes(3);
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
	await service.stop();
	fail.mockRestore();
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
	);
	ctx.qualityRouteService = service;
	expect((await service.status(scope))?.unresolved).toHaveLength(1);
	expect((await send()).status).toBe(503);
	expect(sends).toHaveLength(1);
});
it.each([
	"root",
	"child",
	"request-only",
])("delivered %s output recovers after three write failures without another fetch", async (mode) => {
	const scheduled: (() => void)[] = [];
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
		Date.now,
		{
			schedule: (callback) => {
				scheduled.push(callback);
				return () => {};
			},
		},
	);
	ctx.qualityRouteService = service;
	if (mode !== "root") {
		await (await send()).text();
		await flush();
	}
	const original = service.settleDispatch.bind(service);
	let writes = 0;
	const fail = spyOn(service, "settleDispatch").mockImplementation(
		(...args) => {
			if (++writes <= 3)
				return Promise.reject(new Error("database unavailable"));
			return original(...args);
		},
	);
	try {
		const input =
			mode === "root"
				? request()
				: request(
						"claude-sonnet-5-5",
						mode === "child"
							? { "x-claude-code-agent-id": "worker" }
							: { "x-anthropic-billing-header": "cc_is_subagent=true" },
					);
		expect((await (await send(input)).json()).content).toEqual([
			{ type: "text", text: "ok" },
		]);
		await flush();
		expect(writes).toBe(3);
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
		expect(scheduled).toHaveLength(1);
		scheduled.shift()?.();
		await flush();
		expect((await home())?.accountId).toBe("a");
		expect((await home())?.physicalModel).toBe("claude-fable-5-1");
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
		if (mode === "child")
			expect(
				(await service.status(scope))?.conversations
					.filter((item) => item.key !== "$root")
					.map((item) => item.home?.target.physicalModel),
			).toEqual(["claude-sonnet-5-5"]);
		if (mode === "request-only")
			expect((await service.status(scope))?.conversations).toHaveLength(1);
		expect(sends).toHaveLength(mode === "root" ? 1 : 2);
	} finally {
		fail.mockRestore();
	}
});
it("recovery capacity is reserved before an asynchronous lease and rejects concurrent inference", async () => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
		Date.now,
		{ capacity: 1 },
	);
	ctx.qualityRouteService = service;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const acquire = service.acquireLease.bind(service);
	const hold = spyOn(service, "acquireLease").mockImplementationOnce(
		async (...args) => {
			entered.resolve();
			await release.promise;
			return acquire(...args);
		},
	);
	const first = send();
	try {
		await entered.promise;
		expect(
			(
				await send(
					request(undefined, { "x-claude-code-session-id": "another-session" }),
				)
			).status,
		).toBe(503);
		expect(sends).toHaveLength(0);
		release.resolve();
		await (await first).text();
		await flush();
		expect(sends).toHaveLength(1);
		expect(service.reserveObservedSettlement()).not.toBeNull();
	} finally {
		release.resolve();
		hold.mockRestore();
	}
});
it("begin-dispatch failure returns recovery capacity without inventing a provider outcome", async () => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
		Date.now,
		{ capacity: 1 },
	);
	ctx.qualityRouteService = service;
	const begin = spyOn(service, "beginDispatch").mockRejectedValue(
		new Error("write failed"),
	);
	const settle = spyOn(service, "settleDispatch");
	try {
		expect((await send()).status).toBe(503);
		expect(sends).toHaveLength(0);
		expect(settle).not.toHaveBeenCalled();
		const next = service.reserveObservedSettlement();
		expect(next).not.toBeNull();
		next?.release();
	} finally {
		begin.mockRestore();
		settle.mockRestore();
	}
});
it("abort during lease acquisition releases capacity without a provider outcome", async () => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
		Date.now,
		{ capacity: 1 },
	);
	ctx.qualityRouteService = service;
	const abort = new AbortController();
	const original = service.acquireLease.bind(service);
	const acquire = spyOn(service, "acquireLease").mockImplementationOnce(
		async (...args) => {
			const lease = await original(...args);
			abort.abort();
			return lease;
		},
	);
	const settle = spyOn(service, "settleDispatch");
	try {
		expect(
			(await send(new Request(request(), { signal: abort.signal }))).status,
		).toBe(503);
		expect(sends).toHaveLength(0);
		expect(settle).not.toHaveBeenCalled();
		const next = service.reserveObservedSettlement();
		expect(next).not.toBeNull();
		next?.release();
	} finally {
		acquire.mockRestore();
		settle.mockRestore();
	}
});
it("lost settlement response retries only persistence", async () => {
	const settle = service.settleDispatch.bind(service);
	const lost = spyOn(service, "settleDispatch").mockImplementationOnce(
		async (identity, outcome) => {
			await settle(identity, outcome);
			throw new Error("synthetic committed reply loss");
		},
	);
	await (await send()).text();
	await flush();
	expect(lost).toHaveBeenCalledTimes(2);
	expect(sends).toHaveLength(1);
	expect((await home())?.accountId).toBe("a");
	lost.mockRestore();
});
it.each([
	"active",
	"fresh",
	"left",
])("older buffered root cannot reinstate enrollment after newer native intent (%s)", async (state) => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db), { maxSessions: 1 }),
	);
	ctx.qualityRouteService = service;
	if (state !== "fresh") {
		await (await send()).text();
		await flush();
	}
	if (state === "left") {
		await (await send(request("claude-opus-5-5"))).text();
		await flush();
	}
	let release: (chunk: Uint8Array) => void = () => {};
	const delayed = new Request("https://proxy.invalid/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-claude-code-session-id": scope.sessionId,
		},
		body: new ReadableStream({
			start(controller) {
				release = (chunk) => {
					controller.enqueue(chunk);
					controller.close();
				};
			},
		}),
		duplex: "half",
	} as RequestInit);
	const pending = send(delayed);
	await flush();
	await (await send(request("claude-opus-5-5"))).text();
	await flush();
	const before = sends.length;
	release(
		new TextEncoder().encode(
			JSON.stringify({
				model: "claude-bccf-quality-auto",
				messages: [{ role: "user", content: "old" }],
				max_tokens: 20,
			}),
		),
	);
	expect((await pending).status).toBe(503);
	expect(sends).toHaveLength(before);
	const status = await service.status(scope);
	if (state === "fresh") {
		expect(status).toBeNull();
	} else {
		expect(status).not.toBeNull();
		expect(status?.preference).toBeNull();
	}
});
it("candidate authority is immutable and exhausts each lane before the next", () => {
	accounts[0].priority = 100;
	accounts[1].priority = 0;
	const policy = ctx.config.getQualityRoutingPolicy();
	if (!policy) throw new Error("policy fixture missing");
	const plan = compileQualityCandidates(
		policy,
		{ kind: "main", preference: "auto" },
		accounts,
	);
	expect(
		plan.candidates.map((c) => [c.target.accountId, c.target.physicalModel]),
	).toEqual([
		["b", "claude-fable-5-1"],
		["a", "claude-fable-5-1"],
		["b", "claude-opus-5-5"],
		["a", "claude-opus-5-5"],
	]);
	expect(Object.isFrozen(plan)).toBe(true);
	expect(
		plan.candidates.every(
			(c) => Object.isFrozen(c) && Object.isFrozen(c.target),
		),
	).toBe(true);
});
it("existing strategy route circuits veto exact candidates without installing a parallel home", async () => {
	const strategy = new SessionAffinityStrategy();
	ctx.strategy = strategy;
	const select = strategy.select.bind(strategy);
	let selectedMeta: Parameters<typeof select>[1] | null = null;
	const observer = spyOn(strategy, "select").mockImplementation(
		async (accounts, meta) => {
			selectedMeta = meta;
			return select(accounts, meta);
		},
	);
	try {
		await (await send()).text();
		await flush();
		expect(strategy.affinityEntries).toBe(0);
		if (!selectedMeta) throw new Error("missing real strategy selection");
		strategy.reportCandidateFailure(selectedMeta, {
			candidateId: JSON.stringify(["a", "claude-fable-5-1", "claude-fable"]),
			reason: "synthetic-timeout",
			suppressForMs: 60000,
		});
		await (await send()).text();
		await flush();
		expect(sends[1]?.authorization).toBe("synthetic-b");
		expect((await home())?.accountId).toBe("a");
		expect(strategy.affinityEntries).toBe(0);
	} finally {
		observer.mockRestore();
	}
});
it("proven native no-work rejection tries another account with that account's credentials", async () => {
	upstream = () =>
		sends.length === 1
			? Response.json(
					{
						type: "error",
						error: { type: "rate_limit_error", message: "synthetic limit" },
					},
					{
						status: 429,
						headers: { "anthropic-ratelimit-unified-status": "rejected" },
					},
				)
			: complete();
	const response = await send();
	expect(response.status).toBe(200);
	await response.text();
	await flush();
	expect(sends).toEqual([
		{ model: "claude-fable-5-1", authorization: "synthetic-a" },
		{ model: "claude-fable-5-1", authorization: "synthetic-b" },
	]);
	expect((await home())?.accountId).toBe("b");
});
it("queued no-work settlement does not authorize the next candidate before acknowledgement", async () => {
	const pending: (() => void | Promise<void>)[] = [];
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
		Date.now,
		{
			schedule: (callback) => {
				pending.push(callback);
				return () => {};
			},
		},
	);
	ctx.qualityRouteService = service;
	upstream = () =>
		Response.json(
			{
				type: "error",
				error: { type: "rate_limit_error", message: "synthetic limit" },
			},
			{
				status: 429,
				headers: { "anthropic-ratelimit-unified-status": "rejected" },
			},
		);
	const write = spyOn(service, "settleDispatch").mockRejectedValue(
		new Error("outage"),
	);
	try {
		expect((await send()).status).toBe(503);
		expect(write).toHaveBeenCalledTimes(3);
		expect(sends).toHaveLength(1);
		expect(pending).toHaveLength(1);
		write.mockRestore();
		await pending.shift()?.();
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
		expect(await home()).toBeUndefined();
		expect(sends).toHaveLength(1);
	} finally {
		write.mockRestore();
	}
});
it("hard no-work rejection of the exact healthy home authorizes its replacement", async () => {
	await (await send()).text();
	await flush();
	expect((await home())?.accountId).toBe("a");
	upstream = () =>
		sends.length === 2
			? Response.json(
					{ error: { type: "rate_limit_error" } },
					{
						status: 429,
						headers: { "anthropic-ratelimit-unified-status": "rejected" },
					},
				)
			: complete();
	await (await send()).text();
	await flush();
	expect(sends.map((s) => s.authorization)).toEqual([
		"synthetic-a",
		"synthetic-a",
		"synthetic-b",
	]);
	expect((await home())?.accountId).toBe("b");
});
it("complete generic 429 settles failure without replay or replacing the home", async () => {
	await (await send()).text();
	await flush();
	const settlement = spyOn(service, "settleDispatch");
	upstream = () =>
		Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
	const rejected = await send();
	const rejectedBody = await rejected.text();
	expect([rejected.status, rejectedBody]).toEqual([
		429,
		JSON.stringify({ error: { type: "rate_limit_error" } }),
	]);
	await flush();
	expect(sends).toHaveLength(2);
	expect((await home())?.accountId).toBe("a");
	expect(settlement).toHaveBeenCalledTimes(1);
	expect(settlement.mock.calls[0]?.[1]).toEqual({ kind: "failed" });
	expect(
		usageCache.getModelScopedExhaustion("a", "claude-fable-5-1"),
	).not.toBeNull();
	upstream = complete;
	accounts[0].rate_limited_until = Date.now() + 60000;
	const next = await send();
	expect(next.status).toBe(200);
	await next.text();
	await flush();
	expect(sends).toHaveLength(3);
	expect((await home())?.accountId).toBe("a");
	settlement.mockRestore();
});
it.each([
	["claude-opus-5-5", "claude-sonnet-5-5"],
	["claude-sonnet-5-5", "claude-opus-5-5"],
])("child role uses intercepted %s → %s, not parent preference", async (original, rewritten) => {
	await (await send()).text();
	await flush();
	const preference = spyOn(ctx.dbOps, "getAgentPreference").mockResolvedValue({
		model: rewritten,
	} as never);
	try {
		const response = await send(
			request(original, {
				"x-better-ccflare-agent-id": "rewritten-worker",
				"x-claude-code-agent-id": "rewritten-worker",
			}),
		);
		expect(response.status).toBe(200);
		await response.text();
		await flush();
		expect(sends[1]?.model).toBe(rewritten);
		expect((await service.status(scope))?.preference).toBe("auto");
		expect((await home())?.physicalModel).toBe("claude-fable-5-1");
		expect(
			(await service.status(scope))?.conversations.find(
				(c) => c.key !== "$root",
			)?.home?.target.physicalModel,
		).toBe(rewritten);
	} finally {
		preference.mockRestore();
	}
});
it.each([
	"claude-bccf-quality-auto",
	"claude-bccf-quality-fable",
	"claude-bccf-quality-astra",
	"claude-bccf-quality-opus",
])("child inheriting picker id %s routes as a standard worker", async (pickerId) => {
	await (await send()).text();
	await flush();
	const response = await send(
		request(pickerId, { "x-claude-code-agent-id": "inherited-picker-child" }),
	);
	expect(response.status).toBe(200);
	await response.text();
	await flush();
	expect(sends[1]?.model).toBe("claude-sonnet-5-5");
	expect((await service.status(scope))?.preference).toBe("auto");
	expect((await home())?.physicalModel).toBe("claude-fable-5-1");
	expect(
		(await service.status(scope))?.conversations.find((c) => c.key !== "$root")
			?.home?.target.physicalModel,
	).toBe("claude-sonnet-5-5");
});
it("explicit native frontier child is not downgraded to standard", async () => {
	await (await send()).text();
	await flush();
	const response = await send(
		request("claude-fable-5-1", { "x-claude-code-agent-id": "fable-child" }),
	);
	expect(response.status).toBe(200);
	await response.text();
	await flush();
	expect(sends[1]?.model).toBe("claude-fable-5-1");
	expect(
		(await service.status(scope))?.conversations.find((c) => c.key !== "$root")
			?.home?.target.physicalModel,
	).toBe("claude-fable-5-1");
});
it("child sending an unknown quality id is rejected before worker routing", async () => {
	await (await send()).text();
	await flush();
	const response = await send(
		request("claude-bccf-quality-unknown", {
			"x-claude-code-agent-id": "unknown-picker-child",
		}),
	);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({
		error: { reason: "unknown-or-disabled-quality-id" },
	});
	expect(sends).toHaveLength(1);
	expect(
		(await service.status(scope))?.conversations.filter(
			(c) => c.key !== "$root",
		),
	).toEqual([]);
});
it.each([
	["larger than analytics", 300 * 1024, "", true],
	["exact analytics boundary", 256 * 1024, "", true],
	["invalid tail past analytics", 256 * 1024, "invalid", false],
	["exact validation bound", 8 * 1024 * 1024, "", true],
	["oversized validation", 8 * 1024 * 1024, " ", false],
] as const)("whole nonstream validation: %s", async (_label, size, tail, valid) => {
	let json = await complete().text();
	if (valid) {
		const message = JSON.parse(json);
		message.content[0].text = "x".repeat(size - json.length + 2);
		json = JSON.stringify(message);
	}
	const payload = json + " ".repeat(size - json.length) + tail;
	upstream = () =>
		new Response(payload, { headers: { "content-type": "application/json" } });
	const settlement = spyOn(service, "settleDispatch");
	const response = await send();
	expect(await response.text()).toBe(payload);
	await flush();
	expect(Boolean(await home())).toBe(valid);
	expect(settlement).toHaveBeenCalledTimes(1);
	expect(settlement.mock.calls[0]?.[1]).toEqual({
		kind: valid ? "validated-success" : "failed",
	});
	expect(sends).toHaveLength(1);
	settlement.mockRestore();
});
it.each([
	400, 401, 403, 429, 500, 529, 204,
])("terminal status %s settles one failure and permits a later continuation", async (status) => {
	upstream = () =>
		status === 204
			? new Response(null, { status })
			: Response.json({ error: { type: "synthetic_error" } }, { status });
	const settlement = spyOn(service, "settleDispatch");
	const response = await send();
	expect(response.status).toBe(status);
	await response.text();
	await flush();
	expect(sends).toHaveLength(1);
	expect(settlement).toHaveBeenCalledTimes(1);
	expect(settlement.mock.calls[0]?.[1]).toEqual({ kind: "failed" });
	expect(await home()).toBeUndefined();
	upstream = complete;
	const next = await send();
	expect(next.status).toBe(200);
	await next.text();
	await flush();
	expect(sends).toHaveLength(2);
	settlement.mockRestore();
});
it.each([
	"eof",
	"error",
	"cancel",
])("nonstream %s settles exactly once without a home or replay", async (ending) => {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	upstream = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					c.enqueue(new TextEncoder().encode('{"type":"message"'));
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
	const settlement = spyOn(service, "settleDispatch");
	const response = await send();
	if (!controller) throw new Error("missing synthetic response controller");
	if (ending === "cancel") {
		const cancelled = response.body?.cancel();
		await flush();
		expect(settlement).toHaveBeenCalledTimes(1);
		// The existing usage clone owns the other tee branch. Release that
		// synthetic source after observing cancellation, not before it.
		controller.close();
		await cancelled;
	} else {
		const reading = response.text();
		if (ending === "error") {
			controller.error(new Error("synthetic read error"));
			await expect(reading).rejects.toThrow("synthetic read error");
		} else {
			controller.close();
			await reading;
		}
	}
	await flush();
	expect(settlement).toHaveBeenCalledTimes(1);
	expect(settlement.mock.calls[0]?.[1]).toEqual({
		kind: ending === "cancel" ? "cancelled" : "failed",
	});
	expect(await home()).toBeUndefined();
	expect(sends).toHaveLength(1);
	settlement.mockRestore();
});
it.each([
	"claude-bccf-quality-unknown",
	"claude-bccf-route-unknown",
	"",
])("invalid model %s cannot erase accepted intent", async (model) => {
	await (await send()).text();
	await flush();
	await (await send(request(model))).text();
	expect((await service.status(scope))?.preference).toBe("auto");
});
it("unproven 429 does not replay", async () => {
	upstream = () =>
		Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
	await (await send()).text();
	await flush();
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
});
it.each([
	"credential",
	"catalog",
	"grant",
	"intent",
])("%s changed during real preparation blocks the prepared target", async (change) => {
	const provider = getProvider("anthropic");
	if (!provider?.transformRequestBody)
		throw new Error("missing native provider");
	const transform = provider.transformRequestBody.bind(provider);
	let changed = false;
	const spy = spyOn(provider, "transformRequestBody").mockImplementation(
		async (...args) => {
			const prepared = await transform(...args);
			if (!changed) {
				changed = true;
				if (change === "credential")
					for (const a of accounts) a.api_key = "rotated";
				if (change === "catalog") resetModelCatalogForTest();
				if (change === "grant") ctx.config.getQualityRoutingPolicy = () => null;
				if (change === "intent") {
					const ticket = await service.reserveIngress(scope);
					await service.acceptRoot(ticket, null);
				}
			}
			return prepared;
		},
	);
	try {
		expect((await send()).status).toBe(503);
		expect(sends).toHaveLength(0);
		expect(await home()).toBeUndefined();
	} finally {
		spy.mockRestore();
	}
});
it("new durable intent while dispatch persistence awaits still blocks the physical send", async () => {
	const begin = service.beginDispatch.bind(service);
	const spy = spyOn(service, "beginDispatch").mockImplementationOnce(
		async (...args) => {
			await begin(...args);
			const ticket = await service.reserveIngress(scope);
			await service.acceptRoot(ticket, null);
		},
	);
	try {
		expect((await send()).status).toBe(503);
		expect(sends).toHaveLength(0);
		expect((await service.status(scope))?.preference).toBeNull();
	} finally {
		spy.mockRestore();
	}
});
it("revoked affirmative overage grant blocks transport after preparation", async () => {
	const base = ctx.config.getQualityRoutingPolicy();
	if (!base) throw new Error("missing fixture policy");
	const config = {
		version: base.version,
		assignments: base.assignments,
		accounts: base.accounts,
		fallbacks: base.fallbacks,
		spendGrants: accounts.map((a) => ({
			accountId: a.id,
			line: "claude-fable",
			authorization: "operator-approved",
			scope: "outside-subscription",
		})),
	};
	let current = compileQualityRoutingPolicy(config);
	ctx.config.getQualityRoutingPolicy = () => current;
	for (const a of accounts)
		usageCache.set(a.id, {
			limits: [
				{ kind: "weekly_all", percent: 10, resets_at: Date.now() + 60000 },
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: Date.now() + 60000,
					scope: { model: { display_name: "Fable" } },
				},
			],
			spend: { enabled: true, percent: 10 },
		} as never);
	const provider = getProvider("anthropic");
	if (!provider?.transformRequestBody) throw new Error("missing provider");
	const transform = provider.transformRequestBody.bind(provider);
	let preparations = 0;
	const spy = spyOn(provider, "transformRequestBody").mockImplementation(
		async (...args) => {
			preparations++;
			const prepared = await transform(...args);
			current = compileQualityRoutingPolicy({ ...config, spendGrants: [] });
			return prepared;
		},
	);
	try {
		expect((await send()).status).toBe(503);
		expect(preparations).toBeGreaterThan(0);
		expect(sends).toHaveLength(0);
	} finally {
		spy.mockRestore();
	}
});
it("unknown legacy profile cannot withdraw accepted quality intent", async () => {
	await (await send()).text();
	await flush();
	const before = sends.length;
	expect((await send(request("claude-bccf-route-unknown"))).status).not.toBe(
		200,
	);
	expect(sends).toHaveLength(before);
	expect((await service.status(scope))?.preference).toBe("auto");
});
it("unsupported hosted work remains typed unavailable rather than bypassing accounting", async () => {
	const response = await send(
		request(
			undefined,
			{},
			{ tools: [{ type: "web_search_20250305", name: "web_search" }] },
		),
	);
	expect(response.status).toBe(503);
	expect(
		((await response.json()) as { error: { code: string } }).error.code,
	).toBe("quality_route_unavailable");
	expect(sends).toHaveLength(0);
	expect(await home()).toBeUndefined();
});
it("quota exhaustion during preparation blocks the physical send even with manual throttles disabled", async () => {
	const provider = getProvider("anthropic");
	if (!provider?.transformRequestBody)
		throw new Error("missing native provider");
	const transform = provider.transformRequestBody.bind(provider);
	const spy = spyOn(provider, "transformRequestBody").mockImplementation(
		async (...args) => {
			const prepared = await transform(...args);
			for (const a of accounts)
				usageCache.set(a.id, {
					limits: [
						{ kind: "weekly_all", percent: 100, resets_at: Date.now() + 60000 },
					],
					spend: { enabled: false },
				} as never);
			return prepared;
		},
	);
	try {
		expect((await send()).status).toBe(503);
		expect(sends).toHaveLength(0);
		expect(await home()).toBeUndefined();
	} finally {
		spy.mockRestore();
	}
});

it("original output reserve cannot be weakened during provider transformation", async () => {
	const provider = getProvider("anthropic");
	if (!provider?.transformRequestBody)
		throw new Error("missing native provider");
	const transform = provider.transformRequestBody.bind(provider);
	const spy = spyOn(provider, "transformRequestBody").mockImplementation(
		async (...args) => {
			const prepared = await transform(...args);
			const body = await prepared.json();
			return new Request(prepared, {
				body: JSON.stringify({ ...body, max_tokens: 1 }),
			});
		},
	);
	try {
		expect((await send()).status).toBe(503);
		expect(sends).toHaveLength(0);
	} finally {
		spy.mockRestore();
	}
});
it("root leave preserves existing child lifecycle but never enrolls new children", async () => {
	await (await send()).text();
	await flush();
	await (
		await send(
			request("claude-sonnet-5-5", { "x-claude-code-agent-id": "existing" }),
		)
	).text();
	await flush();
	await (await send(request("claude-opus-5-5"))).text();
	await flush();
	expect((await service.status(scope))?.preference).toBeNull();
	await (
		await send(
			request("claude-sonnet-5-5", { "x-claude-code-agent-id": "existing" }),
		)
	).text();
	await flush();
	const before = (await service.status(scope))?.conversations.length;
	await (
		await send(
			request("claude-sonnet-5-5", { "x-claude-code-agent-id": "new" }),
		)
	).text();
	await flush();
	expect((await service.status(scope))?.conversations).toHaveLength(
		before ?? 0,
	);
	expect(
		(await service.status(scope))?.conversations.find(
			(c) => c.role === "standard",
		)?.home,
	).not.toBeNull();
});
it("stale successful root completion cannot reinstate enrollment", async () => {
	const old = await send();
	await (await send(request("claude-opus-5-5"))).text();
	await old.text();
	await flush();
	expect((await service.status(scope))?.preference).toBeNull();
	expect(await home()).toBeUndefined();
	expect(sends).toHaveLength(2);
});
it("two first requests cannot both cross the durable dispatch boundary", async () => {
	const responses = await Promise.all([send(), send()]);
	await Promise.all(responses.map((r) => r.text()));
	await flush();
	expect(sends).toHaveLength(1);
	expect((await home())?.accountId).toBe("a");
});
it("disabled service preserves ordinary native routing without durable enrollment", async () => {
	ctx.qualityRouteService = undefined;
	await (await send(request("claude-opus-5-5"))).text();
	expect(sends[0]?.model).toBe("claude-opus-5-5");
	expect(await service.status(scope)).toBeNull();
	expect((await send()).status).toBe(503);
	expect(sends).toHaveLength(1);
});
it("missing stable session rejects an explicit quality ID", async () => {
	const req = request();
	req.headers.delete("x-claude-code-session-id");
	expect((await send(req)).status).toBe(400);
	expect(sends).toHaveLength(0);
});
it.each([
	"retry",
	"preference",
	"removed-approved",
	"removed-exact",
])("owned Codex transport keeps an exact Sol predecessor and reconsiders only with authority: %s", async (action) => {
	const codex = {
		...account("c"),
		provider: "codex",
		api_key: null,
		access_token: "synthetic-c",
		expires_at: Date.now() + 3600000,
	};
	accounts = [codex];
	const models = ["gpt-5.6-sol"];
	const policy = compileQualityRoutingPolicy({
		version: 1,
		assignments: [
			{
				line: "gpt-sol",
				lane: "opus",
				priority: 0,
				upgrade: "same-line-supported",
			},
		],
		accounts: [
			{ accountId: "c", provider: "codex", lines: ["gpt-sol"], priority: 0 },
		],
		fallbacks: [
			{ from: "fable", to: "astra" },
			{ from: "astra", to: "opus" },
		],
		spendGrants: [
			{
				accountId: "c",
				line: "gpt-sol",
				authorization: "operator-approved",
				scope: "outside-subscription",
			},
		],
	});
	ctx.config.getQualityRoutingPolicy = () => policy;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = input instanceof Request ? input : new Request(input, init);
			if (req.method === "GET")
				return Response.json({
					models: models.map((slug) => ({
						slug,
						context_window: 100000,
						max_context_window: 100000,
						max_output_tokens: 1000,
						input_modalities: ["text"],
					})),
				});
			const body = (await req.json()) as { model: string };
			sends.push({
				model: body.model,
				authorization: req.headers.get("authorization"),
			});
			return sse([
				{
					type: "response.created",
					response: { id: "resp-synthetic", model: body.model },
				},
				{ type: "response.output_text.delta", delta: "ok" },
				{
					type: "response.completed",
					response: {
						id: "resp-synthetic",
						model: body.model,
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			]);
		},
		{ preconnect: () => {} },
	) as typeof fetch;
	await getCodexModels(codex.id, ctx);
	usageCache.set(codex.id, {
		limits: [
			{ kind: "weekly_all", percent: 10, resets_at: Date.now() + 60000 },
		],
		spend: { enabled: false },
	} as never);
	const response = await send(request("claude-bccf-quality-opus"));
	expect({
		status: response.status,
		body: response.status === 200 ? null : await response.clone().text(),
	}).toMatchObject({ status: 200 });
	await response.text();
	await flush();
	expect((await home())?.physicalModel).toBe("gpt-5.6-sol");
	models.push("gpt-6.1-sol");
	await getCodexModels(codex.id, ctx);
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
	);
	ctx.qualityRouteService = service;
	await (await send(request("claude-bccf-quality-opus"))).text();
	await flush();
	expect(sends[1]?.model).toBe("gpt-5.6-sol");
	const status = await service.status(scope);
	if (!status) throw new Error("missing durable root");
	const exactPolicy = compileQualityRoutingPolicy({
		version: policy.version,
		accounts: policy.accounts,
		fallbacks: policy.fallbacks,
		spendGrants: policy.spendGrants,
		assignments: policy.assignments.map((assignment) => ({
			...assignment,
			upgrade: "exact-only",
		})),
	});
	expect(
		compileQualityCandidates(
			exactPolicy,
			{ kind: "main", preference: "opus" },
			accounts,
			status.conversations[0],
		).candidates.map((candidate) => candidate.target.physicalModel),
	).toEqual(["gpt-5.6-sol"]);
	ctx.config.getQualityRoutingPolicy = () => exactPolicy;
	await (await send(request("claude-bccf-quality-opus"))).text();
	await flush();
	expect(sends[2]?.model).toBe("gpt-5.6-sol");
	if (action === "retry")
		await service.retryPreferred({
			session: scope,
			incarnation: status.incarnation,
			expectedIntentRevision: status.intentRevision,
			idempotencyToken: "retry-once",
		});
	if (action.startsWith("removed")) {
		models.shift();
		await getCodexModels(codex.id, ctx);
		if (action === "removed-approved")
			ctx.config.getQualityRoutingPolicy = () => policy;
	}
	const reconsidered = await send(
		request(
			action === "preference"
				? "claude-bccf-quality-auto"
				: "claude-bccf-quality-opus",
		),
	);
	await reconsidered.text();
	await flush();
	if (action === "removed-exact") {
		expect(reconsidered.status).toBe(503);
		expect(sends).toHaveLength(3);
		expect((await home())?.physicalModel).toBe("gpt-5.6-sol");
		return;
	}
	expect(reconsidered.status).toBe(200);
	expect(sends[3]?.model).toBe("gpt-6.1-sol");
	expect((await home())?.physicalModel).toBe("gpt-6.1-sol");
	expect(sends.every((s) => s.authorization === "Bearer synthetic-c")).toBe(
		true,
	);
});
it("ambiguous send failure never replays against a second account", async () => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db)),
		Date.now,
		{ capacity: 1 },
	);
	ctx.qualityRouteService = service;
	upstream = () => {
		throw new Error("synthetic connection loss after write");
	};
	await (await send()).text();
	await flush();
	expect(sends).toHaveLength(1);
	expect(await home()).toBeUndefined();
	expect((await service.status(scope))?.unresolved).toHaveLength(1);
	// An ambiguous send cannot withdraw ownership of a possible late callback.
	expect(service.reserveObservedSettlement()).toBeNull();
});

it.each([
	"invalid",
	"manual",
	"legacy",
	"reverse-native",
])("provisional ingress isolates accepted capacity: %s", async (mode) => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db), { maxSessions: 1 }),
	);
	ctx.qualityRouteService = service;
	if (mode === "invalid") {
		const bad = new Request("https://proxy.invalid/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-claude-code-session-id": "rejected",
			},
			body: "{}",
		});
		expect((await send(bad, "other-principal")).status).toBe(400);
		const good = await send();
		expect(good.status).toBe(200);
		await good.text();
		expect(sends).toHaveLength(1);
	} else if (mode === "manual" || mode === "legacy") {
		await (await send()).text();
		await flush();
		const before = await service.status(scope);
		if (mode === "legacy")
			ctx.modelRouteSessionRegistry = new ModelRouteSessionRegistry([
				{
					id: "existing",
					publicModelId: "claude-bccf-route-existing",
					discoveryModelId: "claude-bccf-route-existing",
					displayName: "Existing",
					accountId: "a",
					logicalModel: "claude-opus-5-5",
				},
			]);
		const manual = await send(
			request(
				mode === "legacy" ? "claude-bccf-route-existing" : "claude-opus-5-5",
				{
					"x-claude-code-session-id": "fresh-manual",
				},
			),
		);
		expect(manual.status).toBe(200);
		await manual.text();
		expect(sends).toHaveLength(2);
		expect((await service.status(scope))?.conversations).toEqual(
			before?.conversations,
		);
	} else {
		let release = () => {};
		const delayed = new Request("https://proxy.invalid/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-claude-code-session-id": scope.sessionId,
			},
			body: new ReadableStream({
				start(controller) {
					release = () => {
						controller.enqueue(
							new TextEncoder().encode(
								JSON.stringify({
									model: "claude-opus-5-5",
									messages: [{ role: "user", content: "old" }],
									max_tokens: 20,
								}),
							),
						);
						controller.close();
					};
				},
			}),
			duplex: "half",
		} as RequestInit);
		const pending = send(delayed);
		await flush();
		const newer = await send(request("claude-opus-5-5"));
		expect(newer.status).toBe(200);
		await newer.text();
		release();
		const older = await pending;
		expect(older.status).toBe(200);
		await older.text();
		expect(sends).toHaveLength(2);
	}
});

it("exhausted standard worker never escalates to a healthy flagship", async () => {
	await (await send()).text();
	await flush();
	for (const a of accounts)
		usageCache.set(a.id, {
			limits: [
				{ kind: "weekly_all", percent: 10, resets_at: Date.now() + 60000 },
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: Date.now() + 60000,
					scope: { model: { display_name: "Sonnet" } },
				},
			],
			spend: { enabled: false },
		} as never);
	const worker = await send(
		request("claude-sonnet-5-5", {
			"x-better-ccflare-agent-id": "exhausted-worker",
			"x-claude-code-agent-id": "exhausted-worker",
		}),
	);
	expect(worker.status).toBe(503);
	expect(sends).toHaveLength(1);
	expect((await home())?.physicalModel).toBe("claude-fable-5-1");
});

it.each([
	"missing",
	"stale",
	"unsupported",
])("catalog compilation preserves %s reasons in fallback and zero-send history", async (mode) => {
	const transport = globalThis.fetch;
	resetModelCatalogForTest();
	if (mode !== "missing") {
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = input instanceof Request ? input : new Request(input, init);
				if (req.method === "GET")
					return Response.json({
						data: [
							{
								id: "claude-opus-5-5",
								max_input_tokens: 100000,
								max_tokens: 1000,
								input_modalities: ["text"],
							},
						],
						has_more: false,
					});
				return transport(input, init);
			},
			{ preconnect: () => {} },
		) as typeof fetch;
		if (mode === "stale") {
			const clock = spyOn(Date, "now").mockReturnValue(
				Date.now() - 8 * 86_400_000,
			);
			try {
				for (const a of accounts)
					await fetchLiveModels(ctx, { allowOAuth: true, accountId: a.id });
			} finally {
				clock.mockRestore();
			}
		} else
			for (const a of accounts)
				await fetchLiveModels(ctx, { allowOAuth: true, accountId: a.id });
	}
	await withRealQualityHistory(async (operations, collector) => {
		const response = await send();
		expect(response.status).toBe(mode === "unsupported" ? 200 : 503);
		await response.text();
		await flush();
		await collector.drain();
		const history = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(history).toHaveLength(1);
		const reason =
			mode === "unsupported"
				? "model-unsupported"
				: mode === "missing"
					? "evidence-missing"
					: "catalog-evidence-stale";
		expect(history[0].qualityDecision.skippedLanes).toEqual(
			mode === "unsupported"
				? [{ lane: "fable", reasons: { [reason]: 2 } }]
				: [
						{ lane: "fable", reasons: { [reason]: 2 } },
						{ lane: "opus", reasons: { [reason]: 2 } },
					],
		);
		const state = await service.status(scope);
		expect(state?.conversations[0]?.decision?.requestId).toBe(history[0].id);
		expect(state?.conversations[0]?.decision?.value).toEqual(
			history[0].qualityDecision,
		);
		expect(sends).toHaveLength(mode === "unsupported" ? 1 : 0);
	});
});

it.each([
	"invalid-body",
	"unknown-profile",
	"unknown-quality",
])("rejected newer %s leaves accepted quality intent unchanged", async (mode) => {
	await (await send()).text();
	await flush();
	const before = await service.status(scope);
	const invalid =
		mode === "invalid-body"
			? request("claude-opus-5-5", {}, { messages: null })
			: request(
					mode === "unknown-profile"
						? "claude-bccf-route-missing"
						: "claude-bccf-quality-missing",
				);
	expect((await send(invalid)).status).toBe(
		mode === "unknown-profile" ? 503 : 400,
	);
	const after = await service.status(scope);
	expect(after).toEqual(before);
	expect(sends).toHaveLength(1);
});

it("provisional saturation cannot block a new manual request, but storage failure cannot withdraw active intent", async () => {
	service = new QualityRouteService(
		new QualityRouteRepository(new BunSqlAdapter(db), {
			maxSessions: 1,
			maxProvisionalSessions: 1,
		}),
	);
	ctx.qualityRouteService = service;
	const abandoned = await service.reserveIngress({
		...scope,
		sessionId: "pending",
	});
	const manual = await send(request("claude-opus-5-5"));
	expect(manual.status).toBe(200);
	await manual.text();
	await service.withdrawIngress(abandoned);
	await (await send()).text();
	await flush();
	const before = await service.status(scope);
	const fail = spyOn(service, "acceptRoot").mockRejectedValue(
		new Error("synthetic storage failure"),
	);
	try {
		expect((await send(request("claude-opus-5-5"))).status).toBe(503);
	} finally {
		fail.mockRestore();
	}
	expect(await service.status(scope)).toEqual(before);
	expect(sends).toHaveLength(2);
});

it("all three missing lanes persist once per account-line even for stored and current targets", async () => {
	const base = ctx.config.getQualityRoutingPolicy();
	if (!base) throw new Error("missing policy fixture");
	accounts.push({ ...account("c"), provider: "codex" });
	const policy = compileQualityRoutingPolicy({
		version: base.version,
		assignments: [
			...base.assignments,
			{
				line: "gpt-astra",
				lane: "astra",
				priority: 0,
				upgrade: "same-line-supported",
			},
		],
		accounts: [
			...base.accounts,
			{ accountId: "c", provider: "codex", lines: ["gpt-astra"], priority: 0 },
		],
		fallbacks: base.fallbacks,
		spendGrants: [],
	});
	ctx.config.getQualityRoutingPolicy = () => policy;
	await withRealQualityHistory(async (operations, collector) => {
		await (await send()).text();
		await flush();
		resetModelCatalogForTest();
		const state = await service.status(scope);
		const compiled = compileQualityCandidates(
			policy,
			{ kind: "main", preference: "auto" },
			accounts,
			state?.conversations[0],
		);
		const expected = [
			{ lane: "fable", reasons: { "evidence-missing": 2 } },
			{ lane: "astra", reasons: { "evidence-missing": 1 } },
			{ lane: "opus", reasons: { "evidence-missing": 2 } },
		];
		expect(compiled.candidates).toEqual([]);
		expect(compiled.skippedLanes).toEqual(expected);
		expect(() =>
			compileQualityCandidates(
				{
					...policy,
					mainLadders: {
						...policy.mainLadders,
						auto: ["fable", "astra", "opus", "standard"],
					},
				} as never,
				{ kind: "main", preference: "auto" },
				accounts,
			),
		).toThrow("Invalid quality lane ladder");
		const response = await send();
		expect(response.status).toBe(503);
		await response.text();
		await flush();
		await collector.drain();
		const history = await (
			await createRequestsSummaryHandler(operations.getAdapter())()
		).json();
		expect(history).toHaveLength(2);
		const rejection = history.find(
			(row: { statusCode: number }) => row.statusCode === 503,
		);
		expect(rejection.qualityDecision.skippedLanes).toEqual(expected);
		expect(
			(await service.status(scope))?.conversations[0]?.decision,
		).toMatchObject({
			requestId: rejection.id,
			value: { skippedLanes: expected },
		});
		expect(sends).toHaveLength(1);
	});
});
