import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	COMMAND_NAMES,
	PRODUCT_NAME,
} from "../../../packages/core/src/product-identity";
import { smokeExecutable } from "../router-artifacts";

const root = resolve(import.meta.dir, "../../..");
const entrypoint = join(root, "apps/cli/prepare-router-artifacts.ts");
const fixtures: string[] = [];
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "router-prepare-test-"));
	fixtures.push(dir);
	return dir;
}
function copyProductIdentity(repo: string) {
	const core = join(repo, "packages/core/src");
	mkdirSync(core, { recursive: true });
	copyFileSync(
		join(root, "packages/core/src/product-identity.ts"),
		join(core, "product-identity.ts"),
	);
}
afterEach(() => {
	for (const dir of fixtures.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function prepare(
	args: string[],
	home: string,
	extraEnv: Record<string, string> = {},
) {
	return spawnSync(
		process.execPath,
		["--no-env-file", "run", entrypoint, ...args],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: home,
				TMPDIR: home,
				...extraEnv,
			},
			encoding: "utf8",
			timeout: 600_000,
		},
	);
}

describe("current executable smoke fixtures (not native build proof)", () => {
	function executable(body: string) {
		const dir = fixture();
		const binary = join(dir, "binary");
		writeFileSync(binary, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		return { dir, binary };
	}
	const sha = "a".repeat(40);
	const body = `case "$1" in
--help) printf 'HoV Router\\n';;
--version) printf 'HoV Router v1.2.3\\n';;
--git-sha) printf '${sha}\\n';;
esac`;
	it("checks exact current output and SHA for all three command aliases", () => {
		const { dir, binary } = executable(body);
		const calls = join(dir, "calls");
		writeFileSync(
			binary,
			`#!/bin/sh\nprintf '%s %s\\n' "\${0##*/}" "$1" >> '${calls}'\n${body}\n`,
		);
		expect(() =>
			smokeExecutable(binary, { version: "1.2.3", sha }),
		).not.toThrow();
		expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(
			COMMAND_NAMES.flatMap((alias) =>
				["--help", "--version", "--git-sha"].map((flag) => `${alias} ${flag}`),
			),
		);
	});
	it("requires current output for a new build even with the historical version and SHA", () => {
		const identity = {
			version: "3.6.2",
			sha: "5d7b2a888a9b61d87916332b414e46606498d896",
		};
		const current = body.replace("v1.2.3", "v3.6.2").replace(sha, identity.sha);
		expect(() =>
			smokeExecutable(executable(current).binary, identity),
		).not.toThrow();
		expect(() =>
			smokeExecutable(
				executable(current.replaceAll("HoV Router", "wstack Router")).binary,
				identity,
			),
		).toThrow(/Unexpected/);
	});
	for (const [label, source] of [
		["old branding", body.replaceAll("HoV Router", "wstack Router")],
		["wrong version", body.replace("v1.2.3", "v9.9.9")],
		["extra version output", body.replace("v1.2.3", "v1.2.3 extra")],
		["wrong SHA", body.replace(sha, "b".repeat(40))],
		["configuration creation", `mkdir "$HOME/.config"\n${body}`],
		["working directory writes", `touch initialized\n${body}`],
		[
			"broken hov-router alias",
			`test "\${0##*/}" != hov-router || exit 93\n${body}`,
		],
	] as const) {
		it(`rejects ${label}`, () => {
			const { binary } = executable(source);
			expect(() =>
				smokeExecutable(binary, { version: "1.2.3", sha }),
			).toThrow();
		});
	}
});

describe("local Linux artifact preparation", () => {
	it.skipIf(
		process.platform !== "linux" ||
			process.arch !== "x64" ||
			!existsSync("/dev/shm") ||
			statSync("/dev/shm").dev === statSync(tmpdir()).dev,
	)(
		"restores the previous executable when TMPDIR is on a different device",
		() => {
			const home = fixture();
			const temporary = mkdtempSync("/dev/shm/router-prepare-test-");
			fixtures.push(temporary);
			expect(statSync(home).dev).not.toBe(statSync(temporary).dev);
			const cli = join(home, "apps/cli");
			const dashboard = join(home, "packages/dashboard-web");
			mkdirSync(join(cli, "dist"), { recursive: true });
			mkdirSync(dashboard, { recursive: true });
			copyFileSync(entrypoint, join(cli, "prepare-router-artifacts.ts"));
			copyProductIdentity(home);
			copyFileSync(
				join(root, "apps/cli/router-artifacts.ts"),
				join(cli, "router-artifacts.ts"),
			);
			writeFileSync(
				join(dashboard, "build.ts"),
				'throw new Error("cross-device build reached");',
			);
			const stale = join(cli, "dist/better-ccflare-linux-amd64");
			writeFileSync(stale, "preserved previous executable");
			const destination = join(home, "output");
			const result = spawnSync(
				process.execPath,
				[
					"--no-env-file",
					"run",
					join(cli, "prepare-router-artifacts.ts"),
					destination,
				],
				{
					cwd: home,
					env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: temporary },
					encoding: "utf8",
					timeout: 30000,
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("cross-device build reached");
			expect(result.stderr).not.toContain("EXDEV");
			expect(existsSync(destination)).toBe(false);
			expect(readFileSync(stale, "utf8")).toBe("preserved previous executable");
			expect(readdirSync(join(cli, "dist"))).toEqual([
				"better-ccflare-linux-amd64",
			]);
			expect(readdirSync(temporary)).toEqual([]);
		},
	);
	for (const hasPrevious of [true, false]) {
		it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
			`rolls back a replacement after smoke validation fails ${hasPrevious ? "with" : "without"} a previous executable`,
			() => {
				const home = fixture();
				const cli = join(home, "apps/cli");
				const dashboard = join(home, "packages/dashboard-web");
				mkdirSync(join(cli, "dist"), { recursive: true });
				mkdirSync(dashboard, { recursive: true });
				copyFileSync(entrypoint, join(cli, "prepare-router-artifacts.ts"));
				copyProductIdentity(home);
				copyFileSync(
					join(root, "apps/cli/router-artifacts.ts"),
					join(cli, "router-artifacts.ts"),
				);
				writeFileSync(
					join(dashboard, "build.ts"),
					"// Synthetic successful build\n",
				);
				writeFileSync(join(cli, "package.json"), '{"version":"1.2.3"}');
				writeFileSync(
					join(cli, "build-multi-arch.ts"),
					`import { writeFileSync } from "node:fs";
writeFileSync("dist/better-ccflare-linux-amd64", "#!/bin/sh\\nprintf 'invalid smoke output\\\\n'\\n", { mode: 0o755 });`,
				);
				const built = join(cli, "dist/better-ccflare-linux-amd64");
				const original = Buffer.from([0, 255, 1, 128, 10, 42]);
				if (hasPrevious) writeFileSync(built, original);
				const destination = join(home, "output");
				const result = spawnSync(
					process.execPath,
					[
						"--no-env-file",
						"run",
						join(cli, "prepare-router-artifacts.ts"),
						destination,
					],
					{
						cwd: home,
						env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home },
						encoding: "utf8",
						timeout: 30000,
					},
				);
				expect(result.status).not.toBe(0);
				expect(result.stdout).toContain("better-ccflare-linux-amd64: OK");
				expect(result.stderr).toContain("Unexpected hov-router --help output");
				expect(existsSync(destination)).toBe(false);
				if (hasPrevious) expect(readFileSync(built)).toEqual(original);
				else expect(existsSync(built)).toBe(false);
				expect(readdirSync(join(cli, "dist"))).toEqual(
					hasPrevious ? ["better-ccflare-linux-amd64"] : [],
				);
				expect(
					readdirSync(home)
						.filter((name) => name !== ".bun")
						.sort(),
				).toEqual(["apps", "packages"]);
			},
		);
	}
	it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
		"builds fresh Linux assets, verifies checksums and runs all three aliases without configuration",
		() => {
			const home = fixture();
			const destination = join(home, "output");
			const sentinel = join(home, "must-not-initialize.json");
			const result = prepare([destination], home, {
				CCFLARE_ONLY_PLATFORMS: "bun-windows-x64",
				CCFLARE_SKIP_PLATFORMS: "bun-linux-amd64",
				CCFLARE_BUILD_SUFFIX: "must-not-appear",
				CCFLARE_BUILD_PRODUCER: "github-release-binary",
				CCFLARE_VERSION: "0.0.0-must-not-appear",
				BETTER_CCFLARE_CONFIG_PATH: sentinel,
				DATABASE_URL: "postgresql://synthetic.invalid/never-connect",
				ANTHROPIC_API_KEY: "synthetic-never-forward",
			});
			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(destination)).toBe(true);
			expect(result.stdout).toContain("Prepared local-only artifacts");
			expect(result.stdout).toContain("better-ccflare-linux-amd64: OK");
			expect(readdirSync(destination).sort()).toEqual([
				"SHA256SUMS",
				"better-ccflare-linux-amd64",
			]);
			const checksum = spawnSync("sha256sum", ["-c", "SHA256SUMS"], {
				cwd: destination,
				encoding: "utf8",
			});
			expect(checksum.status, checksum.stderr).toBe(0);
			const cwd = join(home, "smoke", "cwd", "leaf");
			const emptyHome = join(home, "smoke", "home");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(emptyHome);
			const version = JSON.parse(
				readFileSync(join(root, "apps/cli/package.json"), "utf8"),
			).version;
			for (const alias of COMMAND_NAMES) {
				const executable = join(home, "smoke", alias);
				copyFileSync(
					join(destination, "better-ccflare-linux-amd64"),
					executable,
				);
				for (const flag of ["--help", "--version"]) {
					const smoke = spawnSync(executable, [flag], {
						cwd,
						env: { HOME: emptyHome, PATH: "/usr/bin:/bin", NO_COLOR: "1" },
						encoding: "utf8",
						timeout: 10000,
					});
					expect(smoke.status, smoke.stderr).toBe(0);
					expect(smoke.stdout).toContain(PRODUCT_NAME);
					if (flag === "--version")
						expect(smoke.stdout.trim()).toBe(`${PRODUCT_NAME} v${version}`);
				}
			}
			expect(readdirSync(emptyHome).filter((name) => name !== ".bun")).toEqual(
				[],
			);
			expect(readdirSync(cwd)).toEqual([]);
			expect(existsSync(sentinel)).toBe(false);
			expect(existsSync(join(home, ".config"))).toBe(false);
			writeFileSync(
				join(destination, "better-ccflare-linux-amd64"),
				"tampered fixture",
			);
			const tampered = spawnSync("sha256sum", ["-c", "SHA256SUMS"], {
				cwd: destination,
				encoding: "utf8",
			});
			expect(tampered.status).not.toBe(0);
			expect(tampered.stdout).toContain("FAILED");
		},
		660_000,
	);
	it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
		"keeps stderr from successful subprocesses visible",
		() => {
			const home = fixture();
			const cli = join(home, "apps/cli");
			const dashboard = join(home, "packages/dashboard-web");
			mkdirSync(join(cli, "dist"), { recursive: true });
			mkdirSync(dashboard, { recursive: true });
			copyFileSync(entrypoint, join(cli, "prepare-router-artifacts.ts"));
			copyProductIdentity(home);
			copyFileSync(
				join(root, "apps/cli/router-artifacts.ts"),
				join(cli, "router-artifacts.ts"),
			);
			writeFileSync(
				join(dashboard, "build.ts"),
				'console.error("dashboard-warning-visible");',
			);
			writeFileSync(
				join(cli, "build-multi-arch.ts"),
				'throw new Error("stop after dashboard");',
			);
			const result = spawnSync(
				process.execPath,
				[
					"--no-env-file",
					"run",
					join(cli, "prepare-router-artifacts.ts"),
					join(home, "output"),
				],
				{
					cwd: home,
					env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home },
					encoding: "utf8",
					timeout: 30000,
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("dashboard-warning-visible");
		},
	);
	it("rejects missing arguments and existing destinations without clobbering", () => {
		const home = fixture();
		const missing = prepare([], home);
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain("Usage:");
		const destination = join(home, "existing");
		mkdirSync(destination);
		writeFileSync(join(destination, "keep"), "unchanged");
		const existing = prepare([destination], home);
		expect(existing.status).not.toBe(0);
		expect(existing.stderr).toContain("already exists");
		expect(readdirSync(destination)).toEqual(["keep"]);
		const extra = prepare([join(home, "new"), "unexpected"], home);
		expect(extra.status).not.toBe(0);
		expect(extra.stderr).toContain("Usage:");
		expect(existsSync(join(home, "new"))).toBe(false);
		for (const target of [destination, join(home, "missing-target")]) {
			const link = join(
				home,
				target === destination ? "existing-link" : "dangling-link",
			);
			symlinkSync(target, link);
			const linked = prepare([link], home);
			expect(linked.status).not.toBe(0);
			expect(linked.stderr).toContain("already exists");
		}
		const file = join(home, "file");
		writeFileSync(file, "keep");
		expect(prepare([file], home).status).not.toBe(0);
		expect(readFileSync(file, "utf8")).toBe("keep");
	});
	it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
		"does not package a stale executable after a build failure",
		() => {
			// Synthetic failing source tree tests the failure contract, not build acceptance.
			const home = fixture();
			const cli = join(home, "apps/cli");
			const dashboard = join(home, "packages/dashboard-web");
			mkdirSync(join(cli, "dist"), { recursive: true });
			mkdirSync(dashboard, { recursive: true });
			copyFileSync(entrypoint, join(cli, "prepare-router-artifacts.ts"));
			copyProductIdentity(home);
			copyFileSync(
				join(root, "apps/cli/router-artifacts.ts"),
				join(cli, "router-artifacts.ts"),
			);
			writeFileSync(
				join(dashboard, "build.ts"),
				'throw new Error("deliberate dashboard build failure");',
			);
			const stale = join(cli, "dist/better-ccflare-linux-amd64");
			writeFileSync(stale, "old executable must not be packaged");
			const destination = join(home, "output");
			const result = spawnSync(
				process.execPath,
				[
					"--no-env-file",
					"run",
					join(cli, "prepare-router-artifacts.ts"),
					destination,
				],
				{
					cwd: home,
					env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home },
					encoding: "utf8",
					timeout: 30000,
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("deliberate dashboard build failure");
			expect(existsSync(destination)).toBe(false);
			expect(readFileSync(stale, "utf8")).toBe(
				"old executable must not be packaged",
			);
		},
	);
});
