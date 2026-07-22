import { describe, expect, test } from "bun:test";
import { AuthService } from "../auth-service";
import { extractApiKey } from "../extract-api-key";

/**
 * Tests for extractApiKey header parsing logic
 *
 * Covers multi-header authentication support:
 * - x-api-key header (Vercel AI SDK / Opencode)
 * - Authorization: Bearer header (standard OAuth format)
 */

function makeRequest(headers: Record<string, string>): Request {
	return new Request("http://localhost/", { headers });
}

describe("API Key Header Extraction", () => {
	describe("x-api-key header", () => {
		test("extracts API key from x-api-key header", () => {
			const req = makeRequest({ "x-api-key": "sk-test-key-123" });
			expect(extractApiKey(req)).toBe("sk-test-key-123");
		});

		test("handles empty x-api-key header (falls back to Authorization)", () => {
			const req = makeRequest({ "x-api-key": "" });
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("Authorization Bearer header", () => {
		test("extracts API key from Authorization: Bearer header", () => {
			const req = makeRequest({ authorization: "Bearer sk-test-key-456" });
			expect(extractApiKey(req)).toBe("sk-test-key-456");
		});

		test("handles lowercase bearer", () => {
			const req = makeRequest({ authorization: "bearer sk-test-key-789" });
			expect(extractApiKey(req)).toBe("sk-test-key-789");
		});

		test("handles mixed case bearer", () => {
			const req = makeRequest({ authorization: "BEARER sk-test-key-abc" });
			expect(extractApiKey(req)).toBe("sk-test-key-abc");
		});

		test("handles extra whitespace in Authorization header", () => {
			const req = makeRequest({
				authorization: "  Bearer   sk-test-key-def  ",
			});
			expect(extractApiKey(req)).toBe("sk-test-key-def");
		});

		test("returns null for malformed Authorization header (missing Bearer)", () => {
			const req = makeRequest({ authorization: "sk-test-key-ghi" });
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null for malformed Authorization header (wrong prefix)", () => {
			const req = makeRequest({ authorization: "Basic sk-test-key-jkl" });
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null for Authorization header with only Bearer", () => {
			const req = makeRequest({ authorization: "Bearer" });
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("priority: x-api-key over Authorization", () => {
		test("prefers x-api-key when both headers are present", () => {
			const req = makeRequest({
				"x-api-key": "sk-from-x-api-key",
				authorization: "Bearer sk-from-auth",
			});
			expect(extractApiKey(req)).toBe("sk-from-x-api-key");
		});

		test("falls back to Authorization when x-api-key is empty", () => {
			const req = makeRequest({
				"x-api-key": "",
				authorization: "Bearer sk-from-auth",
			});
			expect(extractApiKey(req)).toBe("sk-from-auth");
		});
	});

	describe("no authentication headers", () => {
		test("returns null when no auth headers present", () => {
			const req = makeRequest({});
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null when unrelated headers present", () => {
			const req = makeRequest({
				"content-type": "application/json",
				"user-agent": "test-client",
			});
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("Vercel AI SDK / Opencode compatibility", () => {
		test("supports Vercel AI SDK x-api-key format", () => {
			const req = makeRequest({
				"x-api-key": "sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			expect(extractApiKey(req)).toBe("sk-ant-api03-test-key");
		});

		test("supports Anthropic SDK Authorization Bearer format", () => {
			const req = makeRequest({
				authorization: "Bearer sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			expect(extractApiKey(req)).toBe("sk-ant-api03-test-key");
		});
	});
});

describe("device setup authentication", () => {
	const protectedPaths = [
		["/api/oauth/qwen/init", "POST"],
		["/api/oauth/codex/init", "POST"],
		["/api/oauth/qwen/status/job-1", "GET"],
		["/api/oauth/codex/status/job-1", "GET"],
		["/api/oauth/device-setup/jobs", "GET"],
		["/api/oauth/device-setup/jobs/job-1", "GET"],
	] as const;

	function authWithActiveKeyCount(count: number): AuthService {
		return new AuthService({
			countActiveApiKeys: async () => count,
			getActiveApiKeys: async () => [],
			updateApiKeyUsage: async () => {},
		} as never);
	}

	test("does not exempt init, status, list, or job routes", async () => {
		const auth = authWithActiveKeyCount(1);
		for (const [path, method] of protectedPaths) {
			expect(await auth.isPathExempt(path, method)).toBe(false);
			const result = await auth.authenticateRequest(
				new Request(`http://localhost${path}`, { method }),
				path,
				method,
			);
			expect(result.isAuthenticated).toBe(false);
		}
	});

	test("preserves no-key bootstrap while restricting dashboard routes to admin keys", async () => {
		const bootstrap = authWithActiveKeyCount(0);
		for (const [path, method] of protectedPaths) {
			expect(
				(
					await bootstrap.authenticateRequest(
						new Request(`http://localhost${path}`, { method }),
						path,
						method,
					)
				).isAuthenticated,
			).toBe(true);
		}

		const auth = authWithActiveKeyCount(1);
		expect(
			(
				await auth.authorizeEndpoint(
					{ role: "admin" } as never,
					protectedPaths[4][0],
					"GET",
				)
			).authorized,
		).toBe(true);
		expect(
			(
				await auth.authorizeEndpoint(
					{ role: "api-only" } as never,
					protectedPaths[4][0],
					"GET",
				)
			).authorized,
		).toBe(false);
	});
});
