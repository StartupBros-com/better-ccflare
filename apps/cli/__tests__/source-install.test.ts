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
import { dirname, join, resolve } from "node:path";

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
	it("keeps product identity, support, lineage, and license in the README", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		expect(readme.startsWith("# wstack Router\n")).toBe(true);
		expect(readme).toContain(
			"https://github.com/StartupBros/wstack-router/issues",
		);
		expect(readme).toContain("https://github.com/tombii/better-ccflare");
		expect(readme).toContain("https://github.com/snipeship/ccflare");
		expect(readme).toContain("## Acknowledgements");
		expect(readme).toContain("MIT - See [LICENSE](LICENSE)");
	});

	it("connects the README agent prompt to setup and working local references", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		const prompt = readme.match(/```text\n([\s\S]*?)```/)?.[1];
		expect(prompt).toBeDefined();
		expect(prompt).toContain(
			"https://github.com/StartupBros/wstack-router/blob/main/docs/agent-setup.md",
		);
		const guide = readFileSync(join(root, "docs/agent-setup.md"), "utf8");
		for (const anchor of [
			"install-the-linux-x86_64-release",
			"install-from-source",
			"configure-claude-sdk",
		])
			expect(guide).toContain(`reference.md#${anchor}`);
		// Client-only readers need a route that does not start with installation.
		const sharedClient = "agent-setup.md#shared-client-only";
		expect(readme).toContain(`docs/${sharedClient}`);
		expect(readFileSync(join(root, "docs/index.md"), "utf8")).toContain(
			sharedClient,
		);
		const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
		for (const section of [
			"## Quick Start",
			"## Configure Claude SDK",
			"### Option 3: Remote/Headless VPS Setup (Secure Proxy)",
		]) {
			const body = reference.split(`${section}\n`)[1]?.split(/\n#{1,3} /)[0];
			expect(body, section).toContain(sharedClient);
		}
		// A moved heading or an unrebased image must not strand the setup path.
		for (const file of [
			"README.md",
			"docs/agent-setup.md",
			"docs/reference.md",
			"docs/index.md",
		]) {
			const path = join(root, file);
			const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
			const links = [
				...Array.from(text.matchAll(/\]\(([^\s)]+)\)/g), (match) => match[1]),
				...Array.from(
					text.matchAll(/(?:src|href)="([^"]+)"/g),
					(match) => match[1],
				),
			];
			for (const link of links) {
				if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
				const [relative, anchor] = link.split("#");
				const target = relative ? resolve(dirname(path), relative) : path;
				expect(existsSync(target), `${file}: ${link}`).toBe(true);
				if (!anchor || !target.endsWith(".md")) continue;
				const headings = Array.from(
					readFileSync(target, "utf8")
						.replace(/```[\s\S]*?```/g, "")
						.matchAll(/^#{1,6} (.+)$/gm),
					(match) =>
						match[1]
							.toLowerCase()
							.replace(/[^\p{L}\p{N}_ -]/gu, "")
							.replace(/ /g, "-"),
				);
				expect(headings, `${file}: ${link}`).toContain(anchor);
			}
		}
	});

	it("installs the built fork under both names and preserves legacy storage", () => {
		const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
		expect(reference).toContain(
			"git clone https://github.com/StartupBros/wstack-router.git better-ccflare\ncd better-ccflare\n",
		);
		const section = reference.split("<!-- source-install-local -->")[1];
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
