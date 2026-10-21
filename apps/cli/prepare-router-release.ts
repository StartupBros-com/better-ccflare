#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	constants,
	copyFileSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	isRouterRepository,
	routerRepositoryOrigins,
} from "../../packages/core/src/router-repository";
import { readTombiiTaggedBuildEvidence } from "./build-provenance";
import {
	artifactRoot,
	digestFile,
	executableFilename,
	isolatedEnvironment,
	prepareArtifacts,
	smokeExecutable,
} from "./router-artifacts";

export interface ReleaseIdentity {
	readonly repository: string;
	readonly version: string;
	readonly ref: string;
	readonly sha: string;
}
const bunPin = readFileSync(join(artifactRoot, ".bun-version"), "utf8").trim();
const target = "bun-linux-amd64";
const inventory = [
	"SHA256SUMS",
	executableFilename,
	"release-manifest.json",
].sort();
function validateIdentity(expected: ReleaseIdentity): void {
	if (
		!isRouterRepository(expected.repository) ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected.version) ||
		expected.ref !== `refs/tags/v${expected.version}` ||
		!/^[a-f0-9]{40}$/.test(expected.sha)
	)
		throw new Error("Invalid expected release repository/version/ref/full SHA");
}
export function expectedManifest(
	expected: ReleaseIdentity,
	size: number,
	digest: string,
) {
	validateIdentity(expected);
	return {
		schema: 1,
		repository: expected.repository,
		version: expected.version,
		ref: expected.ref,
		sha: expected.sha,
		bun: bunPin,
		target,
		executable: { filename: executableFilename, size, sha256: digest },
		provenance: {
			raw: "v1:startupbros-wstack-router-binary",
			schemaVersion: "v1",
			identity: "v1:startupbros-wstack-router-binary",
			producer: "startupbros",
			artifactMode: "binary",
			updateChannel: null,
			source_sha: expected.sha,
			source_ref: expected.ref,
			proven: true,
			actionable: false,
			reason: "proven_non_actionable",
		},
	};
}

export function validateReleaseSource(
	expected: ReleaseIdentity,
	version: string,
	bun: string,
	platform: string,
	arch: string,
	git: (args: string[]) => string | null,
): void {
	validateIdentity(expected);
	if (version !== expected.version)
		throw new Error("Release package version mismatch");
	if (bun !== bunPin || platform !== "linux" || arch !== "x64")
		throw new Error(`Release requires native Linux x64 Bun ${bunPin}`);
	const origin = git(["config", "--null", "--get", "remote.origin.url"]);
	if (!routerRepositoryOrigins(expected.repository).includes(origin ?? ""))
		throw new Error("Release origin does not match expected repository");
	const evidence = readTombiiTaggedBuildEvidence(
		version,
		"wstack-router-binary",
		git,
	);
	if (
		!evidence ||
		evidence.sourceSha !== expected.sha ||
		evidence.sourceRef !== expected.ref
	)
		throw new Error("Release requires clean exact HEAD/tag/source evidence");
}

export function prepareRelease(
	destination: string,
	expected: ReleaseIdentity,
): void {
	// Git evidence also runs with an allowlist: inherited GIT_DIR/config overrides are not evidence.
	const scratch = mkdtempSync(join(tmpdir(), "router-source-"));
	try {
		const git = (args: string[]): string | null => {
			try {
				const output = execFileSync("git", args, {
					cwd: artifactRoot,
					env: isolatedEnvironment(scratch, scratch),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "inherit"],
				});
				return args[0] === "config"
					? output.replace(/\0$/, "")
					: output.replace(/\r?\n$/, "");
			} catch {
				return null;
			}
		};
		const validate = () => {
			const cliVersion = JSON.parse(
				readFileSync(join(artifactRoot, "apps/cli/package.json"), "utf8"),
			).version;
			const rootVersion = JSON.parse(
				readFileSync(join(artifactRoot, "package.json"), "utf8"),
			).version;
			if (rootVersion !== cliVersion)
				throw new Error("Release root/CLI package version mismatch");
			validateReleaseSource(
				expected,
				cliVersion,
				Bun.version,
				process.platform,
				process.arch,
				git,
			);
		};
		validate();
		prepareArtifacts(destination, {
			version: expected.version,
			sha: expected.sha,
			validate,
			manifest: (size, digest) => expectedManifest(expected, size, digest),
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Byte/claim checks only; caller MUST authenticate GitHub attestations before invoking this executable smoke. */
export function verifyReleaseDirectory(
	directory: string,
	expected: ReleaseIdentity,
) {
	validateIdentity(expected);
	directory = resolve(directory);
	if (
		!lstatSync(directory).isDirectory() ||
		!isDeepStrictEqual(readdirSync(directory).sort(), inventory)
	)
		throw new Error("Invalid release inventory");
	for (const name of inventory)
		if (!lstatSync(join(directory, name)).isFile())
			throw new Error(`Release asset must be a regular file: ${name}`);
	// Snapshot into our owned directory, then validate and execute the same bytes.
	const scratch = mkdtempSync(join(tmpdir(), "router-verify-"));
	try {
		for (const name of inventory)
			copyFileSync(
				join(directory, name),
				join(scratch, name),
				constants.COPYFILE_EXCL,
			);
		const binary = join(scratch, executableFilename);
		const digest = digestFile(binary);
		const manifest = expectedManifest(expected, lstatSync(binary).size, digest);
		let actual: unknown;
		try {
			actual = JSON.parse(
				readFileSync(join(scratch, "release-manifest.json"), "utf8"),
			);
		} catch {
			throw new Error("Malformed release manifest");
		}
		if (!isDeepStrictEqual(actual, manifest))
			throw new Error(
				"Release manifest does not match independently expected identity or executable bytes",
			);
		if (
			readFileSync(join(scratch, "SHA256SUMS"), "utf8") !==
			`${digest}  ${executableFilename}\n`
		)
			throw new Error("Malformed or mismatched release checksums");
		// Download transports need not preserve mode. Never chmod untrusted input in place.
		chmodSync(binary, 0o755);
		smokeExecutable(binary, expected);
		return manifest;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		const [command, directory, repository, version, ref, sha, ...extra] =
			process.argv.slice(2);
		if (
			!directory ||
			!repository ||
			!version ||
			!ref ||
			!sha ||
			extra.length ||
			!["prepare", "verify"].includes(command ?? "")
		)
			throw new Error(
				"Usage: prepare-router-release.ts <prepare|verify> DIRECTORY REPOSITORY VERSION REF FULL_SHA (verify requires prior attestation authentication)",
			);
		const expected = { repository, version, ref, sha };
		if (command === "prepare") prepareRelease(directory, expected);
		else
			console.log(JSON.stringify(verifyReleaseDirectory(directory, expected)));
	} catch (error) {
		console.error(
			error instanceof Error
				? error.message
				: "Release preparation/verification failed",
		);
		process.exitCode = 1;
	}
}
