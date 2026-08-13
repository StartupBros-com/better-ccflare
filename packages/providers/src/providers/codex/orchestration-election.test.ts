import { afterEach, describe, expect, test } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import {
	deriveConversationIdentity,
	extractLineageHashes,
	hashOrchestrationCallId,
	hashOrchestrationInstructions,
	ORCHESTRATION_MAX_CALL_ID_LENGTH,
	ORCHESTRATION_MAX_IDENTITY_ALIASES,
	ORCHESTRATION_MAX_LINEAGE_HASHES,
	ORCHESTRATION_MIN_CALL_ID_LENGTH,
	OrchestrationElectionStore,
} from "./orchestration-election";

const ORCHESTRATOR_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORCHESTRATOR_INSTRUCTIONS = "You are the orchestrator.";

function functionCall(callId: string) {
	return {
		type: "function_call",
		call_id: callId,
		name: "Task",
		arguments: "{}",
	};
}

function functionCallOutput(callId: string) {
	return { type: "function_call_output", call_id: callId, output: "done" };
}

function userTurn(text: string) {
	return { role: "user", content: [{ type: "input_text", text }] };
}

describe("hashOrchestrationCallId", () => {
	test("is pure and deterministic for a given session and call_id", () => {
		const a = hashOrchestrationCallId("session", "c1");
		const b = hashOrchestrationCallId("session", "c1");
		expect(a).toBeDefined();
		expect(a).toBe(b as string);
	});

	test("is session-scoped: the same call_id under a different session hashes differently", () => {
		const a = hashOrchestrationCallId("session-a", "c1");
		const b = hashOrchestrationCallId("session-b", "c1");
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
	});

	test("is domain-separated from the instructions hash", () => {
		const lineage = hashOrchestrationCallId("session", "shared-text");
		const instructions = hashOrchestrationInstructions("shared-text");
		expect(lineage).toBeDefined();
		expect(lineage).not.toBe(instructions);
	});

	test("accepts call_id strings within [1, 512] inclusive", () => {
		const min = "c".repeat(ORCHESTRATION_MIN_CALL_ID_LENGTH);
		const max = "c".repeat(ORCHESTRATION_MAX_CALL_ID_LENGTH);
		expect(hashOrchestrationCallId("session", min)).toBeDefined();
		expect(hashOrchestrationCallId("session", max)).toBeDefined();
	});

	test("rejects the empty string, over-length strings, and non-string values", () => {
		expect(hashOrchestrationCallId("session", "")).toBeUndefined();
		expect(
			hashOrchestrationCallId(
				"session",
				"c".repeat(ORCHESTRATION_MAX_CALL_ID_LENGTH + 1),
			),
		).toBeUndefined();
		expect(hashOrchestrationCallId("session", 123)).toBeUndefined();
		expect(hashOrchestrationCallId("session", null)).toBeUndefined();
		expect(hashOrchestrationCallId("session", undefined)).toBeUndefined();
	});
});

