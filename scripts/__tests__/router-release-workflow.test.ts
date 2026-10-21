import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	ROUTER_REPOSITORIES,
	ROUTER_REPOSITORY_ID,
} from "../../packages/core/src/router-repository";
import {
	type AssetTransport,
	assertArtifactEvent,
	assertCoordinatorEvent,
	attestationArguments,
	reconcileAssets,
} from "../router-release-assets";

for (const module of ["router-release.ts", "router-release-assets.ts"]) {
	test(`fresh process imports ${module} first`, () => {
		const result = Bun.spawnSync([
			process.execPath,
			"--no-env-file",
			"-e",
			`await import(${JSON.stringify(join(import.meta.dir, "..", module))});`,
		]);
		expect(result.stderr.toString()).not.toContain(
			"superclass is not a constructor",
		);
		expect(result.exitCode).toBe(0);
	});
}

const repository = "StartupBros/wstack-router";
const repositoryId = 1278801682;
const metadata = (full_name: string = repository) => ({
	id: repositoryId,
	full_name,
	name: full_name.split("/")[1],
	owner: { login: "StartupBros" },
});
const sha = "a".repeat(40);
const identity = {
	repository,
	sha,
	version: "3.5.79",
	ref: "refs/tags/v3.5.79",
	releaseId: 17,
};
const run = {
	repository,
	repositoryId,
	eventName: "workflow_run",
	ref: "refs/heads/main",
	sha,
	event: {
		repository: metadata(),
		workflow_run: {
			name: "Managed Routing Foundation Gate",
			path: ".github/workflows/managed-routing-postgres.yml",
			event: "push",
			status: "completed",
			conclusion: "success",
			head_branch: "main",
			head_sha: sha,
			repository: metadata(),
			head_repository: metadata(),
		},
	},
};

