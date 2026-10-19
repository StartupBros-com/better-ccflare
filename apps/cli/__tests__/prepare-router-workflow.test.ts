import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Step = {
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
	run?: string;
	env?: Record<string, unknown>;
};
type Workflow = {
	name: string;
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	jobs: Record<
		string,
		{
			"runs-on": string;
			"timeout-minutes": number;
			permissions?: unknown;
			env?: unknown;
			steps: Step[];
		}
	>;
	env?: unknown;
};

const workflowPath = join(
	import.meta.dir,
	"../../../.github/workflows/prepare-router-artifacts.yml",
);
async function readWorkflow(): Promise<Workflow> {
	return Bun.YAML.parse(await Bun.file(workflowPath).text()) as Workflow;
}

// Configuration regression checks, not a sandbox or a proof about helper behavior.
describe("unpublished wstack Router artifact preparation workflow", () => {
	test("has a distinct name and only PR/manual triggers without inputs", async () => {
		const workflow = await readWorkflow();
		expect(workflow.name).toBe("Prepare wstack Router Artifacts");
		expect(workflow.on).toEqual({
			pull_request: null,
			workflow_dispatch: null,
		});
	});

	test("uses one bounded hosted job with read-only permissions", async () => {
		const workflow = await readWorkflow();
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(Object.keys(workflow.jobs)).toEqual(["prepare"]);
		const job = workflow.jobs.prepare;
		expect(job["runs-on"]).toBe("ubuntu-latest");
		expect(job["timeout-minutes"]).toBeGreaterThan(0);
		expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
		expect(job.permissions).toBeUndefined();
		expect(workflow.env).toBeUndefined();
		expect(job.env).toBeUndefined();
	});

	test("uses only checkout and uncached Bun setup actions", async () => {
		const { steps } = (await readWorkflow()).jobs.prepare;
		const actions = steps.filter((step) => step.uses);
		expect(actions.map((step) => step.uses)).toEqual([
			"actions/checkout@v7.0.1",
			"oven-sh/setup-bun@v2.2.0",
		]);
		expect(actions[0].with).toEqual({ "persist-credentials": false });
		expect(actions[1].with).toEqual({
			"bun-version-file": ".bun-version",
			"no-cache": true,
			token: "",
		});
	});

	test("checks the exact installed Bun before frozen dependency installation", async () => {
		const { steps } = (await readWorkflow()).jobs.prepare;
		expect(steps[0].uses).toBe("actions/checkout@v7.0.1");
		expect(steps[1].uses).toBe("oven-sh/setup-bun@v2.2.0");
		expect(steps[2].run).toBe(
			`test "$(bun --version)" = "$(tr -d '[:space:]' < .bun-version)"`,
		);
		expect(steps[3].run).toBe("bun install --frozen-lockfile");
	});

	test("invokes the helper with a fresh runner-temp output and explains its scope", async () => {
		const { steps } = (await readWorkflow()).jobs.prepare;
		const prepare = steps[4];
		expect(prepare.run).toContain(
			'preparation_root="$(mktemp -d "$RUNNER_TEMP/wstack-router.XXXXXX")"',
		);
		expect(prepare.run).toContain(
			'bun run apps/cli/prepare-router-artifacts.ts "$preparation_root/artifacts"',
		);
		expect(prepare.run).toContain("Local ephemeral preparation only");
		expect(prepare.run).toContain("not release publication");
	});

	test("has no additional publication, upload, credentials or provenance configuration", async () => {
		const workflow = await readWorkflow();
		const { steps } = workflow.jobs.prepare;
		expect(steps).toHaveLength(5);
		for (const step of steps) expect(step.env).toBeUndefined();
		const configuration = JSON.stringify(workflow);
		for (const forbidden of [
			"secrets.",
			"github.token",
			"upload-artifact",
			"actions/cache",
			"gh release",
			"gh workflow",
			"npm publish",
			"bun publish",
			"ghcr.io",
			"git push",
			"CCFLARE_BUILD_PRODUCER",
		]) {
			expect(configuration).not.toContain(forbidden);
		}
	});
});
