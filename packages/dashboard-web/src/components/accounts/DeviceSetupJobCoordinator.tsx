import type { DeviceSetupJobView } from "@better-ccflare/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import {
	deviceSetupJobsNeedPolling,
	FULL_MANAGED_ROUTING_INVALIDATION,
	invalidateManagedRouting,
	useRecentDeviceSetupJobs,
} from "../../hooks/queries";
import { queryKeys } from "../../lib/query-keys";

const SUCCESSFUL_TERMINAL_STATUSES = new Set<DeviceSetupJobView["status"]>([
	"complete",
	"complete_with_actions",
]);

export async function invalidateNewSuccessfulDeviceSetupJobs(
	queryClient: QueryClient,
	jobs: readonly DeviceSetupJobView[],
	seen: Set<string>,
): Promise<boolean> {
	const newlyCompleted = jobs.filter(
		(job) => SUCCESSFUL_TERMINAL_STATUSES.has(job.status) && !seen.has(job.id),
	);
	if (newlyCompleted.length === 0) return false;
	for (const job of newlyCompleted) seen.add(job.id);

	await Promise.all([
		invalidateManagedRouting(queryClient, FULL_MANAGED_ROUTING_INVALIDATION),
		queryClient.invalidateQueries({ queryKey: queryKeys.deviceSetupJobs() }),
	]);
	return true;
}

export function DeviceSetupJobCoordinator({
	authenticated,
}: {
	authenticated: boolean;
}) {
	const queryClient = useQueryClient();
	const completedRef = useRef(new Set<string>());
	const { data: jobs = [] } = useRecentDeviceSetupJobs(authenticated);
	const activeCount = useMemo(
		() => jobs.filter((job) => deviceSetupJobsNeedPolling([job])).length,
		[jobs],
	);

	useEffect(() => {
		void invalidateNewSuccessfulDeviceSetupJobs(
			queryClient,
			jobs,
			completedRef.current,
		);
	}, [jobs, queryClient]);

	if (!authenticated || activeCount === 0) return null;
	return (
		<div
			className="mx-4 mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100 lg:ml-68"
			role="status"
			aria-live="polite"
		>
			{activeCount === 1 ? "An account setup" : `${activeCount} account setups`}{" "}
			continues on the server. You can navigate away or close this page safely.
		</div>
	);
}
