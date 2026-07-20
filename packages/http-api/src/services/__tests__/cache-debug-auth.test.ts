import { describe, expect, test } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { ApiKey } from "@better-ccflare/types/api-key";
import { AuthService } from "../auth-service";

function makeDbOps(activeKeys: number): DatabaseOperations {
	return {
		countActiveApiKeys: async () => activeKeys,
		getActiveApiKeys: async () => [],
	} as unknown as DatabaseOperations;
}

const paths = [
	["POST", "/api/debug/cache-diagnosis"],
	["GET", "/api/debug/cache-pacing"],
] as const;

describe("cache debug endpoint authentication", () => {
	test("rejects unauthenticated requests when API-key auth is enabled", async () => {
		const auth = new AuthService(makeDbOps(1));
		for (const [method, path] of paths) {
			const result = await auth.authenticateRequest(
				new Request(`http://localhost${path}`, { method }),
				path,
				method,
			);
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toContain("API key required");
		}
	});

	test("keeps no-key local dashboard installs usable", async () => {
		const auth = new AuthService(makeDbOps(0));
		for (const [method, path] of paths) {
			const result = await auth.authenticateRequest(
				new Request(`http://localhost${path}`, { method }),
				path,
				method,
			);
			expect(result.isAuthenticated).toBe(true);
		}
	});

	test("keeps debug routes admin-only after authentication", async () => {
		const auth = new AuthService(makeDbOps(1));
		const apiOnly = { role: "api-only" } as ApiKey;
		const admin = { role: "admin" } as ApiKey;

		for (const [method, path] of paths) {
			expect(
				(await auth.authorizeEndpoint(apiOnly, path, method)).authorized,
			).toBe(false);
			expect(
				(await auth.authorizeEndpoint(admin, path, method)).authorized,
			).toBe(true);
		}
	});
});
