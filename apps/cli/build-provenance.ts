import { execFileSync } from "node:child_process";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "../..");
const FULL_LOWERCASE_SHA = /^[0-9a-f]{40}$/;
const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const TOMBI_REPOSITORY_URLS = new Set([
	"https://github.com/tombii/better-ccflare",
	"https://github.com/tombii/better-ccflare.git",
	"git@github.com:tombii/better-ccflare.git",
	"ssh://git@github.com/tombii/better-ccflare.git",
]);

export type ReleaseBuildContext = "github-release-binary" | "npm-package";

export interface ReleaseBuildEvidence {
	readonly version: string;
	readonly sourceSha: string;
	readonly sourceRef: string;
}

function define(name: string, value: string): string[] {
	return ["--define", `${name}=${JSON.stringify(value)}`];
}

function distributionFor(context: ReleaseBuildContext): {
	token: string;
	artifactMode: string;
	updateChannel: string;
} {
	return context === "github-release-binary"
		? {
				token: "v1:tombii-github-release-binary",
				artifactMode: "binary",
				updateChannel: "github-releases",
			}
		: {
				token: "v1:tombii-npm-package",
				artifactMode: "package",
				updateChannel: "npm",
			};
}

function validEvidence(
	evidence: ReleaseBuildEvidence | null,
): evidence is ReleaseBuildEvidence {
	return (
		evidence !== null &&
		RELEASE_VERSION.test(evidence.version) &&
		FULL_LOWERCASE_SHA.test(evidence.sourceSha) &&
		evidence.sourceRef === `refs/tags/v${evidence.version}`
	);
}

/**
 * Emit immutable Bun constants as argv pairs. JSON string expressions contain
 * no whitespace, so the package build's unquoted command substitution preserves
 * each controlled token; direct callers can pass the pairs to execFile safely.
 */
export function releaseBuildDefines(
	evidence: ReleaseBuildEvidence | null,
	context: ReleaseBuildContext | null,
): string[] {
	if (!validEvidence(evidence) || context === null) return [];
	const distribution = distributionFor(context);
	return [
		...define("__BETTER_CCFLARE_GIT_SHA__", evidence.sourceSha),
		...define("__CCFLARE_BUILD_PROVENANCE_VERSION__", evidence.version),
		...define("__CCFLARE_BUILD_PROVENANCE_DISTRIBUTION__", distribution.token),
		...define("__CCFLARE_BUILD_PROVENANCE_PRODUCER__", "tombii"),
		...define(
			"__CCFLARE_BUILD_PROVENANCE_ARTIFACT_MODE__",
			distribution.artifactMode,
		),
		...define(
			"__CCFLARE_BUILD_PROVENANCE_UPDATE_CHANNEL__",
			distribution.updateChannel,
		),
		...define("__CCFLARE_BUILD_PROVENANCE_GIT_SHA__", evidence.sourceSha),
		...define("__CCFLARE_BUILD_PROVENANCE_GIT_REF__", evidence.sourceRef),
		...define("__CCFLARE_BUILD_PROVENANCE_SOURCE_SHA__", evidence.sourceSha),
		...define("__CCFLARE_BUILD_PROVENANCE_SOURCE_REF__", evidence.sourceRef),
	];
}

function git(args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

/**
 * A release marker alone is insufficient: only an explicit producer context,
 * the tombii origin, a clean worktree, a plain version, and an exact HEAD/tag
 * equality can emit actionable provenance. Git-ignored generated workers and
 * build outputs remain outside the cleanliness check.
 */
export function readTombiiTaggedBuildEvidence(
	version: string,
	context: string | undefined,
	runGit: (args: string[]) => string | null = git,
): ReleaseBuildEvidence | null {
	if (
		!RELEASE_VERSION.test(version) ||
		(context !== "github-release-binary" && context !== "npm-package")
	)
		return null;
	if (
		!TOMBI_REPOSITORY_URLS.has(
			runGit(["config", "--get", "remote.origin.url"]) ?? "",
		)
	)
		return null;
	if (runGit(["status", "--porcelain"]) !== "") return null;
	const sourceSha = runGit(["rev-parse", "HEAD"]);
	const tagSha = runGit(["rev-parse", `refs/tags/v${version}^{commit}`]);
	if (!sourceSha || !tagSha || !FULL_LOWERCASE_SHA.test(sourceSha)) return null;
	return sourceSha === tagSha
		? { version, sourceSha, sourceRef: `refs/tags/v${version}` }
		: null;
}

async function main(): Promise<void> {
	const packageJson = (await Bun.file("./package.json").json()) as {
		version?: unknown;
	};
	const suffix = process.env.CCFLARE_BUILD_SUFFIX;
	const version =
		typeof packageJson.version === "string" && !suffix
			? packageJson.version
			: "";
	const context = process.env.CCFLARE_BUILD_PRODUCER;
	const evidence = readTombiiTaggedBuildEvidence(version, context);
	const defines = releaseBuildDefines(
		evidence,
		context === "github-release-binary" || context === "npm-package"
			? context
			: null,
	);
	if (defines.length > 0) process.stdout.write(defines.join(" "));
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
