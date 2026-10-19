import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const workflowsDir = join(repositoryRoot, ".github/workflows");

// Every workflow that installs Bun. A new one must be added here deliberately (#321).
const PINNED_WORKFLOWS = [
	"managed-routing-postgres.yml",
	"prepare-router-artifacts.yml",
	"release.yml",
	"release-dispatch.yml",
	"router-release-artifacts.yml",
	"router-release.yml",
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

function pinnedBunVersion(): string {
	return readFileSync(join(repositoryRoot, ".bun-version"), "utf8").trim();
}

// bun.lock is JSONC (trailing commas), so JSON.parse rejects it. Match the npm
// `bun` package's resolution and its @oven/bun-* platform binaries, both their
// own resolutions and the versions `bun` asks for, by text.
function lockedBunVersions(): string[] {
	const lock = readFileSync(join(repositoryRoot, "bun.lock"), "utf8");
	return [
		...lock.matchAll(/"bun@(\d+\.\d+\.\d+)"/g),
		...lock.matchAll(/"@oven\/bun-[a-z0-9-]+(?:@|": ")(\d+\.\d+\.\d+)"/g),
	].map((match) => match[1] ?? "");
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

// setup-bun's version is not the one that builds what we ship. bun-plugin-tailwind
// peer-depends on `bun`, so `bun install` links the npm `bun` package into
// node_modules/.bin, and `bun run` puts that first on PATH. Every nested `bun` in
// a package script (`build:cli`, `build:multi`, ...) runs it, and
// `bun build --compile` embeds that runtime in every binary, prod and release
// artifacts alike. It sat at 1.3.11 from bun.lock through every .bun-version bump
// (#489, #491).
describe("nested bun resolves to .bun-version (#491)", () => {
	test("the root package.json pins the npm bun package to exactly .bun-version", () => {
		const manifest = JSON.parse(
			readFileSync(join(repositoryRoot, "package.json"), "utf8"),
		) as { devDependencies?: Record<string, string> };
		// An exact root devDependency, not `overrides`: Bun does not apply overrides
		// to an auto-installed peer, so an override leaves bun.lock on the peer's
		// old resolution.
		expect(manifest.devDependencies?.bun).toBe(pinnedBunVersion());
	});

	test("bun.lock resolves the npm bun package and its platform binaries to .bun-version", () => {
		const versions = lockedBunVersions();
		expect(versions.length).toBeGreaterThan(0);
		expect([...new Set(versions)]).toEqual([pinnedBunVersion()]);
	});
});