describe("hashOrchestrationInstructions", () => {
	test("is pure, deterministic, and distinguishes different instructions", () => {
		const a = hashOrchestrationInstructions("You are the orchestrator.");
		const b = hashOrchestrationInstructions("You are the orchestrator.");
		const c = hashOrchestrationInstructions("You are a subagent.");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe("extractLineageHashes", () => {
	test("filters out non-function-call items, non-objects, and invalid call_id shapes", () => {
		const hashes = extractLineageHashes(ORCHESTRATOR_SESSION_ID, [
			userTurn("hello"),
			null,
			undefined,
			42,
			"not an object",
			{ type: "function_call" }, // missing call_id
			{ type: "function_call", call_id: 123 }, // wrong call_id type
			{ type: "function_call", call_id: "" }, // too short
			{
				type: "function_call",
				call_id: "x".repeat(ORCHESTRATION_MAX_CALL_ID_LENGTH + 1),
			}, // too long
			{ type: "other_thing", call_id: "c1" },
			functionCall("c1"),
			functionCallOutput("c2"),
		]);
		expect(hashes).toEqual([
			hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "c1"),
			hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "c2"),
		]);
	});

	test("deduplicates repeated call_id hashes by their newest occurrence", () => {
		const hashes = extractLineageHashes(ORCHESTRATOR_SESSION_ID, [
			functionCall("c1"),
			functionCall("c2"),
			functionCallOutput("c1"),
			functionCall("c3"),
			functionCallOutput("c2"),
		]);
		expect(hashes).toEqual([
			hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "c1"),
			hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "c3"),
			hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "c2"),
		]);
	});

	test("caps output at ORCHESTRATION_MAX_LINEAGE_HASHES unique hashes, retaining the newest", () => {
		const total = ORCHESTRATION_MAX_LINEAGE_HASHES + 10;
		const items = Array.from({ length: total }, (_, i) =>
			functionCall(`call-${i}`),
		);
		const hashes = extractLineageHashes(ORCHESTRATOR_SESSION_ID, items);

		expect(hashes).toHaveLength(ORCHESTRATION_MAX_LINEAGE_HASHES);

		const expected = items
			.slice(total - ORCHESTRATION_MAX_LINEAGE_HASHES)
			.map((item) =>
				hashOrchestrationCallId(
					ORCHESTRATOR_SESSION_ID,
					(item as { call_id: string }).call_id,
				),
			);
		expect(hashes).toEqual(expected);

		// The oldest call_ids must not have survived the cap.
		const dropped = hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "call-0");
		expect(hashes).not.toContain(dropped);
	});

	test("is deterministic and session-scoped", () => {
		const input = [functionCall("c1"), functionCallOutput("c2")];
		const a = extractLineageHashes(ORCHESTRATOR_SESSION_ID, input);
		const b = extractLineageHashes(ORCHESTRATOR_SESSION_ID, input);
		expect(a).toEqual(b);

		const otherSession = extractLineageHashes("some-other-session", input);
		expect(otherSession).not.toEqual(a);
		expect(otherSession).toHaveLength(a.length);
	});

	test("never mutates the input array or its items", () => {
		const items = [
			functionCall("c1"),
			functionCallOutput("c1"),
			userTurn("hi"),
		];
		const snapshot = JSON.parse(JSON.stringify(items));
		extractLineageHashes(ORCHESTRATOR_SESSION_ID, items);
		expect(items).toEqual(snapshot);
		expect(Object.isFrozen(items)).toBe(false); // sanity: not relying on freezing
	});

	test("returns an empty array for input with no orchestration tool calls", () => {
		expect(extractLineageHashes(ORCHESTRATOR_SESSION_ID, [])).toEqual([]);
		expect(
			extractLineageHashes(ORCHESTRATOR_SESSION_ID, [userTurn("hi")]),
		).toEqual([]);
	});
});

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
		expect(
			store.admit("session", "conversation-a", "instructions", []),
		).toMatchObject({
			admission: "root",
			basis: "initial_claim",
		});
		expect(
			store.admit("session", "conversation-b", "instructions", []),
		).toMatchObject({
			admission: "non_root",
			basis: "rejected",
		});
		expect(
			store.admit("session", "conversation-a", "instructions", []),
		).toMatchObject({
			admission: "root",
			basis: "identity_match",
		});
		expect(
			store.admit("session", "conversation-b", "instructions", []),
		).toMatchObject({
			admission: "non_root",
			basis: "rejected",
		});
	});

	test("expires ownership after five hours of inactivity", () => {
		const store = createStore();
		expect(
			store.admit("session", "conversation-a", "instructions", []).admission,
		).toBe("root");
		now += TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT;
		expect(
			store.admit("session", "conversation-b", "instructions", []).admission,
		).toBe("root");
	});

	test("evicts the least recently active session at capacity", () => {
		const store = createStore(2);
		store.admit("old", "old-root", "instructions", []);
		now++;
		store.admit("recent", "recent-root", "instructions", []);
		now++;
		store.admit("new", "new-root", "instructions", []);
		expect(store.size).toBe(2);
		expect(
			store.admit("old", "replacement", "instructions", []).admission,
		).toBe("root");
	});

	test("reset clears all ownership", () => {
		const store = createStore();
		store.admit("session", "conversation-a", "instructions", []);
		store.reset();
		expect(store.size).toBe(0);
		expect(
			store.admit("session", "conversation-b", "instructions", []).admission,
		).toBe("root");
	});

	test("snapshot exposes a defensive copy of the current entry without mutating admission state", () => {
		const store = createStore();
		expect(store.snapshot("session")).toBeUndefined();

		store.admit("session", "conversation-a", ORCHESTRATOR_INSTRUCTIONS, [
			functionCall("c1"),
		]);
		const snapshot = store.snapshot("session");
		expect(snapshot).toBeDefined();
		expect(snapshot?.identities).toEqual(["conversation-a"]);
		expect(snapshot?.lineageHashes.length).toBe(1);
		expect(snapshot?.instructionHash).toBe(
			hashOrchestrationInstructions(ORCHESTRATOR_INSTRUCTIONS),
		);
		expect(snapshot?.lastActiveAt).toBe(now);

		// Mutating the returned snapshot's arrays must never reach internal
		// state: snapshot() always hands back fresh copies.
		(snapshot?.identities as string[]).push("injected");
		(snapshot?.lineageHashes as string[]).push("injected");
		const secondSnapshot = store.snapshot("session");
		expect(secondSnapshot?.identities).toEqual(["conversation-a"]);
		expect(secondSnapshot?.lineageHashes.length).toBe(1);

		// Snapshotting must never influence subsequent admission outcomes: the
		// existing entry still wins "root" for its own conversation and still
		// rejects a differing, unrelated one, exactly as if snapshot() had
		// never been called.
		expect(
			store.admit("session", "conversation-b", "unrelated instructions", [])
				.admission,
		).toBe("non_root");
		expect(
			store.admit("session", "conversation-a", ORCHESTRATOR_INSTRUCTIONS, [])
				.admission,
		).toBe("root");
	});
});

