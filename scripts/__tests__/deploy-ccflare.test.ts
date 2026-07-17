import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const deployScript = join(repoRoot, "scripts", "deploy-ccflare.sh");
const helperScriptForShell = "scripts/deploy-ccflare-lib.sh";
const runnerScript = join(repoRoot, "scripts", "run-ccflare-stack.sh");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-deploy-test-"));
	tempDirs.push(dir);
	return dir;
}

function bash(script: string) {
	return Bun.spawnSync(["bash", "-c", script], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function wslUncPath(value: string): string | null {
	const normalized = value.replaceAll("\\", "/");
	const match = normalized.match(
		/^\/{1,2}wsl(?:\.localhost|\$)\/[^/]+(?<linuxPath>\/.*)?$/i,
	);
	if (!match) return null;
	return match.groups?.linuxPath ?? "/";
}

function shellPath(value: string): string {
	if (process.platform !== "win32") return value;
	// Windows Bun exposes a WSL workspace as a UNC path. Passing that path
	// through `bash -c` can collapse its leading `\\` to `\`, which makes
	// wslpath reject it. The UNC components after the distro are already the
	// absolute Linux path, so normalize that form directly. Keep wslpath/cygpath
	// for ordinary Windows drive and network paths.
	const directWslPath = wslUncPath(value);
	if (directWslPath !== null) return directWslPath;
	const quoted = shellQuote(value);
	const result = bash(
		[
			"if command -v wslpath >/dev/null 2>&1; then",
			`  wslpath -a ${quoted}`,
			"elif command -v cygpath >/dev/null 2>&1; then",
			`  cygpath -u ${quoted}`,
			"else",
			'  echo "bash has neither wslpath nor cygpath" >&2',
			"  exit 127",
			"fi",
		].join("\n"),
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`failed to convert Windows path for bash: ${result.stderr.toString().trim()}`,
		);
	}
	const converted = result.stdout.toString().trim();
	if (!converted.startsWith("/")) {
		throw new Error(`bash returned a non-POSIX path: ${converted}`);
	}
	return converted;
}

function bashChildEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env, ...overrides };
	if (process.platform === "win32") {
		// Windows' WSL launcher only imports custom variables named in WSLENV.
		// Preserve any caller-provided bridge entries and add this fixture's exact
		// overrides so the runner sees the same environment as a native Linux spawn.
		const bridged = new Set(
			(env.WSLENV ?? "").split(":").filter((entry) => entry.length > 0),
		);
		for (const name of Object.keys(overrides)) bridged.add(name);
		env.WSLENV = [...bridged].join(":");
	}
	return env;
}

async function allocatePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("failed to allocate a fixture port");
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	message: string | (() => string),
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(typeof message === "function" ? message() : message);
		}
		await Bun.sleep(10);
	}
}

function repoRootDeployTestArtifacts(): string[] {
	return readdirSync(repoRoot)
		.filter(
			(name) =>
				name.includes("ccflare-deploy-test-") &&
				name.endsWith("pin.rendered.conf"),
		)
		.sort();
}

