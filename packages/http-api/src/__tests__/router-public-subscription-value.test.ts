import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiKey } from "@better-ccflare/types/api-key";
import type { APIContext } from "../types";

// Set isolation before importing modules that can initialize database singletons.
const scratch = mkdtempSync(join(tmpdir(), "ccflare-public-boundary-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "test.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "config.json");
process.env.DATABASE_URL = "";
process.env.BETTER_CCFLARE_PUBLIC_SUBSCRIPTIONS = "";
const { APIRouter } = await import("../router");
const { AuthService } = await import("../services/auth-service");

function context(authEnabled = true): APIContext {
	return {
		dbOps: {
			getAdapter: () => ({}),
			countActiveApiKeys: async () => (authEnabled ? 1 : 0),
			getActiveApiKeys: async () => [],
		},
		config: {},
	} as unknown as APIContext;
}

describe("public subscription value auth boundary", () => {
	it("exempts only the exact GET path, including from the shared proxy auth check", async () => {
		const auth = new AuthService(context().dbOps);
		expect(
			await auth.isPathExempt("/api/public/subscription-value", "GET"),
		).toBe(true);
		for (const method of [
			"POST",
			"HEAD",
			"OPTIONS",
			"PUT",
			"PATCH",
			"DELETE",
		]) {
			expect(
				await auth.isPathExempt("/api/public/subscription-value", method),
			).toBe(false);
		}
		expect(auth.isStaticPathExempt("/api/public/subscription-value")).toBe(
			false,
		);
		for (const path of [
			"/api/public",
			"/api/public/",
			"/api/public/subscription-value/",
			"/api/public/subscription-value/extra",
			"/api/public/subscription-values",
			"/api/public/accounts",
			"/api/accounts",
			"/api/config",
			"/api/usage-windows",
		]) {
			expect(await auth.isPathExempt(path, "GET")).toBe(false);
		}
	});

	it("registers the public read without exposing private admin handlers", async () => {
		const router = new APIRouter(context());
		const url = new URL(
			"http://localhost/api/public/subscription-value?accountId=secret&limit=999",
		);
		const response = await router.handleRequest(url, new Request(url));
		expect(response?.status).toBe(404);
		for (const path of ["/api/accounts", "/api/config", "/api/usage-windows"]) {
			const privateUrl = new URL(`http://localhost${path}`);
			expect(
				(await router.handleRequest(privateUrl, new Request(privateUrl)))
					?.status,
			).toBe(401);
		}
	});

	it("retains admin authorization and authenticates public siblings and writes", async () => {
		const router = new APIRouter(context());
		for (const [path, method] of [
			["/api/public/subscription-value", "POST"],
			["/api/public/subscription-value", "HEAD"],
			["/api/public/subscription-value/extra", "GET"],
			["/api/public/accounts", "GET"],
		] as const) {
			const url = new URL(`http://localhost${path}`);
			expect(
				(await router.handleRequest(url, new Request(url, { method })))?.status,
			).toBe(401);
		}
		const auth = new AuthService(context().dbOps);
		for (const path of [
			"/api/accounts",
			"/api/config",
			"/api/usage-windows",
			"/api/debug/heap",
		]) {
			expect(
				(
					await auth.authorizeEndpoint(
						{ role: "api-only" } as ApiKey,
						path,
						"GET",
					)
				).authorized,
			).toBe(false);
			expect(
				(await auth.authorizeEndpoint({ role: "admin" } as ApiKey, path, "GET"))
					.authorized,
			).toBe(true);
		}
	});

	it("terminally rejects wrong methods and siblings even with authentication disabled", async () => {
		const router = new APIRouter(context(false));
		for (const method of ["POST", "HEAD", "OPTIONS", "PUT", "DELETE"]) {
			const url = new URL("http://localhost/api/public/subscription-value");
			const response = await router.handleRequest(
				url,
				new Request(url, { method }),
			);
			expect(response).not.toBeNull();
			expect(response?.status).toBe(405);
			expect(response?.headers.get("Allow")).toBe("GET");
		}
		for (const path of [
			"/api/public",
			"/api/public/",
			"/api/public/subscription-value/",
			"/api/public/subscription-value/extra",
			"/api/public/subscription-values",
			"/api/public/accounts",
		]) {
			const url = new URL(`http://localhost${path}`);
			for (const method of ["GET", "POST"]) {
				expect(
					(await router.handleRequest(url, new Request(url, { method })))
						?.status,
				).toBe(404);
			}
		}
	});
});
