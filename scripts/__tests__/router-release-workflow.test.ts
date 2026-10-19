import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	eventName: "workflow_run",
	ref: "refs/heads/main",
	sha,
	event: {
		workflow_run: {
			name: "Managed Routing Foundation Gate",
			path: ".github/workflows/managed-routing-postgres.yml",
			event: "push",
			status: "completed",
			conclusion: "success",
			head_branch: "main",
			head_sha: sha,
			repository: { full_name: repository },
			head_repository: { full_name: repository },
		},
	},
};

test("coordinator accepts exact foundation main push and bounded explicit draft retry", () => {
	expect(assertCoordinatorEvent(run)).toEqual({ sha });
	expect(
		assertCoordinatorEvent({
			...run,
			eventName: "workflow_dispatch",
			event: { inputs: { source_sha: sha, version: identity.version } },
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
				event: { workflow_run: { ...run.event.workflow_run, [field]: value } },
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
	const good = { ...run, eventName: "workflow_dispatch", ref: identity.ref };
	expect(() => assertArtifactEvent(good, identity)).not.toThrow();
	for (const bad of [
		{ ...good, sha: "b".repeat(40) },
		{ ...good, ref: "refs/heads/main" },
		{ ...good, repository: "fork/router" },
		{ ...good, eventName: "push" },
	])
		expect(() => assertArtifactEvent(bad, identity)).toThrow();
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

test("stage CLI emits one JSON object and preserves noisy verifier and engine diagnostics", () => {
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
		writeFileSync(join(root, "event.json"), "{}");
		for (const tool of ["gh", "bun"])
			writeFileSync(
				join(root, tool),
				`#!/bin/sh\nprintf '${tool} stdout diagnostic\\n'\nprintf '${tool} stderr diagnostic\\n' >&2\n`,
				{ mode: 0o755 },
			);
		const preload = join(root, "preload.ts");
		writeFileSync(
			preload,
			`
const {GitHub, Manifest} = await import(${JSON.stringify(require.resolve("release-please"))});
const logger = require(${JSON.stringify(require.resolve("release-please/build/src/util/logger"))});
const sha = ${JSON.stringify(sha)};
const version = ${JSON.stringify(identity.version)};
GitHub.create = async () => ({repository: {owner: "StartupBros", repo: "wstack-router"},
 getFileJson: async () => ({version, ".": version}),
 getFileContentsOnBranch: async () => ({parsedContent: JSON.stringify({workspaces: {"apps/cli": {version}}})})});
Manifest.fromManifest = async () => ({buildReleases: async () => {
 logger.logger.info("engine diagnostic");
 return [{sha, tag: {toString: () => "v"+version}, draft: true, forceTag: true,
 pullRequest: {sha, baseBranchName: "main", labels: ["autorelease: tagged"], number: 1}}];
}});
const names = ${JSON.stringify(names)};
globalThis.fetch = async (input) => {
 const url = String(input);
 let data;
 if (url.includes("git/ref/")) data = {object: {type: "commit", sha}};
 else if (url.includes("actions/workflows/")) data = {workflow_runs: [{head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/managed-routing-postgres.yml", repository: {full_name: "StartupBros/wstack-router"}}]};
 else if (url.includes("releases?")) data = [{id: 17, tag_name: "v"+version, target_commitish: sha, draft: true}];
 else if (url.includes("releases/17/assets")) data = names.map((name, id) => ({id, name, state: "uploaded"}));
 else if (url.includes("releases/assets/")) return new Response(names[Number(url.split("/").at(-1))]);
 else if (url.endsWith("releases/17")) data = {html_url: "https://example.test/draft/17"};
 else throw new Error("Unexpected fixture request: " + url);
 return Response.json(data);
};`,
		);
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
			{
				env: {
					PATH: `${root}:${process.env.PATH}`,
					TMPDIR: root,
					GITHUB_TOKEN: "synthetic",
					GITHUB_REPOSITORY: repository,
					GITHUB_EVENT_NAME: "workflow_dispatch",
					GITHUB_REF: identity.ref,
					GITHUB_SHA: sha,
					GITHUB_EVENT_PATH: join(root, "event.json"),
					ROUTER_REPOSITORY: repository,
					ROUTER_SHA: sha,
					ROUTER_VERSION: identity.version,
					ROUTER_REF: identity.ref,
					ROUTER_RELEASE_ID: "17",
				},
			},
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({
			...identity,
			draftUrl: "https://example.test/draft/17",
			verified: true,
		});
		for (const diagnostic of [
			"engine diagnostic",
			"gh stdout diagnostic",
			"gh stderr diagnostic",
			"bun stdout diagnostic",
			"bun stderr diagnostic",
		])
			expect(result.stderr.toString()).toContain(diagnostic);
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
	permissions?: Record<string, string>;
	steps: {
		uses?: string;
		run?: string;
		env?: Record<string, string>;
		with?: Record<string, unknown>;
	}[];
};
function workflow(file: string) {
	return Bun.YAML.parse(readFileSync(join(workflows, file), "utf8")) as {
		name: string;
		jobs: Record<string, Job>;
		concurrency: { group: string; "cancel-in-progress": boolean };
	};
}
function evaluate(condition: string, github: unknown) {
	return Function(
		"github",
		`return (${condition.replace(/^\s*\$\{\{|\}\}\s*$/g, "")});`,
	)(github);
}
for (const file of [
	"release-dispatch.yml",
	"release.yml",
	"signpath-release.yml",
	"signpath-test.yml",
	"docker-publish.yml",
]) {
	test(`${file}: every inherited job excludes Router and preserves other repository conditions`, () => {
		for (const job of Object.values(workflow(file).jobs)) {
			for (const event_name of ["workflow_dispatch", "push", "workflow_run"])
				for (const conclusion of ["success", "failure"]) {
					const context = {
						repository,
						event_name,
						event: { workflow_run: { conclusion } },
					};
					expect(evaluate(job.if ?? "true", context)).toBe(false);
					expect(
						evaluate(job.if ?? "true", {
							...context,
							repository: "tombii/better-ccflare",
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
			`#!/bin/sh\ncase "$4" in\ncandidates) printf '%s\\n' '{"releases":[{"version":"3.5.79","sha":"${sha}"},{"version":"3.5.80","sha":"${sha}"},{"version":"3.5.81","sha":"${sha}"},{"version":"3.5.82","sha":"${sha}"}]}' ;;\ndraft) printf '%s\\n' '{"releaseId":17}' ;;\n*) exit 9 ;;\nesac\n`,
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
	expect(artifacts.jobs.validate.permissions).toEqual({
		contents: "read",
		"pull-requests": "read",
		actions: "read",
	});
	expect(artifacts.jobs.stage.permissions).toEqual({
		contents: "write",
		"pull-requests": "read",
		attestations: "read",
		actions: "read",
	});
	expect(coordinator.jobs["pull-requests"].permissions).toEqual({
		contents: "write",
		"pull-requests": "write",
		issues: "write",
		actions: "read",
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
		const flags = attestationArguments("binary", identity).filter((arg) =>
			arg.startsWith("--"),
		);
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
test("new workflows evaluate exact-repository guards and contain no publish, clobber or delete path", () => {
	for (const file of ["router-release.yml", "router-release-artifacts.yml"]) {
		const text = readFileSync(join(workflows, file), "utf8");
		expect(text).not.toMatch(
			/--clobber|gh release (delete|edit|create)|npm publish|bun publish|docker\/|packages: write|releases\/assets\/\d+.*DELETE/,
		);
		for (const job of Object.values(workflow(file).jobs).filter((j) =>
			j.if?.includes("github.repository"),
		)) {
			expect(evaluate(job.if as string, { repository })).toBe(true);
			expect(evaluate(job.if as string, { repository: "fork/router" })).toBe(
				false,
			);
		}
	}
	expect(workflow("router-release.yml").jobs["pull-requests"].if).toBe(
		"github.event_name == 'workflow_run'",
	);
	expect(
		readFileSync(join(workflows, "router-release-artifacts.yml"), "utf8"),
	).toContain("gh attestation verify --help");
});
