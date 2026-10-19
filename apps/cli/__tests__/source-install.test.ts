import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

// This is an artifact acceptance test: run `bun run build` first, not prepublish.
// An allowlisted environment prevents developer credentials, live-test opt-ins,
// DATABASE_URL, or build/provenance overrides from reaching child processes.
describe("documented source install", () => {
	it("installs the built fork under both names and preserves legacy storage", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		expect(readme.startsWith("# wstack Router\n")).toBe(true);
		expect(readme).toContain(
			"git clone https://github.com/StartupBros/wstack-router.git better-ccflare\ncd better-ccflare\n",
		);
		expect(readme).toContain(
			"https://github.com/StartupBros/wstack-router/issues",
		);
		expect(readme).toContain("https://github.com/tombii/better-ccflare");
		expect(readme).toContain("https://github.com/snipeship/ccflare");
		expect(readme).toContain("## Acknowledgements");
		expect(readme).toContain("MIT - See [LICENSE](LICENSE)");
		const section = readme.split("<!-- source-install-local -->")[1];
		expect(section).toBeDefined();
		const commands = section.split("```bash\n")[1].split("```")[0];
		expect(existsSync(join(root, "apps/cli/dist/better-ccflare"))).toBe(true);
		const home = mkdtempSync(join(tmpdir(), "wstack-source-install-"));
		homes.push(home);
		const env = {
			HOME: home,
			PATH: "/usr/bin:/bin",
			NODE_ENV: "test",
			NO_COLOR: "1",
		};
		const installed = spawnSync(
			"/bin/bash",
			[
				"-eu",
				"-c",
				`${commands}\nprintf '\\nINSTALL_DIR=%s\\n' "$install_dir"`,
			],
			{ cwd: root, env, encoding: "utf8", timeout: 30000 },
		);
		expect(installed.status).toBe(0);
		expect(installed.stderr).toBe("");
		const bin = installed.stdout.trim().split("INSTALL_DIR=")[1];
		expect(bin).toBeDefined();
		const configDir = join(home, ".config", "better-ccflare");
		// Help/version must not create a storage namespace in a clean home.
		expect(existsSync(configDir)).toBe(false);
		mkdirSync(configDir, { recursive: true });
		const fixtures = {
			"better-ccflare.json":
				'{"default_agent_model":"synthetic-legacy-model","unrelated":{"keep":true}}\n',
			"better-ccflare.json.backup": "synthetic recovery material\n",
		};
		for (const [name, bytes] of Object.entries(fixtures))
			writeFileSync(join(configDir, name), bytes);
		const override = join(home, "override.json");
		writeFileSync(
			override,
			'{"default_agent_model":"synthetic-override-model"}\n',
		);
		for (const name of ["wstack-router", "better-ccflare"]) {
			const executable = join(bin, name);
			expect(
				readFileSync(executable).equals(
					readFileSync(join(root, "apps/cli/dist/better-ccflare")),
				),
			).toBe(true);
			for (const flag of ["--help", "--version"]) {
				const result = spawnSync(executable, [flag], {
					cwd: home,
					env,
					encoding: "utf8",
					timeout: 10000,
				});
				expect(result.status).toBe(0);
				expect(result.stdout).toContain("wstack Router");
			}
			for (const custom of [false, true]) {
				const result = spawnSync(executable, ["--get-model"], {
					cwd: home,
					env: {
						...env,
						...(custom ? { BETTER_CCFLARE_CONFIG_PATH: override } : {}),
					},
					encoding: "utf8",
					timeout: 10000,
				});
				expect(result.status).toBe(0);
				expect(result.stdout).toContain(
					custom ? "synthetic-override-model" : "synthetic-legacy-model",
				);
				expect(result.stderr).toBe("");
			}
		}
		for (const [name, bytes] of Object.entries(fixtures))
			expect(readFileSync(join(configDir, name), "utf8")).toBe(bytes);
		expect(readFileSync(override, "utf8")).toBe(
			'{"default_agent_model":"synthetic-override-model"}\n',
		);
		expect(readdirSync(join(home, ".config"))).toEqual(["better-ccflare"]);
		expect(readdirSync(configDir).sort()).toEqual(Object.keys(fixtures).sort());
	}, 60000);
});
