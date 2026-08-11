import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const enabled = process.env.RUN_CLAUDE_2_1_224_STRUCTURED_OUTPUT_COMPAT === "1";
const binary = process.env.CLAUDE_2_1_224_BIN;
const requiredVersion = "2.1.224 (Claude Code)";
const initialPrompt = "Inspect the supplied work item, determine the checks needed, and complete it before returning the final structured result. The work item is entirely contained in this prompt; do not access external services.";
const initialText = "I inspected the work item and completed the requested checks.";
const enforcementNudge = "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.";
const structuredOutputDescription = "return the final response as structured JSON";
const structuredOutputToolUseId = "toolu_structured_output_fixture_224";
const schema = {
	type: "object",
	properties: {
		work_item: { type: "string" },
		checks: { type: "array", items: { type: "string" } },
		complete: { type: "boolean" },
	},
	required: ["work_item", "checks", "complete"],
	additionalProperties: false,
} as const;
const validStructuredOutput = {
	work_item: "structured-output compatibility fixture",
	checks: ["inspected the prompt", "completed local-only work"],
	complete: true,
} as const;

interface CapturedRequest {
	headers: Record<string, string | string[] | undefined>;
	body: Record<string, unknown>;
}

interface CapturedProcess {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface ClaudeJsonResult extends Record<string, unknown> {
	type: unknown;
	subtype: unknown;
	is_error: unknown;
	stop_reason: unknown;
	terminal_reason: unknown;
	num_turns: unknown;
	result: unknown;
	structured_output: unknown;
}

interface ClaudeMessage {
	role?: unknown;
	content?: unknown;
}

interface Fixture {
	root: string;
	home: string;
	configDir: string;
	workspace: string;
	settingsPath: string;
	mcpPath: string;
	server: Server;
	sockets: Set<Socket>;
	baseUrl: string;
	requests: CapturedRequest[];
	errors: string[];
}

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseClaudeJsonResult(stdout: string): ClaudeJsonResult {
	const parsed: unknown = JSON.parse(stdout);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Claude stdout was not a top-level JSON result object");
	}
	return parsed as ClaudeJsonResult;
}

function messagesFrom(body: Record<string, unknown>): ClaudeMessage[] {
	if (!Array.isArray(body.messages)) throw new Error("Messages request did not contain a messages array");
	return body.messages as ClaudeMessage[];
}

function contentFrom(message: ClaudeMessage): Array<Record<string, unknown>> {
	if (!Array.isArray(message.content)) throw new Error("Claude message did not contain a content array");
	return message.content as Array<Record<string, unknown>>;
}

function hasStructuredOutputToolResult(body: Record<string, unknown>): boolean {
	return messagesFrom(body).some((message) => {
		if (!Array.isArray(message.content)) return false;
		return message.content.some((block: unknown) => {
			if (typeof block !== "object" || block === null) return false;
			const contentBlock = block as Record<string, unknown>;
			return contentBlock.type === "tool_result" && contentBlock.tool_use_id === structuredOutputToolUseId;
		});
	});
}

function textEndTurnStream(): string {
	return [
		frame("message_start", {
			type: "message_start",
			message: {
				id: "msg_structured_output_initial",
				type: "message",
				role: "assistant",
				model: "claude-opus-4-6",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 20, output_tokens: 0 },
			},
		}),
		frame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		frame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: initialText },
		}),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 12 },
		}),
		frame("message_stop", { type: "message_stop" }),
	].join("");
}

function structuredOutputToolUseStream(): string {
	return [
		frame("message_start", {
			type: "message_start",
			message: {
				id: "msg_structured_output_enforcement",
				type: "message",
				role: "assistant",
				model: "claude-opus-4-6",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 30, output_tokens: 0 },
			},
		}),
		frame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "tool_use",
				id: structuredOutputToolUseId,
				name: "StructuredOutput",
				input: {},
			},
		}),
		frame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(validStructuredOutput) },
		}),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 24 },
		}),
		frame("message_stop", { type: "message_stop" }),
	].join("");
}

function toolResultEndTurnStream(): string {
	return [
		frame("message_start", {
			type: "message_start",
			message: {
				id: "msg_structured_output_complete",
				type: "message",
				role: "assistant",
				model: "claude-opus-4-6",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 40, output_tokens: 0 },
			},
		}),
		frame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		frame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Structured output accepted." },
		}),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 6 },
		}),
		frame("message_stop", { type: "message_stop" }),
	].join("");
}

