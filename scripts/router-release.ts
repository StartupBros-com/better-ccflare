import {
	GitHub,
	Manifest,
	registerReleaseType,
	setLogger,
} from "release-please";
import type { ConventionalCommit } from "release-please/build/src/commit";
import type { Scm, ScmRelease } from "release-please/build/src/scm";
import type { BuildUpdatesOptions } from "release-please/build/src/strategies/base";

// Finish the public entry point before traversing its circular internal strategies.
const { Node } = await import("release-please/build/src/strategies/node");

import ts from "typescript";

// Both CLI entry points reserve stdout for their machine-readable result.
setLogger({
	error: console.error,
	warn: console.error,
	info: console.error,
	debug: console.error,
	trace: console.error,
});

export const ROUTER_REPOSITORY = "StartupBros/wstack-router";
const aliases: Record<string, string> = {
	feature: "feat",
	add: "feat",
	new: "feat",
	bug: "fix",
	resolve: "fix",
	security: "security",
	vulnerabilit: "security",
	redact: "security",
	redos: "security",
	improve: "refactor",
	enhance: "refactor",
	update: "refactor",
};

/** Only adapt legacy vocabulary and Bun serialization; the engine owns releases. */
class RouterNode extends Node {
	protected async postProcessCommits(commits: ConventionalCommit[]) {
		return commits.map((commit) => ({
			...commit,
			type: aliases[commit.type.toLowerCase()] ?? commit.type,
		}));
	}
	protected async buildUpdates(options: BuildUpdatesOptions) {
		const updates = await super.buildUpdates(options);
		updates.push({
			path: "bun.lock",
			createIfMissing: false,
			updater: {
				updateContent(content: string | undefined) {
					if (!content) throw new Error("Missing bun.lock");
					const parsed = ts.parseConfigFileTextToJson("bun.lock", content);
					if (parsed.error) throw new Error("Invalid Bun JSONC lockfile");
					const lock = parsed.config;
					if (!lock.workspaces?.["apps/cli"]?.version)
						throw new Error("Missing Bun CLI workspace version");
					lock.workspaces["apps/cli"].version = options.newVersion.toString();
					return `${JSON.stringify(lock, null, 2)}\n`;
				},
			},
		});
		return updates;
	}
}
registerReleaseType("router-node", (options) => new RouterNode(options));

export function createRouterManifest(scm: Scm) {
	if (`${scm.repository.owner}/${scm.repository.repo}` !== ROUTER_REPOSITORY)
		throw new Error("Wrong release repository");
	return Manifest.fromManifest(scm, "main");
}

export interface SourceIdentity {
	repository: string;
	sha: string;
}
export interface DraftIdentity extends SourceIdentity {
	version: string;
	ref: string;
}
export interface ReleaseTransport {
	scm: Scm;
	getHeadSha(): Promise<string>;
	isAncestor(sourceSha: string, mainSha: string): Promise<boolean>;
	checkFoundation(sha: string): Promise<boolean>;
	getTagSha(tag: string): Promise<string | undefined>;
	getRelease(tag: string): Promise<ScmRelease | undefined>;
}
async function assertSource(
	transport: ReleaseTransport,
	expected: SourceIdentity,
	allowAncestor = false,
) {
	if (
		expected.repository !== ROUTER_REPOSITORY ||
		`${transport.scm.repository.owner}/${transport.scm.repository.repo}` !==
			expected.repository
	)
		throw new Error("Wrong release repository");
	if (!/^[a-f0-9]{40}$/.test(expected.sha))
		throw new Error("Stale or invalid source SHA");
	const mainSha = await transport.getHeadSha();
	if (
		mainSha !== expected.sha &&
		(!allowAncestor || !(await transport.isAncestor(expected.sha, mainSha)))
	)
		throw new Error("Stale or non-ancestor source SHA");
	if (!(await transport.checkFoundation(expected.sha)))
		throw new Error("Foundation CI has not succeeded for exact source SHA");
}

async function releaseCandidatesAtSource(
	scm: Scm,
	manifest: Manifest,
	sha: string,
) {
	const pending = (await manifest.buildReleases()).filter(
		(candidate) => candidate.sha === sha,
	);
	if (pending.length) return pending;
	// A verified draft is tagged, so the next release PR is not blocked by the engine.
	// Read that same engine label on reruns without repeating release creation.
	const tagged = await Manifest.fromManifest(
		scm,
		"main",
		undefined,
		undefined,
		{ labels: ["autorelease: tagged"] },
	);
	return (await tagged.buildReleases()).filter(
		(candidate) => candidate.sha === sha,
	);
}

