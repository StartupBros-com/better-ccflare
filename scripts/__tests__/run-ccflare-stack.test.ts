import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const runnerScript = join(repoRoot, "scripts", "run-ccflare-stack.sh");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function allocatePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("failed to allocate fixture port");
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

function writeFixturePrograms(dir: string): {
	upstream: string;
	guard: string;
} {
	const upstream = join(dir, "fake-upstream.mjs");
	const guard = join(dir, "fake-guard.mjs");
	writeFileSync(
		upstream,
		[
			"#!/usr/bin/env node",
			'import { appendFileSync } from "node:fs";',
			'import http from "node:http";',
			'const portIndex = process.argv.indexOf("--port");',
			"const port = Number(process.argv[portIndex + 1]);",
			'appendFileSync(`${process.env.CAPTURE_DIR}/upstream.json`, JSON.stringify({ secret: process.env.CCFLARE_GUARD_CORRELATION_SECRET, argv: process.argv }) + "\\n");',
			"const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });",
			"server.listen(port, '127.0.0.1');",
			"process.on('SIGTERM', () => server.close(() => process.exit(0)));",
		].join("\n"),
	);
	writeFileSync(
		guard,
		[
			'import { appendFileSync } from "node:fs";',
			'import http from "node:http";',
			'appendFileSync(`${process.env.CAPTURE_DIR}/guard.json`, JSON.stringify({ secret: process.env.CCFLARE_GUARD_CORRELATION_SECRET, argv: process.argv }) + "\\n");',
			"let exitScheduled = false;",
			"const server = http.createServer((_req, res) => {",
			"  res.writeHead(200, { 'content-type': 'application/json' });",
			"  res.end('{}');",
			"  if (!exitScheduled) { exitScheduled = true; setTimeout(() => server.close(() => process.exit(0)), 350); }",
			"});",
			"server.listen(Number(process.env.GUARD_PORT), '127.0.0.1');",
			"process.on('SIGTERM', () => server.close(() => process.exit(0)));",
		].join("\n"),
	);
	chmodSync(upstream, 0o755);
	chmodSync(guard, 0o755);
	return { upstream, guard };
}

async function runStackInvocation(
	programs: { upstream: string; guard: string },
): Promise<{
	upstream: { secret: string; argv: string[] };
	guard: { secret: string; argv: string[] };
	stdout: string;
	stderr: string;
}> {
	const captureDir = tempDir("ccflare-stack-capture-");
	mkdirSync(captureDir, { recursive: true });
	const upstreamPort = await allocatePort();
	const guardPort = await allocatePort();
	const child = spawn("bash", [runnerScript], {
		cwd: repoRoot,
		env: {
			...process.env,
			CAPTURE_DIR: captureDir,
			CCFLARE_BIN: programs.upstream,
			GUARD_SCRIPT: programs.guard,
			NODE_BIN: process.execPath,
			CCFLARE_UPSTREAM_PORT: String(upstreamPort),
			GUARD_PORT: String(guardPort),
			AI_GATEWAY_TUNNEL_ENABLED: "0",
			CCFLARE_GUARD_CORRELATION_SECRET: "inherited-value-must-be-replaced",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exitCode = await Promise.race([
		new Promise<number | null>((resolve) => child.once("exit", resolve)),
		Bun.sleep(10_000).then(() => {
			throw new Error(`runner fixture timed out:\n${stdout}\n${stderr}`);
		}),
	]).finally(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	});
	if (exitCode !== 0) {
		throw new Error(
			`runner fixture exited ${exitCode}:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}
	const upstream = JSON.parse(
		readFileSync(join(captureDir, "upstream.json"), "utf8").trim(),
	);
	const guard = JSON.parse(
		readFileSync(join(captureDir, "guard.json"), "utf8").trim(),
	);
	return { upstream, guard, stdout, stderr };
}

describe("run-ccflare-stack guard correlation credential", () => {
	test(
		"generates one high-entropy per-stack secret, passes it only by child env, and rotates on restart",
		async () => {
			const fixtureDir = tempDir("ccflare-stack-fixture-");
			const programs = writeFixturePrograms(fixtureDir);
			const runnerSource = readFileSync(runnerScript, "utf8");

			// Prefix assignments are applied by the shell directly to the exec'd
			// child. An external `env NAME=secret command` helper would briefly
			// expose the secret as that helper's argv.
			expect(runnerSource).not.toMatch(/^env \\/m);
			expect(runnerSource).not.toContain("export guard_correlation_secret");
			expect(runnerSource).not.toMatch(
				/guard_correlation_secret.*(?:>|tee|printf|echo)/,
			);

			const first = await runStackInvocation(programs);
			const second = await runStackInvocation(programs);

			for (const invocation of [first, second]) {
				expect(invocation.upstream.secret).toBe(invocation.guard.secret);
				expect(invocation.upstream.secret).not.toBe(
					"inherited-value-must-be-replaced",
				);
				expect(invocation.upstream.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
				expect(
					Buffer.from(invocation.upstream.secret, "base64url"),
				).toHaveLength(32);
				expect(invocation.upstream.argv.join(" ")).not.toContain(
					invocation.upstream.secret,
				);
				expect(invocation.guard.argv.join(" ")).not.toContain(
					invocation.guard.secret,
				);
				expect(invocation.stdout).not.toContain(invocation.upstream.secret);
				expect(invocation.stderr).not.toContain(invocation.upstream.secret);
			}
			expect(second.upstream.secret).not.toBe(first.upstream.secret);
		},
		20_000,
	);
});