async function initializeFixture(root: string, capture: (fixture: Fixture) => void): Promise<Fixture> {
	const home = join(root, "home");
	const configDir = join(root, "config");
	const workspace = join(root, "workspace");
	const settingsPath = join(root, "settings.json");
	const mcpPath = join(root, "mcp.json");
	await Promise.all([
		mkdir(home, { recursive: true }),
		mkdir(configDir, { recursive: true }),
		mkdir(workspace, { recursive: true }),
		mkdir(join(root, "xdg-config"), { recursive: true }),
		mkdir(join(root, "xdg-cache"), { recursive: true }),
		mkdir(join(root, "xdg-data"), { recursive: true }),
		mkdir(join(root, "xdg-state"), { recursive: true }),
		mkdir(join(root, "tmp"), { recursive: true }),
		writeFile(settingsPath, JSON.stringify({ disableAllHooks: true })),
		writeFile(mcpPath, JSON.stringify({ mcpServers: {} })),
	]);

	const fixture: Fixture = {
		root,
		home,
		configDir,
		workspace,
		settingsPath,
		mcpPath,
		server: undefined as unknown as Server,
		sockets: new Set(),
		baseUrl: "",
		requests: [],
		errors: [],
	};
	fixture.server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
				throw new Error(`Unexpected request: ${request.method} ${request.url}`);
			}
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw) as Record<string, unknown>;
			fixture.requests.push({ headers: { ...request.headers }, body });
			if (body.stream !== true) throw new Error("Claude request did not enable streaming");
			const requestNumber = fixture.requests.length;
			if (requestNumber > 3) throw new Error(`Unexpected extra Messages request #${requestNumber}`);
			if (requestNumber === 3 && !hasStructuredOutputToolResult(body)) {
				throw new Error("Third Messages request did not return the StructuredOutput tool result");
			}
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"request-id": `req_structured_output_${requestNumber}`,
			});
			if (requestNumber === 1) {
				response.end(textEndTurnStream());
				return;
			}
			if (requestNumber === 2) {
				response.end(structuredOutputToolUseStream());
				return;
			}
			response.end(toolResultEndTurnStream());
		} catch (error) {
			fixture.errors.push(String(error));
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/event-stream" });
			response.end(
				frame("error", {
					type: "error",
					error: { type: "api_error", message: String(error) },
				}),
			);
		}
	});
	capture(fixture);
	fixture.server.on("connection", (socket) => {
		fixture.sockets.add(socket);
		socket.once("close", () => fixture.sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		fixture.server.once("error", reject);
		fixture.server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = fixture.server.address();
	if (!address || typeof address === "string") throw new Error("Fake Messages server did not bind a TCP port");
	fixture.baseUrl = `http://127.0.0.1:${address.port}`;
	return fixture;
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "claude-2.1.224-structured-output-"));
	let partial: Fixture | undefined;
	try {
		return await initializeFixture(root, (fixture) => partial = fixture);
	} catch (error) {
		await cleanupFixture(partial, root);
		throw error;
	}
}

function sanitizedEnvironment(fixture: Fixture): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "C.UTF-8",
		LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
		SHELL: "/bin/sh",
		USER: "claude-compat",
		LOGNAME: "claude-compat",
		HOME: fixture.home,
		CLAUDE_CONFIG_DIR: fixture.configDir,
		XDG_CONFIG_HOME: join(fixture.root, "xdg-config"),
		XDG_CACHE_HOME: join(fixture.root, "xdg-cache"),
		XDG_DATA_HOME: join(fixture.root, "xdg-data"),
		XDG_STATE_HOME: join(fixture.root, "xdg-state"),
		TMPDIR: join(fixture.root, "tmp"),
		ANTHROPIC_API_KEY: "dummy-local-compatibility-test-key",
		ANTHROPIC_BASE_URL: fixture.baseUrl,
		ANTHROPIC_MAX_RETRIES: "0",
		CLAUDE_CODE_MAX_RETRIES: "0",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_AUTOUPDATER: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		CI: "1",
		HTTP_PROXY: "http://127.0.0.1:9",
		HTTPS_PROXY: "http://127.0.0.1:9",
		ALL_PROXY: "http://127.0.0.1:9",
		NO_PROXY: "127.0.0.1,localhost",
		http_proxy: "http://127.0.0.1:9",
		https_proxy: "http://127.0.0.1:9",
		all_proxy: "http://127.0.0.1:9",
		no_proxy: "127.0.0.1,localhost",
	};
}

