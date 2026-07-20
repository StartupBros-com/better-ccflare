/**
 * Version utility that works in both development and production environments
 */

// Claude CLI version to use in user-agent headers
export const CLAUDE_CLI_VERSION = "2.1.215";

// Build-time injected version via --define __BETTER_CCFLARE_VERSION__="x.y.z"
// Replaced by bun bundler with a string literal; undefined at dev/runtime.
declare const __BETTER_CCFLARE_VERSION__: string | undefined;

// Build-time injected git short SHA via --define __BETTER_CCFLARE_GIT_SHA__="abc1234"
// Replaced by bun bundler with a string literal; undefined at dev/runtime.
declare const __BETTER_CCFLARE_GIT_SHA__: string | undefined;

// Cache the version to avoid repeated file reads
let cachedVersion: string | null = null;

// Cache the git SHA (undefined = not yet resolved, null = resolved-but-unknown)
let cachedGitSha: string | null | undefined;

export async function getVersion(): Promise<string> {
	if (cachedVersion) {
		return cachedVersion;
	}

	// 1. Build-time injected version (reliable for compiled binaries)
	if (
		typeof __BETTER_CCFLARE_VERSION__ !== "undefined" &&
		__BETTER_CCFLARE_VERSION__
	) {
		cachedVersion = __BETTER_CCFLARE_VERSION__;
		return cachedVersion;
	}

	// 2. Runtime env var fallback (dev/test environments)
	if (process.env.BETTER_CCFLARE_VERSION) {
		cachedVersion = process.env.BETTER_CCFLARE_VERSION;
		return cachedVersion;
	}

	if (process.env.npm_package_version) {
		cachedVersion = process.env.npm_package_version;
		return cachedVersion;
	}

	// 3. Try reading from apps/cli/package.json (dev environment)
	try {
		const packageJsonPath = new URL(
			"../../../apps/cli/package.json",
			import.meta.url,
		);
		const packageJson = await fetch(packageJsonPath);
		const pkg = (await packageJson.json()) as { version?: string };
		if (pkg.version) {
			cachedVersion = pkg.version;
			return cachedVersion;
		}
	} catch {
		// Continue to fallback
	}

	// 4. Final fallback
	cachedVersion = CLAUDE_CLI_VERSION;
	return cachedVersion;
}

// Synchronous version for contexts where async is not available
export function getVersionSync(): string {
	if (cachedVersion) {
		return cachedVersion;
	}

	// 1. Build-time injected version (reliable for compiled binaries)
	if (
		typeof __BETTER_CCFLARE_VERSION__ !== "undefined" &&
		__BETTER_CCFLARE_VERSION__
	) {
		cachedVersion = __BETTER_CCFLARE_VERSION__;
		return cachedVersion;
	}

	// 2. Runtime env var fallback
	if (process.env.BETTER_CCFLARE_VERSION) {
		cachedVersion = process.env.BETTER_CCFLARE_VERSION;
		return cachedVersion;
	}

	if (process.env.npm_package_version) {
		cachedVersion = process.env.npm_package_version;
		return cachedVersion;
	}

	cachedVersion = CLAUDE_CLI_VERSION;
	return cachedVersion;
}

/**
 * Get the git short SHA the running binary was built from.
 *
 * Mirrors getVersionSync(): a compiled binary has the SHA burned in at
 * build time via --define; dev/test environments fall back to an env var.
 * Unlike the version, there is no static default — an unknown SHA means
 * the deploy provenance can't be verified, so callers must handle null.
 *
 * @returns The build-time injected SHA, the BETTER_CCFLARE_GIT_SHA env var, or null if unknown.
 */
export function getGitSha(): string | null {
	if (cachedGitSha !== undefined) {
		return cachedGitSha;
	}

	// 1. Build-time injected SHA (reliable for compiled binaries)
	if (
		typeof __BETTER_CCFLARE_GIT_SHA__ !== "undefined" &&
		__BETTER_CCFLARE_GIT_SHA__ &&
		__BETTER_CCFLARE_GIT_SHA__ !== "unknown"
	) {
		cachedGitSha = __BETTER_CCFLARE_GIT_SHA__;
		return cachedGitSha;
	}

	// 2. Runtime env var fallback (dev/test environments)
	if (process.env.BETTER_CCFLARE_GIT_SHA) {
		cachedGitSha = process.env.BETTER_CCFLARE_GIT_SHA;
		return cachedGitSha;
	}

	cachedGitSha = null;
	return cachedGitSha;
}

/**
 * Extract Claude CLI version from a user-agent header
 * @param userAgent - The user-agent string to parse
 * @returns The extracted version string, or null if not found
 * @example
 * extractClaudeVersion("claude-cli/2.0.60 (external, cli)") // returns "2.0.60"
 * extractClaudeVersion("Mozilla/5.0...") // returns null
 */
export function extractClaudeVersion(userAgent: string | null): string | null {
	if (!userAgent) {
		return null;
	}

	// Match claude-cli/X.Y.Z pattern (handles semver with optional prerelease/build metadata)
	const match = userAgent.match(
		/claude-cli\/(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)/i,
	);
	return match ? match[1] : null;
}

// Track the most recent Claude CLI version seen from client requests
// This allows auto-refresh to use newer client versions even after app restart
let lastSeenClientVersion: string | null = null;

/**
 * Update the tracked client version from an incoming request
 * @param userAgent - The user-agent header from the client request
 */
export function trackClientVersion(userAgent: string | null): void {
	const version = extractClaudeVersion(userAgent);
	if (version) {
		lastSeenClientVersion = version;
	}
}

/**
 * Get the most recently seen client version, or fall back to the application version
 * @returns The client version if available, otherwise CLAUDE_CLI_VERSION
 */
export function getClientVersion(): string {
	return lastSeenClientVersion || CLAUDE_CLI_VERSION;
}
