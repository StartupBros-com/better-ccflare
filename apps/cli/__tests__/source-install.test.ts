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
import {
	COMMAND_NAMES,
	PRODUCT_NAME,
} from "../../../packages/core/src/product-identity";

const root = resolve(import.meta.dir, "../../..");
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

describe("documented source installer shell (synthetic artifact, not native build proof)", () => {
	it("installs all three names from the unchanged build filename into a fresh legacy directory without overwriting commands or profiles", () => {
		const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
		expect(reference).toContain(
			"git clone https://github.com/StartupBros/hov-router.git better-ccflare\ncd better-ccflare\n",
		);
		const commands = reference
			.split("<!-- source-install-local -->")[1]
			?.split("```bash\n")[1]
			?.split("```")[0];
		expect(commands).toBeDefined();
		const home = mkdtempSync(join(tmpdir(), "wstack-source-install-"));
		homes.push(home);
		const checkout = join(home, "better-ccflare");
		const built = join(checkout, "apps/cli/dist/better-ccflare");
		mkdirSync(dirname(built), { recursive: true });
		const payload = `#!/bin/sh\ncase "$1" in\n--version) printf '${PRODUCT_NAME} v1.2.3\\n';;\n--help) printf '${PRODUCT_NAME}\\n';;\n*) exit 94;;\nesac\n`;
		writeFileSync(built, payload, { mode: 0o755 });
		const previous = join(home, ".local/bin");
		mkdirSync(previous, { recursive: true });
		for (const name of COMMAND_NAMES)
			writeFileSync(join(previous, name), "keep existing command\n");
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			writeFileSync(join(home, profile), "keep profile\n");
		const config = join(home, ".config/better-ccflare");
		mkdirSync(config, { recursive: true });
		writeFileSync(join(config, "better-ccflare.json"), "keep config\n");
		writeFileSync(join(config, "better-ccflare.db"), "keep database\n");
		const installed = spawnSync(
			"/bin/bash",
			[
				"--noprofile",
				"--norc",
				"-eu",
				"-c",
				`${commands}\nprintf '\\nINSTALL_DIR=%s\\n' "$install_dir"`,
			],
			{
				cwd: checkout,
				env: { HOME: home, PATH: `${previous}:/usr/bin:/bin` },
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(installed.status, installed.stderr).toBe(0);
		const bin = installed.stdout.trim().split("INSTALL_DIR=")[1];
		expect(bin).toStartWith(join(home, ".local/wstack-router."));
		expect(readdirSync(bin).sort()).toEqual([...COMMAND_NAMES].sort());
		for (const name of COMMAND_NAMES) {
			expect(readFileSync(join(bin, name), "utf8")).toBe(payload);
			expect(readFileSync(join(previous, name), "utf8")).toBe(
				"keep existing command\n",
			);
		}
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			expect(readFileSync(join(home, profile), "utf8")).toBe("keep profile\n");
		expect(readFileSync(built, "utf8")).toBe(payload);
		expect(readFileSync(join(config, "better-ccflare.json"), "utf8")).toBe(
			"keep config\n",
		);
		expect(readFileSync(join(config, "better-ccflare.db"), "utf8")).toBe(
			"keep database\n",
		);
		expect(readdirSync(join(home, ".config"))).toEqual(["better-ccflare"]);
	});
});

// This is an artifact acceptance test: run `bun run build` first, not prepublish.
// An allowlisted environment prevents developer credentials, live-test opt-ins,
// DATABASE_URL, or build/provenance overrides from reaching child processes.
describe("documented source install", () => {
	it("keeps product identity, support, lineage, and license in the README", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		expect(readme.startsWith(`# ${PRODUCT_NAME}\n`)).toBe(true);
		expect(readme).toContain(
			"https://github.com/StartupBros/hov-router/issues",
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
			"https://github.com/StartupBros/hov-router/blob/main/docs/agent-setup.md",
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

	it("installs the built fork under all three names with identical version/source evidence and config behavior while preserving legacy storage", () => {
		const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
		expect(reference).toContain(
			"git clone https://github.com/StartupBros/hov-router.git better-ccflare\ncd better-ccflare\n",
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
				"--noprofile",
				"--norc",
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
		const version = JSON.parse(
			readFileSync(join(root, "apps/cli/package.json"), "utf8"),
		).version;
		const sourceEvidence = spawnSync(
			join(root, "apps/cli/dist/better-ccflare"),
			["--git-sha"],
			{ cwd: home, env, encoding: "utf8", timeout: 10000 },
		);
		expect(sourceEvidence.error).toBeUndefined();
		expect(sourceEvidence.status).not.toBeNull();
		expect(readdirSync(bin).sort()).toEqual([...COMMAND_NAMES].sort());
		const configOutputs = new Map<boolean, string>();
		for (const name of COMMAND_NAMES) {
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
				expect(result.stdout).toContain(PRODUCT_NAME);
				if (flag === "--version")
					expect(result.stdout.trim()).toBe(`${PRODUCT_NAME} v${version}`);
			}
			const evidence = spawnSync(executable, ["--git-sha"], {
				cwd: home,
				env,
				encoding: "utf8",
				timeout: 10000,
			});
			expect(evidence.error).toBeUndefined();
			expect([evidence.status, evidence.stdout, evidence.stderr]).toEqual([
				sourceEvidence.status,
				sourceEvidence.stdout,
				sourceEvidence.stderr,
			]);
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
				const previousOutput = configOutputs.get(custom);
				if (previousOutput === undefined)
					configOutputs.set(custom, result.stdout);
				else expect(result.stdout).toBe(previousOutput);
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
