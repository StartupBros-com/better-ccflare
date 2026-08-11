import { describe, expect, it } from "bun:test";
import { readDockerBuildProvenance } from "./build-provenance";
import {
	extractClaudeVersion,
	getClientVersion,
	trackClientVersion,
} from "./version";

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
		});

		expect(readDockerBuildProvenance({})).toEqual({
			version: "unknown",
			git_sha: "unknown",
			git_ref: "unknown",
			build_date: "unknown",
		});
	});
});
