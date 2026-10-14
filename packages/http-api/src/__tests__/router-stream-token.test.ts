import { beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { type ApiKey, NodeCryptoUtils } from "@better-ccflare/types/api-key";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

const ADMIN = "test-stream-admin";
const API_ONLY = "test-stream-api-only";
const streamPaths = {
	logs: "/api/logs/stream",
	requests: "/api/requests/stream",
	alerts: "/api/insights/alerts/stream",
} as const;
type Audience = keyof typeof streamPaths;
let keys: ApiKey[];
let router: APIRouter;

beforeEach(async () => {
	const crypto = new NodeCryptoUtils();
	keys = await Promise.all(
		[ADMIN, API_ONLY].map(async (raw, index) => ({
			id: String(index),
			name: raw,
			hashedKey: await crypto.hashApiKey(raw),
			prefixLast8: raw.slice(-8),
			role: index === 0 ? ("admin" as const) : ("api-only" as const),
			isActive: true,
			createdAt: 0,
			lastUsed: null,
			usageCount: 0,
		})),
	);
	router = new APIRouter({
		config: {},
		dbOps: {
			getAdapter: () => ({}),
			countActiveApiKeys: async () => keys.filter((key) => key.isActive).length,
			getActiveApiKeys: async () => keys.filter((key) => key.isActive),
			getApiKey: async (id: string) =>
				keys.find((key) => key.id === id) ?? null,
			updateApiKeyUsage: () => {},
		},
	} as unknown as APIContext);
});

async function request(path: string, method = "GET", key?: string) {
	const url = new URL(`http://localhost${path}`);
	const response = await router.handleRequest(
		url,
		new Request(url, {
			method,
			headers: key ? { "x-api-key": key } : {},
		}),
	);
	if (!response) throw new Error(`No route for ${path}`);
	return response;
}
async function mint(audience: Audience, key = ADMIN) {
	const response = await request(`${streamPaths[audience]}/token`, "POST", key);
	expect(response.status).toBe(200);
	return (await response.json()).token as string;
}
async function expectStream(path: string, key?: string) {
	const response = await request(path, "GET", key);
	try {
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
	} finally {
		await response.body?.cancel();
	}
}

describe("router stream-token authentication and authorization", () => {
	for (const audience of ["logs", "requests", "alerts"] as const) {
		it(`${audience}: admin mints an ephemeral token and opens exactly one stream`, async () => {
			const token = await mint(audience);
			expect(token).toMatch(/^[a-f0-9]{64}$/);
			const path = `${streamPaths[audience]}?stream_token=${token}`;
			await expectStream(path);
			expect((await request(path)).status).toBe(401);
		});
		it(`${audience}: anonymous and API-only keys cannot mint or stream`, async () => {
			for (const key of [undefined, API_ONLY]) {
				expect(
					(await request(`${streamPaths[audience]}/token`, "POST", key)).status,
				).toBe(401);
				expect((await request(streamPaths[audience], "GET", key)).status).toBe(
					401,
				);
			}
		});
		it(`${audience}: header fallback and no-auth bootstrap still work`, async () => {
			await expectStream(
				`${streamPaths[audience]}?stream_token=invalid`,
				ADMIN,
			);
			keys = [];
			await expectStream(streamPaths[audience]);
			expect(
				(await request(`${streamPaths[audience]}/token`, "POST")).status,
			).toBe(200);
		});
		for (const other of ["logs", "requests", "alerts"] as const) {
			if (other === audience) continue;
			it(`${audience}: rejects ${other} audience and burns the token`, async () => {
				const token = await mint(audience);
				expect(
					(await request(`${streamPaths[other]}?stream_token=${token}`)).status,
				).toBe(401);
				expect(
					(await request(`${streamPaths[audience]}?stream_token=${token}`))
						.status,
				).toBe(401);
			});
		}
		for (const change of ["downgrade", "revoke", "delete"] as const) {
			it(`${audience}: rejects an issuer after ${change} with another key still active`, async () => {
				const token = await mint(audience);
				if (change === "downgrade") keys[0].role = "api-only";
				if (change === "revoke") keys[0].isActive = false;
				if (change === "delete") keys.shift();
				expect(
					(await request(`${streamPaths[audience]}?stream_token=${token}`))
						.status,
				).toBe(401);
			});
		}
	}
});
