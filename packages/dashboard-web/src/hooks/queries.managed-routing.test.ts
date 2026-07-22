import { describe, expect, it, mock } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/query-keys";
import {
	ACCOUNT_ROUTING_INVALIDATION,
	ACCOUNTS_ONLY_INVALIDATION,
	deviceSetupJobsNeedPolling,
	FULL_MANAGED_ROUTING_INVALIDATION,
	getAccountRoutingOverviewQueryOptions,
	getApplyFamilyRoutingProposalMutationOptions,
	getApplyRoutingProposalMutationOptions,
	getDeviceSetupJobQueryOptions,
	getExcludeAccountFromFamilyMutationOptions,
	getForceResetRateLimitMutationOptions,
	getPauseAccountMutationOptions,
	getPreviewFamilyRoutingMutationOptions,
	getRecentDeviceSetupJobsQueryOptions,
	getRefreshUsageMutationOptions,
	getRestoreAccountToFamilyMutationOptions,
	getResumeAccountMutationOptions,
	getRoutingPreviewMutationOptions,
	getUpdateAccountAutoRefreshMutationOptions,
	getUpdateAccountBillingTypeMutationOptions,
	getUpdateAccountCustomEndpointMutationOptions,
	getUpdateAccountModelMappingsMutationOptions,
	getUpdateAccountPriorityMutationOptions,
	getUpdateFamilyPolicyMutationOptions,
	invalidateManagedRouting,
	ROUTING_CONFIGURATION_INVALIDATION,
} from "./queries";

function createQueryClientSpy() {
	const invalidateQueries = mock(async () => undefined);
	return {
		queryClient: { invalidateQueries } as unknown as QueryClient,
		invalidateQueries,
	};
}

function invalidatedKeys(invalidateQueries: ReturnType<typeof mock>) {
	return invalidateQueries.mock.calls.map(([filters]) => filters.queryKey);
}

describe("managed-routing query keys", () => {
	it("keeps effective routing and the account overview under stable roots", () => {
		expect(queryKeys.routingEffective()).toEqual([
			"better-ccflare",
			"routing",
			"effective",
		]);
		expect(queryKeys.routingEffective("opus")).toEqual([
			"better-ccflare",
			"routing",
			"effective",
			"opus",
		]);
		expect(queryKeys.accountRoutingOverview()).toEqual([
			"better-ccflare",
			"routing",
			"accounts",
		]);
		expect(getAccountRoutingOverviewQueryOptions().queryKey).toEqual(
			queryKeys.accountRoutingOverview(),
		);
	});

	it("keeps durable job list and details below one invalidation root", () => {
		expect(queryKeys.deviceSetupJobs()).toEqual([
			"better-ccflare",
			"device-setup",
			"jobs",
		]);
		expect(queryKeys.deviceSetupJobsRecent()).toEqual([
			...queryKeys.deviceSetupJobs(),
			"recent",
		]);
		expect(queryKeys.deviceSetupJob("opaque/job")).toEqual([
			...queryKeys.deviceSetupJobs(),
			"opaque/job",
		]);
		expect(getRecentDeviceSetupJobsQueryOptions(true).queryKey).toEqual(
			queryKeys.deviceSetupJobsRecent(),
		);
		expect(getDeviceSetupJobQueryOptions("opaque/job").queryKey).toEqual(
			queryKeys.deviceSetupJob("opaque/job"),
		);
	});

	it("polls authenticated recent jobs only while server work is active", () => {
		const awaiting = { status: "awaiting_authorization" as const };
		const reconciling = { status: "reconciling" as const };
		const complete = { status: "complete" as const };
		const expired = { status: "expired" as const };

		expect(deviceSetupJobsNeedPolling([awaiting])).toBe(true);
		expect(deviceSetupJobsNeedPolling([complete, reconciling])).toBe(true);
		expect(deviceSetupJobsNeedPolling([complete, expired])).toBe(false);
		expect(getRecentDeviceSetupJobsQueryOptions(false).enabled).toBe(false);
		expect(getRecentDeviceSetupJobsQueryOptions(true).enabled).toBe(true);
	});
});

describe("invalidateManagedRouting", () => {
	it("invalidates the exact full managed-routing matrix", async () => {
		const { queryClient, invalidateQueries } = createQueryClientSpy();

		await invalidateManagedRouting(
			queryClient,
			FULL_MANAGED_ROUTING_INVALIDATION,
		);

		expect(invalidatedKeys(invalidateQueries)).toEqual([
			queryKeys.accounts(),
			queryKeys.families(),
			queryKeys.combos(),
			queryKeys.routingEffective(),
			queryKeys.accountRoutingOverview(),
		]);
	});

	it("invalidates account state, effective routing, and the account overview", async () => {
		const { queryClient, invalidateQueries } = createQueryClientSpy();

		await invalidateManagedRouting(queryClient, ACCOUNT_ROUTING_INVALIDATION);

		expect(invalidatedKeys(invalidateQueries)).toEqual([
			queryKeys.accounts(),
			queryKeys.routingEffective(),
			queryKeys.accountRoutingOverview(),
		]);
	});

	it("invalidates routing configuration without refetching account records", async () => {
		const { queryClient, invalidateQueries } = createQueryClientSpy();

		await invalidateManagedRouting(
			queryClient,
			ROUTING_CONFIGURATION_INVALIDATION,
		);

		expect(invalidatedKeys(invalidateQueries)).toEqual([
			queryKeys.families(),
			queryKeys.combos(),
			queryKeys.routingEffective(),
			queryKeys.accountRoutingOverview(),
		]);
	});

	it("keeps auto-refresh-only mutations accounts-only", async () => {
		const { queryClient, invalidateQueries } = createQueryClientSpy();

		await invalidateManagedRouting(queryClient, ACCOUNTS_ONLY_INVALIDATION);

		expect(invalidatedKeys(invalidateQueries)).toEqual([queryKeys.accounts()]);
	});

	it("honors a focused caller-selected invalidation scope", async () => {
		const { queryClient, invalidateQueries } = createQueryClientSpy();

		await invalidateManagedRouting(queryClient, {
			families: true,
			effective: true,
		});

		expect(invalidatedKeys(invalidateQueries)).toEqual([
			queryKeys.families(),
			queryKeys.routingEffective(),
		]);
	});
});

