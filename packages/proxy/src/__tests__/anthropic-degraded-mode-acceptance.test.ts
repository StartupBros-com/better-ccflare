import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	ANTHROPIC_DEGRADED_MODE_DEFAULTS,
	type AnthropicDegradedMode,
} from "@better-ccflare/config";
import { GUARD_REQUEST_ID_HEADER } from "@better-ccflare/http-common";
import type {
	Account,
	AffinityOwnerSnapshot,
	RequestMeta,
} from "@better-ccflare/types";
import {
	type AnthropicDegradedCohortKey,
	AnthropicDegradedModeCoordinator,
	buildAnthropicDegradedCohortKey,
	classifyAnthropicReplayRisk,
} from "../anthropic-degraded-mode";
import {
	DegradedModeObservability,
	type DegradedModeObservabilitySnapshot,
} from "../anthropic-degraded-observability";
import { DegradedOwnerOverlay } from "../degraded-owner-overlay";
import {
	createGuardCorrelationEnvelope,
	createGuardCorrelationVerifier,
} from "../handlers/guard-correlation-auth";
import type { ProxyContext } from "../handlers/proxy-types";
import { RoutingAttemptLedger } from "../handlers/routing-attempt-ledger";
import { createOpaqueRuntimeIdFactory } from "../opaque-runtime-id";

mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const usageCollectorModule = await import("../usage-collector");
spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
	handleStart: mock(() => undefined),
	handleChunk: mock(() => undefined),
	handleEnd: mock(async () => undefined),
} as unknown as usageCollectorModule.UsageCollector);

const { isAnthropicDegradedSendDenied, proxyWithAccount } = await import(
	"../handlers/proxy-operations"
);
const { deriveAffinityLaneKey } = await import("../handlers/account-selector");
const { handleProxy } = await import("../proxy");

const OVERLOAD_BODY =
	'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const SEMANTIC_OVERLOAD = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: error",
	'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
	"",
	"",
].join("\n");
const GUARD_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const NATIVE_MODEL = "claude-opus-4-6";
const ROUTING_ENV_NAMES = [
	"CCFLARE_OVERLOAD_RETRY_BASE_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
	"CCFLARE_OVERLOAD_RETRY_ENABLED",
	"CCFLARE_PASSTHROUGH_ON_EMPTY_POOL",
] as const;
const originalRoutingEnv = Object.fromEntries(
	ROUTING_ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof ROUTING_ENV_NAMES)[number], string | undefined>;

interface SelectionRecord {
	readonly accounts: string[];
	readonly directive: "retain-owner" | "defer-owner-assignment" | null;
	readonly directiveOwner: string | null;
	readonly guardAttemptOrdinal: number | null;
}

interface AcceptanceRuntime {
	readonly coordinator: AnthropicDegradedModeCoordinator;
	readonly observability: DegradedModeObservability;
	readonly ownerOverlay: DegradedOwnerOverlay;
	readonly shadowOwnerOverlay: DegradedOwnerOverlay;
	readonly ctx: ProxyContext;
	readonly selectionRecords: SelectionRecord[];
	readonly affinityCommits: AffinityOwnerSnapshot[];
	setAccounts(accounts: Account[]): void;
	setOwner(owner: AffinityOwnerSnapshot | null): void;
	getOwner(): AffinityOwnerSnapshot | null;
	setNow(value: number): void;
}

function makeAccount(id: string): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "oauth-refresh-token",
		access_token: `oauth-${id}`,
		expires_at: Date.now() + 3 * 60 * 60 * 1_000,
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

function makeRequestMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function nativeCohortKey(): AnthropicDegradedCohortKey {
	const cohortKey = buildAnthropicDegradedCohortKey({
		provider: "anthropic",
		endpoint: "https://api.anthropic.com",
		path: "/v1/messages",
		protocol: "messages",
		model: NATIVE_MODEL,
		betaSignature: "oauth-2025-04-20",
	});
	if (cohortKey === null) throw new Error("expected native Anthropic cohort");
	return cohortKey;
}

