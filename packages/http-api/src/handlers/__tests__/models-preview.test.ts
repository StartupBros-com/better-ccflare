import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { generateApiKey } from "@better-ccflare/cli-commands";
import type { APIContext } from "../../types";
import { APIRouter } from "../../router";
import { createModelsPreviewHandler } from "../models";

const LIVE_BODY = {
	data: [{ id: "gpt-oss-120b" }, { id: "gpt-oss-20b" }],
};

function previewRequest(
	body: unknown,
	apiKey?: string,
): Request {
	return new Request("http://localhost/api/models/preview", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(apiKey ? { "x-api-key": apiKey } : {}),
		},
		body: JSON.stringify(body),
	});
}

function contextFor(dbOps: DatabaseOperations): APIContext {
	return {
		db: dbOps.getAdapter(),
		dbOps,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config,
		alertService: {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		},
	} as unknown as APIContext;
}

let originalFetch: typeof globalThis.fetch;
let dbOps: DatabaseOperations;

beforeEach(() => {
	originalFetch = globalThis.fetch;
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	await dbOps.close();
});

describe("POST /api/models/preview", () => {
	it("returns a bounded live listing without persisting credentials or accounts", async () => {
		const secret = "preview-secret-key";
		let authorization: string | null = null;
		globalThis.fetch = (async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify(LIVE_BODY));
		}) as typeof fetch;

		const response = await createModelsPreviewHandler()(
			previewRequest({
				apiKey: secret,
				endpoint: "http://127.0.0.1:11434/v1",
			}),
		);

		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(secret);
		expect(authorization).toBe(`Bearer ${secret}`);
		expect(JSON.parse(text)).toMatchObject({
			provider: "openai-compatible",
			source: "preview",
			models: [
				{ id: "gpt-oss-120b", source: "preview" },
				{ id: "gpt-oss-20b", source: "preview" },
			],
		});
		expect(
			await dbOps.getAdapter().get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM accounts",
			),
		).toEqual({ count: 0 });
	});

	it("validates input before fetching", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify(LIVE_BODY));
		}) as typeof fetch;
		const handler = createModelsPreviewHandler();

		for (const body of [
			{},
			{ apiKey: 42, endpoint: "http://localhost:4000" },
			{ apiKey: "valid-preview-key", endpoint: "file:///tmp/models" },
		]) {
			const response = await handler(previewRequest(body));
			expect(response.status).toBe(400);
		}
		expect(fetchCalls).toBe(0);
	});

	it("returns redacted outcomes for upstream, malformed, empty, and size-limit failures", async () => {
		const secret = "preview-secret-key";
		const cases = [
			new Response(`credential ${secret} rejected`, { status: 403 }),
			new Response("not-json"),
			new Response(JSON.stringify({ data: [] })),
			new Response(null, {
				headers: { "content-length": String(8 * 1024 * 1024 + 1) },
			}),
		];
		const handler = createModelsPreviewHandler();

		for (const upstreamResponse of cases) {
			globalThis.fetch = (async () => upstreamResponse) as typeof fetch;
			const response = await handler(
				previewRequest({
					apiKey: secret,
					endpoint: "http://localhost:4000/v1",
				}),
			);
			expect(response.ok).toBe(false);
			const text = await response.text();
			expect(text).not.toContain(secret);
			expect(text).not.toContain("credential");
		}
	});

	it("authorizes before outbound fetch: bootstrap/admin allowed; unauthenticated/api-only denied", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response(JSON.stringify(LIVE_BODY));
		}) as typeof fetch;
		const router = new APIRouter(contextFor(dbOps));
		const url = new URL("http://localhost/api/models/preview");
		const body = {
			apiKey: "provider-preview-key",
			endpoint: "http://localhost:4000/v1",
		};

		const bootstrap = await router.handleRequest(url, previewRequest(body));
		expect(bootstrap?.status).toBe(200);
		expect(fetchCalls).toBe(1);

		const admin = await generateApiKey(dbOps, "preview-admin", "admin");
		const apiOnly = await generateApiKey(dbOps, "preview-api-only", "api-only");

		const unauthenticated = await router.handleRequest(url, previewRequest(body));
		expect(unauthenticated?.status).toBe(401);
		expect(fetchCalls).toBe(1);

		const denied = await router.handleRequest(
			url,
			previewRequest(body, apiOnly.apiKey),
		);
		expect(denied?.status).toBe(401);
		expect(fetchCalls).toBe(1);

		const allowed = await router.handleRequest(
			url,
			previewRequest(body, admin.apiKey),
		);
		expect(allowed?.status).toBe(200);
		expect(fetchCalls).toBe(2);
	});
});
