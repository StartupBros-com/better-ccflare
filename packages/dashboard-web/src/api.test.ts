import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { RequestOptions } from "@better-ccflare/http-common";
import { api } from "./api";

type RequestCall = [url: string, options: RequestOptions];

const originalRequest = api.request;
let requestMock: ReturnType<typeof mock>;

function calls(): RequestCall[] {
	return requestMock.mock.calls as unknown as RequestCall[];
}

function callFor(url: string): RequestCall {
	const found = calls().find(([candidate]) => candidate === url);
	if (!found) throw new Error(`Missing request for ${url}`);
	return found;
}

beforeEach(() => {
	requestMock = mock(async (url: string) => {
		if (url === "/api/oauth/device-setup/jobs?limit=17") return [];
		if (url.startsWith("/api/oauth/device-setup/jobs/")) {
			return {
				id: "opaque-job",
				provider: "codex",
				accountId: null,
				status: "awaiting_authorization",
				routingOutcomes: [],
				errorCode: null,
				errorMessage: null,
				createdAt: 1,
				updatedAt: 1,
				terminalAt: null,
			};
		}
		if (url === "/api/oauth/qwen/init" || url === "/api/oauth/codex/init") {
			return {
				job: {
					id: "opaque-job",
					provider: url.includes("qwen") ? "qwen" : "codex",
					accountId: null,
					status: "awaiting_authorization",
					routingOutcomes: [],
					errorCode: null,
					errorMessage: null,
					createdAt: 1,
					updatedAt: 1,
					terminalAt: null,
				},
				authorization: {
					verificationUrl: "https://authorize.example",
					userCode: "SAFE-CODE",
				},
				replayed: false,
			};
		}
		if (url.includes("/status/")) {
			return { status: "complete", accountId: "created-account" };
		}
		if (url === "/api/oauth/callback") {
			return {
				success: true,
				accountId: "created-account",
				message: "created",
				mode: "claude-oauth",
			};
		}
		if (url === "/api/oauth/anthropic/reauth/callback") {
			return { success: true, message: "reauthenticated" };
		}
		if (url.startsWith("/api/accounts/openai-compatible")) {
			return {
				success: true,
				accountId: "created-account",
				message: "created",
				account: {},
			};
		}
		return { success: true, data: { marker: url } };
	});
	api.request = requestMock as typeof api.request;
});

afterEach(() => {
	api.request = originalRequest;
});

describe("managed-routing dashboard API contracts", () => {
	it("uses durable device-setup contracts and copies only reviewed command fields", async () => {
		const command = {
			name: "account name",
			priority: 0,
			idempotencyKey: "device-setup-stable-key",
			reviewed: [
				{ family: "opus" as const, proposalId: "proposal/opaque:opus" },
				{ family: "fable" as const, proposalId: "proposal/opaque:fable" },
			],
			apiKey: "must-not-cross-api-boundary",
			jobId: "must-not-be-client-selected",
		};

		await api.initQwenDeviceFlow(command);
		await api.initCodexDeviceFlow(command);
		await api.getDeviceSetupJob("opaque/job id");
		await api.getRecentDeviceSetupJobs(17);

		for (const url of ["/api/oauth/qwen/init", "/api/oauth/codex/init"]) {
			const request = callFor(url)[1];
			expect(request.method).toBe("POST");
			expect(JSON.parse(request.body as string)).toEqual({
				name: "account name",
				priority: 0,
				idempotencyKey: "device-setup-stable-key",
				reviewed: [
					{ family: "opus", proposalId: "proposal/opaque:opus" },
					{ family: "fable", proposalId: "proposal/opaque:fable" },
				],
			});
		}
		expect(
			callFor("/api/oauth/device-setup/jobs/opaque%2Fjob%20id")[1].method,
		).toBe("GET");
		expect(callFor("/api/oauth/device-setup/jobs?limit=17")[1].method).toBe(
			"GET",
		);
	});

	it("uses the authoritative effective, preview, apply, and exclusion endpoints", async () => {
		await api.getEffectiveRouting();
		await api.getEffectiveRouting("opus");
		await api.getAccountRoutingOverview();
		await api.previewRouting(
			{
				draft: {
					provider: "anthropic",
					priority: 0,
					auth_shape: "oauth-subscription",
				},
			},
			"opus",
			"claude-opus-4-7",
		);
		await api.applyRoutingProposal({
			family: "opus",
			previewId: "preview:reviewed",
			proposalId: "proposal:reviewed",
			accountId: "account/created",
			managedModel: "claude-opus-4-7",
		});
		await api.excludeAccountFromFamily("opus", "account/created");
		await api.restoreAccountToFamily("opus", "account/created");

		expect(callFor("/api/routing/effective")[1].method).toBe("GET");
		expect(callFor("/api/routing/effective/opus")[1].method).toBe("GET");
		expect(callFor("/api/routing/accounts")[1].method).toBe("GET");

		const preview = callFor("/api/routing/preview")[1];
		expect(preview.method).toBe("POST");
		expect(JSON.parse(preview.body as string)).toEqual({
			family: "opus",
			managed_model: "claude-opus-4-7",
			draft: {
				provider: "anthropic",
				priority: 0,
				auth_shape: "oauth-subscription",
			},
		});

		const apply = callFor("/api/routing/apply/opus")[1];
		expect(apply.method).toBe("POST");
		expect(JSON.parse(apply.body as string)).toEqual({
			preview_id: "preview:reviewed",
			proposal_id: "proposal:reviewed",
			managed_model: "claude-opus-4-7",
			subject: { account_id: "account/created" },
		});

		const exclude = callFor("/api/routing/exclusions/opus")[1];
		expect(exclude.method).toBe("POST");
		expect(JSON.parse(exclude.body as string)).toEqual({
			account_id: "account/created",
		});
		expect(
			callFor("/api/routing/exclusions/opus/account%2Fcreated")[1].method,
		).toBe("DELETE");
	});

	it("sends family policy fields in the server-owned wire format", async () => {
		await api.updateFamilyPolicy({
			family: "fable",
			comboId: "combo-1",
			enabled: true,
			membershipMode: "managed",
			managedModel: "claude-fable-5",
		});
		const update = callFor("/api/families/fable")[1];
		expect(update.method).toBe("PUT");
		expect(JSON.parse(update.body as string)).toEqual({
			combo_id: "combo-1",
			enabled: true,
			membership_mode: "managed",
			managed_model: "claude-fable-5",
		});
	});

	it("preserves omitted family policy fields while retaining explicit combo null", async () => {
		await api.updateFamilyPolicy({ family: "opus", enabled: false });
		await api.updateFamilyPolicy({
			family: "opus",
			managedModel: "claude-opus-4-7",
		});
		await api.updateFamilyPolicy({
			family: "opus",
			comboId: "combo-2",
		});
		await api.updateFamilyPolicy({ family: "opus", comboId: null });
		await api.updateFamilyPolicy({ family: "opus", managedModel: null });
		await api.updateFamilyPolicy({ family: "opus", membershipMode: "manual" });
		await api.assignFamily({
			family: "fable",
			comboId: "combo-legacy",
			enabled: true,
		});

		const bodies = calls()
			.filter(([url]) => url === "/api/families/opus")
			.map(([, options]) => JSON.parse(options.body as string));
		expect(bodies).toEqual([
			{ enabled: false },
			{ managed_model: "claude-opus-4-7" },
			{ combo_id: "combo-2" },
			{ combo_id: null },
			{ managed_model: null },
			{ membership_mode: "manual" },
		]);
		expect(
			JSON.parse(callFor("/api/families/fable")[1].body as string),
		).toEqual({ combo_id: "combo-legacy", enabled: true });
	});

	it("uses explicit family scope for conversion preview and apply", async () => {
		await api.previewFamilyRouting("opus", "claude-opus-4-7");
		await api.applyFamilyRoutingProposal({
			family: "opus",
			previewId: "preview:family",
			proposalId: "proposal:family",
			managedModel: "claude-opus-4-7",
		});

		const preview = callFor("/api/routing/preview")[1];
		expect(JSON.parse(preview.body as string)).toEqual({
			scope: "family",
			family: "opus",
			managed_model: "claude-opus-4-7",
		});
		const apply = callFor("/api/routing/apply/opus")[1];
		expect(JSON.parse(apply.body as string)).toEqual({
			scope: "family",
			preview_id: "preview:family",
			proposal_id: "proposal:family",
			managed_model: "claude-opus-4-7",
		});
	});
});

