import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBuildProvenance } from "./build-provenance";

const dockerfile = join(import.meta.dir, "../../../Dockerfile");
const dockerWorkflow = join(
	import.meta.dir,
	"../../../.github/workflows/docker-publish.yml",
);

const sourceSha = "abcdef1234567890abcdef1234567890abcdef12";
const differentSha = "1234567890abcdef1234567890abcdef12345678";

type ScriptEnvironment = Readonly<Record<string, string>>;
type MockGit = Readonly<{
	checkoutSha: string;
	tags: readonly string[];
	tagSha?: string;
}>;

type WorkflowStep = Readonly<{
	name?: string;
	if?: string;
	uses?: string;
	run?: string;
	with?: Readonly<Record<string, unknown>>;
}>;

type DockerWorkflow = Readonly<{
	jobs?: Readonly<{
		"build-and-push"?: Readonly<{ steps?: readonly WorkflowStep[] }>;
	}>;
}>;

function parseDockerWorkflow(): DockerWorkflow {
	return Bun.YAML.parse(readFileSync(dockerWorkflow, "utf8")) as DockerWorkflow;
}

function findWorkflowStep(name: string): WorkflowStep | undefined {
	return parseDockerWorkflow().jobs?.["build-and-push"]?.steps?.find(
		(step) => step.name === name,
	);
}

function readBuildProvenanceScript(): string {
	const run = findWorkflowStep("Set build provenance")?.run;
	expect(run).toEqual(expect.any(String));
	return run ?? "";
}

/** Executes the workflow's exact run block against a local, deterministic Git facade. */
function runBuildProvenanceScript(
	env: ScriptEnvironment,
	git: MockGit,
): Record<string, string> {
	const outputDirectory = mkdtempSync(
		join(tmpdir(), "ccflare-docker-provenance-"),
	);
	const outputPath = join(outputDirectory, "github-output");
	const mockGitPath = join(outputDirectory, "git");
	writeFileSync(
		mockGitPath,
		`#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  tag)
    [[ "\${2:-}" == "--points-at" && "\${3:-}" == "HEAD" ]]
    printf '%s\\n' "\${MOCK_TAGS:-}"
    ;;
  rev-parse)
    if [[ "\${2:-}" == "HEAD" ]]; then
      printf '%s\\n' "\${MOCK_CHECKOUT_SHA:-}"
    elif [[ "\${2:-}" == refs/tags/*'^{commit}' ]]; then
      printf '%s\\n' "\${MOCK_TAG_SHA:-\${MOCK_CHECKOUT_SHA:-}}"
    else
      exit 64
    fi
    ;;
  *)
    exit 64
    ;;
esac
`,
	);
	chmodSync(mockGitPath, 0o755);

	try {
		const result = Bun.spawnSync({
			cmd: ["bash", "-euo", "pipefail", "-c", readBuildProvenanceScript()],
			env: {
				...process.env,
				EVENT_NAME: "",
				WORKFLOW_RUN_EVENT: "",
				WORKFLOW_RUN_CONCLUSION: "",
				GITHUB_REPOSITORY: "",
				HEAD_SHA: "",
				MOCK_TAGS: git.tags.join("\n"),
				MOCK_TAG_SHA: git.tagSha ?? "",
				MOCK_CHECKOUT_SHA: git.checkoutSha,
				...env,
				GITHUB_OUTPUT: outputPath,
				PATH: `${outputDirectory}:${process.env.PATH ?? ""}`,
			},
		});
		expect(result.exitCode).toBe(0);
		return Object.fromEntries(
			readFileSync(outputPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("=", 2) as [string, string]),
		);
	} finally {
		rmSync(outputDirectory, { recursive: true, force: true });
	}
}

const unproven = {
	proven: "false",
	version: "latest",
	is_prerelease: "false",
	git_sha: "unknown",
	git_ref: "unknown",
	checkout_sha: "unknown",
	event_sha: "unknown",
	tag_sha: "unknown",
	distribution: "unknown",
	producer: "unknown",
	artifact_mode: "unknown",
	update_channel: "unknown",
	can_publish: "false",
	can_attest: "false",
} as const;

const provenEnvironment: ScriptEnvironment = {
	EVENT_NAME: "workflow_run",
	WORKFLOW_RUN_EVENT: "push",
	WORKFLOW_RUN_CONCLUSION: "success",
	GITHUB_REPOSITORY: "tombii/better-ccflare",
	HEAD_SHA: sourceSha,
};

const validGit: MockGit = { checkoutSha: sourceSha, tags: ["v1.2.3"] };