describe("OrchestrationElectionStore lineage continuity", () => {
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

	test("a compaction-shaped follow-up turn is accepted as root via lineage_match", () => {
		const store = createStore();

		// Turn 1 establishes the root: an initial user turn plus one completed
		// orchestration tool round trip.
		const firstTurnInput = [
			userTurn("start the task"),
			functionCall("c1"),
			functionCallOutput("c1"),
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		expect(rootConversationId).toBeDefined();
		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				rootConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				firstTurnInput,
			),
		).toMatchObject({ admission: "root", basis: "initial_claim" });

		// Compaction drops the earliest input item, keeps the tail (still
		// carrying call_id "c1"), and appends a fresh turn. Same session, same
		// instructions, and the surviving c1 lineage overlaps what turn 1
		// recorded, even though deriveConversationIdentity's hash changes
		// because the first surviving item differs.
		const compactedInput = [...firstTurnInput.slice(1), userTurn("continue")];
		const compactedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			compactedInput,
		);
		expect(compactedConversationId).toBeDefined();
		expect(compactedConversationId).not.toBe(rootConversationId);

		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				compactedConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				compactedInput,
			),
		).toMatchObject({ admission: "root", basis: "lineage_match" });

		// The accepted new identity is now also a recognized alias, and the
		// lastActiveAt was renewed by the accepted call.
		const snapshot = store.snapshot(ORCHESTRATOR_SESSION_ID);
		expect(snapshot?.identities).toEqual([
			rootConversationId,
			compactedConversationId,
		]);
		expect(snapshot?.lastActiveAt).toBe(now);
	});

	test("returns the stable canonical identity for accepted admissions and null for rejection", () => {
		const store = createStore();
		const firstTurnInput = [
			userTurn("start the task"),
			functionCall("c1"),
			functionCallOutput("c1"),
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		) as string;

		const initial = store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		expect(initial).toMatchObject({
			admission: "root",
			basis: "initial_claim",
			canonicalConversationIdentity: rootConversationId,
		});

		const compactedInput = [...firstTurnInput.slice(1), userTurn("continue")];
		const compactedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			compactedInput,
		) as string;
		const lineageMatch = store.admit(
			ORCHESTRATOR_SESSION_ID,
			compactedConversationId,
			ORCHESTRATOR_INSTRUCTIONS,
			compactedInput,
		);
		expect(lineageMatch).toMatchObject({
			admission: "root",
			basis: "lineage_match",
			canonicalConversationIdentity: rootConversationId,
		});

		const rejected = store.admit(
			ORCHESTRATOR_SESSION_ID,
			"unrelated-conversation",
			"different instructions",
			[userTurn("unrelated")],
		);
		expect(rejected).toMatchObject({
			admission: "non_root",
			basis: "rejected",
			canonicalConversationIdentity: null,
		});
	});

	test("rejects a changed identity with no lineage at all", () => {
		const store = createStore();
		const rootInput = [userTurn("start the task")];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			rootInput,
		);
		expect(rootConversationId).toBeDefined();
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			rootInput,
		);

		const otherInput = [userTurn("spawn subagent")];
		const otherConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			otherInput,
		);
		expect(otherConversationId).toBeDefined();

		// Same instructions, but neither call ever carried a function_call /
		// function_call_output, so there is no lineage to overlap.
		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				otherConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				otherInput,
			),
		).toMatchObject({ admission: "non_root", basis: "rejected" });
	});

	test("rejects a changed identity with matching lineage but changed instructions", () => {
		const store = createStore();
		const firstTurnInput = [
			userTurn("start the task"),
			functionCall("c1"),
			functionCallOutput("c1"),
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);

		const compactedInput = [...firstTurnInput.slice(1), userTurn("continue")];
		const compactedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			"different instructions",
			compactedInput,
		);
		expect(compactedConversationId).toBeDefined();

		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				compactedConversationId as string,
				"different instructions",
				compactedInput,
			),
		).toMatchObject({ admission: "non_root", basis: "rejected" });
	});

	test("rejects a changed identity with matching instructions but unrelated lineage", () => {
		const store = createStore();
		const firstTurnInput = [
			userTurn("start the task"),
			functionCall("c1"),
			functionCallOutput("c1"),
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);

		const unrelatedInput = [
			userTurn("spawn subagent"),
			functionCall("c-unrelated"),
			functionCallOutput("c-unrelated"),
		];
		const unrelatedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			unrelatedInput,
		);
		expect(unrelatedConversationId).toBeDefined();

		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				unrelatedConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				unrelatedInput,
			),
		).toMatchObject({ admission: "non_root", basis: "rejected" });
	});

	test("invalid call_id items are excluded from lineage extraction and cannot spuriously grant lineage_match", () => {
		const store = createStore();
		const firstTurnInput = [
			userTurn("start the task"),
			functionCall("c1"),
			functionCallOutput("c1"),
		];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);

		const invalidLineageInput = [
			userTurn("continue"),
			// Wrong item type: not function_call / function_call_output.
			{ type: "message", call_id: "c1", content: "not a tool call" },
			// call_id is not a string.
			{ type: "function_call", call_id: 12345, name: "Task", arguments: "{}" },
			// call_id is the empty string.
			{ type: "function_call", call_id: "", name: "Task", arguments: "{}" },
			// call_id is over the maximum length.
			{
				type: "function_call",
				call_id: "c".repeat(ORCHESTRATION_MAX_CALL_ID_LENGTH + 1),
				name: "Task",
				arguments: "{}",
			},
			// Non-object entries in the input array.
			null,
			"a string item",
			42,
		];
		const changedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			invalidLineageInput,
		);
		expect(changedConversationId).toBeDefined();

		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				changedConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				invalidLineageInput,
			),
		).toMatchObject({ admission: "non_root", basis: "rejected" });
	});

	test("accepted roots renew lastActiveAt and merge new lineage hashes", () => {
		const store = createStore();
		const firstTurnInput = [functionCall("c1"), functionCallOutput("c1")];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		expect(store.snapshot(ORCHESTRATOR_SESSION_ID)?.lineageHashes.length).toBe(
			1,
		);

		now += 1_000;
		const secondTurnInput = [functionCall("c2"), functionCallOutput("c2")];
		// Same identity re-admitted (identity_match) with a fresh call_id.
		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				rootConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				secondTurnInput,
			),
		).toMatchObject({ admission: "root", basis: "identity_match" });

		const snapshot = store.snapshot(ORCHESTRATOR_SESSION_ID);
		expect(snapshot?.lastActiveAt).toBe(now);
		expect(snapshot?.lineageHashes.length).toBe(2);
	});

	test("rejected calls do not mutate timestamps or entries", () => {
		const store = createStore();
		const firstTurnInput = [functionCall("c1"), functionCallOutput("c1")];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		const before = store.snapshot(ORCHESTRATOR_SESSION_ID);
		expect(before?.lastActiveAt).toBe(now);

		now += 1_000;
		const unrelatedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			"different instructions",
			[userTurn("spawn subagent")],
		);
		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				unrelatedConversationId as string,
				"different instructions",
				[userTurn("spawn subagent")],
			),
		).toMatchObject({ admission: "non_root", basis: "rejected" });

		const after = store.snapshot(ORCHESTRATOR_SESSION_ID);
		expect(after).toEqual(before);
	});

	test("a rejected call does not renew TTL: the true root still expires on schedule", () => {
		const store = createStore();
		const firstTurnInput = [functionCall("c1"), functionCallOutput("c1")];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId as string,
			ORCHESTRATOR_INSTRUCTIONS,
			firstTurnInput,
		);

		// Just under the TTL, a rejected sibling call arrives. It must not
		// renew the root's clock.
		now += TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT - 1;
		const unrelatedConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			"different instructions",
			[userTurn("spawn subagent")],
		);
		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				unrelatedConversationId as string,
				"different instructions",
				[userTurn("spawn subagent")],
			).admission,
		).toBe("non_root");

		// One more tick past the *original* claim's TTL: the root must have
		// expired exactly as if the rejected call had never happened, so a
		// brand new claimant wins initial_claim.
		now += 1;
		const freshConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			[userTurn("fresh start")],
		);
		expect(
			store.admit(
				ORCHESTRATOR_SESSION_ID,
				freshConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				[userTurn("fresh start")],
			),
		).toMatchObject({ admission: "root", basis: "initial_claim" });
	});

	test("bounds identity aliases to the newest 8, evicting the oldest first", () => {
		const store = createStore();
		const sharedInput = [functionCall("shared"), functionCallOutput("shared")];
		const identities: string[] = [];
		for (let i = 0; i < ORCHESTRATION_MAX_IDENTITY_ALIASES + 1; i++) {
			// The distinguishing user turn must come first: deriveConversationIdentity
			// only hashes input[0], so the shared call_id items must trail it in
			// order to both (a) vary the identity per turn and (b) still carry the
			// overlapping lineage.
			const turnInput = [userTurn(`turn-${i}`), ...sharedInput];
			const conversationId = deriveConversationIdentity(
				ORCHESTRATOR_SESSION_ID,
				ORCHESTRATOR_INSTRUCTIONS,
				turnInput,
			) as string;
			identities.push(conversationId);
			const result = store.admit(
				ORCHESTRATOR_SESSION_ID,
				conversationId,
				ORCHESTRATOR_INSTRUCTIONS,
				turnInput,
			);
			expect(result.admission).toBe("root");
		}

		const snapshot = store.snapshot(ORCHESTRATOR_SESSION_ID);
		expect(snapshot?.identities.length).toBe(
			ORCHESTRATION_MAX_IDENTITY_ALIASES,
		);
		// The oldest identity (index 0) was evicted; the newest 8 remain, in
		// insertion order.
		expect(snapshot?.identities).toEqual(
			identities.slice(1, ORCHESTRATION_MAX_IDENTITY_ALIASES + 1),
		);
		expect(snapshot?.identities).not.toContain(identities[0]);
	});

	test("bounds lineage hashes to the newest 32, evicting the oldest first", () => {
		const store = createStore();
		const rootInput = [userTurn("start the task")];
		const rootConversationId = deriveConversationIdentity(
			ORCHESTRATOR_SESSION_ID,
			ORCHESTRATOR_INSTRUCTIONS,
			rootInput,
		) as string;
		store.admit(
			ORCHESTRATOR_SESSION_ID,
			rootConversationId,
			ORCHESTRATOR_INSTRUCTIONS,
			rootInput,
		);

		for (let i = 0; i < ORCHESTRATION_MAX_LINEAGE_HASHES + 1; i++) {
			const callId = `call-${i}`;
			const result = store.admit(
				ORCHESTRATOR_SESSION_ID,
				rootConversationId,
				ORCHESTRATOR_INSTRUCTIONS,
				[functionCall(callId), functionCallOutput(callId)],
			);
			expect(result).toMatchObject({
				admission: "root",
				basis: "identity_match",
			});
		}

		const snapshot = store.snapshot(ORCHESTRATOR_SESSION_ID);
		expect(snapshot?.lineageHashes.length).toBe(
			ORCHESTRATION_MAX_LINEAGE_HASHES,
		);
		expect(snapshot?.lineageHashes).not.toContain(
			hashOrchestrationCallId(ORCHESTRATOR_SESSION_ID, "call-0"),
		);
		expect(snapshot?.lineageHashes).toContain(
			hashOrchestrationCallId(
				ORCHESTRATOR_SESSION_ID,
				`call-${ORCHESTRATION_MAX_LINEAGE_HASHES}`,
			),
		);
	});
});

