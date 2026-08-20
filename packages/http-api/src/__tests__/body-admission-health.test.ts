import { describe, expect, test } from "bun:test";
import { createHealthHandler } from "../handlers/health";

const config = {
	getHealthDetailEnabled: () => false,
	getStrategy: () => "session",
} as never;
const dbOps = {
	getAllAccounts: async () => [],
} as never;

describe("body admission health", () => {
	test("exposes only aggregate admission counters with no request identifiers", async () => {
		const handler = createHealthHandler(
			dbOps,
			config,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => ({
				enabled: true,
				budgetBytes: 268435456,
				reservedBytes: 8388608,
				activeLeases: 1,
				queuedRequests: 2,
				queueLimit: 500,
				peakReservedBytes: 16777216,
				peakActiveLeases: 2,
				counters: {
					admitted: 3,
					queued: 2,
					queueFull: 1,
					queueAborted: 1,
					released: 2,
				},
				path: "/v1/messages",
				accountId: "must-not-leak",
			}),
		);

		const body = (
			await handler(new URL("http://localhost/health"))
		).json() as Promise<Record<string, unknown>>;
		const json = await body;
		expect(json.runtime).toEqual({
			bodyAdmission: {
				enabled: true,
				budgetBytes: 268435456,
				reservedBytes: 8388608,
				activeLeases: 1,
				queuedRequests: 2,
				queueLimit: 500,
				peakReservedBytes: 16777216,
				peakActiveLeases: 2,
				counters: {
					admitted: 3,
					queued: 2,
					queueFull: 1,
					queueAborted: 1,
					released: 2,
				},
			},
		});
		expect(JSON.stringify(json)).not.toContain("must-not-leak");
		expect(JSON.stringify(json)).not.toContain("/v1/messages");
	});
});
