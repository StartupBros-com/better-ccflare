import { describe, expect, it } from "bun:test";
import { applySkillElision, elideSkillBundles } from "../skill-elision";

const SKILL_MARKER = "Base directory for this skill: ";

/** Build marker-bearing text of exactly `totalLength` characters. */
function makeSkillText(dir: string, totalLength: number): string {
	const header = `${SKILL_MARKER}${dir}\n`;
	const body = "x".repeat(Math.max(0, totalLength - header.length));
	return header + body;
}

describe("elideSkillBundles", () => {
	it("passes the exact same body through by reference when the blocklist is empty", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: makeSkillText("some-skill", 20_000) },
					],
				},
			],
		};

		const result = elideSkillBundles(body, []);

		expect(result.body).toBe(body);
		expect(result.elided).toEqual([]);
	});

	it("elides a top-level text content block naming a blocked skill", () => {
		const bundleText = makeSkillText("some-skill", 12_000);
		const body = {
			messages: [
				{ role: "user", content: [{ type: "text", text: bundleText }] },
			],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.body).not.toBe(body);
		expect(result.elided).toHaveLength(1);
		expect(result.elided[0]).toEqual({
			skillName: "some-skill",
			originalLength: bundleText.length,
		});
		const messages = (result.body as typeof body).messages;
		const text = (messages[0].content[0] as { text: string }).text;
		expect(text).toContain("[better-ccflare]");
		expect(text).not.toContain(bundleText);
		// Original message/body untouched.
		expect(body.messages[0].content[0]).toEqual({
			type: "text",
			text: bundleText,
		});
	});

	it("elides a tool_result block whose content is a plain string", () => {
		const bundleText = makeSkillText("some-skill", 15_000);
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: bundleText,
						},
					],
				},
			],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided).toHaveLength(1);
		const block = (result.body as typeof body).messages[0].content[0] as {
			type: string;
			tool_use_id: string;
			content: string;
		};
		expect(block.tool_use_id).toBe("call_1");
		expect(block.content).toContain("[better-ccflare]");
		expect(block.content).not.toContain(bundleText);
	});

	it("elides a qualifying text sub-block inside a tool_result content array, preserving array shape", () => {
		const bundleText = makeSkillText("some-skill", 15_000);
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: [
								{ type: "text", text: "small ack" },
								{ type: "text", text: bundleText },
							],
						},
					],
				},
			],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided).toHaveLength(1);
		const block = (result.body as typeof body).messages[0].content[0] as {
			content: Array<{ type: string; text: string }>;
		};
		expect(Array.isArray(block.content)).toBe(true);
		expect(block.content).toHaveLength(2);
		expect(block.content[0]).toEqual({ type: "text", text: "small ack" });
		expect(block.content[1].text).toContain("[better-ccflare]");
		expect(block.content[1].text).not.toContain(bundleText);
	});

	it("does not elide qualifying text just under the 10,000 char floor", () => {
		const text = makeSkillText("some-skill", 9_999);
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text }] }],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.body).toBe(body);
		expect(result.elided).toEqual([]);
	});

	it("elides qualifying text just over the 10,000 char floor", () => {
		const text = makeSkillText("some-skill", 10_001);
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text }] }],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided).toHaveLength(1);
	});

	it("matches a Windows-style path by basename", () => {
		const text = makeSkillText("C:\\Users\\foo\\some-skill", 12_000);
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text }] }],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided).toHaveLength(1);
		expect(result.elided[0]?.skillName).toBe("some-skill");
	});

	it("matches a directory with a trailing slash by basename", () => {
		const text = makeSkillText("/a/b/some-skill/", 12_000);
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text }] }],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided).toHaveLength(1);
		expect(result.elided[0]?.skillName).toBe("some-skill");
	});

	it("matches case-insensitively in both directions", () => {
		const mixedCaseDir = makeSkillText("/a/Some-Skill", 12_000);
		const bodyLowerBlocklist = {
			messages: [
				{ role: "user", content: [{ type: "text", text: mixedCaseDir }] },
			],
		};
		expect(
			elideSkillBundles(bodyLowerBlocklist, ["some-skill"]).elided,
		).toHaveLength(1);

		const lowerCaseDir = makeSkillText("/a/some-skill", 12_000);
		const bodyMixedBlocklist = {
			messages: [
				{ role: "user", content: [{ type: "text", text: lowerCaseDir }] },
			],
		};
		expect(
			elideSkillBundles(bodyMixedBlocklist, ["Some-Skill"]).elided,
		).toHaveLength(1);
	});

	it("does not match a blocked skill name that is only a parent directory segment", () => {
		const text = makeSkillText("/a/some-skill/other-skill", 12_000);
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text }] }],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.body).toBe(body);
		expect(result.elided).toEqual([]);
	});

	it("passes through a qualifying block naming a non-blocked skill unchanged", () => {
		const text = makeSkillText("unrelated-skill", 12_000);
		const body = {
			messages: [{ role: "user", content: [{ type: "text", text }] }],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.body).toBe(body);
		expect(result.elided).toEqual([]);
	});

	it("is deterministic across structurally-equal but distinct input references", () => {
		const fixture = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: makeSkillText("some-skill", 12_000) },
					],
				},
			],
		};

		const input1 = JSON.parse(JSON.stringify(fixture));
		const input2 = JSON.parse(JSON.stringify(fixture));

		const result1 = elideSkillBundles(input1, ["some-skill"]);
		const result2 = elideSkillBundles(input2, ["some-skill"]);

		expect(JSON.stringify(result1.body)).toBe(JSON.stringify(result2.body));
	});

	it("never mutates the original input object in place", () => {
		const original = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: makeSkillText("some-skill", 12_000) },
					],
				},
			],
		};
		const expectedOriginal = JSON.parse(JSON.stringify(original));

		elideSkillBundles(original, ["some-skill"]);

		expect(original).toEqual(expectedOriginal);
	});

	it("produces a stub under 200 chars", () => {
		const bundleText = makeSkillText("some-skill", 12_000);
		const body = {
			messages: [
				{ role: "user", content: [{ type: "text", text: bundleText }] },
			],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided[0]?.originalLength).toBe(bundleText.length);
		const stubText = (
			(result.body as typeof body).messages[0].content[0] as { text: string }
		).text;
		expect(stubText.length).toBeLessThan(200);
	});

	it("elides two bundles in one content array without dropping or reordering neighbors", () => {
		const bundleA = makeSkillText("skill-a", 12_000);
		const bundleB = makeSkillText("skill-b", 12_000);
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "before" },
						{ type: "text", text: bundleA },
						{ type: "text", text: "between" },
						{ type: "text", text: bundleB },
						{ type: "text", text: "after" },
					],
				},
			],
		};

		const result = elideSkillBundles(body, ["skill-a", "skill-b"]);

		expect(result.elided).toHaveLength(2);
		expect(result.elided.map((r) => r.skillName)).toEqual([
			"skill-a",
			"skill-b",
		]);
		const content = (result.body as typeof body).messages[0].content;
		expect(content).toHaveLength(5);
		expect(content[0].text).toBe("before");
		expect(content[1].text).toContain("'skill-a' skill document elided");
		expect(content[2].text).toBe("between");
		expect(content[3].text).toContain("'skill-b' skill document elided");
		expect(content[4].text).toBe("after");
	});

	it("elides a middle tool_result sub-block while preserving trailing sub-blocks", () => {
		const bundle = makeSkillText("some-skill", 12_000);
		const body = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "untouched msg" }] },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: [
								{ type: "text", text: "loaded ok" },
								{ type: "text", text: bundle },
								{ type: "text", text: "trailing note" },
								{ type: "image", source: { data: "not-text" } },
							],
						},
					],
				},
			],
		};

		const result = elideSkillBundles(body, ["some-skill"]);

		expect(result.elided).toHaveLength(1);
		const messages = (result.body as typeof body).messages;
		expect(messages[0]).toBe(body.messages[0]);
		const sub = (
			messages[1].content[0] as {
				content: Array<{ type: string; text?: string }>;
			}
		).content;
		expect(sub).toHaveLength(4);
		expect(sub[0].text).toBe("loaded ok");
		expect(sub[1].text).toContain("'some-skill' skill document elided");
		expect(sub[2].text).toBe("trailing note");
		expect(sub[3].type).toBe("image");
	});
});

describe("applySkillElision", () => {
	function makeQualifyingBody(skillName: string) {
		return {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: makeSkillText(skillName, 12_000) }],
				},
			],
		};
	}

	it("is a no-op for the native anthropic provider (identity-preserved)", () => {
		const body = makeQualifyingBody("some-skill");
		const result = applySkillElision("anthropic", body, ["some-skill"]);
		expect(result).toBe(body);
	});

	it("is a no-op for the claude-console-api provider alias (identity-preserved)", () => {
		const body = makeQualifyingBody("some-skill");
		const result = applySkillElision("claude-console-api", body, [
			"some-skill",
		]);
		expect(result).toBe(body);
	});

	it("elides for a non-Anthropic provider name", () => {
		const body = makeQualifyingBody("some-skill");
		const result = applySkillElision("openai-compatible", body, ["some-skill"]);
		expect(result).not.toBe(body);
		const text = (
			(result as typeof body).messages[0].content[0] as { text: string }
		).text;
		expect(text).toContain("[better-ccflare]");
	});
});
