import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const enabled = process.env.RUN_CLAUDE_2_1_207_COMPAT === "1";
const binary = process.env.CLAUDE_2_1_207_BIN;
const requiredVersion = "2.1.207 (Claude Code)";
const overflowMessage = "prompt is too long: 380000 tokens > 353400 tokens";
const summaryMarker = "FIXED_REACTIVE_COMPACTION_SUMMARY_MARKER";
const oldestSentinel = "OLDEST_SENTINEL_MUST_BE_COMPACTED_AWAY";
const recentSentinel = "RECENT_SENTINEL_MUST_SURVIVE_COMPACTION";
const triggerSentinel = "TRIGGER_SENTINEL_MUST_SURVIVE_COMPACTION";
const forbiddenContinuationPhrase = "You have weighted tokens left";

interface CapturedRequest {
	body: Record<string, unknown>;
	serialized: string;
}

interface ScenarioContext {
	root: string;
	home: string;
	configDir: string;
	cwd: string;
	settingsPath: string;
	mcpPath: string;
	hookLogPath: string;
	server: Server;
	baseUrl: string;
	requests: CapturedRequest[];
}

const contexts: ScenarioContext[] = [];

afterEach(async () => {
	await Promise.all(
		contexts.splice(0).map(async ({ server, root }) => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}),
	);
});

function textFromRequest(body: Record<string, unknown>): string {
	return JSON.stringify(body);
}

function successResponse(text: string): string {
	return [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: crypto.randomUUID(), type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })}`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } })}`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
		"",
	].join("\n\n");
}

async function createScenario(mode: "http-400" | "sse-error"): Promise<ScenarioContext> {
	const root = await mkdtemp(join(tmpdir(), `claude-2.1.207-${mode}-`));
	const home = join(root, "home");
	const configDir = join(root, "config");
	const cwd = join(root, "workspace");
	const settingsPath = join(root, "settings.json");
	const mcpPath = join(root, "mcp.json");
	const hookLogPath = join(root, "hooks.jsonl");
	const hookPath = join(root, "record-hook.mjs");
	await Promise.all([
		Bun.write(join(home, ".keep"), ""),
		Bun.write(join(configDir, ".keep"), ""),
		Bun.write(join(cwd, ".keep"), ""),
	]);
	await writeFile(
		hookPath,
		`import { appendFileSync } from "node:fs";\nlet input=""; for await (const chunk of process.stdin) input += chunk; appendFileSync(${JSON.stringify(hookLogPath)}, input.trim()+"\\n");\n`,
	);
	await chmod(hookPath, 0o755);
	await writeFile(
		settingsPath,
		JSON.stringify({
			disableAllHooks: false,
			hooks: {
				PreCompact: [{ hooks: [{ type: "command", command: `node ${hookPath}` }] }],
				PostCompact: [{ hooks: [{ type: "command", command: `node ${hookPath}` }] }],
			},
		}),
	);
	await writeFile(mcpPath, JSON.stringify({ mcpServers: {} }));

	const requests: CapturedRequest[] = [];
	let overflowSent = false;
	let summarySeen = false;
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
				throw new Error(`Unexpected request: ${request.method} ${request.url}`);
			}
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw) as Record<string, unknown>;
			const serialized = textFromRequest(body);
			requests.push({ body, serialized });
			if (serialized.includes(forbiddenContinuationPhrase)) {
				throw new Error(`Unexpected output-limit continuation request: ${serialized}`);
			}

			const isTrigger = serialized.includes(triggerSentinel);
			const isSummary = serialized.includes("Your task is to create a detailed summary");
			if (isTrigger && !summarySeen && !serialized.includes(summaryMarker)) {
				overflowSent = true;
				if (mode === "http-400") {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: overflowMessage } }));
				} else {
					response.writeHead(200, { "content-type": "text/event-stream", "request-id": crypto.randomUUID() });
					response.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: overflowMessage } })}\n\n`);
				}
				return;
			}
			if (overflowSent && !summarySeen && isSummary) {
				summarySeen = true;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(successResponse(summaryMarker));
				return;
			}
			if (summarySeen && isTrigger && serialized.includes(summaryMarker)) {
				if (!serialized.includes(recentSentinel) || serialized.includes(oldestSentinel)) {
					throw new Error(`Compacted retry retained the wrong context: ${serialized}`);
				}
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(successResponse("FINAL_REACTIVE_COMPACTION_SUCCESS"));
				return;
			}
			if (!overflowSent && !isTrigger) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(successResponse(`warmup-response-${requests.length}-${"context ".repeat(4000)}`));
				return;
			}
			throw new Error(`Unknown or extra API request #${requests.length}: ${serialized}`);
		} catch (error) {
			if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: String(error) }));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP port");
	const context = { root, home, configDir, cwd, settingsPath, mcpPath, hookLogPath, server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
	contexts.push(context);
	return context;
}

