import { describe, expect, test } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

const validMessage = { type: "message", role: "user", content: "keep me" };
const hostileType = { toString: null, valueOf: null };
const additionalTools = {
	type: "additional_tools",
	tools: [{ type: "computer_use_preview" }],
};

async function runRequest(body: Record<string, unknown>) {
	const forwarded: Record<string, unknown>[] = [];
	const warnings: string[] = [];
	const captureWarning = (event: LogEvent) => {
		if (event.level === "WARN") warnings.push(event.msg);
	};
	const proxy: HandleProxyFn = async (request) => {
		forwarded.push((await request.json()) as Record<string, unknown>);
		return Response.json({
			id: "msg_offline",
			type: "message",
			role: "assistant",
			model: "claude-haiku-4-5",
			content: [{ type: "text", text: "Hello" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		});
	};
	const request = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	logBus.on("log", captureWarning);
	try {
		const response = await handleResponsesRequest(
			request,
			new URL(request.url),
			proxy,
			{},
		);
		return { response, forwarded, warnings };
	} finally {
		logBus.off("log", captureWarning);
	}
}

describe("Responses runtime model and input-item boundaries", () => {
	for (const [label, model] of [
		["missing", undefined],
		["null", null],
		["number", 7],
		["boolean", false],
		["array", []],
		["object", {}],
		["coercion-hostile object", hostileType],
	] as const) {
		test(`rejects ${label} model with a 400 before proxy dispatch`, async () => {
			const { response, forwarded } = await runRequest({ model, input: "Hi" });
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "model must be a string",
				},
			});
			expect(forwarded).toHaveLength(0);
		});
	}

	for (const [label, type] of [
		["missing", undefined],
		["null", null],
		["number", 7],
		["boolean", false],
		["array", []],
		["object", {}],
		["coercion-hostile object", hostileType],
		["coercion-hostile array", [hostileType]],
	] as const) {
		test(`drops ${label} input-item type with a safe warning`, async () => {
			const { response, forwarded, warnings } = await runRequest({
				model: "claude-haiku-4-5",
				input: [{ type }, validMessage],
			});
			expect(response.status).toBe(200);
			expect(forwarded).toHaveLength(1);
			expect(forwarded[0].messages).toEqual([
				{ role: "user", content: [{ type: "text", text: "keep me" }] },
			]);
			expect(warnings).toEqual([
				"Dropping malformed Responses input item — type must be a string",
			]);
		});
	}

	test("drops null and other malformed input items while preserving additional_tools", async () => {
		const { response, forwarded, warnings } = await runRequest({
			model: "claude-haiku-4-5",
			input: [null, 7, false, "junk", [], validMessage, additionalTools],
		});
		expect(response.status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "keep me" }] },
		]);
		expect(forwarded[0].__better_ccflare_codex_passthrough).toEqual({
			model: "claude-haiku-4-5",
			additional_tools: [additionalTools],
		});
		expect(warnings).toHaveLength(5);
		expect(
			warnings.every((warning) => warning.includes("expected an object")),
		).toBe(true);
	});

	test("rejects input containing only dropped items with a 400 before proxy dispatch", async () => {
		const { response, forwarded, warnings } = await runRequest({
			model: "claude-haiku-4-5",
			input: [null, { type: hostileType }],
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "input must contain at least one translatable message",
			},
		});
		expect(forwarded).toHaveLength(0);
		expect(warnings).toHaveLength(2);
	});

	test("keeps unknown string input types skippable with the existing warning", async () => {
		const { response, forwarded, warnings } = await runRequest({
			model: "claude-haiku-4-5",
			input: [{ type: "future_item" }, validMessage],
		});
		expect(response.status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(warnings).toEqual([
			'Dropping unhandled Responses input item type "future_item" — no Anthropic mapping implemented',
		]);
	});

	test("shares the existing warning budget with malformed input-item types", async () => {
		const { response, forwarded, warnings } = await runRequest({
			model: "claude-haiku-4-5",
			input: [
				...Array.from({ length: 60 }, () => ({ type: hostileType })),
				validMessage,
			],
		});
		expect(response.status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(warnings).toHaveLength(51);
		expect(warnings.at(-1)).toBe(
			"10 further translation warning(s) suppressed",
		);
	});
});
