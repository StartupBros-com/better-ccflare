import { describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { PromptAdapter } from "../../prompts";

mock.module("@better-ccflare/database", () => ({
	DatabaseOperations: class DatabaseOperations {},
	DatabaseFactory: class DatabaseFactory {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

let oauthCompletionSequence = 0;
const oauthBegin = mock(
	async ({ mode }: { mode: "claude-oauth" | "console" }) => ({
		sessionId: `session-${mode}`,
		authUrl: "https://oauth.example.test/authorize",
		pkce: { verifier: "verifier", challenge: "challenge" },
		oauthConfig: {},
		mode,
	}),
);
const oauthComplete = mock(
	async (
		{ name }: { name: string },
		flow: { mode: "claude-oauth" | "console" },
	) => ({
		id: `oauth-created-${++oauthCompletionSequence}`,
		name,
		provider:
			flow.mode === "console"
				? ("claude-console-api" as const)
				: ("anthropic" as const),
		authType:
			flow.mode === "console" ? ("api_key" as const) : ("oauth" as const),
	}),
);

mock.module("@better-ccflare/oauth-flow", () => ({
	createOAuthFlow: async () => ({ begin: oauthBegin, complete: oauthComplete }),
}));

mock.module("../../utils/browser", () => ({
	openBrowser: async () => true,
}));

const { addAccount, createNanoGPTAccount } = await import("../account");
type CreatedAccountIdentity = import("../account").CreatedAccountIdentity;

function captureOnlyDatabase() {
	const inserts: unknown[][] = [];
	const run = mock(async (_sql: string, params: unknown[]) => {
		inserts.push([...params]);
	});
	const getAllAccounts = mock(async () => {
		throw new Error("account creation must not rediscover identity by listing");
	});
	const dbOps = {
		getAdapter: () => ({ run }),
		getAllAccounts,
	} as unknown as DatabaseOperations;

	return { dbOps, getAllAccounts, inserts };
}

const nanogptAdapter: PromptAdapter = {
	async select(_question, options) {
		return (options.find(({ value }) => value === "no") ?? options[0]).value;
	},
	async input(question) {
		return question.includes("NanoGPT API key") ? "test-api-key" : "";
	},
	async confirm() {
		return true;
	},
};

const directConsoleAdapter: PromptAdapter = {
	async select(question, options) {
		if (question.includes("set up your Console account")) return "apikey";
		return (options.find(({ value }) => value === "no") ?? options[0]).value;
	},
	async input() {
		return "console-api-key";
	},
	async confirm() {
		return true;
	},
};

const oauthAdapter: PromptAdapter = {
	async select(question, options) {
		if (question.includes("set up your Console account")) return "oauth";
		return (options.find(({ value }) => value === "no") ?? options[0]).value;
	},
	async input() {
		return "authorization-code";
	},
	async confirm() {
		return true;
	},
};

describe("created account identity", () => {
	it("returns each direct creator's generated ID without duplicate-name lookup", async () => {
		const { dbOps, getAllAccounts, inserts } = captureOnlyDatabase();

		const first = await createNanoGPTAccount(
			dbOps,
			"duplicate-name",
			"first-api-key",
			1,
		);
		const second = await createNanoGPTAccount(
			dbOps,
			"duplicate-name",
			"second-api-key",
			2,
		);

		expect(first).toEqual({
			id: inserts[0][0],
			name: "duplicate-name",
			provider: "nanogpt",
		});
		expect(second).toEqual({
			id: inserts[1][0],
			name: "duplicate-name",
			provider: "nanogpt",
		});
		expect(first.id).not.toBe(second.id);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(second)).toBe(true);
		expect(getAllAccounts).not.toHaveBeenCalled();
	});

	it("returns the direct creator identity through addAccount", async () => {
		const { dbOps, getAllAccounts, inserts } = captureOnlyDatabase();

		const created = await addAccount(dbOps, {} as Config, {
			name: "direct-through-add",
			mode: "nanogpt",
			priority: 4,
			adapter: nanogptAdapter,
		});

		expect(created).toEqual({
			id: inserts[0][0],
			name: "direct-through-add",
			provider: "nanogpt",
		});
		expect(getAllAccounts).not.toHaveBeenCalled();
	});

	it("returns the direct Console API-key identity from its early branch", async () => {
		const { dbOps, getAllAccounts, inserts } = captureOnlyDatabase();

		const created = await addAccount(dbOps, {} as Config, {
			name: "console-direct",
			mode: "console",
			priority: 3,
			adapter: directConsoleAdapter,
		});

		expect(created).toEqual({
			id: inserts[0][0],
			name: "console-direct",
			provider: "claude-console-api",
		});
		expect(getAllAccounts).not.toHaveBeenCalled();
	});

	it("preserves exact Claude and Console OAuth completion identities", async () => {
		const { dbOps, getAllAccounts } = captureOnlyDatabase();

		const claude = await addAccount(dbOps, {} as Config, {
			name: "duplicate-oauth-name",
			mode: "claude-oauth",
			priority: 5,
			adapter: oauthAdapter,
		});
		const consoleAccount = await addAccount(dbOps, {} as Config, {
			name: "duplicate-oauth-name",
			mode: "console",
			priority: 6,
			adapter: oauthAdapter,
		});

		expect(claude).toEqual({
			id: "oauth-created-1",
			name: "duplicate-oauth-name",
			provider: "anthropic",
		});
		expect(consoleAccount).toEqual({
			id: "oauth-created-2",
			name: "duplicate-oauth-name",
			provider: "claude-console-api",
		});
		expect(Object.keys(claude).sort()).toEqual(["id", "name", "provider"]);
		expect(Object.isFrozen(claude)).toBe(true);
		expect(Object.isFrozen(consoleAccount)).toBe(true);
		expect(oauthComplete).toHaveBeenCalledTimes(2);
		expect(getAllAccounts).not.toHaveBeenCalled();
	});

	it("exposes addAccount's exact immutable return contract", () => {
		const contract: (
			...args: Parameters<typeof addAccount>
		) => Promise<CreatedAccountIdentity> = addAccount;

		expect(contract).toBe(addAccount);
	});
});