function createRuntime(
	mode: AnthropicDegradedMode,
	seed: number,
	initialNow = 100_000,
): AcceptanceRuntime {
	let now = initialNow;
	let accounts: Account[] = [];
	let authoritativeOwner: AffinityOwnerSnapshot | null = null;
	const selectionRecords: SelectionRecord[] = [];
	const affinityCommits: AffinityOwnerSnapshot[] = [];
	const config = {
		...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
		mode,
		largeRequestByteThreshold: 64 * 1024,
	};
	const coordinator = new AnthropicDegradedModeCoordinator({
		config,
		now: () => now,
	});
	const idFactory = createOpaqueRuntimeIdFactory({
		secret: Uint8Array.from({ length: 32 }, () => seed + 11),
		bootNonce: Uint8Array.from({ length: 16 }, () => seed + 31),
	});
	const observability = new DegradedModeObservability({
		mode,
		largeRequestTokenThreshold: config.largeRequestTokenThreshold,
		largeRequestByteThreshold: config.largeRequestByteThreshold,
		idFactory,
	});
	const ownerOverlay = new DegradedOwnerOverlay({ now: () => now });
	const shadowOwnerOverlay = new DegradedOwnerOverlay({ now: () => now });
	const strategy = {
		snapshotAffinityOwner: () =>
			authoritativeOwner === null ? null : { ...authoritativeOwner },
		select: async (candidates: Account[], meta: RequestMeta) => {
			const directive = meta.affinityOwnerDirective ?? null;
			selectionRecords.push({
				accounts: candidates.map((candidate) => candidate.id),
				directive: directive?.kind ?? null,
				directiveOwner:
					directive?.kind === "retain-owner" ? directive.owner.accountId : null,
				guardAttemptOrdinal: meta.guardAttemptOrdinal ?? null,
			});
			if (directive?.kind !== "retain-owner") return candidates;
			return [...candidates].sort((left, right) => {
				if (left.id === directive.owner.accountId) return -1;
				if (right.id === directive.owner.accountId) return 1;
				return 0;
			});
		},
		commitAffinityOwner: (_meta: RequestMeta, owner: AffinityOwnerSnapshot) => {
			authoritativeOwner = { ...owner };
			affinityCommits.push({ ...owner });
			return true;
		},
		reportCandidateFailure: mock(() => undefined),
		reportCandidateSuccess: mock(() => undefined),
	};
	const ctx: ProxyContext = {
		strategy: strategy as never,
		anthropicDegradedMode: coordinator,
		anthropicDegradedObservability: observability,
		degradedOwnerOverlay: ownerOverlay,
		degradedOwnerShadowOverlay: shadowOwnerOverlay,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			getAgentPreference: mock(async () => null),
			markAccountRateLimited: mock(async () => ({
				consecutiveRateLimits: 1,
				applied: true,
			})),
			saveRequest: mock(async () => undefined),
			updateAccountUsage: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "acceptance-test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: (headers: Headers) => new Headers(headers),
			transformRequestBody: undefined,
			processResponse: async (response: Response) => response,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: (response: Response) =>
				response.headers
					.get("content-type")
					?.toLowerCase()
					.includes("text/event-stream") === true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => true) } as never,
		guardCorrelationVerifier: createGuardCorrelationVerifier(GUARD_SECRET),
	};

	return {
		coordinator,
		observability,
		ownerOverlay,
		shadowOwnerOverlay,
		ctx,
		selectionRecords,
		affinityCommits,
		setAccounts(nextAccounts) {
			accounts = nextAccounts;
		},
		setOwner(owner) {
			authoritativeOwner = owner === null ? null : { ...owner };
		},
		getOwner() {
			return authoritativeOwner === null ? null : { ...authoritativeOwner };
		},
		setNow(value) {
			now = value;
		},
	};
}

function makeGuardedRequest(input: {
	readonly runtime: AcceptanceRuntime;
	readonly session: string;
	readonly requestId: string;
	readonly guardAttemptOrdinal: number;
	readonly large: boolean;
	readonly stream?: boolean;
	readonly model?: string;
}): Request {
	const model = input.model ?? NATIVE_MODEL;
	const content = input.large
		? "x".repeat(input.runtime.coordinator.config.largeRequestByteThreshold)
		: "small";
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			[GUARD_REQUEST_ID_HEADER]: createGuardCorrelationEnvelope(
				GUARD_SECRET,
				input.requestId,
				input.guardAttemptOrdinal,
			),
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content }],
			metadata: { user_id: input.session },
			max_tokens: 16,
			stream: input.stream ?? false,
		}),
	});
}

