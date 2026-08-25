import { describe, expect, it } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformsForBuild, releaseBuildDefines } from "../build-multi-arch";
import { readTombiiTaggedBuildEvidence } from "../build-provenance";

const sha = "abcdef1234567890abcdef1234567890abcdef12";
const runtimeSha = "1234567890abcdef1234567890abcdef12345678";
const coreBuildProvenance = join(
	import.meta.dir,
	"../../../packages/core/src/build-provenance.ts",
);
const coreVersion = join(
	import.meta.dir,
	"../../../packages/core/src/version.ts",
);

function runCompiledFixture(
	defines: string[],
	env: Record<string, string> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-provenance-"));
	const source = join(dir, "fixture.ts");
	const binary = join(dir, "fixture");
	writeFileSync(
		source,
		[
			`import { readDockerBuildProvenance, resolveBuildProvenance } from ${JSON.stringify(coreBuildProvenance)};`,
			`import { getVersionSync } from ${JSON.stringify(coreVersion)};`,
			"process.stdout.write(JSON.stringify({ version: getVersionSync(), provenance: resolveBuildProvenance(), docker: readDockerBuildProvenance() }));",
		].join("\n"),
	);
	try {
		execFileSync(
			"bun",
			["build", source, "--compile", "--outfile", binary, ...defines],
			{ stdio: "pipe" },
		);
		return JSON.parse(
			execFileSync(binary, {
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", ...env },
			}),
		);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

function runShellSubstitutionFixture(): unknown {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-provenance-shell-"));
	const source = join(dir, "fixture.ts");
	const binary = join(dir, "fixture");
	const releaseBuildProvenance = join(
		import.meta.dir,
		"../build-provenance.ts",
	);
	const defineCommand = [
		`import { releaseBuildDefines } from ${JSON.stringify(releaseBuildProvenance)};`,
		`process.stdout.write(releaseBuildDefines({ version: "1.2.3", sourceSha: "${sha}", sourceRef: "refs/tags/v1.2.3" }, "github-release-binary").join(" "));`,
	].join(" ");
	writeFileSync(
		source,
		[
			`import { resolveBuildProvenance } from ${JSON.stringify(coreBuildProvenance)};`,
			"process.stdout.write(JSON.stringify(resolveBuildProvenance()));",
		].join("\n"),
	);
	try {
		execSync(
			`bun build ${JSON.stringify(source)} --compile --outfile ${JSON.stringify(binary)} $(bun -e ${JSON.stringify(defineCommand)})`,
			{ stdio: "pipe" },
		);
		return JSON.parse(
			execFileSync(binary, {
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "" },
			}),
		);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

function define(name: string, value: string): string[] {
	return ["--define", `${name}=${JSON.stringify(value)}`];
}

function releaseFixtureDefines() {
	return [
		...define("__BETTER_CCFLARE_VERSION__", "1.2.3"),
		...releaseBuildDefines(
			{
				version: "1.2.3",
				sourceSha: sha,
				sourceRef: "refs/tags/v1.2.3",
			},
			"github-release-binary",
		),
	];
}

describe("release binary provenance", () => {
	it("emits shell-safe immutable constants only for an explicit release producer", () => {
		const evidence = {
			version: "1.2.3",
			sourceSha: sha,
			sourceRef: "refs/tags/v1.2.3",
		};
		expect(releaseBuildDefines(evidence, null)).toEqual([]);
		expect(releaseBuildDefines(evidence, "github-release-binary")).toEqual([
			"--define",
			`__BETTER_CCFLARE_GIT_SHA__=${JSON.stringify(sha)}`,
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_VERSION__="1.2.3"',
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_DISTRIBUTION__="v1:tombii-github-release-binary"',
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_PRODUCER__="tombii"',
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_ARTIFACT_MODE__="binary"',
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_UPDATE_CHANNEL__="github-releases"',
			"--define",
			`__CCFLARE_BUILD_PROVENANCE_GIT_SHA__=${JSON.stringify(sha)}`,
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_GIT_REF__="refs/tags/v1.2.3"',
			"--define",
			`__CCFLARE_BUILD_PROVENANCE_SOURCE_SHA__=${JSON.stringify(sha)}`,
			"--define",
			'__CCFLARE_BUILD_PROVENANCE_SOURCE_REF__="refs/tags/v1.2.3"',
		]);
	});

	it("preserves exact define expressions through package-style command substitution", () => {
		expect(runShellSubstitutionFixture()).toMatchObject({
			raw: "v1:tombii-github-release-binary",
			identity: "v1:tombii-github-release-binary",
			producer: "tombii",
			artifactMode: "binary",
			updateChannel: "github-releases",
			source_sha: sha,
			source_ref: "refs/tags/v1.2.3",
			proven: true,
			actionable: true,
			reason: "proven_actionable",
		});
	});

	it("proves an actual compiled binary's immutable release identity and lets runtime evidence override it", () => {
		const defines = releaseFixtureDefines();
		const embedded = runCompiledFixture(defines);
		expect(embedded).toMatchObject({
			version: "1.2.3",
			provenance: {
				raw: "v1:tombii-github-release-binary",
				schemaVersion: "v1",
				identity: "v1:tombii-github-release-binary",
				producer: "tombii",
				artifactMode: "binary",
				updateChannel: "github-releases",
				source_sha: sha,
				source_ref: "refs/tags/v1.2.3",
				proven: true,
				actionable: true,
				reason: "proven_actionable",
			},
		});

		const isolatedRuntimeFields = runCompiledFixture(defines, {
			CCFLARE_VERSION: "9.9.9",
			CCFLARE_GIT_SHA: runtimeSha,
		});
		expect(isolatedRuntimeFields).toEqual(embedded);
		expect(isolatedRuntimeFields.docker).toMatchObject({
			version: "1.2.3",
			git_sha: sha,
			git_ref: "refs/tags/v1.2.3",
		});

		const runtimeOverride = runCompiledFixture(defines, {
			CCFLARE_DISTRIBUTION: "v1:startupbros-managed-source",
			CCFLARE_GIT_SHA: runtimeSha,
			CCFLARE_GIT_REF: "refs/heads/main",
			CCFLARE_SOURCE_SHA: runtimeSha,
			CCFLARE_SOURCE_REF: "refs/heads/main",
			CCFLARE_PRODUCER: "startupbros",
			CCFLARE_ARTIFACT_MODE: "managed-source",
			CCFLARE_VERSION: "9.9.9",
		});
		expect(runtimeOverride.provenance).toMatchObject({
			identity: "v1:startupbros-managed-source",
			producer: "startupbros",
			artifactMode: "managed-source",
			source_sha: runtimeSha,
			source_ref: "refs/heads/main",
			proven: true,
			actionable: false,
			reason: "proven_non_actionable",
		});

		const partialRuntimeOverride = runCompiledFixture(defines, {
			CCFLARE_DISTRIBUTION: "v1:startupbros-managed-source",
		});
		expect(partialRuntimeOverride.provenance).toMatchObject({
			identity: "v1:startupbros-managed-source",
			proven: false,
			actionable: false,
			reason: "missing_source_sha",
		});
	});

	it("wires the tagged npm producer through prepublish and embeds its actionable identity", () => {
		const packageJson = JSON.parse(
			readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(packageJson.scripts.prepublishOnly).toContain(
			"CCFLARE_BUILD_PRODUCER=npm-package bun run build",
		);
		expect(packageJson.scripts.build).toContain(
			"$(bun run --silent build-provenance.ts)",
		);

		const embedded = runCompiledFixture([
			...define("__BETTER_CCFLARE_VERSION__", "1.2.3"),
			...releaseBuildDefines(
				{
					version: "1.2.3",
					sourceSha: sha,
					sourceRef: "refs/tags/v1.2.3",
				},
				"npm-package",
			),
		]);
		expect(embedded.provenance).toMatchObject({
			identity: "v1:tombii-npm-package",
			producer: "tombii",
			artifactMode: "package",
			updateChannel: "npm",
			source_sha: sha,
			source_ref: "refs/tags/v1.2.3",
			proven: true,
			actionable: true,
			reason: "proven_actionable",
		});
	});

	it("requires the exact tagged, clean tombii producer context before it emits provenance", () => {
		const cleanProbeCalls: string[][] = [];
		const verifiedProbe = (args: string[]) => {
			cleanProbeCalls.push(args);
			if (args[0] === "config")
				return "https://github.com/tombii/better-ccflare";
			if (args[0] === "status") return "";
			return sha;
		};
		expect(
			readTombiiTaggedBuildEvidence("1.2.3", "npm-package", verifiedProbe),
		).toEqual({
			version: "1.2.3",
			sourceSha: sha,
			sourceRef: "refs/tags/v1.2.3",
		});
		expect(cleanProbeCalls).toContainEqual(["status", "--porcelain"]);

		for (const status of [
			" M apps/cli/build-provenance.ts",
			"?? bunfig.toml",
		]) {
			const dirtyProbe = (args: string[]) => {
				if (args[0] === "config")
					return "https://github.com/tombii/better-ccflare";
				if (args[0] === "status") return status;
				return sha;
			};
			expect(
				readTombiiTaggedBuildEvidence("1.2.3", "npm-package", dirtyProbe),
			).toBeNull();
		}

		for (const [version, context, probe] of [
			["1.2.3", undefined, verifiedProbe],
			["1.2.3+local", "npm-package", verifiedProbe],
			[
				"1.2.3",
				"npm-package",
				(args: string[]) =>
					args[0] === "config"
						? "https://github.com/startupbros/better-ccflare.git"
						: args[0] === "status"
							? ""
							: sha,
			],
			[
				"1.2.3",
				"npm-package",
				(args: string[]) =>
					args[0] === "config"
						? "https://github.com/tombii/better-ccflare.git"
						: args[0] === "status"
							? ""
							: "abc123",
			],
			[
				"1.2.3",
				"github-release-binary",
				(args: string[]) =>
					args[0] === "config"
						? "https://github.com/tombii/better-ccflare.git"
						: args[0] === "status"
							? ""
							: args[1] === "HEAD"
								? sha
								: runtimeSha,
			],
		] as const) {
			expect(readTombiiTaggedBuildEvidence(version, context, probe)).toBeNull();
		}
	});

	it("emits no runtime provenance evidence when tag/SHA proof is absent or malformed", () => {
		expect(releaseBuildDefines(null, "github-release-binary")).toEqual([]);
		for (const evidence of [
			{ version: "1.2", sourceSha: sha, sourceRef: "refs/tags/v1.2" },
			{
				version: "01.2.3",
				sourceSha: sha,
				sourceRef: "refs/tags/v01.2.3",
			},
			{
				version: "1.2.3",
				sourceSha: sha.slice(0, 12),
				sourceRef: "refs/tags/v1.2.3",
			},
			{
				version: "1.2.3",
				sourceSha: sha.toUpperCase(),
				sourceRef: "refs/tags/v1.2.3",
			},
			{ version: "1.2.3", sourceSha: sha, sourceRef: "refs/heads/main" },
		]) {
			expect(releaseBuildDefines(evidence, "github-release-binary")).toEqual(
				[],
			);
		}
	});

	it("routes every per-architecture script through the shared selected-platform builder", () => {
		const packageJson = JSON.parse(
			readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		const expectedScripts = {
			"build:linux-amd64": "bun-linux-amd64",
			"build:linux-arm64": "bun-linux-arm64",
			"build:macos-x86_64": "bun-darwin-x64",
			"build:macos-arm64": "bun-darwin-arm64",
			"build:windows-x64": "bun-windows-x64",
		};
		for (const [script, target] of Object.entries(expectedScripts)) {
			expect(packageJson.scripts[script]).toBe(
				`CCFLARE_ONLY_PLATFORMS=${target} bun run build:multi`,
			);
			expect(packageJson.scripts[script]).not.toContain(
				"bun build src/main.ts",
			);
		}
	});

	it("selects only requested architectures while keeping ordinary builds unproven", () => {
		expect(platformsForBuild("bun-windows-x64", "")).toEqual([
			expect.objectContaining({
				target: "bun-windows-x64",
				outfile: "better-ccflare-windows-x64.exe",
			}),
		]);
		expect(platformsForBuild("better-ccflare-linux-amd64", "")).toEqual([
			expect.objectContaining({ target: "bun-linux-amd64" }),
		]);
		expect(() => platformsForBuild("unknown-platform", "")).toThrow(
			"CCFLARE_ONLY_PLATFORMS contains an unknown platform",
		);
		expect(releaseBuildDefines(null, "github-release-binary")).toEqual([]);
	});

	it("proves production tag builds but leaves every dispatch and test signing unproven", () => {
		const release = readFileSync(
			join(import.meta.dir, "../../../.github/workflows/release.yml"),
			"utf8",
		);
		const signpathRelease = readFileSync(
			join(import.meta.dir, "../../../.github/workflows/signpath-release.yml"),
			"utf8",
		);
		const signpathTest = readFileSync(
			join(import.meta.dir, "../../../.github/workflows/signpath-test.yml"),
			"utf8",
		);
		const tagReleaseProducer =
			"CCFLARE_BUILD_PRODUCER: $" +
			"{{ github.event_name == 'push' && github.ref_type == 'tag' && 'github-release-binary' || '' }}";
		expect(release).toContain(tagReleaseProducer);
		expect(release).not.toContain(
			"CCFLARE_BUILD_PRODUCER=github-release-binary",
		);
		expect(signpathRelease).toContain(tagReleaseProducer);
		expect(signpathRelease).toContain("bun run build:windows-x64");
		expect(signpathTest).not.toContain("CCFLARE_BUILD_PRODUCER");
	});
});