test("coordinator accepts exact foundation main push and bounded explicit draft retry", () => {
	expect(assertCoordinatorEvent(run)).toEqual({ sha });
	expect(
		assertCoordinatorEvent({
			...run,
			eventName: "workflow_dispatch",
			event: {
				repository: metadata(),
				inputs: { source_sha: sha, version: identity.version },
			},
		}),
	).toEqual({ sha, version: identity.version });
});
for (const [field, value] of Object.entries({
	event: "pull_request",
	conclusion: "failure",
	status: "in_progress",
	head_branch: "topic",
	head_sha: "bad",
	path: ".github/workflows/other.yml",
	name: "Other",
	repository: { full_name: "fork/router" },
	head_repository: { full_name: "fork/router" },
})) {
	test(`coordinator rejects substituted ${field}`, () => {
		expect(() =>
			assertCoordinatorEvent({
				...run,
				event: {
					...run.event,
					workflow_run: { ...run.event.workflow_run, [field]: value },
				},
			}),
		).toThrow();
	});
}
test("coordinator rejects wrong repo, nonmain dispatch, incomplete retry and unknown event", () => {
	for (const bad of [
		{ ...run, repository: "fork/router" },
		{ ...run, ref: "refs/heads/topic" },
		{ ...run, eventName: "pull_request" },
		{ ...run, eventName: "workflow_dispatch", event: { inputs: {} } },
	])
		expect(() => assertCoordinatorEvent(bad)).toThrow();
});
test("tag run identity binds actual GitHub ref and SHA, not checkout", () => {
	const good = {
		...run,
		eventName: "workflow_dispatch",
		ref: identity.ref,
		event: {
			repository: metadata(),
			inputs: { source_sha: sha, version: identity.version, release_id: "17" },
		},
	};
	expect(() => assertArtifactEvent(good, identity)).not.toThrow();
	for (const bad of [
		{ ...good, sha: "b".repeat(40) },
		{ ...good, ref: "refs/heads/main" },
		{ ...good, repository: "fork/router" },
		{ ...good, eventName: "push" },
		{ ...good, repositoryId: 1 },
		{
			...good,
			event: {
				...good.event,
				inputs: { ...good.event.inputs, release_id: "18" },
			},
		},
		{
			...good,
			event: {
				...good.event,
				inputs: { ...good.event.inputs, source_sha: "b".repeat(40) },
			},
		},
		{
			...good,
			event: {
				...good.event,
				inputs: { ...good.event.inputs, version: "3.5.80" },
			},
		},
	])
		expect(() => assertArtifactEvent(bad, identity)).toThrow();
	for (const releaseId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
		expect(() =>
			assertArtifactEvent(good, { ...identity, releaseId }),
		).toThrow();
});
test("event fixtures admit both exact names and reject missing IDs and mixed repository contexts", () => {
	for (const repository of ROUTER_REPOSITORIES) {
		const event = {
			repository: metadata(repository),
			workflow_run: {
				...run.event.workflow_run,
				repository: metadata(repository),
				head_repository: metadata(repository),
			},
		};
		const context = { ...run, repository, event };
		expect(assertCoordinatorEvent(context)).toEqual({ sha });
		const artifact = {
			...context,
			eventName: "workflow_dispatch",
			ref: identity.ref,
			event: {
				repository: metadata(repository),
				inputs: {
					source_sha: sha,
					version: identity.version,
					release_id: "17",
				},
			},
		};
		expect(() =>
			assertArtifactEvent(artifact, { ...identity, repository }),
		).not.toThrow();
		const other = ROUTER_REPOSITORIES.find(
			(name) => name !== repository,
		) as string;
		expect(() =>
			assertArtifactEvent(artifact, { ...identity, repository: other }),
		).toThrow();
		for (const repositoryId of [undefined, 1, "1278801682", NaN]) {
			expect(() =>
				assertCoordinatorEvent({ ...context, repositoryId } as never),
			).toThrow();
			expect(() =>
				assertArtifactEvent({ ...artifact, repositoryId } as never, {
					...identity,
					repository,
				}),
			).toThrow();
		}
		for (const full_name of [
			"other/hov-router",
			`${repository}-extra`,
			`prefix-${repository}`,
			"startupbros/hov-router",
		]) {
			expect(() =>
				assertCoordinatorEvent({ ...context, repository: full_name }),
			).toThrow();
			expect(() =>
				assertArtifactEvent(
					{ ...artifact, repository: full_name },
					{ ...identity, repository: full_name },
				),
			).toThrow();
		}
		for (const field of ["repository", "head_repository"] as const)
			for (const patch of [
				{ id: undefined },
				{ id: 1 },
				metadata(other),
				{ owner: { login: "other" } },
			])
				expect(() =>
					assertCoordinatorEvent({
						...context,
						event: {
							...event,
							workflow_run: {
								...event.workflow_run,
								[field]: { ...metadata(repository), ...patch },
							},
						},
					}),
				).toThrow();
		for (const patch of [
			{ id: undefined },
			{ id: 1 },
			metadata(other),
			{ full_name: "other/hov-router" },
			{ name: "wrong" },
		]) {
			const badRepository = { ...metadata(repository), ...patch };
			expect(() =>
				assertCoordinatorEvent({
					...context,
					event: { ...event, repository: badRepository },
				}),
			).toThrow();
			expect(() =>
				assertArtifactEvent(
					{
						...artifact,
						event: { ...artifact.event, repository: badRepository },
					},
					{ ...identity, repository },
				),
			).toThrow();
		}
	}
});
test("attestation verifier binds repository, exact source, signer workflow and hosted runner", () => {
	expect(attestationArguments("binary", identity)).toEqual([
		"attestation",
		"verify",
		"binary",
		"--repo",
		repository,
		"--source-digest",
		sha,
		"--source-ref",
		identity.ref,
		"--cert-identity",
		`https://github.com/${repository}/.github/workflows/router-release-artifacts.yml@${identity.ref}`,
		"--signer-digest",
		sha,
		"--deny-self-hosted-runners",
	]);
});
test("attestation policy fixtures preserve historical identity and bind future builds to their actual producer", () => {
	const historical = {
		...identity,
		version: "3.6.2",
		ref: "refs/tags/v3.6.2",
		sha: "5d7b2a888a9b61d87916332b414e46606498d896",
	};
	const old = attestationArguments(
		"binary",
		historical,
		"downloaded-old-bundle.jsonl",
	);
	expect(old).toContain("StartupBros/wstack-router");
	expect(old).toContain(
		"https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2",
	);
	expect(old[old.indexOf("--source-digest") + 1]).toBe(historical.sha);
	expect(old[old.indexOf("--signer-digest") + 1]).toBe(historical.sha);
	expect(old[old.indexOf("--source-ref") + 1]).toBe(historical.ref);
	expect(old).toContain("--deny-self-hosted-runners");
	expect(old.slice(-2)).toEqual(["--bundle", "downloaded-old-bundle.jsonl"]);
	for (const repository of ROUTER_REPOSITORIES) {
		const future = {
			...identity,
			repository,
			version: "3.6.3",
			ref: "refs/tags/v3.6.3",
		};
		const args = attestationArguments("binary", future);
		expect(args).toContain(
			`https://github.com/${repository}/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.3`,
		);
		expect(args).not.toContain(old[old.indexOf("--cert-identity") + 1]);
		expect(args).toContain("--deny-self-hosted-runners");
	}
});

test.each([
	"old",
	"new",
	"renamed",
	"wrong-id",
	"unrelated-redirect",
])("stage CLI transport fixture %s uses validated API/upload destinations and preserves producing attestation policy", (scenario) => {
	const producer = scenario === "new" ? "StartupBros/hov-router" : repository;
	const current = scenario === "old" ? repository : "StartupBros/hov-router";
	const returnedMetadata =
		scenario === "wrong-id"
			? { ...metadata(current), id: 1 }
			: metadata(scenario === "unrelated-redirect" ? "other/router" : current);
	const root = mkdtempSync(join(tmpdir(), "router-stage-cli-"));
	try {
		const assets = join(root, "assets");
		mkdirSync(assets);
		const names = [
			"SHA256SUMS",
			"better-ccflare-linux-amd64",
			"release-manifest.json",
		];
		for (const name of names) writeFileSync(join(assets, name), name);
		writeFileSync(
			join(root, "event.json"),
			JSON.stringify({
				repository: metadata(producer),
				inputs: {
					source_sha: sha,
					version: identity.version,
					release_id: "17",
				},
			}),
		);
		for (const tool of ["gh", "bun"])
			writeFileSync(
				join(root, tool),
				`#!/bin/sh\nprintf '${tool} stdout diagnostic\\n'\nprintf '${tool} stderr diagnostic\\n' >&2\nprintf '%s\\n' "$*" >> '${join(root, `${tool}-arguments`).replaceAll("'", "'\\''")}'\n`,
				{ mode: 0o755 },
			);
		const preload = join(root, "preload.ts");
		writeFileSync(
			preload,
			`
const {GitHub, Manifest} = await import(${JSON.stringify(require.resolve("release-please"))});
const logger = require(${JSON.stringify(require.resolve("release-please/build/src/util/logger"))});
const { appendFileSync } = await import("node:fs");
const sha = ${JSON.stringify(sha)};
const version = ${JSON.stringify(identity.version)};
const metadata = ${JSON.stringify(returnedMetadata)};
const current = ${JSON.stringify(current)};
GitHub.create = async (options) => {
 if (options.owner !== "StartupBros" || options.repo !== current.split("/")[1]) throw new Error("Unvalidated SCM destination");
 return {repository: {owner: "StartupBros", repo: current.split("/")[1]},
 getFileJson: async () => ({version, ".": version}),
 getFileContentsOnBranch: async () => ({parsedContent: JSON.stringify({workspaces: {"apps/cli": {version}}})})};
};
Manifest.fromManifest = async () => ({buildReleases: async () => {
 logger.logger.info("engine diagnostic");
 return [{sha, tag: {toString: () => "v"+version}, draft: true, forceTag: true,
 pullRequest: {sha, baseBranchName: "main", labels: ["autorelease: tagged"], number: 1}}];
}});
const names = ${JSON.stringify(names)};
const uploaded = new Set();
globalThis.fetch = async (input, init) => {
 const url = String(input);
 appendFileSync(${JSON.stringify(join(root, "api-requests"))}, url + "\\n");
 let data;
 if (url === "https://api.github.com/repos/StartupBros/wstack-router" || url === "https://api.github.com/repos/StartupBros/hov-router") return Response.json(metadata);
 if (url.startsWith("https://uploads.github.com/repos/" + current + "/releases/17/assets?")) {
   if (init.method !== "POST" || init.redirect !== "error") throw new Error("Invalid upload request");
   uploaded.add(new URL(url).searchParams.get("name"));
   return Response.json({});
 }
 if (!url.startsWith("https://api.github.com/repos/" + current + "/")) throw new Error("Unvalidated API destination: " + url);
 if (url.includes("git/ref/")) data = {object: {type: "commit", sha}};
 else if (url.includes("actions/workflows/")) data = {workflow_runs: [{name: "Managed Routing Foundation Gate", head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/managed-routing-postgres.yml", repository: metadata, head_repository: metadata}]};
 else if (url.includes("releases?")) data = [{id: 17, tag_name: "v"+version, target_commitish: sha, draft: true}];
 else if (url.includes("releases/17/assets")) data = names.filter(name => uploaded.has(name)).map(name => ({id: names.indexOf(name) + 1, name, state: "uploaded"}));
 else if (url.includes("releases/assets/")) return new Response(names[Number(url.split("/").at(-1)) - 1]);
 else if (url.endsWith("releases/17")) data = {html_url: "https://example.test/draft/17"};
 else throw new Error("Unexpected fixture request: " + url);
 return Response.json(data);
};`,
		);
		const env = {
			PATH: `${root}:${process.env.PATH}`,
			TMPDIR: root,
			GITHUB_TOKEN: "synthetic",
			GITHUB_REPOSITORY: producer,
			GITHUB_REPOSITORY_ID: String(repositoryId),
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REF: identity.ref,
			GITHUB_SHA: sha,
			GITHUB_EVENT_PATH: join(root, "event.json"),
			ROUTER_REPOSITORY: producer,
			ROUTER_SHA: sha,
			ROUTER_VERSION: identity.version,
			ROUTER_REF: identity.ref,
			ROUTER_RELEASE_ID: "17",
		};
		const result = Bun.spawnSync(
			[
				process.execPath,
				"--no-env-file",
				"--preload",
				preload,
				join(import.meta.dir, "../router-release-assets.ts"),
				"stage",
				assets,
			],
			{ env },
		);
		const requests = readFileSync(join(root, "api-requests"), "utf8")
			.trim()
			.split("\n");
		if (scenario === "wrong-id" || scenario === "unrelated-redirect") {
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout.toString()).toBe("");
			expect(result.stderr.toString()).toContain(
				"Wrong Router repository identity",
			);
			expect(requests).toEqual([`https://api.github.com/repos/${producer}`]);
			return;
		}
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({
			...identity,
			repository: producer,
			draftUrl: "https://example.test/draft/17",
			verified: true,
		});
		const uploads = requests.filter((url) =>
			url.startsWith("https://uploads.github.com/"),
		);
		expect(uploads).toHaveLength(3);
		expect(
			uploads.every((url) =>
				url.startsWith(`https://uploads.github.com/repos/${current}/`),
			),
		).toBe(true);
		const args = readFileSync(join(root, "gh-arguments"), "utf8")
			.trim()
			.split("\n");
		expect(args).toHaveLength(4);
		for (const line of args.filter((line) =>
			line.startsWith("attestation download"),
		))
			expect(line).toContain(`--repo ${current}`);
		for (const line of args.filter((line) =>
			line.startsWith("attestation verify"),
		)) {
			expect(line).toContain(`--repo ${producer}`);
			expect(line).toContain("--bundle ");
			expect(line).toContain(
				`https://github.com/${producer}/.github/workflows/router-release-artifacts.yml@${identity.ref}`,
			);
		}
		for (const diagnostic of [
			"engine diagnostic",
			"gh stdout diagnostic",
			"gh stderr diagnostic",
			"bun stdout diagnostic",
			"bun stderr diagnostic",
		])
			expect(result.stderr.toString()).toContain(diagnostic);
		const command = [
			process.execPath,
			"--no-env-file",
			"--preload",
			preload,
			join(import.meta.dir, "../router-release-assets.ts"),
			"coordinator-event",
		];
		const coordinator = Bun.spawnSync(command, {
			env: { ...env, GITHUB_REF: "refs/heads/main" },
		});
		expect(coordinator.exitCode).toBe(0);
		expect(JSON.parse(coordinator.stdout.toString())).toEqual({
			sha,
			version: identity.version,
			repository: current,
			repositoryName: current.split("/")[1],
		});
		const before = readFileSync(join(root, "api-requests"), "utf8");
		for (const GITHUB_REPOSITORY_ID of [
			"",
			"1",
			" 1278801682",
			"1278801682\n",
			"01278801682",
		]) {
			const rejected = Bun.spawnSync(command, {
				env: { ...env, GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY_ID },
			});
			expect(rejected.exitCode).not.toBe(0);
			expect(rejected.stdout.toString()).toBe("");
			expect(readFileSync(join(root, "api-requests"), "utf8")).toBe(before);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("production smoke launcher keeps runtime HOME out of downloaded inventory", () => {
	const root = mkdtempSync(join(tmpdir(), "router-smoke-"));
	try {
		const names = [
			"SHA256SUMS",
			"better-ccflare-linux-amd64",
			"release-manifest.json",
		];
		// Run the real launcher and verifier, not a replacement bun executable.
		// Invalid JSON stops verification before any inert executable bytes can run.
		const result = Bun.spawnSync(
			[
				process.execPath,
				"--no-env-file",
				"-e",
				`import { smokeDownloadedAssets } from ${JSON.stringify(join(import.meta.dir, "../router-release-assets.ts"))};
smokeDownloadedAssets(new Map(${JSON.stringify(names)}.map(name => [name, new TextEncoder().encode("inert text")])), ${JSON.stringify(identity)}, ${JSON.stringify(root)});`,
			],
			{
				cwd: join(import.meta.dir, "../.."),
				env: {
					PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
					HOME: root,
				},
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("Malformed release manifest");
		expect(result.stderr.toString()).not.toContain("Invalid release inventory");
		const downloads = readdirSync(root).filter((name) =>
			name.startsWith("download-"),
		);
		expect(downloads).toHaveLength(1);
		expect(readdirSync(join(root, downloads[0])).sort()).toEqual(names);
		for (const name of names)
			expect(readFileSync(join(root, downloads[0], name), "utf8")).toBe(
				"inert text",
			);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// These are transport/state-machine tests, not live GitHub upload or attestation proof.
function fixture() {
	const files = new Map([
		["better-ccflare-linux-amd64", new Uint8Array([1, 2, 3])],
		["SHA256SUMS", new Uint8Array([4])],
		["release-manifest.json", new Uint8Array([5])],
	]);
	const remote = new Map<string, Uint8Array>();
	const calls: string[] = [];
	let valid = true;
	let attest = true;
	const transport: AssetTransport = {
		validate: async () => {
			calls.push("validate");
			if (!valid) throw new Error("Published or mismatched release");
		},
		list: async () =>
			[...remote.keys()].map((name, index) => ({ id: index + 1, name })),
		download: async (asset) => {
			calls.push(`download:${asset.name}`);
			const bytes = remote.get(asset.name);
			if (!bytes) throw new Error(`Missing fixture asset ${asset.name}`);
			return bytes;
		},
		upload: async (name, bytes) => {
			calls.push(`upload:${name}`);
			remote.set(name, bytes);
		},
		authenticate: async (name) => {
			calls.push(`attest:${name}`);
			if (!attest) throw new Error("attestation failed");
		},
		smoke: async () => {
			calls.push("smoke");
		},
	};
	return {
		files,
		remote,
		calls,
		transport,
		invalidate: () => {
			valid = false;
		},
		failAttest: () => {
			attest = false;
		},
	};
}
for (const phase of ["authenticate", "smoke"] as const) {
	test(`release state changing during ${phase} cannot return verified`, async () => {
		const f = fixture();
		f.transport[phase] = async () => {
			f.invalidate();
		};
		await expect(reconcileAssets(f.transport, f.files)).rejects.toThrow(
			"Published or mismatched release",
		);
	});
}
test("partial upload resumes only missing bytes; rerun verifies without replacement", async () => {
	const f = fixture();
	f.remote.set("SHA256SUMS", new Uint8Array([4]));
	await reconcileAssets(f.transport, f.files);
	expect(f.calls.filter((c) => c.startsWith("upload:"))).toHaveLength(2);
	expect(f.calls.slice(-2)).toEqual(["smoke", "validate"]);
	for (let i = 0; i < f.calls.length; i++)
		if (f.calls[i].startsWith("upload:"))
			expect(f.calls[i - 1]).toBe("validate");
	expect(f.calls.filter((c) => c.startsWith("attest:"))).toHaveLength(2);
	f.calls.length = 0;
	await reconcileAssets(f.transport, f.files);
	expect(f.calls.some((c) => c.startsWith("upload:"))).toBe(false);
	expect(f.calls.filter((c) => c.startsWith("download:"))).toHaveLength(6);
});
for (const failure of [
	"conflict",
	"published",
	"extra",
	"missing-local",
	"attestation",
	"lost-source",
	"lost-upload",
]) {
	test(`assets refuse ${failure}; never execute unauthenticated bytes`, async () => {
		const f = fixture();
		if (failure === "conflict")
			f.remote.set("better-ccflare-linux-amd64", new Uint8Array([99]));
		if (failure === "published") f.invalidate();
		if (failure === "extra") f.remote.set("bundle.json", new Uint8Array([1]));
		if (failure === "missing-local") f.files.delete("SHA256SUMS");
		if (failure === "attestation") f.failAttest();
		if (failure === "lost-source") {
			const list = f.transport.list;
			f.transport.list = async () => {
				f.invalidate();
				return list();
			};
		}
		if (failure === "lost-upload") f.transport.upload = async () => {};
		await expect(reconcileAssets(f.transport, f.files)).rejects.toThrow();
		expect(f.calls).not.toContain("smoke");
		if (
			[
				"conflict",
				"published",
				"extra",
				"missing-local",
				"lost-source",
			].includes(failure)
		)
			expect(f.calls.some((c) => c.startsWith("upload:"))).toBe(false);
	});
}
const workflows = join(import.meta.dir, "../../.github/workflows");
type Job = {
	if?: string;
	needs?: string | string[];
	outputs?: Record<string, string>;
	"continue-on-error"?: boolean;
	permissions?: Record<string, string>;
	steps: {
		id?: string;
		if?: string;
		"continue-on-error"?: boolean;
		uses?: string;
		run?: string;
		env?: Record<string, string>;
		with?: Record<string, unknown>;
	}[];
};
function workflow(file: string) {
	return Bun.YAML.parse(readFileSync(join(workflows, file), "utf8")) as {
		name: string;
		permissions: Record<string, string>;
		jobs: Record<string, Job>;
		concurrency: { group: string; "cancel-in-progress": boolean };
	};
}
// Fixture evaluation of the checked-in expressions, not real GitHub execution proof.
function evaluate(
	condition: string,
	github: unknown,
	needs: unknown = { guard: { result: "success" } },
) {
	return Function(
		"github",
		"needs",
		"cancelled",
		`return (${condition.replace(/^\s*\$\{\{|\}\}\s*$/g, "")});`,
	)(github, needs, () => false);
}
for (const file of [
	"release-dispatch.yml",
	"release.yml",
	"signpath-release.yml",
	"signpath-test.yml",
	"docker-publish.yml",
]) {
	test(`${file}: publisher gate fixtures deny both Router names and stable ID and preserve upstream conditions`, () => {
		for (const job of Object.values(workflow(file).jobs)) {
			for (const event_name of ["workflow_dispatch", "push", "workflow_run"])
				for (const conclusion of ["success", "failure"]) {
					const context = {
						repository,
						repository_id: String(repositoryId),
						event_name,
						event: { workflow_run: { conclusion } },
					};
					expect(evaluate(job.if ?? "true", context)).toBe(false);
					for (const repository of ROUTER_REPOSITORIES)
						for (const repository_id of [undefined, "1", String(repositoryId)])
							expect(
								evaluate(job.if ?? "true", {
									...context,
									repository,
									repository_id,
								}),
							).toBe(false);
					expect(
						evaluate(job.if ?? "true", {
							...context,
							repository: "other/renamed-router",
						}),
					).toBe(false);
					expect(
						evaluate(job.if ?? "true", {
							...context,
							repository: "tombii/better-ccflare",
							repository_id: "123",
						}),
					).toBe(
						file !== "docker-publish.yml" ||
							event_name !== "workflow_run" ||
							conclusion === "success",
					);
				}
		}
	});
}
test("coordinator dispatches all four pending candidates at their tags", () => {
	const root = mkdtempSync(join(tmpdir(), "router-dispatch-"));
	try {
		const step = workflow("router-release.yml").jobs.drafts.steps.find((s) =>
			s.run?.includes("selection="),
		);
		expect(step?.run).toBeDefined();
		writeFileSync(join(root, "run.sh"), step?.run ?? "");
		writeFileSync(
			join(root, "bun"),
			`#!/bin/sh\ncase "$4" in\ncandidates) printf '%s\\n' '{"releases":[{"version":"3.5.79","sha":"${sha}"},{"version":"3.5.80","sha":"${sha}"},{"version":"3.5.81","sha":"${sha}"},{"version":"3.5.82","sha":"${sha}"}]}' ;;\ndraft) printf '%s\\n' '{"releaseId":17,"repository":"StartupBros/hov-router"}' ;;\n*) exit 9 ;;\nesac\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(root, "gh"),
			'#!/bin/sh\nprintf "%s\\n" "$*" >> "$DISPATCH_LOG"\n',
			{ mode: 0o755 },
		);
		const log = join(root, "dispatch.log");
		const result = Bun.spawnSync(["bash", join(root, "run.sh")], {
			env: {
				PATH: `${root}:${process.env.PATH}`,
				ROUTER_VERSION: "",
				ROUTER_SHA: sha,
				ROUTER_REPOSITORY: repository,
				DISPATCH_LOG: log,
			},
		});
		expect(result.exitCode).toBe(0);
		const dispatches = readFileSync(log, "utf8").trim().split("\n");
		expect(dispatches).toHaveLength(4);
		for (const [index, line] of dispatches.entries()) {
			expect(line).toContain(`--ref v3.5.${79 + index} `);
			expect(line).toContain("--repo StartupBros/hov-router ");
			expect(line).not.toContain("--ref main");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("artifact concurrency serializes a tag without dropping distinct tags", () => {
	const group = workflow("router-release-artifacts.yml").concurrency.group;
	const render = (ref: string) =>
		group.replace(/\$\{\{\s*github.ref\s*\}\}/g, ref);
	expect(render("refs/tags/v3.5.79")).not.toBe(render("refs/tags/v3.5.80"));
	expect(render("refs/tags/v3.5.79")).toBe(render("refs/tags/v3.5.79"));
});
test("workflow jobs isolate build credentials and permissions; dispatch and attest are explicit", () => {
	const coordinator = workflow("router-release.yml");
	const artifacts = workflow("router-release-artifacts.yml");
	expect(coordinator.concurrency.group).not.toBe(artifacts.concurrency.group);
	expect(coordinator.concurrency["cancel-in-progress"]).toBe(false);
	expect(artifacts.concurrency["cancel-in-progress"]).toBe(false);
	expect(artifacts.jobs.build.permissions).toEqual({ contents: "read" });
	expect(artifacts.jobs.attest.permissions).toEqual({
		contents: "read",
		"id-token": "write",
		attestations: "write",
	});
	// Listing drafts requires push access even though validate-draft is read-only.
	expect(artifacts.permissions).toEqual({});
	expect(artifacts.jobs.validate.permissions).toEqual({
		contents: "write",
		"pull-requests": "read",
		actions: "read",
	});
	expect(artifacts.jobs.stage.permissions).toEqual({
		contents: "write",
		"pull-requests": "read",
		attestations: "read",
		actions: "read",
	});
	expect(coordinator.permissions).toEqual({});
	expect(coordinator.jobs["pull-requests"].permissions).toEqual({
		contents: "read",
	});
	expect(coordinator.jobs.drafts.permissions).toEqual({
		contents: "write",
		"pull-requests": "write",
		actions: "write",
	});
	for (const step of artifacts.jobs.build.steps) {
		expect(JSON.stringify(step.env ?? {})).not.toMatch(/token|secret/i);
		if (step.uses?.startsWith("actions/checkout@"))
			expect(step.with?.["persist-credentials"]).toBe(false);
	}
	for (const w of [coordinator, artifacts])
		for (const job of Object.values(w.jobs))
			for (const step of job.steps) {
				if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
				expect(step.run ?? "").not.toContain("${{");
			}
	const exclusions = readFileSync(
		join(workflows, "auto-rerun-failed.yml"),
		"utf8",
	);
	expect(exclusions).toContain(`"${coordinator.name}"`);
	expect(exclusions).toContain(`"${artifacts.name}"`);
});
// Static wiring proof only: these assertions do not mint a token or run Actions.
test("release App is pinned, repo-scoped and minted only immediately before PR reconciliation", () => {
	const coordinator = workflow("router-release.yml");
	const job = coordinator.jobs["pull-requests"];
	expect(job["continue-on-error"]).toBeUndefined();
	const index = job.steps.findIndex((step) => step.id === "release-app");
	expect(index).toBeGreaterThan(0);
	const mint = job.steps[index];
	expect(mint.uses).toBe(
		"actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
	);
	expect(mint.with).toEqual({
		"client-id": `\${{ vars.ROUTER_RELEASE_APP_CLIENT_ID }}`,
		"private-key": `\${{ secrets.ROUTER_RELEASE_APP_PRIVATE_KEY }}`,
		owner: "StartupBros",
		repositories: `\${{ needs.guard.outputs.repository-name }}`,
		"permission-contents": "write",
		"permission-pull-requests": "write",
		"permission-issues": "write",
		"permission-actions": "read",
	});
	expect(job.steps[index - 1].run).toBe("bun install --frozen-lockfile");
	expect(job.needs).toBe("guard");
	const guard = coordinator.jobs.guard;
	expect(guard.outputs?.["repository-name"]).toBe(
		`\${{ steps.event.outputs.repository-name }}`,
	);
	expect(guard.outputs?.repository).toBe(
		`\${{ steps.event.outputs.repository }}`,
	);
	const validate = guard.steps.find((step) => step.id === "event");
	expect(validate?.run).toContain(
		"scripts/router-release-assets.ts coordinator-event",
	);
	expect(validate?.env?.GITHUB_TOKEN).toBe(`\${{ github.token }}`);
	const reconcile = job.steps[index + 1];
	expect(reconcile.run).toBe(
		'bun --no-env-file run scripts/router-release.ts reconcile-pr "$ROUTER_REPOSITORY" "$ROUTER_SHA"',
	);
	expect(reconcile.env?.GITHUB_TOKEN).toBe(
		`\${{ steps.release-app.outputs.token }}`,
	);
	expect(reconcile.env?.ROUTER_REPOSITORY).toBe(
		`\${{ needs.guard.outputs.repository }}`,
	);
	// Missing config and mint failures must fail the job, not skip or fall back.
	for (const step of [mint, reconcile]) {
		expect(step.if).toBeUndefined();
		expect(step["continue-on-error"]).toBeUndefined();
	}
	for (const file of ["router-release.yml", "router-release-artifacts.yml"]) {
		const w = workflow(file);
		for (const candidate of Object.values(w.jobs)) {
			for (const step of candidate.steps) {
				if (step.uses?.startsWith("actions/checkout@"))
					expect(step.with?.["persist-credentials"]).toBe(false);
			}
		}
		const text = JSON.stringify(w);
		for (const config of [
			"ROUTER_RELEASE_APP_CLIENT_ID",
			"ROUTER_RELEASE_APP_PRIVATE_KEY",
		])
			expect(text.split(config).length - 1).toBe(
				file === "router-release.yml" ? 1 : 0,
			);
		expect(text.split("steps.release-app.outputs.token").length - 1).toBe(
			file === "router-release.yml" ? 1 : 0,
		);
		expect(text.split("actions/create-github-app-token@").length - 1).toBe(
			file === "router-release.yml" ? 1 : 0,
		);
	}
});
test("manual draft retry skips minting and retains independent built-in credentials", () => {
	const coordinator = workflow("router-release.yml");
	const job = coordinator.jobs["pull-requests"];
	const context = { repository, repository_id: String(repositoryId) };
	expect(
		evaluate(job.if ?? "true", { ...context, event_name: "workflow_dispatch" }),
	).toBe(false);
	expect(
		evaluate(job.if ?? "true", { ...context, event_name: "workflow_run" }),
	).toBe(true);
	const drafts = coordinator.jobs.drafts;
	expect(evaluate(drafts.if ?? "true", context)).toBe(true);
	expect(
		evaluate(drafts.if ?? "true", context, { guard: { result: "failure" } }),
	).toBe(false);
	const dispatch = drafts.steps.find((step) =>
		step.run?.includes("selection="),
	);
	expect(dispatch?.env?.GITHUB_TOKEN).toBe(`\${{ github.token }}`);
	expect(dispatch?.env?.GH_TOKEN).toBe(`\${{ github.token }}`);
	expect(dispatch?.env?.ROUTER_REPOSITORY).toBe(
		`\${{ needs.guard.outputs.repository }}`,
	);
	expect(JSON.stringify(drafts)).not.toMatch(/release-app|ROUTER_RELEASE_APP/);
});
test("release CLI without a token fails with an authentication-neutral diagnostic", () => {
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "../router-release.ts"),
			"reconcile-pr",
			repository,
			sha,
		],
		{ env: { GITHUB_TOKEN: "" } },
	);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain(
		"GITHUB_TOKEN required; supply a token with permissions for the requested release operation",
	);
	expect(result.stderr.toString()).not.toContain(
		"can_approve_pull_request_reviews",
	);
	expect(result.stdout.toString()).toBe("");
});
test("verifier help preflight consumes long output and requires every used flag", () => {
	const root = mkdtempSync(join(tmpdir(), "router-help-"));
	try {
		const step = workflow("router-release-artifacts.yml").jobs.stage.steps.find(
			(s) => s.run?.includes("gh attestation verify --help"),
		);
		expect(step?.run).toBeDefined();
		writeFileSync(join(root, "run.sh"), step?.run ?? "");
		writeFileSync(join(root, "gh"), '#!/bin/sh\ncat "$HELP_FILE"\n', {
			mode: 0o755,
		});
		const flags = attestationArguments(
			"binary",
			identity,
			"bundle.jsonl",
		).filter((arg) => arg.startsWith("--"));
		for (const missing of [undefined, ...flags]) {
			writeFileSync(
				join(root, "help.txt"),
				flags.filter((flag) => flag !== missing).join("\n") +
					"\n" +
					"long help output\n".repeat(10000),
			);
			const result = Bun.spawnSync(["bash", join(root, "run.sh")], {
				env: {
					PATH: `${root}:${process.env.PATH}`,
					HELP_FILE: join(root, "help.txt"),
				},
			});
			if (missing) expect(result.exitCode).not.toBe(0);
			else expect(result.exitCode).toBe(0);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("producer gate fixtures match shared exact names and stable ID and contain no publishing path", () => {
	expect(ROUTER_REPOSITORY_ID).toBe(repositoryId);
	for (const file of ["router-release.yml", "router-release-artifacts.yml"]) {
		const text = readFileSync(join(workflows, file), "utf8");
		expect(text).not.toMatch(
			/--clobber|gh release (delete|edit|create)|npm publish|bun publish|docker\/|packages: write|releases\/assets\/\d+.*DELETE/,
		);
		for (const job of Object.values(workflow(file).jobs)) {
			for (const repository of ROUTER_REPOSITORIES) {
				const context = {
					repository,
					repository_id: String(repositoryId),
					event_name: "workflow_run",
				};
				expect(evaluate(job.if ?? "true", context)).toBe(true);
				for (const repository_id of [
					undefined,
					"",
					"1",
					"01278801682",
					"1278801682-extra",
				])
					expect(
						evaluate(job.if ?? "true", { ...context, repository_id }),
					).toBe(false);
				for (const wrong of [
					"fork/router",
					"other/hov-router",
					`${repository}-extra`,
					`prefix-${repository}`,
					"startupbros/hov-router",
				])
					expect(
						evaluate(job.if ?? "true", { ...context, repository: wrong }),
					).toBe(false);
			}
		}
	}
	expect(workflow("router-release.yml").jobs["pull-requests"].if).toContain(
		"github.event_name == 'workflow_run'",
	);
	expect(
		readFileSync(join(workflows, "router-release-artifacts.yml"), "utf8"),
	).toContain("gh attestation verify --help");
});
