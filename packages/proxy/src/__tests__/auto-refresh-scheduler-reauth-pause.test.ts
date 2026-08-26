/**
 * The proactive OAuth refresh paths in AutoRefreshScheduler (Qwen/xAI and
 * Codex) call provider.refreshToken() directly, bypassing the
 * refreshAccessTokenSafe chokepoint. They must also pause the account for
 * reauth on a terminal OAuth refresh failure, otherwise a revoked xAI or
 * Codex refresh token silently retries forever without ever pausing.
 */

import { describe, expect, it, mock } from "bun:test";
import { OAuthRefreshTokenError } from "@better-ccflare/core";
import { registerProvider } from "@better-ccflare/providers";

function makeDb(rows: Array<Record<string, unknown>>) {
	return {
		run: mock(async () => {}),
		runWithChanges: mock(async () => 1),
		query: mock(async () => rows.map((row) => ({ created_at: 1, ...row }))),
	};
}

function makeProxyContext(flagResult = true) {
	const currentAccount = { ...baseRow, created_at: 1 };
	const flagRequiresReauthIfTokenMatches = mock(
		async (_accountId: string, _refreshToken: string) => flagResult,
	);
	return {
		context: {
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			dbOps: {
				getAccount: mock(async (accountId: string) =>
					accountId === currentAccount.id ? currentAccount : null,
				),
				flagRequiresReauthIfTokenMatches,
			},
		},
		flagRequiresReauthIfTokenMatches,
	};
}

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
	proxyContext: ReturnType<typeof makeProxyContext>["context"],
) {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		proxyContext as never,
	) as unknown as {
		checkAndRefreshOpenAICompatibleOAuthTokens(): Promise<void>;
		checkAndRefreshCodexTokens(): Promise<void>;
	};
}

const baseRow = {
	id: "acc-oauth-proactive",
	name: "test-account",
	refresh_token: "rt-1",
	access_token: null,
	expires_at: null,
	custom_endpoint: null,
};

describe("AutoRefreshScheduler — proactive refresh pause-for-reauth", () => {
	it("pauses a qwen/xai-provider account when refreshToken throws OAuthRefreshTokenError", async () => {
		registerProvider({
			name: "test-openai-compat-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new OAuthRefreshTokenError("acc-oauth-proactive", "revoked");
			},
		} as never);

		const db = makeDb([
			{ ...baseRow, provider: "test-openai-compat-provider" },
		]);
		const { context, flagRequiresReauthIfTokenMatches } =
			makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(flagRequiresReauthIfTokenMatches).toHaveBeenCalledTimes(1);
		expect(flagRequiresReauthIfTokenMatches).toHaveBeenCalledWith(
			"acc-oauth-proactive",
			"rt-1",
			1,
		);
	});

	it("does not pause a qwen/xai-provider account on a transient refresh failure", async () => {
		registerProvider({
			name: "test-openai-compat-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new Error("fetch failed: ETIMEDOUT");
			},
		} as never);

		const db = makeDb([
			{ ...baseRow, provider: "test-openai-compat-provider" },
		]);
		const { context, flagRequiresReauthIfTokenMatches } =
			makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
	});

	it("does not pause when provider prose merely mentions invalid_grant", async () => {
		registerProvider({
			name: "test-openai-compat-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new Error(
					JSON.stringify({
						error: { message: "provider mentioned invalid_grant in prose" },
					}),
				);
			},
		} as never);

		const db = makeDb([
			{ ...baseRow, provider: "test-openai-compat-provider" },
		]);
		const { context, flagRequiresReauthIfTokenMatches } =
			makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
	});

	it("pauses on an explicit structured OAuth machine code", async () => {
		registerProvider({
			name: "test-openai-compat-provider",
			canHandle: () => true,
			refreshToken: async () => {
				const error = new Error("structured OAuth failure") as Error & {
					error: { code: string };
				};
				error.error = { code: "invalid_grant" };
				throw error;
			},
		} as never);

		const db = makeDb([
			{ ...baseRow, provider: "test-openai-compat-provider" },
		]);
		const { context, flagRequiresReauthIfTokenMatches } =
			makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(flagRequiresReauthIfTokenMatches).toHaveBeenCalledWith(
			"acc-oauth-proactive",
			"rt-1",
			1,
		);
	});

	it("pauses a codex account when refreshToken throws OAuthRefreshTokenError", async () => {
		registerProvider({
			name: "test-codex-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new OAuthRefreshTokenError("acc-oauth-proactive", "reused");
			},
		} as never);

		const db = makeDb([{ ...baseRow, provider: "test-codex-provider" }]);
		const { context, flagRequiresReauthIfTokenMatches } =
			makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshCodexTokens();

		expect(flagRequiresReauthIfTokenMatches).toHaveBeenCalledTimes(1);
		expect(flagRequiresReauthIfTokenMatches).toHaveBeenCalledWith(
			"acc-oauth-proactive",
			"rt-1",
			1,
		);
	});

	it("does not pause a codex account on a transient refresh failure", async () => {
		registerProvider({
			name: "test-codex-provider",
			canHandle: () => true,
			refreshToken: async () => {
				throw new Error("fetch failed: ETIMEDOUT");
			},
		} as never);

		const db = makeDb([{ ...baseRow, provider: "test-codex-provider" }]);
		const { context, flagRequiresReauthIfTokenMatches } =
			makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshCodexTokens();

		expect(flagRequiresReauthIfTokenMatches).not.toHaveBeenCalled();
	});
});
