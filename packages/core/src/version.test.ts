import { describe, expect, it } from "bun:test";
import {
	isTrustedDistributionProvenance,
	parseDistributionIdentity,
	readDockerBuildProvenance,
	resolveBuildProvenance,
} from "./build-provenance";
import {
	CLAUDE_CLI_VERSION,
	extractClaudeVersion,
	getClientVersion,
	trackClientVersion,
} from "./version";

describe("release lineage", () => {
	it("uses the exact upstream Claude CLI fallback version", () => {
		expect(CLAUDE_CLI_VERSION).toBe("2.1.250");
	});

	it("preserves runtime Git SHA fallback and explicit unknown behavior", () => {
		const script =
			'const { getGitSha } = await import("./version.ts"); process.stdout.write(String(getGitSha()));';
		const known = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: { ...process.env, BETTER_CCFLARE_GIT_SHA: "abc1234" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(known.exitCode).toBe(0);
		expect(known.stdout.toString()).toBe("abc1234");

		const unknownEnv = { ...process.env };
		delete unknownEnv.BETTER_CCFLARE_GIT_SHA;
		const unknown = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			env: unknownEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(unknown.exitCode).toBe(0);
		expect(unknown.stdout.toString()).toBe("null");
	});
});

describe("extractClaudeVersion", () => {
	it("should extract version from standard claude-cli user-agent", () => {
		const userAgent = "claude-cli/2.0.55 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should extract version from newer claude-cli user-agent", () => {
		const userAgent = "claude-cli/2.0.60 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.60");
	});

	it("should extract version with prerelease metadata", () => {
		const userAgent = "claude-cli/2.1.0-beta.1 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.1.0-beta.1");
	});

	it("should extract version with build metadata", () => {
		const userAgent = "claude-cli/2.0.55+build.123 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55+build.123");
	});

	it("should extract version with both prerelease and build metadata", () => {
		const userAgent = "claude-cli/2.1.0-rc.1+build.456 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.1.0-rc.1+build.456");
	});

	it("should handle case-insensitive matching", () => {
		const userAgent = "Claude-CLI/2.0.55 (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should return null for non-claude-cli user-agent", () => {
		const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
		expect(extractClaudeVersion(userAgent)).toBeNull();
	});

	it("should return null for null user-agent", () => {
		expect(extractClaudeVersion(null)).toBeNull();
	});

	it("should return null for empty string", () => {
		expect(extractClaudeVersion("")).toBeNull();
	});

	it("should return null for malformed version", () => {
		const userAgent = "claude-cli/invalid (external, cli)";
		expect(extractClaudeVersion(userAgent)).toBeNull();
	});

	it("should extract version when embedded in longer user-agent string", () => {
		const userAgent =
			"some-prefix claude-cli/2.0.55 (external, cli) some-suffix";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should handle version without suffix text", () => {
		const userAgent = "claude-cli/2.0.55";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});

	it("should extract first occurrence if multiple versions present", () => {
		const userAgent = "claude-cli/2.0.55 claude-cli/2.0.60";
		expect(extractClaudeVersion(userAgent)).toBe("2.0.55");
	});
});

