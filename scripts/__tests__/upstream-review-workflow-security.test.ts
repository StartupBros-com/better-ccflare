import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

function exposesSecretsToPullRequestCode(workflow: string): boolean {
	const runsForPullRequestTarget = /^\s*pull_request_target\s*:/m.test(workflow);
	const exposesSecret = /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/.test(workflow);
	const checksOutPullRequestCode =
		/refs\/pull\/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}\/(?:head|merge)/.test(
			workflow,
		) ||
		/ref:\s*\$\{\{\s*github\.event\.pull_request\.(?:head\.sha|head\.ref)\s*\}\}/.test(
			workflow,
		);
	const runsRepositoryCode = /^\s*(?:-\s*)?run\s*:/m.test(workflow);

	return (
		runsForPullRequestTarget &&
		exposesSecret &&
		checksOutPullRequestCode &&
		runsRepositoryCode
	);
}

async function repositoryWorkflowViolations(): Promise<string[]> {
	const workflowNames = (await readdir(workflowsDir)).filter(
		(name) => name.endsWith(".yml") || name.endsWith(".yaml"),
	);
	const violations: string[] = [];

	for (const name of workflowNames) {
		const workflow = await Bun.file(join(workflowsDir, name)).text();
		if (exposesSecretsToPullRequestCode(workflow)) violations.push(name);
	}

	return violations;
}

describe("upstream review workflow security hardening", () => {
	test("retires the PR-controlled review workflow and script", async () => {
		expect(existsSync(join(workflowsDir, "pr-review.yml"))).toBe(false);
		expect(
			existsSync(join(repoRoot, ".github", "scripts", "pr-review.sh")),
		).toBe(false);
		expect(await repositoryWorkflowViolations()).toEqual([]);
	});

	test("rejects a synthetic secret-bearing pull_request_target workflow", () => {
		const unsafeFixture = `
name: unsafe review
on:
  pull_request_target:
jobs:
  review:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/pull/\${{ github.event.pull_request.number }}/merge
      - run: bash .github/scripts/review.sh
        env:
          API_KEY: \${{ secrets.LLM_API_KEY }}
`;

		expect(exposesSecretsToPullRequestCode(unsafeFixture)).toBe(true);
	});

	test("disables persisted checkout credentials for the surviving review", async () => {
		const workflow = await Bun.file(
			join(workflowsDir, "claude-code-review.yml"),
		).text();

		expect(workflow).toContain("uses: actions/checkout@v5");
		expect(workflow).toContain("persist-credentials: false");
	});

	test("preserves the managed-routing PostgreSQL gate and exact Bun pin", async () => {
		const workflow = await Bun.file(
			join(workflowsDir, "managed-routing-postgres.yml"),
		).text();

		expect(workflow).toContain("managed-routing-foundation:");
		expect(workflow).toContain("image: postgres:16");
		expect(workflow).toContain(
			"DATABASE_URL: postgresql://postgres:postgres@localhost:5432/better_ccflare_test",
		);
		expect(workflow).toContain("bun-version-file: .bun-version");
		expect(workflow).toContain(
			`run: test "$(bun --version)" = "$(tr -d '[:space:]' < .bun-version)"`,
		);
	});
});
