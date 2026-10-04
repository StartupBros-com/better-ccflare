import { expect, it, spyOn } from "bun:test";
import {
	CodexProvider,
	captureAutoRequestRequirements,
	createAutoCatalogEvidence,
	estimateAnthropicAdmissionTokens,
	resolveAutoModelTargets,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	clearCodexModelCacheForTests,
	getCodexAutoCatalogEvidence,
	getCodexModels,
} from "../../codex-model-catalog";
import {
	fetchLiveModels,
	getNativeAutoCatalogEvidence,
	resetModelCatalogForTest,
} from "../../model-catalog";
import type { ProxyContext } from "../proxy-types";
import {
	evaluateQualityRouteAdmission,
	type QualityRouteAdmissionInput,
} from "../quality-route-admission";

function fixture(): QualityRouteAdmissionInput {
	const now = Date.now();
	const catalog = createAutoCatalogEvidence({
		accountId: "a",
		provider: "anthropic",
		source: "live",
		fetchedAt: now,
		expiresAt: now + 60000,
		models: [{ id: "claude-fable-5-1" }],
	});
	const target = resolveAutoModelTargets(catalog, "claude-fable").current;
	if (!catalog || !target) throw new Error("Invalid catalog fixture");
	const body = {
		model: target.physicalModel,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 20,
	};
	return {
		account: {
			id: "a",
			provider: "anthropic",
			paused: false,
			rate_limited_until: null,
		},
		policy: {
			accounts: [
				{
					accountId: "a",
					provider: "anthropic",
					lines: ["claude-fable"],
					priority: 0,
				},
			],
			assignments: [
				{
					line: "claude-fable",
					lane: "fable",
					priority: 0,
					upgrade: "same-line-supported",
				},
			],
			spendGrants: [],
		},
		request: {
			catalog,
			target,
			requirements: captureAutoRequestRequirements(body),
			finalBody: body,
		},
		usage: {
			accountId: "a",
			provider: "anthropic",
			observedAt: now,
			data: {
				limits: [{ kind: "weekly_all", percent: 10, resets_at: now + 60000 }],
				spend: { enabled: false },
			},
		},
	};
}

it("admits through the real owner guard and blocks replacement/expiry during preparation", async () => {
	const originalFetch = globalThis.fetch;
	const account = {
		...fixture().account,
		created_at: 1,
		access_token: "synthetic-token",
		api_key: null,
		expires_at: Date.now() + 3600000,
		custom_endpoint: null,
	} as Account;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				data: [
					{
						id: "claude-fable-5-1",
						max_input_tokens: 10000,
						max_tokens: 20,
						capabilities: {
							image_input: { supported: false },
							pdf_input: { supported: false },
						},
					},
				],
				has_more: false,
			}),
		{ preconnect: () => {} },
	);
	try {
		await fetchLiveModels(
			{
				dbOps: {
					getAllAccounts: async () => [account],
					getAccount: async () => account,
				},
				refreshInFlight: new Map(),
			} as unknown as ProxyContext,
			{ allowOAuth: true },
		);
		const catalog = getNativeAutoCatalogEvidence(account.id);
		const target = resolveAutoModelTargets(catalog, "claude-fable").current;
		if (!catalog || !target) throw new Error("missing owned evidence");
		const base = fixture();
		const input = {
			...base,
			account,
			selectedCredentials: { account, accessToken: "synthetic-token" },
			request: { ...base.request, catalog, target },
		};
		expect(evaluateQualityRouteAdmission(input).status).toBe("admit");
		let transportCalls = 0;
		await Promise.resolve();
		const rotated = evaluateQualityRouteAdmission({
			...input,
			selectedCredentials: { account, accessToken: "replacement" },
		});
		if (rotated.status === "admit") transportCalls++;
		expect(rotated).toMatchObject({
			status: "unknown",
			reason: "credential-evidence-unknown",
		});
		const clock = spyOn(Date, "now").mockReturnValue(catalog.expiresAt);
		try {
			const expired = evaluateQualityRouteAdmission(input);
			if (expired.status === "admit") transportCalls++;
			expect(expired).toMatchObject({
				status: "unknown",
				reason: "catalog-evidence-stale",
			});
		} finally {
			clock.mockRestore();
		}
		expect(transportCalls).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
		resetModelCatalogForTest();
	}
});
const codexCeilingCases = [
	{ name: "catalog ceiling 20", ceiling: 20, malformed: false },
	{ name: "catalog ceiling 19", ceiling: 19, malformed: false },
	{ name: "missing ceiling", ceiling: undefined, malformed: false },
	{ name: "explicit null ceiling", ceiling: null, malformed: false },
	{ name: "zero ceiling", ceiling: 0, malformed: true },
	{ name: "negative ceiling", ceiling: -1, malformed: true },
	{ name: "fractional ceiling", ceiling: 1.5, malformed: true },
	{ name: "numeric string ceiling", ceiling: "20", malformed: true },
	{
		name: "unsafe integer ceiling",
		ceiling: Number.MAX_SAFE_INTEGER + 1,
		malformed: true,
	},
	{ name: "object ceiling", ceiling: { tokens: 20 }, malformed: true },
];

