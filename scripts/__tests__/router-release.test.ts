import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitHub, Manifest } from "release-please";
import type { Scm } from "release-please/build/src/scm";
import ts from "typescript";
import {
	buildCandidates,
	createRouterManifest,
	githubTransport,
	type ReleaseTransport,
	reconcileDraft,
	reconcilePullRequests,
} from "../router-release";

const root = new URL("../../", import.meta.url);
const sha = "a".repeat(40);
const expected = {
	repository: "StartupBros/wstack-router",
	sha,
	version: "3.5.79",
	ref: "refs/tags/v3.5.79",
};
async function draftFixture() {
	const { scm, files } = fixture("fix: repair routing");
	const [pr] = await (await createRouterManifest(scm)).buildPullRequests();
	for (const update of pr.updates)
		if (files[update.path] !== undefined)
			files[update.path] = update.updater.updateContent(files[update.path]);
	let labels = ["autorelease: pending"];
	scm.addIssueLabels = async (added) => {
		labels = [...new Set([...labels, ...added])];
	};
	scm.removeIssueLabels = async (removed) => {
		labels = labels.filter((label) => !removed.includes(label));
	};
	scm.pullRequestIterator = async function* () {
		yield {
			number: 12,
			title: pr.title.toString(),
			body: pr.body.toString(),
			labels,
			headBranchName: pr.headRefName,
			baseBranchName: "main",
			sha,
			files: [],
		};
	};
	const writes: unknown[] = [];
	let tag: string | undefined;
	let draft: Awaited<ReturnType<ReleaseTransport["getRelease"]>>;
	scm.createRelease = async (release, options) => {
		writes.push({ release, options });
		tag = release.sha;
		draft = {
			id: 17,
			tagName: release.tag.toString(),
			sha: release.sha,
			draft: true,
			url: "https://github.com/StartupBros/wstack-router/releases/17",
		};
		return draft;
	};
	const transport: ReleaseTransport = {
		scm,
		getHeadSha: async () => sha,
		isAncestor: async () => false,
		checkFoundation: async () => true,
		getTagSha: async () => tag,
		getRelease: async () => draft,
	};
	return {
		transport,
		writes,
		getLabels: () => labels,
		setTag: (value: string) => {
			tag = value;
		},
		setDraft: (value: typeof draft) => {
			draft = value;
		},
	};
}

test("real engine HTTP serialization creates explicit tag before draft (transport fixture only)", async () => {
	const { transport } = await draftFixture();
	const [candidate] = await (
		await createRouterManifest(transport.scm)
	).buildReleases();
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const github = await GitHub.create({
		owner: "StartupBros",
		repo: "wstack-router",
		defaultBranch: "main",
		token: "fixture-not-a-credential",
		fetch: async (url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			requests.push({ url: String(url), body });
			if (String(url).endsWith("/git/refs"))
				return Response.json(
					{ ref: body.ref, object: { sha } },
					{ status: 201 },
				);
			if (String(url).endsWith("/releases"))
				return Response.json(
					{
						id: 17,
						tag_name: body.tag_name,
						target_commitish: sha,
						draft: body.draft,
						html_url: "https://example.test/draft",
					},
					{ status: 201 },
				);
			throw new Error(`Unexpected fixture request ${url}`);
		},
	});
	await github.createRelease(candidate, {
		draft: candidate.draft,
		forceTag: candidate.forceTag,
		prerelease: false,
	});
	expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
		"/repos/StartupBros/wstack-router/git/refs",
		"/repos/StartupBros/wstack-router/releases",
	]);
	expect(requests[0].body).toEqual({ ref: "refs/tags/v3.5.79", sha });
	expect(requests[1].body).toMatchObject({
		tag_name: "v3.5.79",
		target_commitish: sha,
		draft: true,
		prerelease: false,
	});
});

test("transport fixture: merged engine PR creates one forced-tag draft; rerun reuses it", async () => {
	const { transport, writes, getLabels } = await draftFixture();
	const first = await reconcileDraft(transport, expected);
	expect(first).toEqual({
		...expected,
		releaseId: 17,
		tag: "v3.5.79",
		pullRequest: 12,
	});
	expect(getLabels()).toEqual(["autorelease: tagged"]);
	expect(
		await (await createRouterManifest(transport.scm)).buildReleases(),
	).toEqual([]);
	expect(await reconcileDraft(transport, expected)).toEqual(first);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		options: { draft: true, forceTag: true, prerelease: false },
	});
});

