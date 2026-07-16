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
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

function makeDb(rows: Array<Record<string, unknown>>) {
	return {
		run: mock(async () => {}),
		runWithChanges: mock(async () => 1),
		query: mock(async () => rows),
	};
}

function makeProxyContext(pauseResult = true) {
	const pauseAccountIfActive = mock(async () => pauseResult);
	return {
		context: {
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			dbOps: { pauseAccountIfActive },
		},
		pauseAccountIfActive,
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
	) as AutoRefreshScheduler & {
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
		const { context, pauseAccountIfActive } = makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(pauseAccountIfActive).toHaveBeenCalledTimes(1);
		expect(pauseAccountIfActive.mock.calls[0][0]).toBe("acc-oauth-proactive");
		expect(pauseAccountIfActive.mock.calls[0][1]).toBe("oauth_invalid_grant");
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
		const { context, pauseAccountIfActive } = makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshOpenAICompatibleOAuthTokens();

		expect(pauseAccountIfActive).not.toHaveBeenCalled();
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
		const { context, pauseAccountIfActive } = makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshCodexTokens();

		expect(pauseAccountIfActive).toHaveBeenCalledTimes(1);
		expect(pauseAccountIfActive.mock.calls[0][0]).toBe("acc-oauth-proactive");
		expect(pauseAccountIfActive.mock.calls[0][1]).toBe("oauth_invalid_grant");
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
		const { context, pauseAccountIfActive } = makeProxyContext(true);
		const scheduler = await makeScheduler(db, context);

		await scheduler.checkAndRefreshCodexTokens();

		expect(pauseAccountIfActive).not.toHaveBeenCalled();
	});
});
