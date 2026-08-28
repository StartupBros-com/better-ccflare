import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
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
			'import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
			'import http from "node:http";',
			'const portIndex = process.argv.indexOf("--port");',
			"const port = Number(process.argv[portIndex + 1]);",
			"const procDir = `${process.env.RUNNER_PROC_ROOT}/${process.pid}`;",
			'const procEnabled = process.env.FAKE_PROC_DISABLED !== "1";',
			"if (procEnabled) mkdirSync(procDir, { recursive: true });",
			'const starttime = String(process.env.FAKE_PROC_STARTTIME || "424242");',
			'if (procEnabled) writeFileSync(`${procDir}/stat`, `${process.pid} (fake-upstream) S ${Array(18).fill("0").join(" ")} ${starttime} 0\\n`);',
			"const rssControl = `${process.env.CAPTURE_DIR}/rss-kib`;",
			'const writeStatus = () => { if (!procEnabled) return; const rss = existsSync(rssControl) ? readFileSync(rssControl, "utf8").trim() : "1"; writeFileSync(`${procDir}/status`, `Name:\\tfake\\nVmRSS:\\t${rss} kB\\n`); };',
			"writeStatus();",
			"const rssTimer = procEnabled ? setInterval(writeStatus, 2) : undefined;",
			'appendFileSync(`${process.env.CAPTURE_DIR}/upstream.json`, JSON.stringify({ pid: process.pid, secret: process.env.CCFLARE_GUARD_CORRELATION_SECRET, logLevel: process.env.LOG_LEVEL, argv: process.argv }) + "\\n");',
			"appendFileSync(`${process.env.CAPTURE_DIR}/lifecycle.log`, `upstream-start ${process.pid}\\n`);",
			"const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });",
			"server.listen(port, '127.0.0.1');",
			"process.on('SIGTERM', () => { if (rssTimer) clearInterval(rssTimer); appendFileSync(`${process.env.CAPTURE_DIR}/lifecycle.log`, `upstream-term ${process.pid}\\n`); server.close(() => process.exit(0)); });",
		].join("\n"),
	);
	writeFileSync(
		guard,
		[
			'import { appendFileSync } from "node:fs";',
			'import http from "node:http";',
			'appendFileSync(`${process.env.CAPTURE_DIR}/guard.json`, JSON.stringify({ pid: process.pid, secret: process.env.CCFLARE_GUARD_CORRELATION_SECRET, argv: process.argv }) + "\\n");',
			"appendFileSync(`${process.env.CAPTURE_DIR}/lifecycle.log`, `guard-start ${process.pid}\\n`);",
			"const server = http.createServer((_req, res) => {",
			"  res.writeHead(200, { 'content-type': 'application/json' });",
			"  res.end('{}');",
			"});",
			"server.listen(Number(process.env.GUARD_PORT), '127.0.0.1');",
			"process.on('SIGTERM', () => { appendFileSync(`${process.env.CAPTURE_DIR}/lifecycle.log`, `guard-term ${process.pid}\\n`); if (process.env.FAKE_GUARD_IGNORE_TERM === '1') return; server.close(() => process.exit(Number(process.env.FAKE_GUARD_TERM_STATUS || 0))); });",
		].join("\n"),
	);
	chmodSync(upstream, 0o755);
	chmodSync(guard, 0o755);
	return { upstream, guard };
}

function writeGuardExitFixture(
	dir: string,
	exitCode: number,
): { upstream: string; guard: string } {
	const programs = writeFixturePrograms(dir);
	writeFileSync(
		programs.guard,
		[
			'import { appendFileSync } from "node:fs";',
			'import http from "node:http";',
			'appendFileSync(`${process.env.CAPTURE_DIR}/guard-exits.log`, JSON.stringify({ pid: process.pid }) + "\\n");',
			"const server = http.createServer((_req, res) => {",
			"  res.writeHead(200, { 'content-type': 'application/json' });",
			`  res.end('{}'); setTimeout(() => server.close(() => process.exit(${exitCode})), 5);`,
			"});",
			"server.listen(Number(process.env.GUARD_PORT), '127.0.0.1');",
			"process.on('SIGTERM', () => server.close(() => process.exit(0)));",
		].join("\n"),
	);
	chmodSync(programs.guard, 0o755);
	return programs;
}

