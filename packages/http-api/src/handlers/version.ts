import {
	getVersionSync,
	isTrustedDistributionProvenance,
	type ResolvedDistributionProvenance,
	resolveBuildProvenance,
	type TrustedUpdateChannel,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { jsonResponse } from "../utils/http-error";

const log = new Logger("VersionHandler");
const CACHE_DURATION_MS = 60 * 60 * 1000;

export interface UpdateAction {
	readonly kind: "command" | "url";
	readonly value: string;
}

export interface UpdateStatusResult {
	readonly provenance: ResolvedDistributionProvenance;
	readonly currentVersion: string;
	readonly availability: "current" | "available" | "unavailable";
	readonly latestVersion: string | null;
	readonly action: UpdateAction | null;
	readonly cache: "hit" | "miss" | "not-applicable";
	readonly reason: string;
}

export type UpdateAdapter = () => Promise<string>;
export type UpdateAdapters = Partial<
	Record<TrustedUpdateChannel, UpdateAdapter>
>;

export interface UpdateStatusOptions {
	readonly readProvenance?: () => ResolvedDistributionProvenance;
	readonly currentVersion?: () => string;
	readonly adapters?: UpdateAdapters;
	readonly now?: () => number;
}

interface VersionCacheEntry {
	readonly version: string;
	readonly timestamp: number;
}

const actions: Record<TrustedUpdateChannel, UpdateAction> = {
	ghcr: {
		kind: "command",
		value: "docker pull ghcr.io/tombii/better-ccflare:latest",
	},
	npm: { kind: "command", value: "npm install -g better-ccflare@latest" },
	"github-releases": {
		kind: "url",
		value: "https://github.com/tombii/better-ccflare/releases/latest",
	},
};

const STABLE_UPDATE_VERSION =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function parseVersion(value: string): bigint[] | null {
	const match = value.match(
		/^v?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/,
	);
	return match ? match.slice(1, 4).map(BigInt) : null;
}

function isNewer(latest: string, current: string): boolean {
	const latestParts = parseVersion(latest);
	const currentParts = parseVersion(current);
	if (!latestParts || !currentParts) return false;

	for (let index = 0; index < latestParts.length; index += 1) {
		if (latestParts[index] !== currentParts[index]) {
			return latestParts[index] > currentParts[index];
		}
	}
	return false;
}

async function fetchNpmLatest(): Promise<string> {
	const response = await fetch(
		"https://registry.npmjs.org/better-ccflare/latest",
	);
	if (!response.ok)
		throw new Error(`npm registry returned status ${response.status}`);
	const data = (await response.json()) as { version?: unknown };
	if (typeof data.version !== "string")
		throw new Error("npm registry returned no version");
	return data.version;
}

const GHCR_TOKEN_URL =
	"https://ghcr.io/token?service=ghcr.io&scope=repository%3Atombii%2Fbetter-ccflare%3Apull";
const GHCR_TAGS_URL = "https://ghcr.io/v2/tombii/better-ccflare/tags/list";
const GHCR_MAX_TAG_PAGES = 100;
const GHCR_RELEASE_TAG = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function getGhcrNextPage(linkHeader: string | null): string | null {
	if (!linkHeader) return null;

	let next: string | null = null;
	for (const entry of linkHeader.split(",")) {
		const match = entry.trim().match(/^<([^>]*)>\s*(.*)$/);
		if (!match?.[1]) {
			throw new Error("GHCR returned malformed pagination link");
		}
		const parameters = match[2].trim();
		if (
			parameters &&
			!/^;\s*[A-Za-z][A-Za-z0-9_-]*\s*=\s*(?:"[^"]*"|[^;\s]+)(?:\s*;\s*[A-Za-z][A-Za-z0-9_-]*\s*=\s*(?:"[^"]*"|[^;\s]+))*$/.test(
				parameters,
			)
		) {
			throw new Error("GHCR returned malformed pagination link");
		}
		const relation = parameters.match(
			/(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i,
		);
		if (
			!relation ||
			!(relation[1] ?? relation[2] ?? "").split(/\s+/).includes("next")
		) {
			continue;
		}
		if (next) throw new Error("GHCR returned multiple next pagination links");

		const url = new URL(match[1], GHCR_TAGS_URL);
		if (
			url.origin !== "https://ghcr.io" ||
			url.pathname !== "/v2/tombii/better-ccflare/tags/list" ||
			url.hash
		) {
			throw new Error("GHCR returned unsafe pagination link");
		}
		next = url.toString();
	}
	return next;
}

function getGhcrTags(data: unknown): string[] {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("GHCR returned malformed tags page");
	}
	const tags = (data as { tags?: unknown }).tags;
	if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
		throw new Error("GHCR returned malformed tags page");
	}
	return tags;
}