/** Read-only engine candidates, before any remote mutation. */
export async function buildCandidates(
	transport: ReleaseTransport,
	expected: SourceIdentity,
) {
	await assertSource(transport, expected);
	const manifest = await createRouterManifest(transport.scm);
	const pullRequests = await manifest.buildPullRequests();
	// Pending merged releases keep their immutable source even as main advances.
	// Tagged history is only consulted by an explicit draft retry, never enumerated.
	const releases = await manifest.buildReleases();
	for (const release of releases)
		await assertSource(
			transport,
			{ repository: expected.repository, sha: release.sha },
			true,
		);
	await assertSource(transport, expected);
	return { manifest, pullRequests, releases };
}

export async function reconcilePullRequests(
	transport: ReleaseTransport,
	expected: SourceIdentity,
) {
	const { manifest, pullRequests } = await buildCandidates(transport, expected);
	// Reuse precisely the candidates that were checked, retaining the engine's PR reconciliation.
	manifest.buildPullRequests = async () => pullRequests;
	await assertSource(transport, expected);
	return manifest.createPullRequests();
}

export const reconcileDraft = (
	transport: ReleaseTransport,
	expected: DraftIdentity,
) => draftFlow(transport, expected, true);

/** Read-only revalidation for build/stage runs: never creates tags/releases or edits labels. */
export const validateDraft = (
	transport: ReleaseTransport,
	expected: DraftIdentity,
) => draftFlow(transport, expected, false);

async function draftFlow(
	transport: ReleaseTransport,
	expected: DraftIdentity,
	write: boolean,
) {
	if (
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected.version) ||
		expected.ref !== `refs/tags/v${expected.version}`
	)
		throw new Error("Expected stable version and exact tag ref");
	await assertSource(transport, expected, true);
	const manifest = await createRouterManifest(transport.scm);
	const candidates = await releaseCandidatesAtSource(
		transport.scm,
		manifest,
		expected.sha,
	);
	if (candidates.length !== 1)
		throw new Error(
			"Expected one merged engine release PR at exact source SHA",
		);
	const candidate = candidates[0];
	const tag = `v${expected.version}`;
	if (
		candidate.tag.toString() !== tag ||
		candidate.pullRequest.sha !== expected.sha ||
		candidate.pullRequest.baseBranchName !== "main" ||
		!candidate.pullRequest.labels.some((label) =>
			["autorelease: pending", "autorelease: tagged"].includes(label),
		) ||
		candidate.draft !== true ||
		candidate.forceTag !== true ||
		candidate.prerelease
	)
		throw new Error("Release candidate identity or draft policy mismatch");
	// Versioned source files are independent of the release PR title/body.
	const versions = await Promise.all(
		[
			"package.json",
			"apps/cli/package.json",
			".release-please-manifest.json",
		].map((path) =>
			transport.scm.getFileJson<Record<string, string>>(path, expected.sha),
		),
	);
	const lock = await transport.scm.getFileContentsOnBranch(
		"bun.lock",
		expected.sha,
	);
	const lockData = ts.parseConfigFileTextToJson("bun.lock", lock.parsedContent);
	if (
		versions[0].version !== expected.version ||
		versions[1].version !== expected.version ||
		versions[2]["."] !== expected.version ||
		lockData.error ||
		lockData.config.workspaces?.["apps/cli"]?.version !== expected.version
	)
		throw new Error("Source versions disagree with candidate");
	const existingTag = await transport.getTagSha(tag);
	if (existingTag && existingTag !== expected.sha)
		throw new Error(`Conflicting tag ${tag}`);
	let release = await transport.getRelease(tag);
	if (
		release &&
		(!release.draft ||
			release.tagName !== tag ||
			release.sha !== expected.sha ||
			existingTag !== expected.sha)
	)
		throw new Error(`Published or mismatched release ${release.id}`);
	await assertSource(transport, expected, true);
	if (!release && !write) throw new Error(`Missing draft release ${tag}`);
	if (!release)
		release = await transport.scm.createRelease(candidate, {
			draft: true,
			forceTag: true,
			prerelease: false,
		});
	// Verify the effect rather than treating an API response as proof of the tag.
	const verified = await transport.getRelease(tag);
	if (
		!verified ||
		verified.id !== release.id ||
		!verified.draft ||
		verified.tagName !== tag ||
		verified.sha !== expected.sha ||
		(await transport.getTagSha(tag)) !== expected.sha
	)
		throw new Error("Draft/tag verification failed");
	if (write && !candidate.pullRequest.labels.includes("autorelease: tagged"))
		await transport.scm.addIssueLabels(
			["autorelease: tagged"],
			candidate.pullRequest.number,
		);
	if (write && candidate.pullRequest.labels.includes("autorelease: pending"))
		await transport.scm.removeIssueLabels(
			["autorelease: pending"],
			candidate.pullRequest.number,
		);
	return {
		...expected,
		releaseId: verified.id,
		tag,
		pullRequest: candidate.pullRequest.number,
	};
}

