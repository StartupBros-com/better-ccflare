import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMMAND_NAMES } from "../../../packages/core/src/product-identity";

const root = resolve(import.meta.dir, "../../..");
const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
const releaseGuide = readFileSync(
	join(root, "docs/wstack-router-releases.md"),
	"utf8",
);
const releaseDigest =
	"b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7";
const releaseUrl =
	"https://github.com/StartupBros/hov-router/releases/download/v3.6.2/better-ccflare-linux-amd64";
const sourceSha = "5d7b2a888a9b61d87916332b414e46606498d896";
// Synthetic download only: this is not proof of the real published release.
// Only the expected digest is substituted; Bash and sha256sum remain real.
const payload = `#!/bin/sh
printf 'executed\\n' >> "$HOME/executed"
case "$1" in
  --help) printf 'wstack Router\\n';;
  --version) printf 'wstack Router v3.6.2\\n';;
  --git-sha) printf '${sourceSha}\\n';;
esac
`;
const fixtureDigest = createHash("sha256").update(payload).digest("hex");
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function block(marker: string) {
	const document =
		marker === "router-release-provenance" ? releaseGuide : reference;
	const section = document.split(`<!-- ${marker} -->`)[1];
	expect(section, `reference block ${marker}`).toBeDefined();
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
	writeFileSync(join(home, "bundle-fixture"), "synthetic attestation bundle\n");
	for (const profile of [".profile", ".bashrc", ".zshrc"])
		writeFileSync(join(home, profile), "keep profile\n");
	// This stand-in is transport. Record every request and honor --output;
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
	// A strict policy stand-in, not a cryptographic verifier. The real checksum
	// and extracted documentation run unchanged except for the fixture digest.
	writeFileSync(
		join(tools, "gh"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$HOME/attestations"
binary="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"
bundle="$PWD/sha256:${fixtureDigest}.jsonl"
case "$1 $2" in
  'attestation download')
    [ "$#" -eq 5 ] && [ "$3" = "$binary" ] && [ "$4" = --repo ] && [ "$5" = StartupBros/hov-router ] || exit 91
    [ "$DOWNLOAD_MODE" != attestation-fail ] || exit 22
    cp "$HOME/bundle-fixture" "$bundle"
    if [ "$DOWNLOAD_MODE" = bad-bundle ]; then printf 'corrupt\\n' > "$bundle"; fi
    ;;
  'attestation verify')
    expected=(attestation verify "$binary" --repo StartupBros/wstack-router
      --source-digest ${sourceSha} --source-ref refs/tags/v3.6.2
      --cert-identity https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2
      --signer-digest ${sourceSha} --deny-self-hosted-runners --bundle "$bundle")
    [ "$#" -eq "\${#expected[@]}" ] || exit 92
    for arg in "\${expected[@]}"; do [ "$1" = "$arg" ] || exit 92; shift; done
    cmp "$HOME/bundle-fixture" "$bundle"
    printf '%s  %s\\n' '${fixtureDigest}' "$binary" | sha256sum --check --strict -
    ;;
  *) exit 93 ;;