function writeStubbornGuardFixture(dir: string): {
	upstream: string;
	guard: string;
} {
	const programs = writeFixturePrograms(dir);
	writeFileSync(
		programs.upstream,
		[
			"#!/usr/bin/env node",
			'import http from "node:http";',
			'const portIndex = process.argv.indexOf("--port");',
			"const port = Number(process.argv[portIndex + 1]);",
			"const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });",
			"server.listen(port, '127.0.0.1', () => setTimeout(() => server.close(() => process.exit(42)), 300));",
		].join("\n"),
	);
	writeFileSync(
		programs.guard,
		[
			'import http from "node:http";',
			"const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });",
			"server.listen(Number(process.env.GUARD_PORT), '127.0.0.1');",
			"// This fixture deliberately ignores TERM so failure cleanup must enforce its short budget.",
			"process.on('SIGTERM', () => {});",
		].join("\n"),
	);
	chmodSync(programs.upstream, 0o755);
	chmodSync(programs.guard, 0o755);
	return programs;
}

function writeStableFixturePrograms(dir: string): {
	upstream: string;
	guard: string;
} {
	const programs = writeFixturePrograms(dir);
	writeFileSync(
		programs.guard,
		[
			'import { appendFileSync } from "node:fs";',
			'import http from "node:http";',
			'appendFileSync(`${process.env.CAPTURE_DIR}/guard-stable.log`, "start\\n");',
			"const server = http.createServer((_req, res) => {",
			"  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');",
			"});",
			"server.listen(Number(process.env.GUARD_PORT), '127.0.0.1');",
			"process.on('SIGTERM', () => server.close(() => process.exit(0)));",
		].join("\n"),
	);
	chmodSync(programs.guard, 0o755);
	return programs;
}

function writeOptionalTunnelFixture(dir: string): string {
	const tunnel = join(dir, "fake-ssh-tunnel.mjs");
	writeFileSync(
		tunnel,
		[
			"#!/usr/bin/env node",
			'import { existsSync } from "node:fs";',
			'import http from "node:http";',
			"const exitFile = process.env.TUNNEL_EXIT_FILE;",
			"const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });",
			"server.listen(Number(process.env.AI_GATEWAY_LOCAL_PORT), '127.0.0.1');",
			"const stop = () => { server.close(() => process.exit(0)); };",
			"const timer = setInterval(() => { if (exitFile && existsSync(exitFile)) { clearInterval(timer); stop(); } }, 10);",
			"process.on('SIGTERM', stop);",
		].join("\n"),
	);
	chmodSync(tunnel, 0o755);
	return tunnel;
}

type SpawnedRunnerFixture = {
	child: ReturnType<typeof spawn>;
	captureDir: string;
	getOutput: () => { stdout: string; stderr: string };
};

