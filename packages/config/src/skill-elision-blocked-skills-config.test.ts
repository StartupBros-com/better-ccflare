import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, parseSkillElisionBlockedSkills } from "./index";

const ENV_NAME = "CCFLARE_SKILL_ELISION_BLOCKED";

function makeConfig(raw?: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-skill-elision-"));
	const configPath = join(dir, "config.json");
	if (raw) writeFileSync(configPath, JSON.stringify(raw), "utf8");
	return {
		config: new Config(configPath),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("skill elision blocked-skills configuration", () => {
	const originalEnv = process.env[ENV_NAME];

	beforeEach(() => {
		delete process.env[ENV_NAME];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[ENV_NAME];
		else process.env[ENV_NAME] = originalEnv;
	});

	it("is default-off with no config file content and no env", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getSkillElisionBlockedSkills()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("parses a CSV file field into a normalized, deduped, lowercased list", () => {
		const { config, cleanup } = makeConfig({
			skill_elision_blocked_skills: "Some-Skill, other-skill,some-skill",
		});
		try {
			expect(config.getSkillElisionBlockedSkills()).toEqual([
				"some-skill",
				"other-skill",
			]);
		} finally {
			cleanup();
		}
	});

	it("fails closed to an empty list when the file field has 17 items", () => {
		const { config, cleanup } = makeConfig({
			skill_elision_blocked_skills: Array.from(
				{ length: 17 },
				(_, i) => `skill-${i}`,
			).join(","),
		});
		try {
			expect(config.getSkillElisionBlockedSkills()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("fails closed on an oversized env value even when the file has a valid short list", () => {
		process.env[ENV_NAME] = Array.from(
			{ length: 17 },
			(_, i) => `skill-${i}`,
		).join(",");
		const { config, cleanup } = makeConfig({
			skill_elision_blocked_skills: "some-skill",
		});
		try {
			expect(config.getSkillElisionBlockedSkills()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("gives the environment precedence over a differing valid file value", () => {
		process.env[ENV_NAME] = "env-skill";
		const { config, cleanup } = makeConfig({
			skill_elision_blocked_skills: "file-skill",
		});
		try {
			expect(config.getSkillElisionBlockedSkills()).toEqual(["env-skill"]);
		} finally {
			cleanup();
		}
	});

	it("fails closed for a mixed-type array (only reachable by hand-editing config)", () => {
		expect(parseSkillElisionBlockedSkills(["ok", 42])).toEqual([]);
	});

	it("trims whitespace and skips empty segments", () => {
		expect(
			parseSkillElisionBlockedSkills(" some-skill , , other-skill "),
		).toEqual(["some-skill", "other-skill"]);
	});

	it("never throws and treats undefined/null as an empty list", () => {
		expect(parseSkillElisionBlockedSkills(undefined)).toEqual([]);
		expect(parseSkillElisionBlockedSkills(null)).toEqual([]);
	});

	it("treats non-string, non-array input as an empty list", () => {
		expect(parseSkillElisionBlockedSkills(42)).toEqual([]);
		expect(parseSkillElisionBlockedSkills({ foo: "bar" })).toEqual([]);
	});

	it("returns a frozen array", () => {
		expect(Object.isFrozen(parseSkillElisionBlockedSkills("a,b"))).toBe(true);
	});
});
