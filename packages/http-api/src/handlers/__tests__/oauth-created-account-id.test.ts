import { describe, expect, it, mock } from "bun:test";

const createdAnthropicId = "anthropic-created-id";
const complete = mock(async () => ({
	id: createdAnthropicId,
	name: "new-anthropic",
	provider: "anthropic" as const,
	authType: "oauth" as const,
}));

mock.module("@better-ccflare/oauth-flow", () => ({
	createOAuthFlow: async () => ({ complete }),
}));
mock.module("@better-ccflare/providers", () => ({
	getOAuthProvider: () => ({ getOAuthConfig: () => ({ clientId: "test" }) }),
}));
mock.module("@better-ccflare/providers/qwen", () => ({
	initiateDeviceFlow: async () => ({
		deviceCode: "device",
		userCode: "code",
		verificationUri: "https://example.test/qwen",
		verificationUriComplete: null,
		interval: 1,
		pkce: { verifier: "verifier", challenge: "challenge" },
	}),
	pollForToken: async () => ({
		access_token: "secret-access",
		refresh_token: "secret-refresh",
		expires_in: 3600,
	}),
}));
mock.module("@better-ccflare/providers/codex", () => ({
	initiateCodexDeviceFlow: async () => ({
		deviceAuthId: "device",
		userCode: "code",
		verificationUrl: "https://example.test/codex",
		interval: 1,
	}),
	pollCodexForToken: async () => ({
		access_token: "secret-access",
		refresh_token: "secret-refresh",
		expires_in: 3600,
	}),
}));
mock.module("@better-ccflare/proxy", () => ({
	clearAccountRefreshCache: () => {},
}));

async function handlers() {
	return await import("../oauth");
}

function fakeDb() {
	const insertedIds: string[] = [];
	return {
		insertedIds,
		dbOps: {
			getAdapter: () => ({
				run: async (_sql: string, params: unknown[]) => {
					insertedIds.push(String(params[0]));
				},
			}),
			getOAuthSession: async () => ({
				accountName: "new-anthropic",
				verifier: "verifier",
				mode: "claude-oauth",
				customEndpoint: undefined,
				priority: 0,
			}),
			deleteOAuthSession: () => {},
		},
	};
}

async function waitForComplete(
	status: (sessionId: string) => Response,
	sessionId: string,
): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const body = (await status(sessionId).json()) as Record<string, unknown>;
		if (body.status === "complete") return body;
		await Bun.sleep(1);
	}
	throw new Error("device flow did not complete");
}

describe("account creation identity responses", () => {
	it("preserves OAuthFlow AccountCreated identity at the Anthropic callback", async () => {
		const { createOAuthCallbackHandler } = await handlers();
		const { dbOps } = fakeDb();
		const response = await createOAuthCallbackHandler(dbOps as never)(
			new Request("http://localhost/api/oauth/callback", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: "00000000-0000-0000-0000-000000000001",
					code: "authorization-code",
				}),
			}),
		);
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			accountId: createdAnthropicId,
		});
		expect(JSON.stringify(body)).not.toContain("secret-");
	});

	for (const provider of ["qwen", "codex"] as const) {
		it(`returns the immutable ${provider} accountId from terminal device status`, async () => {
			const module = await handlers();
			const { dbOps, insertedIds } = fakeDb();
			const init =
				provider === "qwen"
					? module.createQwenDeviceFlowInitHandler(dbOps as never)
					: module.createCodexDeviceFlowInitHandler(dbOps as never);
			const status =
				provider === "qwen"
					? module.createQwenDeviceFlowStatusHandler()
					: module.createCodexDeviceFlowStatusHandler();
			const started = await init(
				new Request(`http://localhost/api/oauth/${provider}/init`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: `${provider}-new`, priority: 0 }),
				}),
			);
			const sessionId = (await started.json()).sessionId as string;
			const completeStatus = await waitForComplete(status, sessionId);
			expect(completeStatus).toMatchObject({
				status: "complete",
				accountId: insertedIds[0],
			});
			expect(JSON.stringify(completeStatus)).not.toContain("secret-");
		});
	}
});
