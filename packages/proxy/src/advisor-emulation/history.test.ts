import { describe, expect, test } from "bun:test";
import { stripEmulatedAdvisorResults } from "../advisor-result-ownership";
import {
	advisorToolResultText,
	projectAdvisorHistoryForCodex,
} from "./history";

const EID = "srvtoolu_bccf_call_1";
const EID2 = "srvtoolu_bccf_call_2";

const call = (id: string) => ({
	type: "server_tool_use",
	id,
	name: "advisor",
	input: {},
});
const okResult = (id: string, text = "advice") => ({
	type: "advisor_tool_result",
	tool_use_id: id,
	content: { type: "advisor_result", text },
});
const errResult = (id: string) => ({
	type: "advisor_tool_result",
	tool_use_id: id,
	content: { type: "advisor_tool_result_error", error_code: "overloaded" },
});
const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({
	type: "thinking",
	thinking: t,
	signature: "sig",
});
const asst = (...content: unknown[]) => ({ role: "assistant", content });
const user = (t: string) => ({ role: "user", content: t });

describe("advisorToolResultText", () => {
	test("maps result, error, and unknown shapes", () => {
		expect(advisorToolResultText({ type: "advisor_result", text: "hi" })).toBe(
			"hi",
		);
		expect(
			advisorToolResultText({
				type: "advisor_tool_result_error",
				error_code: "too_many_requests",
			}),
		).toBe("Advisor unavailable (too_many_requests). Continue without advice.");
		expect(advisorToolResultText({ type: "advisor_redacted_result" })).toBe(
			"Advisor unavailable (unavailable). Continue without advice.",
		);
		expect(advisorToolResultText(undefined)).toBe(
			"Advisor unavailable (unavailable). Continue without advice.",
		);
	});
});

