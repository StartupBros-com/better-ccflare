import { describe, expect, it, mock } from "bun:test";
import type {
	AccountRoutingOverview,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../api";
import { getAccountRoutingOverviewQueryOptions } from "../hooks/queries";
import { queryKeys } from "../lib/query-keys";
import {
	AccountsTab,
	buildRoutingByAccountId,
	createAccountCreationCallbacks,
} from "./AccountsTab";

const creationMethodNames = [
	"completeAddAccount",
	"addVertexAIAccount",
	"addBedrockAccount",
	"addZaiAccount",
	"addMinimaxAccount",
	"addNanoGPTAccount",
	"addAlibabaCodingPlanAccount",
	"addKiloAccount",
	"addOpenRouterAccount",
	"addAnthropicCompatibleAccount",
	"addOpenAIAccount",
	"addOllamaAccount",
	"addOllamaCloudAccount",
] as const;

const creationCallbackNames = [
	"onCompleteAccount",
	"onAddVertexAIAccount",
	"onAddBedrockAccount",
	"onAddZaiAccount",
	"onAddMinimaxAccount",
	"onAddNanoGPTAccount",
	"onAddAlibabaCodingPlanAccount",
	"onAddKiloAccount",
	"onAddOpenRouterAccount",
	"onAddAnthropicCompatibleAccount",
	"onAddOpenAIAccount",
	"onAddOllamaAccount",
	"onAddOllamaCloudAccount",
] as const;

function routingView(
	accountId: string,
	overrides: Partial<EffectiveComboRoutingView> = {},
): EffectiveComboRoutingView {
	return {
		family: "opus",
		policy: {
			family: "opus",
			combo: {
				id: "combo-opus",
				name: "Opus priority",
			},
		},
		resolution: {
			active: true,
			members: [
				{
					id: "member-opus",
					account_id: accountId,
					account_name: "duplicate-name",
					source: "managed",
					tier: 0,
					logical_model: "claude-opus-latest",
					reason: "included",
					availability: { available: true, reason: "available" },
					identity_provisional: false,
					rule_id: "rule-opus",
				},
			],
			decisions: [],
		},
		...overrides,
	} as EffectiveComboRoutingView;
}

function routingOverview(
	effective: EffectiveComboRoutingView[],
	opportunities: AccountRoutingOverview["opportunities"] = [],
): AccountRoutingOverview {
	return { effective, opportunities };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-stable-id",
		name: "duplicate-name",
		provider: "anthropic",
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

describe("AccountsTab account creation identity", () => {
	it("returns the exact immutable API accountId from all 13 creation callbacks", async () => {
		const calls: string[] = [];
		const client = Object.fromEntries(
			creationMethodNames.map((methodName, index) => [
				methodName,
				mock(async () => {
					calls.push(methodName);
					return { accountId: `server-id-${index}` };
				}),
			]),
		) as unknown as Parameters<typeof createAccountCreationCallbacks>[0];
		const afterCreate = mock(async () => undefined);
		const callbacks = createAccountCreationCallbacks(client, afterCreate);

		const identities = [];
		for (const callbackName of creationCallbackNames) {
			const callback = callbacks[callbackName] as (
				params: never,
			) => Promise<{ accountId: string }>;
			identities.push(await callback(undefined as never));
		}

		expect(Object.keys(callbacks)).toEqual([...creationCallbackNames]);
		expect(calls).toEqual([...creationMethodNames]);
		expect(afterCreate).toHaveBeenCalledTimes(13);
		expect(identities).toEqual(
			creationMethodNames.map((_, index) => ({
				accountId: `server-id-${index}`,
			})),
		);
	});

	it("preserves the created identity when post-create invalidation fails", async () => {
		const refreshError = new Error("routing cache refresh failed");
		const client = Object.fromEntries(
			creationMethodNames.map((methodName) => [
				methodName,
				mock(async () => ({ accountId: "created-on-server" })),
			]),
		) as unknown as Parameters<typeof createAccountCreationCallbacks>[0];
		const afterCreate = mock(async () => {
			throw refreshError;
		});
		const onError = mock(() => undefined);
		const callbacks = createAccountCreationCallbacks(
			client,
			afterCreate,
			onError,
		);

		const identity = await callbacks.onAddZaiAccount(undefined as never);

		expect(identity).toEqual({ accountId: "created-on-server" });
		expect(onError).toHaveBeenCalledWith(refreshError);
	});

	it("rejects an API creation failure and does not run post-create invalidation", async () => {
		const creationError = new Error("account creation failed");
		const client = Object.fromEntries(
			creationMethodNames.map((methodName) => [
				methodName,
				mock(async () => {
					if (methodName === "addZaiAccount") throw creationError;
					return { accountId: "unused" };
				}),
			]),
		) as unknown as Parameters<typeof createAccountCreationCallbacks>[0];
		const afterCreate = mock(async () => undefined);
		const onError = mock(() => undefined);
		const callbacks = createAccountCreationCallbacks(
			client,
			afterCreate,
			onError,
		);

		expect(callbacks.onAddZaiAccount(undefined as never)).rejects.toThrow(
			"account creation failed",
		);
		expect(afterCreate).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(creationError);
	});
});

describe("account routing overview query", () => {
	it("uses one overview query for ten account cards", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const accounts = Array.from({ length: 10 }, (_, index) =>
			makeAccount({ id: `account-${index}`, name: `Account ${index}` }),
		);
		queryClient.setQueryData(queryKeys.accounts(), accounts);
		queryClient.setQueryData(
			queryKeys.accountRoutingOverview(),
			routingOverview([routingView(accounts[0]?.id ?? "account-0")]),
		);

		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);

		const routingQueryKeys = queryClient
			.getQueryCache()
			.getAll()
			.map((query) => query.queryKey)
			.filter(
				(queryKey) =>
					queryKey[0] === "better-ccflare" && queryKey[1] === "routing",
			);
		expect(routingQueryKeys).toEqual([queryKeys.accountRoutingOverview()]);
		expect(getAccountRoutingOverviewQueryOptions().queryKey).toEqual(
			queryKeys.accountRoutingOverview(),
		);
	});

	it("projects current members only from effective state and opportunities only as warnings", () => {
		const currentMemberId = "current-member";
		const outsideId = "outside-account";
		const result = buildRoutingByAccountId(
			[currentMemberId, outsideId],
			routingOverview(
				[routingView(currentMemberId)],
				[
					{
						account_id: outsideId,
						family: "opus",
						proposal_id: "proposal-opus",
						combo_id: "combo-opus",
						managed_model: "claude-opus-latest",
						tier_source: "account_priority",
						reason: "included",
					},
				],
			),
		);

		expect(result[currentMemberId]?.[0]).toMatchObject({
			membershipLabel: "Managed",
			managedRouteAvailable: false,
		});
		expect(result[outsideId]?.[0]).toMatchObject({
			membershipLabel: null,
			managedRouteAvailable: true,
		});
	});

	it("matches an outside opportunity by the exact immutable account ID", () => {
		const exactId = "acct:opaque/Δ-01";
		const lookalikeId = "acct:opaque/Δ-010";
		const current = routingView("another-account", {
			resolution: {
				family: "opus",
				combo_id: "combo-opus",
				active: true,
				reason: null,
				members: [],
				decisions: [],
			},
		});
		const result = buildRoutingByAccountId(
			[exactId, lookalikeId],
			routingOverview(
				[current],
				[
					{
						account_id: exactId,
						family: "opus",
						proposal_id: "proposal-opus",
						combo_id: "combo-opus",
						managed_model: "claude-opus-latest",
						tier_source: "account_priority",
						reason: "included",
					},
				],
			),
		);

		expect(result[exactId]?.[0]).toMatchObject({
			membershipLabel: null,
			managedRouteAvailable: true,
		});
		expect(result[lookalikeId]).toEqual([]);
	});
});

describe("AccountsTab production routing prop", () => {
	it("renders AccountList family routing from the overview cache", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const account = makeAccount();
		queryClient.setQueryData(queryKeys.accounts(), [account]);
		queryClient.setQueryData(
			queryKeys.accountRoutingOverview(),
			routingOverview([routingView(account.id)]),
		);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);

		expect(html).toContain("Family routing");
		expect(html).toContain(">Opus<");
		expect(html).toContain("Managed");
	});
});
