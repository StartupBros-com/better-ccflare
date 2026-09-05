import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const workflowsDir = join(repositoryRoot, ".github/workflows");

// Every workflow that installs Bun. A new one must be added here deliberately (#321).
const PINNED_WORKFLOWS = [
	"managed-routing-postgres.yml",
	"release.yml",
	"release-dispatch.yml",
	"signpath-release.yml",
	"signpath-test.yml",
];

type Step = Record<string, unknown>;

function readWorkflow(file: string): string {
	return readFileSync(join(workflowsDir, file), "utf8");
}

function workflowSteps(file: string): Step[] {
	const parsed = Bun.YAML.parse(readWorkflow(file)) as {
		jobs?: Record<string, { steps?: Step[] }>;
	};
	return Object.values(parsed.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function isSetupBun(step: Step): boolean {
	return typeof step.uses === "string" && step.uses.startsWith("oven-sh/setup-bun@");
}

describe("Bun toolchain pin (#321)", () => {
	test(".bun-version holds one exact version", () => {
		const pinned = readFileSync(join(repositoryRoot, ".bun-version"), "utf8");
		expect(pinned).toMatch(/^\d+\.\d+\.\d+\n$/);
	});

	test.each(PINNED_WORKFLOWS)(
		"%s installs Bun from .bun-version and verifies the install",
		(file) => {
			const steps = workflowSteps(file);
			const setupIndex = steps.findIndex(isSetupBun);
			expect(setupIndex).toBeGreaterThan(-1);

			const withBlock = (steps[setupIndex]?.with ?? {}) as Record<string, unknown>;
			expect(withBlock["bun-version-file"]).toBe(".bun-version");
			expect(withBlock).not.toHaveProperty("bun-version");

			// setup-bun only warns and falls back to `latest` when the file is missing.
			const verify = String(steps[setupIndex + 1]?.run ?? "");
			expect(verify).toContain("bun --version");
			expect(verify).toContain(".bun-version");
		},
	);

	test("no workflow floats bun-version: latest, and only the pinned workflows install Bun", () => {
		const files = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));

		const floating = files.filter((file) =>
			/bun-version:\s*['"]?latest/.test(readWorkflow(file)),
		);
		expect(floating).toEqual([]);

		const installing = files.filter((file) => workflowSteps(file).some(isSetupBun));
		expect(installing.sort()).toEqual([...PINNED_WORKFLOWS].sort());
	});
});
