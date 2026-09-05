import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

const CANARY_WORKFLOW = "bun-latest-canary.yml";
const GATE_WORKFLOW = "managed-routing-postgres.yml";
const GATE_ACTION = ".github/actions/managed-routing-gate/action.yml";

// The exact set of workflows besides the canary that install Bun. A new
// workflow that installs Bun must be added here deliberately (#321).
const EXPECTED_PINNED_WORKFLOW_BASENAMES = [
	"managed-routing-postgres",
	"release",
	"release-dispatch",
	"signpath-release",
	"signpath-test",
] as const;

type YamlStep = Record<string, unknown>;

function readRepositoryFile(path: string): string {
	return readFileSync(join(repositoryRoot, path), "utf8");
}

function parseYamlFile(path: string): Record<string, unknown> {
	return Bun.YAML.parse(readRepositoryFile(path)) as Record<string, unknown>;
}

function listWorkflowFiles(): string[] {
	const dir = join(repositoryRoot, ".github/workflows");
	return readdirSync(dir)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()
		.map((name) => `.github/workflows/${name}`);
}

// Recursively finds every action.yml/action.yaml under .github/actions,
// relative to the repository root. Returns [] if the directory does not
// exist yet (another agent may not have created it yet while this test is
// being written).
function listActionFiles(): string[] {
	const root = join(repositoryRoot, ".github/actions");
	if (!existsSync(root)) return [];

	const found: string[] = [];
	const walk = (dir: string, relDir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), relPath);
			} else if (entry.name === "action.yml" || entry.name === "action.yaml") {
				found.push(`.github/actions/${relPath}`);
			}
		}
	};
	walk(root, "");
	return found.sort();
}

// Recursively lists every file under a repository-relative directory,
// returning paths relative to the repository root.
function listAllFilesUnder(relDir: string): string[] {
	const root = join(repositoryRoot, relDir);
	const found: string[] = [];
	const walk = (dir: string, rel: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), relPath);
			} else {
				found.push(`${relDir}/${relPath}`);
			}
		}
	};
	walk(root, "");
	return found;
}

function jobsOf(workflow: Record<string, unknown>): Record<string, any> {
	return (workflow.jobs ?? {}) as Record<string, any>;
}

function stepsOfSingleJob(workflow: Record<string, unknown>): YamlStep[] {
	const jobs = Object.values(jobsOf(workflow));
	expect(jobs.length).toBe(1);
	return (jobs[0].steps ?? []) as YamlStep[];
}

function isSetupBunStep(step: YamlStep): boolean {
	return (
		typeof step.uses === "string" &&
		(step.uses as string).startsWith("oven-sh/setup-bun@")
	);
}

// Collects every oven-sh/setup-bun step across all workflow jobs and every
// composite action's steps, tagged with the file it came from.
function collectSetupBunSteps(): { file: string; step: YamlStep }[] {
	const files = [...listWorkflowFiles(), ...listActionFiles()];
	const found: { file: string; step: YamlStep }[] = [];

	for (const file of files) {
		const parsed = parseYamlFile(file);
		const stepLists: YamlStep[][] = [];

		for (const job of Object.values(jobsOf(parsed))) {
			if (Array.isArray(job?.steps)) stepLists.push(job.steps as YamlStep[]);
		}

		const runs = parsed.runs as { steps?: YamlStep[] } | undefined;
		if (Array.isArray(runs?.steps)) stepLists.push(runs.steps as YamlStep[]);

		for (const steps of stepLists) {
			for (const step of steps) {
				if (isSetupBunStep(step)) found.push({ file, step });
			}
		}
	}

	return found;
}

function basenameWithoutExtension(file: string): string {
	const name = file.split("/").pop() ?? file;
	return name.replace(/\.ya?ml$/, "");
}