function openCohort(
	runtime: AcceptanceRuntime,
	retryAfter = "30",
): AnthropicDegradedCohortKey {
	const cohortKey = nativeCohortKey();
	for (const accountId of ["evidence-a", "evidence-b"]) {
		runtime.coordinator.observeTrustedOverload({
			cohortKey,
			accountId,
			outcome: "http_529",
			phase: "pre_commit",
			forceRouted: false,
			retryAfter,
		});
	}
	if (runtime.coordinator.config.mode !== "off") {
		expect(runtime.coordinator.getCohortState(cohortKey).state).toBe("open");
	}
	return cohortKey;
}

function normalizedAccountId(id: string): string {
	return id.replace(/^(off|observe|enforce)-/, "");
}

function accountIdFromFetch(input: RequestInfo | URL): string {
	if (!(input instanceof Request)) return "unknown";
	const authorization = input.headers.get("authorization");
	return normalizedAccountId(
		authorization?.replace(/^Bearer oauth-/, "") ?? "",
	);
}

const STABLE_RESPONSE_HEADER_NAMES = new Set(["content-type", "retry-after"]);

type StableResponseHeaderEntry = readonly [name: string, value: string];

function compareStableResponseHeaders(
	left: StableResponseHeaderEntry,
	right: StableResponseHeaderEntry,
): number {
	if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
	if (left[1] === right[1]) return 0;
	return left[1] < right[1] ? -1 : 1;
}

function stableResponseHeaders(headers: Headers): StableResponseHeaderEntry[] {
	return [...headers.entries()]
		.map(
			([name, value]) =>
				[name.toLowerCase(), value.trim()] as StableResponseHeaderEntry,
		)
		.filter(([name]) => STABLE_RESPONSE_HEADER_NAMES.has(name))
		.sort(compareStableResponseHeaders);
}

interface ProjectedResponse {
	readonly status: number;
	readonly headers: StableResponseHeaderEntry[];
	readonly body: string;
}

interface ModeSequenceResult {
	readonly http: ProjectedResponse;
	readonly httpRequestId: string | null;
	readonly semantic: ProjectedResponse;
	readonly physicalOrder: string[];
	readonly selectionRecords: SelectionRecord[];
	readonly httpOwner: string | null;
	readonly authoritativeOwner: string | null;
	readonly affinityCommits: string[];
	readonly realOwnerEntries: number;
	readonly shadowOwnerEntries: number;
	readonly telemetry: DegradedModeObservabilitySnapshot;
	readonly freshCoordinator: ReturnType<
		AnthropicDegradedModeCoordinator["snapshot"]
	>;
	readonly finalCoordinator: ReturnType<
		AnthropicDegradedModeCoordinator["snapshot"]
	>;
}

