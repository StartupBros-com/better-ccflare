import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import type { ProviderModelDefaultsResponse } from "../../lib/provider-model-defaults-api";
import { queryKeys } from "../../lib/query-keys";
import { AccountModelMappingsBody } from "./AccountModelMappingsDialog";

const EMPTY_MAPPINGS = { fable: "", opus: "", sonnet: "", haiku: "" };

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-codex-1",
		name: "codex-account-1",
		provider: "codex",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date().toISOString(),
		paused: false,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		sessionStats: null,
		isPrimary: false,
		...overrides,
	};
}

function renderDialog(
	account: Account,
	response: ProviderModelDefaultsResponse,
): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(queryKeys.providerModelDefaults(), response);

	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<AccountModelMappingsBody
				account={account}
				modelMappings={EMPTY_MAPPINGS}
				onInputChange={() => {}}
			/>
		</QueryClientProvider>,
	);
}

describe("AccountModelMappingsDialog Codex per-family Automatic/Pinned status", () => {
	it("shows a Pinned status for a family sourced from the account's own mapping", () => {
		const account = makeAccount({
			modelMappings: { opus: "gpt-5.3-codex-pinned" },
		});
		const html = renderDialog(account, {
			providers: [],
			accounts: [
				{
					accountId: account.id,
					accountName: account.name,
					paused: false,
					catalog: { source: "none", fetchedAt: null, stale: false },
					families: [
						{
							family: "opus",
							effectiveModel: "gpt-5.3-codex-pinned",
							source: "account_mapping_pin",
							pinned: true,
						},
						{
							family: "fable",
							effectiveModel: "gpt-5.3-codex",
							source: "compiled_default",
							pinned: false,
						},
						{
							family: "sonnet",
							effectiveModel: "gpt-5.3-codex",
							source: "compiled_default",
							pinned: false,
						},
						{
							family: "haiku",
							effectiveModel: "gpt-5.3-codex",
							source: "compiled_default",
							pinned: false,
						},
					],
				},
			],
		});

		expect(html).toContain("Pinned — gpt-5.3-codex-pinned (account mapping)");
		expect(html).toContain(
			"Automatic — current default gpt-5.3-codex (compiled default)",
		);
	});

	it("shows an Automatic status with catalog freshness for an unmapped family", () => {
		const account = makeAccount();
		const html = renderDialog(account, {
			providers: [],
			accounts: [
				{
					accountId: account.id,
					accountName: account.name,
					paused: false,
					catalog: { source: "own", fetchedAt: Date.now(), stale: false },
					families: [
						{
							family: "opus",
							effectiveModel: "gpt-5.6-sol",
							source: "account_catalog",
							pinned: false,
						},
						{
							family: "fable",
							effectiveModel: "gpt-5.6-sol",
							source: "account_catalog",
							pinned: false,
						},
						{
							family: "sonnet",
							effectiveModel: "gpt-5.6-sol",
							source: "account_catalog",
							pinned: false,
						},
						{
							family: "haiku",
							effectiveModel: "gpt-5.6-sol",
							source: "account_catalog",
							pinned: false,
						},
					],
				},
			],
		});

		expect(html).toContain(
			"Automatic — current default gpt-5.6-sol (this account’s catalog, fresh)",
		);
	});

	it("renders nothing extra for a non-Codex account (no accounts data applies)", () => {
		const account = makeAccount({ provider: "anthropic" });
		const html = renderDialog(account, { providers: [] });

		expect(html).not.toContain("Automatic — current default");
		expect(html).not.toContain("Pinned —");
	});
});