async function fetchGhcrLatest(): Promise<string> {
	const tokenResponse = await fetch(GHCR_TOKEN_URL, { redirect: "error" });
	if (!tokenResponse.ok) {
		throw new Error(
			`GHCR token endpoint returned status ${tokenResponse.status}`,
		);
	}
	const tokenData = await tokenResponse.json();
	if (!tokenData || typeof tokenData !== "object" || Array.isArray(tokenData)) {
		throw new Error("GHCR token endpoint returned malformed token");
	}
	const { token: rawToken, access_token: rawAccessToken } = tokenData as {
		access_token?: unknown;
		token?: unknown;
	};
	const token = rawToken ?? rawAccessToken;
	if (typeof token !== "string" || !/^\S+$/.test(token)) {
		throw new Error("GHCR token endpoint returned malformed token");
	}

	const versions = new Set<string>();
	const seenPages = new Set<string>();
	let pageUrl = GHCR_TAGS_URL;
	for (let page = 0; page < GHCR_MAX_TAG_PAGES; page += 1) {
		if (seenPages.has(pageUrl)) {
			throw new Error("GHCR pagination cycle detected");
		}
		seenPages.add(pageUrl);

		const response = await fetch(pageUrl, {
			redirect: "error",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok)
			throw new Error(`GHCR returned status ${response.status}`);
		for (const tag of getGhcrTags(await response.json())) {
			if (GHCR_RELEASE_TAG.test(tag)) versions.add(tag);
		}

		const next = getGhcrNextPage(response.headers.get("Link"));
		if (!next) break;
		if (seenPages.has(next)) throw new Error("GHCR pagination cycle detected");
		if (page === GHCR_MAX_TAG_PAGES - 1) {
			throw new Error("GHCR pagination page limit exceeded");
		}
		pageUrl = next;
	}

	let latest: string | null = null;
	for (const version of versions) {
		if (!latest || isNewer(version, latest)) latest = version;
	}
	if (!latest) throw new Error("GHCR returned no release tags");
	return latest.replace(/^v/, "");
}

async function fetchGithubReleaseLatest(): Promise<string> {
	const response = await fetch(
		"https://api.github.com/repos/tombii/better-ccflare/releases/latest",
	);
	if (!response.ok)
		throw new Error(`GitHub releases returned status ${response.status}`);
	const data = (await response.json()) as { tag_name?: unknown };
	if (typeof data.tag_name !== "string")
		throw new Error("GitHub releases returned no tag");
	return data.tag_name.replace(/^v/, "");
}

const fixedAdapters: Required<UpdateAdapters> = {
	npm: fetchNpmLatest,
	ghcr: fetchGhcrLatest,
	"github-releases": fetchGithubReleaseLatest,
};

/** Server-authoritative update policy: unproven provenance cannot reach an adapter. */
export function createUpdateStatusService(options: UpdateStatusOptions = {}) {
	const readProvenance = options.readProvenance ?? resolveBuildProvenance;
	const currentVersion = options.currentVersion ?? getVersionSync;
	const adapters = { ...fixedAdapters, ...options.adapters };
	const now = options.now ?? Date.now;
	const cache = new Map<string, VersionCacheEntry>();

	return {
		async check(): Promise<UpdateStatusResult> {
			const provenance = readProvenance();
			const current = currentVersion();
			if (
				!isTrustedDistributionProvenance(provenance, current) ||
				!provenance.actionable ||
				!provenance.producer ||
				!provenance.updateChannel
			) {
				return {
					provenance,
					currentVersion: current,
					availability: "unavailable",
					latestVersion: null,
					action: null,
					cache: "not-applicable",
					reason: provenance.reason,
				};
			}

			const cohort = `${provenance.producer}:${provenance.updateChannel}`;
			let latest: string;
			let cacheState: "hit" | "miss" = "miss";
			const cached = cache.get(cohort);
			try {
				if (cached && now() - cached.timestamp < CACHE_DURATION_MS) {
					latest = cached.version;
					cacheState = "hit";
				} else {
					const adapter = adapters[provenance.updateChannel];
					if (!adapter)
						throw new Error(
							`No trusted adapter for ${provenance.updateChannel}`,
						);
					latest = await adapter();
					if (!STABLE_UPDATE_VERSION.test(latest)) {
						throw new Error("adapter returned non-stable version");
					}
					cache.set(cohort, { version: latest, timestamp: now() });
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				log.error("Validated update lookup failed", { cohort, reason });
				return {
					provenance,
					currentVersion: current,
					availability: "unavailable",
					latestVersion: null,
					action: null,
					cache: "not-applicable",
					reason: `lookup_failed:${reason}`,
				};
			}

			return {
				provenance,
				currentVersion: current,
				availability: isNewer(latest, current) ? "available" : "current",
				latestVersion: latest,
				action: isNewer(latest, current)
					? actions[provenance.updateChannel]
					: null,
				cache: cacheState,
				reason: isNewer(latest, current) ? "update_available" : "current",
			};
		},
	};
}

export function createVersionCheckHandler(options: UpdateStatusOptions = {}) {
	const service = createUpdateStatusService(options);
	return async (): Promise<Response> => jsonResponse(await service.check());
}
