import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const originalHomes = process.env.CCFLARE_EXTERNAL_CODEX_HOMES;
const originalCloud = process.env.CCFLARE_EXTERNAL_CODEX_CLOUD_ROOTS;
const dirs: string[] = [];
afterEach(() => {
	if (originalHomes === undefined)
		delete process.env.CCFLARE_EXTERNAL_CODEX_HOMES;
	else process.env.CCFLARE_EXTERNAL_CODEX_HOMES = originalHomes;
	if (originalCloud === undefined)
		delete process.env.CCFLARE_EXTERNAL_CODEX_CLOUD_ROOTS;
	else process.env.CCFLARE_EXTERNAL_CODEX_CLOUD_ROOTS = originalCloud;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function config() {
	const dir = mkdtempSync(join(tmpdir(), "external-config-"));
	dirs.push(dir);
	return new Config(join(dir, "config.json"));
}
test("external sources default off and persist both source settings", () => {
	delete process.env.CCFLARE_EXTERNAL_CODEX_HOMES;
	delete process.env.CCFLARE_EXTERNAL_CODEX_CLOUD_ROOTS;
	const c = config();
	expect(c.getExternalCodexHomes()).toEqual([]);
	expect(c.getExternalCodexCloudRoots()).toEqual([]);
	c.setExternalCodexHomes(["/rollouts"]);
	c.setExternalCodexCloudRoots([{ accountName: "primary", path: "/cloud" }]);
	expect(c.getExternalCodexHomes()).toEqual(["/rollouts"]);
	expect(c.getExternalCodexCloudRoots()).toEqual([
		{ accountName: "primary", path: "/cloud" },
	]);
	expect(c.getAllSettings().external_codex_homes).toEqual("/rollouts");
	const reloaded = new Config(join(dirs[dirs.length - 1], "config.json"));
	expect(reloaded.getExternalCodexHomes()).toEqual(["/rollouts"]);
	expect(reloaded.getExternalCodexCloudRoots()).toEqual([
		{ accountName: "primary", path: "/cloud" },
	]);
});
test("env source settings override persisted sources, including explicit empty disable", () => {
	const c = config();
	c.setExternalCodexHomes(["/saved"]);
	process.env.CCFLARE_EXTERNAL_CODEX_HOMES = " /one, /two ,";
	process.env.CCFLARE_EXTERNAL_CODEX_CLOUD_ROOTS = "main=/cloud=1,alt=/other";
	expect(c.getExternalCodexHomes()).toEqual(["/one", "/two"]);
	expect(c.getExternalCodexCloudRoots()).toEqual([
		{ accountName: "main", path: "/cloud=1" },
		{ accountName: "alt", path: "/other" },
	]);
	process.env.CCFLARE_EXTERNAL_CODEX_HOMES = "";
	expect(c.getExternalCodexHomes()).toEqual([]);
});
test("invalid cloud mappings fail closed instead of guessing an account", () => {
	process.env.CCFLARE_EXTERNAL_CODEX_CLOUD_ROOTS = "/unmapped,main=/valid";
	const c = config();
	expect(c.getExternalCodexCloudRoots()).toEqual([
		{ accountName: "main", path: "/valid" },
	]);
	expect(c.getInvalidExternalCodexCloudRoots()).toEqual(["/unmapped"]);
	expect(c.getAllSettings().external_codex_cloud_roots).toBe(
		"/unmapped,main=/valid",
	);
});
