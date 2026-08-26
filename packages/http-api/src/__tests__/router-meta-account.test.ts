import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

describe("APIRouter — Meta account ingress aliases", () => {
	let dbOps: DatabaseOperations;
	let router: APIRouter;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const alertService = {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		};
		const context = {
			db: dbOps.getAdapter(),
			config,
			dbOps,
			alertService,
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	afterEach(async () => {
		await dbOps.close();
	});

	for (const path of ["/api/accounts/meta", "/api/accounts/muse-spark"]) {
		it(`persists canonical provider=meta through POST ${path}`, async () => {
			const name = path.endsWith("muse-spark")
				? "legacy-meta"
				: "canonical-meta";
			const url = new URL(`http://localhost${path}`);
			const response = await router.handleRequest(
				url,
				new Request(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name,
						apiKey: "meta-key-abcdef",
						priority: 7,
					}),
				}),
			);

			expect(response?.ok).toBe(true);
			const payload = (await response?.json()) as {
				account: { provider: string };
			};
			expect(payload.account.provider).toBe("meta");

			const row = await dbOps.getAdapter().get<{
				provider: string;
				api_key: string | null;
				refresh_token: string | null;
				access_token: string | null;
				custom_endpoint: string | null;
			}>(
				"SELECT provider, api_key, refresh_token, access_token, custom_endpoint FROM accounts WHERE name = ?",
				[name],
			);
			expect(row).toEqual({
				provider: "meta",
				api_key: "meta-key-abcdef",
				refresh_token: null,
				access_token: null,
				custom_endpoint: "https://api.meta.ai",
			});
		});
	}
});
