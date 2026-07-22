import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import type {
	DeviceSetupJobView,
	DeviceSetupStartResult,
} from "@better-ccflare/types";
import { BunSqlAdapter } from "../../../../database/src/adapters/bun-sql-adapter";
import {
	ensureSchema,
	runMigrations,
} from "../../../../database/src/migrations";
import { DeviceSetupJobRepository } from "../../../../database/src/repositories/device-setup-job.repository";
import {
	createDeviceSetupCoordinator,
	DeviceSetupAuthorizationUnavailableError,
	type DeviceSetupCoordinator,
	DeviceSetupIdempotencyConflictError,
	validateDeviceSetupCommand,
} from "../../services/device-setup-jobs";

mock.module("@better-ccflare/proxy", () => ({
	clearAccountRefreshCache: () => {},
}));
mock.module("@better-ccflare/oauth-flow", () => ({
	createOAuthFlow: async () => ({ complete: async () => undefined }),
}));

async function handlers() {
	return await import("../oauth");
}

function job(
	provider: "qwen" | "codex" = "qwen",
	id = `${provider}-job`,
): DeviceSetupJobView {
	return {
		id,
		provider,
		accountId: null,
		status: "awaiting_authorization",
		routingOutcomes: [],
		errorCode: null,
		errorMessage: null,
		createdAt: 10,
		updatedAt: 10,
		terminalAt: null,
	};
}

function start(provider: "qwen" | "codex"): DeviceSetupStartResult {
	return {
		job: job(provider),
		authorization: {
			verificationUrl: `https://auth.example/${provider}`,
			userCode: "SAFE-CODE",
		},
		replayed: false,
	};
}

function request(provider: "qwen" | "codex", body: unknown): Request {
	return new Request(`http://localhost/api/oauth/${provider}/init`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function coordinator(overrides: Partial<DeviceSetupCoordinator> = {}) {
	const initQwen = mock(async (input: unknown) => {
		validateDeviceSetupCommand(input);
		return start("qwen");
	});
	const initCodex = mock(async (input: unknown) => {
		validateDeviceSetupCommand(input);
		return start("codex");
	});
	return {
		initQwen,
		initCodex,
		get: mock(async (id: string) => (id === "known" ? job("qwen", id) : null)),
		listRecent: mock(async () => [job("qwen", "recent")]),
		tick: mock(async () => {}),
		dispose: mock(() => {}),
		...overrides,
	} satisfies DeviceSetupCoordinator;
}

const valid = {
	name: "qwen-primary",
	priority: 0,
	idempotencyKey: "setup:one",
	reviewed: [{ family: "fable", proposalId: "proposal-1" }],
};

describe("durable device setup HTTP handlers", () => {
	it("returns only the durable start DTO and transient authorization fields", async () => {
		const module = await handlers();
		for (const provider of ["qwen", "codex"] as const) {
			const service = coordinator();
			const handler =
				provider === "qwen"
					? module.createQwenDeviceFlowInitHandler(service)
					: module.createCodexDeviceFlowInitHandler(service);
			const response = await handler(request(provider, valid));
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toEqual(start(provider));
			expect(JSON.stringify(body)).not.toContain("refresh_token");
		}
	});

	it("rejects unknown, duplicate-family, invalid, and overlong input", async () => {
		const { createQwenDeviceFlowInitHandler } = await handlers();
		const handler = createQwenDeviceFlowInitHandler(coordinator());
		const invalidBodies = [
			{ ...valid, token: "must-not-enter-job" },
			{
				...valid,
				reviewed: [
					...valid.reviewed,
					{ family: "fable", proposalId: "proposal-2" },
				],
			},
			{ ...valid, priority: -1 },
			{ ...valid, idempotencyKey: "x".repeat(201) },
			{
				...valid,
				reviewed: [{ family: "fable", proposalId: "x".repeat(513) }],
			},
		];
		for (const body of invalidBodies) {
			const response = await handler(request("qwen", body));
			expect(response.status).toBe(400);
		}
	});

	it("returns 400 for malformed JSON and non-object JSON", async () => {
		const { createQwenDeviceFlowInitHandler } = await handlers();
		const handler = createQwenDeviceFlowInitHandler(coordinator());
		const malformed = await handler(
			new Request("http://localhost/api/oauth/qwen/init", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		);
		expect(malformed.status).toBe(400);
		expect(
			(await handler(request("qwen", "this is valid JSON but not an object")))
				.status,
		).toBe(400);
	});

	it("maps a real repository idempotency fingerprint conflict to 409", async () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const repository = new DeviceSetupJobRepository(new BunSqlAdapter(db));
		const service = createDeviceSetupCoordinator({
			repository,
			providers: {
				qwen: {
					initiate: async () => ({
						verificationUrl: "https://auth.example/qwen",
						userCode: "SAFE-CODE",
						continuation: { providerState: "memory-only" },
					}),
					poll: async () => ({ credential: "not-run" }),
				},
				codex: {
					initiate: async () => ({
						verificationUrl: "https://auth.example/codex",
						userCode: "SAFE-CODE",
						continuation: { providerState: "memory-only" },
					}),
					poll: async () => ({ credential: "not-run" }),
				},
			},
			commitAuthorizedAccount: async () => {},
			accountExists: async () => false,
			finalizeRouting: async ({ accountId }) => ({
				accountId,
				outcomes: [],
			}),
			runInBackground: () => {},
			startLeaseHeartbeat: () => () => {},
		});
		try {
			const { createQwenDeviceFlowInitHandler } = await handlers();
			const handler = createQwenDeviceFlowInitHandler(service);
			expect((await handler(request("qwen", valid))).status).toBe(200);
			const conflict = await handler(
				request("qwen", { ...valid, name: "different-account" }),
			);
			expect(conflict.status).toBe(409);
			expect(await conflict.json()).toEqual({
				error: "Idempotency key was already used for a different request",
			});
		} finally {
			service.dispose();
			db.close();
		}
	});

	it("maps idempotency conflicts and unavailable authorization safely", async () => {
		const {
			createCodexDeviceFlowInitHandler,
			createQwenDeviceFlowInitHandler,
		} = await handlers();
		const conflict = coordinator({
			initQwen: async () => {
				throw new DeviceSetupIdempotencyConflictError();
			},
		});
		expect(
			(await createQwenDeviceFlowInitHandler(conflict)(request("qwen", valid)))
				.status,
		).toBe(409);

		const unavailable = coordinator({
			initCodex: async () => {
				throw new DeviceSetupAuthorizationUnavailableError();
			},
		});
		const response = await createCodexDeviceFlowInitHandler(unavailable)(
			request("codex", valid),
		);
		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain("secret");
	});

	it("lists and gets only safe durable job views, returning 404 for unknown jobs", async () => {
		const { createDeviceSetupJobGetHandler, createDeviceSetupJobsListHandler } =
			await handlers();
		const service = coordinator();
		const list = await createDeviceSetupJobsListHandler(service)(
			new URL("http://localhost/api/oauth/device-setup/jobs?limit=25"),
		);
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual([job("qwen", "recent")]);
		expect(service.listRecent).toHaveBeenCalledWith(25);

		const get = createDeviceSetupJobGetHandler(service);
		expect((await get("known")).status).toBe(200);
		expect((await get("missing")).status).toBe(404);
	});
});