describe("render_systemd_pin", () => {
	test("atomically-rendered content upserts deploy-owned keys and preserves all others", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		writeFileSync(
			input,
			[
				"[Service]",
				"Environment=KEEP_ME=unchanged",
				"Environment=CCFLARE_BIN=/old/bin",
				"Environment=GUARD_SCRIPT=/old/guard.mjs",
				"Environment=GUARD_SCRIPT=/duplicate/guard.mjs",
				"ExecStart=/home/will/legacy-runner.sh",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin /new/runners/abc/run-ccflare-stack.sh /new/guards/abc/ccflare-guard.mjs abc123 pool-exhaustion-finite-recovery-v1`,
			].join("\n"),
		);

		expect(repoRootDeployTestArtifacts()).toEqual([]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(readFileSync(output, "utf8")).toBe(
			[
				"[Service]",
				"Environment=KEEP_ME=unchanged",
				"Environment=CCFLARE_BIN=/new/bin",
				"Environment=GUARD_SCRIPT=/new/guards/abc/ccflare-guard.mjs",
				"Environment=GUARD_SOURCE_ID=abc123",
				"Environment=GUARD_POLICY_ID=pool-exhaustion-finite-recovery-v1",
				"ExecStart=",
				"ExecStart=/new/runners/abc/run-ccflare-stack.sh",
				"",
			].join("\n"),
		);
	});
});

describe("validate_deploy_health", () => {
	test("requires exact digests, runtime paths, process identity, and effective limits", () => {
		const expected = JSON.stringify({
			proxyGitSha: "abc123",
			sourceId: "full-sha",
			policyId: "pool-exhaustion-finite-recovery-v1",
			runnerPid: 42,
			artifacts: {
				binary: { path: "/artifacts/bin", sha256: "bin-digest" },
				runner: { path: "/artifacts/runner", sha256: "runner-digest" },
				guard: { path: "/artifacts/guard", sha256: "guard-digest" },
				policy: { path: "/artifacts/policy", sha256: "policy-digest" },
			},
			limits: {
				totalDeadlineMs: 120_000,
				maxAttempts: 3,
				jitterMs: 2_000,
				maxInspectionBytes: 65_536,
			},
		});
		const proxy = JSON.stringify({ git_sha: "abc123" });
		const guard = JSON.stringify({
			sourceId: "full-sha",
			policyId: "pool-exhaustion-finite-recovery-v1",
			runtime: {
				process: { runnerPid: 42 },
				artifacts: {
					binary: { path: "/artifacts/bin", sha256: "bin-digest" },
					runner: {
						path: "/artifacts/runner",
						sha256: "runner-digest",
					},
					guard: { path: "/artifacts/guard", sha256: "guard-digest" },
					policy: {
						path: "/artifacts/policy",
						sha256: "policy-digest",
					},
				},
				limits: {
					totalDeadlineMs: 120_000,
					maxAttempts: 3,
					jitterMs: 2_000,
					maxInspectionBytes: 65_536,
				},
			},
		});
		const good = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`validate_deploy_health ${shellQuote(proxy)} ${shellQuote(guard)} ${shellQuote(expected)}`,
			].join("\n"),
		);
		expect(good.exitCode).toBe(0);

		for (const [needle, replacement] of [
			['"git_sha":"abc123"', '"git_sha":"wrong"'],
			['"runnerPid":42', '"runnerPid":99'],
			['"sha256":"guard-digest"', '"sha256":"wrong"'],
			['"maxAttempts":3', '"maxAttempts":9'],
		] as const) {
			const bad = bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`validate_deploy_health ${shellQuote(proxy.replace(needle, replacement))} ${shellQuote(guard.replace(needle, replacement))} ${shellQuote(expected)}`,
				].join("\n"),
			);
			expect(bad.exitCode).not.toBe(0);
		}
	});
});

describe("rollback identity proof", () => {
	test("returns hard-failure 70 when prior identity is absent or differs", () => {
		const proxy = '{"git_sha":"old"}';
		const completeGuard = JSON.stringify({
			sourceId: "old-source",
			policyId: "old-policy",
			runtime: {
				artifacts: {
					binary: { path: "/b", sha256: "b" },
					runner: { path: "/r", sha256: "r" },
					guard: { path: "/g", sha256: "g" },
					policy: { path: "/p", sha256: "p" },
				},
				limits: {
					totalDeadlineMs: 120_000,
					maxAttempts: 3,
					jitterMs: 2_000,
					maxInspectionBytes: 65_536,
				},
			},
		});
		const good = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`validate_rollback_health ${shellQuote(proxy)} ${shellQuote(completeGuard)} ${shellQuote(proxy)} ${shellQuote(completeGuard)}`,
			].join("\n"),
		);
		expect(good.exitCode).toBe(0);

		for (const [priorGuard, currentGuard] of [
			['{"sourceId":"legacy"}', completeGuard],
			[
				completeGuard,
				completeGuard.replace('"sha256":"r"', '"sha256":"wrong"'),
			],
		] as const) {
			const bad = bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`validate_rollback_health ${shellQuote(proxy)} ${shellQuote(priorGuard)} ${shellQuote(proxy)} ${shellQuote(currentGuard)}`,
				].join("\n"),
			);
			expect(bad.exitCode).toBe(70);
		}
	});
});

describe("process start identity", () => {
	test("resolves the actual runner path from proc cmdline", () => {
		const root = tempDir();
		const procRoot = join(root, "proc");
		const pidDir = join(procRoot, "42");
		const runner = join(root, "run-ccflare-stack.sh");
		mkdirSync(pidDir, { recursive: true });
		writeFileSync(runner, "#!/usr/bin/env bash\n");
		writeFileSync(
			join(pidDir, "cmdline"),
			Buffer.from(`/usr/bin/bash\0${shellPath(runner)}\0`),
		);

		const good = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`verify_process_start_identity 42 ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(procRoot))}`,
			].join("\n"),
		);
		expect(good.exitCode).toBe(0);

		const bad = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`verify_process_start_identity 42 /wrong/runner ${shellQuote(shellPath(procRoot))}`,
			].join("\n"),
		);
		expect(bad.exitCode).not.toBe(0);
	});
});

describe("guard_prune_candidates", () => {
	test("keeps the newest window plus both the deployed and pinned guard directories", () => {
		const root = tempDir();
		const names = ["aaaaaaa", "bbbbbbb", "ccccccc", "ddddddd", "eeeeeee"];
		for (const [index, name] of names.entries()) {
			const dir = join(root, name);
			mkdirSync(dir);
			writeFileSync(join(dir, "ccflare-guard.mjs"), "guard");
			writeFileSync(join(dir, "ccflare-guard-policy.mjs"), "policy");
			utimesSync(dir, index + 1, index + 1);
		}
		mkdirSync(join(root, "not-a-sha"));
		const shellRoot = shellPath(root);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`guard_prune_candidates ${shellQuote(shellRoot)} ${shellQuote(`${shellRoot}/aaaaaaa`)} ${shellQuote(`${shellRoot}/bbbbbbb`)} 2`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim().split("\n")).toEqual([
			`${shellRoot}/ccccccc`,
		]);
	});
});

describe("source-controlled stack runner", () => {
	test("validates the shared guard shutdown grace before starting children", () => {
		for (const value of ["-1", "12ms"]) {
			const invalid = bash(
				`GUARD_SHUTDOWN_GRACE_MS=${shellQuote(value)} CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
			);
			expect(invalid.exitCode).toBe(64);
			expect(invalid.stdout.toString()).toContain(
				`invalid GUARD_SHUTDOWN_GRACE_MS=${value}`,
			);
		}

		const zero = bash(
			`GUARD_SHUTDOWN_GRACE_MS=0 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(zero.exitCode).not.toBe(64);
	});

	test("pins bounded guard limits and retains tunnel and lifecycle supervision", () => {
		const source = readFileSync(runnerScript, "utf8");
		expect(source).toContain("GUARD_TOTAL_DEADLINE_MS=120000");
		expect(source).toContain("GUARD_MAX_ATTEMPTS=3");
		expect(source).toContain("GUARD_RETRY_JITTER_MS=2000");
		expect(source).toContain("GUARD_MAX_INSPECTION_BYTES=65536");
		expect(source).toContain("start_ai_gateway_tunnel");
		expect(source).toContain('GUARD_UPSTREAM_PID="${upstream_pid}"');
		expect(source).toContain('wait -n "$upstream_pid" "$guard_pid"');
		expect(source).toContain(
			'stop_child "better-ccflare upstream" "$upstream_pid" 5000',
		);
		expect(source).toContain(
			'stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" 5000',
		);
	});

	test("requires an HTTP-success response from gateway health", () => {
		const source = readFileSync(runnerScript, "utf8");
		expect(source).toContain(
			'curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:${AI_GATEWAY_LOCAL_PORT}/health"',
		);
	});

	test("gives the guard its configured drain plus cushion before short child shutdowns", async () => {
		const dir = tempDir();
		const fixture = join(dir, "stubborn-stack-child.mjs");
		const eventsFile = join(dir, "events.log");
		const runnerPidFile = join(dir, "runner.pid");
		writeFileSync(
			fixture,
			`#!/usr/bin/node
import { appendFileSync } from "node:fs";
import http from "node:http";

const role = process.argv.includes("--serve") ? "upstream" : "guard";
const port = Number(role === "guard" ? process.env.GUARD_PORT : process.env.PORT);
const eventsFile = process.env.FIXTURE_EVENTS;
const record = (event) => appendFileSync(
  eventsFile,
  [role, event, Date.now(), process.env.GUARD_SHUTDOWN_GRACE_MS || ""].join(":") + "\\n",
);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"status":"ok"}');
});
server.listen(port, "127.0.0.1", () => record("start"));
process.on("SIGTERM", () => {
  record("term");
  if (role === "upstream") server.close(() => process.exit(0));
});
`,
		);
		chmodSync(fixture, 0o755);

		const upstreamPort = await allocatePort();
		const guardPort = await allocatePort();
		const runner = spawn(
			"bash",
			[
				"-c",
				[
					`printf '%s\\n' "$$" > ${shellQuote(shellPath(runnerPidFile))}`,
					`exec bash ${shellQuote(shellPath(runnerScript))}`,
				].join("\n"),
			],
			{
				cwd: repoRoot,
				detached: process.platform !== "win32",
				env: bashChildEnv({
					HOME: dir,
					USER: "ccflare-test",
					CCFLARE_BIN: shellPath(fixture),
					GUARD_SCRIPT: shellPath(fixture),
					NODE_BIN: "/usr/bin/node",
					CCFLARE_UPSTREAM_PORT: String(upstreamPort),
					GUARD_PORT: String(guardPort),
					AI_GATEWAY_TUNNEL_ENABLED: "0",
					AI_GATEWAY_TUNNEL_REQUIRED: "0",
					GUARD_SHUTDOWN_GRACE_MS: "240",
					GUARD_SHUTDOWN_CUSHION_MS: "120",
					FIXTURE_EVENTS: shellPath(eventsFile),
				}),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		runner.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		runner.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		try {
			await waitFor(
				() => stdout.includes("ccflare stack ready"),
				5_000,
				() => `runner did not become ready:\n${stdout}\n${stderr}`,
			);
			const exit = new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
				at: number;
			}>(
				(resolve) => {
					runner.once("exit", (code, signal) =>
						resolve({ code, signal, at: Date.now() }),
					);
				},
			);
			if (process.platform === "win32") {
				// child_process.kill terminates the Windows interop wrapper without
				// delivering SIGTERM to the Linux process. Signal the recorded WSL PID
				// so the runner's real shutdown trap and child ordering are exercised.
				const stop = bash(
					`kill -TERM "$(cat ${shellQuote(shellPath(runnerPidFile))})"`,
				);
				expect(stop.exitCode).toBe(0);
			} else {
				runner.kill("SIGTERM");
			}
			const result = await Promise.race([
				exit,
				Bun.sleep(15_000).then(() => {
					throw new Error(`runner did not terminate:\n${stdout}\n${stderr}`);
				}),
			]);

			expect({ code: result.code, signal: result.signal }).toEqual({
				code: 143,
				signal: null,
			});
			const events = readFileSync(eventsFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => {
					const [role, event, timestamp, grace] = line.split(":");
					return { role, event, timestamp: Number(timestamp), grace };
				});
			const guardStart = events.find(
				(entry) => entry.role === "guard" && entry.event === "start",
			);
			const guardTerm = events.find(
				(entry) => entry.role === "guard" && entry.event === "term",
			);
			const upstreamTerm = events.find(
				(entry) => entry.role === "upstream" && entry.event === "term",
			);
			expect(guardStart?.grace).toBe("240");
			expect(guardTerm).toBeDefined();
			expect(upstreamTerm).toBeDefined();
			const guardStopMs =
				(upstreamTerm?.timestamp ?? 0) - (guardTerm?.timestamp ?? 0);
			expect(guardStopMs).toBeGreaterThanOrEqual(360);
			expect(guardStopMs).toBeLessThan(1_500);
			const upstreamStopMs = result.at - (upstreamTerm?.timestamp ?? 0);
			expect(upstreamStopMs).toBeLessThan(1_000);
			expect(stdout).toContain("ccflare guard");
			expect(stdout).toContain("did not stop after 360ms; sending SIGKILL");
			expect(stdout).toContain("better-ccflare upstream");
			expect(
				stdout
					.split("\n")
					.some(
						(line) =>
							line.includes("better-ccflare upstream") &&
							line.includes("SIGKILL"),
					),
			).toBe(false);
		} finally {
			if (runner.exitCode === null && runner.signalCode === null) {
				runner.kill("SIGKILL");
			}
			if (process.platform !== "win32" && runner.pid) {
				try {
					process.kill(-runner.pid, "SIGKILL");
				} catch {
					// The process group is already gone after a successful cleanup.
				}
			}
		}
	}, 20_000);
});

describe("deployment flow safety contracts", () => {
	test("check-only exits before build, sudo, artifact installation, or restart", () => {
		const source = readFileSync(deployScript, "utf8");
		const checkExit = source.indexOf('if [[ "$CHECK_ONLY" == "1" ]]');
		expect(checkExit).toBeGreaterThan(0);
		for (const marker of [
			"flock -n",
			"bun run build",
			"GUARD_DIR=",
			"sudo cp",
			"systemctl restart ccflare-stack.service",
		]) {
			expect(source.indexOf(marker, checkExit + 1)).toBeGreaterThan(checkExit);
		}
	});

	test("full deployment has rollback and exact dual-health verification", () => {
		const source = readFileSync(deployScript, "utf8");
		expect(source).toContain('GUARD_DIR="${GUARDS_ROOT}/${HEAD_SHA}"');
		expect(source).toContain('RUNNER_DIR="${RUNNERS_ROOT}/${HEAD_SHA}"');
		expect(source).toContain(
			'SOURCE_RUNNER="$REPO_ROOT/scripts/run-ccflare-stack.sh"',
		);
		expect(source).toContain('GUARD_SOURCE_ID="$HEAD_SHA"');
		expect(source).toContain(
			'GUARD_POLICY_ID="pool-exhaustion-finite-recovery-v1"',
		);
		expect(source).toContain('PIN_STAGED="${PIN}.new-${SHORT}-$$"');
		expect(source).toContain('sudo mv -f "$PIN_STAGED" "$PIN"');
		expect(source).toContain(
			'cp "$SOURCE_GUARD_POLICY" "$GUARD_STAGE_DIR/ccflare-guard-policy.mjs"',
		);
		expect(source).toContain('mv "$GUARD_STAGE_DIR" "$GUARD_DIR"');
		expect(source).toContain("trap 'rollback_on_failure $?' EXIT");
		expect(source).toContain(
			'sudo cp --preserve=all "$PIN_BACKUP" "$rollback_stage"',
		);
		expect(source).toContain("sudo systemctl restart ccflare-stack.service");
		expect(source).toContain("validate_deploy_health");
		expect(source).toContain("verify_process_start_identity");
		expect(source).toContain("ROLLBACK_HARD_FAILURE=70");
		expect(source).toContain('exit "$ROLLBACK_HARD_FAILURE"');

		const backup = source.indexOf(
			'sudo cp --preserve=all "$PIN" "$PIN_BACKUP"',
		);
		const rollbackArmed = source.indexOf("PIN_ROLLBACK_ARMED=1", backup);
		const pinRender = source.indexOf("render_systemd_pin", rollbackArmed);
		const restart = source.indexOf(
			"sudo systemctl restart ccflare-stack.service",
			pinRender,
		);
		const verify = source.indexOf("if ! validate_deploy_health", restart);
		const hardFailure = source.indexOf("exit 1", verify);
		expect(backup).toBeGreaterThan(0);
		expect(rollbackArmed).toBeGreaterThan(backup);
		expect(pinRender).toBeGreaterThan(rollbackArmed);
		expect(restart).toBeGreaterThan(pinRender);
		expect(verify).toBeGreaterThan(restart);
		expect(hardFailure).toBeGreaterThan(verify);
	});
});