test("pending A is discovered at main B; only A's CI authorizes its draft and tagged retry", async () => {
	const f = await draftFixture();
	const main = "b".repeat(40);
	f.transport.getHeadSha = async () => main;
	const ancestry: string[][] = [];
	f.transport.isAncestor = async (base, head) => {
		ancestry.push([base, head]);
		return base === sha && head === main;
	};
	const checks: string[] = [];
	f.transport.checkFoundation = async (source) => {
		checks.push(source);
		return true;
	};
	const candidates = await buildCandidates(f.transport, {
		repository: expected.repository,
		sha: main,
	});
	expect(candidates.releases.map((release) => release.sha)).toEqual([sha]);
	expect(checks).toContain(sha);
	expect(ancestry).toContainEqual([sha, main]);
	const sourceReads: string[] = [];
	const readJson = f.transport.scm.getFileJson.bind(f.transport.scm);
	f.transport.scm.getFileJson = async (path, ref) => {
		if (
			[
				"package.json",
				"apps/cli/package.json",
				".release-please-manifest.json",
			].includes(path)
		)
			sourceReads.push(ref ?? "");
		return readJson(path, ref);
	};
	const first = await reconcileDraft(f.transport, expected);
	expect(sourceReads.filter((ref) => ref === sha)).toHaveLength(3);
	expect(await reconcileDraft(f.transport, expected)).toEqual(first);
	expect(f.writes).toHaveLength(1);
	// Normal enumeration must not replay historical tagged releases.
	expect(
		(
			await buildCandidates(f.transport, {
				repository: expected.repository,
				sha: main,
			})
		).releases,
	).toEqual([]);
	await expect(reconcilePullRequests(f.transport, expected)).rejects.toThrow(
		"Stale",
	);
});

test("main B CI cannot authorize ancestor A with failed CI", async () => {
	const f = await draftFixture();
	const main = "b".repeat(40);
	f.transport.getHeadSha = async () => main;
	f.transport.isAncestor = async () => true;
	f.transport.checkFoundation = async (source) => source === main;
	await expect(reconcileDraft(f.transport, expected)).rejects.toThrow(
		"Foundation CI",
	);
	await expect(
		buildCandidates(f.transport, {
			repository: expected.repository,
			sha: main,
		}),
	).rejects.toThrow("Foundation CI");
	expect(f.writes).toEqual([]);
});

test.each([
	"non-ancestor",
	"repository",
	"version",
	"source-version",
	"lost-ancestry",
	"lost-ci",
])("ancestor draft refuses %s without remote mutation", async (failure) => {
	const f = await draftFixture();
	const main = "b".repeat(40);
	const input = { ...expected };
	f.transport.getHeadSha = async () => main;
	let ancestryChecks = 0;
	f.transport.isAncestor = async () => {
		ancestryChecks++;
		return (
			failure !== "non-ancestor" &&
			(failure !== "lost-ancestry" || ancestryChecks === 1)
		);
	};
	let ciChecks = 0;
	f.transport.checkFoundation = async () =>
		++ciChecks === 1 || failure !== "lost-ci";
	if (failure === "repository") input.repository = "other/repo";
	if (failure === "version") {
		input.version = "3.5.80";
		input.ref = "refs/tags/v3.5.80";
	}
	if (failure === "source-version") {
		const read = f.transport.scm.getFileJson.bind(f.transport.scm);
		f.transport.scm.getFileJson = async <T>(
			path: string,
			ref: string,
		): Promise<T> =>
			ref === sha && path === "package.json"
				? ({ version: "3.5.80" } as T)
				: read<T>(path, ref);
	}
	await expect(reconcileDraft(f.transport, input)).rejects.toThrow();
	expect(f.writes).toEqual([]);
	expect(f.getLabels()).toEqual(["autorelease: pending"]);
});

