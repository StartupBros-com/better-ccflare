import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";

// Account command imports the provider barrel, whose Bedrock error helper has
// runtime database imports. This focused unit test never exercises that helper.
mock.module("@better-ccflare/database", () => ({
	DatabaseFactory: class DatabaseFactory {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

mock.module("../../utils/browser", () => ({
	openBrowser: async () => true,
}));

mock.module("../../prompts/index", () => ({
	promptAccountRemovalConfirmation: async () => true,
	stdPromptAdapter: {
		select: async () => "claude-oauth",
		input: async () => "authorization-code#state",
		confirm: async () => true,
	},
}));

const { reauthenticateAccount } = await import("../account");

const config = {
	getRuntime: () => ({ clientId: "test-client-id" }),
} as Config;

type AnthropicMode = "oauth" | "console";

interface AccountState {
	id: string;
	name: string;
	provider: "anthropic";
	priority: number;
	custom_endpoint: null;
	api_key: string | null;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	requires_reauth: number;
	paused: number;
	pause_reason: string | null;
}

describe("CLI Anthropic account re-authentication", () => {
	let dbOps: DatabaseOperations;
	let account: AccountState;
	let resumeCalls: number;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		resumeCalls = 0;
		const adapter = {
			get: async (_sql: string, params: unknown[]) => {
				if (params[0] !== account.name) return null;
				return account;
			},
			run: async (sql: string, params: unknown[]) => {
				if (sql.includes("api_key = ?")) {
					account.api_key = params[0] as string;
					account.refresh_token = params[1] as string;
					account.access_token = null;
					account.expires_at = null;
					account.requires_reauth = 0;
					return;
				}
				if (sql.includes("refresh_token = ?")) {
					account.refresh_token = params[0] as string;
					account.access_token = params[1] as string;
					account.expires_at = params[2] as number;
					account.requires_reauth = 0;
					return;
				}
				throw new Error(`Unexpected SQL in Anthropic CLI reauth test: ${sql}`);
			},
		};
		dbOps = {
			getAdapter: () => adapter,
			getAllAccounts: async () => [],
			getActiveApiKeys: async () => [],
			resumeAccountIfNeedsReauth: async () => {
				resumeCalls++;
				if (
					account.paused === 1 &&
					account.pause_reason === "oauth_invalid_grant"
				) {
					account.paused = 0;
					account.pause_reason = null;
					return true;
				}
				return false;
			},
		} as unknown as DatabaseOperations;

		originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://platform.claude.com/v1/oauth/token") {
				return Response.json({
					refresh_token: "refresh-token-reauth",
					access_token: "access-token-reauth",
					expires_in: 3600,
				});
			}
			if (
				url === "https://api.anthropic.com/api/oauth/claude_cli/create_api_key"
			) {
				return Response.json({ raw_key: "api-key-reauth" });
			}
			if (url.startsWith("http://localhost:")) {
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected fetch in Anthropic CLI reauth test: ${url}`);
		};
	});

	afterEach(async () => {
		// showSuccessMessage notifies local servers without awaiting the task.
		// Let the immediate mocked fetches settle before disposing the database.
		await new Promise((resolve) => setTimeout(resolve, 0));
		globalThis.fetch = originalFetch;
	});

	for (const mode of ["oauth", "console"] as const) {
		it(`guarded-resumes an oauth_invalid_grant pause after ${mode} credential replacement`, async () => {
			const name = `anthropic-${mode}-terminal`;
			await insertAnthropicAccount(name, mode, "oauth_invalid_grant");

			const result = await reauthenticateAccount(dbOps, config, name);

			expect(result.success).toBe(true);
			const account = readAccount(name);
			expect(account?.requires_reauth).toBe(0);
			expect(account?.paused).toBe(0);
			expect(account?.pause_reason).toBeNull();
			expect(resumeCalls).toBe(1);
			assertCredentialsReplaced(account, mode);
		});

		for (const pauseReason of ["manual", "overage"] as const) {
			it(`preserves a ${pauseReason} pause after ${mode} credential replacement`, async () => {
				const name = `anthropic-${mode}-${pauseReason}`;
				await insertAnthropicAccount(name, mode, pauseReason);

				const result = await reauthenticateAccount(dbOps, config, name);

				expect(result.success).toBe(true);
				const account = readAccount(name);
				expect(account?.requires_reauth).toBe(0);
				expect(account?.paused).toBe(1);
				expect(account?.pause_reason).toBe(pauseReason);
				expect(resumeCalls).toBe(1);
				assertCredentialsReplaced(account, mode);
			});
		}
	}

	async function insertAnthropicAccount(
		name: string,
		mode: AnthropicMode,
		pauseReason: "oauth_invalid_grant" | "manual" | "overage",
	): Promise<void> {
		account = {
			id: crypto.randomUUID(),
			name,
			provider: "anthropic",
			priority: 10,
			custom_endpoint: null,
			api_key: mode === "console" ? "api-key-original" : null,
			refresh_token: "refresh-token-original",
			access_token: mode === "oauth" ? "access-token-original" : null,
			expires_at: mode === "oauth" ? Date.now() + 60_000 : null,
			requires_reauth: 1,
			paused: 1,
			pause_reason: pauseReason,
		};
	}

	function readAccount(name: string): AccountState | undefined {
		return account.name === name ? account : undefined;
	}

	function assertCredentialsReplaced(
		account: ReturnType<typeof readAccount>,
		mode: AnthropicMode,
	): void {
		expect(account).toBeDefined();
		if (mode === "oauth") {
			expect(account?.api_key).toBeNull();
			expect(account?.access_token).toBe("access-token-reauth");
			expect(account?.refresh_token).toBe("refresh-token-reauth");
		} else {
			expect(account?.api_key).toBe("api-key-reauth");
			expect(account?.access_token).toBeNull();
			expect(account?.refresh_token).toBe("api-key-reauth");
		}
	}
});
