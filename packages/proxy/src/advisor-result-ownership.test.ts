import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ADVISOR_RESULT_UNPROCESSABLE_MARKERS,
	advisorResultOwnerKeyFromBlock,
	getAdvisorResultOwnerAccount,
	getAdvisorResultOwnerKey,
	isAdvisorResultUnprocessableMessage,
	mayContainAdvisorResult,
	readAdvisorResultOwnerKey,
	recordAdvisorResultOwner,
	resetAdvisorResultOwnershipForTests,
	stripAllAdvisorResults,
	stripForeignAdvisorResults,
} from "./advisor-result-ownership";

const KEY_A = "54f97ec3-c398-4c6b-b337-942aec61b3de";
const KEY_B = "11111111-2222-4333-8444-555555555555";

function blob(uuid: string): string {
	const inner = [
		0x0a,
		0x2a,
		0x08,
		0x14,
		0x18,
		0x02,
		0x22,
		0x24,
		...Buffer.from(uuid, "ascii"),
		...Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff),
	];
	return Buffer.from([0x12, inner.length, ...inner]).toString("base64");
}

function result(
	id: string,
	key: string | null,
	type = "advisor_redacted_result",
) {
	return {
		type: "advisor_tool_result",
		tool_use_id: id,
		content:
			type === "advisor_redacted_result"
				? { type, encrypted_content: key ? blob(key) : "AAAA" }
				: { type, error_code: "unavailable" },
	};
}
const use = (id: string) => ({
	type: "server_tool_use",
	id,
	name: "advisor",
	input: {},
});
const text = (t: string) => ({ type: "text", text: t });
const asst = (...content: unknown[]) => ({ role: "assistant", content });
const user = (t = "hi") => ({ role: "user", content: t });
// biome-ignore lint/suspicious/noExplicitAny: test helper for loosely typed messages
type Msgs = any[];

function deepFreeze<T>(o: T): T {
	if (o && typeof o === "object") {
		for (const v of Object.values(o)) deepFreeze(v);
		Object.freeze(o);
	}
	return o;
}

beforeEach(resetAdvisorResultOwnershipForTests);
afterEach(resetAdvisorResultOwnershipForTests);

describe("readAdvisorResultOwnerKey", () => {
	test("extracts the uuid and rejects bad input", () => {
		expect(readAdvisorResultOwnerKey(blob(KEY_A))).toBe(KEY_A);
		expect(readAdvisorResultOwnerKey(123)).toBeNull();
		expect(readAdvisorResultOwnerKey("")).toBeNull();
		expect(readAdvisorResultOwnerKey("!!!not base64***")).toBeNull();
		const noMarker = Buffer.from([
			0x12,
			0x30,
			0x0a,
			0x2a,
			0x21,
			0x24,
			...Buffer.from(KEY_A),
		]).toString("base64");
		expect(readAdvisorResultOwnerKey(noMarker)).toBeNull();
		const badUuid = Buffer.from([
			0x12,
			0x30,
			0x22,
			0x24,
			...Buffer.from("z".repeat(36)),
		]).toString("base64");
		expect(readAdvisorResultOwnerKey(badUuid)).toBeNull();
	});
	test("finds a uuid that ends exactly at the end of a short blob", () => {
		const tail = Buffer.from([
			0x12,
			0x26,
			0x22,
			0x24,
			...Buffer.from(KEY_A),
		]).toString("base64");
		expect(readAdvisorResultOwnerKey(tail)).toBe(KEY_A);
		const truncated = Buffer.from([
			0x12,
			0x26,
			0x22,
			0x24,
			...Buffer.from(KEY_A.slice(0, 35)),
		]).toString("base64");
		expect(readAdvisorResultOwnerKey(truncated)).toBeNull();
	});
	test("block helper", () => {
		expect(advisorResultOwnerKeyFromBlock(result("s1", KEY_A))).toBe(KEY_A);
		expect(advisorResultOwnerKeyFromBlock(result("s1", null, "x"))).toBeNull();
		expect(advisorResultOwnerKeyFromBlock(null)).toBeNull();
	});
});

describe("stripForeignAdvisorResults", () => {
	test("target key known strips foreign, keeps own/unknown/error", () => {
		recordAdvisorResultOwner("acc1", KEY_A);
		const body = {
			messages: [
				user(),
				asst(text("a"), use("s1"), result("s1", KEY_B)),
				asst(text("b"), use("s2"), result("s2", KEY_A)),
				asst(text("c"), use("s3"), result("s3", null)),
				asst(
					text("d"),
					use("s4"),
					result("s4", null, "advisor_tool_result_error"),
				),
			],
		};
		const out = stripForeignAdvisorResults(body, "acc1");
		expect(out?.strippedResults).toBe(1);
		const m = out?.body.messages as Msgs;
		expect(m[1].content).toEqual([text("a")]);
		expect(m[2].content).toHaveLength(3);
		expect(m[3].content).toHaveLength(3);
		expect(m[4].content).toHaveLength(3);
	});
	test("target key unknown uses registry", () => {
		recordAdvisorResultOwner("other", KEY_B);
		const body = {
			messages: [
				asst(text("a"), use("s1"), result("s1", KEY_B)),
				asst(text("b"), use("s2"), result("s2", KEY_A)),
			],
		};
		const out = stripForeignAdvisorResults(body, "acc1");
		expect(out?.strippedResults).toBe(1);
		const m = out?.body.messages as Msgs;
		expect(m[0].content).toEqual([text("a")]);
		expect(m[1].content).toHaveLength(3);
	});
	test("single-owner history sent to its owner returns null", () => {
		recordAdvisorResultOwner("acc1", KEY_A);
		const body = { messages: [asst(use("s1"), result("s1", KEY_A))] };
		expect(stripForeignAdvisorResults(body, "acc1")).toBeNull();
	});
});