function captureProcess(
	command: string,
	args: string[],
	fixture: Fixture,
	timeoutMs: number,
): { child: ChildProcess; result: Promise<CapturedProcess> } {
	const child = spawn(command, args, {
		cwd: fixture.workspace,
		env: sanitizedEnvironment(fixture),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => stdout += chunk);
	child.stderr?.on("data", (chunk) => stderr += chunk);
	const result = new Promise<CapturedProcess>((resolve, reject) => {
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Process exceeded ${timeoutMs}ms: ${command}`));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(deadline);
			resolve({ code, stdout, stderr });
		});
	});
	return { child, result };
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const closed = await Promise.race([
		new Promise<void>((resolve) => child.once("close", () => resolve())),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
	]);
	if (closed !== false || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await Promise.race([
		new Promise<void>((resolve) => child.once("close", () => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
	]);
}

async function cleanupFixture(fixture: Fixture | undefined, partialRoot?: string): Promise<void> {
	const root = fixture?.root ?? partialRoot;
	try {
		if (!fixture) return;
		for (const socket of fixture.sockets) socket.destroy();
		if (fixture.server.listening) {
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
		}
	} finally {
		if (root) await rm(root, { recursive: true, force: true });
	}
}

const compatTest = enabled ? test : test.skip;

describe("Claude Code 2.1.224 structured output compatibility", () => {
	compatTest("enforces --json-schema with the built-in StructuredOutput tool", async () => {
		if (!binary || !isAbsolute(binary)) throw new Error("CLAUDE_2_1_224_BIN must be an absolute path");
		let fixture: Fixture | undefined;
		let child: ChildProcess | undefined;
		try {
			fixture = await createFixture();
			const versionRun = captureProcess(binary, ["--version"], fixture, 10_000);
			child = versionRun.child;
			const version = await versionRun.result;
			child = undefined;
			expect(version.code).toBe(0);
			expect(version.stderr).toBe("");
			expect(version.stdout.trim()).toBe(requiredVersion);

			const run = captureProcess(binary, [
				"-p",
				"--bare",
				"--output-format",
				"json",
				"--json-schema",
				JSON.stringify(schema),
				"--settings",
				fixture.settingsPath,
				"--setting-sources",
				"user",
				"--strict-mcp-config",
				"--mcp-config",
				fixture.mcpPath,
				"--disable-slash-commands",
				"--no-chrome",
				"--tools",
				"",
				"--session-id",
				crypto.randomUUID(),
				initialPrompt,
			], fixture, 20_000);
			child = run.child;
			const result = await run.result;
			child = undefined;

			const output = parseClaudeJsonResult(result.stdout);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(output.type).toBe("result");
			expect(output.subtype).toBe("success");
			expect(output.is_error).toBe(false);
			expect(output.stop_reason).toBe("tool_use");
			expect(output.terminal_reason).toBe("completed");
			expect(output.num_turns).toBe(3);
			expect(output.result).toBe(JSON.stringify(validStructuredOutput));
			expect(JSON.parse(output.result as string)).toEqual(validStructuredOutput);
			expect(output.structured_output).toEqual(validStructuredOutput);

			expect(fixture.requests).toHaveLength(2);
			const [initialRequest, enforcementRequest] = fixture.requests;
			const expectedTool = {
				name: "StructuredOutput",
				description: structuredOutputDescription,
				input_schema: schema,
			};
			expect(initialRequest.body.stream).toBe(true);
			expect(initialRequest.body.tools).toEqual([expectedTool]);
			expect(initialRequest.body.tool_choice).toBeUndefined();
			expect(Object.hasOwn(initialRequest.body, "disable_parallel_tool_use")).toBe(false);

			const initialMessages = messagesFrom(initialRequest.body);
			expect(initialMessages).toHaveLength(1);
			expect(initialMessages[0]?.role).toBe("user");
			expect(contentFrom(initialMessages[0]!).some(({ text }) => text === initialPrompt)).toBe(true);

			expect(enforcementRequest.body.stream).toBe(true);
			expect(enforcementRequest.body.tools).toEqual([expectedTool]);
			expect(enforcementRequest.body.tool_choice).toBeUndefined();
			expect(Object.hasOwn(enforcementRequest.body, "disable_parallel_tool_use")).toBe(false);
			const enforcementMessages = messagesFrom(enforcementRequest.body);
			expect(enforcementMessages.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
			expect(contentFrom(enforcementMessages[1]!)).toEqual([{ type: "text", text: initialText }]);
			expect(contentFrom(enforcementMessages[2]!)).toEqual([{
				type: "text",
				text: enforcementNudge,
				cache_control: { type: "ephemeral" },
			}]);

			const localHost = new URL(fixture.baseUrl).host;
			for (const request of fixture.requests) {
				expect(request.headers.host).toBe(localHost);
				expect(request.headers["x-api-key"]).toBe("dummy-local-compatibility-test-key");
			}
			expect(fixture.errors).toEqual([]);
		} finally {
			await stopChild(child);
			await cleanupFixture(fixture);
		}
	}, 30_000);
});