/** Production transport. Tests use fixtures, not authenticated GitHub acceptance probes. */
export async function githubTransport(
	token: string,
): Promise<ReleaseTransport> {
	const owner = "StartupBros";
	const repo = "wstack-router";
	const scm = await GitHub.create({
		owner,
		repo,
		token,
		defaultBranch: "main",
	});
	async function read<T>(
		path: string,
		optional = false,
	): Promise<T | undefined> {
		const response = await fetch(
			`https://api.github.com/repos/${ROUTER_REPOSITORY}/${path}`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (optional && response.status === 404) return undefined;
		if (!response.ok)
			throw new Error(`GitHub read ${path}: HTTP ${response.status}`);
		return response.json() as Promise<T>;
	}
	async function need<T>(path: string): Promise<T> {
		const value = await read<T>(path);
		if (value === undefined) throw new Error(`GitHub read ${path}: empty`);
		return value;
	}
	return {
		scm,
		getHeadSha: async () =>
			(await need<{ object: { sha: string } }>("git/ref/heads/main")).object
				.sha,
		isAncestor: async (sourceSha, mainSha) => {
			// GitHub compares BASE...HEAD: main must be ahead of (or identical to) source.
			const comparison = await need<{
				status: string;
				base_commit: { sha: string };
				merge_base_commit: { sha: string };
			}>(`compare/${sourceSha}...${mainSha}`);
			return (
				["ahead", "identical"].includes(comparison.status) &&
				comparison.base_commit.sha === sourceSha &&
				comparison.merge_base_commit.sha === sourceSha
			);
		},
		checkFoundation: async (sha) => {
			const data = await need<{
				workflow_runs: {
					head_sha: string;
					head_branch: string;
					event: string;
					conclusion: string;
					status: string;
					path: string;
					repository: { full_name: string };
				}[];
			}>(
				`actions/workflows/managed-routing-postgres.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
			);
			return data.workflow_runs.some(
				(run) =>
					run.head_sha === sha &&
					run.head_branch === "main" &&
					run.event === "push" &&
					run.status === "completed" &&
					run.conclusion === "success" &&
					run.path === ".github/workflows/managed-routing-postgres.yml" &&
					run.repository.full_name === ROUTER_REPOSITORY,
			);
		},
		getTagSha: async (tag) => {
			let object = (
				await read<{ object: { type: string; sha: string } }>(
					`git/ref/tags/${tag}`,
					true,
				)
			)?.object;
			while (object?.type === "tag")
				object = (
					await need<{ object: { type: string; sha: string } }>(
						`git/tags/${object.sha}`,
					)
				).object;
			if (object && object.type !== "commit")
				throw new Error("Tag does not resolve to a commit");
			return object?.sha;
		},
		getRelease: async (tag) => {
			// The by-tag endpoint does not reliably return drafts. Authenticated listing does.
			for (let page = 1; ; page++) {
				const releases = await need<
					{
						id: number;
						tag_name: string;
						target_commitish: string;
						draft: boolean;
						html_url: string;
					}[]
				>(`releases?per_page=100&page=${page}`);
				const release = releases.find((item) => item.tag_name === tag);
				if (release)
					return {
						id: release.id,
						tagName: release.tag_name,
						sha: release.target_commitish,
						draft: release.draft,
						url: release.html_url,
					};
				if (releases.length < 100) return undefined;
			}
		},
	};
}

if (import.meta.main) {
	const [command, repository, sha, version, ref] = process.argv.slice(2);
	if (
		!["candidates", "reconcile-pr", "draft", "validate-draft"].includes(
			command,
		) ||
		!repository ||
		!sha ||
		(command.endsWith("draft") && (!version || !ref))
	)
		throw new Error(
			"Usage: router-release.ts candidates|reconcile-pr REPOSITORY SHA; draft|validate-draft REPOSITORY SHA VERSION REF",
		);
	const token = process.env.GITHUB_TOKEN;
	if (!token)
		throw new Error(
			"GITHUB_TOKEN required; supply a token with permissions for the requested release operation",
		);
	const transport = await githubTransport(token);
	const expected = { repository, sha };
	const output =
		command === "draft"
			? await reconcileDraft(transport, { ...expected, version, ref })
			: command === "validate-draft"
				? await validateDraft(transport, { ...expected, version, ref })
				: command === "reconcile-pr"
					? await reconcilePullRequests(transport, expected)
					: await buildCandidates(transport, expected).then(
							({ pullRequests, releases }) => ({
								pullRequests: pullRequests.map((pr) => ({
									title: pr.title.toString(),
									version: pr.version?.toString(),
								})),
								releases: releases.map((release) => ({
									version: release.tag.version.toString(),
									sha: release.sha,
									ref: `refs/tags/${release.tag}`,
								})),
							}),
						);
	console.log(JSON.stringify(output));
}