describe("dashboard API log redaction", () => {
	it("does not log create credentials, OAuth material, endpoints, mappings, or sessions", async () => {
		const originalConsole = {
			debug: console.debug,
			info: console.info,
			warn: console.warn,
			error: console.error,
		};
		const entries: unknown[][] = [];
		console.debug = mock((...args: unknown[]) => entries.push(args));
		console.info = mock((...args: unknown[]) => entries.push(args));
		console.warn = mock((...args: unknown[]) => entries.push(args));
		console.error = mock((...args: unknown[]) => entries.push(args));

		try {
			await api.addOpenAIAccount({
				name: "safe-name",
				priority: 0,
				apiKey: "secret-api-key-sentinel",
				customEndpoint: "https://secret-endpoint-sentinel.example",
				modelMappings: { opus: "secret-mapping-sentinel" },
			});
			await api.completeAddAccount({
				sessionId: "secret-oauth-session-sentinel",
				code: "secret-oauth-code-sentinel",
			});
			await api.completeAnthropicReauth(
				"secret-reauth-session-sentinel",
				"secret-reauth-code-sentinel",
			);
			await api.getCodexAuthStatus("secret-codex-session-sentinel");
			await api.getQwenAuthStatus("secret-qwen-session-sentinel");
			await api.getDeviceSetupJob("secret-device-job-id-sentinel");
			await api.getRecentDeviceSetupJobs(17);
			await api.updateAccountCustomEndpoint(
				"account-safe",
				"https://secret-updated-endpoint-sentinel.example",
			);
			await api.updateAccountModelMappings("account-safe", {
				opus: "secret-updated-mapping-sentinel",
			});
		} finally {
			console.debug = originalConsole.debug;
			console.info = originalConsole.info;
			console.warn = originalConsole.warn;
			console.error = originalConsole.error;
		}

		const serialized = JSON.stringify(entries);
		for (const sentinel of [
			"secret-api-key-sentinel",
			"secret-endpoint-sentinel",
			"secret-mapping-sentinel",
			"secret-oauth-session-sentinel",
			"secret-oauth-code-sentinel",
			"secret-reauth-session-sentinel",
			"secret-reauth-code-sentinel",
			"secret-codex-session-sentinel",
			"secret-qwen-session-sentinel",
			"secret-device-job-id-sentinel",
			"secret-updated-endpoint-sentinel",
			"secret-updated-mapping-sentinel",
		]) {
			expect(serialized).not.toContain(sentinel);
		}
	});
});