describe("OrchestrationElectionStore restart limitation (documents an inherent constraint, not a bug)", () => {
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

	test("a fresh store after process restart has no lineage history, so the first writer still wins the race", () => {
		// Two distinct conversations sharing one session: the orchestrator's own
		// turn, and a sibling (e.g. a subagent) with different instructions.
		// Neither has recorded any function_call/function_call_output, so
		// neither ever produces a lineage hash on its own.
		const rootInput = [userTurn("start the task")];
		const siblingInput = [userTurn("spawn subagent")];
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

		// A process restart wipes all in-memory election state -- identities,
		// lineage hashes, and instruction hashes alike. This is a fresh store,
		// not the compacted-hash scenario above: rootConversationId is
		// unchanged from before the restart, but the store has no memory of it.
		const freshStore = createStore();

		// A concurrent request under the same session lands first after restart
		// and wins the now-empty root slot as an initial claim.
		expect(
			freshStore.admit(
				ORCHESTRATOR_SESSION_ID,
				siblingConversationId as string,
				"different instructions",
				siblingInput,
			),
		).toMatchObject({ admission: "root", basis: "initial_claim" });

		// LIMITATION (inherent, not fixed here): the true orchestrator's own
		// continuing turn, whose derived identity never changed, still loses
		// the race. With no persisted lineage or instruction hash surviving
		// the restart, and neither turn ever carrying a call_id, there is
		// nothing for it to lineage-match against.
		expect(
			freshStore.admit(
				ORCHESTRATOR_SESSION_ID,
				rootConversationId as string,
				ORCHESTRATOR_INSTRUCTIONS,
				rootInput,
			),
		).toMatchObject({ admission: "non_root", basis: "rejected" });
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
