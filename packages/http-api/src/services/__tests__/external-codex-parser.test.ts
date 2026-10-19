import { expect, test } from "bun:test";
import {
	codexEventDedupeKey,
	parseCodexLines,
	suppressCodexReplay,
} from "../external-codex-parser";

const usage = (input_tokens: number, cached_input_tokens = 0) => ({
	input_tokens,
	cached_input_tokens,
	output_tokens: 5,
	reasoning_output_tokens: 2,
	total_tokens: input_tokens + 5,
});
const t = (seconds: string) => `2026-10-18T00:00:${seconds}Z`;
const event = (timestamp: string, info: object, extra: object = {}) =>
	JSON.stringify({
		timestamp,
		type: "event_msg",
		payload: { type: "token_count", info, ...extra },
	});
const meta = (id: string, parent?: string) =>
	JSON.stringify({
		type: "session_meta",
		timestamp: t("10"),
		payload: { id, forked_from_id: parent, thread_source: "subagent" },
	});

test("invalid timestamp retains tokens outside tracked windows and epoch zero metadata stays valid", async () => {
	const parsed = await parseCodexLines([
		JSON.stringify({
			type: "session_meta",
			timestamp: 0,
			payload: { id: "epoch" },
		}),
		event("invalid", { last_token_usage: usage(9) }),
	]);
	expect(parsed.sessionTimestamp).toBe(0);
	expect(parsed.events[0]).toMatchObject({
		timestamp: "invalid",
		eventTs: 0,
		totalTokens: 14,
	});
});