describe("Docker distribution provenance", () => {
	it("gates failed workflow-run release builds and checks out the event SHA with tags", () => {
		const workflow = readFileSync(dockerWorkflow, "utf8");
		expect(workflow).toContain(
			"github.event.workflow_run.conclusion == 'success'",
		);
		expect(workflow).toMatch(
			/- name: Checkout triggering workflow source\n\s+if: github\.event_name == 'workflow_run'\n\s+uses: actions\/checkout@v5\n\s+with:\n(?:\s+#.*\n)+\s+ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}\n\s+fetch-depth: 0\n\s+fetch-tags: true/,
		);
		expect(workflow).toContain("context: .");
	});

	it("derives one strict local release tag at the checked-out event SHA", () => {
		const outputs = runBuildProvenanceScript(provenEnvironment, validGit);
		expect(outputs).toMatchObject({
			proven: "true",
			version: "1.2.3",
			is_prerelease: "false",
			git_sha: sourceSha,
			git_ref: "refs/tags/v1.2.3",
			checkout_sha: sourceSha,
			event_sha: sourceSha,
			tag_sha: sourceSha,
			distribution: "v1:tombii-ghcr-docker",
			producer: "tombii",
			artifact_mode: "docker",
			update_channel: "ghcr",
			image_sha: sourceSha,
			can_publish: "true",
			can_attest: "true",
		});
		for (const [name, tag, isPrerelease] of [
			["prerelease", "v1.2.3-preview.1", "true"],
			["build metadata", "v1.2.3+build.1", "false"],
		] as const) {
			expect(
				runBuildProvenanceScript(provenEnvironment, {
					checkoutSha: sourceSha,
					tags: [tag],
				}),
				name,
			).toMatchObject({
				...unproven,
				version: tag.slice(1),
				is_prerelease: isPrerelease,
				image_sha: sourceSha,
			});
		}
		expect(
			resolveBuildProvenance({
				CCFLARE_VERSION: outputs.version,
				CCFLARE_GIT_SHA: outputs.git_sha,
				CCFLARE_GIT_REF: outputs.git_ref,
				CCFLARE_SOURCE_SHA: outputs.git_sha,
				CCFLARE_SOURCE_REF: outputs.git_ref,
				CCFLARE_DISTRIBUTION: outputs.distribution,
				CCFLARE_PRODUCER: outputs.producer,
				CCFLARE_ARTIFACT_MODE: outputs.artifact_mode,
				CCFLARE_UPDATE_CHANNEL: outputs.update_channel,
			}),
		).toMatchObject({ proven: true, actionable: true });
	});

	it("allows exact-tag dispatches to publish immutable images without provenance", () => {
		const outputs = runBuildProvenanceScript(
			{ EVENT_NAME: "workflow_dispatch" },
			validGit,
		);
		expect(outputs).toMatchObject({
			...unproven,
			version: "1.2.3",
			image_sha: sourceSha,
			can_publish: "true",
			can_attest: "false",
		});
		for (const [name, tag, isPrerelease] of [
			["prerelease", "v1.2.3-preview.1", "true"],
			["build metadata", "v1.2.3+build.1", "false"],
		] as const) {
			expect(
				runBuildProvenanceScript(
					{ EVENT_NAME: "workflow_dispatch" },
					{ checkoutSha: sourceSha, tags: [tag] },
				),
				name,
			).toMatchObject({
				...unproven,
				version: tag.slice(1),
				is_prerelease: isPrerelease,
				image_sha: sourceSha,
			});
		}
	});

	it("keeps malformed, mismatched, ambiguous, and invalid workflow runs unpublishable", () => {
		const cases: ReadonlyArray<
			Readonly<{ name: string; env: ScriptEnvironment; git: MockGit }>
		> = [
			{
				name: "failed release workflow",
				env: { ...provenEnvironment, WORKFLOW_RUN_CONCLUSION: "failure" },
				git: validGit,
			},
			{
				name: "fork repository",
				env: {
					...provenEnvironment,
					GITHUB_REPOSITORY: "StartupBros/better-ccflare",
				},
				git: validGit,
			},
			{
				name: "non-push workflow run",
				env: { ...provenEnvironment, WORKFLOW_RUN_EVENT: "workflow_dispatch" },
				git: validGit,
			},
			{
				name: "uppercase SHA",
				env: { ...provenEnvironment, HEAD_SHA: sourceSha.toUpperCase() },
				git: validGit,
			},
			{
				name: "checkout mismatch",
				env: provenEnvironment,
				git: { ...validGit, checkoutSha: differentSha },
			},
			{
				name: "tag mismatch",
				env: provenEnvironment,
				git: { ...validGit, tagSha: differentSha },
			},
			{
				name: "zero strict tags",
				env: { EVENT_NAME: "workflow_dispatch" },
				git: { ...validGit, tags: ["v01.2.3"] },
			},
			{
				name: "ambiguous strict tags",
				env: { EVENT_NAME: "workflow_dispatch" },
				git: { ...validGit, tags: ["v1.2.3", "v1.2.4"] },
			},
		];

		for (const testCase of cases) {
			expect(
				runBuildProvenanceScript(testCase.env, testCase.git),
				testCase.name,
			).toMatchObject(unproven);
		}
	});

	it("passes the complete provenance tuple and verifies versioned release binaries exactly", () => {
		const workflow = readFileSync(dockerWorkflow, "utf8");
		const source = readFileSync(dockerfile, "utf8");
		const metadataTags = findWorkflowStep("Extract metadata")?.with?.tags;
		expect(metadataTags).toEqual(expect.any(String));
		expect(workflow).toContain('proven="false"');
		expect(workflow).toContain('proven="true"');
		const tags = metadataTags as string;
		expect(tags).not.toContain("type=sha");
		const exactTag = tags
			.split("\n")
			.find((line) =>
				line.includes(
					`type=raw,value=\${{ steps.provenance.outputs.version }}`,
				),
			);
		expect(exactTag).toContain("steps.provenance.outputs.proven == 'true'");
		expect(exactTag).toContain(
			"steps.provenance.outputs.is_prerelease == 'false'",
		);
		expect(exactTag).not.toContain(
			"steps.provenance.outputs.can_publish == 'true'",
		);
		const shaTag = tags
			.split("\n")
			.find((line) => line.includes("type=raw,value=sha-"));
		expect(shaTag).toContain("steps.provenance.outputs.image_sha");
		expect(shaTag).toContain("steps.provenance.outputs.can_publish == 'true'");
		for (const mutableTag of [
			"type=semver,pattern={{major}}.{{minor}}",
			"type=semver,pattern={{major}}",
			"type=raw,value=latest",
			"type=raw,value=main",
		]) {
			const line = tags
				.split("\n")
				.find((candidate) => candidate.includes(mutableTag));
			expect(line, mutableTag).toContain(
				"steps.provenance.outputs.proven == 'true'",
			);
			expect(line, mutableTag).toContain(
				"steps.provenance.outputs.is_prerelease == 'false'",
			);
		}
		const buildStep = findWorkflowStep("Build and push Docker images");
		expect(buildStep?.if).toBe(
			"steps.provenance.outputs.can_publish == 'true'",
		);
		expect(buildStep?.with?.push).toBe(
			"$" + "{{ steps.provenance.outputs.can_publish == 'true' }}",
		);
		const attestationStep = findWorkflowStep("Generate artifact attestation");
		expect(attestationStep?.if).toBe(
			"steps.provenance.outputs.proven == 'true' && steps.provenance.outputs.is_prerelease == 'false' && steps.provenance.outputs.can_attest == 'true'",
		);
		expect(workflow).toContain(
			`echo "image_sha=\${image_sha}" >> "$GITHUB_OUTPUT"`,
		);
		expect(workflow).toContain(`echo "proven=\${proven}" >> "$GITHUB_OUTPUT"`);
		for (const name of [
			"VERSION",
			"GIT_SHA",
			"GIT_REF",
			"CHECKOUT_SHA",
			"EVENT_SHA",
			"TAG_SHA",
			"IMAGE_SHA",
			"DISTRIBUTION",
			"PRODUCER",
			"ARTIFACT_MODE",
			"UPDATE_CHANNEL",
		]) {
			expect(workflow).toContain(
				`${name}=$` + `{{ steps.provenance.outputs.${name.toLowerCase()} }}`,
			);
		}
		expect(source).toContain(
			"https://github.com/tombii/better-ccflare/releases/",
		);
		expect(source).toContain(
			'expected_version="better-ccflare v$' + '{VERSION}"',
		);
		expect(source).toContain(
			'reported_version="$(/usr/local/bin/better-ccflare --version)"',
		);
		expect(source).toContain(
			'"$' + '{reported_version}" = "$' + '{expected_version}"',
		);
		expect(source).toContain("ARG IMAGE_SHA=unknown");
		expect(source).toContain(
			'reported_sha="$(/usr/local/bin/better-ccflare --git-sha)"',
		);
		expect(source).toContain('"$' + '{reported_sha}" = "$' + '{IMAGE_SHA}"');
		expect(source).toContain("full checked-out release SHA");
		for (const line of [
			"ARG DISTRIBUTION=unknown",
			"ARG CHECKOUT_SHA=unknown",
			"ARG IMAGE_SHA=unknown",
			"ENV CCFLARE_DISTRIBUTION=$" + "{DISTRIBUTION}",
			"ENV CCFLARE_CHECKOUT_SHA=$" + "{CHECKOUT_SHA}",
			"ENV CCFLARE_EVENT_SHA=$" + "{EVENT_SHA}",
			"ENV CCFLARE_TAG_SHA=$" + "{TAG_SHA}",
		]) {
			expect(source).toContain(line);
		}
	});
});
