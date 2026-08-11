import { getGitSha, getVersionSync } from "./version";

export interface DockerBuildProvenance {
	readonly version: string;
	readonly git_sha: string;
	readonly git_ref: string;
	readonly build_date: string;
}

export interface ResolvedBuildProvenance {
	readonly version: string;
	readonly git_sha: string | null;
	readonly git_ref: string;
	readonly build_date: string;
}

export function readDockerBuildProvenance(
	env: Readonly<Record<string, string | undefined>> = process.env,
): DockerBuildProvenance {
	return {
		version:
			env.CCFLARE_VERSION ??
			env.BETTER_CCFLARE_VERSION ??
			env.npm_package_version ??
			"unknown",
		git_sha: env.CCFLARE_GIT_SHA ?? "unknown",
		git_ref: env.CCFLARE_GIT_REF ?? "unknown",
		build_date: env.CCFLARE_BUILD_DATE ?? "unknown",
	};
}

export function readBuildProvenance(
	env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedBuildProvenance {
	const docker = readDockerBuildProvenance(env);
	return {
		...docker,
		version: getVersionSync(),
		git_sha: getGitSha(),
	};
}

export function normalizeDeploymentRevision(
	revision: string | null | undefined,
): string | null {
	if (typeof revision !== "string") return null;
	const normalized = revision.trim();
	if (normalized.length === 0 || normalized === "unknown") return null;
	return normalized;
}