describe("routing preview mutation", () => {
	it("does not invalidate any server state", () => {
		const options = getRoutingPreviewMutationOptions();

		expect(options).toHaveProperty("mutationFn");
		expect(options).not.toHaveProperty("onSuccess");
		expect(options).not.toHaveProperty("onSettled");
	});

	it("keeps family conversion preview read-only", () => {
		const options = getPreviewFamilyRoutingMutationOptions();

		expect(options).toHaveProperty("mutationFn");
		expect(options).not.toHaveProperty("onSuccess");
		expect(options).not.toHaveProperty("onSettled");
	});
});

describe("family routing mutation invalidation", () => {
	const routingConfigurationKeys = [
		queryKeys.families(),
		queryKeys.combos(),
		queryKeys.routingEffective(),
		queryKeys.accountRoutingOverview(),
	];

	for (const [name, getOptions] of [
		["family policy", getUpdateFamilyPolicyMutationOptions],
		["account proposal apply", getApplyRoutingProposalMutationOptions],
		["family proposal apply", getApplyFamilyRoutingProposalMutationOptions],
		["family exclusion", getExcludeAccountFromFamilyMutationOptions],
		["family restore", getRestoreAccountToFamilyMutationOptions],
	] as const) {
		it(`${name} refreshes routing configuration without account records or device jobs`, async () => {
			const { queryClient, invalidateQueries } = createQueryClientSpy();
			const options = getOptions(queryClient);

			await options.onSuccess();

			expect(invalidatedKeys(invalidateQueries)).toEqual(
				routingConfigurationKeys,
			);
			expect(invalidatedKeys(invalidateQueries)).not.toContainEqual(
				queryKeys.accounts(),
			);
			expect(invalidatedKeys(invalidateQueries)).not.toContainEqual(
				queryKeys.deviceSetupJobs(),
			);
		});
	}
});

describe("usage-state mutation invalidation", () => {
	for (const [name, getOptions] of [
		["force reset rate limit", getForceResetRateLimitMutationOptions],
		["refresh usage", getRefreshUsageMutationOptions],
	] as const) {
		it(`${name} refreshes accounts and authoritative routing views`, async () => {
			const { queryClient, invalidateQueries } = createQueryClientSpy();
			const options = getOptions(queryClient);

			await options.onSuccess();

			expect(invalidatedKeys(invalidateQueries)).toEqual([
				queryKeys.accounts(),
				queryKeys.routingEffective(),
				queryKeys.accountRoutingOverview(),
			]);
		});
	}
});

describe("canonical account mutation invalidation", () => {
	const accountRoutingKeys = [
		queryKeys.accounts(),
		queryKeys.routingEffective(),
		queryKeys.accountRoutingOverview(),
	];
	const fullRoutingKeys = [
		queryKeys.accounts(),
		queryKeys.families(),
		queryKeys.combos(),
		queryKeys.routingEffective(),
		queryKeys.accountRoutingOverview(),
	];

	for (const [name, getOptions, expectedKeys] of [
		["pause", getPauseAccountMutationOptions, accountRoutingKeys],
		["resume", getResumeAccountMutationOptions, accountRoutingKeys],
		["priority", getUpdateAccountPriorityMutationOptions, fullRoutingKeys],
		[
			"auto refresh",
			getUpdateAccountAutoRefreshMutationOptions,
			[queryKeys.accounts()],
		],
		["billing", getUpdateAccountBillingTypeMutationOptions, fullRoutingKeys],
		[
			"custom endpoint",
			getUpdateAccountCustomEndpointMutationOptions,
			fullRoutingKeys,
		],
		[
			"model mappings",
			getUpdateAccountModelMappingsMutationOptions,
			fullRoutingKeys,
		],
	] as const) {
		it(`${name} uses its exact managed-routing invalidation scope`, async () => {
			const { queryClient, invalidateQueries } = createQueryClientSpy();
			const options = getOptions(queryClient);

			await options.onSuccess();

			expect(invalidatedKeys(invalidateQueries)).toEqual([...expectedKeys]);
		});
	}
});

describe("query test module isolation", () => {
	it("leaves shared API, core, React Query, and React exports intact", async () => {
		const [{ api }, core, reactQuery, react] = await Promise.all([
			import("../api"),
			import("@better-ccflare/core"),
			import("@tanstack/react-query"),
			import("react"),
		]);

		expect(api.getAccounts).toBeFunction();
		expect(core.getModelDisplayName).toBeFunction();
		expect(reactQuery.QueryClient).toBeFunction();
		expect(react.version).toBeString();
	});
});
