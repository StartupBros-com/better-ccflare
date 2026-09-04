import { afterEach, describe, expect, test } from "bun:test";
import { resolveBuildProvenance } from "@better-ccflare/core";
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
const systemdDocs = join(repoRoot, "docs", "systemd.md");
const deploymentDocs = join(repoRoot, "docs", "deployment.md");
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

function capturedOutput(
	output: Uint8Array | undefined,
	stream: "stdout" | "stderr",
): string {
	if (output === undefined) {
		throw new Error(`command did not capture ${stream}`);
	}
	return output.toString();
}

function expectCommandOk(result: ReturnType<typeof Bun.spawnSync>): void {
	if (result.exitCode !== 0) {
		throw new Error(
			`command failed (${result.exitCode}):\n${capturedOutput(result.stdout, "stdout")}\n${capturedOutput(result.stderr, "stderr")}`,
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
			`failed to convert Windows path for bash: ${capturedOutput(result.stderr, "stderr").trim()}`,
		);
	}
	const converted = capturedOutput(result.stdout, "stdout").trim();
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
		// Respond once and hang up, matching the fixture's `Connection: close`.
		// Destroy in the flush callback rather than waiting for the peer's FIN:
		// Bun 1.4.0's node:net never surfaces the passive close on a server
		// socket after `end(data)`, so `server.close()` in the teardown would
		// wait for this connection until the test timed out.
		socket.end(rawResponse, () => socket.destroy());
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
		["-c", `exec bash ${shellQuote(shellPath(runnerScript))}`],
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
				// This helper probes the tunnel admission boundary with deliberately
				// inert child binaries. Keep each probe one-shot so the suite does not
				// spend its timeout budget exercising the production restart policy.
				RUNNER_RESTART_MAX_FAILURES: "1",
				RUNNER_RESTART_BACKOFF_BASE_MS: "0",
				RUNNER_RESTART_BACKOFF_MAX_MS: "0",
				RUNNER_CIRCUIT_HOLD: "false",
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

describe("systemd documentation contracts", () => {
	test("keeps StartLimit directives in the Unit section", () => {
		for (const path of [systemdDocs, deploymentDocs]) {
			const source = readFileSync(path, "utf8");
			const unitStart = source.indexOf("[Unit]");
			const serviceStart = source.indexOf("[Service]", unitStart + 1);
			const interval = source.indexOf(
				"StartLimitIntervalSec=300",
				unitStart + 1,
			);
			const burst = source.indexOf("StartLimitBurst=5", unitStart + 1);

			expect(unitStart).toBeGreaterThanOrEqual(0);
			expect(serviceStart).toBeGreaterThan(unitStart);
			expect(interval).toBeGreaterThan(unitStart);
			expect(interval).toBeLessThan(serviceStart);
			expect(burst).toBeGreaterThan(unitStart);
			expect(burst).toBeLessThan(serviceStart);
			expect(source).not.toContain("Restart=always");
			expect(source).not.toContain("StartLimitIntervalSec=120");
			expect(source).toContain("RUNNER_FAILURE_STOP_BUDGET_MS");
		}
	});
});

describe("render_systemd_pin", () => {
	test("renders the complete production RSS recycle tuple", () => {
		const source = readFileSync(join(repoRoot, helperScriptForShell), "utf8");
		for (const line of [
			"Environment=RUNNER_RSS_THRESHOLD_BYTES=4294967296",
			"Environment=RUNNER_RSS_POLL_INTERVAL_MS=60000",
			"Environment=RUNNER_RSS_MIN_UPTIME_MS=1800000",
			"Environment=RUNNER_RSS_CONSECUTIVE_SAMPLES=5",
			"Environment=RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000",
			"Environment=RUNNER_RSS_MAX_RECYCLES=3",
			"Environment=RUNNER_RSS_RECYCLE_WINDOW_MS=86400000",
		])
			expect(source).toContain(line);
	});

	test("verifies every rendered RSS tuple line before restarting production", () => {
		const deploySource = readFileSync(deployScript, "utf8");
		for (const line of [
			"Environment=RUNNER_RSS_THRESHOLD_BYTES=4294967296",
			"Environment=RUNNER_RSS_POLL_INTERVAL_MS=60000",
			"Environment=RUNNER_RSS_MIN_UPTIME_MS=1800000",
			"Environment=RUNNER_RSS_CONSECUTIVE_SAMPLES=5",
			"Environment=RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000",
			"Environment=RUNNER_RSS_MAX_RECYCLES=3",
			"Environment=RUNNER_RSS_RECYCLE_WINDOW_MS=86400000",
		]) {
			expect(deploySource).toContain(`"${line}"`);
		}
	});
	// A deploy that renders one budget and then verifies a different literal
	// aborts after the build, mid-pin-swap. That is exactly how the 1 GiB
	// app-admission pin shipped broken: the renderer moved, the post-render
	// verification list did not, and the failure only surfaced against the real
	// systemd unit. Keep the two literal lists tied together here.
	test("verifies every body-policy line it renders", () => {
		const renderer = readFileSync(join(repoRoot, helperScriptForShell), "utf8");
		const deployer = readFileSync(deployScript, "utf8");
		const renderedBodyPolicyLines = [
			...renderer.matchAll(
				/"(Environment=(?:GUARD_MAX_REQUEST_BODY_BYTES|GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES|CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES|CCFLARE_MAX_BODY_ADMISSION_QUEUE)=\d+)"/g,
			),
		].map((match) => match[1]);

		expect(renderedBodyPolicyLines).toHaveLength(4);
		for (const line of renderedBodyPolicyLines) {
			expect(deployer).toContain(`"${line}"`);
		}
	});

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
		expect(capturedOutput(result.stderr, "stderr")).toBe("");
		expect(result.exitCode).toBe(0);
		expect(readFileSync(output, "utf8")).toBe(
			[
				"# BEGIN better-ccflare managed deployment",
				"[Unit]",
				"StartLimitIntervalSec=300s",
				"StartLimitBurst=5",
				"[Service]",
				"Environment=KEEP_ME=unchanged",
				"Environment=OPERATOR_OVERRIDE=must-not-survive",
				"Environment=CCFLARE_BIN=/new/bin",
				"Environment=CCFLARE_DISTRIBUTION=v1:startupbros-managed-source",
				"Environment=CCFLARE_PRODUCER=startupbros",
				"Environment=CCFLARE_ARTIFACT_MODE=managed-source",
				"Environment=CCFLARE_GIT_SHA=abc123",
				"Environment=CCFLARE_GIT_REF=refs/heads/main",
				"Environment=CCFLARE_SOURCE_SHA=abc123",
				"Environment=CCFLARE_SOURCE_REF=refs/heads/main",
				`Environment=GUARD_SCRIPT=${guardScript}`,
				"Environment=GUARD_SOURCE_ID=abc123",
				"Environment=GUARD_POLICY_ID=pool-exhaustion-finite-recovery-v1",
				`Environment=GUARD_SHA256=${sha256Of(guardScript)}`,
				`Environment=GUARD_POLICY_SHA256=${sha256Of(guardPolicyScript)}`,
				`Environment=RUNNER_SHA256=${sha256Of(runnerScriptFixture)}`,
				"Environment=GUARD_MAX_REQUEST_BODY_BYTES=33554432",
				"Environment=GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"Environment=CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=1073741824",
				"Environment=CCFLARE_MAX_BODY_ADMISSION_QUEUE=500",
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000",
				"Environment=GUARD_MAX_RECOVERY_SLEEP_MS=120000",
				"Environment=GUARD_MAX_RECOVERY_WAITS=12",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"Environment=RUNNER_FAILURE_STOP_BUDGET_MS=30000",
				"Environment=RUNNER_RSS_THRESHOLD_BYTES=4294967296",
				"Environment=RUNNER_RSS_POLL_INTERVAL_MS=60000",
				"Environment=RUNNER_RSS_MIN_UPTIME_MS=1800000",
				"Environment=RUNNER_RSS_CONSECUTIVE_SAMPLES=5",
				"Environment=RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000",
				"Environment=RUNNER_RSS_MAX_RECYCLES=3",
				"Environment=RUNNER_RSS_RECYCLE_WINDOW_MS=86400000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
				"Restart=on-failure",
				"RestartSec=5s",
				"RestartPreventExitStatus=143",
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
		expect(readFileSync(output, "utf8")).toContain(
			"Environment=KEEP_ME=unchanged",
		);
		expect(readFileSync(output, "utf8")).toContain(
			"Environment=OPERATOR_OVERRIDE=must-not-survive",
		);
		expect(readFileSync(output, "utf8")).not.toContain(
			"CCFLARE_GUARD_CORRELATION_SECRET",
		);
	});

	test("preserves unrelated assignments from mixed Environment directives", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				'Environment="NODE_OPTIONS=--max-old-space-size=4096" "CCFLARE_MAX_BODY_ADMISSION_QUEUE=400" "HTTP_PROXY=http://proxy.example"',
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered).toContain(
			'Environment="NODE_OPTIONS=--max-old-space-size=4096" "HTTP_PROXY=http://proxy.example"',
		);
		expect(rendered).not.toContain("CCFLARE_MAX_BODY_ADMISSION_QUEUE=400");
		expect(rendered).toContain(
			"Environment=CCFLARE_MAX_BODY_ADMISSION_QUEUE=500",
		);
	});

	test("preserves only final effective unowned assignments after resets and excludes stale Docker provenance", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const secondOutput = join(dir, "pin.second-rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				'Environment=HTTP_PROXY=http://before.example "KEEP=before reset" CCFLARE_VERSION=v3.5.65 CCFLARE_BUILD_DATE=2026-08-01',
				"Environment=CCFLARE_CHECKOUT_SHA=checkout CCFLARE_EVENT_SHA=event CCFLARE_TAG_SHA=tag",
				"Environment=",
				'Environment="HTTP_PROXY=http://after.example" \\',
				"  'KEEP=after reset' \"CONTINUED=raw spelling\"",
				'Environment=HTTP_PROXY=http://final.example "KEEP=final value"',
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const render = (source: string, target: string) =>
			bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`render_systemd_pin ${shellQuote(shellPath(source))} ${shellQuote(shellPath(target))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
				].join("\n"),
			);

		const first = render(input, output);
		expect(first.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered).toContain('Environment="CONTINUED=raw spelling"');
		expect(rendered).toContain(
			'Environment=HTTP_PROXY=http://final.example "KEEP=final value"',
		);
		for (const stale of [
			"HTTP_PROXY=http://before.example",
			"KEEP=before reset",
			"HTTP_PROXY=http://after.example",
			"KEEP=after reset",
			"CCFLARE_VERSION=v3.5.65",
			"CCFLARE_BUILD_DATE=2026-08-01",
			"CCFLARE_CHECKOUT_SHA=checkout",
			"CCFLARE_EVENT_SHA=event",
			"CCFLARE_TAG_SHA=tag",
		]) {
			expect(rendered).not.toContain(stale);
		}

		const second = render(output, secondOutput);
		expect(second.exitCode).toBe(0);
		expect(readFileSync(secondOutput, "utf8")).toBe(rendered);
	});

	test("treats quoted empty Environment directives as resets", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				"Environment=BEFORE_RESET=old",
				'Environment=""',
				"Environment=AFTER_DOUBLE_RESET=must-not-survive",
				"Environment=''",
				"Environment=AFTER_SINGLE_RESET=survives",
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered).toContain("Environment=AFTER_SINGLE_RESET=survives");
		expect(rendered).not.toContain("BEFORE_RESET=old");
		expect(rendered).not.toContain("AFTER_DOUBLE_RESET=must-not-survive");
	});

	test("ignores comments within Environment continuations", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				"Environment=HTTP_PROXY=http://proxy.example \\",
				"  # This comment must not terminate the continuation.",
				'  "KEEP=continued value"',
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered).toContain(
			'Environment=HTTP_PROXY=http://proxy.example "KEEP=continued value"',
		);
		expect(rendered).not.toContain("This comment must not terminate");
	});

	test("classifies escaped Environment names while retaining their raw spelling", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				"Environment=HTTP_PROXY\\x3dhttp://proxy.example HTTPS_PROXY\\075http://secure-proxy.example CCFLARE_BIN\\x3d/stale/bin",
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered).toContain(
			"Environment=HTTP_PROXY\\x3dhttp://proxy.example HTTPS_PROXY\\075http://secure-proxy.example",
		);
		expect(rendered).not.toContain("CCFLARE_BIN\\x3d/stale/bin");
	});

	test("accepts documented C escapes without changing raw tokens", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		const escapes = [
			"a",
			"b",
			"f",
			"n",
			"r",
			"t",
			"v",
			"\\",
			'"',
			"'",
			"s",
			"040",
			"101",
		];
		const assignments = escapes.map(
			(escape, index) => `ESCAPE_${index}=\\${escape}`,
		);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				`Environment=${assignments.join(" ")}`,
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		expect(readFileSync(output, "utf8")).toContain(
			`Environment=${assignments.join(" ")}`,
		);
	});

	test("rejects malformed C escapes in Environment directives", () => {
		for (const invalid of ["\\x", "\\x3g", "\\08", "\\q"]) {
			const dir = tempDir();
			const input = join(dir, "pin.conf");
			const output = join(dir, "pin.rendered.conf");
			const { guard, policy, runner } = writeDigestFixtures(dir);
			writeFileSync(
				input,
				[
					"# BEGIN better-ccflare managed deployment",
					"[Service]",
					`Environment=HTTP_PROXY${invalid}http://proxy.example`,
					"# END better-ccflare managed deployment",
					"",
				].join("\n"),
			);

			const result = bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
				].join("\n"),
			);

			expect(result.exitCode).toBe(2);
			expect(capturedOutput(result.stderr, "stderr")).toContain(
				"invalid systemd Environment directive: invalid escape",
			);
		}
	});

	test("does not preserve the deployment-owned update channel from mixed Environment directives", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(
			input,
			[
				"# BEGIN better-ccflare managed deployment",
				"[Service]",
				'Environment="NODE_OPTIONS=--max-old-space-size=4096" \'CCFLARE_UPDATE_CHANNEL=nightly\' "HTTP_PROXY=http://proxy.example"',
				"# END better-ccflare managed deployment",
				"",
			].join("\n"),
		);

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(rendered).toContain(
			'Environment="NODE_OPTIONS=--max-old-space-size=4096" "HTTP_PROXY=http://proxy.example"',
		);
		expect(rendered).not.toContain("CCFLARE_UPDATE_CHANNEL=nightly");
	});

	test("leaves correlation credential generation to the restart-scoped runner", () => {
		const deploySource = readFileSync(deployScript, "utf8");

		expect(deploySource).toContain("run-ccflare-stack.sh");
		expect(deploySource).not.toMatch(
			/Environment=.*CCFLARE_GUARD_CORRELATION_SECRET/,
		);
		expect(deploySource).not.toMatch(
			/CCFLARE_GUARD_CORRELATION_SECRET=[A-Za-z0-9_-]+/,
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
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"contains unmanaged systemd configuration outside",
		);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"line 2: [Service]",
		);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"Migrate operator policy to a later drop-in",
		);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"90-operator-policy.conf",
		);
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
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"sha256_file requires one existing file",
		);
	});

	test("accepts an empty or comment-only legacy file and replaces it from scratch", () => {
		const dir = tempDir();
		const input = join(dir, "pin.conf");
		const output = join(dir, "pin.rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(input, "\n  # deployment note\n\t; another comment\n\n");

		const result = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abc123 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);

		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		expect(
			rendered.startsWith("# BEGIN better-ccflare managed deployment\n"),
		).toBe(true);
		expect(rendered).not.toContain("deployment note");
		expect(rendered).not.toContain("another comment");
		expect(rendered).toContain("Environment=GUARD_TOTAL_DEADLINE_MS=600000");
		expect(rendered).toContain(
			"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000",
		);
		expect(rendered).toContain(
			"Environment=GUARD_MAX_RECOVERY_SLEEP_MS=120000",
		);
		expect(rendered).toContain("Environment=GUARD_SHUTDOWN_GRACE_MS=600000");
		expect(rendered).toContain(
			"Environment=RUNNER_FAILURE_STOP_BUDGET_MS=30000",
		);
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
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"invalid managed marker structure",
		);
	});
});

