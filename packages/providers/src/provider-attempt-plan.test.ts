import { describe, expect, test } from "bun:test";
import type { Account, ServerToolReplayAtom } from "@better-ccflare/types";
import {
	createProviderAttemptNoExecutionSnapshot,
	MAX_PROVIDER_NO_EXECUTION_BODY_BYTES,
	materializeProviderAttemptPlan,
} from "./provider-attempt-plan";
import type {
	Provider,
	ProviderAttemptNoExecutionSnapshot,
	ProviderAttemptPlan,
	ProviderAttemptPlanContext,
} from "./types";

type VertexAccountView = Account & {
	_originalModel?: string;
	_vertexModel?: string;
};

function accountFixture(): Account {
	return {
		id: "account-1",
		name: "Shared Vertex",
		provider: "vertex-ai",
		api_key: null,
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1,
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
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: true,
		peak_hours_pause_enabled: false,
		custom_endpoint: JSON.stringify({
			projectId: "project",
			region: "us-east5",
		}),
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	};
}

function bodyBuffer(value: unknown): ArrayBuffer {
	const encoded = new TextEncoder().encode(JSON.stringify(value));
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}

function requestFor(model = "claude-sonnet-4-5-20250929"): Request {
	return new Request("http://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [] }),
	});
}

function context(
	account: Account,
	overrides: Partial<ProviderAttemptPlanContext> = {},
): ProviderAttemptPlanContext {
	const model = overrides.physicalModel ?? "claude-sonnet-4-5-20250929";
	return {
		request: requestFor(model ?? undefined),
		requestBodyBuffer: bodyBuffer({ model, messages: [] }),
		account,
		path: "/v1/messages",
		query: "stream=true",
		physicalModel: model,
		capabilityProofKey: null,
		inputReplayMode: [],
		outputReplayMode: [],
		...overrides,
	};
}

function expectDeeplyFrozen(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	expect(Object.isFrozen(value)).toBe(true);
	for (const nested of Object.values(value)) expectDeeplyFrozen(nested);
}

function baseProvider(overrides: Partial<Provider> = {}): Provider {
	return {
		name: "fixture",
		canHandle: () => true,
		refreshToken: async () => ({
			accessToken: "token",
			expiresAt: 1,
			refreshToken: "refresh",
		}),
		buildUrl: () => "https://fixture.invalid/v1/messages",
		prepareHeaders: (headers) => new Headers(headers),
		parseRateLimit: () => ({ isRateLimited: false }),
		processResponse: async (response) => response,
		...overrides,
	};
}

function customPlan(
	overrides: Partial<ProviderAttemptPlan> = {},
): ProviderAttemptPlan {
	return {
		providerName: "custom",
		targetUrl: "https://custom.invalid/v1/responses",
		apiFamily: "responses",
		physicalModel: "gpt-5.6-sol",
		capabilityProofKey: "proof:custom",
		inputReplayMode: ["proxy-evidence-v1"],
		outputReplayMode: ["proxy-evidence-v1"],
		dataRetryPolicy: { mode: "reuse-same-plan", maxAttempts: 2 },
		classifyNoExecution: async () => ({
			decision: "proven_no_execution",
			reason: "fixture_rejection",
		}),
		cacheReplayModelStrategy: "transformed-body",
		prepareHeaders: (headers) => new Headers(headers),
		transformRequestBody: async (request) => request,
		processResponse: async (response) => response,
		parseRateLimit: () => ({ isRateLimited: false }),
		isStreamingResponse: () => false,
		extractTierInfo: async () => null,
		extractUsageInfo: async () => null,
		parseUsage: async () => null,
		...overrides,
	};
}

