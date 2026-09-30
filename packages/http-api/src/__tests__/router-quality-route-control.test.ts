import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { QualityRouteService } from "@better-ccflare/proxy";
import { NodeCryptoUtils } from "@better-ccflare/types/api-key";
import { runQualityRouteCommand } from "../../../../apps/cli/src/quality-route-control";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

let directory: string;
let dbOps: DatabaseOperations;
let service: QualityRouteService;
let router: APIRouter;
let now: number;
const scope = {
	verified: true as const,
	principalId: "owner",
	sessionId: "shared-name",
};
const secrets = {
	owner: "synthetic-owner-12345678",
	other: "synthetic-other-87654321",
};
function makeRouter(enabled = true) {
	return new APIRouter({
		db: dbOps.getAdapter(),
		dbOps,
		config: {} as Config,
		qualityRouteService: enabled ? service : undefined,
		localControlSecret: "synthetic-local",
		internalProbeSecret: "synthetic-probe",
		alertService: {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		},
	} as APIContext);
}
async function fetchControl(req: Request): Promise<Response> {
	const response = await router.handleRequest(new URL(req.url), req);
	if (!response) throw new Error("Quality control request fell through router");
	return response;
}
async function call(
	path = "/v1/quality-routing/sessions/shared-name",
	method = "GET",
	body?: unknown,
	secret: string | null = secrets.owner,
) {
	const req = new Request(`http://localhost${path}`, {
		method,
		headers: {
			...(secret ? { authorization: `Bearer ${secret}` } : {}),
			"content-type": "application/json",
		},
		...(body === undefined
			? {}
			: { body: typeof body === "string" ? body : JSON.stringify(body) }),
	});
	return router.handleRequest(new URL(req.url), req);
}
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "quality-api-"));
	dbOps = new DatabaseOperations(join(directory, "test.db"));
	now = 1000;
	service = new QualityRouteService(
		dbOps.getQualityRouteRepository(),
		() => now,
	);
	for (const [id, secret] of Object.entries(secrets))
		await dbOps.createApiKey({
			id,
			name: id,
			hashedKey: await new NodeCryptoUtils().hashApiKey(secret),
			prefixLast8: secret.slice(-8),
			createdAt: now,
			isActive: true,
			role: "api-only",
		});
	await service.acceptRoot(await service.reserveIngress(scope), "auto");
	router = makeRouter();
});
afterEach(async () => {
	await dbOps.close();
	rmSync(directory, { recursive: true });
});
const retryPath = "/v1/quality-routing/sessions/shared-name/retry-preferred";
it("denies revoked/bootstrap/local-secret authority and keeps disabled controls reserved", async () => {
	const req = new Request(
		"http://localhost/v1/quality-routing/sessions/shared-name",
		{
			headers: {
				"x-better-ccflare-local-control-secret": "synthetic-local",
				"x-api-key-id": "owner",
			},
		},
	);
	expect((await router.handleRequest(new URL(req.url), req))?.status).toBe(401);
	const probe = new Request(req.url, {
		headers: {
			"x-better-ccflare-internal-probe-secret": "synthetic-probe",
			"x-better-ccflare-auto-refresh": "true",
		},
	});
	expect((await router.handleRequest(new URL(probe.url), probe))?.status).toBe(
		401,
	);
	await dbOps.disableApiKey("owner");
	expect((await call())?.status).toBe(401);
	await dbOps.disableApiKey("other");
	expect((await call())?.status).toBe(401);
	expect((await call(undefined, "GET", undefined, null))?.status).toBe(401);
	expect((await service.status(scope))?.intentRevision).toBe(1);
});
it("rejects non-JSON media types and limits streamed bytes without trusting Content-Length", async () => {
	const state = await service.status(scope);
	const payload = JSON.stringify({
		incarnation: state?.incarnation,
		expectedIntentRevision: 1,
		idempotencyToken: "media",
	});
	for (const contentType of ["text/plain", "application/json-not-really"]) {
		const req = new Request(`http://localhost${retryPath}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${secrets.owner}`,
				"content-type": contentType,
			},
			body: payload,
		});
		expect((await router.handleRequest(new URL(req.url), req))?.status).toBe(
			415,
		);
	}
	const req = new Request(`http://localhost${retryPath}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${secrets.owner}`,
			"content-type": "application/json",
			"content-length": "1",
		},
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(4097));
				controller.close();
			},
		}),
	});
	expect((await router.handleRequest(new URL(req.url), req))?.status).toBe(413);
	expect((await service.status(scope))?.intentRevision).toBe(1);
});
it("disabled controls are unavailable even for a verified key and cannot fall through", async () => {
	router = makeRouter(false);
	expect((await call())?.status).toBe(404);
	expect((await call(retryPath, "POST", {}))?.status).toBe(404);
});
it("concurrent same-session-string callers read only their own principal without shared auth state", async () => {
	await service.acceptRoot(
		await service.reserveIngress({ ...scope, principalId: "other" }),
		"opus",
	);
	const [owner, other] = await Promise.all([
		call(),
		call(undefined, "GET", undefined, secrets.other),
	]);
	expect(await owner?.json()).toMatchObject({ preference: "auto" });
	expect(await other?.json()).toMatchObject({ preference: "opus" });
});
it("expired sessions stay unknown and are not resurrected by controls", async () => {
	const state = await service.status(scope);
	now = state?.expiresAt + 1;
	expect((await call())?.status).toBe(404);
	expect(
		(
			await call(retryPath, "POST", {
				incarnation: state?.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "expired",
			})
		)?.status,
	).toBe(404);
	expect(await service.status(scope)).toBeNull();
});
it("CLI and raw API share real authentication/repository semantics, including lost delivery", async () => {
	let posts = 0;
	let gets = 0;
	const command = {
		action: "retry-preferred" as const,
		sessionId: scope.sessionId,
		origin: "http://localhost",
		credentialEnv: "SYNTHETIC_KEY",
	};
	const result = await runQualityRouteCommand(command, {
		getEnv: () => secrets.owner,
		fetch: async (req) => {
			const response = await fetchControl(req);
			if (req.method === "GET") gets++;
			if (req.method === "POST" && ++posts === 1)
				throw new Error("Lost response");
			return response;
		},
	});
	expect(result).toMatchObject({
		exitCode: 0,
		data: { status: "ready", intentRevision: 2 },
	});
	expect(posts).toBe(2);
	expect(gets).toBe(1);
	expect((await service.status(scope))?.intentRevision).toBe(2);
	const status = await runQualityRouteCommand(
		{ ...command, action: "status" },
		{
			getEnv: () => secrets.owner,
			fetch: fetchControl,
		},
	);
	expect(status.data).toEqual(await (await call())?.json());
	const other = await runQualityRouteCommand(command, {
		getEnv: () => secrets.other,
		fetch: fetchControl,
	});
	expect(other).toMatchObject({ exitCode: 1, data: { status: "unknown" } });
});
it("retry persists one pending intent, returns original outcome on redelivery, and rejects conflicts", async () => {
	const before = await service.status(scope);
	const payload = {
		incarnation: before?.incarnation,
		expectedIntentRevision: 1,
		idempotencyToken: "operation-1",
	};
	const accepted = await call(retryPath, "POST", payload);
	expect(accepted?.status).toBe(200);
	const outcome = await accepted?.json();
	expect(outcome).toMatchObject({
		status: "ready",
		intentRevision: 2,
		decision: null,
	});
	expect(await (await call(retryPath, "POST", payload))?.json()).toEqual(
		outcome,
	);
	expect((await service.status(scope))?.intentRevision).toBe(2);
	expect(
		(await call(retryPath, "POST", { ...payload, expectedIntentRevision: 2 }))
			?.status,
	).toBe(409);
	expect(
		(
			await call(retryPath, "POST", {
				...payload,
				idempotencyToken: "new-operation",
			})
		)?.status,
	).toBe(409);
	expect(
		(
			await call(retryPath, "POST", {
				...payload,
				incarnation: "old",
				idempotencyToken: "new-operation",
			})
		)?.status,
	).toBe(409);
	expect(
		(await call(retryPath.replace("shared-name", "unknown"), "POST", payload))
			?.status,
	).toBe(404);
	expect(await service.status({ ...scope, sessionId: "unknown" })).toBeNull();
});
it("rejects malformed bodies and reserved paths without falling through", async () => {
	const state = await service.status(scope);
	const payload = {
		incarnation: state?.incarnation,
		expectedIntentRevision: 1,
		idempotencyToken: "one",
	};
	for (const body of [
		null,
		[],
		{},
		{ ...payload, principalId: "other" },
		{ ...payload, expectedIntentRevision: "1" },
		{ ...payload, expectedIntentRevision: -1 },
		{ ...payload, idempotencyToken: "" },
		"{",
		" ".repeat(4097),
	]) {
		expect((await call(retryPath, "POST", body))?.status).toBeOneOf([400, 413]);
	}
	for (const path of [
		"/v1/quality-routing/sessions/%",
		"/v1/quality-routing/sessions/%2f",
		"/v1/quality-routing/sessions/%252f",
		"/v1/quality-routing/sessions//retry-preferred",
		"/v1/quality-routing-other",
		"/v1/%71uality-routing/sessions/shared-name",
		"/v1/%71uality-routing/sessions/%",
		"/v1/quality-routing/sessions/shared-name/extra",
	])
		expect((await call(path))?.status).toBeOneOf([400, 404]);
	expect(
		(await call("/%761/quality-routing/sessions/shared-name"))?.status,
	).toBe(401);
	expect((await call(retryPath))?.status).toBe(405);
	expect((await call(undefined, "DELETE"))?.status).toBe(405);
	expect((await service.status(scope))?.intentRevision).toBe(1);
});
it("preserves decoded session ID character and length boundaries", async () => {
	for (const sessionId of [
		"",
		...Array.from(
			{ length: 33 },
			(_, code) => `a${String.fromCharCode(code)}b`,
		),
		"a\u007fb",
		"a/b",
		"a\\b",
		"a%b",
		"a?b",
		"a#b",
		"%2f",
		"a".repeat(257),
	])
		expect(
			(
				await call(
					`/v1/quality-routing/sessions/${encodeURIComponent(sessionId)}`,
				)
			)?.status,
		).toBe(400);
	for (const sessionId of [
		"a",
		"session-A_1.2:3",
		"a".repeat(256),
		"é",
		"a\u0080b",
		"a b",
	]) {
		await service.acceptRoot(
			await service.reserveIngress({ ...scope, sessionId }),
			"auto",
		);
		expect(
			(
				await call(
					`/v1/quality-routing/sessions/${encodeURIComponent(sessionId)}`,
				)
			)?.status,
		).toBe(200);
	}
});
it("uses verified API-only identity; status is private and never refreshes session TTL", async () => {
	const before = await service.status(scope);
	now += 100;
	const response = await call();
	expect(response?.status).toBe(200);
	expect(await response?.json()).toMatchObject({
		status: "known",
		incarnation: before?.incarnation,
		intentRevision: 1,
		preference: "auto",
		pending: true,
		lastSuccessfulHome: null,
	});
	expect((await service.status(scope))?.expiresAt).toBe(before?.expiresAt);
	expect((await call(undefined, "GET", undefined, secrets.other))?.status).toBe(
		404,
	);
	expect((await call(undefined, "GET", undefined, null))?.status).toBe(401);
	expect((await call("/api/accounts"))?.status).toBe(401);
});
