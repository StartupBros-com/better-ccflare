import { describe, expect, it } from "bun:test";
import {
	CODEX_REASONING_RETENTION_PREFIX,
	isProxyMintedCodexReasoningBlock,
	stripCodexReasoningRetention,
} from "../codex-reasoning-retention";

describe("isProxyMintedCodexReasoningBlock", () => {
	it("recognizes only exact proxy-minted redacted-thinking blocks", () => {
		expect(
			isProxyMintedCodexReasoningBlock({
				type: "redacted_thinking",
				data: "bccfr1.rs_bound.cipher",
			}),
		).toBe(true);
		expect(
			isProxyMintedCodexReasoningBlock({
				type: "redacted_thinking",
				data: "bccfr10.not-ours",
			}),
		).toBe(false);
		expect(
			isProxyMintedCodexReasoningBlock({
				type: "thinking",
				data: "bccfr1.not-redacted",
			}),
		).toBe(false);
	});
});

describe("stripCodexReasoningRetention", () => {
	it("returns the original body and zero when no proxy-minted block is present", () => {
		const body = {
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "kept" }] },
				{
					role: "user",
					content: [{ type: "redacted_thinking", data: "bccfr1.rs_user.keep" }],
				},
			],
		};

		const result = stripCodexReasoningRetention(body);

		expect(result).toEqual({ body, strippedCount: 0 });
		expect(result.body).toBe(body);
	});

	it("removes only exact proxy-minted assistant blocks and preserves all other structure", () => {
		const body = {
			model: "claude-sonnet",
			messages: [
				{
					role: "user",
					content: [{ type: "redacted_thinking", data: "bccfr1.rs_user.keep" }],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "before" },
						{
							type: "redacted_thinking",
							data: `${CODEX_REASONING_RETENTION_PREFIX}rs_bound.cipher`,
						},
						{ type: "redacted_thinking", data: "anthropic-genuine" },
						{ type: "redacted_thinking", data: "bccfr10.not-ours" },
						{ type: "redacted_thinking", data: 42 },
						{ type: "text", text: "after" },
					],
				},
			],
		};

		const result = stripCodexReasoningRetention(body);

		expect(result.strippedCount).toBe(1);
		expect(result.body).toEqual({
			model: "claude-sonnet",
			messages: [
				body.messages[0],
				{
					role: "assistant",
					content: [
						{ type: "text", text: "before" },
						{ type: "redacted_thinking", data: "anthropic-genuine" },
						{ type: "redacted_thinking", data: "bccfr10.not-ours" },
						{ type: "redacted_thinking", data: 42 },
						{ type: "text", text: "after" },
					],
				},
			],
		});
		expect(result.body).not.toBe(body);
		expect(result.body.messages[0]).toBe(body.messages[0]);
		expect(result.body.messages[1]).not.toBe(body.messages[1]);
		expect(result.body.messages[1].content[0]).toBe(
			body.messages[1].content[0],
		);
		expect(result.body.messages[1].content[4]).toBe(
			body.messages[1].content[5],
		);
		expect(body.messages[1].content).toHaveLength(6);
	});

	it("drops only assistant messages emptied by removing proxy-minted blocks", () => {
		const preExistingEmptyText = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
		};
		const body = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.rs_drop.cipher" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.rs_drop_2.cipher" },
						{ type: "text", text: "" },
					],
				},
				{ role: "assistant", content: [] },
				preExistingEmptyText,
				{
					role: "assistant",
					content: [{ type: "redacted_thinking", data: "anthropic-genuine" }],
				},
			],
		};

		const result = stripCodexReasoningRetention(body);

		expect(result.strippedCount).toBe(2);
		expect(result.body).toEqual({
			messages: [body.messages[2], preExistingEmptyText, body.messages[4]],
		});
	});
	it("merges adjacent same-role turns exposed by a dropped reasoning-only message", () => {
		const body = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "turn 1" }] },
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.rs_only.cipher" },
					],
				},
				{ role: "user", content: [{ type: "text", text: "turn 2" }] },
			],
		};

		const result = stripCodexReasoningRetention(body);

		// The reasoning-only assistant turn is dropped, and the two user turns it
		// separated are merged so no upstream sees an invalid role sequence.
		expect(result.strippedCount).toBe(1);
		expect(result.body.messages.map((m) => m.role)).toEqual(["user"]);
		expect(result.body.messages[0].content).toEqual([
			{ type: "text", text: "turn 1" },
			{ type: "text", text: "turn 2" },
		]);
	});

	it("leaves string-content neighbours unmerged", () => {
		const body = {
			messages: [
				{ role: "user", content: "turn 1" },
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "bccfr1.rs_only.cipher" },
					],
				},
				{ role: "user", content: "turn 2" },
			],
		};

		const result = stripCodexReasoningRetention(body);

		expect(result.strippedCount).toBe(1);
		// String content is not merged: the neighbours survive as-is rather than
		// guessing at a concatenation the upstream may format differently.
		expect(result.body.messages).toEqual([
			{ role: "user", content: "turn 1" },
			{ role: "user", content: "turn 2" },
		]);
	});
});