describe("Bun toolchain pin (#321)", () => {
	test(".bun-version pins an exact patch version satisfying package.json engines.bun", () => {
		const raw = readRepositoryFile(".bun-version");
		expect(raw).toMatch(/^\d+\.\d+\.\d+\n$/);

		const pinned = raw
			.trim()
			.split(".")
			.map((part) => Number.parseInt(part, 10));

		const pkg = JSON.parse(readRepositoryFile("package.json")) as {
			engines?: { bun?: string };
		};
		const engineRange = pkg.engines?.bun;
		expect(typeof engineRange).toBe("string");

		const match = (engineRange as string).match(/^>=(\d+)\.(\d+)\.(\d+)$/);
		expect(match).not.toBeNull();
		const lowerBound = [match![1], match![2], match![3]].map((part) =>
			Number.parseInt(part, 10),
		);

		let comparison = 0;
		for (let i = 0; i < 3; i++) {
			if (pinned[i] !== lowerBound[i]) {
				comparison = pinned[i] - lowerBound[i];
				break;
			}
		}

		expect(comparison).toBeGreaterThanOrEqual(0);
	});

	test("every oven-sh/setup-bun step is pinned via .bun-version, except the canary's floating install", () => {
		const setupBunSteps = collectSetupBunSteps();
		expect(setupBunSteps.length).toBeGreaterThan(0);

		const nonCanaryBasenames = new Set<string>();

		for (const { file, step } of setupBunSteps) {
			const withBlock = (step.with ?? {}) as Record<string, unknown>;

			if (file.endsWith(`/${CANARY_WORKFLOW}`)) {
				expect(withBlock["bun-version"]).toBe(
					"${{ inputs.bun-version || 'latest' }}",
				);
				expect(withBlock).not.toHaveProperty("bun-version-file");
			} else {
				expect(withBlock["bun-version-file"]).toBe(".bun-version");
				expect(withBlock).not.toHaveProperty("bun-version");
				nonCanaryBasenames.add(basenameWithoutExtension(file));
			}
		}

		expect([...nonCanaryBasenames].sort()).toEqual(
			[...EXPECTED_PINNED_WORKFLOW_BASENAMES].sort(),
		);
	});

	test("no file under .github other than the canary floats bun-version: latest", () => {
		const offenders = listAllFilesUnder(".github").filter((file) => {
			if (file.endsWith(`/${CANARY_WORKFLOW}`)) return false;
			const content = readRepositoryFile(file);
			return /bun-version:\s*['"]?latest/.test(content);
		});

		expect(offenders).toEqual([]);
	});

	test("each pinned workflow asserts installed Bun matches .bun-version immediately after Setup Bun", () => {
		for (const basename of EXPECTED_PINNED_WORKFLOW_BASENAMES) {
			const file = `.github/workflows/${basename}.yml`;
			const parsed = parseYamlFile(file);
			const steps = stepsOfSingleJob(parsed);

			const setupIndex = steps.findIndex(isSetupBunStep);
			expect(setupIndex).not.toBe(-1);

			const nextStep = steps[setupIndex + 1];
			expect(nextStep).toBeDefined();

			const run = String(nextStep?.run ?? "");
			expect(run).toContain("bun --version");
			expect(run).toContain(".bun-version");
		}
	});

	test("bun-latest-canary.yml has the non-blocking canary's triggers and permissions", () => {
		const parsed = parseYamlFile(`.github/workflows/${CANARY_WORKFLOW}`);
		const on = (parsed.on ?? {}) as Record<string, unknown>;

		expect(Object.keys(on).sort()).toEqual(
			["push", "schedule", "workflow_dispatch"].sort(),
		);
		expect(on).not.toHaveProperty("pull_request");

		const push = on.push as { branches?: unknown; paths?: unknown };
		expect(push.branches).toEqual(["main"]);
		expect(Array.isArray(push.paths)).toBe(true);
		expect((push.paths as unknown[]).length).toBeGreaterThan(0);

		expect(parsed.permissions).toEqual({ contents: "read", issues: "write" });
	});

	test("bun-latest-canary.yml runs the gate on drift and always reports through !cancelled()", () => {
		const parsed = parseYamlFile(`.github/workflows/${CANARY_WORKFLOW}`);
		const steps = stepsOfSingleJob(parsed);

		const gateStep = steps.find(
			(step) => step.uses === "./.github/actions/managed-routing-gate",
		);
		expect(gateStep).toBeDefined();
		expect(gateStep?.if).toBe("steps.drift.outputs.drift == 'true'");

		const reportStep = steps.find(
			(step) =>
				typeof step.run === "string" &&
				(step.run as string).includes("scripts/bun-latest-canary-report.sh"),
		);
		expect(reportStep).toBeDefined();
		expect(String(reportStep?.if ?? "")).toContain("!cancelled()");
	});

	test("managed-routing-postgres.yml keeps its identity, pull_request trigger, step order, and postgres service parity with the canary", () => {
		const gate = parseYamlFile(`.github/workflows/${GATE_WORKFLOW}`);
		expect(gate.name).toBe("Managed Routing Foundation Gate");
		expect(jobsOf(gate)).toHaveProperty("managed-routing-foundation");

		const on = (gate.on ?? {}) as Record<string, unknown>;
		expect(on).toHaveProperty("pull_request");

		const steps = stepsOfSingleJob(gate);
		expect(steps[0]?.name).toBe("Checkout code");
		expect(steps[0]?.uses).toBe("actions/checkout@v5");
		expect(isSetupBunStep(steps[1] ?? {})).toBe(true);
		expect(String(steps[2]?.run ?? "")).toContain("bun --version");
		expect(String(steps[2]?.run ?? "")).toContain(".bun-version");
		expect(steps[3]?.uses).toBe("./.github/actions/managed-routing-gate");

		const canary = parseYamlFile(`.github/workflows/${CANARY_WORKFLOW}`);
		const gatePostgres = jobsOf(gate)["managed-routing-foundation"].services
			.postgres;
		const canaryJobs = Object.values(jobsOf(canary));
		expect(canaryJobs.length).toBe(1);
		const canaryPostgres = canaryJobs[0].services.postgres;

		expect(gatePostgres).toEqual(canaryPostgres);
	});

	test("the managed-routing-gate composite action shares the gate's exact steps with shell: bash added", () => {
		const action = parseYamlFile(GATE_ACTION);
		const runs = action.runs as { using?: unknown; steps?: YamlStep[] };
		expect(runs.using).toBe("composite");

		const steps = runs.steps ?? [];
		expect(steps.length).toBeGreaterThan(0);
		for (const step of steps) {
			expect(step.shell).toBe("bash");
		}

		const expectedNames = [
			"Install dependencies",
			"Build CLI generated modules",
			"Build dashboard generated modules",
			"Run focused managed-routing database tests",
			"Run must-run PostgreSQL migration tests",
			"Run focused PostgreSQL integration tests",
			"Run full test suite",
			"Run lint",
			"Run typecheck",
			"Run format",
			"Verify lint and format left the checkout clean",
		];
		expect(steps.map((step) => step.name)).toEqual(expectedNames);

		const pgMigrationStep = steps.find(
			(step) => step.name === "Run must-run PostgreSQL migration tests",
		);
		expect(pgMigrationStep).toBeDefined();

		const env = (pgMigrationStep?.env ?? {}) as Record<string, unknown>;
		expect(env.CCFLARE_REQUIRE_LIVE_PG_MIGRATIONS).toBe("true");
		expect(String(pgMigrationStep?.run ?? "")).toContain(
			'test "${DATABASE_URL#*://*:*@}" = "localhost:5432/better_ccflare_test"',
		);
	});

	test("auto-rerun-failed.yml excludes the Bun Latest Canary workflow from reruns", () => {
		const parsed = parseYamlFile(".github/workflows/auto-rerun-failed.yml");
		const steps = stepsOfSingleJob(parsed);

		const runBodies = steps.map((step) => String(step.run ?? ""));
		const arrayStepRun = runBodies.find((body) =>
			body.includes("EXCLUDED_WORKFLOWS="),
		);
		expect(arrayStepRun).toBeDefined();

		const arrayMatch = arrayStepRun?.match(
			/EXCLUDED_WORKFLOWS=\(([\s\S]*?)\n\s*\)/,
		);
		expect(arrayMatch).not.toBeNull();
		expect(arrayMatch?.[1]).toContain('"Bun Latest Canary"');
	});

	test("scripts/bun-latest-canary-report.sh exists and is executable", () => {
		const stats = statSync(join(repositoryRoot, "scripts/bun-latest-canary-report.sh"));
		expect(stats.mode & 0o111).not.toBe(0);
	});
});