esac
`,
		{ mode: 0o755 },
	);
	return {
		home,
		binary: join(home, ".local/lib/wstack-router/3.6.2/wstack-router"),
		versionDir: join(home, ".local/lib/wstack-router/3.6.2"),
		binDir: join(home, ".local/bin"),
		run(marker: string, rewrite = (script: string) => script, thenRun = false) {
			const script = rewrite(
				block(marker).replaceAll(releaseDigest, fixtureDigest),
			);
			return spawnSync(
				"/bin/bash",
				[
					"--noprofile",
					"--norc",
					"-eu",
					"-c",
					script + (thenRun ? `\n${block("router-release-run")}` : ""),
				],
				{
					cwd: home,
					env: {
						HOME: home,
						TMPDIR: home,
						PATH: `${tools}:/usr/bin:/bin`,
						DOWNLOAD_MODE: mode,
					},
					encoding: "utf8",
					timeout: 10000,
				},
			);
		},
	};
}

describe("documented binary install (synthetic downloads)", () => {
	it("offers the full pinned provenance policy before the first run", () => {
		const link =
			"wstack-router-releases.md#optional-consumer-provenance-verification";
		expect(reference.indexOf(link)).toBeGreaterThan(0);
		expect(reference.indexOf(link)).toBeLessThan(
			reference.indexOf("<!-- router-release-run -->"),
		);
		const policy = block("router-release-provenance");
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
			"retrieval_repo=StartupBros/hov-router",
			'gh attestation download "$binary" --repo "$retrieval_repo"',
			'--bundle "$bundle_dir/sha256:$digest.jsonl"',
		])
			expect(policy).toContain(pin);
		for (const document of [reference, releaseGuide]) {
			expect(document.replace(/\s+/g, " ")).toContain(
				"renamed from `StartupBros/wstack-router` on 2026-10-21",
			);
			expect(document).toContain("`StartupBros/hov-router`");
			expect(document).toContain("1278801682");
			expect(document).not.toContain("Before the repository rename");
		}
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

	it("creates all three optional command aliases to the same verified binary without running it", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of COMMAND_NAMES) {
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
			expect(readFileSync(join(f.binDir, name), "utf8")).toBe(payload);
		}
		expect(readdirSync(f.binDir).sort()).toEqual([...COMMAND_NAMES].sort());
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			expect(readFileSync(join(f.home, profile), "utf8")).toBe(
				"keep profile\n",
			);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("keeps exact historical output and source SHA through all three installed aliases (fixture)", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of COMMAND_NAMES) {
			for (const [flag, output] of [
				["--version", "wstack Router v3.6.2\n"],
				["--git-sha", `${sourceSha}\n`],
			]) {
				const result = spawnSync(join(f.binDir, name), [flag], {
					cwd: f.home,
					env: { HOME: f.home, PATH: "/usr/bin:/bin" },
					encoding: "utf8",
					timeout: 10000,
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toBe(output);
			}
		}
	});

	for (const name of COMMAND_NAMES) {
		it.each([
			"file",
			"symlink",
			"broken symlink",
			"directory",
		])(`refuses an existing ${name} (%s) before creating any missing alias`, (kind) => {
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
			const before = lstatSync(collision);
			const result = f.run("router-release-path");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Refusing existing command:");
			expect(lstatSync(collision).ino).toBe(before.ino);
			if (kind === "file") expect(readFileSync(collision, "utf8")).toBe("keep");
			else if (kind === "symlink")
				expect(readlinkSync(collision)).toBe(f.binary);
			else if (kind === "broken symlink")
				expect(readlinkSync(collision)).toBe("missing-command");
			else {
				expect(readFileSync(join(collision, "sentinel"), "utf8")).toBe("keep");
				expect(readdirSync(collision)).toEqual(["sentinel"]);
			}
			for (const other of COMMAND_NAMES.filter((alias) => alias !== name))
				expect(() => lstatSync(join(f.binDir, other))).toThrow();
			expect(readFileSync(f.binary, "utf8")).toBe(payload);
		});
	}
});

describe("documented historical provenance (synthetic policy fixture, not cryptographic proof)", () => {
	it("retrieves at the intended home and verifies the same local bundle under the exact old identity before execution", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		const verified = f.run("router-release-provenance");
		expect(verified.status, verified.stderr).toBe(0);
		const calls = readFileSync(join(f.home, "attestations"), "utf8")
			.trim()
			.split("\n");
		expect(calls).toHaveLength(2);
		expect(calls[0]).toBe(
			`attestation download ${f.binary} --repo StartupBros/hov-router`,
		);
		expect(calls[1]).toStartWith(
			`attestation verify ${f.binary} --repo StartupBros/wstack-router `,
		);
		expect(calls[1]).toContain(`--bundle `);
		expect(calls[1]).toEndWith(`/sha256:${fixtureDigest}.jsonl`);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
		expect(f.run("router-release-run").status).toBe(0);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("pins historical release and asset evidence independently of the new display name", () => {
		for (const pin of [
			"418096444",
			sourceSha,
			"refs/tags/v3.6.2",
			"658578101",
			"97965536",
			releaseDigest,
			"658578455",
			"a90aa5f71ba5ae9f4b255e487c2afc80f39d44bc70a6193da43d83f4b05dc60b",
			"658577847",
			"dee851d757ec92a28946c838a11919d34bf2fc4755613e67b34bd1e3cdf70b29",
		])
			expect(releaseGuide).toContain(pin);
		expect(reference).toContain("wstack Router v3.6.2");
		expect(releaseGuide).toContain("v1:startupbros-wstack-router-binary");
	});

	it("rejects changed binary bytes before bundle retrieval or execution", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		writeFileSync(f.binary, "tampered bytes\n");
		expect(f.run("router-release-provenance", undefined, true).status).not.toBe(
			0,
		);
		expect(existsSync(join(f.home, "attestations"))).toBe(false);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	for (const mode of ["attestation-fail", "bad-bundle"]) {
		it(`stops on ${mode} before execution`, () => {
			const f = fixture(mode);
			expect(f.run("router-release-install").status).toBe(0);
			expect(
				f.run("router-release-provenance", undefined, true).status,
			).not.toBe(0);
			const calls = readFileSync(join(f.home, "attestations"), "utf8")
				.trim()
				.split("\n");
			expect(calls).toHaveLength(mode === "attestation-fail" ? 1 : 2);
			expect(existsSync(join(f.home, "executed"))).toBe(false);
		});
	}

	for (const [label, from, to] of [
		[
			"new verification repository",
			"--repo StartupBros/wstack-router",
			"--repo StartupBros/hov-router",
		],
		[
			"owner-only policy",
			"--repo StartupBros/wstack-router",
			"--owner StartupBros",
		],
		[
			"new certificate",
			"--cert-identity https://github.com/StartupBros/wstack-router/",
			"--cert-identity https://github.com/StartupBros/hov-router/",
		],
		[
			"short source SHA",
			'--source-digest "$source_sha"',
			`--source-digest ${sourceSha.slice(0, 7)}`,
		],
		[
			"wrong signer SHA",
			'--signer-digest "$source_sha"',
			`--signer-digest ${"b".repeat(40)}`,
		],
		[
			"wrong tag",
			"--source-ref refs/tags/v3.6.2",
			"--source-ref refs/heads/main",
		],
		["self-hosted runner allowance", "--deny-self-hosted-runners", ""],
		[
			"different bundle",
			'--bundle "$bundle_dir/sha256:$digest.jsonl"',
			'--bundle "$bundle_dir/other.jsonl"',
		],
	] as const) {
		it(`rejects ${label} before execution`, () => {
			const f = fixture();
			expect(f.run("router-release-install").status).toBe(0);
			expect(block("router-release-provenance")).toContain(from);
			const result = f.run(
				"router-release-provenance",
				(script) => script.replace(from, to),
				true,
			);
			expect(result.status).not.toBe(0);
			expect(existsSync(join(f.home, "executed"))).toBe(false);
		});
	}
});
