import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const enabled = process.env.RUN_CLAUDE_2_1_212_PING_COMPAT === "1";
const binary = process.env.CLAUDE_2_1_212_BIN;
const requiredVersion = "2.1.212 (Claude Code)";
const terminalMarker = "CLAUDE_2_1_212_PING_WATCHDOG_SUCCESS";
const pingOffsetsMs = [45_000, 90_000, 135_000, 180_000, 225_000, 270_000, 305_000];
const terminalOffsetMs = 310_000;

interface CapturedProcess {
	code: number | null;
	stdout: string;
	stderr: string;
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
	timers: Set<ReturnType<typeof setTimeout>>;
	baseUrl: string;
	requestCount: number;
	pingCount: number;
	terminalSent: boolean;
	closedEarly: boolean;
	errors: string[];
}

interface ClaudeJsonResult extends Record<string, unknown> {
	type: unknown;
	subtype: unknown;
	is_error: unknown;
	result: unknown;
}

function parseClaudeJsonResult(stdout: string): ClaudeJsonResult {
	const parsed: unknown = JSON.parse(stdout);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Claude stdout was not a top-level JSON result object");
	}
	return parsed as ClaudeJsonResult;
}

function findPingArtifact(value: unknown, path = "$output"): string | undefined {
	if (typeof value === "string") {
		if (value.trim().toLowerCase() === "ping") return path;
		if (/"(?:type|event)"\s*:\s*"ping"/i.test(value)) return path;
		return undefined;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const found = findPingArtifact(value[index], `${path}[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	for (const [key, child] of Object.entries(value)) {
		if (key.trim().toLowerCase() === "ping") return `${path}.${key}`;
		const found = findPingArtifact(child, `${path}.${key}`);
		if (found) return found;
	}
	return undefined;
}

function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function initialStream(): string {
	return frame("message_start", {
		type: "message_start",
		message: {
			id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
			type: "message",
			role: "assistant",
			model: "claude-opus-4-8",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	}) + frame("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
}

function terminalStream(): string {
	return [
		frame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: terminalMarker },
		}),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 8 },
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
		timers: new Set(),
		baseUrl: "",
		requestCount: 0,
		pingCount: 0,
		terminalSent: false,
		closedEarly: false,
		errors: [],
	};

	fixture.server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
				fixture.errors.push(`Unexpected request: ${request.method} ${request.url}`);
				response.writeHead(404, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "not found" }));
				return;
			}
			fixture.requestCount++;
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw) as { stream?: unknown };
			if (body.stream !== true) throw new Error("Claude request did not enable streaming");

			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"request-id": crypto.randomUUID(),
			});
			response.flushHeaders();
			response.write(initialStream());

			const clearStreamTimers = () => {
				for (const timer of fixture.timers) clearTimeout(timer);
				fixture.timers.clear();
			};
			response.once("error", (error) => fixture.errors.push(`Response error: ${String(error)}`));
			response.once("close", () => {
				if (!fixture.terminalSent) fixture.closedEarly = true;
				clearStreamTimers();
			});

			for (const offset of pingOffsetsMs) {
				const timer = setTimeout(() => {
					fixture.timers.delete(timer);
					if (response.destroyed || response.writableEnded) return;
					response.write(frame("message", { type: "ping" }));
					fixture.pingCount++;
				}, offset);
				fixture.timers.add(timer);
			}
			const terminalTimer = setTimeout(() => {
				fixture.timers.delete(terminalTimer);
				if (response.destroyed || response.writableEnded) return;
				fixture.terminalSent = true;
				response.end(terminalStream());
			}, terminalOffsetMs);
			fixture.timers.add(terminalTimer);
		} catch (error) {
			fixture.errors.push(String(error));
			if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: String(error) }));
		}
	});
	capture(fixture);
	fixture.server.requestTimeout = 0;
	fixture.server.timeout = 0;
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
	const root = await mkdtemp(join(tmpdir(), "claude-2.1.212-ping-watchdog-"));
	let partial: Fixture | undefined;
	try {
		return await initializeFixture(root, (fixture) => partial = fixture);
	} catch (error) {
		try {
			await cleanupFixture(partial, root);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Fixture setup and rollback both failed");
		}
		throw error;
	}
}

function sanitizedEnvironment(fixture: Fixture): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(ANTHROPIC|CLAUDE|AWS|AMAZON|GOOGLE|GCP|GCLOUD|VERTEX|BEDROCK|AZURE|CLOUD)/i.test(key)) continue;
		if (/PROXY/i.test(key)) continue;
		env[key] = value;
	}
	return {
		...env,
		HOME: fixture.home,
		CLAUDE_CONFIG_DIR: fixture.configDir,
		XDG_CONFIG_HOME: join(fixture.root, "xdg-config"),
		XDG_CACHE_HOME: join(fixture.root, "xdg-cache"),
		XDG_DATA_HOME: join(fixture.root, "xdg-data"),
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
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
	]);
	if (closed !== false || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await Promise.race([
		new Promise<void>((resolve) => child.once("close", () => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
}

async function cleanupFixture(fixture: Fixture | undefined, partialRoot?: string): Promise<void> {
	const root = fixture?.root ?? partialRoot;
	try {
		if (!fixture) return;
		for (const timer of fixture.timers) clearTimeout(timer);
		fixture.timers.clear();
		for (const socket of fixture.sockets) socket.destroy();
		if (fixture.server.listening) {
			await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
		}
	} finally {
		if (root) await rm(root, { recursive: true, force: true });
	}
}

const compatTest = enabled ? test : test.skip;

describe("Claude Code 2.1.212 ping watchdog compatibility", () => {
	compatTest("accepts hidden message-event ping carriers for more than 300 seconds", async () => {
		if (!binary || !isAbsolute(binary)) throw new Error("CLAUDE_2_1_212_BIN must be an absolute path");
		let fixture: Fixture | undefined;
		let child: ChildProcess | undefined;
		try {
			fixture = await createFixture();
			const versionRun = captureProcess(binary, ["--version"], fixture, 15_000);
			child = versionRun.child;
			const version = await versionRun.result;
			child = undefined;
			expect(version.code).toBe(0);
			expect(version.stderr).toBe("");
			expect(version.stdout.trim()).toBe(requiredVersion);

			const sessionId = crypto.randomUUID();
			const startedAt = Date.now();
			const run = captureProcess(binary, [
				"-p",
				"--output-format",
				"json",
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
				sessionId,
				`Return exactly ${terminalMarker}.`,
			], fixture, 390_000);
			child = run.child;
			const result = await run.result;
			const elapsedMs = Date.now() - startedAt;
			const combined = `${result.stdout}\n${result.stderr}`;
			const output = parseClaudeJsonResult(result.stdout);

			expect(result.code).toBe(0);
			expect(elapsedMs).toBeGreaterThan(300_000);
			expect(output.type).toBe("result");
			expect(output.subtype).toBe("success");
			expect(output.is_error).toBe(false);
			expect(output.result).toBe(terminalMarker);
			expect(findPingArtifact(output)).toBeUndefined();
			expect(combined.toLowerCase()).not.toContain("response stalled");
			expect(combined.toLowerCase()).not.toContain("mid-stream");
			expect(combined.toLowerCase()).not.toContain("api error");
			expect(combined).not.toContain("event: message");
			expect(fixture.requestCount).toBe(1);
			expect(fixture.pingCount).toBe(pingOffsetsMs.length);
			expect(fixture.terminalSent).toBe(true);
			expect(fixture.closedEarly).toBe(false);
			expect(fixture.errors).toEqual([]);
		} finally {
			await stopChild(child);
			await cleanupFixture(fixture);
		}
	}, 420_000);
});