test("cumulative-only initial totals and saturated deltas", async () => {
	const parsed = await parseCodexLines([
		meta("s"),
		event(t("00"), { total_token_usage: usage(100, 20) }),
		event(t("01"), { total_token_usage: usage(150, 30) }),
		event(t("02"), { total_token_usage: usage(10) }),
	]);
	expect(
		parsed.events.map((e) => [
			e.inputTokens,
			e.cachedInputTokens,
			e.outputTokens,
			e.totalTokens,
		]),
	).toEqual([
		[100, 20, 5, 105],
		[50, 10, 0, 50],
	]);
});
test("repeated totals suppress last usage and cached input clamps", async () => {
	const info = {
		last_token_usage: usage(10, 20),
		total_token_usage: usage(10, 20),
	};
	const parsed = await parseCodexLines([
		event(` ${t("00")} `, info),
		event(t("01"), info),
	]);
	expect(parsed.events).toHaveLength(1);
	expect(parsed.events[0]?.cachedInputTokens).toBe(10);
	expect(parsed.events[0]?.timestamp).toBe(t("00"));
});
test("persistent fallback and date-resolved auto-review model", async () => {
	const parsed = await parseCodexLines([
		event(t("00"), { last_token_usage: usage(1) }),
		event(t("01"), { last_token_usage: usage(2) }),
		JSON.stringify({
			type: "turn_context",
			payload: { model_name: " codex-auto-review " },
		}),
		event("2026-03-05T00:00:00-05:00", { last_token_usage: usage(3) }),
		event(t("04"), {
			last_token_usage: usage(4),
			metadata: { model: "gpt-6-sol" },
		}),
		event(t("05"), { last_token_usage: usage(5) }),
	]);
	expect(parsed.events.map((e) => [e.model, e.isFallbackModel])).toEqual([
		["gpt-5", true],
		["gpt-5", true],
		["gpt-5.4", true],
		["gpt-6-sol", false],
		["gpt-6-sol", false],
	]);
});
test("metadata only and real rate limit shape", async () => {
	const rate_limits = {
		credits: {
			balance: "18763.0107080000",
			has_credits: true,
			unlimited: false,
		},
		individual_limit: null,
		limit_id: "codex",
		limit_name: null,
		plan_type: "pro",
		primary: {
			resets_at: 1792186143,
			used_percent: 100.0,
			window_minutes: 10080,
		},
		rate_limit_reached_type: null,
		secondary: null,
		spend_control_reached: null,
	};
	const parsed = await parseCodexLines([
		meta("s"),
		event(t("00"), { last_token_usage: usage(1) }, { rate_limits }),
		"{broken",
		JSON.stringify({ type: "message", body: "SECRET" }),
	]);
	expect(parsed.malformedLines).toBe(1);
	expect(parsed.events[0]).toMatchObject({
		rateLimitResetsAt: 1792186143,
		creditsBalance: "18763.0107080000",
		creditsHasCredits: true,
		primaryUsedPercent: 100,
		planType: "pro",
		limitId: "codex",
	});
	expect(JSON.stringify(parsed)).not.toContain("SECRET");
});
test("headless nested aliases and zero total derive without double reasoning", async () => {
	const parsed = await parseCodexLines([
		JSON.stringify({
			result: {
				created_at: 1792281600,
				model: "gpt-6-sol",
				usage: {
					prompt_tokens: "50",
					cached_tokens: "5",
					completion_tokens: 12,
					reasoning_tokens: 4,
					total_tokens: 0,
				},
			},
		}),
	]);
	expect(parsed.events[0]).toMatchObject({
		inputTokens: 50,
		cachedInputTokens: 5,
		outputTokens: 12,
		reasoningOutputTokens: 4,
		totalTokens: 62,
		timestamp: "2026-10-18T00:00:00.000Z",
	});
});
test("subagent fork suppresses parent replay", async () => {
	const parent = await parseCodexLines([
		meta("parent"),
		event(t("00"), { last_token_usage: usage(100) }),
		event(t("05"), { last_token_usage: usage(200) }),
		event(t("20"), { last_token_usage: usage(300) }),
	]);
	const child = await parseCodexLines([
		meta("child", "parent"),
		event(t("10.000"), { last_token_usage: usage(100) }),
		event(t("10.010"), { last_token_usage: usage(200) }),
		event(t("25"), { last_token_usage: usage(7) }),
	]);
	expect(
		[...parent.events, ...suppressCodexReplay(child, parent)].reduce(
			(n, e) => n + e.totalTokens,
			0,
		),
	).toBe(627);
});
test("parent-less fork suppresses rewritten burst across second boundary", async () => {
	const child = await parseCodexLines([
		meta("child", "absent"),
		event(t("10.990"), { last_token_usage: usage(100) }),
		event(t("11.010"), { last_token_usage: usage(200) }),
		event(t("11.100"), { last_token_usage: usage(300) }),
		event(t("25"), { last_token_usage: usage(7) }),
	]);
	expect(suppressCodexReplay(child).map((e) => e.totalTokens)).toEqual([12]);
});
test("no burst preserves own events and self parent has no lookup path", async () => {
	const child = await parseCodexLines([
		meta("child", "absent"),
		event(t("10"), { last_token_usage: usage(100) }),
		event(t("25"), { last_token_usage: usage(7) }),
	]);
	expect(suppressCodexReplay(child)).toHaveLength(2);
	const self = await parseCodexLines([
		meta("self", "self"),
		event(t("10"), { last_token_usage: usage(100) }),
		event(t("10.010"), { last_token_usage: usage(7) }),
	]);
	expect(self.parentId).toBeNull();
	expect(suppressCodexReplay(self)).toHaveLength(0);
});
test("global dedupe key ignores home and session", async () => {
	const a = await parseCodexLines([
		meta("a"),
		event(t("00"), { last_token_usage: usage(100) }),
	]);
	const b = await parseCodexLines([
		meta("b"),
		event(t("00"), { last_token_usage: usage(100) }),
	]);
	const first = a.events[0];
	const second = b.events[0];
	if (!first || !second) throw new Error("Expected both source events");
	expect(codexEventDedupeKey(first)).toBe(codexEventDedupeKey(second));
	expect(codexEventDedupeKey({ ...first, reasoningOutputTokens: 3 })).not.toBe(
		codexEventDedupeKey(first),
	);
});

