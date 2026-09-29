import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import { existsSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	agentRegistry,
	WorkspacePersistence,
	workspacePersistence,
} from "@better-ccflare/agents";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { ModelCatalog } from "../../model-catalog";
import {
	interceptAndModifyRequest,
	isRewriteTargetServable,
} from "../agent-interceptor";

// The `agentRegistry` singleton used below defaults to persisting workspace
// state to the real `~/.better-ccflare/workspaces.json`. Redirect it to an
// isolated tmp-dir file for the lifetime of this test file so no test here
// can ever touch the developer's real file.
let workspacePersistenceTmpDir: string;

beforeAll(() => {
	workspacePersistenceTmpDir = fs.mkdtempSync(
		path.join(
			os.tmpdir(),
			"bcf-interceptor-rewrite-guard-workspace-persistence-",
		),
	);
	agentRegistry.setWorkspacePersistenceForTests(
		new WorkspacePersistence({
			workspacesFile: path.join(workspacePersistenceTmpDir, "workspaces.json"),
		}),
	);
});

afterAll(() => {
	agentRegistry.setWorkspacePersistenceForTests(workspacePersistence);
	fs.rmSync(workspacePersistenceTmpDir, { recursive: true, force: true });
});

describe("isRewriteTargetServable", () => {
	test("live catalog containing the model => servable (no veto)", () => {
		const catalog: ModelCatalog = {
			models: [
				{ id: "claude-opus-model", displayName: "Opus", createdAt: null },
			],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(true);
	});

	test("live catalog missing the model => veto", () => {
		const catalog: ModelCatalog = {
			models: [
				{ id: "claude-sonnet-5", displayName: "Sonnet", createdAt: null },
			],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(false);
	});

	test("fallback source => never vetoes, even if model absent", () => {
		const catalog: ModelCatalog = {
			models: [
				{ id: "claude-sonnet-5", displayName: "Sonnet", createdAt: null },
			],
			fetchedAt: Date.now(),
			source: "fallback",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(true);
	});

	test("empty model list (even if source is live) => never vetoes", () => {
		const catalog: ModelCatalog = {
			models: [],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-opus-model")).toBe(true);
	});

	test("null/undefined catalog => never vetoes", () => {
		expect(isRewriteTargetServable(null, "claude-opus-model")).toBe(true);
		expect(isRewriteTargetServable(undefined, "claude-opus-model")).toBe(true);
	});
});

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-agent-interceptor-rewrite-guard.db`;

function toArrayBuffer(obj: Record<string, unknown>): ArrayBuffer {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(JSON.stringify(obj));
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function createMockRequestBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "claude-3-5-sonnet-20241022",
		messages: [{ role: "user", content: "test message" }],
		system: "",
		max_tokens: 1024,
		...overrides,
	};
}

function liveCatalog(models: string[]): ModelCatalog {
	return {
		models: models.map((id) => ({ id, displayName: id, createdAt: null })),
		fetchedAt: Date.now(),
		source: "live",
	};
}

describe("interceptAndModifyRequest - rewrite guard integration", () => {
	let dbOps: DatabaseOperations;
	let tmpDir: string;
	let agentsDir: string;

	function writeAgent(fileName: string, frontmatter: string, body: string) {
		fs.writeFileSync(
			path.join(agentsDir, fileName),
			`---\n${frontmatter}\n---\n\n${body}`,
		);
	}

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-interceptor-rewrite-guard-test-"),
		);
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
	});

	afterAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
		fs.rmSync(tmpDir, { recursive: true, force: true });
		agentRegistry.clearWorkspaces();
	});

	afterEach(() => {
		agentRegistry.clearWorkspaces();
	});

	test("preference targets a model absent from a live catalog => no rewrite, agentUsed set (header path)", async () => {
		await dbOps.setAgentPreference("guard-header-agent", "claude-opus-model");
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "guard-header-agent" }),
			{
				getModelCatalog: async () =>
					liveCatalog(["claude-3-5-sonnet-20241022"]),
			},
		);
		expect(result.agentUsed).toBe("guard-header-agent");
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.originalModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("preference targets a model present in a live catalog => rewrite proceeds (header path)", async () => {
		await dbOps.setAgentPreference(
			"guard-header-agent-ok",
			"claude-opus-model",
		);
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "guard-header-agent-ok" }),
			{
				getModelCatalog: async () =>
					liveCatalog(["claude-3-5-sonnet-20241022", "claude-opus-model"]),
			},
		);
		expect(result.appliedModel).toBe("claude-opus-model");
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("preference targets a model absent from a live catalog => no rewrite (system-prompt path)", async () => {
		writeAgent(
			"guard-agent.md",
			"name: Guard Agent\ndescription: test agent\nmodel: inherit",
			"You are the guard agent, a uniquely identifiable helper persona.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":guard-agent"));
		expect(agent).toBeDefined();

		await dbOps.setAgentPreference(
			agent?.id ?? "guard-agent",
			"claude-opus-model",
		);

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system:
					"You are the guard agent, a uniquely identifiable helper persona.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: async () => liveCatalog(["claude-3-5-sonnet-20241022"]),
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("fallback-source catalog never vetoes (system-prompt path)", async () => {
		writeAgent(
			"guard-agent-fallback.md",
			"name: Guard Agent Fallback\ndescription: test agent\nmodel: inherit",
			"You are the fallback guard agent, an entirely distinct helper voice.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":guard-agent-fallback"));
		expect(agent).toBeDefined();

		await dbOps.setAgentPreference(
			agent?.id ?? "guard-agent-fallback",
			"claude-opus-model",
		);

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system:
					"You are the fallback guard agent, an entirely distinct helper voice.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: async () => ({
				models: [],
				fetchedAt: Date.now(),
				source: "fallback",
			}),
		});
		expect(result.appliedModel).toBe("claude-opus-model");
		expect(result.modifiedBody).not.toBe(buffer);
	});

	// `force_account_model` is a second, independent veto on the same rewrite.
	// The catalog guard asks "can this target be served?"; this one asks "is
	// renaming allowed at all?" — and when the operator has said no, an agent
	// preference is just one more way of sending a model other than the one
	// that was asked for, exactly like a combo slot.
	test("force account model on => no rewrite, agentUsed still set (header path)", async () => {
		await dbOps.setAgentPreference("force-header-agent", "claude-opus-model");
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "force-header-agent" }),
			{
				// A catalog that *would* allow the rewrite, so the only thing
				// stopping it is the setting under test.
				getModelCatalog: async () =>
					liveCatalog(["claude-3-5-sonnet-20241022", "claude-opus-model"]),
				forceAccountModel: true,
			},
		);
		expect(result.agentUsed).toBe("force-header-agent");
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.originalModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("same preference and catalog with the setting off => rewrite proceeds", async () => {
		await dbOps.setAgentPreference("force-header-agent", "claude-opus-model");
		const buffer = toArrayBuffer(createMockRequestBody());
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "force-header-agent" }),
			{
				getModelCatalog: async () =>
					liveCatalog(["claude-3-5-sonnet-20241022", "claude-opus-model"]),
				forceAccountModel: false,
			},
		);
		expect(result.appliedModel).toBe("claude-opus-model");
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("force account model on => no rewrite (system-prompt path)", async () => {
		writeAgent(
			"force-agent.md",
			"name: Force Agent\ndescription: test agent\nmodel: inherit",
			"You are the force agent, a singular and unmistakable helper voice.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":force-agent"));
		expect(agent).toBeDefined();

		await dbOps.setAgentPreference(
			agent?.id ?? "force-agent",
			"claude-opus-model",
		);

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system:
					"You are the force agent, a singular and unmistakable helper voice.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: async () =>
				liveCatalog(["claude-3-5-sonnet-20241022", "claude-opus-model"]),
			forceAccountModel: true,
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("force account model on => the frontmatter fallback is vetoed too", async () => {
		writeAgent(
			"force-frontmatter-agent.md",
			"name: Force Frontmatter Agent\ndescription: test agent\nmodel: claude-opus-model",
			"You are the frontmatter force agent, an unrepeated and separate persona.",
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agents = await agentRegistry.getAgents();
		const agent = agents.find((a) => a.id.endsWith(":force-frontmatter-agent"));
		expect(agent).toBeDefined();

		const buffer = toArrayBuffer(
			createMockRequestBody({
				system:
					"You are the frontmatter force agent, an unrepeated and separate persona.",
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: async () =>
				liveCatalog(["claude-3-5-sonnet-20241022", "claude-opus-model"]),
			frontmatterModelFallback: true,
			forceAccountModel: true,
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.appliedModel).toBe("claude-3-5-sonnet-20241022");
		expect(result.modifiedBody).toBe(buffer);
	});
});

// Opus 5.5, Sonnet 5.5 and Fable 5.1 answer a forced tool_choice with HTTP
// 400. A rewrite that moves a forced-tool request onto one of them turns a
// working request into a failing one, so the interceptor must decline it.
describe("interceptAndModifyRequest - forced tool_choice guard", () => {
	let dbOps: DatabaseOperations;
	let tmpDir: string;
	let agentsDir: string;
	const ORIGINAL = "claude-3-5-sonnet-20241022";
	const REJECTING = "claude-opus-5-5";
	const ACCEPTING = "claude-sonnet-5";
	const TOOLS = [
		{
			name: "pick",
			description: "pick",
			input_schema: { type: "object", properties: {} },
		},
	];
	const catalog = async () => liveCatalog([ORIGINAL, REJECTING, ACCEPTING]);

	beforeAll(() => {
		const dbPath = `${process.env.TMPDIR || "/tmp"}/test-agent-interceptor-forced-tool.db`;
		try {
			if (existsSync(dbPath)) unlinkSync(dbPath);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
		tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "bcf-interceptor-forced-tool-test-"),
		);
		agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
	});

	afterAll(() => {
		DatabaseFactory.reset();
		fs.rmSync(tmpDir, { recursive: true, force: true });
		agentRegistry.clearWorkspaces();
	});

	afterEach(() => {
		agentRegistry.clearWorkspaces();
	});

	function headerRequest(toolChoice?: unknown) {
		const body = createMockRequestBody({ tools: TOOLS });
		if (toolChoice !== undefined) body.tool_choice = toolChoice;
		return toArrayBuffer(body);
	}

	const forcedForms: Array<[string, unknown]> = [
		["any", { type: "any" }],
		["tool", { type: "tool", name: "pick" }],
	];

	for (const [label, toolChoice] of forcedForms) {
		test(`rejecting preference + forced '${label}' tool_choice => no rewrite (header path)`, async () => {
			const agentId = `forced-header-${label}`;
			await dbOps.setAgentPreference(agentId, REJECTING);
			const buffer = headerRequest(toolChoice);
			const result = await interceptAndModifyRequest(
				buffer,
				dbOps,
				new Headers({ "x-anthropic-agent-id": agentId }),
				{ getModelCatalog: catalog },
			);
			expect(result.agentUsed).toBe(agentId);
			expect(result.originalModel).toBe(ORIGINAL);
			expect(result.appliedModel).toBe(ORIGINAL);
			expect(result.agentAttributionSource).toBe("header_agent");
			expect(result.modifiedBody).toBe(buffer);
		});
	}

	test("rejecting preference + auto tool_choice => rewrite proceeds (header path)", async () => {
		await dbOps.setAgentPreference("forced-header-auto", REJECTING);
		const buffer = headerRequest({ type: "auto" });
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "forced-header-auto" }),
			{ getModelCatalog: catalog },
		);
		expect(result.appliedModel).toBe(REJECTING);
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("rejecting preference + no tool_choice => rewrite proceeds (header path)", async () => {
		await dbOps.setAgentPreference("forced-header-none", REJECTING);
		const buffer = headerRequest();
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "forced-header-none" }),
			{ getModelCatalog: catalog },
		);
		expect(result.appliedModel).toBe(REJECTING);
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("accepting preference + forced tool_choice => rewrite proceeds (header path)", async () => {
		await dbOps.setAgentPreference("forced-header-accepting", ACCEPTING);
		const buffer = headerRequest({ type: "any" });
		const result = await interceptAndModifyRequest(
			buffer,
			dbOps,
			new Headers({ "x-anthropic-agent-id": "forced-header-accepting" }),
			{ getModelCatalog: catalog },
		);
		expect(result.appliedModel).toBe(ACCEPTING);
		expect(result.modifiedBody).not.toBe(buffer);
	});

	async function registerFrontmatterAgent(slug: string, system: string) {
		fs.writeFileSync(
			path.join(agentsDir, `${slug}.md`),
			`---\nname: ${slug}\ndescription: test agent\nmodel: opus\n---\n\n${system}`,
		);
		await agentRegistry.registerWorkspace(tmpDir);
		const agent = (await agentRegistry.getAgents()).find((a) =>
			a.id.endsWith(`:${slug}`),
		);
		expect(agent).toBeDefined();
		expect(agent?.model).toBe(REJECTING);
		return agent;
	}

	test("frontmatter fallback to a rejecting model + forced tool_choice => no rewrite (system-prompt path)", async () => {
		const system =
			"You are the forced-tool frontmatter agent, a peculiar and unique voice.";
		const agent = await registerFrontmatterAgent("forced-frontmatter", system);
		const buffer = toArrayBuffer(
			createMockRequestBody({
				system,
				tools: TOOLS,
				tool_choice: { type: "any" },
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: catalog,
			frontmatterModelFallback: true,
		});
		expect(result.agentUsed).toBe(agent?.id);
		expect(result.originalModel).toBe(ORIGINAL);
		expect(result.appliedModel).toBe(ORIGINAL);
		expect(result.agentAttributionSource).toBe("prompt_agent");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("frontmatter fallback to a rejecting model + auto tool_choice => rewrite proceeds (system-prompt path)", async () => {
		const system =
			"You are the forced-tool control agent, an equally peculiar other voice.";
		await registerFrontmatterAgent("forced-frontmatter-control", system);
		const buffer = toArrayBuffer(
			createMockRequestBody({
				system,
				tools: TOOLS,
				tool_choice: { type: "auto" },
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: catalog,
			frontmatterModelFallback: true,
		});
		expect(result.appliedModel).toBe(REJECTING);
		expect(result.modifiedBody).not.toBe(buffer);
	});

	test("DB preference for a rejecting model + forced tool_choice => no rewrite (system-prompt path)", async () => {
		const system =
			"You are the forced-tool preference agent, a third distinctive voice.";
		const agent = await registerFrontmatterAgent("forced-pref", system);
		await dbOps.setAgentPreference(agent?.id ?? "forced-pref", REJECTING);
		const buffer = toArrayBuffer(
			createMockRequestBody({
				system,
				tools: TOOLS,
				tool_choice: { type: "tool", name: "pick" },
			}),
		);
		const result = await interceptAndModifyRequest(buffer, dbOps, undefined, {
			getModelCatalog: catalog,
		});
		expect(result.appliedModel).toBe(ORIGINAL);
		expect(result.modifiedBody).toBe(buffer);
	});
});