describe("placeholders", () => {
	test("advisor-only message gets [Advisor response]", () => {
		const out = stripAllAdvisorResults({
			messages: [asst(use("s1"), result("s1", KEY_A))],
		});
		expect((out?.body.messages as Msgs)[0].content).toEqual([
			{ type: "text", text: "[Advisor response]", citations: [] },
		]);
	});
	test("thinking kept only when enabled; thinking-only gets placeholder", () => {
		const mk = (thinking?: unknown) => ({
			...(thinking ? { thinking } : {}),
			messages: [
				asst(
					{ type: "thinking", thinking: "x" },
					use("s1"),
					result("s1", KEY_A),
				),
			],
		});
		const en = stripAllAdvisorResults(mk({ type: "enabled" }));
		expect((en?.body.messages as Msgs)[0].content).toEqual([
			{ type: "thinking", thinking: "x" },
			{ type: "text", text: "[Advisor response]", citations: [] },
		]);
		const ad = stripAllAdvisorResults(mk({ type: "adaptive" }));
		expect((ad?.body.messages as Msgs)[0].content).toEqual([
			{ type: "text", text: "[Advisor response]", citations: [] },
		]);
	});
});

describe("thinking strip", () => {
	const messages = () => [
		user(),
		asst({ type: "thinking", thinking: "early" }, text("e")),
		asst(text("m"), use("s1"), result("s1", KEY_A)),
		asst({ type: "thinking", thinking: "late" }, text("  "), text("l")),
		asst({ type: "redacted_thinking", data: "x" }),
	];
	test.each([
		[{ type: "adaptive" }],
		[undefined],
	])("thinking=%p", (thinking) => {
		const out = stripAllAdvisorResults({
			...(thinking ? { thinking } : {}),
			messages: messages(),
		});
		const m = out?.body.messages as Msgs;
		expect(m[1].content).toHaveLength(2);
		expect(m[3].content).toEqual([text("l")]);
		expect(m[4].content).toEqual([
			{ type: "text", text: "[Thinking removed]", citations: [] },
		]);
		expect(out?.thinkingStrippedMessages).toBe(2);
	});
	test("a later message without thinking keeps its blank text, as BNt does", () => {
		const blankOnly = asst(text(" "), text("tail"));
		const out = stripAllAdvisorResults({
			thinking: { type: "adaptive" },
			messages: [...messages(), user(), blankOnly],
		});
		const m = out?.body.messages as Msgs;
		expect(m[6]).toBe(blankOnly);
		expect(out?.thinkingStrippedMessages).toBe(2);
	});
	test("enabled strips no thinking", () => {
		const out = stripAllAdvisorResults({
			thinking: { type: "enabled" },
			messages: messages(),
		});
		const m = out?.body.messages as Msgs;
		expect(m[3].content).toHaveLength(3);
		expect(m[4].content).toHaveLength(1);
		expect(out?.thinkingStrippedMessages).toBe(0);
	});
});

describe("copy-on-write", () => {
	test("frozen input untouched", () => {
		const body = {
			thinking: { type: "adaptive" },
			messages: [
				user(),
				asst(
					{ type: "thinking", thinking: "t" },
					use("s1"),
					result("s1", KEY_A),
				),
				asst({ type: "thinking", thinking: "t2" }, text("x")),
			],
		};
		const snapshot = structuredClone(body);
		deepFreeze(body);
		const out = stripAllAdvisorResults(body);
		expect(out).not.toBeNull();
		expect(body).toEqual(snapshot);
		expect((out?.body.messages as Msgs)[0]).toBe(body.messages[0]);
	});
});

describe("registry", () => {
	test("is 1:1 and resettable", () => {
		recordAdvisorResultOwner("a", KEY_A);
		recordAdvisorResultOwner("b", KEY_A);
		expect(getAdvisorResultOwnerKey("a")).toBeUndefined();
		expect(getAdvisorResultOwnerAccount(KEY_A)).toBe("b");
		recordAdvisorResultOwner("b", KEY_B);
		expect(getAdvisorResultOwnerAccount(KEY_A)).toBeUndefined();
		expect(getAdvisorResultOwnerKey("b")).toBe(KEY_B);
		resetAdvisorResultOwnershipForTests();
		expect(getAdvisorResultOwnerKey("b")).toBeUndefined();
	});
});

describe("misc helpers", () => {
	test("mayContainAdvisorResult", () => {
		const enc = (s: string) =>
			new TextEncoder().encode(s).buffer as ArrayBuffer;
		expect(mayContainAdvisorResult(enc('{"type":"advisor_tool_result"}'))).toBe(
			true,
		);
		expect(mayContainAdvisorResult(enc("{}"))).toBe(false);
		expect(mayContainAdvisorResult(null)).toBe(false);
	});
	test("isAdvisorResultUnprocessableMessage", () => {
		for (const m of ADVISOR_RESULT_UNPROCESSABLE_MARKERS)
			expect(isAdvisorResultUnprocessableMessage(`x ${m} y`)).toBe(true);
		expect(isAdvisorResultUnprocessableMessage("rate limited")).toBe(false);
	});
	test("stripAll", () => {
		const out = stripAllAdvisorResults({
			messages: [
				asst(text("a"), use("s1"), result("s1", KEY_A)),
				asst(text("b"), use("s2"), result("s2", null)),
				asst(
					text("c"),
					use("s3"),
					result("s3", null, "advisor_tool_result_error"),
				),
			],
		});
		expect(out?.strippedResults).toBe(2);
		expect(
			stripAllAdvisorResults({ messages: [asst(text("a")), user()] }),
		).toBeNull();
	});
});