describe("trackClientVersion and getClientVersion", () => {
	it("should track and return client version", () => {
		trackClientVersion("claude-cli/2.0.60 (external, cli)");
		expect(getClientVersion()).toBe("2.0.60");
	});

	it("should update to newer client version", () => {
		trackClientVersion("claude-cli/2.0.55 (external, cli)");
		expect(getClientVersion()).toBe("2.0.55");

		trackClientVersion("claude-cli/2.0.65 (external, cli)");
		expect(getClientVersion()).toBe("2.0.65");
	});

	it("should ignore non-claude-cli user-agents", () => {
		trackClientVersion("claude-cli/2.0.55 (external, cli)");
		const beforeVersion = getClientVersion();

		trackClientVersion("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
		expect(getClientVersion()).toBe(beforeVersion);
	});

	it("should handle null user-agent gracefully", () => {
		trackClientVersion("claude-cli/2.0.55 (external, cli)");
		const beforeVersion = getClientVersion();

		trackClientVersion(null);
		expect(getClientVersion()).toBe(beforeVersion);
	});
});

describe("distribution identity", () => {
	const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";

	it("accepts every exact v1 catalogue token and rejects non-exact forms", () => {
		const accepted = [
			"v1:startupbros-managed-source",
			"v1:tombii-ghcr-docker",
			"v1:tombii-npm-package",
			"v1:tombii-github-release-binary",
			"v1:startupbros-docker-image",
		] as const;
		for (const token of accepted) {
			expect(parseDistributionIdentity(token)).not.toBeNull();
		}
		for (const invalid of [
			undefined,
			"",
			" v1:startupbros-managed-source",
			"v1:startupbros-managed-source ",
			"V1:startupbros-managed-source",
			"v2:startupbros-managed-source",
			"v1:STARTUPBROS-managed-source",
			"v1:startupbros-managed-source:extra",
			"v1:tombii-ghcr-docker/extra",
			"v1:arbitrary:tuple",
		]) {
			expect(parseDistributionIdentity(invalid)).toBeNull();
		}
	});

	it("requires complete redundant evidence for non-actionable identities", () => {
		const valid = {
			CCFLARE_DISTRIBUTION: "v1:startupbros-managed-source",
			CCFLARE_GIT_SHA: sourceSha,
			CCFLARE_GIT_REF: "refs/heads/main",
			CCFLARE_SOURCE_SHA: sourceSha,
			CCFLARE_SOURCE_REF: "refs/heads/main",
			CCFLARE_PRODUCER: "startupbros",
			CCFLARE_ARTIFACT_MODE: "managed-source",
		} as const;
		expect(resolveBuildProvenance(valid)).toMatchObject({
			proven: true,
			actionable: false,
			source_sha: sourceSha,
		});

		for (const [missing, reason] of [
			["CCFLARE_GIT_SHA", "missing_source_sha"],
			["CCFLARE_GIT_REF", "missing_source_ref"],
			["CCFLARE_SOURCE_SHA", "missing_redundant_source_sha"],
			["CCFLARE_SOURCE_REF", "missing_redundant_source_ref"],
			["CCFLARE_PRODUCER", "missing_producer"],
			["CCFLARE_ARTIFACT_MODE", "missing_artifact_mode"],
		] as const) {
			const evidence = { ...valid } as Record<string, string>;
			delete evidence[missing];
			expect(resolveBuildProvenance(evidence).reason).toBe(reason);
		}

		expect(
			resolveBuildProvenance({ ...valid, CCFLARE_UPDATE_CHANNEL: "" }).reason,
		).toBe("unexpected_update_channel");
		expect(
			resolveBuildProvenance({
				...valid,
				CCFLARE_SOURCE_SHA: "forged",
			}).reason,
		).toBe("conflicting_source_sha");

		for (const env of [
			{},
			{ CCFLARE_GIT_SHA: "" },
			{ CCFLARE_GIT_SHA: ` ${sourceSha}` },
			{ CCFLARE_GIT_SHA: `${sourceSha} ` },
			{ CCFLARE_GIT_SHA: sourceSha.slice(0, 12) },
			{ CCFLARE_GIT_SHA: sourceSha.toUpperCase() },
			{ CCFLARE_GIT_SHA: "unknown" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_GIT_REF: "" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_GIT_REF: "refs/tags/v1.0.0" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_ARTIFACT_MODE: "docker" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_PRODUCER: "tombii" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_UPDATE_CHANNEL: "npm" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_UPDATE_CHANNEL: "" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_SOURCE_SHA: "forged" },
			{ CCFLARE_GIT_SHA: sourceSha, CCFLARE_SOURCE_REF: "refs/tags/v1.0.0" },
		]) {
			const result = resolveBuildProvenance({
				CCFLARE_DISTRIBUTION: "v1:startupbros-managed-source",
				CCFLARE_GIT_REF: "refs/heads/main",
				...env,
			});
			expect(result.proven).toBe(false);
			expect(result.actionable).toBe(false);
		}
	});

	it("requires matching release ref and tuple for actionable tombii identities", () => {
		const release = {
			CCFLARE_DISTRIBUTION: "v1:tombii-ghcr-docker",
			CCFLARE_VERSION: "1.2.3",
			CCFLARE_GIT_SHA: sourceSha,
			CCFLARE_GIT_REF: "refs/tags/v1.2.3",
			CCFLARE_SOURCE_SHA: sourceSha,
			CCFLARE_SOURCE_REF: "refs/tags/v1.2.3",
			CCFLARE_PRODUCER: "tombii",
			CCFLARE_ARTIFACT_MODE: "docker",
			CCFLARE_UPDATE_CHANNEL: "ghcr",
		} as const;
		expect(resolveBuildProvenance(release)).toMatchObject({
			proven: true,
			actionable: true,
			updateChannel: "ghcr",
		});
		const missingChannel = { ...release } as Record<string, string>;
		delete missingChannel.CCFLARE_UPDATE_CHANNEL;
		expect(resolveBuildProvenance(missingChannel).reason).toBe(
			"missing_update_channel",
		);
		expect(
			resolveBuildProvenance({
				...release,
				CCFLARE_UPDATE_CHANNEL: "npm",
			}).reason,
		).toBe("conflicting_update_channel");
		for (const env of [
			{ CCFLARE_VERSION: "1.2.4" },
			{ CCFLARE_VERSION: "v1.2.3", CCFLARE_GIT_REF: "refs/tags/v1.2.3" },
			{ CCFLARE_VERSION: "1.2", CCFLARE_GIT_REF: "refs/tags/v1.2" },
			{ CCFLARE_VERSION: "unknown", CCFLARE_GIT_REF: "refs/tags/vunknown" },
			{ CCFLARE_GIT_REF: "refs/tags/V1.2.3" },
			{ CCFLARE_GIT_REF: "refs/tags/v1.2.3 " },
			{ CCFLARE_PRODUCER: "startupbros" },
			{ CCFLARE_ARTIFACT_MODE: "binary" },
			{ CCFLARE_UPDATE_CHANNEL: "github-releases" },
			{ CCFLARE_DISTRIBUTION: "v1:startupbros-docker-image" },
		]) {
			expect(resolveBuildProvenance({ ...release, ...env }).proven).toBe(false);
		}
	});

	it("fails closed for non-stable Tombii release versions in resolvers and facades", () => {
		const release = {
			CCFLARE_DISTRIBUTION: "v1:tombii-npm-package",
			CCFLARE_VERSION: "1.2.3",
			CCFLARE_GIT_SHA: sourceSha,
			CCFLARE_GIT_REF: "refs/tags/v1.2.3",
			CCFLARE_SOURCE_SHA: sourceSha,
			CCFLARE_SOURCE_REF: "refs/tags/v1.2.3",
			CCFLARE_PRODUCER: "tombii",
			CCFLARE_ARTIFACT_MODE: "package",
			CCFLARE_UPDATE_CHANNEL: "npm",
		} as const;
		const proven = resolveBuildProvenance(release);
		expect(isTrustedDistributionProvenance(proven, "1.2.3")).toBe(true);

		for (const version of [
			"1.2.3-rc.1",
			"1.2.3+build.7",
			"1.2.3-rc.1+build.7",
			"1.2.3-",
			"1.2.3-rc..1",
			"01.2.3",
			"1.02.3",
			"1.2.03",
			"1.2",
			"v1.2.3",
			"unknown",
		]) {
			const resolved = resolveBuildProvenance({
				...release,
				CCFLARE_VERSION: version,
				CCFLARE_GIT_REF: `refs/tags/v${version}`,
				CCFLARE_SOURCE_REF: `refs/tags/v${version}`,
			});
			expect(resolved).toMatchObject({
				proven: false,
				actionable: false,
				reason: "invalid_release_version",
			});
			expect(
				isTrustedDistributionProvenance(
					{ ...proven, source_ref: `refs/tags/v${version}` },
					version,
				),
			).toBe(false);
		}
	});
});

describe("readDockerBuildProvenance", () => {
	it("preserves Docker-style provenance env precedence and explicit unknowns", () => {
		expect(
			readDockerBuildProvenance({
				CCFLARE_VERSION: "9.9.9-ccflare",
				BETTER_CCFLARE_VERSION: "8.8.8-better",
				npm_package_version: "7.7.7-npm",
				CCFLARE_GIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
				CCFLARE_GIT_REF: "deploy/test",
				CCFLARE_BUILD_DATE: "2026-08-01T00:00:00Z",
			}),
		).toEqual({
			version: "9.9.9-ccflare",
			git_sha: "abcdef1234567890abcdef1234567890abcdef12",
			git_ref: "deploy/test",
			build_date: "2026-08-01T00:00:00Z",
			distribution: {
				raw: null,
				schemaVersion: null,
				identity: null,
				producer: null,
				artifactMode: null,
				updateChannel: null,
				source_sha: null,
				source_ref: null,
				proven: false,
				actionable: false,
				reason: "unknown_distribution",
			},
		});

		expect(readDockerBuildProvenance({})).toMatchObject({
			version: "unknown",
			git_sha: "unknown",
			git_ref: "unknown",
			build_date: "unknown",
			distribution: {
				proven: false,
				actionable: false,
				reason: "unknown_distribution",
			},
		});
	});
});