describe("deployment provenance pin", () => {
	test("renders an exact managed-source identity and leaves a restored legacy pin unproven", () => {
		const dir = tempDir();
		const input = join(dir, "legacy.conf");
		const output = join(dir, "rendered.conf");
		const { guard, policy, runner } = writeDigestFixtures(dir);
		writeFileSync(input, "# legacy pin without provenance\n");
		const result = bash(
			[
			`source ${shellQuote(helperScriptForShell)}`,
			`render_systemd_pin ${shellQuote(shellPath(input))} ${shellQuote(shellPath(output))} /new/bin ${shellQuote(shellPath(runner))} ${shellQuote(shellPath(guard))} abcdef1234567890abcdef1234567890abcdef12 policy-v1 ${shellQuote(shellPath(policy))}`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(0);
		const rendered = readFileSync(output, "utf8");
		for (const line of [
			"Environment=CCFLARE_DISTRIBUTION=v1:startupbros-managed-source",
			"Environment=CCFLARE_PRODUCER=startupbros",
			"Environment=CCFLARE_ARTIFACT_MODE=managed-source",
			"Environment=CCFLARE_GIT_SHA=abcdef1234567890abcdef1234567890abcdef12",
			"Environment=CCFLARE_GIT_REF=refs/heads/main",
			"Environment=CCFLARE_SOURCE_SHA=abcdef1234567890abcdef1234567890abcdef12",
			"Environment=CCFLARE_SOURCE_REF=refs/heads/main",
		])
			expect(rendered).toContain(line);

		const legacy = resolveBuildProvenance({
			CCFLARE_GIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
			CCFLARE_GIT_REF: "refs/heads/main",
		});
		expect(legacy).toMatchObject({
			proven: false,
			reason: "unknown_distribution",
		});
	});
});

describe("configured_systemd_environment_value", () => {
	test("reads the last plain, quoted, or escaped numeric operator value", () => {
		const dir = tempDir();
		const pin = join(dir, "pin.conf");
		writeFileSync(
			pin,
			[
				"[Service]",
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				'Environment="GUARD_TOTAL_DEADLINE_MS=900000"',
				"Environment=GUARD_TOTAL_DEADLINE_MS\\075950000",
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
		expect(capturedOutput(result.stdout, "stdout").trim()).toBe("950000");
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
				"    \"GUARD_TOTAL_DEADLINE_MS=900000\" 'GUARD_SHUTDOWN_GRACE_MS=900000'",
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
		expect(capturedOutput(result.stdout, "stdout").trim().split("\n")).toEqual([
			"900000",
			"900000",
		]);
	});
});

describe("validate_deployment_timing", () => {
	test("accepts the safe defaults, lower silence ceilings, and named serialization", () => {
		for (const [deadline, headroom, maxSleep, grace, timeout, expected] of [
			[
				"600000",
				"30000",
				"120000",
				"600000",
				"720s",
				[
					"guard_total_deadline_ms=600000",
					"guard_retry_attempt_headroom_ms=30000",
					"guard_max_recovery_sleep_ms=120000",
					"guard_shutdown_grace_ms=600000",
					"guard_max_recovery_waits=12",
					"stop_timeout_ms=720000",
						"guard_max_request_body_bytes=33554432",
						"guard_max_buffered_request_body_bytes=268435456",
						"body_admission_budget_bytes=268435456",
						"body_admission_queue_limit=500",
				].join("\n"),
			],
			[
				"900000",
				"45000",
				"90000",
				"900000",
				"17min",
				[
					"guard_total_deadline_ms=900000",
					"guard_retry_attempt_headroom_ms=45000",
					"guard_max_recovery_sleep_ms=90000",
					"guard_shutdown_grace_ms=900000",
					"guard_max_recovery_waits=12",
					"stop_timeout_ms=1020000",
						"guard_max_request_body_bytes=33554432",
						"guard_max_buffered_request_body_bytes=268435456",
						"body_admission_budget_bytes=268435456",
						"body_admission_queue_limit=500",
				].join("\n"),
			],
		] as const) {
			const dir = tempDir();
			const pin = join(dir, "pin.conf");
			writeFileSync(
				pin,
				[
					"[Service]",
					"Environment=GUARD_MAX_REQUEST_BODY_BYTES=33554432",
					"Environment=GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
					"Environment=CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
					"Environment=CCFLARE_MAX_BODY_ADMISSION_QUEUE=500",
					`Environment=GUARD_TOTAL_DEADLINE_MS=${deadline}`,
					`Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=${headroom}`,
					`Environment=GUARD_MAX_RECOVERY_SLEEP_MS=${maxSleep}`,
					"Environment=GUARD_MAX_RECOVERY_WAITS=12",
					`Environment=GUARD_SHUTDOWN_GRACE_MS=${grace}`,
					"Environment=RUNNER_RSS_THRESHOLD_BYTES=4294967296",
					"Environment=RUNNER_RSS_POLL_INTERVAL_MS=60000",
					"Environment=RUNNER_RSS_MIN_UPTIME_MS=1800000",
					"Environment=RUNNER_RSS_CONSECUTIVE_SAMPLES=5",
					"Environment=RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000",
					"Environment=RUNNER_RSS_MAX_RECYCLES=3",
					"Environment=RUNNER_RSS_RECYCLE_WINDOW_MS=86400000",
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
			expect(capturedOutput(result.stdout, "stdout").trim()).toBe(expected);
		}
	});

	test.each(["120001", "180000", "0", "malformed"])(
		"rejects max recovery silence %s even when the deadline is larger",
		(maxSleep) => {
			const dir = tempDir();
			const pin = join(dir, "pin.conf");
			writeFileSync(
				pin,
				[
					"[Service]",
					"Environment=GUARD_TOTAL_DEADLINE_MS=900000",
					"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000",
					`Environment=GUARD_MAX_RECOVERY_SLEEP_MS=${maxSleep}`,
					"Environment=GUARD_MAX_RECOVERY_WAITS=12",
					"Environment=GUARD_SHUTDOWN_GRACE_MS=900000",
					"KillMode=mixed",
					"TimeoutStopSec=17min",
				].join("\n"),
			);
			const result = bash(
				`source ${shellQuote(helperScriptForShell)}\nvalidate_deployment_timing ${shellQuote(shellPath(pin))}`,
			);
			expect(result.exitCode).not.toBe(0);
		},
	);

	test("rejects a rendered policy with a missing recovery silence ceiling", () => {
		const dir = tempDir();
		const pin = join(dir, "pin.conf");
		writeFileSync(
			pin,
			[
				"[Service]",
				"Environment=GUARD_MAX_REQUEST_BODY_BYTES=33554432",
				"Environment=GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"Environment=CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"Environment=CCFLARE_MAX_BODY_ADMISSION_QUEUE=500",
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000",
				"Environment=GUARD_MAX_RECOVERY_WAITS=12",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
			].join("\n"),
		);
		const result = bash(
			`source ${shellQuote(helperScriptForShell)}\nvalidate_deployment_timing ${shellQuote(shellPath(pin))}`,
		);
		expect(result.exitCode).not.toBe(0);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"missing RUNNER_RSS_THRESHOLD_BYTES",
		);
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
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=600000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
			],
			[
				"Environment=GUARD_TOTAL_DEADLINE_MS=600000",
				"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=550000",
				"Environment=GUARD_SHUTDOWN_GRACE_MS=600000",
				"KillMode=mixed",
				"TimeoutStopSec=720s",
			],
		] as const) {
			const dir = tempDir();
			const pin = join(dir, "pin.conf");
			writeFileSync(
				pin,
				[
					"[Service]",
					"Environment=GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000",
					"Environment=GUARD_MAX_RECOVERY_SLEEP_MS=120000",
					"Environment=GUARD_MAX_RECOVERY_WAITS=12",
					...lines,
					"",
				].join("\n"),
			);
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
				"    printf '%s\\n' \"$CCFLARE_TEST_KILL_MODE\"",
				"  fi",
				"  exit 0",
				"fi",
				'if [[ "$*" == *"--property=TimeoutStopUSec"* ]]; then printf \'%s\\n\' "$CCFLARE_TEST_TIMEOUT"; exit 0; fi',
				'if [[ "$*" == *"--property=StartLimitIntervalUSec"* ]]; then printf \'%s\\n\' "${CCFLARE_TEST_START_LIMIT_INTERVAL_SEC:-300s}"; exit 0; fi',
				'if [[ "$*" == *"--property=StartLimitBurst"* ]]; then printf \'%s\\n\' "${CCFLARE_TEST_START_LIMIT_BURST:-5}"; exit 0; fi',
				'if [[ "$*" == *"--property=RestartUSec"* ]]; then printf \'%s\\n\' "${CCFLARE_TEST_RESTART_SEC:-5s}"; exit 0; fi',
				'if [[ "$*" == *"--property=RestartPreventExitStatus"* ]]; then printf \'%s\\n\' "${CCFLARE_TEST_RESTART_PREVENT_EXIT_STATUS:-143}"; exit 0; fi',
				'if [[ "$*" == *"--property=Restart"* ]]; then printf \'%s\\n\' "${CCFLARE_TEST_RESTART:-on-failure}"; exit 0; fi',
			'if [[ "$*" == *"--property=Environment"* ]]; then',
			'  if [[ -n "${CCFLARE_TEST_SAFE_POLICY_PIN:-}" && -n "${CCFLARE_TEST_SAFE_POLICY_BACKUP:-}" ]] && cmp -s "$CCFLARE_TEST_SAFE_POLICY_PIN" "$CCFLARE_TEST_SAFE_POLICY_BACKUP" && [[ -n "${CCFLARE_TEST_RESTORED_ENVIRONMENT+x}" ]]; then',
				"    printf '%s\\n' \"$CCFLARE_TEST_RESTORED_ENVIRONMENT\"",
			"  else",
			'    environment="$CCFLARE_TEST_ENVIRONMENT"',
			'    if [[ "${CCFLARE_TEST_OMIT_FAILURE_STOP_BUDGET:-0}" != "1" && "$environment" != *"RUNNER_FAILURE_STOP_BUDGET_MS="* ]]; then environment="$environment RUNNER_FAILURE_STOP_BUDGET_MS=${CCFLARE_TEST_FAILURE_STOP_BUDGET:-30000}"; fi',
				"    printf '%s\\n' \"$environment\"",
				"  fi",
				"  exit 0",
				"fi",
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
			"export CCFLARE_TEST_ENVIRONMENT='KEEP=1 GUARD_MAX_REQUEST_BODY_BYTES=33554432 GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 CCFLARE_MAX_BODY_ADMISSION_QUEUE=500 GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_SLEEP_MS=120000 GUARD_MAX_RECOVERY_WAITS=12 GUARD_SHUTDOWN_GRACE_MS=600000 RUNNER_RSS_THRESHOLD_BYTES=4294967296 RUNNER_RSS_POLL_INTERVAL_MS=60000 RUNNER_RSS_MIN_UPTIME_MS=1800000 RUNNER_RSS_CONSECUTIVE_SAMPLES=5 RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000 RUNNER_RSS_MAX_RECYCLES=3 RUNNER_RSS_RECYCLE_WINDOW_MS=86400000'",
			`source ${shellQuote(helperScriptForShell)}`,
		];
		const good = bash(
			[...base, "validate_effective_systemd_policy ccflare-stack.service"].join(
				"\n",
			),
		);
		expect(good.exitCode).toBe(0);
		expect(capturedOutput(good.stdout, "stdout")).toContain(
			"guard_max_recovery_sleep_ms=120000",
		);
		expect(capturedOutput(good.stdout, "stdout")).toContain(
			"guard_max_recovery_waits=12",
		);
		expect(capturedOutput(good.stdout, "stdout")).toContain(
			"runner_failure_stop_budget_ms=30000",
		);

		for (const restart of ["always", "no"] as const) {
			const invalidRestart = bash(
				[
					...base,
					`export CCFLARE_TEST_RESTART=${shellQuote(restart)}`,
					"validate_effective_systemd_policy ccflare-stack.service",
				].join("\n"),
			);
			expect(invalidRestart.exitCode).not.toBe(0);
		}
		for (const [interval, burst] of [
			["299999999", "5"],
			["300000000", "6"],
		] as const) {
			const invalidStartLimit = bash(
				[
					...base,
					`export CCFLARE_TEST_START_LIMIT_INTERVAL_SEC=${interval === "299999999" ? "299s" : "300s"}`,
					`export CCFLARE_TEST_START_LIMIT_BURST=${burst}`,
					"validate_effective_systemd_policy ccflare-stack.service",
				].join("\n"),
			);
			expect(invalidStartLimit.exitCode).not.toBe(0);
		}

		const safeOperatorOverride = bash(
			[
				...base,
				"export CCFLARE_TEST_TIMEOUT='17min'",
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_MAX_REQUEST_BODY_BYTES=16777216 GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=33554432 CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 CCFLARE_MAX_BODY_ADMISSION_QUEUE=500 GUARD_TOTAL_DEADLINE_MS=900000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=45000 GUARD_MAX_RECOVERY_SLEEP_MS=90000 GUARD_MAX_RECOVERY_WAITS=20 GUARD_SHUTDOWN_GRACE_MS=900000 RUNNER_RSS_THRESHOLD_BYTES=4294967296 RUNNER_RSS_POLL_INTERVAL_MS=60000 RUNNER_RSS_MIN_UPTIME_MS=1800000 RUNNER_RSS_CONSECUTIVE_SAMPLES=5 RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000 RUNNER_RSS_MAX_RECYCLES=3 RUNNER_RSS_RECYCLE_WINDOW_MS=86400000'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(safeOperatorOverride.exitCode).toBe(0);
		expect(capturedOutput(safeOperatorOverride.stdout, "stdout")).toContain(
			"guard_max_recovery_sleep_ms=90000",
		);
		expect(capturedOutput(safeOperatorOverride.stdout, "stdout")).toContain(
			"guard_max_recovery_waits=20",
		);

		for (const maxSleep of ["120001", "180000", "0", "malformed"]) {
			const invalidRecoverySilence = bash(
				[
					...base,
					`export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=900000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=45000 GUARD_MAX_RECOVERY_SLEEP_MS=${maxSleep} GUARD_MAX_RECOVERY_WAITS=12 GUARD_SHUTDOWN_GRACE_MS=900000'`,
					"export CCFLARE_TEST_TIMEOUT='17min'",
					"validate_effective_systemd_policy ccflare-stack.service",
				].join("\n"),
			);
			expect(invalidRecoverySilence.exitCode).not.toBe(0);
		}

		const missingRecoveryWaits = bash(
			[
				...base,
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_SLEEP_MS=120000 GUARD_SHUTDOWN_GRACE_MS=600000'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(missingRecoveryWaits.exitCode).not.toBe(0);

		const missingFailureStopBudget = bash(
			[
				...base,
				"export CCFLARE_TEST_OMIT_FAILURE_STOP_BUDGET=1",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(missingFailureStopBudget.exitCode).not.toBe(0);

		for (const budget of ["0", "120001", "malformed"]) {
			const invalidFailureStopBudget = bash(
				[
					...base,
					`export CCFLARE_TEST_FAILURE_STOP_BUDGET=${shellQuote(budget)}`,
					"validate_effective_systemd_policy ccflare-stack.service",
				].join("\n"),
			);
			expect(invalidFailureStopBudget.exitCode).not.toBe(0);
		}

		const missingRecoverySilence = bash(
			[
				...base,
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_WAITS=12 GUARD_SHUTDOWN_GRACE_MS=600000'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(missingRecoverySilence.exitCode).not.toBe(0);

		const infeasibleRecoverySilence = bash(
			[
				...base,
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=550000 GUARD_MAX_RECOVERY_SLEEP_MS=60000 GUARD_MAX_RECOVERY_WAITS=12 GUARD_SHUTDOWN_GRACE_MS=600000'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(infeasibleRecoverySilence.exitCode).not.toBe(0);

		const overridden = bash(
			[
				...base,
				"export CCFLARE_TEST_TIMEOUT='10min'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(overridden.exitCode).not.toBe(0);

		const missingHeadroom = bash(
			[
				...base,
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_SHUTDOWN_GRACE_MS=600000'",
				"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(missingHeadroom.exitCode).not.toBe(0);
	});

	test("rejects missing, noninteger, out-of-range, and inconsistent effective body policies", () => {
		const dir = tempDir();
		const { binDir, log } = writeSystemctlMock(dir);
		const base = [
			`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
			`export CCFLARE_TEST_SYSTEMCTL_LOG=${shellQuote(shellPath(log))}`,
			"export CCFLARE_TEST_KILL_MODE=mixed",
			"export CCFLARE_TEST_TIMEOUT=12min",
			`source ${shellQuote(helperScriptForShell)}`,
		];
		const safe =
			"GUARD_MAX_REQUEST_BODY_BYTES=33554432 GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 CCFLARE_MAX_BODY_ADMISSION_QUEUE=500 GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_SLEEP_MS=120000 GUARD_MAX_RECOVERY_WAITS=12 GUARD_SHUTDOWN_GRACE_MS=600000 RUNNER_RSS_THRESHOLD_BYTES=4294967296 RUNNER_RSS_POLL_INTERVAL_MS=60000 RUNNER_RSS_MIN_UPTIME_MS=1800000 RUNNER_RSS_CONSECUTIVE_SAMPLES=5 RUNNER_RSS_RECYCLE_COOLDOWN_MS=3600000 RUNNER_RSS_MAX_RECYCLES=3 RUNNER_RSS_RECYCLE_WINDOW_MS=86400000";
		const good = bash(
			[
			...base,
			`export CCFLARE_TEST_ENVIRONMENT='${safe}'`,
			"validate_effective_systemd_policy ccflare-stack.service",
			].join("\n"),
		);
		expect(good.exitCode).toBe(0);
		expect(capturedOutput(good.stdout, "stdout")).toContain(
			"guard_max_request_body_bytes=33554432",
		);
		expect(capturedOutput(good.stdout, "stdout")).toContain(
			"guard_max_buffered_request_body_bytes=268435456",
		);

		for (const environment of [
			safe.replace("GUARD_MAX_REQUEST_BODY_BYTES=33554432 ", ""),
			safe.replace("GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 ", ""),
			safe.replace("CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456 ", ""),
			safe.replace("CCFLARE_MAX_BODY_ADMISSION_QUEUE=500 ", ""),
			safe.replace(
				"CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=1",
			),
			safe.replace(
				"CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES=1073741825",
			),
			safe.replace(
				"CCFLARE_MAX_BODY_ADMISSION_QUEUE=500",
				"CCFLARE_MAX_BODY_ADMISSION_QUEUE=5001",
			),
			safe.replace(
				"CCFLARE_MAX_BODY_ADMISSION_QUEUE=500",
				"CCFLARE_MAX_BODY_ADMISSION_QUEUE=invalid",
			),
			safe.replace(
				"GUARD_MAX_REQUEST_BODY_BYTES=33554432",
				"GUARD_MAX_REQUEST_BODY_BYTES=1.5",
			),
			safe.replace(
				"GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=not-a-number",
			),
			safe.replace(
				"GUARD_MAX_REQUEST_BODY_BYTES=33554432",
				"GUARD_MAX_REQUEST_BODY_BYTES=1023",
			),
			safe.replace(
				"GUARD_MAX_REQUEST_BODY_BYTES=33554432",
				"GUARD_MAX_REQUEST_BODY_BYTES=33554433",
			),
			safe.replace(
				"GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435457",
			),
			safe.replace(
				"GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=268435456",
				"GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES=67108863",
			),
		]) {
			const invalid = bash(
				[
				...base,
				`export CCFLARE_TEST_ENVIRONMENT='${environment}'`,
				"validate_effective_systemd_policy ccflare-stack.service",
				].join("\n"),
			);
			expect(invalid.exitCode).not.toBe(0);
		}
	});

	test("allows a legacy restart policy only for rollback compatibility", () => {
		const dir = tempDir();
		const { binDir, log } = writeSystemctlMock(dir);
		const base = [
			`export PATH=${shellQuote(shellPath(binDir))}:$PATH`,
			`export CCFLARE_TEST_SYSTEMCTL_LOG=${shellQuote(shellPath(log))}`,
			"export CCFLARE_TEST_KILL_MODE=mixed",
			"export CCFLARE_TEST_TIMEOUT=12min",
			"export CCFLARE_TEST_RESTART=always",
			"export CCFLARE_TEST_RESTART_SEC=10s",
			"export CCFLARE_TEST_RESTART_PREVENT_EXIT_STATUS=''",
			"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_SLEEP_MS=120000 GUARD_MAX_RECOVERY_WAITS=12 GUARD_SHUTDOWN_GRACE_MS=600000'",
			`source ${shellQuote(helperScriptForShell)}`,
		];
		const strict = bash(
			[...base, "validate_effective_systemd_policy ccflare-stack.service"].join(
				"\n",
			),
		);
		expect(strict.exitCode).not.toBe(0);
		const rollback = bash(
			[
				...base,
				"validate_effective_systemd_policy ccflare-stack.service 1",
			].join("\n"),
		);
		expect(rollback.exitCode).toBe(0);
	});
	test("restores and accepts a safe pre-headroom pin without restarting", () => {
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
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_SLEEP_MS=120000 GUARD_SHUTDOWN_GRACE_MS=600000'",
				"export CCFLARE_TEST_RESTORED_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_SHUTDOWN_GRACE_MS=600000'",
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
		expect(events.some((event) => event.includes("systemctl restart"))).toBe(
			false,
		);
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
				"export CCFLARE_TEST_ENVIRONMENT='GUARD_TOTAL_DEADLINE_MS=600000 GUARD_RETRY_ATTEMPT_HEADROOM_MS=30000 GUARD_MAX_RECOVERY_SLEEP_MS=120000 GUARD_SHUTDOWN_GRACE_MS=600000'",
				`source ${shellQuote(helperScriptForShell)}`,
				`reload_validate_or_restore_systemd_policy ${shellQuote(shellPath(pin))} ${shellQuote(shellPath(backup))} ccflare-stack.service`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(70);
		expect(readFileSync(pin, "utf8")).toBe("old pin\n");
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"operator drop-ins still produce an unsafe effective systemd policy",
		);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"90-operator-policy.conf",
		);
		const events = readFileSync(log, "utf8").trim().split("\n");
		expect(
			events.filter((event) => event === "systemctl:daemon-reload"),
		).toHaveLength(2);
		expect(
			events.filter((event) => event.includes("--property=KillMode")),
		).toHaveLength(2);
		expect(events.some((event) => event.includes("systemctl restart"))).toBe(
			false,
		);
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
		expect(capturedOutput(result.stdout, "stdout")).toBe("1");
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
				"  printf 'operator edit\\n' >\"$3\"",
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
		expect(capturedOutput(result.stderr, "stderr")).toContain(
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
		expect(capturedOutput(result.stderr, "stderr")).toContain(
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
			bodyAdmission: {
				budgetBytes: 268_435_456,
				queueLimit: 500,
			},
			limits: {
				totalDeadlineMs: 900_000,
				retryAttemptHeadroomMs: 45_000,
				maxRecoverySleepMs: 120_000,
				maxRecoveryWaits: 12,
				shutdownGraceMs: 900_000,
				maxAttempts: 3,
				jitterMs: 2_000,
				maxInspectionBytes: 65_536,
				maxRequestBodyBytes: 33_554_432,
				maxBufferedRequestBodyBytes: 268_435_456,
			},
		});
		const proxy = JSON.stringify({
			git_sha: "abc123",
			runtime: {
				bodyAdmission: {
					budgetBytes: 268_435_456,
					queueLimit: 500,
				},
			},
		});
		const guard = JSON.stringify({
			sourceId: "full-sha",
			policyId: "pool-exhaustion-finite-recovery-v1",
			maxRequestBodyBytes: 33_554_432,
			maxBufferedRequestBodyBytes: 268_435_456,
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
					retryAttemptHeadroomMs: 45_000,
					maxRecoverySleepMs: 120_000,
					maxRecoveryWaits: 12,
					shutdownGraceMs: 900_000,
					maxAttempts: 3,
					jitterMs: 2_000,
					maxInspectionBytes: 65_536,
					maxRequestBodyBytes: 33_554_432,
					maxBufferedRequestBodyBytes: 268_435_456,
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
			['"budgetBytes":268435456', '"budgetBytes":1'],
			['"queueLimit":500', '"queueLimit":1'],
			['"runnerPid":42', '"runnerPid":99'],
			['"sha256":"guard-digest"', '"sha256":"wrong"'],
			['"maxAttempts":3', '"maxAttempts":9'],
			['"retryAttemptHeadroomMs":45000', '"retryAttemptHeadroomMs":1'],
			['"maxRecoverySleepMs":120000', '"maxRecoverySleepMs":300000'],
			['"maxRequestBodyBytes":33554432', '"maxRequestBodyBytes":1'],
			[
				'"maxBufferedRequestBodyBytes":268435456,"runtime"',
				'"maxBufferedRequestBodyBytes":1,"runtime"',
			],
		] as const) {
			const bad = bash(
				[
					`source ${shellQuote(helperScriptForShell)}`,
					`validate_deploy_health ${shellQuote(proxy.replace(needle, replacement))} ${shellQuote(guard.replace(needle, replacement))} ${shellQuote(expected)}`,
				].join("\n"),
			);
			expect(bad.exitCode).not.toBe(0);
		}

		const unsafeExpectedAndActual = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`validate_deploy_health ${shellQuote(proxy)} ${shellQuote(guard.replaceAll('"maxRecoverySleepMs":120000', '"maxRecoverySleepMs":180000'))} ${shellQuote(expected.replace('"maxRecoverySleepMs":120000', '"maxRecoverySleepMs":180000'))}`,
			].join("\n"),
		);
		expect(unsafeExpectedAndActual.exitCode).not.toBe(0);
	});
});

describe("rollback identity proof", () => {
	test("accepts a legacy rollback identity without aggregate body-policy fields and rejects missing identity", () => {
		const proxy = '{"git_sha":"old"}';
		const completeGuard = JSON.stringify({
			sourceId: "old-source",
			policyId: "old-policy",
			maxRequestBodyBytes: 4_194_304,
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
					maxRequestBodyBytes: 4_194_304,
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

	test("requires complete body-policy proof for current-format rollback snapshots", () => {
		const proxy = '{"git_sha":"current"}';
		const incompleteCurrentGuard = JSON.stringify({
			sourceId: "current-source",
			policyId: "current-policy",
			maxRequestBodyBytes: 33_554_432,
			maxBufferedRequestBodyBytes: 268_435_456,
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
					maxRequestBodyBytes: 33_554_432,
				},
			},
		});
		const result = bash(
			[
			`source ${shellQuote(helperScriptForShell)}`,
			`validate_rollback_health ${shellQuote(proxy)} ${shellQuote(incompleteCurrentGuard)} ${shellQuote(proxy)} ${shellQuote(incompleteCurrentGuard)}`,
			].join("\n"),
		);
		expect(result.exitCode).toBe(70);
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
		expect(capturedOutput(result.stdout, "stdout").trim().split("\n")).toEqual([
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
			expect(capturedOutput(invalid.stdout, "stdout")).toContain(
				`invalid GUARD_SHUTDOWN_GRACE_MS=${value}`,
			);
		}

		const zero = bash(
			`GUARD_SHUTDOWN_GRACE_MS=0 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(zero.exitCode).toBe(64);
	});

	test("bounds failure cleanup separately from the intentional stop grace", () => {
		for (const value of ["0", "120001", "-1", "12ms"]) {
			const invalid = bash(
				`RUNNER_FAILURE_STOP_BUDGET_MS=${shellQuote(value)} CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
			);
			expect(invalid.exitCode).toBe(64);
			expect(capturedOutput(invalid.stdout, "stdout")).toContain(
				`invalid RUNNER_FAILURE_STOP_BUDGET_MS=${value}`,
			);
		}

		const source = readFileSync(runnerScript, "utf8");
		expect(source).toContain(
			"RUNNER_FAILURE_STOP_BUDGET_MS=${RUNNER_FAILURE_STOP_BUDGET_MS:-30000}",
		);
		expect(source).toContain(
			'validate_bounded_ms RUNNER_FAILURE_STOP_BUDGET_MS "$RUNNER_FAILURE_STOP_BUDGET_MS" 1 120000',
		);
		expect(source).toContain(
			'stop_stack_children "$RUNNER_FAILURE_STOP_BUDGET_MS"',
		);
		const cleanupStart = source.indexOf("cleanup() {");
		const cleanupEnd = source.indexOf("\n}\n", cleanupStart) + 3;
		const cleanupSource = source.slice(cleanupStart, cleanupEnd);
		expect(cleanupSource).toContain("stop_stack_children");
		expect(cleanupSource).not.toContain("RUNNER_FAILURE_STOP_BUDGET_MS");
		expect(source).toContain(
			"failure_cleanup_budget_ms=${RUNNER_FAILURE_STOP_BUDGET_MS}; intentional_stop_budget_ms=${GUARD_STOP_BUDGET_MS}",
		);
	});

	test("rejects a zero deadline instead of letting the guard clamp it to 1ms", () => {
		const result = bash(
			`GUARD_TOTAL_DEADLINE_MS=0 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(result.exitCode).toBe(64);
		expect(capturedOutput(result.stdout, "stdout")).toContain(
			"invalid GUARD_TOTAL_DEADLINE_MS=0",
		);
	});

	test("rejects an invalid retry-attempt headroom before starting children", () => {
		const result = bash(
			`GUARD_RETRY_ATTEMPT_HEADROOM_MS=0 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(result.exitCode).toBe(64);
		expect(capturedOutput(result.stdout, "stdout")).toContain(
			"invalid GUARD_RETRY_ATTEMPT_HEADROOM_MS=0",
		);
	});

	test("rejects an invalid or infeasible recovery sleep cap before starting children", () => {
		const invalid = bash(
			`GUARD_MAX_RECOVERY_SLEEP_MS=0 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(invalid.exitCode).toBe(64);
		expect(capturedOutput(invalid.stdout, "stdout")).toContain(
			"invalid GUARD_MAX_RECOVERY_SLEEP_MS=0",
		);

		const infeasible = bash(
			`GUARD_TOTAL_DEADLINE_MS=100 GUARD_RETRY_ATTEMPT_HEADROOM_MS=40 GUARD_MAX_RECOVERY_SLEEP_MS=61 GUARD_SHUTDOWN_GRACE_MS=100 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(infeasible.exitCode).toBe(64);
		expect(capturedOutput(infeasible.stdout, "stdout")).toContain(
			"GUARD_MAX_RECOVERY_SLEEP_MS=61 must fit within",
		);

		for (const value of ["120001", "180000"]) {
			const aboveHardMaximum = bash(
				`GUARD_MAX_RECOVERY_SLEEP_MS=${value} CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
			);
			expect(aboveHardMaximum.exitCode).toBe(64);
			expect(capturedOutput(aboveHardMaximum.stdout, "stdout")).toContain(
				`invalid GUARD_MAX_RECOVERY_SLEEP_MS=${value}`,
			);
		}
	});

	test("rejects shutdown grace shorter than the total request deadline", () => {
		const result = bash(
			`GUARD_TOTAL_DEADLINE_MS=900000 GUARD_SHUTDOWN_GRACE_MS=600000 CCFLARE_BIN=/bin/true GUARD_SCRIPT=/bin/true NODE_BIN=/bin/true AI_GATEWAY_TUNNEL_ENABLED=0 bash ${shellQuote(shellPath(runnerScript))}`,
		);
		expect(result.exitCode).toBe(64);
		expect(capturedOutput(result.stdout, "stdout")).toContain(
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
		expect(source).toContain(
			"GUARD_RETRY_ATTEMPT_HEADROOM_MS=${GUARD_RETRY_ATTEMPT_HEADROOM_MS:-30000}",
		);
		expect(source).toContain(
			'validate_bounded_ms GUARD_RETRY_ATTEMPT_HEADROOM_MS "$GUARD_RETRY_ATTEMPT_HEADROOM_MS" 1 2147483647',
		);
		expect(source).toContain(
			'GUARD_RETRY_ATTEMPT_HEADROOM_MS="$GUARD_RETRY_ATTEMPT_HEADROOM_MS"',
		);
		expect(source).toContain(
			"GUARD_MAX_RECOVERY_SLEEP_MS=${GUARD_MAX_RECOVERY_SLEEP_MS:-120000}",
		);
		expect(source).toContain(
			'validate_bounded_ms GUARD_MAX_RECOVERY_SLEEP_MS "$GUARD_MAX_RECOVERY_SLEEP_MS" 1 120000',
		);
		expect(source).toContain(
			'GUARD_MAX_RECOVERY_SLEEP_MS="$GUARD_MAX_RECOVERY_SLEEP_MS"',
		);
		expect(source).toContain(
			"GUARD_MAX_RECOVERY_WAITS=${GUARD_MAX_RECOVERY_WAITS:-$GUARD_EFFECTIVE_MAX_ACTIVE}",
		);
		expect(source).toContain(
			'GUARD_MAX_RECOVERY_WAITS="$GUARD_MAX_RECOVERY_WAITS"',
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
		expect(source).toContain('wait -n -p exited_pid "${child_pids[@]}"');
		expect(source).toContain(
			'stop_child "better-ccflare upstream" "$upstream_pid" 5000',
		);
		expect(source).toContain(
			'stop_child "ai-gateway ssh tunnel" "$ai_gateway_tunnel_pid" 5000',
		);
	});

	test("makes the service-mode circuit exit while explicit operator hold remains opt-in", () => {
		const source = readFileSync(runnerScript, "utf8");
		const holdStart = source.indexOf("circuit_hold_enabled() {");
		const holdEnd = source.indexOf("\n}\n", holdStart) + 3;
		const holdSource = source.slice(holdStart, holdEnd);
		expect(holdStart).toBeGreaterThanOrEqual(0);
		expect(source).toContain("RUNNER_CIRCUIT_EXIT_STATUS=75");
		expect(source).toContain(
			"auto | AUTO) printf '%s\\n' \"$RUNNER_CIRCUIT_EXIT_STATUS\"",
		);
		expect(source).toContain('return "$circuit_status"');
		expect(holdSource).toContain(
			'1 | true | TRUE | yes | YES) [[ -z "${INVOCATION_ID:-}" ]] ;;',
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
				expect(result.stdout).not.toContain("starting better-ccflare upstream");
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
		const nodeBin = Bun.which("node");
		if (!nodeBin) throw new Error("Node executable not found on PATH");
		writeFileSync(
			fixture,
			`#!${nodeBin}
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
    process.env.GUARD_RETRY_ATTEMPT_HEADROOM_MS || "",
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
					NODE_BIN: nodeBin,
					CCFLARE_UPSTREAM_PORT: String(upstreamPort),
					GUARD_PORT: String(guardPort),
					AI_GATEWAY_TUNNEL_ENABLED: "0",
					AI_GATEWAY_TUNNEL_REQUIRED: "0",
					GUARD_TOTAL_DEADLINE_MS: "240",
					GUARD_RETRY_ATTEMPT_HEADROOM_MS: "40",
					GUARD_MAX_RECOVERY_SLEEP_MS: "120",
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
			}>((resolve) => {
					runner.once("exit", (code, signal) =>
						resolve({ code, signal, at: Date.now() }),
					);
			});
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
					const [role, event, timestamp, grace, deadline, retryHeadroom] =
						line.split(":");
					return {
						role,
						event,
						timestamp: Number(timestamp),
						grace,
						deadline,
						retryHeadroom,
					};
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
			expect(guardStart?.retryHeadroom).toBe("40");
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
		expect(capturedOutput(result.stderr, "stderr")).toBe("");
		expect(capturedOutput(result.stdout, "stdout")).toContain(
			"is refs/heads/main at refs/remotes/origin/main",
		);
	});

	test("rejects a feature branch even when it points at origin/main", () => {
		const sha = "a".repeat(40);
		const result = runSourceGate("refs/heads/codex/example", sha, sha);

		expect(result.exitCode).toBe(1);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"checkout must be refs/heads/main",
		);
	});

	test("rejects detached HEAD even when it points at origin/main", () => {
		const sha = "a".repeat(40);
		const result = runSourceGate("", sha, sha);

		expect(result.exitCode).toBe(1);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
			"checkout has detached HEAD",
		);
	});

	test("rejects local main whenever it differs from fetched origin/main", () => {
		const result = runSourceGate(
			"refs/heads/main",
			"1111111111111111111111111111111111111111",
			"2222222222222222222222222222222222222222",
		);

		expect(result.exitCode).toBe(1);
		expect(capturedOutput(result.stderr, "stderr")).toContain(
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
		expect(capturedOutput(pass.stdout, "stdout")).toContain(
			"is refs/heads/main at refs/remotes/origin/main",
		);
		expect(capturedOutput(pass.stdout, "stdout")).toContain(
			"no merged v* tags to compare",
		);

		const feature = createDisposableDeployRepo();
		expectCommandOk(gitAt(feature.checkout, "switch", "-c", "feature"));
		const wrongBranch = bashAt(
			feature.checkout,
			"bash scripts/deploy-ccflare.sh --check",
		);
		expect(wrongBranch.exitCode).toBe(1);
		expect(capturedOutput(wrongBranch.stderr, "stderr")).toContain(
			"checkout must be refs/heads/main",
		);

		const staleMain = createDisposableDeployRepo();
		const oldSha = capturedOutput(
			gitAt(staleMain.checkout, "rev-parse", "HEAD").stdout,
			"stdout",
		).trim();
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
		expect(capturedOutput(behind.stderr, "stderr")).toContain(
			"does not exactly match refs/remotes/origin/main",
		);
	});

	test("verified source snapshot remains at the captured commit after the shared checkout changes", () => {
		const { checkout } = createDisposableDeployRepo();
		const snapshotParent = tempDir();
		const snapshot = join(snapshotParent, "source");
		const headSha = capturedOutput(
			gitAt(checkout, "rev-parse", "HEAD").stdout,
			"stdout",
		).trim();
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
			capturedOutput(
				gitAt(snapshot, "rev-parse", "HEAD").stdout,
				"stdout",
			).trim(),
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
		expect(
			capturedOutput(
				gitAt(checkout, "worktree", "list", "--porcelain").stdout,
				"stdout",
			),
		).not.toContain(snapshot);
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
		const lockAcquire = source.indexOf("if ! flock -n 9; then", lockOpen);
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
		const lockAcquire = source.indexOf("if ! flock -n 9; then");
		const preflight = source.indexOf(
			'validate_deploy_owned_systemd_pin "$PIN"',
			lockAcquire,
		);
		const snapshot = source.indexOf(
			'create_verified_source_snapshot "$REPO_ROOT"',
			lockAcquire,
		);
		const build = source.indexOf("bun run build", lockAcquire);
		const binaryInstall = source.indexOf(
			'cp "$BUILT_BIN" "$DEST_BIN"',
			lockAcquire,
		);
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
		expect(source).toContain(
			'BUILT_BIN="$BUILD_SOURCE_ROOT/apps/cli/dist/better-ccflare"',
		);
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

	test("uses a safe later 16 MiB/32 MiB body-policy override for health identity without pre-restart rollback", () => {
		const source = readFileSync(deployScript, "utf8");
		const effectivePolicy = source.indexOf(
			"reload_validate_or_restore_systemd_policy",
		);
		const expectedIdentity = source.indexOf(
			"EXPECTED_IDENTITY_JSON=",
			effectivePolicy,
		);
		const restart = source.indexOf(
			"sudo systemctl restart ccflare-stack.service",
			effectivePolicy,
		);
		const postReloadAssignments = source.slice(
			effectivePolicy,
			expectedIdentity,
		);

		// A later 90-operator-policy.conf can safely lower the request limit from
		// the rendered 32 MiB / 256 MiB defaults. The post-reload identity must
		// carry those effective values into health verification, rather than
		// treating the safe difference as a reason to roll back.
		expect(postReloadAssignments).toContain(
			'CONFIGURED_GUARD_MAX_REQUEST_BODY_BYTES="$(deployment_timing_value "$EFFECTIVE_DEPLOYMENT_TIMING" guard_max_request_body_bytes)"',
		);
		expect(postReloadAssignments).toContain(
			'CONFIGURED_GUARD_MAX_BUFFERED_REQUEST_BODY_BYTES="$(deployment_timing_value "$EFFECTIVE_DEPLOYMENT_TIMING" guard_max_buffered_request_body_bytes)"',
		);
		expect(restart).toBeGreaterThan(effectivePolicy);

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
			bodyAdmission: {
				budgetBytes: 268_435_456,
				queueLimit: 500,
			},
			limits: {
				totalDeadlineMs: 900_000,
				retryAttemptHeadroomMs: 45_000,
				maxRecoverySleepMs: 90_000,
				maxRecoveryWaits: 20,
				shutdownGraceMs: 900_000,
				maxAttempts: 3,
				jitterMs: 2_000,
				maxInspectionBytes: 65_536,
				maxRequestBodyBytes: 16_777_216,
				maxBufferedRequestBodyBytes: 33_554_432,
			},
		});
		const proxy = JSON.stringify({
			git_sha: "abc123",
			runtime: {
				bodyAdmission: {
					budgetBytes: 268_435_456,
					queueLimit: 500,
				},
			},
		});
		const guard = JSON.stringify({
			sourceId: "full-sha",
			policyId: "pool-exhaustion-finite-recovery-v1",
			maxRequestBodyBytes: 16_777_216,
			maxBufferedRequestBodyBytes: 33_554_432,
			runtime: {
				process: { runnerPid: 42 },
				artifacts: {
					binary: { path: "/artifacts/bin", sha256: "bin-digest" },
					runner: { path: "/artifacts/runner", sha256: "runner-digest" },
					guard: { path: "/artifacts/guard", sha256: "guard-digest" },
					policy: { path: "/artifacts/policy", sha256: "policy-digest" },
				},
				bodyAdmission: {
					budgetBytes: 268_435_456,
					queueLimit: 500,
				},
				limits: {
					totalDeadlineMs: 900_000,
					retryAttemptHeadroomMs: 45_000,
					maxRecoverySleepMs: 90_000,
					maxRecoveryWaits: 20,
					shutdownGraceMs: 900_000,
					maxAttempts: 3,
					jitterMs: 2_000,
					maxInspectionBytes: 65_536,
					maxRequestBodyBytes: 16_777_216,
					maxBufferedRequestBodyBytes: 33_554_432,
				},
			},
		});
		const health = bash(
			[
				`source ${shellQuote(helperScriptForShell)}`,
				`validate_deploy_health ${shellQuote(proxy)} ${shellQuote(guard)} ${shellQuote(expected)}`,
			].join("\n"),
		);
		expect(health.exitCode).toBe(0);
	});

	test("full deployment has rollback and exact dual-health verification", () => {
		const source = readFileSync(deployScript, "utf8");
		const helperSource = readFileSync(
			join(repoRoot, helperScriptForShell),
			"utf8",
		);
		expect(source).toContain('validate_deployment_timing "$PIN_RENDERED"');
		expect(source).toContain("totalDeadlineMs: Number(guardTotalDeadlineMs)");
		expect(source).toContain(
			"retryAttemptHeadroomMs: Number(guardRetryAttemptHeadroomMs)",
		);
		expect(source).toContain("shutdownGraceMs: Number(guardShutdownGraceMs)");
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
		expect(source).toContain('if [[ "$SERVICE_RESTART_ATTEMPTED" == "0" ]]');

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
