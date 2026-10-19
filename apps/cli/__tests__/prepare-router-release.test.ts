import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	expectedManifest,
	validateReleaseSource,
	verifyReleaseDirectory,
} from "../prepare-router-release";

const expected = {
	repository: "StartupBros/wstack-router",
	version: "1.2.3",
	ref: "refs/tags/v1.2.3",
	sha: "a".repeat(40),
};
const filename = "better-ccflare-linux-amd64";
const bunPin = readFileSync(
	resolve(import.meta.dir, "../../../.bun-version"),
	"utf8",
).trim();
// Independent schema example: never construct verifier input with the producer.
function schemaExample(sha: string, size: number, sha256: string) {
	return {
		schema: 1,
		repository: "StartupBros/wstack-router",
		version: "1.2.3",
		ref: "refs/tags/v1.2.3",
		sha,
		bun: bunPin,
		target: "bun-linux-amd64",
		executable: { filename: "better-ccflare-linux-amd64", size, sha256 },
		provenance: {
			raw: "v1:startupbros-wstack-router-binary",
			schemaVersion: "v1",
			identity: "v1:startupbros-wstack-router-binary",
			producer: "startupbros",
			artifactMode: "binary",
			updateChannel: null,
			source_sha: sha,
			source_ref: "refs/tags/v1.2.3",
			proven: true,
			actionable: false,
			reason: "proven_non_actionable",
		},
	};
}
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture(body?: string) {
	const dir = mkdtempSync(join(tmpdir(), "release-verify-test-"));
	dirs.push(dir);
	const binary = Buffer.from(
		body ??
			`#!/bin/sh\ncase "$1" in\n--help) printf 'wstack Router\\n';;\n--version) printf 'wstack Router v1.2.3\\n';;\n--git-sha) printf '${expected.sha}\\n';;\nesac\n`,
	);
	const digest = createHash("sha256").update(binary).digest("hex");
	const manifest = schemaExample(expected.sha, binary.length, digest);
	writeFileSync(join(dir, filename), binary, { mode: 0o755 });
	writeFileSync(join(dir, "SHA256SUMS"), `${digest}  ${filename}\n`);
	writeFileSync(join(dir, "release-manifest.json"), JSON.stringify(manifest));
	return { dir, manifest };
}
function probe(args: string[]) {
	if (args[0] === "config")
		return "https://github.com/StartupBros/wstack-router.git";
	if (args[0] === "status") return "";
	return expected.sha;
}
// Synthetic build orchestration, not native binary proof. The CLI, shared
// preparation and Git evidence are real; only the two build scripts are fixtures.
function syntheticRelease(mode = "clean", hasPrevious = false) {
	const base = mkdtempSync(join(tmpdir(), "release-synthetic-"));
	dirs.push(base);
	const repo = join(base, "source");
	const cli = join(repo, "apps/cli");
	const dashboard = join(repo, "packages/dashboard-web");
	const home = join(base, "home");
	mkdirSync(join(cli, "dist"), { recursive: true });
	mkdirSync(dashboard, { recursive: true });
	mkdirSync(home);
	const env = {
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: home,
		TMPDIR: base,
	};
	const git = (args: string[]) =>
		execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
	for (const name of [
		"prepare-router-release.ts",
		"router-artifacts.ts",
		"build-provenance.ts",
	])
		copyFileSync(join(import.meta.dir, "..", name), join(cli, name));
	writeFileSync(join(repo, ".bun-version"), "1.4.2\n");
	writeFileSync(join(repo, ".gitignore"), "apps/cli/dist/\n");
	for (const dir of [repo, cli])
		writeFileSync(join(dir, "package.json"), '{"version":"1.2.3"}');
	const hostile = {
		GITHUB_TOKEN: "synthetic-token",
		ANTHROPIC_API_KEY: "synthetic-provider",
		DATABASE_URL: "synthetic-db",
		BETTER_CCFLARE_DB_PATH: "synthetic-db-path",
		BETTER_CCFLARE_CONFIG_PATH: "synthetic-config",
		CCFLARE_VERSION: "9.9.9",
		CCFLARE_BUILD_SUFFIX: "hostile",
		CCFLARE_SKIP_PLATFORMS: "bun-linux-amd64",
		CCFLARE_BUILD_PRODUCER: "github-release-binary",
		CCFLARE_ONLY_PLATFORMS: "bun-windows-x64",
		GIT_DIR: "/nonexistent-synthetic-git",
		GIT_WORK_TREE: "/nonexistent-synthetic-tree",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "remote.origin.url",
		GIT_CONFIG_VALUE_0: "https://invalid.example/hostile",
		GIT_CONFIG_GLOBAL: "/nonexistent-synthetic-config",
		NODE_OPTIONS: "--trace-warnings",
		BUN_OPTIONS: "--no-env-file",
	};
	const dotenv =
		"DOTENV_SENTINEL=must-not-reach-build\nCCFLARE_VERSION=8.8.8\n";
	for (const dir of [base, repo, cli, dashboard])
		writeFileSync(join(dir, ".env"), dotenv);
	const forbidden = [
		...Object.keys(hostile).filter(
			(key) =>
				!["CCFLARE_BUILD_PRODUCER", "CCFLARE_ONLY_PLATFORMS"].includes(key),
		),
		"DOTENV_SENTINEL",
	];
	const guard = `for (const key of ${JSON.stringify(forbidden)}) if (process.env[key] !== undefined) throw new Error("inherited " + key);\n`;
	const calls = join(base, "calls");
	writeFileSync(
		join(dashboard, "build.ts"),
		`${guard}
import { appendFileSync, mkdirSync } from "node:fs";
if (process.env.CCFLARE_BUILD_PRODUCER || process.env.CCFLARE_ONLY_PLATFORMS) throw new Error("dashboard producer/platform leak");
appendFileSync(${JSON.stringify(calls)}, "dashboard\\n");
${mode === "config" ? 'mkdirSync(process.env.HOME + "/.config");' : ""}
`,
	);
	const shellGuard = [
		...forbidden,
		"CCFLARE_BUILD_PRODUCER",
		"CCFLARE_ONLY_PLATFORMS",
	]
		.map((key) => `$${key}`)
		.join("");
	writeFileSync(
		join(cli, "build-multi-arch.ts"),
		`${guard}
import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (process.env.CCFLARE_BUILD_PRODUCER !== "wstack-router-binary" || process.env.CCFLARE_ONLY_PLATFORMS !== "bun-linux-amd64") throw new Error("wrong explicit release producer/platform");
appendFileSync(${JSON.stringify(calls)}, "cli\\n");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const body = '#!/bin/sh\\ntest -z "${shellGuard}" || exit 94\\nprintf "%s %s\\\\n" "' + '$' + '{0##*/}" "$1" >> ${calls}\\ncase "$1" in\\n--help) printf "wstack Router\\\\n";;\\n--version) printf "wstack Router v1.2.3\\\\n";;\\n--git-sha) printf "' + ${mode === "smoke" ? '"wrong-sha"' : "sha"} + '\\\\n";;\\nesac\\n';
writeFileSync("dist/${filename}", body, { mode: 0o755 });
${mode === "dirty" ? 'appendFileSync("package.json", "\\n");' : ""}
`,
	);
	git(["init", "-b", "fixture"]);
	git(["config", "user.name", "Synthetic Release Fixture"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	git([
		"remote",
		"add",
		"origin",
		"https://github.com/StartupBros/wstack-router.git",
	]);
	git(["add", "--all"]);
	git(["commit", "-m", "chore: synthetic release fixture"]);
	const sha = git(["rev-parse", "HEAD"]);
	git(["tag", "v1.2.3"]);
	const built = join(cli, "dist", filename);
	const original = Buffer.from([0, 255, 17, 128]);
	if (hasPrevious) writeFileSync(built, original);
	if (mode === "early")
		writeFileSync(join(repo, "dirty-source"), "dirty before build");
	const output = join(base, "output");
	const result = spawnSync(
		process.execPath,
		[
			"--no-env-file",
			"run",
			join(cli, "prepare-router-release.ts"),
			"prepare",
			output,
			expected.repository,
			"1.2.3",
			"refs/tags/v1.2.3",
			sha,
		],
		{
			cwd: repo,
			env: { ...env, ...hostile },
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	return { result, output, built, original, cli, base, calls, sha };
}

describe("synthetic release preparation", () => {
	it("prepares an independent literal manifest with isolated build/smoke environments despite hostile env and dotenv", () => {
		const f = syntheticRelease();
		expect(f.result.status, f.result.stderr).toBe(0);
		const bytes = readFileSync(join(f.output, filename));
		const literal = schemaExample(
			f.sha,
			bytes.length,
			createHash("sha256").update(bytes).digest("hex"),
		);
		expect(
			JSON.parse(readFileSync(join(f.output, "release-manifest.json"), "utf8")),
		).toEqual(literal);
		expect(readdirSync(f.output).sort()).toEqual([
			"SHA256SUMS",
			filename,
			"release-manifest.json",
		]);
		expect(readFileSync(f.calls, "utf8").trim().split("\n")).toEqual([
			"dashboard",
			"cli",
			"wstack-router --help",
			"wstack-router --version",
			"wstack-router --git-sha",
			"better-ccflare --help",
			"better-ccflare --version",
			"better-ccflare --git-sha",
		]);
		expect(
			verifyReleaseDirectory(f.output, { ...expected, sha: f.sha }),
		).toEqual(literal);
	});
	for (const mode of ["early", "dirty", "smoke"]) {
		for (const hasPrevious of [true, false]) {
			it(`rolls back release ${mode} failure ${hasPrevious ? "with" : "without"} prior binary`, () => {
				const f = syntheticRelease(mode, hasPrevious);
				expect(f.result.status, f.result.stderr).not.toBe(0);
				expect(f.result.stderr).toContain(
					mode === "smoke"
						? "Unexpected wstack-router --git-sha output"
						: "Release requires clean exact HEAD/tag/source evidence",
				);
				expect(existsSync(f.output)).toBe(false);
				if (hasPrevious) expect(readFileSync(f.built)).toEqual(f.original);
				else expect(existsSync(f.built)).toBe(false);
				expect(readdirSync(join(f.cli, "dist"))).toEqual(
					hasPrevious ? [filename] : [],
				);
				expect(
					readdirSync(f.base).filter((name) => name.startsWith("router-")),
				).toEqual([]);
				if (mode === "early") expect(existsSync(f.calls)).toBe(false);
				else
					expect(readFileSync(f.calls, "utf8")).toStartWith("dashboard\ncli\n");
				if (mode === "dirty")
					expect(readFileSync(f.calls, "utf8")).toBe("dashboard\ncli\n");
			});
		}
	}
	for (const hasPrevious of [true, false]) {
		it(`rejects build HOME configuration and rolls back ${hasPrevious ? "with" : "without"} previous binary`, () => {
			const f = syntheticRelease("config", hasPrevious);
			expect(f.result.status, f.result.stderr).not.toBe(0);
			expect(f.result.stderr).toContain(
				"Build unexpectedly initialized configuration",
			);
			expect(existsSync(f.output)).toBe(false);
			if (hasPrevious) expect(readFileSync(f.built)).toEqual(f.original);
			else expect(existsSync(f.built)).toBe(false);
		});
	}
});

describe("native tagged release rehearsal", () => {
	it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
		"builds in an independent repository and verifies the exact native inventory",
		() => {
			const base = mkdtempSync(join(tmpdir(), "release-native-"));
			dirs.push(base);
			const root = resolve(import.meta.dir, "../../..");
			const repo = join(base, "source");
			const home = join(base, "home");
			mkdirSync(repo);
			mkdirSync(home);
			const env = {
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				HOME: home,
				TMPDIR: base,
				NO_COLOR: "1",
			};
			const run = (command: string, args: string[], cwd = repo) => {
				const result = spawnSync(command, args, {
					cwd,
					env,
					encoding: "utf8",
					timeout: 600_000,
					maxBuffer: 32 * 1024 * 1024,
				});
				if (command === process.execPath) process.stdout.write(result.stdout);
				process.stderr.write(result.stderr);
				if (result.error) throw result.error;
				if (result.status !== 0)
					throw new Error(
						`${command} exited ${result.status}: ${result.stderr}`,
					);
				return result.stdout;
			};
			const excluded = new Set([
				"packages/database/src/inline-vacuum-worker.ts",
				"packages/database/src/inline-integrity-check-worker.ts",
				"packages/database/src/inline-incremental-vacuum-worker.ts",
				"packages/proxy/src/inline-worker.ts",
			]);
			const files = run("git", ["ls-files", "-z"], root)
				.split("\0")
				.filter(
					(path) =>
						path &&
						!excluded.has(path) &&
						!path.includes(".env") &&
						!path.endsWith(".md") &&
						!path.includes("__tests__") &&
						!path.endsWith(".test.ts") &&
						(path.startsWith("apps/cli/") ||
							path.startsWith("apps/server/") ||
							path === "apps/lander/package.json" ||
							path.startsWith("packages/") ||
							[
								"package.json",
								"bun.lock",
								"tsconfig.json",
								".gitignore",
								".bun-version",
							].includes(path)),
				);
			files.push(
				"scripts/ccflare-managed-timing.mjs",
				"apps/cli/router-artifacts.ts",
				"apps/cli/prepare-router-release.ts",
			);
			for (const path of new Set(files)) {
				const destination = join(repo, path);
				mkdirSync(dirname(destination), { recursive: true });
				copyFileSync(join(root, path), destination);
			}
			run(process.execPath, ["--no-env-file", "install", "--frozen-lockfile"]);
			run("git", ["init", "-b", "fixture"]);
			run("git", ["config", "user.name", "Release Fixture"]);
			run("git", ["config", "user.email", "fixture@example.invalid"]);
			run("git", [
				"remote",
				"add",
				"origin",
				"https://github.com/StartupBros/wstack-router.git",
			]);
			run("git", ["add", "--all"]);
			run("git", ["commit", "-m", "chore: independent native release fixture"]);
			const sha = run("git", ["rev-parse", "HEAD"]).trim();
			const version = JSON.parse(
				readFileSync(join(repo, "package.json"), "utf8"),
			).version;
			run("git", ["tag", `v${version}`]);
			const output = join(base, "artifacts");
			const identity = {
				repository: expected.repository,
				version,
				ref: `refs/tags/v${version}`,
				sha,
			};
			const args = [output, identity.repository, version, identity.ref, sha];
			const entrypoint = join(repo, "apps/cli/prepare-router-release.ts");
			const prepared = run(process.execPath, [
				"--no-env-file",
				"run",
				entrypoint,
				"prepare",
				...args,
			]);
			expect(prepared).toContain("Prepared release artifacts");
			expect(readdirSync(output).sort()).toEqual([
				"SHA256SUMS",
				filename,
				"release-manifest.json",
			]);
			expect(verifyReleaseDirectory(output, identity).sha).toBe(sha);
			expect(run("git", ["status", "--porcelain"])).toBe("");
			// Rejection must not overwrite an existing destination, even with valid source evidence.
			const before = readFileSync(
				join(output, "release-manifest.json"),
				"utf8",
			);
			expect(() =>
				run(process.execPath, [
					"--no-env-file",
					"run",
					entrypoint,
					"prepare",
					...args,
				]),
			).toThrow();
			expect(readFileSync(join(output, "release-manifest.json"), "utf8")).toBe(
				before,
			);
			writeFileSync(
				join(repo, "package.json"),
				`${readFileSync(join(repo, "package.json"), "utf8")}\n`,
			);
			expect(() =>
				run(process.execPath, [
					"--no-env-file",
					"run",
					entrypoint,
					"prepare",
					join(base, "dirty-output"),
					...args.slice(1),
				]),
			).toThrow(/Release requires clean exact HEAD\/tag\/source evidence/);
		},
		660_000,
	);
});

describe("release source evidence", () => {
	it("uses the checkout Bun pin and the literal manifest schema", () => {
		expect(expectedManifest(expected, 123, "d".repeat(64))).toEqual(
			schemaExample(expected.sha, 123, "d".repeat(64)),
		);
	});
	it("refuses missing evidence and a tag pointing away from HEAD", () => {
		expect(() =>
			validateReleaseSource(
				expected,
				"1.2.3",
				bunPin,
				"linux",
				"x64",
				() => null,
			),
		).toThrow();
		expect(() =>
			validateReleaseSource(
				expected,
				"1.2.3",
				bunPin,
				"linux",
				"x64",
				(args) =>
					args[1]?.startsWith("refs/tags/") ? "b".repeat(40) : probe(args),
			),
		).toThrow(/clean exact HEAD/);
	});
	it("accepts only explicit native pinned identity with clean exact origin/tag/HEAD evidence", () => {
		expect(() =>
			validateReleaseSource(expected, "1.2.3", bunPin, "linux", "x64", probe),
		).not.toThrow();
		for (const change of [
			{ repository: "tombii/better-ccflare" },
			{ version: "1.2.3-rc.1" },
			{ ref: "refs/heads/main" },
			{ sha: "abc" },
			{ sha: "b".repeat(40) },
		])
			expect(() =>
				validateReleaseSource(
					{ ...expected, ...change },
					"1.2.3",
					bunPin,
					"linux",
					"x64",
					probe,
				),
			).toThrow();
		for (const field of ["config", "status", "rev-parse"])
			expect(() =>
				validateReleaseSource(
					expected,
					"1.2.3",
					bunPin,
					"linux",
					"x64",
					(args) => (args[0] === field ? "invalid" : probe(args)),
				),
			).toThrow();
		for (const [version, bun, platform, arch] of [
			["1.2.4", bunPin, "linux", "x64"],
			["1.2.3", "1.3.0", "linux", "x64"],
			["1.2.3", bunPin, "darwin", "x64"],
			["1.2.3", bunPin, "linux", "arm64"],
		] as const)
			expect(() =>
				validateReleaseSource(expected, version, bun, platform, arch, probe),
			).toThrow();
	});
});
describe("downloaded release verification (not publisher authentication)", () => {
	it("validates the fixed inventory and smokes both aliases under an isolated environment", () => {
		const { dir } = fixture();
		expect(verifyReleaseDirectory(dir, expected).version).toBe(
			expected.version,
		);
	});
	it("runs all three exits for both aliases without inherited secrets or ancestor dotenv", () => {
		const home = mkdtempSync(join(tmpdir(), "release-hostile-"));
		dirs.push(home);
		const marker = join(home, "calls");
		writeFileSync(
			join(home, ".env"),
			"CCFLARE_VERSION=9.9.9\nANTHROPIC_API_KEY=dotenv-secret\n",
		);
		const source = readFileSync(join(fixture().dir, filename), "utf8");
		const { dir } = fixture(
			source.replace(
				"case",
				`test -z "$ANTHROPIC_API_KEY$CCFLARE_VERSION$CCFLARE_BUILD_PRODUCER$DATABASE_URL$GITHUB_TOKEN$BUN_OPTIONS" || exit 94\nprintf '%s %s\\n' "\${0##*/}" "$1" >> '${marker}'\ncase`,
			),
		);
		const result = spawnSync(
			process.execPath,
			[
				"--no-env-file",
				"run",
				join(import.meta.dir, "../prepare-router-release.ts"),
				"verify",
				dir,
				expected.repository,
				expected.version,
				expected.ref,
				expected.sha,
			],
			{
				cwd: home,
				env: {
					PATH: "/usr/bin:/bin",
					HOME: home,
					TMPDIR: home,
					ANTHROPIC_API_KEY: "synthetic",
					GITHUB_TOKEN: "synthetic",
					DATABASE_URL: "synthetic",
					CCFLARE_VERSION: "9.9.9",
					CCFLARE_BUILD_PRODUCER: "github-release-binary",
				},
				encoding: "utf8",
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([
			"wstack-router --help",
			"wstack-router --version",
			"wstack-router --git-sha",
			"better-ccflare --help",
			"better-ccflare --version",
			"better-ccflare --git-sha",
		]);
	});
	for (const name of [filename, "SHA256SUMS", "release-manifest.json"]) {
		it(`rejects missing and symlinked ${name} before execution`, () => {
			const { dir } = fixture("#!/bin/sh\nexit 93\n");
			rmSync(join(dir, name));
			expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/inventory/);
			symlinkSync("/does-not-exist", join(dir, name));
			expect(() => verifyReleaseDirectory(dir, expected)).toThrow(
				/regular file/,
			);
		});
	}
	it("rejects symlinked input directory and non-regular assets", () => {
		const { dir } = fixture("#!/bin/sh\nexit 93\n");
		const link = `${dir}-link`;
		dirs.push(link);
		symlinkSync(dir, link);
		expect(() => verifyReleaseDirectory(link, expected)).toThrow(/inventory/);
		rmSync(join(dir, filename));
		mkdirSync(join(dir, filename));
		expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/regular file/);
	});
	it("rejects altered provenance and traversal checksums before execution", () => {
		const { dir, manifest } = fixture("#!/bin/sh\nexit 93\n");
		writeFileSync(
			join(dir, "release-manifest.json"),
			JSON.stringify({
				...manifest,
				provenance: { ...manifest.provenance, actionable: true },
			}),
		);
		expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/manifest/);
		writeFileSync(join(dir, "release-manifest.json"), JSON.stringify(manifest));
		writeFileSync(
			join(dir, "SHA256SUMS"),
			`${manifest.executable.sha256}  ../${filename}\n`,
		);
		expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/checksums/);
	});
	it("rejects extra files and directories", () => {
		const { dir } = fixture();
		mkdirSync(join(dir, "extra"));
		expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/inventory/);
	});
	for (const change of [
		{ repository: "other/repo" },
		{ version: "2.0.0" },
		{ sha: "b".repeat(40) },
		{ ref: "refs/heads/main" },
		{ target: "bun-windows-x64" },
		{ bun: "1.0.0" },
		{ schema: 2 },
	]) {
		it(`rejects manifest identity ${JSON.stringify(change)}`, () => {
			const { dir, manifest } = fixture("#!/bin/sh\nexit 93\n");
			writeFileSync(
				join(dir, "release-manifest.json"),
				JSON.stringify({ ...manifest, ...change }),
			);
			expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/manifest/);
		});
	}
	for (const change of [
		{ filename: "../escape" },
		{ size: 1 },
		{ sha256: "0".repeat(64) },
	]) {
		it(`rejects executable claim ${JSON.stringify(change)}`, () => {
			const { dir, manifest } = fixture("#!/bin/sh\nexit 93\n");
			writeFileSync(
				join(dir, "release-manifest.json"),
				JSON.stringify({
					...manifest,
					executable: { ...manifest.executable, ...change },
				}),
			);
			expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/manifest/);
		});
	}
	it("rejects tampering and malformed checksum/manifest before execution", () => {
		for (const name of [filename, "SHA256SUMS", "release-manifest.json"]) {
			const { dir } = fixture("#!/bin/sh\nexit 93\n");
			writeFileSync(join(dir, name), "tampered");
			expect(() => verifyReleaseDirectory(dir, expected)).toThrow(
				/manifest|checksums/,
			);
		}
	});
	for (const [flag, output] of [
		["--version", "wstack Router v9.9.9"],
		["--git-sha", "b".repeat(40)],
	] as const) {
		it(`rejects actual executable ${flag} mismatch despite consistent claims`, () => {
			const original = fixture();
			const source = readFileSync(join(original.dir, filename), "utf8");
			const { dir } = fixture(
				source.replace(
					flag === "--version" ? "wstack Router v1.2.3" : expected.sha,
					output,
				),
			);
			expect(() => verifyReleaseDirectory(dir, expected)).toThrow(/Unexpected/);
		});
	}
});