it.each([
	...codexCeilingCases.flatMap(({ name, ceiling, malformed }) =>
		[true, false].map((withGrant) => ({
			name: `${name}, grant=${withGrant}`,
			ceiling,
			malformed,
			withGrant,
			rotation: false,
		})),
	),
	{
		name: "usage token A versus catalog/dispatch token B",
		ceiling: 20,
		malformed: false,
		withGrant: false,
		rotation: true,
	},
])("synthetic Codex composite: $name", async ({
	ceiling,
	malformed,
	withGrant,
	rotation,
}) => {
	const savedFetch = globalThis.fetch;
	const account = {
		...fixture().account,
		provider: "codex",
		created_at: 1,
		access_token: "synthetic-token",
		api_key: null,
		expires_at: Date.now() + 3600000,
		custom_endpoint: null,
	} as Account;
	globalThis.fetch = Object.assign(
		async (url: string | URL | Request) =>
			String(url).includes("/usage")
				? Response.json({
						rate_limit: {
							allowed: true,
							limit_reached: false,
							primary_window: null,
							secondary_window: {
								used_percent: 55,
								reset_at: Math.floor(Date.now() / 1000) + 3600,
							},
						},
						credits: { has_credits: false, unlimited: false, balance: 0 },
					})
				: Response.json({
						models: [
							{
								slug: "gpt-6-astra",
								context_window: 272000,
								max_context_window: 872000,
								max_output_tokens: ceiling,
								input_modalities: ["text", "image"],
							},
						],
					}),
		{ preconnect: () => {} },
	);
	const ctx = {
		dbOps: { getAccount: async () => account },
		refreshInFlight: new Map(),
	} as unknown as ProxyContext;
	try {
		const original = {
			model: "gpt-6-astra",
			messages: [{ role: "user", content: "hello" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			max_tokens: 20,
		};
		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://chatgpt.com/backend-api/codex/responses", {
				method: "POST",
				body: JSON.stringify(original),
				headers: { "content-type": "application/json" },
			}),
		);
		const finalBody = await transformed.json();
		expect(finalBody.max_output_tokens).toBeUndefined();
		await new Promise<void>((resolve) =>
			usageCache.startPolling(
				account.id,
				async () => account.access_token as string,
				"codex",
				60_000,
				undefined,
				undefined,
				undefined,
				() => resolve(),
			),
		);
		const snapshot = usageCache.getSnapshot(account.id);
		if (!snapshot) throw new Error("poll did not publish a snapshot");
		await getCodexModels(account.id, ctx);
		const catalog = getCodexAutoCatalogEvidence(account.id);
		const target = resolveAutoModelTargets(catalog, "gpt-astra").current;
		if (!catalog || !target)
			throw new Error("missing source-owned synthetic catalog");
		const input: QualityRouteAdmissionInput = {
			...fixture(),
			account,
			selectedCredentials: { account, accessToken: "synthetic-token" },
			policy: {
				accounts: [
					{
						accountId: account.id,
						provider: "codex",
						lines: ["gpt-astra"],
						priority: 0,
					},
				],
				assignments: [
					{
						line: "gpt-astra",
						lane: "astra",
						priority: 0,
						upgrade: "same-line-supported",
					},
				],
				spendGrants: withGrant
					? [
							{
								accountId: account.id,
								line: "gpt-astra",
								authorization: "operator-approved",
								scope: "outside-subscription",
							},
						]
					: [],
			},
			usage: withGrant
				? { ...fixture().usage, provider: "codex" }
				: { ...snapshot, accountId: account.id, provider: "codex" },
			request: {
				catalog,
				target,
				requirements: captureAutoRequestRequirements(original),
				finalBody,
			},
		};
		if (rotation) {
			// Keep this baseline independent of the new output-limit accounting.
			expect(evaluateQualityRouteAdmission(input).status).toBe("admit");
			// Catalog and dispatch own token B, while usage still owns token A.
			// A matching fresh catalog must not mask lost dispatch-token forwarding.
			account.access_token = "rotated";
			await getCodexModels(account.id, ctx);
			const rotatedCatalog = getCodexAutoCatalogEvidence(account.id);
			const rotatedTarget = resolveAutoModelTargets(
				rotatedCatalog,
				"gpt-astra",
			).current;
			if (!rotatedCatalog || !rotatedTarget)
				throw new Error("missing rotated catalog");
			const rotated: QualityRouteAdmissionInput = {
				...input,
				selectedCredentials: { account, accessToken: "rotated" },
				request: {
					...input.request,
					catalog: rotatedCatalog,
					target: rotatedTarget,
				},
			};
			expect(evaluateQualityRouteAdmission(rotated).status).not.toBe("admit");
			expect(await usageCache.refreshNow(account.id)).toBe(true);
			const refreshed = usageCache.getSnapshot(account.id);
			if (!refreshed) throw new Error("missing rotated usage");
			expect(
				evaluateQualityRouteAdmission({
					...rotated,
					usage: { ...refreshed, accountId: account.id, provider: "codex" },
				}),
			).toMatchObject({
				status: "admit",
				// The subscription wire carries no cap, so stock reserves nothing.
				accounting: { requestedOutput: 0 },
			});
			return;
		}
		if (malformed) {
			// Stock never checks a malformed ceiling, so Auto admits it; the
			// subscription wire carries no cap, so nothing is reserved.
			expect(evaluateQualityRouteAdmission(input)).toMatchObject({
				status: "admit",
				accounting: {
					requestedOutput: 0,
					outputLimit: { kind: "provider-managed", tokens: null },
				},
			});
			return;
		}
		expect(evaluateQualityRouteAdmission(input)).toMatchObject(
			ceiling === 19
				? { status: "reject", reason: "output-unsupported" }
				: {
						status: "admit",
						accounting: {
							// The subscription endpoint drops max_output_tokens: stock
							// reserves 0 whatever the catalog ceiling.
							requestedOutput: 0,
							outputLimit:
								ceiling == null
									? { kind: "provider-managed", tokens: null }
									: { kind: "catalog", tokens: 20 },
						},
					},
		);
		if (ceiling == null) {
			expect(target.capabilities?.maxOutputTokens).toBeNull();
			for (const max_tokens of [
				undefined,
				null,
				0,
				-1,
				1.5,
				"20",
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				// A missing or invalid max_tokens is admitted: the adapter forwards no
				// cap and stock sends it. The provider-managed reserve is 0 either way.
				expect(
					evaluateQualityRouteAdmission({
						...input,
						request: {
							...input.request,
							requirements: captureAutoRequestRequirements({
								...original,
								max_tokens,
							}),
						},
					}),
				).toMatchObject({
					status: "admit",
					accounting: { requestedOutput: 0 },
				});
			}
			// Stock's estimator and a zero reserve against stock's window: the
			// 872000 maximum (no percent advertised), not the 272000 current one.
			const window = 872000;
			const estimateFor = (padding: number) =>
				estimateAnthropicAdmissionTokens({
					...original,
					messages: [{ role: "user", content: "x".repeat(padding) }],
				}).tokens;
			let padding = Math.max(0, (window - estimateFor(0)) * 2);
			while (estimateFor(padding + 1) <= window) padding++;
			while (estimateFor(padding) > window) padding--;
			for (const excess of [0, 1]) {
				expect(
					evaluateQualityRouteAdmission({
						...input,
						request: {
							...input.request,
							requirements: captureAutoRequestRequirements({
								...original,
								messages: [
									{ role: "user", content: "x".repeat(padding + excess) },
								],
							}),
						},
					}),
				).toMatchObject({
					status: excess === 0 ? "admit" : "reject",
					...(excess === 1 ? { reason: "context-unsupported" } : {}),
					accounting: {
						headroom: 0,
						requestedOutput: 0,
						outputLimit: { kind: "provider-managed", tokens: null },
					},
				});
			}
			// The final body is not rebuilt: a translated body with different tools or
			// input still admits; only an untranslated one (no Responses input) is refused.
			for (const changed of [
				{ ...finalBody, input: [] },
				{ ...finalBody, tools: [] },
			]) {
				expect(
					evaluateQualityRouteAdmission({
						...input,
						request: { ...input.request, finalBody: changed },
					}).status,
				).toBe("admit");
			}
			const { input: _translatedInput, ...untranslated } = finalBody;
			expect(
				evaluateQualityRouteAdmission({
					...input,
					request: { ...input.request, finalBody: untranslated },
				}),
			).toMatchObject({
				status: "unknown",
				reason: "request-preservation-unknown",
			});
			expect(
				evaluateQualityRouteAdmission({
					...input,
					request: {
						...input.request,
						finalBody: { ...finalBody, max_output_tokens: 19 },
					},
				}),
			).toMatchObject({ status: "reject", reason: "output-unsupported" });
		}
		if (!withGrant && ceiling === 20) {
			expect(
				evaluateQualityRouteAdmission({
					...input,
					selectedCredentials: { account, accessToken: "rotated" },
				}).status,
			).not.toBe("admit");
			expect(
				evaluateQualityRouteAdmission({
					...input,
					request: {
						...input.request,
						requirements: captureAutoRequestRequirements({
							...original,
							max_tokens: 21,
						}),
					},
				}).status,
			).not.toBe("admit");
		}
	} finally {
		usageCache.stopPolling(account.id);
		usageCache.delete(account.id);
		globalThis.fetch = savedFetch;
		clearCodexModelCacheForTests();
	}
});
it("exposes the missing selected-credential epoch gate, never accepts account-ID-only evidence", () => {
	expect(evaluateQualityRouteAdmission(fixture())).toMatchObject({
		status: "unknown",
		reason: "credential-evidence-unknown",
	});
});
it("uses current grants after preparation, without calling transport on reject or unknown", async () => {
	const input = fixture();
	const withOverage = {
		...input,
		usage: {
			...input.usage,
			data: {
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
			},
		},
	};
	let calls = 0;
	let currentPolicy: QualityRouteAdmissionInput["policy"] = {
		...input.policy,
		spendGrants: [
			{
				accountId: "a",
				line: "claude-fable",
				authorization: "operator-approved",
				scope: "outside-subscription",
			},
		],
	};
	expect(
		evaluateQualityRouteAdmission({ ...withOverage, policy: currentPolicy }),
	).toMatchObject({ status: "unknown", reason: "credential-evidence-unknown" });
	// Synthetic preparation revokes permission; this is not U5 dispatch proof.
	await Promise.resolve().then(() => {
		currentPolicy = { ...currentPolicy, spendGrants: [] };
	});
	const decision = evaluateQualityRouteAdmission({
		...withOverage,
		policy: currentPolicy,
	});
	if (decision.status === "admit") calls++;
	expect(decision).toEqual({
		status: "reject",
		reason: "spend-not-authorized",
	});
	expect(calls).toBe(0);
	if (!input.request.catalog) throw new Error("Missing fixture catalog");
	const expired = {
		...input,
		request: {
			...input.request,
			catalog: { ...input.request.catalog, expiresAt: Date.now() - 1 },
		},
	};
	const expiry = evaluateQualityRouteAdmission(expired);
	if (expiry.status === "admit") calls++;
	expect(expiry).toEqual({
		status: "unknown",
		reason: "catalog-evidence-stale",
	});
	expect(calls).toBe(0);
});
it("rejects enrollment removal and hard provider limits independently of missing request evidence", () => {
	const input = fixture();
	expect(
		evaluateQualityRouteAdmission({
			...input,
			policy: { ...input.policy, accounts: [] },
		}),
	).toEqual({ status: "reject", reason: "account-not-enrolled" });
	expect(
		evaluateQualityRouteAdmission({
			...input,
			usage: {
				...input.usage,
				data: {
					limits: [
						{ kind: "weekly_all", percent: 100, resets_at: Date.now() + 60000 },
					],
				},
			},
		}),
	).toEqual({ status: "reject", reason: "provider-capacity-exhausted" });
});
