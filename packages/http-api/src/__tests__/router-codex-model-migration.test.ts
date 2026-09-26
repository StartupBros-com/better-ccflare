import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { parseModelRouteProfiles } from "@better-ccflare/proxy";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

// Fictitious account and model names only.
describe("APIRouter — Codex model migration routes", () => {
	let dbOps: DatabaseOperations;
	let router: APIRouter;

	beforeEach(async () => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		await dbOps
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, refresh_token, created_at, model_mappings) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"codex-alpha",
					"alpha",
					"codex",
					"refresh-alpha",
					1,
					JSON.stringify({ opus: "gpt-6-astra" }),
				],
			);
		const context = {
			db: dbOps.getAdapter(),
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
			} as unknown as Config,
			dbOps,
			alertService: {
				listAlerts: async () => [],
				getUnacknowledgedCount: async () => 0,
				acknowledgeAlert: async () => true,
				acknowledgeAll: async () => {},
			},
			// What the server passes after validating CCFLARE_MODEL_ROUTE_PROFILES_JSON.
			modelRouteProfiles: parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "alpha-opus-exact",
						displayName: "Alpha Opus",
						accountId: "codex-alpha",
						logicalModel: "claude-opus-4-8",
						expectedProvider: "codex",
						expectedPhysicalModel: "gpt-6-astra",
					},
				]),
			),
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	afterEach(async () => {
		await dbOps.close();
	});

	async function send(path: string, body: unknown): Promise<Response | null> {
		const url = new URL(`http://localhost${path}`);
		return router.handleRequest(
			url,
			new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	}

	it("serves the preview with the context's configured route profiles", async () => {
		const response = await send("/api/codex/model-migration/preview", {});
		expect(response?.status).toBe(200);
		const payload = (await response?.json()) as {
			data: {
				accounts: Array<{ accountId: string }>;
				routeProfileAdvisories: Array<{ profileId: string }>;
			};
		};
		expect(payload.data.accounts.map((entry) => entry.accountId)).toEqual([
			"codex-alpha",
		]);
		expect(
			payload.data.routeProfileAdvisories.map((entry) => entry.profileId),
		).toEqual(["alpha-opus-exact"]);
	});

	it("routes apply to the guarded handler, which never treats an empty selection list as everything", async () => {
		const revision = await dbOps.getRoutingPolicyRevision();
		const response = await send("/api/codex/model-migration/apply", {
			expected_revision: revision,
			selections: [],
		});
		expect(response?.status).toBe(400);
		expect(
			(
				await dbOps
					.getAdapter()
					.get<{ model_mappings: string | null }>(
						"SELECT model_mappings FROM accounts WHERE id = ?",
						["codex-alpha"],
					)
			)?.model_mappings,
		).toBe(JSON.stringify({ opus: "gpt-6-astra" }));
	});
});