test("githubTransport validates compare direction and exact foundation push evidence", async () => {
	const original = globalThis.fetch;
	const main = "b".repeat(40);
	let comparison = {
		status: "ahead",
		merge_base_commit: { sha },
		base_commit: { sha },
	};
	const validRun = {
		head_sha: sha,
		head_branch: "main",
		event: "push",
		conclusion: "success",
		status: "completed",
		path: ".github/workflows/managed-routing-postgres.yml",
		repository: { full_name: expected.repository },
	};
	let runs = [validRun];
	const requests: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		requests.push(url.pathname + url.search);
		if (url.pathname.endsWith(`/compare/${sha}...${main}`))
			return Response.json(comparison);
		if (url.pathname.endsWith("/managed-routing-postgres.yml/runs")) {
			expect(url.searchParams.get("head_sha")).toBe(sha);
			expect(url.searchParams.get("event")).toBe("push");
			expect(url.searchParams.get("branch")).toBe("main");
			return Response.json({ workflow_runs: runs });
		}
		throw new Error(`Unexpected fixture request ${url}`);
	}) as typeof fetch;
	try {
		const transport = await githubTransport("fixture-not-a-credential");
		expect(await transport.isAncestor(sha, main)).toBe(true);
		for (const status of ["behind", "diverged"]) {
			comparison = { ...comparison, status };
			expect(await transport.isAncestor(sha, main)).toBe(false);
		}
		comparison = {
			status: "ahead",
			base_commit: { sha: main },
			merge_base_commit: { sha },
		};
		expect(await transport.isAncestor(sha, main)).toBe(false);
		comparison = {
			status: "ahead",
			base_commit: { sha },
			merge_base_commit: { sha: main },
		};
		expect(await transport.isAncestor(sha, main)).toBe(false);
		expect(await transport.checkFoundation(sha)).toBe(true);
		for (const patch of [
			{ head_sha: main },
			{ head_branch: "other" },
			{ event: "pull_request" },
			{ conclusion: "failure" },
			{ status: "in_progress" },
			{ path: "other.yml" },
			{ repository: { full_name: "other/repo" } },
		]) {
			runs = [{ ...validRun, ...patch }];
			expect(await transport.checkFoundation(sha)).toBe(false);
		}
		expect(requests[0]).toBe(
			`/repos/${expected.repository}/compare/${sha}...${main}`,
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("githubTransport reads draft listing and dereferences tags without writes", async () => {
	const original = globalThis.fetch;
	const requests: string[] = [];
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		expect(init?.method ?? "GET").toBe("GET");
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		requests.push(url.pathname + url.search);
		if (url.pathname.endsWith("/git/ref/heads/main"))
			return Response.json({ object: { sha } });
		if (url.pathname.endsWith("/git/ref/tags/v3.5.79"))
			return Response.json({ object: { type: "tag", sha: "c".repeat(40) } });
		if (url.pathname.endsWith(`/git/tags/${"c".repeat(40)}`))
			return Response.json({ object: { type: "commit", sha } });
		if (url.pathname.endsWith("/git/ref/tags/v0.0.0"))
			return new Response(null, { status: 404 });
		if (url.pathname.endsWith("/git/ref/tags/v1.0.0"))
			return Response.json({ object: { type: "tree", sha } });
		if (url.pathname.endsWith("/releases"))
			return Response.json(
				url.searchParams.get("page") === "1"
					? Array.from({ length: 100 }, (_, id) => ({
							id,
							tag_name: `v0.0.${id}`,
						}))
					: [
							{
								id: 17,
								tag_name: "v3.5.79",
								target_commitish: sha,
								draft: true,
								html_url: "https://example.test/draft",
							},
						],
			);
		throw new Error(`Unexpected fixture request ${url}`);
	}) as typeof fetch;
	try {
		const transport = await githubTransport("fixture-not-a-credential");
		expect(await transport.getHeadSha()).toBe(sha);
		expect(await transport.getTagSha("v3.5.79")).toBe(sha);
		expect(await transport.getTagSha("v0.0.0")).toBeUndefined();
		await expect(transport.getTagSha("v1.0.0")).rejects.toThrow("commit");
		expect(await transport.getRelease("v3.5.79")).toMatchObject({
			id: 17,
			sha,
			draft: true,
			tagName: "v3.5.79",
		});
		expect(await transport.getRelease("v9.0.0")).toBeUndefined();
		expect(requests).toContain(
			`/repos/${expected.repository}/releases?per_page=100&page=2`,
		);
	} finally {
		globalThis.fetch = original;
	}
});

test.each([
	"unmerged",
	"stale",
	"version",
	"repository",
	"ci",
	"tag",
	"published",
])("transport fixture: %s refuses before writes", async (failure) => {
	const f = await draftFixture();
	const input = { ...expected };
	if (failure === "unmerged")
		f.transport.scm.pullRequestIterator = async function* () {};
	if (failure === "stale") f.transport.getHeadSha = async () => "b".repeat(40);
	if (failure === "version") input.version = "3.5.80";
	if (failure === "repository") input.repository = "other/repo";
	if (failure === "ci") f.transport.checkFoundation = async () => false;
	if (failure === "tag") f.setTag("b".repeat(40));
	if (failure === "published") {
		f.setTag(sha);
		f.setDraft({
			id: 17,
			tagName: "v3.5.79",
			sha,
			draft: false,
			url: "fixture",
		});
	}
	await expect(reconcileDraft(f.transport, input)).rejects.toThrow();
	expect(f.writes).toEqual([]);
});
function fixture(message: string) {
	const files: Record<string, string> = Object.fromEntries(
		[
			"package.json",
			"apps/cli/package.json",
			"bun.lock",
			"release-please-config.json",
			".release-please-manifest.json",
		].map((path) => [path, readFileSync(new URL(path, root), "utf8")]),
	);
	const scm = {
		repository: {
			owner: "StartupBros",
			repo: "wstack-router",
			defaultBranch: "main",
		},
		getFileContentsOnBranch: async (path: string) => ({
			parsedContent: files[path],
			content: Buffer.from(files[path] ?? "").toString("base64"),
			sha,
		}),
		getFileJson: async (path: string) => JSON.parse(files[path]),
		async *releaseIterator() {},
		async *tagIterator() {},
		async *pullRequestIterator() {},
		async *mergeCommitIterator() {
			yield { sha, message, files: ["src/example.ts"] };
			yield {
				sha: "d981843f014e76d8d1743410010d3628bbdc3962",
				message: "feat!: excluded baseline",
				files: ["src/example.ts"],
			};
			yield {
				sha: "b".repeat(40),
				message: "feat!: excluded history",
				files: ["src/example.ts"],
			};
		},
	} as unknown as Scm;
	return { files, scm };
}

