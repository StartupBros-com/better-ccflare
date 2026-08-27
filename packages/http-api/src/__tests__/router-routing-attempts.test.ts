import { describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { RoutingAttemptSummary } from "@better-ccflare/types";
import type { APIContext } from "../types";

// Fresh worktrees intentionally omit generated database workers. The route is
// tested with an injected facade, so prevent unrelated router imports from
// loading DatabaseOperations and its generated worker dependencies.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
	runIntegrityCheckInWorker: mock(async () => ({
		kind: "quick",
		result: "ok",
	})),
	analyzeIndexUsage: mock(async () => []),
}));
const { APIRouter } = await import("../router");

const aggregate: RoutingAttemptSummary = {
	firstObservedAt: null,
	totalAttempts: 1,
	distinctRequests: 1,
	recoveredRequests: 0,
	terminalFailureRequests: 0,
	awaitingTerminalRequests: 1,
	byReasonScope: [
		{
			reason: "model_scoped_429",
			scope: "model",
			attemptCount: 1,
			distinctRequests: 1,
			recoveredRequests: 0,
			terminalFailureRequests: 0,
			awaitingTerminalRequests: 1,
		},
	],
};

describe("APIRouter routing-attempt summary route", () => {
	it("wires GET /api/routing-attempts/summary to the object-shaped aggregate facade", async () => {
		const getRoutingAttemptSummary = mock(async () => aggregate);
		const router = new APIRouter({
			db: {},
			dbOps: {
				getRoutingAttemptSummary,
				countActiveApiKeys: async () => 0,
				getAdapter: () => ({
					get: async () => null,
					query: async () => [],
					run: async () => undefined,
				}),
			},
			config: {} as Config,
			alertService: {
				listAlerts: async () => [],
				getUnacknowledgedCount: async () => 0,
				acknowledgeAlert: async () => true,
				acknowledgeAll: async () => {},
			},
		} as unknown as APIContext);

		const url = new URL(
			"http://localhost/api/routing-attempts/summary?window=1h",
		);
		const response = await router.handleRequest(url, new Request(url));
		expect(response?.status).toBe(200);
		expect(getRoutingAttemptSummary).toHaveBeenCalledWith(
			expect.objectContaining({ window: "1h" }),
		);
		const body = (await response?.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			window: "1h",
			firstObservedAt: null,
			totalAttempts: 1,
			distinctRequests: 1,
		});
		expect(JSON.stringify(body)).not.toMatch(
			/accountId|parentRequestId|attemptedModel|modelFamily|provider|"id"/,
		);
	});
});