async function spawnRunnerFixture(
	programs: { upstream: string; guard: string },
	extraEnv: Record<string, string> = {},
	options: { unsetLogLevel?: boolean } = {},
): Promise<SpawnedRunnerFixture> {
	const captureDir = tempDir("ccflare-stack-capture-");
	mkdirSync(captureDir, { recursive: true });
	const upstreamPort = await allocatePort();
	const guardPort = await allocatePort();
	const tunnelPort = await allocatePort();
	const child = spawn("bash", [runnerScript], {
		cwd: repoRoot,
		env: {
			...process.env,
			...(options.unsetLogLevel ? { LOG_LEVEL: undefined } : {}),
			CAPTURE_DIR: captureDir,
			CCFLARE_BIN: programs.upstream,
			GUARD_SCRIPT: programs.guard,
			NODE_BIN: process.execPath,
			CCFLARE_UPSTREAM_PORT: String(upstreamPort),
			GUARD_PORT: String(guardPort),
			AI_GATEWAY_LOCAL_PORT: String(tunnelPort),
			AI_GATEWAY_TUNNEL_ENABLED: "0",
			AI_GATEWAY_TUNNEL_REQUIRED: "1",
			CCFLARE_GUARD_CORRELATION_SECRET: "inherited-value-must-be-replaced",
			RUNNER_HEALTH_POLL_INTERVAL_MS: "10",
			RUNNER_HEALTH_MAX_ATTEMPTS: "100",
			RUNNER_HEALTH_STABILITY_DELAY_MS: "0",
			RUNNER_CIRCUIT_HOLD: "false",
			RUNNER_PROC_ROOT: join(captureDir, "proc"),
			...extraEnv,
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
	return {
		child,
		captureDir,
		getOutput: () => ({ stdout, stderr }),
	};
}

async function runStackInvocation(
	programs: { upstream: string; guard: string },
	extraEnv: Record<string, string> = {},
): Promise<{
	upstream: { secret: string; logLevel: string; argv: string[] };
	guard: { secret: string; argv: string[] };
	stdout: string;
	stderr: string;
}> {
	const runner = await spawnRunnerFixture(programs, extraEnv, {
		unsetLogLevel: true,
	});
	const { child, captureDir } = runner;
	const started = Date.now();
	while (
		(!existsSync(join(captureDir, "upstream.json")) ||
			!existsSync(join(captureDir, "guard.json"))) &&
		Date.now() - started < 10_000
	) {
		await Bun.sleep(10);
	}
	const { stdout, stderr } = runner.getOutput();
	if (
		!existsSync(join(captureDir, "upstream.json")) ||
		!existsSync(join(captureDir, "guard.json"))
	) {
		child.kill("SIGKILL");
		throw new Error(`runner fixture timed out:\n${stdout}\n${stderr}`);
	}
	child.kill("SIGTERM");
	const exitCode = await new Promise<number | null>((resolve) =>
		child.once("exit", resolve),
	);
	if (exitCode !== 143) {
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

async function spawnRunner(
	programs: { upstream: string; guard: string },
	extraEnv: Record<string, string> = {},
): Promise<SpawnedRunnerFixture> {
	return spawnRunnerFixture(programs, extraEnv);
}

async function waitForOutput(
	runner: Awaited<ReturnType<typeof spawnRunner>>,
	needle: string,
	timeoutMs = 5_000,
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (runner.getOutput().stdout.includes(needle)) return;
		if (runner.child.exitCode !== null || runner.child.signalCode !== null) {
			throw new Error(
				`runner exited before '${needle}': ${JSON.stringify(runner.getOutput())}`,
			);
		}
		await Bun.sleep(10);
	}
	throw new Error(
		`runner did not emit '${needle}': ${JSON.stringify(runner.getOutput())}`,
	);
}

async function waitForExit(
	child: ReturnType<typeof spawn>,
	timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return await Promise.race([
		new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve) => {
				child.once("exit", (code, signal) => resolve({ code, signal }));
			},
		),
		Bun.sleep(timeoutMs).then(() => {
			throw new Error("runner fixture did not exit in time");
		}),
	]);
}

function rssPolicy(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		RUNNER_RSS_THRESHOLD_BYTES: "10240",
		RUNNER_RSS_POLL_INTERVAL_MS: "10",
		RUNNER_RSS_MIN_UPTIME_MS: "0",
		RUNNER_RSS_CONSECUTIVE_SAMPLES: "1",
		RUNNER_RSS_RECYCLE_COOLDOWN_MS: "0",
		RUNNER_RSS_MAX_RECYCLES: "1",
		RUNNER_RSS_RECYCLE_WINDOW_MS: "10000",
		...overrides,
	};
}

function generationCount(
	runner: Awaited<ReturnType<typeof spawnRunner>>,
): number {
	const path = join(runner.captureDir, "upstream.json");
	if (!existsSync(path)) return 0;
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

async function waitForGenerationCount(
	runner: Awaited<ReturnType<typeof spawnRunner>>,
	count: number,
	timeoutMs = 5_000,
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (generationCount(runner) >= count) return;
		await Bun.sleep(10);
	}
	throw new Error(
		`runner did not reach generation ${count}: ${JSON.stringify(runner.getOutput())}`,
	);
}

function setRssKiB(
	runner: Awaited<ReturnType<typeof spawnRunner>>,
	rssKiB: number,
): void {
	writeFileSync(join(runner.captureDir, "rss-kib"), `${rssKiB}\n`);
}

async function stopRunner(
	runner: Awaited<ReturnType<typeof spawnRunner>>,
): Promise<void> {
	if (runner.child.exitCode === null && runner.child.signalCode === null) {
		runner.child.kill("SIGTERM");
		await waitForExit(runner.child, 5_000);
	}
}

describe("run-ccflare-stack upstream environment", () => {
	test("uses one owned sleep per RSS sample instead of the restart backoff slicer", () => {
		const source = readFileSync(runnerScript, "utf8");
		const watchdog = source.match(/rss_watchdog\(\) \{([\s\S]*?)\n\}/)?.[1];
		const wait = source.match(/wait_watchdog_interval\(\) \{([\s\S]*?)\n\}/)?.[1];
		expect(watchdog).toBeDefined();
		expect(watchdog).toContain(
			'wait_watchdog_interval "$RUNNER_RSS_POLL_INTERVAL_MS" || return 0',
		);
		expect(watchdog).not.toContain("sleep_ms");
		expect(wait).toContain("sleep_pid=$!");
		expect(wait).toContain("trap 'kill");
	});

	test("declares the complete fail-closed RSS watchdog contract", () => {
		const source = readFileSync(runnerScript, "utf8");
		for (const key of [
			"RUNNER_RSS_THRESHOLD_BYTES",
			"RUNNER_RSS_POLL_INTERVAL_MS",
			"RUNNER_RSS_MIN_UPTIME_MS",
			"RUNNER_RSS_CONSECUTIVE_SAMPLES",
			"RUNNER_RSS_RECYCLE_COOLDOWN_MS",
			"RUNNER_RSS_MAX_RECYCLES",
			"RUNNER_RSS_RECYCLE_WINDOW_MS",
			"RUNNER_PROC_ROOT",
		])
			expect(source).toContain(key);
		expect(source).toContain('child_exit_class="memory-recycle"');
		expect(source).toContain(
			'stop_child "ccflare guard" "$guard_pid" "$GUARD_STOP_BUDGET_MS"',
		);
	});
	test("defaults LOG_LEVEL to warn when it is unset", async () => {
		const fixtureDir = tempDir("ccflare-stack-log-level-default-fixture-");
		const programs = writeFixturePrograms(fixtureDir);

		const invocation = await runStackInvocation(programs);

		expect(invocation.upstream.logLevel).toBe("warn");
	});

	test("passes an explicit LOG_LEVEL override to upstream", async () => {
		const fixtureDir = tempDir("ccflare-stack-log-level-override-fixture-");
		const programs = writeFixturePrograms(fixtureDir);

		const invocation = await runStackInvocation(programs, {
			LOG_LEVEL: "info",
		});

		expect(invocation.upstream.logLevel).toBe("info");
	});
});

describe("run-ccflare-stack RSS containment behavior", () => {
	test("keeps the watchdog disabled when the tuple is omitted or threshold is zero", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-disabled-");
		const programs = writeFixturePrograms(fixtureDir);
		for (const env of [
			{ FAKE_PROC_DISABLED: "1" },
			{
				...rssPolicy({
					RUNNER_RSS_THRESHOLD_BYTES: "0",
					RUNNER_RSS_MAX_RECYCLES: "0",
				}),
				FAKE_PROC_DISABLED: "1",
			},
		]) {
			const runner = await spawnRunner(programs, env);
			try {
				await waitForOutput(runner, "ccflare stack ready");
				setRssKiB(runner, 1000);
				await Bun.sleep(80);
				expect(generationCount(runner)).toBe(1);
				expect(runner.getOutput().stdout).not.toContain("RSS recycle");
			} finally {
				await stopRunner(runner);
			}
		}
	}, 15_000);

	test("rejects a partial or malformed tuple before starting a child", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-invalid-");
		const programs = writeFixturePrograms(fixtureDir);
		for (const env of [
			{ RUNNER_RSS_THRESHOLD_BYTES: "10240" },
			rssPolicy({ RUNNER_RSS_CONSECUTIVE_SAMPLES: "bad" }),
			rssPolicy({ RUNNER_RSS_MAX_RECYCLES: "0" }),
		]) {
			const runner = await spawnRunner(programs, env);
			const result = await waitForExit(runner.child);
			expect(result.code).toBe(64);
			expect(generationCount(runner)).toBe(0);
		}
	});

	test("resets the high-water streak and recycles only after consecutive high samples", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-streak-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(
			programs,
			rssPolicy({
				RUNNER_RSS_POLL_INTERVAL_MS: "100",
				RUNNER_RSS_CONSECUTIVE_SAMPLES: "3",
			}),
		);
		try {
			setRssKiB(runner, 1);
			await waitForOutput(runner, "ccflare stack ready");
			setRssKiB(runner, 20);
			await Bun.sleep(130);
			setRssKiB(runner, 1);
			await Bun.sleep(130);
			setRssKiB(runner, 20);
			await Bun.sleep(130);
			expect(generationCount(runner)).toBe(1);
			await waitForOutput(runner, "RSS recycle trigger");
			await waitForGenerationCount(runner, 2);
			const output = runner.getOutput().stdout;
			expect(output).toContain(
				"memory recycle guard drain outcome=natural status=0",
			);
			expect(output).toContain("no_failure_backoff=true");
			expect(output).not.toContain("restarting stack via supervisor");
			const lifecycle = readFileSync(
				join(runner.captureDir, "lifecycle.log"),
				"utf8",
			)
				.trim()
				.split("\n");
			expect(
				lifecycle.findIndex((line) => line.startsWith("guard-term")),
			).toBeLessThan(
				lifecycle.findIndex((line) => line.startsWith("upstream-term")),
			);
		} finally {
			await stopRunner(runner);
		}
	}, 10_000);

	test("does not recycle below threshold and delays high RSS until minimum uptime", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-min-uptime-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(
			programs,
			rssPolicy({ RUNNER_RSS_MIN_UPTIME_MS: "120" }),
		);
		try {
			setRssKiB(runner, 1);
			await waitForOutput(runner, "ccflare stack ready");
			await Bun.sleep(40);
			expect(generationCount(runner)).toBe(1);
			setRssKiB(runner, 20);
			await Bun.sleep(50);
			expect(generationCount(runner)).toBe(1);
			await waitForGenerationCount(runner, 2);
		} finally {
			await stopRunner(runner);
		}
	}, 10_000);

	test("never triggers from a stale PID whose exact proc start-time identity changed", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-identity-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(programs, rssPolicy());
		try {
			setRssKiB(runner, 1);
			await waitForOutput(runner, "ccflare stack ready");
			const record = JSON.parse(
				readFileSync(join(runner.captureDir, "upstream.json"), "utf8").trim(),
			);
			writeFileSync(
				join(runner.captureDir, "proc", String(record.pid), "stat"),
				`${record.pid} (stale) S ${Array(18).fill("0").join(" ")} 999999 0\n`,
			);
			setRssKiB(runner, 20);
			await Bun.sleep(80);
			expect(generationCount(runner)).toBe(1);
			expect(runner.getOutput().stdout).not.toContain("RSS recycle trigger");
		} finally {
			await stopRunner(runner);
		}
	}, 10_000);

	test("records forced guard drain status and still performs a bounded restart", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-forced-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(programs, {
			...rssPolicy(),
			FAKE_GUARD_TERM_STATUS: "70",
			GUARD_TOTAL_DEADLINE_MS: "20",
			GUARD_RETRY_ATTEMPT_HEADROOM_MS: "1",
			GUARD_MAX_RECOVERY_SLEEP_MS: "1",
			GUARD_SHUTDOWN_GRACE_MS: "20",
			GUARD_SHUTDOWN_CUSHION_MS: "20",
		});
		try {
			setRssKiB(runner, 20);
			await waitForGenerationCount(runner, 2);
			expect(runner.getOutput().stdout).toContain(
				"memory recycle guard drain outcome=forced status=70",
			);
		} finally {
			await stopRunner(runner);
		}
	}, 10_000);

	test("bounds a memory recycle when the guard ignores TERM and reports an unknown drain", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-stubborn-guard-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(programs, {
			...rssPolicy(),
			FAKE_GUARD_IGNORE_TERM: "1",
			GUARD_TOTAL_DEADLINE_MS: "20",
			GUARD_RETRY_ATTEMPT_HEADROOM_MS: "1",
			GUARD_MAX_RECOVERY_SLEEP_MS: "1",
			GUARD_SHUTDOWN_GRACE_MS: "20",
			GUARD_SHUTDOWN_CUSHION_MS: "20",
			RUNNER_FAILURE_STOP_BUDGET_MS: "40",
			RUNNER_RESTART_MAX_FAILURES: "1",
		});
		setRssKiB(runner, 20);
		const result = await waitForExit(runner.child, 3_000);
		const output = runner.getOutput().stdout;
		expect(result.code).toBe(1);
		expect(output).toContain(
			"did not stop after 40ms during memory recycle; sending SIGKILL",
		);
		expect(output).toContain(
			"memory recycle failed: unknown guard drain status=",
		);
		expect(output).toContain("restart circuit open");
	}, 10_000);

	test("enforces recycle cooldown and cap without entering the failure restart loop", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-cap-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(
			programs,
			rssPolicy({
				RUNNER_RSS_RECYCLE_COOLDOWN_MS: "400",
				RUNNER_RSS_MAX_RECYCLES: "2",
			}),
		);
		try {
			setRssKiB(runner, 20);
			await waitForGenerationCount(runner, 2);
			await Bun.sleep(100);
			expect(generationCount(runner)).toBe(2);
			await waitForGenerationCount(runner, 3);
			await waitForOutput(runner, "RSS recycle suppressed; cap exhausted");
			await Bun.sleep(80);
			expect(generationCount(runner)).toBe(3);
			expect(runner.getOutput().stdout).not.toContain(
				"restarting stack via supervisor",
			);
		} finally {
			await stopRunner(runner);
		}
	}, 10_000);

	test("exits 143 promptly when SIGTERM arrives during a watchdog wait", async () => {
		const fixtureDir = tempDir("ccflare-stack-rss-term-");
		const programs = writeFixturePrograms(fixtureDir);
		const runner = await spawnRunner(
			programs,
			rssPolicy({ RUNNER_RSS_POLL_INTERVAL_MS: "1000" }),
		);
		await waitForOutput(runner, "ccflare stack ready");
		const sentAt = Date.now();
		runner.child.kill("SIGTERM");
		const result = await waitForExit(runner.child, 2_000);
		expect(result.code).toBe(143);
		expect(Date.now() - sentAt).toBeLessThan(800);
		expect(generationCount(runner)).toBe(1);
		expect(runner.getOutput().stdout).not.toContain("restarting stack");
	}, 10_000);
});

