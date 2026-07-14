import { afterEach, describe, expect, test } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import {
	deriveConversationIdentity,
	OrchestrationElectionStore,
} from "./orchestration-election";

describe("OrchestrationElectionStore", () => {
	let now = 1_000;
	const createStore = (maxSessions = 2_048) =>
		new OrchestrationElectionStore({
			clock: () => now,
			ttlMs: TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
			maxSessions,
		});

	afterEach(() => {
		now = 1_000;
	});

	test("elects exactly one root under immediate synchronous sibling admissions", () => {
		const store = createStore();
		expect(store.admit("session", "conversation-a")).toBe("root");
		expect(store.admit("session", "conversation-b")).toBe("non_root");
		expect(store.admit("session", "conversation-a")).toBe("root");
		expect(store.admit("session", "conversation-b")).toBe("non_root");
	});

	test("expires ownership after five hours of inactivity", () => {
		const store = createStore();
		expect(store.admit("session", "conversation-a")).toBe("root");
		now += TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT;
		expect(store.admit("session", "conversation-b")).toBe("root");
	});

	test("evicts the least recently active session at capacity", () => {
		const store = createStore(2);
		store.admit("old", "old-root");
		now++;
		store.admit("recent", "recent-root");
		now++;
		store.admit("new", "new-root");
		expect(store.size).toBe(2);
		expect(store.admit("old", "replacement")).toBe("root");
	});

	test("reset clears all ownership", () => {
		const store = createStore();
		store.admit("session", "conversation-a");
		store.reset();
		expect(store.size).toBe(0);
		expect(store.admit("session", "conversation-b")).toBe("root");
	});
});

describe("deriveConversationIdentity", () => {
	test("normalizes UUIDs and stays stable as history is appended", () => {
		const first = {
			role: "user",
			content: [{ type: "input_text", text: "task" }],
		};
		const upper = deriveConversationIdentity(
			"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
			"instructions",
			[first],
		);
		const lower = deriveConversationIdentity(
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"instructions",
			[first, { role: "assistant", content: "later" }],
		);
		expect(upper).toBe(lower);
	});

	test("distinguishes siblings and instructions", () => {
		const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const first = deriveConversationIdentity(session, "root", [{ text: "a" }]);
		expect(
			deriveConversationIdentity(session, "root", [{ text: "b" }]),
		).not.toBe(first);
		expect(
			deriveConversationIdentity(session, "child", [{ text: "a" }]),
		).not.toBe(first);
	});

	test("fails open without a serializable first item and never falls back to session", () => {
		const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		expect(
			deriveConversationIdentity(session, "instructions", []),
		).toBeUndefined();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(
			deriveConversationIdentity(session, "instructions", [circular]),
		).toBeUndefined();
	});
});
