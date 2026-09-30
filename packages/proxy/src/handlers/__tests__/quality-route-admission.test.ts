import { expect, it, spyOn } from "bun:test";
import {
	CodexProvider,
	captureAutoRequestRequirements,
	createAutoCatalogEvidence,
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
						input_modalities: ["text"],
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
it.each([
	true,
	false,
])("admits synthetic Codex through the composite (grant=%s), never inferring a missing ceiling", async (withGrant) => {
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
	let outputCeiling: number | undefined = 20;
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
								context_window: 10000,
								max_context_window: 10000,
								max_output_tokens: outputCeiling,
								input_modalities: ["text"],
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
		await new Promise<void>((resolve) =>
			usageCache.startPolling(
				account.id,
				"synthetic-token",
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
		for (const ceiling of [20, 19, undefined]) {
			outputCeiling = ceiling;
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
			expect(evaluateQualityRouteAdmission(input)).toMatchObject(
				ceiling === 20
					? { status: "admit", accounting: { requestedOutput: 20 } }
					: {
							status: ceiling === undefined ? "unknown" : "reject",
							reason: "output-unsupported",
						},
			);
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
