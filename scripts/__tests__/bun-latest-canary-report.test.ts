import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const reportScript = join(repoRoot, "scripts", "bun-latest-canary-report.sh");
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-bun-canary-test-"));
	tempDirs.push(dir);
	return dir;
}

type GhLogEntry = { args: string[]; bodyFile: string };

function readGhLog(logPath: string): GhLogEntry[] {
	let raw: string;
	try {
		raw = readFileSync(logPath, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as GhLogEntry);
}

/**
 * Writes a stub `gh` binary into a fresh bin dir. Every invocation is logged
 * as one JSON line (args + the contents of any --body-file) to
 * CCFLARE_TEST_GH_LOG so tests can assert exactly which gh subcommands ran
 * and what body they were given.
 */
function writeGhStub(dir: string): string {
	const binDir = join(dir, "bin");
	mkdirSync(binDir);
	const stub = join(binDir, "gh");
	writeFileSync(
		stub,
		[
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			"",
			"body_file=\"\"",
			'for ((i = 1; i <= $#; i++)); do',
			'  if [[ "${!i}" == "--body-file" ]]; then',
			"    next=$((i + 1))",
			'    body_file="${!next:-}"',
			"  fi",
			"done",
			"",
			'body_content=""',
			'if [[ -n "${body_file}" && -f "${body_file}" ]]; then',
			'  body_content="$(cat "${body_file}")"',
			"fi",
			"",
			'if [[ -n "${CCFLARE_TEST_GH_LOG:-}" ]]; then',
			'  args_json="$(printf \'%s\\n\' "$@" | jq -R . | jq -cs .)"',
			'  jq -cn --argjson args "${args_json}" --arg bodyFile "${body_content}" \\',
			"    '{args: $args, bodyFile: $bodyFile}' >> \"${CCFLARE_TEST_GH_LOG}\"",
			"fi",
			"",
			'all_args="$*"',
			'if [[ -n "${CCFLARE_TEST_GH_FAIL:-}" && "${all_args}" == *"${CCFLARE_TEST_GH_FAIL}"* ]]; then',
			'  echo "stub gh: forced failure for: ${all_args}" >&2',
			"  exit 1",
			"fi",
			"",
			'case "${1:-}" in',
			"  issue)",
			'    case "${2:-}" in',
			'      create) echo "https://github.com/example/repo/issues/999" ;;',
			"      comment) : ;;",
			"    esac",
			"    ;;",
			"  api)",
			'    if [[ "${all_args}" == *"/comments"* ]]; then',
			'      cat "${CCFLARE_TEST_GH_COMMENTS}"',
			'    elif [[ "${all_args}" == *"issues?"* ]]; then',
			'      cat "${CCFLARE_TEST_GH_ISSUES}"',
			"    fi",
			"    ;;",
			"esac",
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);
	return binDir;
}

function baseEnv(dir: string, binDir: string, overrides: Record<string, string | undefined> = {}) {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		GH_TOKEN: "test-token",
		GITHUB_REPOSITORY: "example/repo",
		CANARY_RUN_URL: "https://github.com/example/repo/actions/runs/123",
		CANARY_RESOLVED_BUN: "1.4.3",
		CANARY_PINNED_BUN: "1.4.2",
		CANARY_GATE_OUTCOME: "failure",
		CCFLARE_TEST_GH_LOG: join(dir, "gh.log"),
		CCFLARE_TEST_GH_ISSUES: join(dir, "issues.json"),
		CCFLARE_TEST_GH_COMMENTS: join(dir, "comments.json"),
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}
	return env;
}

function runReport(env: Record<string, string>) {
	return Bun.spawnSync(["bash", reportScript], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function out(result: ReturnType<typeof runReport>): string {
	return (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
}

const STATE_MARKER = "<!-- bun-latest-canary:state resolved=1.4.3 outcome=failure -->";
const MARKER = "<!-- bun-latest-canary -->";

describe("bun-latest-canary-report.sh", () => {
	test("case 1: failure, no open tracking issue -> files exactly one issue create", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(join(dir, "issues.json"), "[[]]");
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		const closes = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "close",
		);
		expect(creates.length).toBe(1);
		expect(closes.length).toBe(0);

		const create = creates[0];
		expect(create.args).toContain("--label");
		expect(create.args).toContain("bug");
		const titleIndex = create.args.indexOf("--title");
		expect(titleIndex).toBeGreaterThan(-1);
		const title = create.args[titleIndex + 1];
		expect(title).toContain("1.4.3");
		expect(title).toContain("1.4.2");
		expect(create.bodyFile).toContain(MARKER);
		expect(create.bodyFile).toContain(STATE_MARKER);
		expect(create.bodyFile).toContain(env.CANARY_RUN_URL);
	});

	test("case 2: failure, open issue already reporting this exact state -> no writes", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 5,
						title: "ci: Bun 1.4.3 fails the managed-routing gate",
						body: `${MARKER}\n${STATE_MARKER}\n`,
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const writes = log.filter(
			(entry) =>
				entry.args[0] === "issue" &&
				(entry.args[1] === "create" || entry.args[1] === "comment"),
		);
		expect(writes.length).toBe(0);
	});

	test("case 3: failure, open issue reported for another version -> one issue comment, no create; decoy ignored", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		const oldState =
			"<!-- bun-latest-canary:state resolved=1.4.0 outcome=failure -->";
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 42,
						title: "some unrelated open issue",
						body: "just a decoy issue with no marker at all",
						user: { login: "someone-else" },
					},
					{
						number: 7,
						title: "ci: Bun 1.4.0 fails the managed-routing gate",
						body: `${MARKER}\n${oldState}\n`,
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		const comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		expect(creates.length).toBe(0);
		expect(comments.length).toBe(1);
		expect(comments[0].args).toContain("7");
		expect(comments[0].args).not.toContain("42");
		expect(comments[0].bodyFile).toContain(STATE_MARKER);
	});

	test("case 4: success comments when last state was a failure, then goes quiet once state matches", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 9,
						title: "ci: Bun 1.4.3 fails the managed-routing gate",
						body: `${MARKER}\n${STATE_MARKER}\n`,
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir, { CANARY_GATE_OUTCOME: "success" });

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		let log = readGhLog(join(dir, "gh.log"));
		let comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		expect(comments.length).toBe(1);
		expect(comments[0].bodyFile.toLowerCase()).toContain("passes");
		expect(comments[0].bodyFile).toContain(
			"<!-- bun-latest-canary:state resolved=1.4.3 outcome=success -->",
		);

		// Re-run with a comments fixture that already carries the success state:
		// no further writes should happen.
		writeFileSync(join(dir, "gh.log"), "");
		writeFileSync(
			join(dir, "comments.json"),
			JSON.stringify([
				[
					{
						body: "<!-- bun-latest-canary:state resolved=1.4.3 outcome=success -->\nBun 1.4.3 passes.",
						created_at: "2026-09-05T00:00:00Z",
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		const result2 = runReport(env);
		expect(result2.exitCode).toBe(0);
		log = readGhLog(join(dir, "gh.log"));
		comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		expect(comments.length).toBe(0);
		expect(creates.length).toBe(0);
	});

	test("case 5: success, no open issue -> no writes, stdout carries ::notice::", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(join(dir, "issues.json"), "[[]]");
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir, { CANARY_GATE_OUTCOME: "success" });

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const writes = log.filter(
			(entry) =>
				entry.args[0] === "issue" &&
				(entry.args[1] === "create" || entry.args[1] === "comment"),
		);
		expect(writes.length).toBe(0);
		expect(out(result)).toContain("::notice::");
	});

	test("case 6: gh issues fetch failure -> exit 1 with ::error::", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(join(dir, "issues.json"), "[[]]");
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir, {
			CCFLARE_TEST_GH_FAIL: "issues?state=open",
		});

		const result = runReport(env);
		expect(result.exitCode).toBe(1);
		expect(out(result)).toContain("::error::");
	});

	test("case 7: gate outcome skipped -> exit 0, no gh writes at all", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(join(dir, "issues.json"), "[[]]");
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir, { CANARY_GATE_OUTCOME: "skipped" });

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		expect(log.length).toBe(0);
	});

	test("case 8: missing CANARY_RESOLVED_BUN -> exit 2", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(join(dir, "issues.json"), "[[]]");
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir, { CANARY_RESOLVED_BUN: undefined });

		const result = runReport(env);
		expect(result.exitCode).toBe(2);
	});

	test("case 9: an open issue with the marker authored by another login is ignored, so failure files a new issue", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 5,
						title: "ci: Bun 1.4.3 fails the managed-routing gate",
						body: `${MARKER}\n${STATE_MARKER}\n`,
						user: { login: "someone-else" },
					},
				],
			]),
		);
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		const comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		expect(creates.length).toBe(1);
		expect(comments.length).toBe(0);
	});

	test("case 10: a comment carrying the current state marker from another login does not suppress the report", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		const oldState =
			"<!-- bun-latest-canary:state resolved=1.4.0 outcome=failure -->";
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 11,
						title: "ci: Bun 1.4.0 fails the managed-routing gate",
						body: `${MARKER}\n${oldState}\n`,
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		writeFileSync(
			join(dir, "comments.json"),
			JSON.stringify([
				[
					{
						body: `${STATE_MARKER}\nspoofed by a non-actor login`,
						created_at: "2026-09-05T00:00:00Z",
						user: { login: "mallory" },
					},
				],
			]),
		);
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		const comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		expect(creates.length).toBe(0);
		expect(comments.length).toBe(1);
		expect(comments[0].args).toContain("11");
		expect(comments[0].bodyFile).toContain(STATE_MARKER);
	});

	test("case 11: comments paginate across two pages; a state marker only on the second page still counts", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 13,
						title: "ci: Bun 1.4.3 fails the managed-routing gate",
						body: `${MARKER}\n`,
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		writeFileSync(
			join(dir, "comments.json"),
			JSON.stringify([
				[
					{
						body: "<!-- bun-latest-canary:state resolved=1.4.0 outcome=failure -->\nBun 1.4.0 fails.",
						created_at: "2026-09-01T00:00:00Z",
						user: { login: "github-actions[bot]" },
					},
				],
				[
					{
						body: `${STATE_MARKER}\nBun 1.4.3 still fails.`,
						created_at: "2026-09-05T00:00:00Z",
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const writes = log.filter(
			(entry) =>
				entry.args[0] === "issue" &&
				(entry.args[1] === "create" || entry.args[1] === "comment"),
		);
		expect(writes.length).toBe(0);
	});

	test("case 12: an open pull request carrying the marker is ignored, so failure files a new issue", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 6,
						title: "ci: Bun 1.4.3 fails the managed-routing gate",
						body: `${MARKER}\n${STATE_MARKER}\n`,
						user: { login: "github-actions[bot]" },
						pull_request: {
							url: "https://api.github.com/repos/example/repo/pulls/6",
						},
					},
				],
			]),
		);
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir);

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		const log = readGhLog(join(dir, "gh.log"));
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		const comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		expect(creates.length).toBe(1);
		expect(comments.length).toBe(0);
	});
	test("case 13 (pro-gate round 1 P2): a canary sharing a reported release's --version but a different --revision is a distinct state, and its own revision dedupes", () => {
		const dir = tempDir();
		const binDir = writeGhStub(dir);
		const stableState =
			"<!-- bun-latest-canary:state resolved=1.4.3+abcdef012 outcome=failure -->";
		const canaryResolved = "1.4.3-canary.9+0123abcde";
		const canaryState = `<!-- bun-latest-canary:state resolved=${canaryResolved} outcome=failure -->`;
		writeFileSync(
			join(dir, "issues.json"),
			JSON.stringify([
				[
					{
						number: 21,
						title:
							"ci: Bun 1.4.3+abcdef012 (latest) fails the managed-routing gate",
						body: `${MARKER}\n${stableState}\n`,
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		writeFileSync(join(dir, "comments.json"), "[[]]");
		const env = baseEnv(dir, binDir, {
			CANARY_RESOLVED_BUN: canaryResolved,
			CANARY_REQUESTED_BUN: "canary",
		});

		const result = runReport(env);
		expect(result.exitCode).toBe(0);

		let log = readGhLog(join(dir, "gh.log"));
		const creates = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "create",
		);
		const comments = log.filter(
			(entry) => entry.args[0] === "issue" && entry.args[1] === "comment",
		);
		expect(creates.length).toBe(0);
		expect(comments.length).toBe(1);
		expect(comments[0].args).toContain("21");
		expect(comments[0].bodyFile).toContain(canaryState);
		expect(comments[0].bodyFile).toContain(`Bun ${canaryResolved} (canary)`);

		// Once that comment exists, the same canary revision writes nothing
		// more: the state-marker regex must accept the `-canary.N+sha` identity.
		writeFileSync(join(dir, "gh.log"), "");
		writeFileSync(
			join(dir, "comments.json"),
			JSON.stringify([
				[
					{
						body: `${canaryState}\nBun ${canaryResolved} (canary) still fails.`,
						created_at: "2026-09-05T00:00:00Z",
						user: { login: "github-actions[bot]" },
					},
				],
			]),
		);
		const result2 = runReport(env);
		expect(result2.exitCode).toBe(0);
		log = readGhLog(join(dir, "gh.log"));
		const writes = log.filter(
			(entry) =>
				entry.args[0] === "issue" &&
				(entry.args[1] === "create" || entry.args[1] === "comment"),
		);
		expect(writes.length).toBe(0);
	});
});
