import { describe, expect, it, mock } from "bun:test";
import type { DeviceSetupJobView } from "@better-ccflare/types";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query-keys";
import { invalidateNewSuccessfulDeviceSetupJobs } from "./DeviceSetupJobCoordinator";

function job(
	status: DeviceSetupJobView["status"],
	id: string,
): DeviceSetupJobView {
	return {
		id,
		provider: "codex",
		accountId:
			status === "complete" || status === "complete_with_actions"
				? `account-for-${id}`
				: null,
		status,
		routingOutcomes: [],
		errorCode:
			status === "expired"
				? "authorization_expired"
				: status === "authorization_error"
					? "authorization_failed"
					: null,
		errorMessage:
			status === "expired"
				? "Authorization expired"
				: status === "authorization_error"
					? "Authorization failed"
					: null,
		createdAt: 1,
		updatedAt: 2,
		terminalAt:
			status === "complete" ||
			status === "complete_with_actions" ||
			status === "expired" ||
			status === "authorization_error"
				? 2
				: null,
	};
}

describe("DeviceSetupJobCoordinator", () => {
	it("invalidates full managed routing and the job root once per new success batch", async () => {
		const invalidateQueries = mock(async (_filters: unknown) => undefined);
		const queryClient = { invalidateQueries } as unknown as QueryClient;
		const seen = new Set<string>();

		expect(
			await invalidateNewSuccessfulDeviceSetupJobs(
				queryClient,
				[job("authorization_error", "failed"), job("expired", "expired")],
				seen,
			),
		).toBe(false);
		expect(invalidateQueries).not.toHaveBeenCalled();

		const completed = [
			job("complete", "complete"),
			job("complete_with_actions", "actions"),
		];
		expect(
			await invalidateNewSuccessfulDeviceSetupJobs(
				queryClient,
				completed,
				seen,
			),
		).toBe(true);
		expect(invalidateQueries).toHaveBeenCalledTimes(6);
		expect(invalidateQueries.mock.calls.at(-1)?.[0]).toEqual({
			queryKey: queryKeys.deviceSetupJobs(),
		});

		await invalidateNewSuccessfulDeviceSetupJobs(queryClient, completed, seen);
		expect(invalidateQueries).toHaveBeenCalledTimes(6);
	});

	it("is route-stable, authenticated, and rediscovers from the server without browser storage", async () => {
		const source = await Bun.file(
			`${import.meta.dir}/DeviceSetupJobCoordinator.tsx`,
		).text();
		const app = await Bun.file(`${import.meta.dir}/../../App.tsx`).text();

		expect(source).toContain("useRecentDeviceSetupJobs(authenticated)");
		expect(source).toContain("continues on the server");
		expect(source).not.toContain("localStorage");
		expect(source).not.toContain("sessionStorage");
		expect(app).toContain("<DeviceSetupJobCoordinator");
		expect(app.indexOf("<DeviceSetupJobCoordinator")).toBeLessThan(
			app.indexOf("<Routes>"),
		);
	});
});