describe("projectAdvisorHistoryForCodex", () => {
	test("returns null without advisor blocks", () => {
		expect(
			projectAdvisorHistoryForCodex({
				messages: [user("a"), asst(text("b"))],
			}),
		).toBeNull();
		expect(projectAdvisorHistoryForCodex({})).toBeNull();
	});

	test("splits one mid-message pair into three messages", () => {
		const body = {
			model: "m",
			messages: [
				user("q"),
				asst(
					thinking("t1"),
					text("before"),
					call(EID),
					okResult(EID),
					thinking("t2"),
					text("after"),
				),
			],
		};
		const snapshot = structuredClone(body);
		const out = projectAdvisorHistoryForCodex(body) as {
			messages: unknown[];
		};
		expect(body).toEqual(snapshot);
		expect(out.messages).toEqual([
			user("q"),
			asst(thinking("t1"), text("before"), {
				type: "tool_use",
				id: EID,
				name: "advisor",
				input: {},
			}),
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: EID, content: "advice" }],
			},
			asst(thinking("t2"), text("after")),
		]);
	});

	test("handles two pairs in one message", () => {
		const out = projectAdvisorHistoryForCodex({
			messages: [
				asst(
					text("a"),
					call(EID),
					okResult(EID, "one"),
					text("b"),
					call(EID2),
					okResult(EID2, "two"),
					text("c"),
				),
			],
		}) as { messages: Array<{ role: string }> };
		expect(out.messages.map((m) => m.role)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	test("pair at the end produces no trailing message", () => {
		const out = projectAdvisorHistoryForCodex({
			messages: [asst(text("a"), call(EID), okResult(EID))],
		}) as { messages: Array<{ role: string }> };
		expect(out.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
	});

	test("error result becomes unavailable text", () => {
		const out = projectAdvisorHistoryForCodex({
			messages: [asst(call(EID), errResult(EID))],
		}) as { messages: Array<{ content: unknown }> };
		expect(out.messages[1].content).toEqual([
			{
				type: "tool_result",
				tool_use_id: EID,
				content: "Advisor unavailable (overloaded). Continue without advice.",
			},
		]);
	});

	test("native pairs are stripped with placeholder, emulated projected", () => {
		const out = projectAdvisorHistoryForCodex({
			messages: [
				asst(thinking("t"), call("srvtoolu_native"), {
					type: "advisor_tool_result",
					tool_use_id: "srvtoolu_native",
					content: { type: "advisor_redacted_result", encrypted_content: "x" },
				}),
				asst(text("x"), call("srvtoolu_native2"), okResult("srvtoolu_native2")),
				asst(text("y"), call(EID), okResult(EID)),
			],
		}) as { messages: Array<{ content: unknown[] }> };
		expect(out.messages[0].content).toEqual([
			thinking("t"),
			{ type: "text", text: "[Advisor response]", citations: [] },
		]);
		expect(out.messages[1].content).toEqual([text("x")]);
		expect(out.messages).toHaveLength(4);
	});

	test("orphan emulated blocks are removed", () => {
		const out = projectAdvisorHistoryForCodex({
			messages: [asst(text("a"), call(EID)), asst(text("b"), okResult(EID2))],
		}) as { messages: Array<{ content: unknown[] }> };
		expect(out.messages.map((m) => m.content)).toEqual([
			[text("a")],
			[text("b")],
		]);
	});

	test("is deterministic", () => {
		const body = { messages: [asst(text("a"), call(EID), okResult(EID))] };
		expect(projectAdvisorHistoryForCodex(body)).toEqual(
			projectAdvisorHistoryForCodex(body),
		);
	});

	test("history + in-flight projection is a prefix of the completed projection", () => {
		const history = [user("q0"), asst(text("old"))];
		const inflight = asst(thinking("t"), text("a"), call(EID), okResult(EID));
		const completed = asst(
			thinking("t"),
			text("a"),
			call(EID),
			okResult(EID),
			text("rest"),
		);
		const a = projectAdvisorHistoryForCodex({
			messages: [...history, inflight],
		}) as { messages: unknown[] };
		const b = projectAdvisorHistoryForCodex({
			messages: [...history, completed, user("next")],
		}) as { messages: unknown[] };
		expect(a.messages.slice(-2)[0]).toMatchObject({ role: "assistant" });
		expect(a.messages.slice(-1)[0]).toMatchObject({ role: "user" });
		expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
	});
});

describe("stripEmulatedAdvisorResults", () => {
	test("strips emulated pairs of any shape, leaves native alone", () => {
		const native = {
			type: "advisor_tool_result",
			tool_use_id: "srvtoolu_native",
			content: { type: "advisor_result", text: "n" },
		};
		const body = {
			messages: [
				asst(text("a"), call(EID), errResult(EID)),
				asst(text("b"), call("srvtoolu_native"), native),
				asst(call(EID2), okResult(EID2)),
			],
		};
		const res = stripEmulatedAdvisorResults(body);
		expect(res?.strippedResults).toBe(2);
		const msgs = res?.body.messages as Array<{ content: unknown[] }>;
		expect(msgs[0].content).toEqual([text("a")]);
		expect(msgs[1].content).toEqual([
			text("b"),
			call("srvtoolu_native"),
			native,
		]);
		expect(msgs[2].content).toEqual([
			{ type: "text", text: "[Advisor response]", citations: [] },
		]);
	});

	test("strips an orphan emulated call (client aborted before its result)", () => {
		const body = {
			messages: [
				asst(text("a"), call(EID)),
				asst(call("srvtoolu_native"), okResult("srvtoolu_native")),
			],
		};
		const res = stripEmulatedAdvisorResults(body);
		expect(res?.strippedResults).toBe(0);
		const msgs = res?.body.messages as Array<{ content: unknown[] }>;
		expect(msgs[0].content).toEqual([text("a")]);
		expect(msgs[1].content).toEqual([
			call("srvtoolu_native"),
			okResult("srvtoolu_native"),
		]);
	});

	test("null when nothing emulated", () => {
		expect(
			stripEmulatedAdvisorResults({
				messages: [asst(call("srvtoolu_native"), okResult("srvtoolu_native"))],
			}),
		).toBeNull();
	});
});