describe("materializeProviderAttemptPlan", () => {
	test("preserves a null refresh token in the immutable legacy account view", async () => {
		const sharedAccount = accountFixture();
		Object.defineProperty(sharedAccount, "refresh_token", {
			configurable: true,
			enumerable: true,
			value: null,
			writable: true,
		});
		let planningAccount: Account | undefined;
		let transformAccount: Account | undefined;
		const provider = baseProvider({
			prepareRequest(_request, _buffer, account) {
				planningAccount = account;
			},
			transformRequestBody: async (request, account) => {
				transformAccount = account;
				return request;
			},
		});

		const plan = materializeProviderAttemptPlan(
			provider,
			context(sharedAccount),
		);
		await plan.transformRequestBody(requestFor());

		expect(planningAccount).toBe(transformAccount);
		expect(planningAccount?.refresh_token).toBeNull();
		expect(Object.isFrozen(planningAccount)).toBe(true);
	});

	test("isolates two interleaved Vertex-style legacy plans on one shared account", async () => {
		const sharedAccount = accountFixture();
		const originalAccount = { ...sharedAccount };
		const views = new Map<string, VertexAccountView[]>();
		const remember = (phase: string, account: VertexAccountView) => {
			const phaseViews = views.get(phase) ?? [];
			phaseViews.push(account);
			views.set(phase, phaseViews);
		};
		const provider = baseProvider({
			name: "vertex-fixture",
			prepareRequest(_request, buffer, account) {
				const parsed = JSON.parse(
					new TextDecoder().decode(buffer as ArrayBuffer),
				);
				const view = account as VertexAccountView;
				view._originalModel = parsed.model;
				view._vertexModel = `${parsed.model}@vertex`;
				remember("prepare", view);
			},
			buildUrl(_path, _query, account) {
				const view = account as VertexAccountView;
				remember("url", view);
				return `https://vertex.invalid/models/${view._vertexModel}:predict`;
			},
			async transformRequestBody(request, account) {
				const view = account as VertexAccountView;
				remember("transform", view);
				const body = await request.json();
				return new Request(request.url, {
					method: "POST",
					body: JSON.stringify({ ...body, routedModel: view._vertexModel }),
				});
			},
			async processResponse(response, account) {
				const view = account as VertexAccountView;
				remember("response", view);
				const body = await response.json();
				return Response.json({ ...body, model: view._originalModel });
			},
		});
		const firstModel = "claude-sonnet-4-5-20250929";
		const secondModel = "claude-haiku-4-5-20251001";

		const first = materializeProviderAttemptPlan(
			provider,
			context(sharedAccount, {
				request: requestFor(firstModel),
				requestBodyBuffer: bodyBuffer({ model: firstModel }),
				physicalModel: firstModel,
			}),
		);
		const second = materializeProviderAttemptPlan(
			provider,
			context(sharedAccount, {
				request: requestFor(secondModel),
				requestBodyBuffer: bodyBuffer({ model: secondModel }),
				physicalModel: secondModel,
			}),
		);

		expect(first.targetUrl).toContain(`${firstModel}@vertex`);
		expect(second.targetUrl).toContain(`${secondModel}@vertex`);
		const secondRequest = await second.transformRequestBody(
			requestFor(secondModel),
		);
		const firstRequest = await first.transformRequestBody(
			requestFor(firstModel),
		);
		expect(await secondRequest.json()).toMatchObject({
			routedModel: `${secondModel}@vertex`,
		});
		expect(await firstRequest.json()).toMatchObject({
			routedModel: `${firstModel}@vertex`,
		});
		const firstResponse = await first.processResponse(
			Response.json({ model: "vertex-wire-model" }),
		);
		const secondResponse = await second.processResponse(
			Response.json({ model: "vertex-wire-model" }),
		);
		expect(await firstResponse.json()).toMatchObject({ model: firstModel });
		expect(await secondResponse.json()).toMatchObject({ model: secondModel });

		const firstView = views.get("prepare")?.[0];
		const secondView = views.get("prepare")?.[1];
		expect(firstView).toBeDefined();
		expect(secondView).toBeDefined();
		expect(firstView).not.toBe(secondView);
		expect(firstView).not.toBe(sharedAccount);
		expect(secondView).not.toBe(sharedAccount);
		expect(Object.isFrozen(firstView)).toBe(true);
		expect(Object.isFrozen(secondView)).toBe(true);
		expect(views.get("url")).toEqual([firstView, secondView]);
		expect(views.get("transform")).toEqual([secondView, firstView]);
		expect(views.get("response")).toEqual([firstView, secondView]);
		expect(sharedAccount).toEqual(originalAccount);
		expect(sharedAccount).not.toHaveProperty("_vertexModel");
		expect(sharedAccount).not.toHaveProperty("_originalModel");
	});

	test("drops unknown nested account extensions without observing or freezing them", () => {
		const nestedExtension = { mutable: "shared" };
		const sharedAccount = accountFixture() as Account & {
			nestedExtension: typeof nestedExtension;
		};
		sharedAccount.nestedExtension = nestedExtension;
		let extensionObserved = false;
		const provider = baseProvider({
			prepareRequest(_request, _buffer, account) {
				extensionObserved = Object.hasOwn(account, "nestedExtension");
				if (extensionObserved) {
					(
						account as Account & {
							nestedExtension: typeof nestedExtension;
						}
					).nestedExtension.mutable = "planning";
				}
			},
		});

		materializeProviderAttemptPlan(provider, context(sharedAccount));

		expect(extensionObserved).toBe(false);
		expect(sharedAccount.nestedExtension).toBe(nestedExtension);
		expect(nestedExtension).toEqual({ mutable: "shared" });
		expect(Object.isFrozen(nestedExtension)).toBe(false);
	});

	test("rejects a known Account accessor without invoking it or provider hooks", () => {
		const sharedAccount = accountFixture();
		let getterCalls = 0;
		Object.defineProperty(sharedAccount, "name", {
			configurable: true,
			enumerable: true,
			get() {
				getterCalls += 1;
				return "accessor-name";
			},
		});
		let hookCalls = 0;
		const provider = baseProvider({
			prepareRequest() {
				hookCalls += 1;
			},
			buildUrl() {
				hookCalls += 1;
				return "https://should-not-run.invalid";
			},
		});

		expect(() =>
			materializeProviderAttemptPlan(provider, context(sharedAccount)),
		).toThrow();
		expect(getterCalls).toBe(0);
		expect(hookCalls).toBe(0);
	});

	test("rejects a non-scalar declared Account field before provider hooks", () => {
		const sharedAccount = accountFixture();
		Object.defineProperty(sharedAccount, "priority", {
			configurable: true,
			enumerable: true,
			value: { nested: true },
			writable: true,
		});
		let hookCalls = 0;
		const provider = baseProvider({
			prepareRequest() {
				hookCalls += 1;
			},
		});

		expect(() =>
			materializeProviderAttemptPlan(provider, context(sharedAccount)),
		).toThrow();
		expect(hookCalls).toBe(0);
	});

	test("rejects a reference temporary from prepare before build or later hooks", () => {
		const sharedAccount = accountFixture();
		const temporaryReference = { providerOwned: true };
		let buildCalls = 0;
		const provider = baseProvider({
			prepareRequest(_request, _buffer, account) {
				(
					account as Account & { _temporaryReference?: unknown }
				)._temporaryReference = temporaryReference;
			},
			buildUrl() {
				buildCalls += 1;
				return "https://should-not-run.invalid";
			},
		});

		expect(() =>
			materializeProviderAttemptPlan(provider, context(sharedAccount)),
		).toThrow();
		expect(buildCalls).toBe(0);
		expect(Object.isFrozen(temporaryReference)).toBe(false);
		expect(sharedAccount).not.toHaveProperty("_temporaryReference");
	});

	test("rejects an accessor temporary from build without invoking or retaining it", () => {
		const sharedAccount = accountFixture();
		let temporaryGetterCalls = 0;
		const provider = baseProvider({
			buildUrl(_path, _query, account) {
				Object.defineProperty(account, "_temporaryAccessor", {
					configurable: true,
					enumerable: true,
					get() {
						temporaryGetterCalls += 1;
						return "unsafe";
					},
				});
				return "https://temporary.invalid";
			},
		});

		expect(() =>
			materializeProviderAttemptPlan(provider, context(sharedAccount)),
		).toThrow();
		expect(temporaryGetterCalls).toBe(0);
		expect(sharedAccount).not.toHaveProperty("_temporaryAccessor");
	});

	test("binds every legacy hook and snapshots immutable attempt metadata", async () => {
		const sharedAccount = accountFixture();
		const inputReplayMode: ServerToolReplayAtom[] = ["native-Anthropic"];
		const outputReplayMode: ServerToolReplayAtom[] = ["proxy-evidence-v1"];
		let provider: Provider;
		const thisValues: unknown[] = [];
		provider = baseProvider({
			name: "all-hooks",
			cacheReplayModelStrategy: "transformed-body",
			buildUrl() {
				thisValues.push(this);
				return "https://all-hooks.invalid/transport";
			},
			prepareHeaders(headers, token, apiKey) {
				thisValues.push(this);
				const next = new Headers(headers);
				next.set("x-token", token ?? "");
				next.set("x-api-key", apiKey ?? "");
				return next;
			},
			async transformRequestBody(request) {
				thisValues.push(this);
				return request;
			},
			async processResponse(response) {
				thisValues.push(this);
				return response;
			},
			parseRateLimit() {
				thisValues.push(this);
				return { isRateLimited: true, remaining: 3 };
			},
			isStreamingResponse() {
				thisValues.push(this);
				return true;
			},
			async extractTierInfo() {
				thisValues.push(this);
				return 4;
			},
			async extractUsageInfo() {
				thisValues.push(this);
				return { totalTokens: 9 };
			},
			async parseUsage() {
				thisValues.push(this);
				return { outputTokens: 2 };
			},
		});

		const plan = materializeProviderAttemptPlan(
			provider,
			context(sharedAccount, {
				physicalModel: "model-a",
				capabilityProofKey: "proof:a",
				inputReplayMode,
				outputReplayMode,
			}),
		);
		inputReplayMode.push("proxy-evidence-v1");
		outputReplayMode.length = 0;

		expect(plan).toMatchObject({
			providerName: "all-hooks",
			targetUrl: "https://all-hooks.invalid/transport",
			apiFamily: "legacy:all-hooks",
			physicalModel: "model-a",
			capabilityProofKey: "proof:a",
			inputReplayMode: ["native-Anthropic"],
			outputReplayMode: ["proxy-evidence-v1"],
			dataRetryPolicy: { mode: "none", maxAttempts: 0 },
			cacheReplayModelStrategy: "transformed-body",
		});
		expectDeeplyFrozen(plan);
		const headers = plan.prepareHeaders(new Headers(), "token", "key");
		expect(headers.get("x-token")).toBe("token");
		expect(headers.get("x-api-key")).toBe("key");
		await plan.transformRequestBody(requestFor());
		await plan.processResponse(Response.json({ ok: true }), new Headers());
		expect(plan.parseRateLimit(new Response(null, { status: 429 }))).toEqual({
			isRateLimited: true,
			remaining: 3,
		});
		expect(plan.isStreamingResponse?.(new Response())).toBe(true);
		expect(await plan.extractTierInfo?.(new Response())).toBe(4);
		expect(await plan.extractUsageInfo?.(new Response())).toEqual({
			totalTokens: 9,
		});
		expect(await plan.parseUsage?.(new Response())).toEqual({
			outputTokens: 2,
		});
		expect(thisValues.every((value) => value === provider)).toBe(true);
	});

	test("rejects legacy identity and strategy drift during planning", () => {
		for (const drift of ["name", "strategy"] as const) {
			let provider: Provider;
			let mappedHookCalls = 0;
			provider = baseProvider({
				name: "stable-before-planning",
				prepareRequest() {
					if (drift === "name") provider.name = "mutated-during-prepare";
				},
				buildUrl() {
					if (drift === "strategy") {
						Object.defineProperty(provider, "cacheReplayModelStrategy", {
							configurable: true,
							enumerable: true,
							value: "transformed-body",
							writable: true,
						});
					}
					return "https://drift.invalid";
				},
				async transformRequestBody(request) {
					mappedHookCalls += 1;
					return request;
				},
			});
			Object.defineProperty(provider, "cacheReplayModelStrategy", {
				configurable: true,
				enumerable: true,
				value: "normalized-source",
				writable: true,
			});

			expect(() =>
				materializeProviderAttemptPlan(provider, context(accountFixture())),
			).toThrow();
			expect(mappedHookCalls).toBe(0);
		}
	});

	test("rejects legacy and custom method-reference drift during planning", () => {
		for (const planningMode of ["legacy", "custom"] as const) {
			let provider: Provider;
			let originalMappedCalls = 0;
			let replacementMappedCalls = 0;
			const originalTransform = async (request: Request) => {
				originalMappedCalls += 1;
				return request;
			};
			const replacementTransform = async (request: Request) => {
				replacementMappedCalls += 1;
				return request;
			};
			provider = baseProvider({
				name: planningMode === "custom" ? "custom" : "method-stable",
				transformRequestBody: originalTransform,
				...(planningMode === "custom"
					? {
							createAttemptPlan() {
								provider.transformRequestBody = replacementTransform;
								return customPlan();
							},
						}
					: {
							prepareRequest() {
								provider.transformRequestBody = replacementTransform;
							},
						}),
			});
			const planningContext = context(accountFixture(), {
				...(planningMode === "custom"
					? {
							physicalModel: "gpt-5.6-sol",
							capabilityProofKey: "proof:custom",
							inputReplayMode: ["proxy-evidence-v1"] as const,
							outputReplayMode: ["proxy-evidence-v1"] as const,
						}
					: {}),
			});

			expect(() =>
				materializeProviderAttemptPlan(provider, planningContext),
			).toThrow();
			expect(originalMappedCalls).toBe(0);
			expect(replacementMappedCalls).toBe(0);
		}
	});

	test("fails closed on an alternating provider name getter", () => {
		const provider = baseProvider();
		let nameReads = 0;
		Object.defineProperty(provider, "name", {
			configurable: true,
			enumerable: true,
			get() {
				nameReads += 1;
				return nameReads % 2 === 1 ? "first-name" : "second-name";
			},
		});

		expect(() =>
			materializeProviderAttemptPlan(provider, context(accountFixture())),
		).toThrow();
		expect(nameReads).toBe(2);
	});

	test("binds one stable legacy provider snapshot and normalizes an undefined strategy", async () => {
		let originalTransformCalls = 0;
		let replacementTransformCalls = 0;
		const originalTransform = async (request: Request) => {
			originalTransformCalls += 1;
			return request;
		};
		const provider = baseProvider({
			name: "snapshot-original",
			transformRequestBody: originalTransform,
		});

		const plan = materializeProviderAttemptPlan(
			provider,
			context(accountFixture()),
		);
		provider.name = "snapshot-after";
		provider.transformRequestBody = async (request) => {
			replacementTransformCalls += 1;
			return request;
		};

		expect(plan.providerName).toBe("snapshot-original");
		expect(plan.apiFamily).toBe("legacy:snapshot-original");
		expect(plan.cacheReplayModelStrategy).toBe("normalized-source");
		await plan.transformRequestBody(requestFor());
		expect(originalTransformCalls).toBe(1);
		expect(replacementTransformCalls).toBe(0);
	});

	test("captures the optional legacy body-derived rate-limit hook", async () => {
		let originalCalls = 0;
		let replacementCalls = 0;
		const provider = baseProvider() as Provider & {
			parseRateLimitFromBody?: (
				response: Response,
			) => Promise<number | undefined>;
		};
		provider.parseRateLimitFromBody = async function (response) {
			expect(this).toBe(provider);
			originalCalls += 1;
			return response.status === 429 ? 321 : undefined;
		};

		const plan = materializeProviderAttemptPlan(
			provider,
			context(accountFixture()),
		) as ProviderAttemptPlan & {
			parseRateLimitFromBody?: (
				response: Response,
			) => Promise<number | undefined>;
		};
		provider.parseRateLimitFromBody = async () => {
			replacementCalls += 1;
			return 999;
		};

		expect(
			await plan.parseRateLimitFromBody?.(new Response(null, { status: 429 })),
		).toBe(321);
		expect(originalCalls).toBe(1);
		expect(replacementCalls).toBe(0);
	});

	test("accepts a synchronous custom planner and deep-freezes its plan", async () => {
		const sharedAccount = accountFixture();
		let plannerCalls = 0;
		let legacyHookCalls = 0;
		const provider = baseProvider({
			name: "custom",
			cacheReplayModelStrategy: "normalized-source",
			prepareRequest() {
				legacyHookCalls += 1;
			},
			buildUrl() {
				legacyHookCalls += 1;
				return "https://legacy.invalid";
			},
			createAttemptPlan(planningContext) {
				plannerCalls += 1;
				expect(planningContext.physicalModel).toBe("gpt-5.6-sol");
				return customPlan();
			},
		});

		const plan = materializeProviderAttemptPlan(
			provider,
			context(sharedAccount, {
				physicalModel: "gpt-5.6-sol",
				capabilityProofKey: "proof:custom",
				inputReplayMode: ["proxy-evidence-v1"],
				outputReplayMode: ["proxy-evidence-v1"],
			}),
		);

		expect(plan).not.toBeInstanceOf(Promise);
		expect(plannerCalls).toBe(1);
		expect(legacyHookCalls).toBe(0);
		expect(plan.targetUrl).toBe("https://custom.invalid/v1/responses");
		expect(plan.cacheReplayModelStrategy).toBe("transformed-body");
		expect(
			await plan.classifyNoExecution(
				createProviderAttemptNoExecutionSnapshot({
					status: 400,
					headers: {},
					bodyText: "unsupported",
					bodyTruncated: false,
				}),
			),
		).toEqual({
			decision: "proven_no_execution",
			reason: "fixture_rejection",
		});
		expectDeeplyFrozen(plan);
	});

	test("binds and freezes a custom body-derived rate-limit hook", async () => {
		let originalCalls = 0;
		let replacementCalls = 0;
		let materializedThis: unknown;
		const candidate = customPlan() as ProviderAttemptPlan & {
			parseRateLimitFromBody?: (
				response: Response,
			) => Promise<number | undefined>;
		};
		candidate.parseRateLimitFromBody = async function (response) {
			materializedThis = this;
			originalCalls += 1;
			return response.status === 429 ? 654 : undefined;
		};
		const provider = baseProvider({
			name: "custom",
			createAttemptPlan: () => candidate,
		});

		const plan = materializeProviderAttemptPlan(
			provider,
			context(accountFixture(), {
				physicalModel: "gpt-5.6-sol",
				capabilityProofKey: "proof:custom",
				inputReplayMode: ["proxy-evidence-v1"],
				outputReplayMode: ["proxy-evidence-v1"],
			}),
		) as ProviderAttemptPlan & {
			parseRateLimitFromBody?: (
				response: Response,
			) => Promise<number | undefined>;
		};
		candidate.parseRateLimitFromBody = async () => {
			replacementCalls += 1;
			return 999;
		};

		expect(
			await plan.parseRateLimitFromBody?.(new Response(null, { status: 429 })),
		).toBe(654);
		expect(materializedThis).toBe(plan);
		expect(originalCalls).toBe(1);
		expect(replacementCalls).toBe(0);
		expect(Object.isFrozen(plan)).toBe(true);
	});

	test("rejects Promise and bare-thenable planners synchronously before legacy hooks", () => {
		const sharedAccount = accountFixture();
		const bareThenable: Record<string, unknown> = {};
		// biome-ignore lint/suspicious/noThenProperty: The contract must reject non-Promise thenables synchronously.
		Object.defineProperty(bareThenable, "then", {
			value: () => undefined,
		});
		for (const createAttemptPlan of [
			async () => customPlan(),
			() => bareThenable,
		]) {
			let legacyHookCalls = 0;
			const provider = baseProvider({
				prepareRequest() {
					legacyHookCalls += 1;
				},
				buildUrl() {
					legacyHookCalls += 1;
					return "https://legacy.invalid";
				},
				createAttemptPlan,
			} as Partial<Provider>);

			expect(() =>
				materializeProviderAttemptPlan(provider, context(sharedAccount)),
			).toThrow();
			expect(legacyHookCalls).toBe(0);
		}
	});

	test("rejects malformed custom plans synchronously without invoking returned hooks", () => {
		const sharedAccount = accountFixture();
		for (const malformed of [
			null,
			{},
			customPlan({ targetUrl: "" }),
			customPlan({
				dataRetryPolicy: {
					mode: "reuse-same-plan",
					maxAttempts: -1,
				},
			}),
			customPlan({ prepareHeaders: undefined as never }),
		]) {
			let returnedHookCalls = 0;
			const candidate =
				malformed && typeof malformed === "object"
					? {
							...malformed,
							transformRequestBody: async (request: Request) => {
								returnedHookCalls += 1;
								return request;
							},
						}
					: malformed;
			const provider = baseProvider({
				createAttemptPlan: () => candidate,
			} as Partial<Provider>);

			expect(() =>
				materializeProviderAttemptPlan(provider, context(sharedAccount)),
			).toThrow();
			expect(returnedHookCalls).toBe(0);
		}
	});

	test("rejects non-HTTP targets outside the legacy Bedrock provider scope", () => {
		for (const targetUrl of [
			"file:///etc/passwd",
			"bedrock://fixture/v1/messages",
		]) {
			const provider = baseProvider({ buildUrl: () => targetUrl });

			expect(() =>
				materializeProviderAttemptPlan(provider, context(accountFixture())),
			).toThrow("Invalid provider attempt plan targetUrl");
		}

		const customBedrockProvider = baseProvider({
			name: "bedrock",
			createAttemptPlan: () =>
				customPlan({
					providerName: "bedrock",
					targetUrl: "bedrock://fixture/v1/messages",
				}),
		});
		expect(() =>
			materializeProviderAttemptPlan(
				customBedrockProvider,
				context(accountFixture(), {
					physicalModel: "gpt-5.6-sol",
					capabilityProofKey: "proof:custom",
					inputReplayMode: ["proxy-evidence-v1"],
					outputReplayMode: ["proxy-evidence-v1"],
				}),
			),
		).toThrow("Invalid provider attempt plan targetUrl");
	});

	test("skips unused planning Request and ArrayBuffer copies for ordinary legacy providers", () => {
		const callerRequest = requestFor();
		let cloneCalls = 0;
		Object.defineProperty(callerRequest, "clone", {
			configurable: true,
			value() {
				cloneCalls += 1;
				throw new Error("ordinary providers must not clone planning requests");
			},
		});
		const detachedBuffer = new Uint8Array([1, 2, 3]).buffer;
		structuredClone(detachedBuffer, { transfer: [detachedBuffer] });

		const plan = materializeProviderAttemptPlan(
			baseProvider(),
			context(accountFixture(), {
				request: callerRequest,
				requestBodyBuffer: detachedBuffer,
			}),
		);

		expect(plan.targetUrl).toBe("https://fixture.invalid/v1/messages");
		expect(cloneCalls).toBe(0);
	});

	for (const planningMode of ["legacy", "custom"] as const) {
		test(`gives ${planningMode} planning private Request and ArrayBuffer copies`, async () => {
			const callerRequest = new Request(
				"http://proxy.local/v1/messages?fixture=caller",
				{
					method: "POST",
					headers: {
						"content-type": "text/plain",
						"x-caller": "unchanged",
					},
					body: "caller-body",
				},
			);
			const originalBytes = new Uint8Array([11, 22, 33, 44]);
			const callerBuffer = originalBytes.slice().buffer;
			let retainedRequest: Request | undefined;
			let retainedBuffer: ArrayBuffer | undefined;
			let privateBodyRead: Promise<string> | undefined;
			const mutatePlanningInputs = (
				request: Request,
				buffer: ArrayBuffer | null,
			) => {
				expect(request).not.toBe(callerRequest);
				expect(buffer).not.toBe(callerBuffer);
				retainedRequest = request;
				retainedBuffer = buffer as ArrayBuffer;
				request.headers.set("x-caller", "planning");
				request.headers.set("x-planning", "added");
				privateBodyRead = request.text();
				new Uint8Array(retainedBuffer).fill(0);
			};
			const provider =
				planningMode === "legacy"
					? baseProvider({
							prepareRequest(request, buffer) {
								mutatePlanningInputs(request, buffer);
							},
						})
					: baseProvider({
							name: "custom",
							createAttemptPlan(planningContext) {
								mutatePlanningInputs(
									planningContext.request,
									planningContext.requestBodyBuffer,
								);
								return customPlan();
							},
						});
			const planningContext = context(accountFixture(), {
				request: callerRequest,
				requestBodyBuffer: callerBuffer,
				...(planningMode === "custom"
					? {
							physicalModel: "gpt-5.6-sol",
							capabilityProofKey: "proof:custom",
							inputReplayMode: ["proxy-evidence-v1"] as const,
							outputReplayMode: ["proxy-evidence-v1"] as const,
						}
					: {}),
			});

			materializeProviderAttemptPlan(provider, planningContext);
			expect(await privateBodyRead).toBe("caller-body");
			expect(retainedRequest).toBeDefined();
			expect(retainedBuffer).toBeDefined();
			retainedRequest?.headers.set("x-after-planning", "mutated");
			new Uint8Array(retainedBuffer as ArrayBuffer)[0] = 99;
			structuredClone(retainedBuffer, {
				transfer: [retainedBuffer as ArrayBuffer],
			});

			expect(callerRequest.headers.get("x-caller")).toBe("unchanged");
			expect(callerRequest.headers.has("x-planning")).toBe(false);
			expect(callerRequest.headers.has("x-after-planning")).toBe(false);
			expect(callerRequest.bodyUsed).toBe(false);
			expect(await callerRequest.text()).toBe("caller-body");
			expect(callerBuffer.byteLength).toBe(originalBytes.byteLength);
			expect([...new Uint8Array(callerBuffer)]).toEqual([...originalBytes]);
		});
	}

	test("fails synchronously before provider hooks when planning inputs cannot be copied", async () => {
		const consumedRequest = requestFor();
		await consumedRequest.text();
		const detachedBuffer = new Uint8Array([1, 2, 3]).buffer;
		structuredClone(detachedBuffer, { transfer: [detachedBuffer] });

		for (const overrides of [
			{ request: consumedRequest },
			{ requestBodyBuffer: detachedBuffer },
		]) {
			let hookCalls = 0;
			const provider = baseProvider({
				prepareRequest() {
					hookCalls += 1;
				},
				buildUrl() {
					hookCalls += 1;
					return "https://should-not-run.invalid";
				},
				createAttemptPlan() {
					hookCalls += 1;
					return customPlan();
				},
			});

			expect(() =>
				materializeProviderAttemptPlan(
					provider,
					context(accountFixture(), overrides),
				),
			).toThrow();
			expect(hookCalls).toBe(0);
		}
	});

	test("creates canonical deeply frozen snapshots at the UTF-8 body limit", () => {
		const bodyText = "a".repeat(MAX_PROVIDER_NO_EXECUTION_BODY_BYTES);
		const snapshot = createProviderAttemptNoExecutionSnapshot({
			status: 400,
			headers: [
				["X-Zeta", " two "],
				["x-alpha", "one"],
			],
			bodyText,
			bodyTruncated: false,
		});

		expect(snapshot).toMatchObject({
			status: 400,
			headers: [
				["x-alpha", "one"],
				["x-zeta", "two"],
			],
			bodyText,
			bodyTruncated: false,
		});
		expectDeeplyFrozen(snapshot);
		expect(() =>
			createProviderAttemptNoExecutionSnapshot({
				status: 400,
				headers: {},
				bodyText: `${bodyText}a`,
				bodyTruncated: true,
			}),
		).toThrow();
		for (const invalid of [
			{ status: 99, bodyTruncated: false },
			{ status: 600, bodyTruncated: false },
			{ status: 400.5, bodyTruncated: false },
			{ status: 400, bodyTruncated: "false" },
		]) {
			expect(() =>
				createProviderAttemptNoExecutionSnapshot({
					status: invalid.status,
					headers: {},
					bodyText: "invalid",
					bodyTruncated: invalid.bodyTruncated as boolean,
				}),
			).toThrow();
		}
	});

	test("rejects unbranded classifier metadata before custom hooks and never consumes a Response", async () => {
		let classifierCalls = 0;
		let classifierInput: ProviderAttemptNoExecutionSnapshot | undefined;
		const provider = baseProvider({
			name: "custom",
			createAttemptPlan: () =>
				customPlan({
					classifyNoExecution: async (snapshot) => {
						classifierCalls += 1;
						classifierInput = snapshot;
						return {
							decision: "proven_no_execution",
							reason: snapshot.bodyText,
						};
					},
				}),
		});
		const plan = materializeProviderAttemptPlan(
			provider,
			context(accountFixture(), {
				physicalModel: "gpt-5.6-sol",
				capabilityProofKey: "proof:custom",
				inputReplayMode: ["proxy-evidence-v1"],
				outputReplayMode: ["proxy-evidence-v1"],
			}),
		);
		const forged = Object.freeze({
			status: 400,
			headers: Object.freeze([]),
			bodyText: "forged",
			bodyTruncated: false,
		}) as unknown as ProviderAttemptNoExecutionSnapshot;

		await expect(plan.classifyNoExecution(forged)).rejects.toThrow();
		expect(classifierCalls).toBe(0);

		const response = new Response("still-readable", {
			status: 400,
			headers: { "x-fixture": "yes" },
		});
		const snapshot = createProviderAttemptNoExecutionSnapshot({
			status: response.status,
			headers: response.headers,
			bodyText: "still-readable",
			bodyTruncated: false,
		});
		expect(await plan.classifyNoExecution(snapshot)).toEqual({
			decision: "proven_no_execution",
			reason: "still-readable",
		});
		expect(classifierCalls).toBe(1);
		expect(classifierInput).toBe(snapshot);
		expect(response.bodyUsed).toBe(false);
		expect(await response.text()).toBe("still-readable");
	});

	test("uses conservative legacy retry and no-execution defaults", async () => {
		const plan = materializeProviderAttemptPlan(
			baseProvider(),
			context(accountFixture(), {
				physicalModel: null,
				capabilityProofKey: null,
			}),
		);

		expect(plan.dataRetryPolicy).toEqual({ mode: "none", maxAttempts: 0 });
		for (const snapshot of [
			createProviderAttemptNoExecutionSnapshot({
				status: 400,
				headers: {},
				bodyText: "unsupported tool",
				bodyTruncated: false,
			}),
			createProviderAttemptNoExecutionSnapshot({
				status: 429,
				headers: {},
				bodyText: "rate limited",
				bodyTruncated: false,
			}),
			createProviderAttemptNoExecutionSnapshot({
				status: 529,
				headers: {},
				bodyText: "overloaded",
				bodyTruncated: false,
			}),
			createProviderAttemptNoExecutionSnapshot({
				status: 307,
				headers: { location: "https://other.invalid" },
				bodyText: "",
				bodyTruncated: false,
			}),
		]) {
			expect(await plan.classifyNoExecution(snapshot)).toEqual({
				decision: "executing_or_ambiguous",
			});
		}
	});
});