describe("run-ccflare-stack guard correlation credential", () => {
	test("generates one high-entropy per-stack secret, passes it only by child env, and rotates on restart", async () => {
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
			expect(Buffer.from(invocation.upstream.secret, "base64url")).toHaveLength(
				32,
			);
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
	}, 20_000);
});

describe("run-ccflare-stack supervisor lifecycle", () => {
	test("classifies an unexpected child failure and opens a bounded restart circuit", async () => {
			const fixtureDir = tempDir("ccflare-stack-failure-fixture-");
			const programs = writeGuardExitFixture(fixtureDir, 42);
			const runner = await spawnRunner(programs, {
				RUNNER_RESTART_BACKOFF_BASE_MS: "20",
				RUNNER_RESTART_BACKOFF_MAX_MS: "40",
				RUNNER_RESTART_MAX_FAILURES: "3",
				RUNNER_RESTART_WINDOW_MS: "10000",
				RUNNER_RESTART_STABLE_MS: "1000",
			});
			const result = await waitForExit(runner.child, 5_000);
			const output = runner.getOutput();

			expect(result.code).toBe(1);
			expect(output.stdout).toContain("class=failure");
			expect(output.stdout).toContain("child=ccflare guard");
			expect(output.stdout).toContain("restart circuit open");
			expect(output.stdout).toContain("backoff_ms=20");
			expect(output.stdout).toContain("backoff_ms=40");
		const starts = (
			output.stdout.match(/starting better-ccflare upstream/g) ?? []
		).length;
			expect(starts).toBe(3);
		const secrets = readFileSync(
			join(runner.captureDir, "upstream.json"),
			"utf8",
		)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).secret);
			expect(secrets).toHaveLength(3);
			expect(new Set(secrets).size).toBe(3);
	}, 10_000);

	test("bounds failure cleanup when the guard ignores TERM without shortening intentional stop grace", async () => {
			const fixtureDir = tempDir("ccflare-stack-stubborn-guard-fixture-");
			const programs = writeStubbornGuardFixture(fixtureDir);
			const runner = await spawnRunner(programs, {
				RUNNER_FAILURE_STOP_BUDGET_MS: "120",
				RUNNER_RESTART_BACKOFF_BASE_MS: "0",
				RUNNER_RESTART_BACKOFF_MAX_MS: "0",
				RUNNER_RESTART_MAX_FAILURES: "1",
				RUNNER_RESTART_WINDOW_MS: "1000",
			});
			const startedAt = Date.now();
			const result = await waitForExit(runner.child, 3_000);
			const elapsedMs = Date.now() - startedAt;
			const output = runner.getOutput();

			expect(result.code).toBe(1);
			expect(result.signal).toBeNull();
			expect(elapsedMs).toBeLessThan(1_500);
		expect(output.stdout).toContain("failure_cleanup_budget_ms=120");
			const forcedStop = output.stdout.match(
				/did not stop after (\d+)ms; sending SIGKILL/,
			);
			expect(forcedStop).not.toBeNull();
			expect(Number(forcedStop?.[1])).toBeLessThanOrEqual(120);
			expect(output.stdout).toContain("restart circuit open");
			expect(output.stdout).toContain("intentional_stop_budget_ms=605000");
	}, 8_000);

	test("treats a runner SIGTERM as intentional and never restarts the stack", async () => {
			const fixtureDir = tempDir("ccflare-stack-term-fixture-");
			const programs = writeStableFixturePrograms(fixtureDir);
			const runner = await spawnRunner(programs, {
				RUNNER_RESTART_BACKOFF_BASE_MS: "20",
				RUNNER_RESTART_MAX_FAILURES: "3",
			});
			await waitForOutput(runner, "ccflare stack ready");
			expect(runner.child.kill("SIGTERM")).toBe(true);
			const result = await waitForExit(runner.child, 5_000);
			const output = runner.getOutput();

			expect(result.code).toBe(143);
			expect(output.stdout).toContain("shutdown requested");
			expect(output.stdout).not.toContain("restart circuit open");
			expect(output.stdout).not.toContain("restarting stack");
	}, 10_000);

	test("interrupts a restart backoff promptly on an intentional SIGTERM", async () => {
			const fixtureDir = tempDir("ccflare-stack-backoff-term-fixture-");
			const programs = writeGuardExitFixture(fixtureDir, 42);
			const runner = await spawnRunner(programs, {
				RUNNER_RESTART_BACKOFF_BASE_MS: "1000",
				RUNNER_RESTART_BACKOFF_MAX_MS: "1000",
				RUNNER_RESTART_MAX_FAILURES: "5",
			});
			await waitForOutput(runner, "backoff_ms=1000");
			const sentAt = Date.now();
			expect(runner.child.kill("SIGTERM")).toBe(true);
			const result = await waitForExit(runner.child, 2_000);

			expect(result.code).toBe(143);
			expect(Date.now() - sentAt).toBeLessThan(1_000);
	}, 10_000);

	test("supervises a child that exits zero without a runner shutdown signal", async () => {
			const fixtureDir = tempDir("ccflare-stack-clean-exit-fixture-");
			const programs = writeGuardExitFixture(fixtureDir, 0);
			const runner = await spawnRunner(programs, {
				RUNNER_RESTART_BACKOFF_BASE_MS: "10",
				RUNNER_RESTART_BACKOFF_MAX_MS: "20",
				RUNNER_RESTART_MAX_FAILURES: "2",
				RUNNER_RESTART_WINDOW_MS: "1000",
				RUNNER_RESTART_STABLE_MS: "1000",
			});
			const result = await waitForExit(runner.child, 5_000);
			const output = runner.getOutput();

			expect(result.code).toBe(1);
			expect(output.stdout).toContain("class=clean");
			expect(output.stdout).toContain("restarting stack via supervisor");
			expect(output.stdout).toContain("restart circuit open");
		const starts = (
			output.stdout.match(/starting better-ccflare upstream/g) ?? []
		).length;
			expect(starts).toBe(2);
	}, 10_000);

	test("keeps a required tunnel fail-closed while applying the bounded restart cap", async () => {
			const fixtureDir = tempDir("ccflare-stack-required-tunnel-fixture-");
			const programs = writeStableFixturePrograms(fixtureDir);
			const runner = await spawnRunner(programs, {
				AI_GATEWAY_TUNNEL_ENABLED: "1",
				AI_GATEWAY_TUNNEL_REQUIRED: "1",
				AI_GATEWAY_SSH_HOST: "127.0.0.1",
				AI_GATEWAY_LOCAL_PORT: "1",
				AI_GATEWAY_REMOTE_PORT: "1",
				AI_GATEWAY_TUNNEL_READY_ATTEMPTS: "1",
				AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS: "1",
				AI_GATEWAY_SSH_CONNECT_TIMEOUT_SECONDS: "1",
				RUNNER_RESTART_BACKOFF_BASE_MS: "10",
				RUNNER_RESTART_BACKOFF_MAX_MS: "20",
				RUNNER_RESTART_MAX_FAILURES: "2",
				RUNNER_RESTART_WINDOW_MS: "1000",
				RUNNER_RESTART_STABLE_MS: "1000",
			});
			const result = await waitForExit(runner.child, 8_000);
			const output = runner.getOutput();

			expect(result.code).toBe(1);
			expect(output.stdout).toContain("ai-gateway tunnel is required");
			expect(output.stdout).toContain("restart circuit open");
			expect(output.stdout).not.toContain("starting better-ccflare upstream");
	}, 12_000);

	test("supervises an optional tunnel after startup and restarts on tunnel death", async () => {
			const fixtureDir = tempDir("ccflare-stack-optional-tunnel-fixture-");
			const programs = writeStableFixturePrograms(fixtureDir);
			const tunnel = writeOptionalTunnelFixture(fixtureDir);
			const tunnelExitFile = join(fixtureDir, "stop-tunnel");
			const runner = await spawnRunner(programs, {
				AI_GATEWAY_TUNNEL_ENABLED: "1",
				AI_GATEWAY_TUNNEL_REQUIRED: "0",
				AI_GATEWAY_SSH_BIN: tunnel,
				AI_GATEWAY_SSH_HOST: "fixture",
				AI_GATEWAY_TUNNEL_READY_ATTEMPTS: "100",
				AI_GATEWAY_TUNNEL_POLL_INTERVAL_MS: "10",
				TUNNEL_EXIT_FILE: tunnelExitFile,
				RUNNER_RESTART_BACKOFF_BASE_MS: "10",
				RUNNER_RESTART_BACKOFF_MAX_MS: "20",
				RUNNER_RESTART_MAX_FAILURES: "3",
				RUNNER_RESTART_WINDOW_MS: "1000",
			});
			await waitForOutput(runner, "ccflare stack ready");
			writeFileSync(tunnelExitFile, "stop\n");
			await waitForOutput(runner, "child=ai-gateway ssh tunnel");
			await waitForOutput(runner, "restarting stack via supervisor");
			const restartStartedAt = Date.now();
			while (
			(runner.getOutput().stdout.match(/starting ai-gateway tunnel/g) ?? [])
				.length < 2 &&
				Date.now() - restartStartedAt < 5_000
			) {
				await Bun.sleep(10);
			}
			expect(runner.child.kill("SIGTERM")).toBe(true);
			const result = await waitForExit(runner.child, 5_000);
			const output = runner.getOutput();

			expect(result.code).toBe(143);
			expect(output.stdout).toContain("class=clean");
			expect(
				(output.stdout.match(/starting ai-gateway tunnel/g) ?? []).length,
			).toBeGreaterThanOrEqual(2);
	}, 12_000);

	test("exits with a bounded circuit status under a service auto invocation", async () => {
			const fixtureDir = tempDir("ccflare-stack-circuit-auto-fixture-");
			const programs = writeGuardExitFixture(fixtureDir, 42);
			const runner = await spawnRunner(programs, {
				// systemd sets INVOCATION_ID. Auto mode must exit with a distinct
				// failure so Restart=on-failure and StartLimit own recovery; it must
				// never report an active service while its children are down.
				INVOCATION_ID: "fixture-invocation",
				RUNNER_CIRCUIT_HOLD: "auto",
				RUNNER_RESTART_BACKOFF_BASE_MS: "10",
				RUNNER_RESTART_BACKOFF_MAX_MS: "20",
				RUNNER_RESTART_MAX_FAILURES: "2",
				RUNNER_RESTART_WINDOW_MS: "1000",
			});
			const result = await waitForExit(runner.child, 5_000);
			const output = runner.getOutput();

			expect(result.code).toBe(75);
			expect(result.signal).toBeNull();
			expect(output.stdout).toContain(
				"restart circuit open; exiting for service supervisor",
			);
			expect(output.stdout).not.toContain("paused until operator restart");
			expect(
				(output.stdout.match(/starting better-ccflare upstream/g) ?? []).length,
			).toBe(2);

			const upstreamRecords = readFileSync(
				join(runner.captureDir, "upstream.json"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { pid: number });
			const guardRecords = readFileSync(
				join(runner.captureDir, "guard-exits.log"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { pid: number });
			const processStillExists = (pid: number): boolean => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			for (const record of [...upstreamRecords, ...guardRecords]) {
				expect(processStillExists(record.pid)).toBe(false);
			}
	}, 10_000);

	test("holds an explicitly requested circuit until an operator TERM", async () => {
			const fixtureDir = tempDir("ccflare-stack-circuit-hold-fixture-");
			const programs = writeGuardExitFixture(fixtureDir, 42);
			const runner = await spawnRunner(programs, {
				// Explicit hold is retained for operator-controlled one-shot fixtures;
				// production auto mode exits for systemd's bounded restart policy.
				INVOCATION_ID: "",
				RUNNER_CIRCUIT_HOLD: "true",
				RUNNER_RESTART_BACKOFF_BASE_MS: "10",
				RUNNER_RESTART_BACKOFF_MAX_MS: "20",
				RUNNER_RESTART_MAX_FAILURES: "2",
				RUNNER_RESTART_WINDOW_MS: "1000",
			});
			await waitForOutput(
				runner,
				"restart circuit open; supervisor paused until operator restart",
				5_000,
			);
		const startsBefore = (
			runner.getOutput().stdout.match(/starting better-ccflare upstream/g) ?? []
		).length;
			expect(startsBefore).toBe(2);
			expect(runner.child.kill("SIGTERM")).toBe(true);
			const result = await waitForExit(runner.child, 5_000);
			await Bun.sleep(50);
			const output = runner.getOutput();

			expect(result.code).toBe(143);
			expect(
				(output.stdout.match(/starting better-ccflare upstream/g) ?? []).length,
			).toBe(startsBefore);
			expect(output.stdout).toContain("shutdown requested");
	}, 10_000);

	test("ignores explicit hold under a systemd invocation", async () => {
		const fixtureDir = tempDir(
			"ccflare-stack-circuit-service-override-fixture-",
		);
			const programs = writeGuardExitFixture(fixtureDir, 42);
			const runner = await spawnRunner(programs, {
				INVOCATION_ID: "fixture-invocation",
				RUNNER_CIRCUIT_HOLD: "true",
				RUNNER_RESTART_BACKOFF_BASE_MS: "10",
				RUNNER_RESTART_BACKOFF_MAX_MS: "10",
				RUNNER_RESTART_MAX_FAILURES: "1",
				RUNNER_RESTART_WINDOW_MS: "1000",
			});
			const result = await waitForExit(runner.child, 5_000);
			const output = runner.getOutput();

			expect(result.code).toBe(75);
			expect(output.stdout).toContain(
				"restart circuit open; exiting for service supervisor",
			);
			expect(output.stdout).not.toContain("paused until operator restart");
	}, 10_000);
});
