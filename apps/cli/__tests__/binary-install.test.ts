import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const releaseDigest =
	"b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7";
const releaseUrl =
	"https://github.com/StartupBros/wstack-router/releases/download/v3.6.2/better-ccflare-linux-amd64";
// Synthetic download only: this is not proof of the real published release.
// Only the expected digest is substituted; Bash and sha256sum remain real.
const payload = '#!/bin/sh\nprintf "executed\\n" >> "$HOME/executed"\n';
const fixtureDigest = createHash("sha256").update(payload).digest("hex");
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function block(marker: string) {
	const section = readme.split(`<!-- ${marker} -->`)[1];
	expect(section, `README block ${marker}`).toBeDefined();
	return section
		.split(`<!-- /${marker} -->`)[0]
		.split("```bash\n")[1]
		.split("```")[0];
}

function fixture(mode = "ok") {
	const home = mkdtempSync(join(tmpdir(), "wstack-binary-install-"));
	homes.push(home);
	const tools = join(home, "tools");
	mkdirSync(tools);
	writeFileSync(join(home, "payload"), payload);
	// The only stand-in is transport. Record every request and honor --output;
	// no network, provider requests, credential environment, or fake checksum pass.
	writeFileSync(
		join(tools, "curl"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$HOME/downloads"
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift ;;
  esac
  shift
done
case "$DOWNLOAD_MODE" in
  fail) exit 22 ;;
  corrupt) printf 'corrupt\\n' > "$output" ;;
  *) cp "$HOME/payload" "$output" ;;