test("partial parent match stops suppression at the first mismatch", async () => {
	const parent = await parseCodexLines([
		meta("parent"),
		event(t("00"), { last_token_usage: usage(100) }),
		event(t("05"), { last_token_usage: usage(200) }),
	]);
	const child = await parseCodexLines([
		meta("child", "parent"),
		event(t("10"), { last_token_usage: usage(100) }),
		event(t("10.010"), { last_token_usage: usage(7) }),
		event(t("10.020"), { last_token_usage: usage(200) }),
	]);
	expect(suppressCodexReplay(child, parent).map((e) => e.totalTokens)).toEqual([
		12, 205,
	]);
});
test("parent first mismatch falls back to rewritten burst", async () => {
	const parent = await parseCodexLines([
		meta("parent"),
		event(t("00"), { last_token_usage: usage(100) }),
	]);
	const child = await parseCodexLines([
		meta("child", "parent"),
		event(t("10"), { last_token_usage: usage(200) }),
		event(t("10.010"), { last_token_usage: usage(300) }),
		event(t("25"), { last_token_usage: usage(7) }),
	]);
	expect(suppressCodexReplay(child, parent).map((e) => e.totalTokens)).toEqual([
		12,
	]);
});
test("subagent source parent id is recognized from first line only", async () => {
	const line = JSON.stringify({
		timestamp: t("10"),
		type: "session_meta",
		payload: {
			id: "child",
			source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
		},
	});
	const parsed = await parseCodexLines([
		line,
		event(t("11"), { last_token_usage: usage(7) }),
	]);
	expect(parsed.parentId).toBe("parent");
	const late = await parseCodexLines(
		[event(t("11"), { last_token_usage: usage(7) }), line],
		{ sessionId: "file" },
	);
	expect(late.parentId).toBeNull();
	expect(late.sessionId).toBe("file");
});
test("auto-review release dates and invalid date use the embedded snapshot", async () => {
	const parsed = await parseCodexLines([
		event("2026-04-23T00:00:00Z", {
			model: "codex-auto-review",
			last_token_usage: usage(1),
		}),
		event("2026-02-05T00:00:00Z", { last_token_usage: usage(2) }),
		event("2025-12-11T00:00:00Z", { last_token_usage: usage(3) }),
		event("2026-02-30T00:00:00Z", { last_token_usage: usage(4) }),
	]);
	expect(parsed.events.map((e) => e.model)).toEqual([
		"gpt-5.5",
		"gpt-5.3-codex",
		"gpt-5.2-codex",
		"gpt-5",
	]);
});
test("numeric timestamps normalize seconds and milliseconds and absent usage skips", async () => {
	const parsed = await parseCodexLines([
		JSON.stringify({
			timestamp: 1792281600,
			type: "event_msg",
			payload: { type: "token_count", info: { last_token_usage: usage(1) } },
		}),
		JSON.stringify({
			timestamp: 1792281600001,
			type: "event_msg",
			payload: { type: "token_count", info: { last_token_usage: usage(2) } },
		}),
		event(t("03"), {}),
	]);
	expect(parsed.events.map((e) => e.timestamp)).toEqual([
		"2026-10-18T00:00:00.000Z",
		"2026-10-18T00:00:00.001Z",
	]);
});

test("self-parented fork suppresses the oracle rewritten burst", async () => {
	const self = await parseCodexLines([
		meta("self", "self"),
		event(t("10"), { last_token_usage: usage(100) }),
		event(t("10.010"), { last_token_usage: usage(200) }),
		event(t("25"), { last_token_usage: usage(7) }),
	]);
	expect(self.parentId).toBeNull();
	expect(self.forked).toBe(true);
	expect(suppressCodexReplay(self).map((e) => e.totalTokens)).toEqual([12]);
});
