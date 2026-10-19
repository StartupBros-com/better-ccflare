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

export const artifactRoot = resolve(import.meta.dir, "../..");
export const executableFilename = "better-ccflare-linux-amd64";
export function isolatedEnvironment(home: string, scratch: string) {
	return {
		PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: home,
		TMPDIR: scratch,
		NO_COLOR: "1",
	};
}
export function digestFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Shared isolation for local builds and already-authenticated downloaded releases. */
export function smokeExecutable(
	binary: string,
	version: string,
	sha?: string,
): void {
	const scratch = mkdtempSync(join(tmpdir(), "router-smoke-"));
	try {
		const home = join(scratch, "home");
		const cwd = join(scratch, "smoke", "cwd");
		mkdirSync(home);
		mkdirSync(cwd, { recursive: true });
		const env = isolatedEnvironment(home, scratch);
		for (const alias of ["wstack-router", "better-ccflare"]) {
			const executable = join(scratch, alias);
			copyFileSync(binary, executable, constants.COPYFILE_EXCL);
			for (const flag of [
				"--help",
				"--version",
				...(sha ? ["--git-sha"] : []),
			]) {
				const output = execFileSync(executable, [flag], {
					cwd,
					env,
					encoding: "utf8",
					timeout: 10_000,
				});
				if (
					(flag === "--help" && !output.includes("wstack Router")) ||
					(flag === "--version" &&
						output.trim() !== `wstack Router v${version}`) ||
					(flag === "--git-sha" && output.trim() !== sha)
				)
					throw new Error(`Unexpected ${alias} ${flag} output`);
			}
		}
		if (
			readdirSync(home).some((name) => name !== ".bun") ||
			readdirSync(cwd).length !== 0
		)
			throw new Error("Smoke check unexpectedly initialized configuration");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

interface ReleasePreparation {
	readonly version: string;
	readonly sha: string;
	/** Revalidate after building, before claiming release identity. */
	readonly validate: () => void;
	readonly manifest: (size: number, digest: string) => unknown;
}

/** The explicit release argument alone enables the producer; ambient env never does. */
export function prepareArtifacts(
	destination: string,
	release?: ReleasePreparation,
): void {
	destination = resolve(destination);
	if (lstatSync(destination, { throwIfNoEntry: false }))
		throw new Error(
			"Destination already exists; choose a new output directory",
		);
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error("Local artifact preparation supports Linux x86_64 only");
	const scratch = mkdtempSync(join(tmpdir(), "router-prepare-"));
	const built = join(artifactRoot, "apps/cli/dist", executableFilename);
	// Same filesystem as dist, even when TMPDIR is tmpfs.
	let backupDir: string | undefined;
	let previous = "";
	let savedPrevious = false;
	let ownsBuilt = false;
	let ownsDestination = false;
	let completed = false;
	try {
		const home = join(scratch, "home");
		mkdirSync(home);
		const env = isolatedEnvironment(home, scratch);
		const run = (command: string, argv: string[], cwd: string) =>
			execFileSync(command, argv, {
				cwd,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "inherit"],
				timeout: 600_000,
				maxBuffer: 16 * 1024 * 1024,
			});
		release?.validate();
		if (lstatSync(built, { throwIfNoEntry: false })) {
			backupDir = mkdtempSync(
				join(dirname(built), ".router-prepare-previous-"),
			);
			previous = join(backupDir, executableFilename);
			renameSync(built, previous);
			savedPrevious = true;
		}
		ownsBuilt = true;
		process.stdout.write(
			run(
				process.execPath,
				["--no-env-file", "run", "build.ts"],
				join(artifactRoot, "packages/dashboard-web"),
			),
		);
		execFileSync(
			process.execPath,
			["--no-env-file", "run", "build-multi-arch.ts"],
			{
				cwd: join(artifactRoot, "apps/cli"),
				env: {
					...env,
					CCFLARE_ONLY_PLATFORMS: "bun-linux-amd64",
					...(release
						? { CCFLARE_BUILD_PRODUCER: "wstack-router-binary" }
						: {}),
				},
				stdio: "inherit",
				timeout: 600_000,
			},
		);
		if (readdirSync(home).some((name) => name !== ".bun"))
			throw new Error("Build unexpectedly initialized configuration");
		if (!lstatSync(built, { throwIfNoEntry: false })?.isFile())
			throw new Error("Build did not produce a fresh Linux executable");
		release?.validate();
		const staged = join(scratch, executableFilename);
		copyFileSync(built, staged, constants.COPYFILE_EXCL);
		const digest = digestFile(staged);
		writeFileSync(
			join(scratch, "SHA256SUMS"),
			`${digest}  ${executableFilename}\n`,
			{ flag: "wx" },
		);
		process.stdout.write(run("sha256sum", ["-c", "SHA256SUMS"], scratch));
		const version =
			release?.version ??
			JSON.parse(
				readFileSync(join(artifactRoot, "apps/cli/package.json"), "utf8"),
			).version;
		smokeExecutable(staged, version, release?.sha);
		const inventory = [executableFilename, "SHA256SUMS"];
		if (release) {
			writeFileSync(
				join(scratch, "release-manifest.json"),
				`${JSON.stringify(release.manifest(lstatSync(staged).size, digest), null, 2)}\n`,
				{ flag: "wx" },
			);
			inventory.push("release-manifest.json");
		}
		// Exclusive ownership: never merge into a destination created during the build.
		mkdirSync(destination);
		ownsDestination = true;
		for (const name of inventory)
			copyFileSync(
				join(scratch, name),
				join(destination, name),
				constants.COPYFILE_EXCL,
			);
		process.stdout.write(run("sha256sum", ["-c", "SHA256SUMS"], destination));
		console.log(
			`Prepared ${release ? "release" : "local-only"} artifacts in ${destination}`,
		);
		completed = true;
		ownsDestination = false;
	} finally {
		if (ownsDestination) rmSync(destination, { recursive: true, force: true });
		if (!completed && ownsBuilt) {
			rmSync(built, { recursive: true, force: true });
			// If restoration fails, leave the backup for recovery.
			if (savedPrevious) renameSync(previous, built);
		}
		if (backupDir) rmSync(backupDir, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
}