async function runOutageSequence(
	mode: AnthropicDegradedMode,
	seed: number,
): Promise<ModeSequenceResult> {
	const runtime = createRuntime(mode, seed);
	const freshCoordinator = runtime.coordinator.snapshot();
	const physicalOrder: string[] = [];
	let phase: "http" | "semantic" = "http";
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const accountId = accountIdFromFetch(input);
		physicalOrder.push(`${phase}:${accountId}`);
		if (phase === "http") {
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: {
					"content-type": "application/json",
					"retry-after": "30",
					"x-request-id": `http-${accountId}`,
				},
			});
		}
		if (accountId === "semantic-a") {
			return new Response(SEMANTIC_OVERLOAD, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response('{"ok":true,"candidate":"semantic-b"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;

	const httpAccounts = [
		makeAccount(`${mode}-http-a`),
		makeAccount(`${mode}-http-b`),
	];
	runtime.setAccounts(httpAccounts);
	runtime.setOwner({
		candidateId: `account:${httpAccounts[0].id}`,
		accountId: httpAccounts[0].id,
	});
	const httpRequest = makeGuardedRequest({
		runtime,
		session: `${mode}-http-session`,
		requestId: "00000000-0000-4000-8000-000000000001",
		guardAttemptOrdinal: 1,
		large: true,
	});
	const httpResponse = await handleProxy(
		httpRequest,
		new URL(httpRequest.url),
		runtime.ctx,
	);
	const httpRequestId = httpResponse.headers.get("x-request-id");
	const http = {
		status: httpResponse.status,
		headers: stableResponseHeaders(httpResponse.headers),
		body: await httpResponse.text(),
	};
	const httpOwner =
		runtime.getOwner() === null
			? null
			: normalizedAccountId(runtime.getOwner()?.accountId ?? "");

	phase = "semantic";
	const semanticAccounts = [
		makeAccount(`${mode}-semantic-a`),
		makeAccount(`${mode}-semantic-b`),
	];
	runtime.setAccounts(semanticAccounts);
	runtime.setOwner({
		candidateId: `account:${semanticAccounts[0].id}`,
		accountId: semanticAccounts[0].id,
	});
	const semanticRequest = makeGuardedRequest({
		runtime,
		session: `${mode}-semantic-session`,
		requestId: "00000000-0000-4000-8000-000000000002",
		guardAttemptOrdinal: 2,
		large: true,
		stream: true,
	});
	const semanticResponse = await handleProxy(
		semanticRequest,
		new URL(semanticRequest.url),
		runtime.ctx,
	);
	const semantic = {
		status: semanticResponse.status,
		headers: stableResponseHeaders(semanticResponse.headers),
		body: await semanticResponse.text(),
	};

	return {
		http,
		httpRequestId,
		semantic,
		physicalOrder,
		selectionRecords: runtime.selectionRecords.map((record) => ({
			...record,
			accounts: record.accounts.map(normalizedAccountId),
			directiveOwner:
				record.directiveOwner === null
					? null
					: normalizedAccountId(record.directiveOwner),
		})),
		httpOwner,
		authoritativeOwner:
			runtime.getOwner() === null
				? null
				: normalizedAccountId(runtime.getOwner()?.accountId ?? ""),
		affinityCommits: runtime.affinityCommits.map((owner) =>
			normalizedAccountId(owner.accountId),
		),
		realOwnerEntries: runtime.ownerOverlay.size,
		shadowOwnerEntries: runtime.shadowOwnerOverlay.size,
		telemetry: runtime.observability.snapshot(),
		freshCoordinator,
		finalCoordinator: runtime.coordinator.snapshot(),
	};
}

describe("Anthropic degraded-mode cross-layer acceptance", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "1";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const name of ROUTING_ENV_NAMES) {
			const value = originalRoutingEnv[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("keeps off and observe transport, owner, affinity, and guard behavior identical while enforce starts without shadow evidence", async () => {
		const off = await runOutageSequence("off", 1);
		const observe = await runOutageSequence("observe", 2);
		const enforce = await runOutageSequence("enforce", 3);

		const parity = (result: ModeSequenceResult) => ({
			http: result.http,
			semantic: result.semantic,
			physicalOrder: result.physicalOrder,
			selectionRecords: result.selectionRecords,
			httpOwner: result.httpOwner,
			authoritativeOwner: result.authoritativeOwner,
			affinityCommits: result.affinityCommits,
			realOwnerEntries: result.realOwnerEntries,
		});
		expect(parity(observe)).toEqual(parity(off));
		expect(off.http).toEqual({
			status: 529,
			headers: [
				["content-type", "application/json"],
				["retry-after", "30"],
			],
			body: OVERLOAD_BODY,
		});
		for (const requestId of [off.httpRequestId, observe.httpRequestId]) {
			expect(requestId).not.toBeNull();
			expect(requestId ?? "").toMatch(/^http-http-[ab]$/);
			expect(requestId ?? "").not.toMatch(/[\r\n]/);
			expect((requestId ?? "").length).toBeLessThanOrEqual(128);
		}
		expect(off.semantic).toEqual({
			status: 200,
			headers: [["content-type", "application/json"]],
			body: '{"ok":true,"candidate":"semantic-b"}',
		});
		expect(off.physicalOrder).toEqual([
			"http:http-a",
			"http:http-b",
			"semantic:semantic-a",
			"semantic:semantic-b",
		]);
		expect(
			off.selectionRecords.map((record) => record.guardAttemptOrdinal),
		).toEqual([1, 2]);
		expect(off.httpOwner).toBe("http-a");
		expect(off.authoritativeOwner).toBe("semantic-a");
		expect(off.affinityCommits).toEqual([]);

		expect(off.finalCoordinator.retainedCohorts).toBe(0);
		expect(off.shadowOwnerEntries).toBe(0);
		expect(observe.finalCoordinator.openCohorts).toBe(1);
		expect(observe.shadowOwnerEntries).toBeGreaterThan(0);
		expect(observe.telemetry.wouldSuppressSends).toBeGreaterThan(0);
		expect(observe.telemetry.suppressedSends).toBe(0);

		expect(enforce.freshCoordinator).toMatchObject({
			mode: "enforce",
			retainedCohorts: 0,
			activeProbes: 0,
		});
		expect(enforce.shadowOwnerEntries).toBe(0);
		expect(enforce.physicalOrder).toEqual(["http:http-a", "http:http-b"]);
		expect(enforce.http).toMatchObject({ status: 529, body: OVERLOAD_BODY });
		expect(enforce.semantic).toMatchObject({
			status: 529,
			body: OVERLOAD_BODY,
		});
		expect(enforce.authoritativeOwner).toBe("semantic-a");
		expect(enforce.affinityCommits).toEqual([]);
	});

	it("preserves small-request failover success in off, observe, and enforce", async () => {
		for (const [index, mode] of (
			["off", "observe", "enforce"] as const
		).entries()) {
			const runtime = createRuntime(mode, index + 10);
			openCohort(runtime);
			const accounts = [
				makeAccount(`${mode}-small-a`),
				makeAccount(`${mode}-small-b`),
			];
			runtime.setAccounts(accounts);
			runtime.setOwner({
				candidateId: `account:${accounts[0].id}`,
				accountId: accounts[0].id,
			});
			const physicalOrder: string[] = [];
			globalThis.fetch = mock(async (input: RequestInfo | URL) => {
				const accountId = accountIdFromFetch(input);
				physicalOrder.push(accountId);
				return accountId === "small-a"
					? new Response(OVERLOAD_BODY, {
							status: 529,
							headers: { "content-type": "application/json" },
						})
					: new Response('{"ok":true,"small":true}', {
							status: 200,
							headers: { "content-type": "application/json" },
						});
			}) as unknown as typeof fetch;
			const request = makeGuardedRequest({
				runtime,
				session: `${mode}-small-session`,
				requestId: `00000000-0000-4000-8000-00000000001${index}`,
				guardAttemptOrdinal: 1,
				large: false,
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				runtime.ctx,
			);

			expect(
				{
					mode,
					status: response.status,
					body: await response.text(),
					physicalOrder,
					owner: normalizedAccountId(
						runtime.getOwner()?.accountId ?? "missing",
					),
				},
				mode,
			).toEqual({
				mode,
				status: 200,
				body: '{"ok":true,"small":true}',
				physicalOrder: ["small-a", "small-b"],
				owner: "small-a",
			});
		}
	});

	it("suppresses an owner-bound follower, then allows one failed owner probe without changing affinity", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const runtime = createRuntime("enforce", 21, 200_000);
		const cohortKey = openCohort(runtime, "1");
		const openState = runtime.coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		const account = makeAccount("enforce-retained-owner");
		const owner = {
			candidateId: `account:${account.id}`,
			accountId: account.id,
		};
		const session = "retained-owner-session";
		runtime.setAccounts([account]);
		runtime.setOwner(owner);
		const laneMeta = makeRequestMeta("lane-meta");
		laneMeta.clientSessionId = session;
		const laneKey = deriveAffinityLaneKey(laneMeta, NATIVE_MODEL);
		if (laneKey === null) throw new Error("expected affinity lane");
		expect(
			runtime.ownerOverlay.retainQualifyingOwner({
				laneKey,
				cohortKey,
				owner,
			}),
		).toBe(true);
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response(OVERLOAD_BODY, {
				status: 529,
				headers: {
					"content-type": "application/json",
					"retry-after": "30",
					"x-request-id": "failed-owner-probe",
				},
			});
		}) as unknown as typeof fetch;

		const followerRequest = makeGuardedRequest({
			runtime,
			session,
			requestId: "00000000-0000-4000-8000-000000000021",
			guardAttemptOrdinal: 1,
			large: true,
		});
		const follower = await handleProxy(
			followerRequest,
			new URL(followerRequest.url),
			runtime.ctx,
		);

		expect(fetchCount).toBe(0);
		expect(follower.status).toBe(529);
		expect(await follower.text()).toBe(OVERLOAD_BODY);
		expect(runtime.getOwner()).toEqual(owner);
		expect(runtime.ownerOverlay.peekRetainedOwner(laneKey, cohortKey)).toEqual(
			owner,
		);

		runtime.setNow(openState.nextProbeAt);
		const probeRequest = makeGuardedRequest({
			runtime,
			session,
			requestId: "00000000-0000-4000-8000-000000000022",
			guardAttemptOrdinal: 1,
			large: true,
		});
		const probe = await handleProxy(
			probeRequest,
			new URL(probeRequest.url),
			runtime.ctx,
		);

		expect(fetchCount).toBe(1);
		expect(probe.status).toBe(529);
		expect(await probe.text()).toBe(OVERLOAD_BODY);
		expect(fetchCount).toBe(1);
		expect(runtime.coordinator.getCohortState(cohortKey).state).toBe("open");
		expect(runtime.getOwner()).toEqual(owner);
		expect(runtime.ownerOverlay.peekRetainedOwner(laneKey, cohortKey)).toEqual(
			owner,
		);
	});

	it("elects one send per coordinator and documents the two-runtime topology boundary", async () => {
		let now = 300_000;
		const runtimes = [
			createRuntime("enforce", 31, now),
			createRuntime("enforce", 32, now),
		];
		const cohortKey = nativeCohortKey();
		for (const runtime of runtimes) {
			openCohort(runtime, "1");
		}
		const probeAt = Math.max(
			...runtimes.map((runtime) => {
				const state = runtime.coordinator.getCohortState(cohortKey);
				if (state.state !== "open") throw new Error("expected open cohort");
				return state.nextProbeAt;
			}),
		);
		now = probeAt;
		for (const runtime of runtimes) runtime.setNow(now);
		let releaseFetch: (() => void) | undefined;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const physicalAccounts: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			physicalAccounts.push(accountIdFromFetch(input));
			await fetchGate;
			return new Response('{"ok":true,"probe":true}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const body = new TextEncoder().encode(
			JSON.stringify({
				model: NATIVE_MODEL,
				messages: [{ role: "user", content: "large" }],
				max_tokens: 16,
				_admission_padding: "x".repeat(
					ANTHROPIC_DEGRADED_MODE_DEFAULTS.largeRequestByteThreshold,
				),
			}),
		);

		const attempts = runtimes.flatMap((runtime, runtimeIndex) =>
			Array.from({ length: 5 }, async (_, requestIndex) => {
				const account = makeAccount(`topology-${runtimeIndex + 1}`);
				const request = new Request("https://proxy.local/v1/messages", {
					method: "POST",
					headers: {
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
					},
					body,
				});
				const meta = makeRequestMeta(
					`topology-${runtimeIndex}-${requestIndex}`,
				);
				meta.headers = request.headers;
				return proxyWithAccount(
					request,
					new URL(request.url),
					account,
					meta,
					body.buffer,
					() => undefined,
					0,
					runtime.ctx,
					undefined,
					undefined,
					undefined,
					undefined,
					false,
					undefined,
					new RoutingAttemptLedger(),
					undefined,
					runtime.coordinator.createRequestAdmission({
						cohortKey,
						risk: classifyAnthropicReplayRisk({
							body,
							config: runtime.coordinator.config,
						}),
						ownerAccountId: null,
						forceRouted: false,
					}),
				);
			}),
		);

		for (let spin = 0; spin < 20 && physicalAccounts.length < 2; spin++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		expect(physicalAccounts.sort()).toEqual(["topology-1", "topology-2"]);
		releaseFetch?.();
		const results = await Promise.all(attempts);
		const responses = results.filter(
			(result): result is Response => result instanceof Response,
		);
		expect(responses).toHaveLength(2);
		expect(results.filter(isAnthropicDegradedSendDenied)).toHaveLength(8);
		expect(
			await Promise.all(responses.map((response) => response.text())),
		).toEqual(['{"ok":true,"probe":true}', '{"ok":true,"probe":true}']);
	});

	it("leaves a non-native provider on baseline routing while the native cohort is open", async () => {
		const runtime = createRuntime("enforce", 41);
		const cohortKey = openCohort(runtime);
		const account = {
			...makeAccount("unrelated-provider"),
			provider: "anthropic-compatible",
			api_key: "fake-compatible-key",
			refresh_token: null,
			access_token: null,
		} as Account;
		runtime.setAccounts([account]);
		runtime.setOwner(null);
		runtime.ctx.provider = {
			...runtime.ctx.provider,
			name: "anthropic-compatible",
			buildUrl: () => "https://unrelated.invalid/v1/messages",
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as never;
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"ok":true,"provider":"unrelated"}', {
				status: 207,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = makeGuardedRequest({
			runtime,
			session: "unrelated-session",
			requestId: "00000000-0000-4000-8000-000000000041",
			guardAttemptOrdinal: 1,
			large: true,
		});

		const response = await handleProxy(
			request,
			new URL(request.url),
			runtime.ctx,
		);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(207);
		expect(await response.text()).toBe('{"ok":true,"provider":"unrelated"}');
		expect(runtime.coordinator.getCohortState(cohortKey).state).toBe("open");
		expect(runtime.coordinator.snapshot().activeProbes).toBe(0);
	});

	it("rotates restart identity, clears shadow/cohort/lease/owner state, and restores off behavior without cleanup", async () => {
		const oldObserve = createRuntime("observe", 51, 500_000);
		const cohortKey = openCohort(oldObserve, "1");
		const openState = oldObserve.coordinator.getCohortState(cohortKey);
		if (openState.state !== "open") throw new Error("expected open cohort");
		oldObserve.setNow(openState.nextProbeAt);
		const riskBody = new TextEncoder().encode(
			JSON.stringify({
				model: NATIVE_MODEL,
				messages: [{ role: "user", content: "large" }],
				_admission_padding: "x".repeat(
					oldObserve.coordinator.config.largeRequestByteThreshold,
				),
			}),
		);
		const shadowDecision = oldObserve.coordinator
			.createRequestAdmission({
				cohortKey,
				risk: classifyAnthropicReplayRisk({
					body: riskBody,
					config: oldObserve.coordinator.config,
				}),
				ownerAccountId: null,
				forceRouted: false,
			})
			.reserve("restart-shadow-owner", cohortKey);
		expect(shadowDecision).toMatchObject({
			action: "allow",
			wouldAction: "probe",
		});
		const shadowOwner = {
			candidateId: "account:restart-shadow-owner",
			accountId: "restart-shadow-owner",
		};
		expect(
			oldObserve.shadowOwnerOverlay.retainQualifyingOwner({
				laneKey: "restart-lane",
				cohortKey,
				owner: shadowOwner,
			}),
		).toBe(true);
		const oldTracker = oldObserve.observability.beginRequest({
			correlationKey: "restart-observation",
			guardAttemptOrdinal: 1,
			replayRisk: "large",
			sizeBucket: "large",
		});
		oldTracker.finish({ outcome: "suppressed" });
		expect(oldObserve.coordinator.snapshot()).toMatchObject({
			retainedCohorts: 1,
			activeProbes: 1,
		});
		expect(oldObserve.shadowOwnerOverlay.size).toBe(1);
		expect(oldObserve.observability.snapshot().logicalRequests).toBe(1);

		const freshEnforce = createRuntime("enforce", 52, 500_000);
		expect(freshEnforce.observability.snapshot().bootId).not.toBe(
			oldObserve.observability.snapshot().bootId,
		);
		expect(freshEnforce.coordinator.snapshot()).toMatchObject({
			mode: "enforce",
			retainedCohorts: 0,
			activeProbes: 0,
		});
		expect(freshEnforce.ownerOverlay.size).toBe(0);
		expect(freshEnforce.shadowOwnerOverlay.size).toBe(0);
		expect(freshEnforce.observability.snapshot()).toMatchObject({
			logicalRequests: 0,
			physicalAttempts: 0,
			suppressedSends: 0,
			wouldSuppressSends: 0,
		});

		const rolledBack = createRuntime("off", 53, 500_000);
		expect(rolledBack.observability.snapshot().bootId).not.toBe(
			freshEnforce.observability.snapshot().bootId,
		);
		expect(rolledBack.coordinator.snapshot()).toMatchObject({
			mode: "off",
			retainedCohorts: 0,
			activeProbes: 0,
		});
		expect(rolledBack.ownerOverlay.size).toBe(0);
		expect(rolledBack.shadowOwnerOverlay.size).toBe(0);
		const account = makeAccount("off-rollback-owner");
		rolledBack.setAccounts([account]);
		rolledBack.setOwner({
			candidateId: `account:${account.id}`,
			accountId: account.id,
		});
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount += 1;
			return new Response('{"ok":true,"mode":"off"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const request = makeGuardedRequest({
			runtime: rolledBack,
			session: "rollback-session",
			requestId: "00000000-0000-4000-8000-000000000053",
			guardAttemptOrdinal: 1,
			large: true,
		});

		const response = await handleProxy(
			request,
			new URL(request.url),
			rolledBack.ctx,
		);

		expect(fetchCount).toBe(1);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('{"ok":true,"mode":"off"}');
		expect(rolledBack.coordinator.snapshot().retainedCohorts).toBe(0);
	});
});
