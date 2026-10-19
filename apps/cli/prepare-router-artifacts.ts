#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const filename = "better-ccflare-linux-amd64";

function prepare(): void {
	const args = process.argv.slice(2);
	if (args.length !== 1 || !args[0] || args[0].startsWith("-")) {
		throw new Error(
			"Usage: bun run apps/cli/prepare-router-artifacts.ts <new-output-directory>",
		);
	}
	const destination = resolve(args[0]);
	if (lstatSync(destination, { throwIfNoEntry: false })) {
		throw new Error(
			"Destination already exists; choose a new output directory",
		);
	}
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new Error("Local artifact preparation supports Linux x86_64 only");
	}

	const scratch = mkdtempSync(join(tmpdir(), "router-prepare-"));
	const built = join(root, "apps/cli/dist", filename);
	// The backup must share a filesystem with dist: TMPDIR is often tmpfs, and
	// renameSync across devices fails with EXDEV.
	let backupDir: string | undefined;
	let previous = "";
	let savedPrevious = false;
	let ownsDestination = false;
	try {
		const home = join(scratch, "home");
		const cwd = join(scratch, "smoke", "cwd");
		mkdirSync(home);
		mkdirSync(cwd, { recursive: true });
		// Allowlist rather than redact: no credentials, endpoints, runtime overrides,
		// producer evidence, suffixes, or platform selectors survive inheritance.
		const env = {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			HOME: home,
			TMPDIR: scratch,
			NO_COLOR: "1",
		};
		const run = (command: string, argv: string[], directory: string) =>
			execFileSync(command, argv, {
				cwd: directory,
				env,
				encoding: "utf8",
				// stdout is returned to the caller; stderr stays visible on success.
				stdio: ["ignore", "pipe", "inherit"],
				timeout: 600_000,
				maxBuffer: 16 * 1024 * 1024,
			});

		// Preserve any old output, but make it impossible to package it after a
		// failed or unexpectedly skipped build. Restore it only if no new file exists.
		if (lstatSync(built, { throwIfNoEntry: false })) {
			backupDir = mkdtempSync(
				join(dirname(built), ".router-prepare-previous-"),
			);
			previous = join(backupDir, filename);
			renameSync(built, previous);
			savedPrevious = true;
		}
		process.stdout.write(
			run(
				process.execPath,
				["--no-env-file", "run", "build.ts"],
				join(root, "packages/dashboard-web"),
			),
		);
		execFileSync(
			process.execPath,
			["--no-env-file", "run", "build-multi-arch.ts"],
			{
				cwd: join(root, "apps/cli"),
				env: { ...env, CCFLARE_ONLY_PLATFORMS: "bun-linux-amd64" },
				stdio: "inherit",
				timeout: 600_000,
			},
		);
		if (!lstatSync(built, { throwIfNoEntry: false })?.isFile()) {
			throw new Error("Build did not produce a fresh Linux executable");
		}
		const staged = join(scratch, filename);
		copyFileSync(built, staged, constants.COPYFILE_EXCL);
		const digest = createHash("sha256")
			.update(readFileSync(staged))
			.digest("hex");
		writeFileSync(join(scratch, "SHA256SUMS"), `${digest}  ${filename}\n`, {
			flag: "wx",
		});
		process.stdout.write(run("sha256sum", ["-c", "SHA256SUMS"], scratch));

		const { version } = JSON.parse(
			readFileSync(join(root, "apps/cli/package.json"), "utf8"),
		);
		// cwd, cwd/../../, executable directory and HOME all belong to scratch.
		// This covers the compiled CLI's explicit dotenv fallbacks as well as Bun's.
		for (const alias of ["wstack-router", "better-ccflare"]) {
			const executable = join(scratch, alias);
			copyFileSync(staged, executable, constants.COPYFILE_EXCL);
			for (const flag of ["--help", "--version"]) {
				const output = execFileSync(executable, [flag], {
					cwd,
					env,
					encoding: "utf8",
					timeout: 10_000,
				});
				if (
					!output.includes("wstack Router") ||
					(flag === "--version" &&
						output.trim() !== `wstack Router v${version}`)
				) {
					throw new Error(`Unexpected ${alias} ${flag} output`);
				}
			}
		}
		if (
			readdirSync(home).some((name) => name !== ".bun") ||
			readdirSync(cwd).length !== 0
		) {
			throw new Error("Smoke check unexpectedly initialized configuration");
		}
		// mkdir is exclusive, including when another process creates a symlink
		// during the build. Never merge into or overwrite an existing destination.
		mkdirSync(destination);
		ownsDestination = true;
		copyFileSync(staged, join(destination, filename), constants.COPYFILE_EXCL);
		copyFileSync(
			join(scratch, "SHA256SUMS"),
			join(destination, "SHA256SUMS"),
			constants.COPYFILE_EXCL,
		);
		process.stdout.write(run("sha256sum", ["-c", "SHA256SUMS"], destination));
		ownsDestination = false;
		console.log(`Prepared local-only artifacts in ${destination}`);
	} finally {
		if (ownsDestination) rmSync(destination, { recursive: true, force: true });
		if (savedPrevious && !lstatSync(built, { throwIfNoEntry: false })) {
			renameSync(previous, built);
		}
		if (backupDir) rmSync(backupDir, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
}

try {
	prepare();
} catch (error) {
	console.error(error instanceof Error ? error.message : "Preparation failed");
	process.exitCode = 1;
}