esac
`,
		{ mode: 0o755 },
	);
	return {
		home,
		binary: join(home, ".local/lib/wstack-router/3.6.2/wstack-router"),
		versionDir: join(home, ".local/lib/wstack-router/3.6.2"),
		binDir: join(home, ".local/bin"),
		run(marker: string) {
			const script = block(marker).replace(releaseDigest, fixtureDigest);
			return spawnSync("/bin/bash", ["-c", script], {
				cwd: home,
				env: {
					HOME: home,
					PATH: `${tools}:/usr/bin:/bin`,
					DOWNLOAD_MODE: mode,
				},
				encoding: "utf8",
				timeout: 10000,
			});
		},
	};
}

describe("documented binary install (synthetic downloads)", () => {
	it("offers the full pinned provenance policy before the first run", () => {
		const link =
			"docs/wstack-router-releases.md#optional-consumer-provenance-verification";
		expect(readme.indexOf(link)).toBeGreaterThan(0);
		expect(readme.indexOf(link)).toBeLessThan(
			readme.indexOf("<!-- router-release-run -->"),
		);
		const guide = readFileSync(
			join(root, "docs/wstack-router-releases.md"),
			"utf8",
		);
		const policy = guide
			.split("<!-- router-release-provenance -->")[1]
			?.split("<!-- /router-release-provenance -->")[0];
		expect(policy).toBeDefined();
		// This checks documented policy, not live GitHub signatures or authenticity.
		for (const pin of [
			"source_sha=5d7b2a888a9b61d87916332b414e46606498d896",
			'gh attestation verify "$binary"',
			"--repo StartupBros/wstack-router",
			'--source-digest "$source_sha"',
			"--source-ref refs/tags/v3.6.2",
			"--cert-identity https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2",
			'--signer-digest "$source_sha"',
			"--deny-self-hosted-runners",
		])
			expect(policy).toContain(pin);
	});

	it("downloads one pinned binary, verifies it, and waits for a separate run step", () => {
		const commands = block("router-release-install");
		expect(commands).not.toMatch(/\b(gh|node|bun)\b/);
		expect(commands.trim().split("\n").length).toBeLessThanOrEqual(15);
		expect(commands).toContain(releaseDigest);
		expect(commands).toContain(releaseUrl);
		const f = fixture();
		const result = f.run("router-release-install");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("wstack-router: OK");
		expect(readFileSync(f.binary, "utf8")).toBe(payload);
		expect(statSync(f.binary).mode & 0o100).toBe(0o100);
		expect(
			readFileSync(join(f.home, "downloads"), "utf8").trim().split("\n"),
		).toHaveLength(1);
		expect(readFileSync(join(f.home, "downloads"), "utf8")).toContain(
			releaseUrl,
		);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
		expect(existsSync(f.binDir)).toBe(false);
		expect(f.run("router-release-run").status).toBe(0);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("rejects corrupt bytes before granting executable permissions", () => {
		const f = fixture("corrupt");
		const result = f.run("router-release-install");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("wstack-router: FAILED");
		expect(statSync(f.binary).mode & 0o111).toBe(0);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("stops when the download fails", () => {
		const f = fixture("fail");
		const result = f.run("router-release-install");
		expect(result.status).toBe(22);
		expect(result.stdout).not.toContain("OK");
		expect(existsSync(f.binary)).toBe(false);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it.each([
		"directory",
		"symlink",
		"broken symlink",
		"file",
	])("preserves an existing version path (%s) without downloading", (kind) => {
		const f = fixture();
		mkdirSync(join(f.home, ".local/lib/wstack-router"), { recursive: true });
		const target = join(f.home, "previous-install");
		mkdirSync(target);
		writeFileSync(join(target, "sentinel"), "keep");
		if (kind === "directory") {
			mkdirSync(f.versionDir);
			writeFileSync(join(f.versionDir, "sentinel"), "keep");
		} else if (kind === "file") {
			writeFileSync(f.versionDir, "keep");
		} else {
			symlinkSync(
				kind === "symlink" ? target : `${target}-missing`,
				f.versionDir,
			);
		}
		const before = lstatSync(f.versionDir);
		expect(f.run("router-release-install").status).not.toBe(0);
		expect(lstatSync(f.versionDir).ino).toBe(before.ino);
		if (kind === "directory")
			expect(readFileSync(join(f.versionDir, "sentinel"), "utf8")).toBe("keep");
		else if (kind === "file")
			expect(readFileSync(f.versionDir, "utf8")).toBe("keep");
		else
			expect(readlinkSync(f.versionDir)).toBe(
				kind === "symlink" ? target : `${target}-missing`,
			);
		expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
		expect(existsSync(join(target, "wstack-router"))).toBe(false);
		expect(existsSync(join(f.home, "downloads"))).toBe(false);
	});

	it("creates both optional command aliases without running the binary", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of ["wstack-router", "better-ccflare"]) {
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
			expect(readFileSync(join(f.binDir, name), "utf8")).toBe(payload);
		}
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	for (const name of ["wstack-router", "better-ccflare"]) {
		it.each([
			"file",
			"symlink",
			"broken symlink",
			"directory",
		])(`refuses an existing ${name} (%s) before creating either alias`, (kind) => {
			const f = fixture();
			expect(f.run("router-release-install").status).toBe(0);
			mkdirSync(f.binDir, { recursive: true });
			const collision = join(f.binDir, name);
			if (kind === "file") writeFileSync(collision, "keep");
			else if (kind === "symlink") symlinkSync(f.binary, collision);
			else if (kind === "broken symlink")
				symlinkSync("missing-command", collision);
			else {
				mkdirSync(collision);
				writeFileSync(join(collision, "sentinel"), "keep");
			}
			const result = f.run("router-release-path");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Refusing existing command:");
			if (kind === "file") expect(readFileSync(collision, "utf8")).toBe("keep");
			else if (kind === "symlink")
				expect(readlinkSync(collision)).toBe(f.binary);
			else if (kind === "broken symlink")
				expect(readlinkSync(collision)).toBe("missing-command");
			else {
				expect(readFileSync(join(collision, "sentinel"), "utf8")).toBe("keep");
				expect(existsSync(join(collision, "wstack-router"))).toBe(false);
			}
			const other =
				name === "wstack-router" ? "better-ccflare" : "wstack-router";
			expect(() => lstatSync(join(f.binDir, other))).toThrow();
			expect(readFileSync(f.binary, "utf8")).toBe(payload);
		});
	}
});
