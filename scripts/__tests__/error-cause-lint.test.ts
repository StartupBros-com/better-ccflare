import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const biome = resolve(root, "node_modules/.bin/biome");
const fixture = mkdtempSync(join(tmpdir(), "error-cause-lint-"));
// Exercise the real rule configuration and file overrides, outside the worktree.
// Git ignore discovery is the only setting disabled: this fixture is not a repo.
const config = JSON.parse(readFileSync(join(root, "biome.json"), "utf8"));
config.vcs.enabled = false;
writeFileSync(join(fixture, "biome.json"), JSON.stringify(config));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const previouslyExempt = [
	"packages/cli-commands/src/runner.ts",
	"packages/config/src/index.ts",
	"packages/core/src/validation.ts",
	"packages/database/src/repositories/combo.repository.ts",
	"packages/http-api/src/handlers/accounts.ts",
	"packages/http-api/src/services/device-setup-jobs.ts",
	"packages/http-common/src/client.ts",
	"packages/openai-responses-adapter/src/handler.ts",
	"packages/proxy/src/handlers/account-selector.ts",
	"packages/proxy/src/handlers/proxy-operations.ts",
	"packages/proxy/src/openai-compatible-model-catalog.ts",
];

function lint(path: string, source: string) {
	const file = join(fixture, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
	return Bun.spawnSync([biome, "lint", path], {
		cwd: fixture,
		stdout: "pipe",
		stderr: "pipe",
	});
}

it.each(previouslyExempt)("enforces cause preservation for new rethrows in %s", (path) => {
	const result = lint(path, 'try { JSON.parse("{"); } catch (error) { throw new Error(String(error)); }');
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain("lint/nursery/useErrorCause");
});

it("accepts cause-preserving rethrows and the intentional bare-catch option", () => {
	for (const source of [
		'try { JSON.parse("{"); } catch (error) { throw new Error("failed", { cause: error }); }',
		'try { JSON.parse("{"); } catch { throw new Error("redacted"); }',
	]) {
		const result = lint("packages/logger/src/cause-probe.ts", source);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).not.toContain("lint/nursery/useErrorCause");
	}
});
