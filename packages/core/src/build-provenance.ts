import { getGitSha, getVersionSync } from "./version";

// Defined only in release/package builds. `typeof` keeps source execution safe.
declare const __CCFLARE_BUILD_PROVENANCE_VERSION__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_DISTRIBUTION__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_PRODUCER__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_ARTIFACT_MODE__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_UPDATE_CHANNEL__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_GIT_SHA__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_GIT_REF__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_SOURCE_SHA__: string | undefined;
declare const __CCFLARE_BUILD_PROVENANCE_SOURCE_REF__: string | undefined;

function embeddedString(value: string | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const EMBEDDED_BUILD_PROVENANCE = Object.freeze({
	CCFLARE_VERSION: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_VERSION__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_VERSION__,
	),
	CCFLARE_DISTRIBUTION: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_DISTRIBUTION__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_DISTRIBUTION__,
	),
	CCFLARE_PRODUCER: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_PRODUCER__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_PRODUCER__,
	),
	CCFLARE_ARTIFACT_MODE: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_ARTIFACT_MODE__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_ARTIFACT_MODE__,
	),
	CCFLARE_UPDATE_CHANNEL: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_UPDATE_CHANNEL__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_UPDATE_CHANNEL__,
	),
	CCFLARE_GIT_SHA: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_GIT_SHA__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_GIT_SHA__,
	),
	CCFLARE_GIT_REF: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_GIT_REF__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_GIT_REF__,
	),
	CCFLARE_SOURCE_SHA: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_SOURCE_SHA__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_SOURCE_SHA__,
	),
	CCFLARE_SOURCE_REF: embeddedString(
		typeof __CCFLARE_BUILD_PROVENANCE_SOURCE_REF__ === "undefined"
			? undefined
			: __CCFLARE_BUILD_PROVENANCE_SOURCE_REF__,
	),
});

function hasRuntimeDistribution(env: Env): boolean {
	return env.CCFLARE_DISTRIBUTION !== undefined;
}

function hasEmbeddedDistribution(): boolean {
	return EMBEDDED_BUILD_PROVENANCE.CCFLARE_DISTRIBUTION !== undefined;
}

function runtimeOrEmbedded(
	env: Env,
	key: keyof typeof EMBEDDED_BUILD_PROVENANCE,
): string | undefined {
	// An explicit runtime identity is a complete replacement. Otherwise, an
	// embedded identity binds its entire tuple so mutable process fields cannot
	// forge a hybrid release identity.
	if (hasRuntimeDistribution(env)) return env[key];
	if (hasEmbeddedDistribution()) return EMBEDDED_BUILD_PROVENANCE[key];
	return env[key];
}

function provenanceVersion(env: Env): string {
	// A runtime distribution must carry its own version, and an embedded release
	// tuple must use its embedded version. Neither may blend mutable fields into
	// the other; source builds retain their established runtime fallback chain.
	if (hasRuntimeDistribution(env)) return env.CCFLARE_VERSION ?? "unknown";
	if (hasEmbeddedDistribution()) {
		return EMBEDDED_BUILD_PROVENANCE.CCFLARE_VERSION ?? "unknown";
	}
	return (
		env.CCFLARE_VERSION ??
		env.BETTER_CCFLARE_VERSION ??
		env.npm_package_version ??
		"unknown"
	);
}

export type DistributionProducer = "startupbros" | "tombii";
export type DistributionArtifactMode =
	| "managed-source"
	| "docker"
	| "package"
	| "binary";
export type TrustedUpdateChannel = "ghcr" | "npm" | "github-releases";

export interface DistributionIdentity {
	readonly schemaVersion: "v1";
	readonly token: string;
	readonly producer: DistributionProducer;
	readonly artifactMode: DistributionArtifactMode;
	readonly updateChannel: TrustedUpdateChannel | null;
	readonly actionable: boolean;
}