function sanitizedEnvironment(context: ScenarioContext): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(ANTHROPIC|CLAUDE|AWS|GOOGLE|VERTEX|BEDROCK|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i.test(key)) continue;
		env[key] = value;
	}
	return {
		...env,
		HOME: context.home,
		CLAUDE_CONFIG_DIR: context.configDir,
		ANTHROPIC_API_KEY: "dummy-compatibility-test-key",
		ANTHROPIC_BASE_URL: context.baseUrl,
		ANTHROPIC_MAX_RETRIES: "0",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_MAX_RETRIES: "0",
		DISABLE_AUTOUPDATER: "1",
		DISABLE_TELEMETRY: "1",
		NO_PROXY: "127.0.0.1,localhost",
	};
}

interface TurnResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runTurnResult(context: ScenarioContext, sessionId: string, prompt: string, first: boolean): Promise<TurnResult> {
	if (!binary) throw new Error("CLAUDE_2_1_207_BIN is required");
	const args = [
		"-p",
		"--output-format",
		"json",
		"--settings",
		context.settingsPath,
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		"--mcp-config",
		context.mcpPath,
		"--disable-slash-commands",
		"--no-chrome",
		"--tools",
		"",
		...(first ? ["--session-id", sessionId] : ["--resume", sessionId]),
		prompt,
	];
	return await new Promise((resolve, reject) => {
		const child = spawn(binary, args, { cwd: context.cwd, env: sanitizedEnvironment(context), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => stdout += chunk);
		child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

async function runTurn(context: ScenarioContext, sessionId: string, prompt: string, first: boolean): Promise<string> {
	const result = await runTurnResult(context, sessionId, prompt, first);
	if (result.code === 0) return result.stdout;
	throw new Error(
		`Claude exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nrequests:\n${context.requests.map((entry) => entry.serialized).join("\n---\n")}`,
	);
}

async function transcriptFiles(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await transcriptFiles(path));
		else if (entry.name.endsWith(".jsonl")) result.push(path);
	}
	return result;
}

const compatTest = enabled ? test : test.skip;

async function assertCompatibleBinary(): Promise<void> {
	if (!binary || !binary.startsWith("/")) throw new Error("CLAUDE_2_1_207_BIN must be an absolute path");
	const version = (await Bun.$`${binary} --version`.text()).trim();
	expect(version).toBe(requiredVersion);
}

async function warmPersistedSession(context: ScenarioContext, sessionId: string): Promise<void> {
	await runTurn(context, sessionId, `${oldestSentinel} warmup turn one`, true);
	await runTurn(context, sessionId, "middle warmup turn two", false);
	await runTurn(context, sessionId, `${recentSentinel} warmup turn three`, false);
}

async function readTranscript(context: ScenarioContext): Promise<string> {
	const transcripts = await transcriptFiles(context.configDir);
	return (await Promise.all(transcripts.map((path) => readFile(path, "utf8")))).join("\n");
}

describe("Claude Code 2.1.207 reactive compaction compatibility", () => {
	compatTest("recovers when HTTP 400 admits compaction before response commitment", async () => {
		await assertCompatibleBinary();
		const context = await createScenario("http-400");
		const sessionId = crypto.randomUUID();
		await warmPersistedSession(context, sessionId);
		const output = await runTurn(context, sessionId, `${triggerSentinel} answer only after recovering`, false);
		expect(output).toContain("FINAL_REACTIVE_COMPACTION_SUCCESS");
		expect(context.requests.length).toBe(6);
		const hookLog = await readFile(context.hookLogPath, "utf8");
		expect(hookLog).toContain('"hook_event_name":"PreCompact"');
		expect(hookLog).toContain('"hook_event_name":"PostCompact"');
		const transcript = await readTranscript(context);
		expect(transcript).toContain('"type":"system"');
		expect(transcript).toContain('"subtype":"compact_boundary"');
	}, 120_000);

	compatTest("characterizes committed SSE event:error as too late for compaction admission", async () => {
		await assertCompatibleBinary();
		const context = await createScenario("sse-error");
		const sessionId = crypto.randomUUID();
		await warmPersistedSession(context, sessionId);
		const result = await runTurnResult(context, sessionId, `${triggerSentinel} answer only after recovering`, false);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("API returned an empty or malformed response (HTTP 200)");
		const triggerRequests = context.requests.filter(({ serialized }) => serialized.includes(triggerSentinel));
		expect(triggerRequests).toHaveLength(2);
		const [{ body: streamedRequest }, { body: transportFallback }] = triggerRequests;
		expect(streamedRequest.stream).toBe(true);
		expect(transportFallback.stream).toBeUndefined();
		expect(transportFallback.messages).toEqual(streamedRequest.messages);
		expect(context.requests.some(({ serialized }) => serialized.includes("Your task is to create a detailed summary"))).toBe(false);
		expect(await Bun.file(context.hookLogPath).exists()).toBe(false);
		expect(await readTranscript(context)).not.toContain('"subtype":"compact_boundary"');
	}, 120_000);
});
