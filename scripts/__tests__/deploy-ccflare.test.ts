import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
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

function bashAt(cwd: string, script: string) {
	return Bun.spawnSync(["bash", "-c", script], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function gitAt(cwd: string, ...args: string[]) {
	return Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function expectCommandOk(result: ReturnType<typeof Bun.spawnSync>): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`command failed (${result.exitCode}):\n${result.stdout.toString()}\n${result.stderr.toString()}`,
		);
	}
}

function createDisposableDeployRepo(): {
	checkout: string;
	remote: string;
} {
	const root = tempDir();
	const remote = join(root, "origin.git");
	const checkout = join(root, "checkout");
	mkdirSync(remote);
	mkdirSync(checkout);
	expectCommandOk(gitAt(remote, "init", "--bare"));
	expectCommandOk(gitAt(checkout, "init", "-b", "main"));
	expectCommandOk(gitAt(checkout, "config", "user.name", "Deploy Test"));
	expectCommandOk(
		gitAt(checkout, "config", "user.email", "deploy-test@example.invalid"),
	);
	mkdirSync(join(checkout, "scripts"));
	copyFileSync(deployScript, join(checkout, "scripts", "deploy-ccflare.sh"));
	copyFileSync(
		join(repoRoot, helperScriptForShell),
		join(checkout, helperScriptForShell),
	);
	writeFileSync(
		join(checkout, "package.json"),
		'{"name":"deploy-fixture","version":"1.0.0"}\n',
	);
	mkdirSync(join(checkout, "apps", "cli"), { recursive: true });
	writeFileSync(
		join(checkout, "apps", "cli", "package.json"),
		'{"name":"deploy-fixture-cli","version":"1.0.0"}\n',
	);
	expectCommandOk(gitAt(checkout, "add", "scripts", "package.json", "apps"));
	expectCommandOk(gitAt(checkout, "commit", "-m", "fixture"));
	expectCommandOk(gitAt(checkout, "remote", "add", "origin", remote));
	expectCommandOk(
		gitAt(
			checkout,
			"push",
			"--set-upstream",
			"origin",
			"refs/heads/main:refs/heads/main",
		),
	);
	return { checkout, remote };
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

async function startGatewayFixture(rawResponse: string): Promise<{
	port: number;
	close: () => Promise<void>;
}> {
	const server = createServer((socket) => {
		socket.end(rawResponse);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("failed to start gateway fixture");
	}
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

function gatewayHttpResponse(status: number): string {
	const body =
		status === 401
			? '{"type":"auth_error","error":{"message":"No API key provided"}}'
			: "{}";
	return [
		`HTTP/1.1 ${status} Fixture`,
		"Content-Type: application/json",
		`Content-Length: ${Buffer.byteLength(body)}`,
		"Connection: close",
		"",
		body,
	].join("\r\n");
}

async function runRunnerGatewayProbe(
	port: number,
	required = true,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const upstreamPort = await allocatePort();
	const guardPort = await allocatePort();
	const child = spawn(
		"bash",
		[
			"-c",
			`exec bash ${shellQuote(shellPath(runnerScript))}`,
		],
		{
			cwd: repoRoot,
			env: bashChildEnv({
				CCFLARE_BIN: "/bin/false",
				GUARD_SCRIPT: "/bin/true",
				NODE_BIN: "/bin/true",
				CCFLARE_UPSTREAM_PORT: String(upstreamPort),
				GUARD_PORT: String(guardPort),
				AI_GATEWAY_TUNNEL_ENABLED: "1",
				AI_GATEWAY_TUNNEL_REQUIRED: required ? "1" : "0",
				AI_GATEWAY_LOCAL_PORT: String(port),
				// If the local probe is rejected, make the attempted SSH child fail
				// locally and immediately instead of touching the network.
				AI_GATEWAY_SSH_HOST: "-Z",
			}),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	try {
		const exitCode = await Promise.race([
			new Promise<number | null>((resolve) => child.once("exit", resolve)),
			Bun.sleep(5_000).then(() => {
				throw new Error(
					`runner gateway probe timed out:\n${stdout}\n${stderr}`,
				);
			}),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
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

function sha256Of(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// render_systemd_pin computes digests from the staged guard/policy/runner
// files at render time, so any test invoking it needs real, existing files
// at those paths, even when the test itself does not care about the
// resulting digest values.
function writeDigestFixtures(dir: string): {
	guard: string;
	policy: string;
	runner: string;
} {
	const guard = join(dir, "ccflare-guard.mjs");
	const policy = join(dir, "ccflare-guard-policy.mjs");
	const runner = join(dir, "run-ccflare-stack.sh");
	writeFileSync(guard, "// guard fixture\n");
	writeFileSync(policy, "// policy fixture\n");
	writeFileSync(runner, "#!/usr/bin/env bash\n# runner fixture\n");
	return { guard, policy, runner };
}

describe("render_systemd_pin", () => {
	test("renders only deploy-owned content, removes stale managed values, and is byte-idempotent", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		// The digest lines are computed from the staged files at render time, so
		// the guard, policy, and runner arguments must be real, existing files
		// (as they are in the real deploy flow, by the time render_systemd_pin
		// runs). The binary argument is not hashed by this function; it stays a
		// symbolic path.
		const {
			guard: guardScript,
			policy: guardPolicyScript,
			runner: runnerScriptFixture,
		} = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# Comments outside the managed block are tolerated but not retained.",
				"",
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				"Environment=KEEP_ME=unchanged",
				"Environment=CCFLARE_BIN=/old/bin",
				"Environment=GUARD_SCRIPT=/old/guard.mjs",
				"Environment=GUARD_SCRIPT=/duplicate/guard.mjs",
				"Environment=GUARD_SHA256=oldguardsha",
				"Environment=GUARD_POLICY_SHA256=oldpolicysha",
				"Environment=RUNNER_SHA256=oldrunnersha",
				"Environment=GUARD_TOTAL_DEADLINE_MS=900000",
				"Environment=OPERATOR_OVERRIDE=must-not-survive",
				"KillMode=control-group",
				"TimeoutStopSec=999s",
				"ExecStart=/home/will/legacy-runner.sh",
				"# END better-ccflare managed deployment",
				"",
				"; A systemd semicolon comment is also tolerated.",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runnerScriptFixture))} ${shellQuote(shellPath(guardScript))} abc123 pool-exhaustion-finite-recovery-v1 ${shellQuote(shellPath(guardPolicyScript))}`,
			].join("\n"),
		);

		expect(repoRootDeployTestArtifacts()).toEqual([]);
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(readFileSync(output, "utf8")).toBe(
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				"Environment=CCFLARE_BIN=/new/bin",
				`Environment=GUARD_SCRIPT=${guardScript}`,
				"Environment=GUARD_SOURCE_ID=abc123",
				"Environment=GUARD_POLICY_ID=pool-exhaustion-finite-recovery-v1",
				`Environment=GUARD_SHA256=${sha256Of(guardScript)}`,
				`Environment=GUARD_POLICY_SHA256=${sha256Of(guardPolicyScript)}`,
				`Environment=RUNNER_SHA256=${sha256Of(runnerScriptFixture)}`,
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
				"ExecStart=",
				`ExecStart=${runnerScriptFixture}`,
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const secondOutput = join(dir, "pin.second-render.conf");
		const second = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(output))} ${shellQuote(shellPath(secondOutput))} /new/bin ${shellQuote(shellPath(runnerScriptFixture))} ${shellQuote(shellPath(guardScript))} abc123 pool-exhaustion-finite-recovery-v1 ${shellQuote(shellPath(guardPolicyScript))}`,
			].join("\n"),
		);
		expect(second.exitCode).toBe(0);
		expect(readFileSync(secondOutput, "utf8")).toBe(
			readFileSync(output, "utf8"),
		);
	});

	test("rejects meaningful unmanaged content with an actionable operator-policy migration error", () => {
		const dir = tempDir();
		const input = join(dir, "50-pinned-build.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# legacy unowned pin",
				"[Service]",
				"Environment=CCFLARE_BIN=/stale/bin",
				"ExecStart=/stale/runner",
				"",
			].join("\n"),
		);

		const mutationLog = join(dir, "systemd-mutation.log");
		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`if render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}; then`,
				`  printf mutation >${shellQuote(shellPath(mutationLog))}`,
				"else",
				"  exit $?",
				"fi",
			].join("\n"),
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"contains unmanaged systemd configuration outside",
		);
		expect(result.stderr.toString()).toContain("line 2: [Service]");
		expect(result.stderr.toString()).toContain(
			"Migrate operator policy to a later drop-in",
		);
		expect(result.stderr.toString()).toContain("90-operator-policy.conf");
		expect(existsSync(output)).toBe(false);
		expect(existsSync(mutationLog)).toBe(false);
	});

	test("fails clearly when a digest input file does not exist", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		writeFileSync(input, "# deploy-owned placeholder\n");

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin /missing/runner.sh /missing/guard.mjs abc123 pool-exhaustion-finite-recovery-v1 /missing/policy.mjs`,
			].join("\n"),
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"sha256_file requires one existing file",
		);
	});

	test("accepts an empty or comment-only legacy file and replaces it from scratch", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			"\n  # deployment note\n\t; another comment\n\n",
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered.startsWith("# BEGIN better-ccflare managed deployment\n")).toBe(
			true,
		);
		expect(rendered).not.toContain("deployment note");
		expect(rendered).not.toContain("another comment");
		expect(rendered).toContain("Environment=GUARD_TOTAL_DEADLINE_MS=600000");
		expect(rendered).toContain("Environment=GUARD_SHUTDOWN_GRACE_MS=600000");
		expect(rendered).toContain("KillMode=mixed");
		expect(rendered).toContain("TimeoutStopSec=720s");
	});

	test("rejects duplicate or unbalanced ownership markers", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				"# BEGIN better-ccflare managed deployment",
				"# END better-ccflare managed deployment",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("invalid managed marker structure");
	});
});

describe("configured_systemd_environment_value", () => {
	test("reads the last plain or quoted numeric operator value", () => {
		const dir = tempDir();
		const pin = join(dir, "pin.conf");
		writeFileSync(
			pin,
			[
				"[Service]",
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				'Environment="GUARD_TOTAL_DEADLINE_MS=900000"',
				"",
			].join("\n"),
		);
		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`configured_systemd_environment_value ${shellQuote(shellPath(pin))} GUARD_TOTAL_DEADLINE_MS`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("900000");
	});

	test("matches systemd Service-section, reset, continuation, and last-wins semantics", () => {
		const dir = tempDir();
		const pin = join(dir, "pin.conf");
		writeFileSync(
			pin,
			[
				"[Unit]",
				"  Environment='GUARD_TOTAL_DEADLINE_MS=111111'",
				"[Service]",
				"  Environment=KEEP=before 'GUARD_TOTAL_DEADLINE_MS=700000' OTHER=value",
				'  Environment="GUARD_TOTAL_DEADLINE_MS=800000" \\',
				"    'GUARD_SHUTDOWN_GRACE_MS=800000'",
				"  Environment=",
				"  Environment='KEEP=after reset' \\",
				'    "GUARD_TOTAL_DEADLINE_MS=900000" \'GUARD_SHUTDOWN_GRACE_MS=900000\'',
				"  Environment=GUARD_TOTAL_DEADLINE_MS=950000",
				"  Environment='GUARD_TOTAL_DEADLINE_MS=900000'",
				"[Install]",
				"Environment=GUARD_TOTAL_DEADLINE_MS=222222",
				"",
			].join("\n"),
		);
		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`configured_systemd_environment_value ${shellQuote(shellPath(pin))} GUARD_TOTAL_DEADLINE_MS`,
				`configured_systemd_environment_value ${shellQuote(shellPath(pin))} GUARD_SHUTDOWN_GRACE_MS`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim().split("\n")).toEqual([
			"900000",
			"900000",
		]);
	});
});

describe("validate_deployment_timing", () => {
	test("accepts the safe defaults and larger coherent operator overrides", () => {
		for (const [deadline, grace, timeout, expected] of [
			["600000", "600000", "720s", "600000 600000 720000"],
			["900000", "900000", "17min", "900000 900000 1020000"],
		] as const) {
			const dir = tempDir();
			const pin = join(dir, "pin.conf");
			writeFileSync(
				pin,
				[
					"[Service]",
					`Environment=GUARD_TOTAL_DEADLINE_MS=${deadline}`,
					`Environment=GUARD_SHUTDOWN_GRACE_MS=${grace}`,
					"KillMode=mixed",
					`TimeoutStopSec=${timeout}`,
					"",
				].join("\n"),
			);
			const result = bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`validate_deployment_timing ${shellQuote(shellPath(pin))}`,
				].join("\n"),
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString().trim()).toBe(expected);
		}
	});

	test("rejects unsafe deadline, drain, kill mode, or stop timeout", () => {
		for (const lines of [
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=120000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
			],
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=75000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
			],
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=control-group",
				"TimeoutStopSec=720s",
			],
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=619s",
			],
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=900000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=1020s",
			],
		] as const) {
			const dir = tempDir();
			const pin = join(dir, "pin.conf");
			writeFileSync(pin, ["[Service]", ...lines, ""].join("\n"));
			const result = bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`validate_deployment_timing ${shellQuote(shellPath(pin))}`,
				].join("\n"),
			);
			expect(result.exitCode).not.toBe(0);
		}
	});
});

describe("effective systemd policy validation", () => {
	function writeSystemctlMock(dir: string): { binDir: string; log: string } {
		const binDir = join(dir, "bin");
		const log = join(dir, "systemctl.log");
		mkdirSync(binDir);
		const mock = join(binDir, "systemctl");
		writeFileSync(
			mock,
			[
				"#!/usr/bin/env bash",
				'printf \'systemctl:%s\\n\' "$*" >>"$CCFLARE_TEST_SYSTEMCTL_LOG"',
				'if [[ "$*" == *"daemon-reload"* ]]; then exit 0; fi',
				'if [[ "$*" == *"--property=KillMode"* ]]; then',
				'  if [[ -n "${CCFLARE_TEST_SAFE_POLICY_PIN:-}" && -n "${CCFLARE_TEST_SAFE_POLICY_BACKUP:-}" ]] && cmp -s "$CCFLARE_TEST_SAFE_POLICY_PIN" "$CCFLARE_TEST_SAFE_POLICY_BACKUP"; then',
				"    printf 'mixed\\n'",
				"  else",
				'    printf \'%s\\n\' "$CCFLARE_TEST_KILL_MODE"',
				"  fi",
				"  exit 0",
				"fi",
				'if [[ "$*" == *"--property=TimeoutStopUSec"* ]]; then printf \'%s\\n\' "$CCFLARE_TEST_TIMEOUT"; exit 0; fi',
				'if [[ "$*" == *"--property=Environment"* ]]; then printf \'%s\\n\' "$CCFLARE_TEST_ENVIRONMENT"; exit 0; fi',
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(mock, 0o755);
		writeFileSync(log, "");
		return { binDir, log };
	}

	test("requires the daemon-reloaded effective policy, including environment", () => {
		const dir = tempDir();
		const { binDir, log } = writeSystemctlMock(dir);
		const base = [
			`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
			`export CCFLARE_TEST_SYSTEMCTL_LOG=${shellQuote(shellPath(log))}`,
			"export CCFLARE_TEST_KILL_MODE=mixed",
			"export CCFLARE_TEST_TIMEOUT=12min",
			"export CCFLARE_TEST_ENVIRONMENT='KEEP=1 GUARD_TOTAL_DEADLINE_MS=600000 GUARD_SHUTDOWN_GRACE_MS=600000'",
			`source ${shellQuote(helperScriptForShell)}`,
		];
		const good = bash(
			[
				...base,
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(good.exitCode).toBe(0);
		expect(good.stdout.toString().trim()).toBe("600000 600000 720000");

		const safeOperatorOverride = bash(
			[
				...base,
				"export CCFLARE_TEST_TIMEOUT='17min'",
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=900000 GUARD_SHUTDOWN_GRACE_MS=900000'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(safeOperatorOverride.exitCode).toBe(0);
		expect(safeOperatorOverride.stdout.toString().trim()).toBe(
			"900000 900000 1020000",
		);

		const overridden = bash(
			[
				...base,
				"export CCFLARE_TEST_TIMEOUT='10min'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(overridden.exitCode).not.toBe(0);
	});

	test("restores and reloads the prior pin without restarting on effective-policy failure", () => {
		const dir = tempDir();
		const { binDir, log } = writeSystemctlMock(dir);
		const sudo = join(binDir, "sudo");
		writeFileSync(
			sudo,
			[
				"#!/usr/bin/env bash",
				'printf \'sudo:%s\\n\' "$*" >>"$CCFLARE_TEST_SYSTEMCTL_LOG"',
				'exec "$@"',
				"",
			].join("\n"),
		);
		chmodSync(sudo, 0o755);
		const pin = join(dir, "pin.conf");
		const backup = join(dir, "pin.conf.bak");
		writeFileSync(pin, "new pin\n");
		writeFileSync(backup, "old pin\n");
		const result = bash(
			[
				`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
				`export CCFLARE_TEST_SYSTEMCTL_LOG=${shellQuote(shellPath(log))}`,
				"export CCFLARE_TEST_KILL_MODE=control-group",
				"export CCFLARE_TEST_TIMEOUT=12min",
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_SHUTDOWN_GRACE_MS=600000'",
				`export CCFLARE_TEST_SAFE_POLICY_PIN=${shellQuote(shellPath(pin))}`,
				`export CCFLARE_TEST_SAFE_POLICY_BACKUP=${shellQuote(shellPath(backup))}`,
				`source ${shellQuote(helperScriptForShell)}`,
				`reload_validate_or_restore_systemd_policy ${shellQuote(shellPath(pin))} ${shellQuote(shellPath(backup))} ccflare-stack.service`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(1);
		expect(readFileSync(pin, "utf8")).toBe("old pin\n");
		const events = readFileSync(log, "utf8").trim().split("\n");
		expect(events[0]).toBe("sudo:systemctl daemon-reload");
		const effectiveCheck = events.findIndex((event) =>
			event.includes("--property=KillMode"),
		);
		const restoreCopy = events.findIndex((event) =>
			event.startsWith("sudo:cp --preserve=all"),
		);
		const restoreMove = events.findIndex((event) =>
			event.startsWith("sudo:mv -f"),
		);
		expect(effectiveCheck).toBeGreaterThan(0);
		expect(restoreCopy).toBeGreaterThan(effectiveCheck);
		expect(restoreMove).toBeGreaterThan(restoreCopy);
		const restoreReload = events.findIndex(
			(event, index) =>
				index > restoreMove && event === "systemctl:daemon-reload",
		);
		const restoredEffectiveCheck = events.findIndex(
			(event, index) =>
				index > restoreReload && event.includes("--property=KillMode"),
		);
		expect(restoreReload).toBeGreaterThan(restoreMove);
		expect(restoredEffectiveCheck).toBeGreaterThan(restoreReload);
		expect(
			events.some((event) => event.includes("systemctl restart")),
		).toBe(false);
	});

	test("hard-fails when a later operator drop-in remains unsafe after pin restoration", () => {
		const dir = tempDir();
		const { binDir, log } = writeSystemctlMock(dir);
		const sudo = join(binDir, "sudo");
		writeFileSync(
			sudo,
			[
				"#!/usr/bin/env bash",
				'printf \'sudo:%s\\n\' "$*" >>"$CCFLARE_TEST_SYSTEMCTL_LOG"',
				'exec "$@"',
				"",
			].join("\n"),
		);
		chmodSync(sudo, 0o755);
		const pin = join(dir, "pin.conf");
		const backup = join(dir, "pin.conf.bak");
		writeFileSync(pin, "new pin\n");
		writeFileSync(backup, "old pin\n");
		const result = bash(
			[
				`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
				`export CCFLARE_TEST_SYSTEMCTL_LOG=${shellQuote(shellPath(log))}`,
				"export CCFLARE_TEST_KILL_MODE=control-group",
				"export CCFLARE_TEST_TIMEOUT=12min",
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_SHUTDOWN_GRACE_MS=600000'",
				`source ${shellQuote(helperScriptForShell)}`,
				`reload_validate_or_restore_systemd_policy ${shellQuote(shellPath(pin))} ${shellQuote(shellPath(backup))} ccflare-stack.service`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(70);
		expect(readFileSync(pin, "utf8")).toBe("old pin\n");
		expect(result.stderr.toString()).toContain(
			"operator drop-ins still produce an unsafe effective systemd policy",
		);
		expect(result.stderr.toString()).toContain("90-operator-policy.conf");
		const events = readFileSync(log, "utf8").trim().split("\n");
		expect(
			events.filter((event) => event === "systemctl:daemon-reload"),
		).toHaveLength(2);
		expect(
			events.filter((event) => event.includes("--property=KillMode")),
		).toHaveLength(2);
		expect(
			events.some((event) => event.includes("systemctl restart")),
		).toBe(false);
	});

	test("replaces an unchanged pin from its exact backup snapshot", () => {
		const dir = tempDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir);
		const sudo = join(binDir, "sudo");
		writeFileSync(sudo, ["#!/usr/bin/env bash", 'exec "$@"', ""].join("\n"));
		chmodSync(sudo, 0o755);
		const pin = join(dir, "pin.conf");
		const backup = join(dir, "pin.conf.bak");
		const rendered = join(dir, "pin.rendered.conf");
		const staged = join(dir, "pin.staged.conf");
		writeFileSync(pin, "original pin\n");
		writeFileSync(backup, "original pin\n");
		writeFileSync(rendered, "new deploy pin\n");
		const result = bash(
			[
				`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
				`source ${shellQuote(helperScriptForShell)}`,
				`replace_systemd_pin_if_snapshot_current ${shellQuote(shellPath(pin))} ${shellQuote(shellPath(backup))} ${shellQuote(shellPath(rendered))} ${shellQuote(shellPath(staged))}`,
				'printf "%s" "$PIN_ROLLBACK_ARMED"',
			].join("\n"),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("1");
		expect(readFileSync(pin, "utf8")).toBe("new deploy pin\n");
		expect(readFileSync(backup, "utf8")).toBe("original pin\n");
		expect(existsSync(staged)).toBe(false);
	});

	test("preserves a concurrent operator pin edit instead of replacing it", () => {
		const dir = tempDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir);
		const sudo = join(binDir, "sudo");
		writeFileSync(
			sudo,
			[
				"#!/usr/bin/env bash",
				'if [[ "$1" == "cmp" ]]; then',
				'  printf \'operator edit\\n\' >"$3"',
				"fi",
				'exec "$@"',
				"",
			].join("\n"),
		);
		chmodSync(sudo, 0o755);
		const pin = join(dir, "pin.conf");
		const backup = join(dir, "pin.conf.bak");
		const rendered = join(dir, "pin.rendered.conf");
		const staged = join(dir, "pin.staged.conf");
		writeFileSync(pin, "original pin\n");
		writeFileSync(backup, "original pin\n");
		writeFileSync(rendered, "new deploy pin\n");
		const result = bash(
			[
				`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
				`source ${shellQuote(helperScriptForShell)}`,
				`replace_systemd_pin_if_snapshot_current ${shellQuote(shellPath(pin))} ${shellQuote(shellPath(backup))} ${shellQuote(shellPath(rendered))} ${shellQuote(shellPath(staged))}`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(1);
		expect(readFileSync(pin, "utf8")).toBe("operator edit\n");
		expect(existsSync(staged)).toBe(false);
		expect(result.stderr.toString()).toContain(
			"changed after the deployment snapshot was captured",
		);
	});

	test("fails clearly when a digest input file does not exist", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		writeFileSync(input, "# deploy-owned placeholder\n");

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin /missing/runner.sh /missing/guard.mjs abc123 pool-exhaustion-finite-recovery-v1 /missing/policy.mjs`,
			].join("\n"),
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"sha256_file requires one existing file",
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
				totalDeadlineMs: 900_000,
				shutdownGraceMs: 900_000,
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
					totalDeadlineMs: 900_000,
					shutdownGraceMs: 900_000,
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
		expect(zero.exitCode).toBe(64);
	});

	test("rejects a zero deadline instead of letting the guard clamp it to 1ms", () => {
		const result = bash(
			`GUARD_TOTAL_DEADLINE_MS=0 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(result.exitCode).toBe(64);
		expect(result.stdout.toString()).toContain(
			"invalid GUARD_TOTAL_DEADLINE_MS=0",
		);
	});

	test("rejects shutdown grace shorter than the total request deadline", () => {
		const result = bash(
			`GUARD_TOTAL_DEADLINE_MS=900000 GUARD_SHUTDOWN_GRACE_MS=600000 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(result.exitCode).toBe(64);
		expect(result.stdout.toString()).toContain(
			"GUARD_SHUTDOWN_GRACE_MS=600000 must be at least GUARD_TOTAL_DEADLINE_MS=900000",
		);
	});

	test("defaults the guard deadline to 600s while preserving an inherited value", () => {
		const source = readFileSync(runnerScript, "utf8");
		expect(source).toContain(
			"GUARD_TOTAL_DEADLINE_MS=${GUARD_TOTAL_DEADLINE_MS:-600000}",
		);
		expect(source).toContain(
			'validate_bounded_ms GUARD_TOTAL_DEADLINE_MS "$GUARD_TOTAL_DEADLINE_MS" 1 2147483647',
		);
		expect(source).toContain(
			'GUARD_TOTAL_DEADLINE_MS="$GUARD_TOTAL_DEADLINE_MS"',
		);
		expect(source).not.toContain("GUARD_TOTAL_DEADLINE_MS=120000");
	});

	test("defaults the guard shutdown grace to 600s", () => {
		const source = readFileSync(runnerScript, "utf8");
		expect(source).toContain(
			"GUARD_SHUTDOWN_GRACE_MS=${GUARD_SHUTDOWN_GRACE_MS:-600000}",
		);
	});

	test("pins the remaining guard limits and retains tunnel and lifecycle supervision", () => {
		const source = readFileSync(runnerScript, "utf8");
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

	test("accepts only 2xx and the unauthenticated 401 gateway boundary", async () => {
		for (const status of [200, 299, 401]) {
			const fixture = await startGatewayFixture(gatewayHttpResponse(status));
			try {
				const result = await runRunnerGatewayProbe(fixture.port);
				expect(result.stdout).toContain(
					`ai-gateway tunnel already ready at 127.0.0.1:${fixture.port}`,
				);
				expect(result.stdout).toContain("starting better-ccflare upstream");
			} finally {
				await fixture.close();
			}
		}
	}, 15_000);

	test("rejects redirects, other errors, malformed HTTP, and connection failure", async () => {
		for (const response of [
			gatewayHttpResponse(302),
			gatewayHttpResponse(403),
			gatewayHttpResponse(503),
			"not an HTTP response\r\n",
		]) {
			const fixture = await startGatewayFixture(response);
			try {
				const result = await runRunnerGatewayProbe(fixture.port);
				expect(result.stdout).toContain(
					"ai-gateway tunnel is required; exiting",
				);
				expect(result.stdout).not.toContain(
					"starting better-ccflare upstream",
				);
			} finally {
				await fixture.close();
			}
		}

		const closedPort = await allocatePort();
		const connectionFailure = await runRunnerGatewayProbe(closedPort);
		expect(connectionFailure.stdout).toContain(
			"ai-gateway tunnel is required; exiting",
		);
		expect(connectionFailure.stdout).not.toContain(
			"starting better-ccflare upstream",
		);
	}, 15_000);

	test("retains optional-tunnel startup when gateway liveness is rejected", async () => {
		const fixture = await startGatewayFixture(gatewayHttpResponse(503));
		try {
			const result = await runRunnerGatewayProbe(fixture.port, false);
			expect(result.stdout).toContain(
				"ai-gateway tunnel unavailable; continuing without last-resort fallback",
			);
			expect(result.stdout).toContain("starting better-ccflare upstream");
		} finally {
			await fixture.close();
		}
	}, 5_000);

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
  [
    role,
    event,
    Date.now(),
    process.env.GUARD_SHUTDOWN_GRACE_MS || "",
    process.env.GUARD_TOTAL_DEADLINE_MS || "",
  ].join(":") + "\\n",
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
					GUARD_TOTAL_DEADLINE_MS: "240",
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
					const [role, event, timestamp, grace, deadline] = line.split(":");
					return { role, event, timestamp: Number(timestamp), grace, deadline };
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
			expect(guardStart?.deadline).toBe("240");
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

describe("validate_main_deploy_source", () => {
	function runSourceGate(
		branchRef: string,
		headSha: string,
		originMainSha: string,
	) {
		return bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`validate_main_deploy_source ${shellQuote(branchRef)} ${shellQuote(headSha)} ${shellQuote(originMainSha)}`,
			].join("\n"),
		);
	}

	test("accepts only refs/heads/main at the fetched origin/main tip", () => {
		const sha = "a".repeat(40);
		const result = runSourceGate("refs/heads/main", sha, sha);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toContain(
			"is refs/heads/main at refs/remotes/origin/main",
		);
	});

	test("rejects a feature branch even when it points at origin/main", () => {
		const sha = "a".repeat(40);
		const result = runSourceGate(
			"refs/heads/codex/example",
			sha,
			sha,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"checkout must be refs/heads/main",
		);
	});

	test("rejects detached HEAD even when it points at origin/main", () => {
		const sha = "a".repeat(40);
		const result = runSourceGate("", sha, sha);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("checkout has detached HEAD");
	});

	test("rejects local main whenever it differs from fetched origin/main", () => {
		const result = runSourceGate(
			"refs/heads/main",
			"1111111111111111111111111111111111111111",
			"2222222222222222222222222222222222222222",
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			"does not exactly match refs/remotes/origin/main",
		);
	});
});

describe("deploy source gate in disposable repositories", () => {
	test("--check accepts only the checked-out refs/heads/main at the current origin tip", () => {
		const accepted = createDisposableDeployRepo();
		const pass = bashAt(
			accepted.checkout,
			"bash scripts/deploy-ccflare.sh --check",
		);
		expect(pass.exitCode).toBe(0);
		expect(pass.stdout.toString()).toContain(
			"is refs/heads/main at refs/remotes/origin/main",
		);
		expect(pass.stdout.toString()).toContain("no merged v* tags to compare");

		const feature = createDisposableDeployRepo();
		expectCommandOk(gitAt(feature.checkout, "switch", "-c", "feature"));
		const wrongBranch = bashAt(
			feature.checkout,
			"bash scripts/deploy-ccflare.sh --check",
		);
		expect(wrongBranch.exitCode).toBe(1);
		expect(wrongBranch.stderr.toString()).toContain(
			"checkout must be refs/heads/main",
		);

		const staleMain = createDisposableDeployRepo();
		const oldSha = gitAt(staleMain.checkout, "rev-parse", "HEAD")
			.stdout.toString()
			.trim();
		writeFileSync(join(staleMain.checkout, "remote-change.txt"), "new tip\n");
		expectCommandOk(gitAt(staleMain.checkout, "add", "remote-change.txt"));
		expectCommandOk(
			gitAt(staleMain.checkout, "commit", "-m", "advance remote"),
		);
		expectCommandOk(
			gitAt(
				staleMain.checkout,
				"push",
				"origin",
				"refs/heads/main:refs/heads/main",
			),
		);
		expectCommandOk(gitAt(staleMain.checkout, "reset", "--hard", oldSha));
		const behind = bashAt(
			staleMain.checkout,
			"bash scripts/deploy-ccflare.sh --check",
		);
		expect(behind.exitCode).toBe(1);
		expect(behind.stderr.toString()).toContain(
			"does not exactly match refs/remotes/origin/main",
		);
	});

	test("verified source snapshot remains at the captured commit after the shared checkout changes", () => {
		const { checkout } = createDisposableDeployRepo();
		const snapshotParent = tempDir();
		const snapshot = join(snapshotParent, "source");
		const headSha = gitAt(checkout, "rev-parse", "HEAD")
			.stdout.toString()
			.trim();
		const create = bashAt(
			checkout,
			[
				`source ${shellQuote(join(checkout, helperScriptForShell))}`,
				`create_verified_source_snapshot ${shellQuote(checkout)} ${shellQuote(snapshot)} ${shellQuote(headSha)}`,
			].join("\n"),
		);
		expect(create.exitCode).toBe(0);

		writeFileSync(join(checkout, "package.json"), '{"version":"9.9.9"}\n');
		expect(readFileSync(join(snapshot, "package.json"), "utf8")).toBe(
			'{"name":"deploy-fixture","version":"1.0.0"}\n',
		);
		expect(
			gitAt(snapshot, "rev-parse", "HEAD").stdout.toString().trim(),
		).toBe(headSha);
		expect(gitAt(snapshot, "symbolic-ref", "-q", "HEAD").exitCode).toBe(1);
		mkdirSync(join(snapshot, "node_modules"));
		writeFileSync(join(snapshot, "node_modules", "build-output"), "ignored\n");

		const cleanup = bashAt(
			checkout,
			[
				`source ${shellQuote(join(checkout, helperScriptForShell))}`,
				`remove_verified_source_snapshot ${shellQuote(checkout)} ${shellQuote(snapshot)}`,
			].join("\n"),
		);
		expect(cleanup.exitCode).toBe(0);
		expect(gitAt(checkout, "worktree", "list", "--porcelain").stdout.toString()).not.toContain(snapshot);
	});
});

describe("deployment flow safety contracts", () => {
	test("fetches and validates exact unambiguous main refs", () => {
		const source = readFileSync(deployScript, "utf8");
		expect(source).toContain(
			"git fetch origin refs/heads/main:refs/remotes/origin/main --quiet",
		);
		expect(source).toContain("git symbolic-ref -q HEAD");
		expect(source).toContain("git rev-parse refs/remotes/origin/main");
		expect(source).toContain("validate_main_deploy_source");
		expect(source).toContain(
			'git merge-base --is-ancestor "$HEAD_SHA" refs/remotes/origin/main',
		);
	});

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

	// A genuine dynamic test would need two real, overlapping full-deploy
	// invocations (git ancestry gate passing, `bun run build`, `sudo cp` into
	// /home/will/.config/better-ccflare, and `systemctl restart
	// ccflare-stack.service`) racing for the same lock. That means mutating
	// production host paths from a fixture, which is out of bounds here — so
	// this stays a static structural check: the lock is a single non-blocking
	// flock on a UID-scoped file, acquired only after the CHECK_ONLY exit (and
	// therefore only on the full-deploy path) and before any build or host
	// mutation, with a distinct exit code so a losing invocation is
	// unambiguous rather than aliasing another failure mode.
	test("full deploy takes a single non-blocking, UID-scoped lock before any mutation", () => {
		const source = readFileSync(deployScript, "utf8");
		const checkExit = source.indexOf('if [[ "$CHECK_ONLY" == "1" ]]');
		const lockPath = source.indexOf(
			'DEPLOY_LOCK="${XDG_RUNTIME_DIR:-/tmp}/better-ccflare-deploy-${UID}.lock"',
		);
		const lockOpen = source.indexOf('exec 9>"$DEPLOY_LOCK"', lockPath);
		const lockAcquire = source.indexOf('if ! flock -n 9; then', lockOpen);
		const lockExitCode = source.indexOf("exit 75", lockAcquire);
		const buildMarker = source.indexOf("bun run build", lockExitCode);

		expect(checkExit).toBeGreaterThan(0);
		expect(lockPath).toBeGreaterThan(checkExit);
		expect(lockOpen).toBeGreaterThan(lockPath);
		expect(lockAcquire).toBeGreaterThan(lockOpen);
		expect(lockExitCode).toBeGreaterThan(lockAcquire);
		expect(buildMarker).toBeGreaterThan(lockExitCode);

		// The exit code on a lost race must be used exactly once in the whole
		// script, and only for this lock failure, so a losing invocation can
		// never be confused with rollback hard-failure (70), usage/validation
		// errors (64), or the generic refusal path (1).
		expect(source.match(/\bexit 75\b/g)).toHaveLength(1);
	});

	test("rejects unmanaged pin content before build or host/systemd mutation", () => {
		const source = readFileSync(deployScript, "utf8");
		const lockAcquire = source.indexOf('if ! flock -n 9; then');
		const preflight = source.indexOf(
			'validate_deploy_owned_systemd_pin "$PIN"',
			lockAcquire,
		);
		const snapshot = source.indexOf(
			'create_verified_source_snapshot "$REPO_ROOT"',
			lockAcquire,
		);
		const build = source.indexOf("bun run build", lockAcquire);
		const binaryInstall = source.indexOf('cp "$BUILT_BIN" "$DEST_BIN"', lockAcquire);
		const pinBackup = source.indexOf(
			'sudo cp --preserve=all "$PIN" "$PIN_BACKUP"',
			lockAcquire,
		);
		const effectivePolicyMutation = source.indexOf(
			"reload_validate_or_restore_systemd_policy",
			lockAcquire,
		);
		const restart = source.indexOf(
			"sudo systemctl restart ccflare-stack.service",
			lockAcquire,
		);

		expect(preflight).toBeGreaterThan(lockAcquire);
		expect(snapshot).toBeGreaterThan(preflight);
		expect(build).toBeGreaterThan(preflight);
		expect(binaryInstall).toBeGreaterThan(preflight);
		expect(pinBackup).toBeGreaterThan(preflight);
		expect(effectivePolicyMutation).toBeGreaterThan(preflight);
		expect(restart).toBeGreaterThan(preflight);
	});

	test("build and copied runtime artifacts come only from the verified snapshot", () => {
		const source = readFileSync(deployScript, "utf8");
		expect(source).toContain(
			'create_verified_source_snapshot "$REPO_ROOT" "$BUILD_SOURCE_ROOT" "$HEAD_SHA"',
		);
		expect(source).toContain('cd "$BUILD_SOURCE_ROOT"');
		expect(source).toContain('BUILT_BIN="$BUILD_SOURCE_ROOT/apps/cli/dist/better-ccflare"');
		expect(source).toContain(
			'SOURCE_GUARD="$BUILD_SOURCE_ROOT/scripts/ccflare-guard.mjs"',
		);
		expect(source).toContain(
			'SOURCE_GUARD_POLICY="$BUILD_SOURCE_ROOT/scripts/ccflare-guard-policy.mjs"',
		);
		expect(source).toContain(
			'SOURCE_RUNNER="$BUILD_SOURCE_ROOT/scripts/run-ccflare-stack.sh"',
		);
		expect(source).not.toContain('SOURCE_GUARD="$REPO_ROOT/');
		expect(source).not.toContain('SOURCE_RUNNER="$REPO_ROOT/');
		expect(source).toContain(
			'remove_verified_source_snapshot "$REPO_ROOT" "$BUILD_SOURCE_ROOT"',
		);
	});

	test("full deployment has rollback and exact dual-health verification", () => {
		const source = readFileSync(deployScript, "utf8");
		const helperSource = readFileSync(
			join(repoRoot, helperScriptForShell),
			"utf8",
		);
		expect(source).toContain('validate_deployment_timing "$PIN_RENDERED"');
		expect(source).toContain(
			"totalDeadlineMs: Number(guardTotalDeadlineMs)",
		);
		expect(source).toContain(
			"shutdownGraceMs: Number(guardShutdownGraceMs)",
		);
		expect(source).not.toContain("totalDeadlineMs: 120000");
		expect(source).toContain('GUARD_DIR="${GUARDS_ROOT}/${HEAD_SHA}"');
		expect(source).toContain('RUNNER_DIR="${RUNNERS_ROOT}/${HEAD_SHA}"');
		expect(source).toContain(
			'SOURCE_RUNNER="$BUILD_SOURCE_ROOT/scripts/run-ccflare-stack.sh"',
		);
		expect(source).toContain('GUARD_SOURCE_ID="$HEAD_SHA"');
		expect(source).toContain(
			'GUARD_POLICY_ID="pool-exhaustion-finite-recovery-v1"',
		);
		expect(source).toContain('PIN_STAGED="${PIN}.new-${SHORT}-$$"');
		expect(source).toContain("replace_systemd_pin_if_snapshot_current");
		expect(source).toContain('render_systemd_pin \\\n\t"$PIN_BACKUP"');
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
		expect(source).toContain("reload_validate_or_restore_systemd_policy");
		expect(source).toContain("SERVICE_RESTART_ATTEMPTED=1");
		expect(source).toContain(
			'if [[ "$SERVICE_RESTART_ATTEMPTED" == "0" ]]',
		);

		const backup = source.indexOf(
			'sudo cp --preserve=all "$PIN" "$PIN_BACKUP"',
		);
		const preflight = source.indexOf(
			'validate_deploy_owned_systemd_pin "$PIN"',
		);
		const pinRender = source.indexOf("render_systemd_pin", preflight);
		const timingValidation = source.indexOf(
			'validate_deployment_timing "$PIN_RENDERED"',
			pinRender,
		);
		const pinWrite = source.indexOf(
			"replace_systemd_pin_if_snapshot_current",
			timingValidation,
		);
		const restart = source.indexOf(
			"sudo systemctl restart ccflare-stack.service",
			pinRender,
		);
		const effectivePolicy = source.indexOf(
			"reload_validate_or_restore_systemd_policy",
			pinWrite,
		);
		const restartAttempted = source.indexOf(
			"SERVICE_RESTART_ATTEMPTED=1",
			effectivePolicy,
		);
		const verify = source.indexOf("if ! validate_deploy_health", restart);
		const hardFailure = source.indexOf("exit 1", verify);
		const snapshotCompare = helperSource.indexOf(
			'if ! sudo cmp -s "$pin" "$backup"',
		);
		const rollbackArmed = helperSource.indexOf(
			"PIN_ROLLBACK_ARMED=1",
			snapshotCompare,
		);
		const atomicRename = helperSource.indexOf(
			'if ! sudo mv -f "$staged" "$pin"',
			rollbackArmed,
		);
		expect(backup).toBeGreaterThan(0);
		expect(preflight).toBeGreaterThan(0);
		expect(pinRender).toBeGreaterThan(preflight);
		expect(timingValidation).toBeGreaterThan(pinRender);
		expect(backup).toBeLessThan(pinRender);
		expect(pinWrite).toBeGreaterThan(timingValidation);
		expect(pinWrite).toBeGreaterThan(backup);
		expect(snapshotCompare).toBeGreaterThan(0);
		expect(rollbackArmed).toBeGreaterThan(snapshotCompare);
		expect(atomicRename).toBeGreaterThan(rollbackArmed);
		expect(effectivePolicy).toBeGreaterThan(pinWrite);
		expect(restartAttempted).toBeGreaterThan(effectivePolicy);
		expect(restart).toBeGreaterThan(restartAttempted);
		expect(restart).toBeGreaterThan(pinRender);
		expect(verify).toBeGreaterThan(restart);
		expect(hardFailure).toBeGreaterThan(verify);
	});
});
