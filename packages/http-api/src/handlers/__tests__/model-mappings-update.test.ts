import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import {
	createAccountModelFallbacksUpdateHandler,
	createAccountModelMappingsUpdateHandler,
	createOpenAIAccountAddHandler,
} from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-model-mappings-update.db`;

/** Insert a minimal account row and return its generated id. */
async function insertAccount(
	dbOps: DatabaseOperations,
	name: string,
	modelMappings: Record<string, unknown> | null = null,
): Promise<string> {
	const db = dbOps.getAdapter();
	const id = crypto.randomUUID();
	await db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, "openai-compatible", "tok", Date.now(), 0],
	);
	if (modelMappings !== null) {
		await db.run("UPDATE accounts SET model_mappings = ? WHERE id = ?", [
			JSON.stringify(modelMappings),
			id,
		]);
	}
	return id;
}

/** Read the raw model_mappings JSON string (or null) for an account. */
async function readMappings(
	dbOps: DatabaseOperations,
	id: string,
): Promise<Record<string, unknown> | null> {
	const db = dbOps.getAdapter();
	const row = await db.get<{ model_mappings: string | null }>(
		"SELECT model_mappings FROM accounts WHERE id = ?",
		[id],
	);
	if (!row || row.model_mappings === null) return null;
	return JSON.parse(row.model_mappings);
}

/** Build a fake PATCH Request carrying the given JSON body. */
function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x/model-mappings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createAccountModelMappingsUpdateHandler — replace semantics", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, accountId: string) => Promise<Response>;
	let fallbackHandler: (req: Request, accountId: string) => Promise<Response>;
	let addHandler: (req: Request) => Promise<Response>;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountModelMappingsUpdateHandler(dbOps);
		fallbackHandler = createAccountModelFallbacksUpdateHandler(dbOps);
		addHandler = createOpenAIAccountAddHandler(dbOps);
	});

	afterAll(() => {
		DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// ignore
		}
	});

	beforeEach(async () => {
		// Wipe all accounts between tests for isolation.
		await dbOps.getAdapter().run("DELETE FROM accounts", []);
	});

	it("empty payload {} clears all existing mappings", async () => {
		const id = await insertAccount(dbOps, "acc1", { sonnet: "custom-model" });

		const response = await handler(makeRequest({ modelMappings: {} }), id);
		const data = (await response.json()) as {
			success: boolean;
			modelMappings: Record<string, unknown>;
		};

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.modelMappings).toEqual({});

		// Confirm the DB row is null (empty → stored as null).
		const stored = await readMappings(dbOps, id);
		expect(stored).toBeNull();
	});

	it("partial update replaces entirely — omitted keys are removed", async () => {
		const id = await insertAccount(dbOps, "acc2", {
			sonnet: "a",
			opus: "b",
		});

		const response = await handler(
			makeRequest({ modelMappings: { sonnet: "c" } }),
			id,
		);
		const data = (await response.json()) as {
			success: boolean;
			modelMappings: Record<string, unknown>;
		};

		expect(response.status).toBe(200);
		expect(data.modelMappings).toEqual({ sonnet: "c" });

		const stored = await readMappings(dbOps, id);
		expect(stored).toEqual({ sonnet: "c" });
		// 'opus' must be gone — not merged in.
		expect(stored).not.toHaveProperty("opus");
	});

	it("new mapping is saved correctly", async () => {
		const id = await insertAccount(dbOps, "acc3", null);

		const response = await handler(
			makeRequest({ modelMappings: { haiku: "my-haiku-model" } }),
			id,
		);
		const data = (await response.json()) as {
			success: boolean;
			modelMappings: Record<string, unknown>;
		};

		expect(response.status).toBe(200);
		expect(data.modelMappings).toEqual({ haiku: "my-haiku-model" });

		const stored = await readMappings(dbOps, id);
		expect(stored).toEqual({ haiku: "my-haiku-model" });
	});

	it("whitespace-only string values are excluded from the result", async () => {
		const id = await insertAccount(dbOps, "acc4", null);

		// The handler returns 400 for whitespace strings — verify rejection.
		const response = await handler(
			makeRequest({ modelMappings: { sonnet: "   " } }),
			id,
		);

		expect(response.status).toBe(400);
	});

	it("array value is saved as-is when multiple elements", async () => {
		const id = await insertAccount(dbOps, "acc5", null);

		const response = await handler(
			makeRequest({ modelMappings: { sonnet: ["model-a", "model-b"] } }),
			id,
		);
		const data = (await response.json()) as {
			success: boolean;
			modelMappings: Record<string, unknown>;
		};

		expect(response.status).toBe(200);
		expect(data.modelMappings).toEqual({ sonnet: ["model-a", "model-b"] });

		const stored = await readMappings(dbOps, id);
		expect(stored).toEqual({ sonnet: ["model-a", "model-b"] });
	});

	it("single-element array is normalized to a plain string", async () => {
		const id = await insertAccount(dbOps, "acc6", null);

		const response = await handler(
			makeRequest({ modelMappings: { sonnet: ["model-a"] } }),
			id,
		);
		const data = (await response.json()) as {
			success: boolean;
			modelMappings: Record<string, unknown>;
		};

		expect(response.status).toBe(200);
		// One-element array → normalized to string
		expect(data.modelMappings).toEqual({ sonnet: "model-a" });

		const stored = await readMappings(dbOps, id);
		expect(stored).toEqual({ sonnet: "model-a" });
	});

	it("accepts exactly 16 candidates", async () => {
		const id = await insertAccount(dbOps, "bounded", null);
		const candidates = Array.from(
			{ length: 16 },
			(_, index) => `model-${index + 1}`,
		);

		const response = await handler(
			makeRequest({ modelMappings: { sonnet: candidates } }),
			id,
		);

		expect(response.status).toBe(200);
		expect(await readMappings(dbOps, id)).toEqual({ sonnet: candidates });
	});

	it("rejects 17 candidates without mutating existing mappings", async () => {
		const id = await insertAccount(dbOps, "overflow", {
			sonnet: "existing-model",
		});
		const response = await handler(
			makeRequest({
				modelMappings: {
					sonnet: Array.from(
						{ length: 17 },
						(_, index) => `model-${index + 1}`,
					),
				},
			}),
			id,
		);
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toContain("modelMappings");
		expect(body.error).toContain("sonnet");
		expect(body.error).toContain("16");
		expect(await readMappings(dbOps, id)).toEqual({
			sonnet: "existing-model",
		});
	});

	it("deprecated fallback updates cannot append a 17th candidate", async () => {
		const candidates = Array.from(
			{ length: 16 },
			(_, index) => `model-${index + 1}`,
		);
		const id = await insertAccount(dbOps, "fallback-overflow", {
			sonnet: candidates,
		});
		const response = await fallbackHandler(
			makeRequest({ modelFallbacks: { sonnet: "overflow-fallback" } }),
			id,
		);

		expect(response.status).toBe(400);
		expect(await readMappings(dbOps, id)).toEqual({ sonnet: candidates });
	});

	it("OpenAI-compatible creation rejects 17 candidates without inserting an account", async () => {
		const response = await addHandler(
			new Request("http://localhost/api/accounts/openai-compatible", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "overflow-create",
					apiKey: "test-key",
					customEndpoint: "https://example.invalid",
					modelMappings: {
						sonnet: Array.from(
							{ length: 17 },
							(_, index) => `model-${index + 1}`,
						),
					},
				}),
			}),
		);
		const row = await dbOps
			.getAdapter()
			.get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM accounts WHERE name = ?",
				["overflow-create"],
			);

		expect(response.status).toBe(400);
		expect(row?.count).toBe(0);
	});

	it("returns 404 when the account does not exist", async () => {
		const response = await handler(
			makeRequest({ modelMappings: { sonnet: "x" } }),
			"nonexistent-id",
		);
		expect(response.status).toBe(404);
	});
});