test.each([
	["fix", "3.5.79"],
	["feat", "3.6.0"],
	["feature", "3.6.0"],
	["add", "3.6.0"],
	["new", "3.6.0"],
	["bug", "3.5.79"],
	["resolve", "3.5.79"],
	["security", "3.5.79"],
	["vulnerabilit", "3.5.79"],
	["redact", "3.5.79"],
	["ReDoS", "3.5.79"],
	["improve", "3.5.79"],
	["enhance", "3.5.79"],
	["update", "3.5.79"],
	["refactor", "3.5.79"],
	["feature!", "4.0.0"],
	["chore!", "4.0.0"],
])("real engine preserves %s intent", async (prefix, version) => {
	const { scm } = fixture(`${prefix}: change behavior`);
	const prs = await (await createRouterManifest(scm)).buildPullRequests();
	expect(prs).toHaveLength(1);
	expect(prs[0].version?.toString()).toBe(version);
	expect(prs[0].body.toString()).toContain("change behavior");
	if (["security", "vulnerabilit", "redact", "ReDoS"].includes(prefix))
		expect(prs[0].body.toString()).toContain("Security");
	if (["improve", "enhance", "update", "refactor"].includes(prefix))
		expect(prs[0].body.toString()).toContain("Improvements");
});
test.each([
	"docs",
	"chore",
	"test",
	"style",
])("%s alone generates nothing", async (prefix) => {
	const { scm } = fixture(`${prefix}: implementation housekeeping`);
	const engine = await createRouterManifest(scm);
	expect(await engine.buildPullRequests()).toEqual([]);
	expect(await engine.buildReleases()).toEqual([]);
});
test("candidate updates synchronize product without changing dependency resolution", async () => {
	const { scm, files } = fixture("fix: repair routing");
	const [pr] = await (await createRouterManifest(scm)).buildPullRequests();
	const updated: Record<string, string> = {};
	for (const update of pr.updates) {
		if (files[update.path] !== undefined || update.createIfMissing)
			updated[update.path] = update.updater.updateContent(files[update.path]);
	}
	expect(JSON.parse(updated["package.json"]).version).toBe("3.5.79");
	expect(JSON.parse(updated["apps/cli/package.json"]).version).toBe("3.5.79");
	expect(JSON.parse(updated[".release-please-manifest.json"])["."]).toBe(
		"3.5.79",
	);
	const before = ts.parseConfigFileTextToJson(
		"bun.lock",
		files["bun.lock"],
	).config;
	const after = JSON.parse(updated["bun.lock"]);
	expect(after.workspaces["apps/cli"].version).toBe("3.5.79");
	before.workspaces["apps/cli"].version = "3.5.79";
	expect(after).toEqual(before);
	const directory = mkdtempSync(join(tmpdir(), "router-candidate-"));
	const paths = ["package.json", "bun.lock"];
	for (const pattern of ["apps/*/package.json", "packages/*/package.json"]) {
		for await (const path of new Bun.Glob(pattern).scan({ cwd: root.pathname }))
			paths.push(path);
	}
	for (const path of paths) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(
			join(directory, path),
			updated[path] ?? readFileSync(new URL(path, root), "utf8"),
		);
	}
	const result = Bun.spawnSync(
		[process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
		{ cwd: directory, env: process.env },
	);
	expect(result.stderr.toString()).not.toContain("lockfile had changes");
	expect(result.exitCode).toBe(0);
}, 60_000);

test("real manifest engine computes patch after exclusive bootstrap", async () => {
	const { scm } = fixture("fix: repair routing");
	const manifest = await createRouterManifest(scm);
	expect(manifest).toBeInstanceOf(Manifest);
	const prs = await manifest.buildPullRequests();
	expect(prs).toHaveLength(1);
	expect(prs[0].version?.toString()).toBe("3.5.79");
});
