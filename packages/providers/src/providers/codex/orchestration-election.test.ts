import { afterEach, describe, expect, test } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import {
	deriveConversationIdentity,
	OrchestrationElectionStore,
} from "./orchestration-election";

const ORCHESTRATOR_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORCHESTRATOR_INSTRUCTIONS = "You are the orchestrator.";

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

	test("peek exposes the current entry without mutating admission state", () => {
		const store = createStore();
		expect(store.peek("session")).toBeUndefined();

		store.admit("session", "conversation-a");
		store.recordRootInstructions("session", "orchestrator instructions");
		expect(store.peek("session")).toEqual({
			conversationId: "conversation-a",
			lastActiveAt: now,
			instructions: "orchestrator instructions",
		});

		// Peeking must never influence subsequent admission outcomes: the
		// existing entry still wins "root" for its own conversation and still
		// rejects a differing one, exactly as if peek() had never been called.
		expect(store.admit("session", "conversation-b")).toBe("non_root");
		expect(store.admit("session", "conversation-a")).toBe("root");
	});
});

describe("OrchestrationElectionStore compaction and restart regressions (documents today's bug)", () => {
	let now = 1_000;
	const createStore = () =>
		new OrchestrationElectionStore({
			clock: () => now,
			ttlMs: TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
			maxSessions: 2_048,
		});

	afterEach(() => {
		now = 1_000;
	});

	test("a compaction-shaped follow-up turn is demoted to non_root even though it is the same conversation", () => {
		const store = createStore();

		// Turn 1 establishes the root: an initial user turn plus one completed
		// orchestration tool round trip.
		const firstTurnInput = [
			{
				role: "user",
				content: [{ type: "input_text", text: "start the task" }],
			},
			{ type: "function_call", call_id: "c1", name: "Task", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: "done" },
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		expect(rootConversationId).toBeDefined();
		expect(
			store.admit(ORCHESTRATOR_SESSION_ID, rootConversationId as string),
		).toBe("root");

		// Compaction drops the earliest input item, keeps the tail, and appends
		// a fresh turn. Same session, same instructions, and this is still the
		// same logical conversation continuing, but the first surviving item is
		// now what used to be item[1], so deriveConversationIdentity's hash
		// changes anyway.
		const compactedInput = [
			...firstTurnInput.slice(1),
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
		];
		const compactedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			compactedInput,
		);
		expect(compactedConversationId).toBeDefined();
		expect(compactedConversationId).not.toBe(rootConversationId);

		// BUG (documented, not fixed here): the continuing orchestrator turn is
		// admitted as non_root because compaction reshaped the hash, not
		// because this is actually a different conversation.
		expect(
			store.admit(ORCHESTRATOR_SESSION_ID, compactedConversationId as string),
		).toBe("non_root");
	});

	test("a fresh store after process restart can demote the true root too, via a different trigger", () => {
		// Two distinct conversations sharing one session: the orchestrator's own
		// turn, and a sibling (e.g. a subagent) with different instructions.
		const rootInput = [
			{
				role: "user",
				content: [{ type: "input_text", text: "start the task" }],
			},
		];
		const siblingInput = [
			{
				role: "user",
				content: [{ type: "input_text", text: "spawn subagent" }],
			},
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			rootInput,
		);
		const siblingConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			"different instructions",
			siblingInput,
		);
		expect(rootConversationId).toBeDefined();
		expect(siblingConversationId).toBeDefined();
		expect(siblingConversationId).not.toBe(rootConversationId);

		// A process restart wipes the in-memory election state. This is a fresh
		// store, not the compacted-hash scenario above: rootConversationId is
		// unchanged from before the restart.
		const freshStore = createStore();

		// A concurrent request under the same session lands first after restart
		// and wins the now-empty root slot.
		expect(
			freshStore.admit(
				ORCHESTRATOR_SESSION_ID,
				siblingConversationId as string,
			),
		).toBe("root");

		// BUG (documented, not fixed here): the true orchestrator's own
		// continuing turn, whose derived identity never changed, still loses the
		// race and is demoted. Same symptom as the compaction case above, but
		// the trigger here is restart-timing, not a reshaped hash.
		expect(
			freshStore.admit(ORCHESTRATOR_SESSION_ID, rootConversationId as string),
		).toBe("non_root");
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
