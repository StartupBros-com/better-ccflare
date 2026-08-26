import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const enabled = process.env.RUN_CLAUDE_2_1_243_CONTEXT_WINDOW_COMPAT === "1";
const binary = process.env.CLAUDE_2_1_243_BIN;
const requiredVersion = "2.1.243 (Claude Code)";
const routeBaseId = "claude-bccf-route-pro-primary-sol";
const suffixedRouteId = `${routeBaseId}[1m]`;
const autoCompactWindow = "auto";
const seededTokens = 240_000;
const seedStartMarker = "CONTEXT_WINDOW_SEED_START_243";
const seedEndMarker = "CONTEXT_WINDOW_SEED_END_243";
const seedAcknowledgementMarker = "CONTEXT_WINDOW_SEED_ACKNOWLEDGEMENT_243";
const triggerMarker = "CONTEXT_WINDOW_TRIGGER_243";
const compactSummaryMarker = "CONTEXT_WINDOW_COMPACT_SUMMARY_243";
const successMarker = "CONTEXT_WINDOW_SUCCESS_243";
const hookMarker = "CONTEXT_WINDOW_HOOK_243";

interface CapturedRequest {
	body: Record<string, unknown>;
	serialized: string;
}

interface Fixture {
	root: string;
	home: string;
	configDir: string;
	workspace: string;
	settingsPath: string;
	mcpPath: string;
	hookLogPath: string;
	server: Server;
	sockets: Set<Socket>;
	baseUrl: string;
	requests: CapturedRequest[];
	errors: string[];
}

interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function successResponse(text: string, inputTokens = 1): string {
	return [
		frame("message_start", {
			type: "message_start",
			message: {
				id: crypto.randomUUID(),
				type: "message",
				role: "assistant",
				model: routeBaseId,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: 0 },
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
			delta: { type: "text_delta", text },
		}),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		}),
		frame("message_stop", { type: "message_stop" }),
	].join("");
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "claude-2.1.243-context-window-"));
	const home = join(root, "home");
	const configDir = join(root, "config");
	const workspace = join(root, "workspace");
	const settingsPath = join(root, "settings.json");
	const mcpPath = join(root, "mcp.json");
	const hookLogPath = join(root, "hooks.jsonl");
	const hookPath = join(root, "record-hook.mjs");
	await Promise.all([
		mkdir(home, { recursive: true }),
		mkdir(configDir, { recursive: true }),
		mkdir(workspace, { recursive: true }),
		mkdir(join(root, "xdg-config"), { recursive: true }),
		mkdir(join(root, "xdg-cache"), { recursive: true }),
		mkdir(join(root, "xdg-data"), { recursive: true }),
		mkdir(join(root, "xdg-state"), { recursive: true }),
		mkdir(join(root, "tmp"), { recursive: true }),
		writeFile(
			hookPath,
			`import { appendFileSync } from "node:fs"; let input = ""; for await (const chunk of process.stdin) input += chunk; appendFileSync(${JSON.stringify(hookLogPath)}, ${JSON.stringify(hookMarker)} + " " + input.trim() + "\\n");`,
		),
		writeFile(
			settingsPath,
			JSON.stringify({
				disableAllHooks: false,
				hooks: {
					PreCompact: [{ hooks: [{ type: "command", command: `node ${hookPath}` }] }],
					PostCompact: [{ hooks: [{ type: "command", command: `node ${hookPath}` }] }],
				},
			}),
		),
		writeFile(mcpPath, JSON.stringify({ mcpServers: {} })),
	]);

	const fixture: Fixture = {
		root,
		home,
		configDir,
		workspace,
		settingsPath,
		mcpPath,
		hookLogPath,
		server: undefined as unknown as Server,
		sockets: new Set(),
		baseUrl: "",
		requests: [],
		errors: [],
	};
	let compacting = false;
	fixture.server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
				throw new Error(`Unexpected request: ${request.method} ${request.url}`);
			}
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw) as Record<string, unknown>;
			const serialized = JSON.stringify(body);
			fixture.requests.push({ body, serialized });
			if (body.model !== routeBaseId) {
				throw new Error(`Claude transported unexpected route model: ${JSON.stringify(body.model)}`);
			}
			const isSummary = serialized.includes("Your task is to create a detailed summary");
			if (isSummary) {
				compacting = true;
				response.writeHead(200, { "content-type": "text/event-stream", "request-id": crypto.randomUUID() });
				response.end(successResponse(compactSummaryMarker));
				return;
			}
			if (serialized.includes(triggerMarker) && compacting && !serialized.includes(compactSummaryMarker)) {
				throw new Error("Compacted continuation did not include the summary marker");
			}
			const inputTokens = serialized.includes(seedAcknowledgementMarker) ? seededTokens : 1;
			response.writeHead(200, { "content-type": "text/event-stream", "request-id": crypto.randomUUID() });
			response.end(successResponse(successMarker, inputTokens));
		} catch (error) {
			fixture.errors.push(String(error));
			if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: String(error) }));
		}
	});
	fixture.server.on("connection", (socket) => {
		fixture.sockets.add(socket);
		socket.once("close", () => fixture.sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		fixture.server.once("error", reject);
		fixture.server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = fixture.server.address();
	if (!address || typeof address === "string") throw new Error("Fake gateway did not bind a TCP port");
	fixture.baseUrl = `http://127.0.0.1:${address.port}`;
	if (new URL(fixture.baseUrl).hostname !== "127.0.0.1") throw new Error("Fake gateway must bind loopback only");
	return fixture;
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
		ANTHROPIC_API_KEY: "dummy-local-context-window-compat-key",
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

function runClaude(fixture: Fixture, args: string[], timeoutMs: number): Promise<ProcessResult> {
	if (!binary) throw new Error("CLAUDE_2_1_243_BIN is required");
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(binary, args, {
			cwd: fixture.workspace,
			env: sanitizedEnvironment(fixture),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const deadline = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Claude exceeded ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => stdout += chunk);
		child.stderr?.on("data", (chunk) => stderr += chunk);
		child.once("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(deadline);
			resolve({ code, stdout, stderr });
		});
	});
}

function turnArgs(fixture: Fixture, model: string, sessionId: string, prompt: string, first: boolean): string[] {
	return [
		"-p",
		"--output-format",
		"json",
		"--model",
		model,
		"--autocompact",
		autoCompactWindow,
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
		...(first ? ["--session-id", sessionId] : ["--resume", sessionId]),
		prompt,
	];
}

async function transcriptFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await transcriptFiles(path));
		else if (entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

async function onlyTranscript(fixture: Fixture): Promise<string> {
	const files = await transcriptFiles(fixture.configDir);
	expect(files).toHaveLength(1);
	return files[0]!;
}

function seedText(): string {
	return `${seedStartMarker} ${" seed".repeat(seededTokens)} ${seedEndMarker}`;
}

async function seedPersistedConversation(fixture: Fixture): Promise<void> {
	const transcriptPath = await onlyTranscript(fixture);
	const persistedTranscript = await readFile(transcriptPath, "utf8");
	const lines = persistedTranscript.trimEnd().split("\n");
	const userLine = lines.find((line) => {
		const record = JSON.parse(line) as { type?: unknown; message?: { role?: unknown } };
		return record.type === "user" && record.message?.role === "user";
	});
	if (!userLine) throw new Error("Could not find the persisted user record to seed");
	const seedRecord = JSON.parse(userLine) as Record<string, unknown> & { message: Record<string, unknown> };
	seedRecord.uuid = crypto.randomUUID();
	const parentLine = [...lines].reverse().find((line) => {
		const record = JSON.parse(line) as { uuid?: unknown };
		return typeof record.uuid === "string";
	});
	seedRecord.parentUuid = parentLine ? (JSON.parse(parentLine) as { uuid: string }).uuid : null;
	seedRecord.timestamp = new Date(0).toISOString();
	seedRecord.message = { ...seedRecord.message, content: seedText() };
	await writeFile(transcriptPath, `${persistedTranscript.trimEnd()}\n${JSON.stringify(seedRecord)}\n`);
}

async function transcript(fixture: Fixture): Promise<string> {
	return await readFile(await onlyTranscript(fixture), "utf8");
}

async function cleanupFixture(fixture: Fixture | undefined): Promise<void> {
	if (!fixture) return;
	try {
		for (const socket of fixture.sockets) socket.destroy();
		if (fixture.server.listening) await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
}

async function assertCompatibleBinary(fixture: Fixture): Promise<void> {
	if (!binary || !isAbsolute(binary)) throw new Error("CLAUDE_2_1_243_BIN must be an absolute path");
	const result = await runClaude(fixture, ["--version"], 10_000);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("");
	expect(result.stdout.trim()).toBe(requiredVersion);
}

async function runScenario(model: string): Promise<Fixture> {
	let fixture: Fixture | undefined;
	try {
		fixture = await createFixture();
		await assertCompatibleBinary(fixture);
		const sessionId = crypto.randomUUID();
		const initial = await runClaude(fixture, turnArgs(fixture, model, sessionId, "CONTEXT_WINDOW_INITIAL_243", true), 30_000);
		expect(initial.code).toBe(0);
		expect(initial.stdout).toContain(successMarker);
		await seedPersistedConversation(fixture);
		const acknowledgement = await runClaude(
			fixture,
			turnArgs(fixture, model, sessionId, seedAcknowledgementMarker, false),
			90_000,
		);
		expect(acknowledgement.code).toBe(0);
		expect(acknowledgement.stdout).toContain(successMarker);
		const resumed = await runClaude(fixture, turnArgs(fixture, model, sessionId, triggerMarker, false), 90_000);
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toContain(successMarker);
		expect(fixture.errors).toEqual([]);
		return fixture;
	} catch (error) {
		await cleanupFixture(fixture);
		throw error;
	}
}

const compatTest = enabled ? test : test.skip;

describe("Claude Code 2.1.243 unknown model context-window compatibility", () => {
	compatTest("compacts unknown aliases near their approximately 200k fallback cap but retains the [1m] context override", async () => {
		let unsuffixed: Fixture | undefined;
		let suffixed: Fixture | undefined;
		try {
			unsuffixed = await runScenario(routeBaseId);
			const unsuffixedRequests = unsuffixed.requests;
			expect(unsuffixedRequests.some(({ serialized }) => serialized.includes(seedStartMarker) && serialized.includes(seedEndMarker))).toBe(true);
			expect(unsuffixedRequests.some(({ serialized }) => serialized.includes("Your task is to create a detailed summary"))).toBe(true);
			const unsuffixedHooks = await readFile(unsuffixed.hookLogPath, "utf8");
			expect(unsuffixedHooks).toContain(hookMarker);
			expect(unsuffixedHooks).toContain('"hook_event_name":"PreCompact"');
			expect(unsuffixedHooks).toContain('"hook_event_name":"PostCompact"');
			expect(await transcript(unsuffixed)).toContain('"subtype":"compact_boundary"');

			suffixed = await runScenario(suffixedRouteId);
			expect(suffixed.requests.some(({ serialized }) => serialized.includes(seedStartMarker) && serialized.includes(seedEndMarker))).toBe(true);
			expect(suffixed.requests.some(({ serialized }) => serialized.includes("Your task is to create a detailed summary"))).toBe(false);
			expect(await Bun.file(suffixed.hookLogPath).exists()).toBe(false);
			expect(await transcript(suffixed)).not.toContain('"subtype":"compact_boundary"');

			for (const request of [...unsuffixed.requests, ...suffixed.requests]) {
				// The model field is the API transport value; [1m] may still appear in client-only system context.
				expect(request.body.model).toBe(routeBaseId);
			}
			// The explicit `auto` mode delegates the window to each model id: 200k-ish unknown or [1m].
			expect(seededTokens).toBeGreaterThan(200_000);
			expect(seededTokens).toBeLessThan(1_000_000);
		} finally {
			await cleanupFixture(unsuffixed);
			await cleanupFixture(suffixed);
		}
	}, 180_000);
});