const DISTRIBUTION_CATALOGUE = Object.freeze({
	"v1:startupbros-managed-source": {
		schemaVersion: "v1",
		token: "v1:startupbros-managed-source",
		producer: "startupbros",
		artifactMode: "managed-source",
		updateChannel: null,
		actionable: false,
	},
	"v1:tombii-ghcr-docker": {
		schemaVersion: "v1",
		token: "v1:tombii-ghcr-docker",
		producer: "tombii",
		artifactMode: "docker",
		updateChannel: "ghcr",
		actionable: true,
	},
	"v1:tombii-npm-package": {
		schemaVersion: "v1",
		token: "v1:tombii-npm-package",
		producer: "tombii",
		artifactMode: "package",
		updateChannel: "npm",
		actionable: true,
	},
	"v1:tombii-github-release-binary": {
		schemaVersion: "v1",
		token: "v1:tombii-github-release-binary",
		producer: "tombii",
		artifactMode: "binary",
		updateChannel: "github-releases",
		actionable: true,
	},
	"v1:startupbros-docker-image": {
		schemaVersion: "v1",
		token: "v1:startupbros-docker-image",
		producer: "startupbros",
		artifactMode: "docker",
		updateChannel: null,
		actionable: false,
	},
} as const satisfies Record<string, DistributionIdentity>);

export type DistributionToken = keyof typeof DISTRIBUTION_CATALOGUE;

export interface DockerBuildProvenance {
	readonly version: string;
	readonly git_sha: string;
	readonly git_ref: string;
	readonly build_date: string;
	readonly distribution: ResolvedDistributionProvenance;
}

export interface ResolvedDistributionProvenance {
	readonly raw: string | null;
	readonly schemaVersion: "v1" | null;
	readonly identity: DistributionToken | null;
	readonly producer: DistributionProducer | null;
	readonly artifactMode: DistributionArtifactMode | null;
	readonly updateChannel: TrustedUpdateChannel | null;
	readonly source_sha: string | null;
	readonly source_ref: string | null;
	readonly proven: boolean;
	readonly actionable: boolean;
	readonly reason: string;
}

export type ResolvedBuildProvenance = Omit<DockerBuildProvenance, "git_sha"> & {
	readonly git_sha: string | null;
};

type Env = Readonly<Record<string, string | undefined>>;

const FULL_LOWERCASE_SHA = /^[0-9a-f]{40}$/;
const STABLE_RELEASE_VERSION =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** Exact matching only: no trim, case fold, partial match, or tuple parsing. */
export function parseDistributionIdentity(
	raw: string | undefined,
): DistributionIdentity | null {
	if (typeof raw !== "string") return null;
	return DISTRIBUTION_CATALOGUE[raw as DistributionToken] ?? null;
}

function rawOrUnknown(value: string | undefined): string {
	return value ?? "unknown";
}

function sourceRefFor(identity: DistributionIdentity, version: string): string {
	return identity.producer === "startupbros"
		? "refs/heads/main"
		: `refs/tags/v${version}`;
}

/**
 * Defense-in-depth validation for consumers that receive an already-resolved
 * facade. A status service must not turn a forged test/integration facade into
 * a network lookup merely because it claims `proven: true`.
 */
export function isTrustedDistributionProvenance(
	provenance: ResolvedDistributionProvenance,
	version: string,
): boolean {
	const identity = parseDistributionIdentity(provenance.raw ?? undefined);
	return (
		identity !== null &&
		(!identity.actionable || STABLE_RELEASE_VERSION.test(version)) &&
		provenance.proven === true &&
		provenance.identity === identity.token &&
		provenance.schemaVersion === identity.schemaVersion &&
		provenance.producer === identity.producer &&
		provenance.artifactMode === identity.artifactMode &&
		provenance.updateChannel === identity.updateChannel &&
		provenance.actionable === identity.actionable &&
		provenance.reason ===
			(identity.actionable ? "proven_actionable" : "proven_non_actionable") &&
		typeof provenance.source_sha === "string" &&
		FULL_LOWERCASE_SHA.test(provenance.source_sha) &&
		provenance.source_ref === sourceRefFor(identity, version)
	);
}

function invalid(
	raw: string | undefined,
	reason: string,
	identity: DistributionIdentity | null = null,
): ResolvedDistributionProvenance {
	return {
		raw: raw ?? null,
		schemaVersion: identity?.schemaVersion ?? null,
		identity: (identity?.token as DistributionToken | undefined) ?? null,
		producer: identity?.producer ?? null,
		artifactMode: identity?.artifactMode ?? null,
		updateChannel: null,
		source_sha: null,
		source_ref: null,
		proven: false,
		actionable: false,
		reason,
	};
}

/**
 * Resolve build identity from immutable build metadata only. This deliberately
 * never inspects a package manager, executable path, current directory, repo,
 * user agent, or mutable filesystem state.
 */
