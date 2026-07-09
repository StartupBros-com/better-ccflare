/**
 * Tests for RequestRepository persistence of project_attribution_source and
 * agent_attribution_source (Unit U5 of the attribution-source plan).
 *
 * Covers:
 *  - save() persists both source labels and they read back correctly.
 *  - UPSERT atomicity (KTD7): project/project_attribution_source are
 *    preserve-first IN LOCKSTEP (COALESCE-style); agent_used/
 *    agent_attribution_source are overwritten unconditionally IN LOCKSTEP.
 *  - UPSERT upgrade: a later save() with a non-null project value updates
 *    project_attribution_source to the new source.
 *  - Secret-safety: only the known enum labels are ever persisted in the
 *    source columns.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

const KNOWN_PROJECT_SOURCES = new Set([
	"header_project",
	"path_project",
	"heading_project",
	"none",
]);
const KNOWN_AGENT_SOURCES = new Set(["header_agent", "prompt_agent", "none"]);

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function baseRequestData(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		accountUsed: null,
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTime: 100,
		failoverAttempts: 0,
		...overrides,
	};
}

describe("RequestRepository — attribution source persistence", () => {
	let db: Database;
	let repo: RequestRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new RequestRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("saves and reads back project_attribution_source and agent_attribution_source", async () => {
		await repo.save(
			baseRequestData("req-1", {
				project: "my-project",
				projectAttributionSource: "header_project",
				agentUsed: "my-agent",
				agentAttributionSource: "prompt_agent",
			}),
		);

		const row = db
			.prepare(
				"SELECT project, project_attribution_source, agent_used, agent_attribution_source FROM requests WHERE id = ?",
			)
			.get("req-1") as {
			project: string | null;
			project_attribution_source: string | null;
			agent_used: string | null;
			agent_attribution_source: string | null;
		};

		expect(row.project).toBe("my-project");
		expect(row.project_attribution_source).toBe("header_project");
		expect(row.agent_used).toBe("my-agent");
		expect(row.agent_attribution_source).toBe("prompt_agent");
	});

	it("UPSERT atomicity: project/project_attribution_source are preserved together when the new project is null; agent_used/agent_attribution_source are overwritten together", async () => {
		await repo.save(
			baseRequestData("req-2", {
				project: "foo",
				projectAttributionSource: "heading_project",
				agentUsed: "agent-a",
				agentAttributionSource: "header_agent",
			}),
		);

		// Conflict: project omitted (undefined -> null binding), agent changes.
		await repo.save(
			baseRequestData("req-2", {
				project: null,
				projectAttributionSource: null,
				agentUsed: "agent-b",
				agentAttributionSource: "prompt_agent",
			}),
		);

		const row = db
			.prepare(
				"SELECT project, project_attribution_source, agent_used, agent_attribution_source FROM requests WHERE id = ?",
			)
			.get("req-2") as {
			project: string | null;
			project_attribution_source: string | null;
			agent_used: string | null;
			agent_attribution_source: string | null;
		};

		// project preserved (COALESCE semantics) AND its source preserved in lockstep.
		expect(row.project).toBe("foo");
		expect(row.project_attribution_source).toBe("heading_project");

		// agent_used overwritten unconditionally AND its source overwritten in lockstep.
		expect(row.agent_used).toBe("agent-b");
		expect(row.agent_attribution_source).toBe("prompt_agent");
	});

	it("UPSERT upgrade: a later save() with a non-null project updates project_attribution_source to the new source", async () => {
		await repo.save(
			baseRequestData("req-3", {
				project: "foo",
				projectAttributionSource: "heading_project",
			}),
		);

		await repo.save(
			baseRequestData("req-3", {
				project: "foo",
				projectAttributionSource: "header_project",
			}),
		);

		const row = db
			.prepare(
				"SELECT project, project_attribution_source FROM requests WHERE id = ?",
			)
			.get("req-3") as {
			project: string | null;
			project_attribution_source: string | null;
		};

		expect(row.project).toBe("foo");
		expect(row.project_attribution_source).toBe("header_project");
	});

	it("secret-safety: persisted source columns contain only known enum labels, never raw header/secret values", async () => {
		await repo.save(
			baseRequestData("req-4", {
				project: "some-project",
				projectAttributionSource: "path_project",
				agentUsed: "some-agent",
				agentAttributionSource: "header_agent",
			}),
		);

		const row = db
			.prepare(
				"SELECT project_attribution_source, agent_attribution_source FROM requests WHERE id = ?",
			)
			.get("req-4") as {
			project_attribution_source: string | null;
			agent_attribution_source: string | null;
		};

		expect(row.project_attribution_source).not.toBeNull();
		expect(row.agent_attribution_source).not.toBeNull();
		expect(
			KNOWN_PROJECT_SOURCES.has(row.project_attribution_source as string),
		).toBe(true);
		expect(
			KNOWN_AGENT_SOURCES.has(row.agent_attribution_source as string),
		).toBe(true);
	});

	it("saving without attribution source fields leaves the columns null", async () => {
		await repo.save(baseRequestData("req-5"));

		const row = db
			.prepare(
				"SELECT project_attribution_source, agent_attribution_source FROM requests WHERE id = ?",
			)
			.get("req-5") as {
			project_attribution_source: string | null;
			agent_attribution_source: string | null;
		};

		expect(row.project_attribution_source).toBeNull();
		expect(row.agent_attribution_source).toBeNull();
	});
});
