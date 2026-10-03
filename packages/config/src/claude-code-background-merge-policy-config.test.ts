import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_NAME = "CCFLARE_CLAUDE_CODE_BACKGROUND_MERGE_POLICY";

function makeConfig(raw?: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-background-merge-policy-"));
	const path = join(dir, "config.json");
	if (raw !== undefined) writeFileSync(path, JSON.stringify(raw), "utf8");
	return {
		config: new Config(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("Claude Code background merge policy configuration", () => {
	const originalEnv = process.env[ENV_NAME];

	beforeEach(() => {
		delete process.env[ENV_NAME];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[ENV_NAME];
		else process.env[ENV_NAME] = originalEnv;
	});

	it("defaults off without an operator opt-in", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getClaudeCodeBackgroundMergePolicyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it.each(["true", "1"])("opts in only with env value %s", (value) => {
		process.env[ENV_NAME] = value;
		const { config, cleanup } = makeConfig({
			claude_code_background_merge_policy_enabled: false,
		});
		try {
			expect(config.getClaudeCodeBackgroundMergePolicyEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it.each([
		"false",
		"0",
		"",
		" ",
		"TRUE",
		"True",
		" true ",
		"yes",
		"on",
		"2",
	])("a present non-opt-in env value %j overrides an enabled file policy", (value) => {
		process.env[ENV_NAME] = value;
		const { config, cleanup } = makeConfig({
			claude_code_background_merge_policy_enabled: true,
		});
		try {
			expect(config.getClaudeCodeBackgroundMergePolicyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("accepts the boolean opt-in in the existing operator config file", () => {
		const { config, cleanup } = makeConfig({
			claude_code_background_merge_policy_enabled: true,
		});
		try {
			expect(config.getClaudeCodeBackgroundMergePolicyEnabled()).toBe(true);
		} finally {
			cleanup();
		}
	});

	it.each(
		[false, null, "true", "1", 1, [], {}].map((value) => ({ value })),
	)("does not infer file opt-in from %j", ({ value }) => {
		const { config, cleanup } = makeConfig({
			claude_code_background_merge_policy_enabled: value,
		});
		try {
			expect(config.getClaudeCodeBackgroundMergePolicyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});
});