export function resolveBuildProvenance(
	env: Env = process.env,
): ResolvedDistributionProvenance {
	const raw = runtimeOrEmbedded(env, "CCFLARE_DISTRIBUTION");
	const identity = parseDistributionIdentity(raw);
	if (!identity) return invalid(raw, "unknown_distribution");

	const version = provenanceVersion(env);
	const sourceSha = runtimeOrEmbedded(env, "CCFLARE_GIT_SHA");
	const sourceRef = runtimeOrEmbedded(env, "CCFLARE_GIT_REF");
	const sourceEvidenceSha = runtimeOrEmbedded(env, "CCFLARE_SOURCE_SHA");
	const sourceEvidenceRef = runtimeOrEmbedded(env, "CCFLARE_SOURCE_REF");
	const producer = runtimeOrEmbedded(env, "CCFLARE_PRODUCER");
	const artifactMode = runtimeOrEmbedded(env, "CCFLARE_ARTIFACT_MODE");
	const updateChannel = runtimeOrEmbedded(env, "CCFLARE_UPDATE_CHANNEL");
	if (sourceSha === undefined)
		return invalid(raw, "missing_source_sha", identity);
	if (!FULL_LOWERCASE_SHA.test(sourceSha)) {
		return invalid(raw, "invalid_source_sha", identity);
	}
	if (sourceRef === undefined)
		return invalid(raw, "missing_source_ref", identity);
	if (identity.producer === "tombii" && !STABLE_RELEASE_VERSION.test(version)) {
		return invalid(raw, "invalid_release_version", identity);
	}
	if (sourceEvidenceSha === undefined) {
		return invalid(raw, "missing_redundant_source_sha", identity);
	}
	if (sourceEvidenceSha !== sourceSha) {
		return invalid(raw, "conflicting_source_sha", identity);
	}
	if (sourceEvidenceRef === undefined) {
		return invalid(raw, "missing_redundant_source_ref", identity);
	}
	if (sourceEvidenceRef !== sourceRef) {
		return invalid(raw, "conflicting_source_ref", identity);
	}
	if (producer === undefined) return invalid(raw, "missing_producer", identity);
	if (producer !== identity.producer) {
		return invalid(raw, "conflicting_producer", identity);
	}
	if (artifactMode === undefined) {
		return invalid(raw, "missing_artifact_mode", identity);
	}
	if (artifactMode !== identity.artifactMode) {
		return invalid(raw, "conflicting_artifact_mode", identity);
	}
	if (identity.updateChannel === null) {
		if (updateChannel !== undefined) {
			return invalid(raw, "unexpected_update_channel", identity);
		}
	} else {
		if (updateChannel === undefined) {
			return invalid(raw, "missing_update_channel", identity);
		}
		if (updateChannel !== identity.updateChannel) {
			return invalid(raw, "conflicting_update_channel", identity);
		}
	}
	if (sourceRef !== sourceRefFor(identity, version)) {
		return invalid(raw, "incompatible_source_ref", identity);
	}

	return {
		raw: raw ?? null,
		schemaVersion: identity.schemaVersion,
		identity: identity.token as DistributionToken,
		producer: identity.producer,
		artifactMode: identity.artifactMode,
		updateChannel: identity.updateChannel,
		source_sha: sourceSha,
		source_ref: sourceRef,
		proven: true,
		actionable: identity.actionable,
		reason: identity.actionable ? "proven_actionable" : "proven_non_actionable",
	};
}

export function readDockerBuildProvenance(
	env: Env = process.env,
): DockerBuildProvenance {
	const version = provenanceVersion(env);
	return {
		version,
		git_sha: rawOrUnknown(runtimeOrEmbedded(env, "CCFLARE_GIT_SHA")),
		git_ref: rawOrUnknown(runtimeOrEmbedded(env, "CCFLARE_GIT_REF")),
		build_date: rawOrUnknown(env.CCFLARE_BUILD_DATE),
		distribution: resolveBuildProvenance(env),
	};
}

export function readBuildProvenance(
	env: Env = process.env,
): ResolvedBuildProvenance {
	const docker = readDockerBuildProvenance(env);
	return {
		...docker,
		version: getVersionSync(),
		git_sha: docker.distribution.source_sha ?? getGitSha(),
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
