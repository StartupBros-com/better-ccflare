import { afterEach, describe, expect, test } from "bun:test";
import {
	CODEX_TURN_STATE_ACCOUNT_IDS_ENV,
	CODEX_TURN_STATE_COHORT_IDS_ENV,
	CODEX_TURN_STATE_IDLE_TTL_MS_ENV,
	CODEX_TURN_STATE_MAX_ENTRIES_ENV,
	CODEX_TURN_STATE_MODELS_ENV,
	CODEX_TURN_STATE_OBSERVE_ONLY_ENV,
	CODEX_TURN_STATE_PERCENT_ENV,
	type CodexTurnStateBeginInput,
	CodexTurnStateCoordinator,
	deriveCodexTurnStateCohortId,
	extractCodexTurnStateLineage,
	normalizeCodexTurnStateCallIds,
	readCodexTurnStateConfig,
} from "./turn-state";

const ENV_KEYS = [
	CODEX_TURN_STATE_PERCENT_ENV,
	CODEX_TURN_STATE_ACCOUNT_IDS_ENV,
	CODEX_TURN_STATE_MODELS_ENV,
	CODEX_TURN_STATE_COHORT_IDS_ENV,
	CODEX_TURN_STATE_OBSERVE_ONLY_ENV,
	CODEX_TURN_STATE_MAX_ENTRIES_ENV,
	CODEX_TURN_STATE_IDLE_TTL_MS_ENV,
] as const;

const ACCOUNT = "account-a";
const MODEL = "gpt-5.6-sol";
const CONVERSATION = "conversation-a";

function enableEligibleControl(): void {
	process.env[CODEX_TURN_STATE_PERCENT_ENV] = "0";
	process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV] = ACCOUNT;
	process.env[CODEX_TURN_STATE_MODELS_ENV] = MODEL;
}

function enableTreatment(conversationIdentity = CONVERSATION): void {
	process.env[CODEX_TURN_STATE_PERCENT_ENV] = "100";
	process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV] = ACCOUNT;
	process.env[CODEX_TURN_STATE_MODELS_ENV] = MODEL;
	process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = deriveCodexTurnStateCohortId({
		accountId: ACCOUNT,
		model: MODEL,
		conversationIdentity,
	});
}

function beginInput(
	overrides: Partial<CodexTurnStateBeginInput> = {},
): CodexTurnStateBeginInput {
	return {
		accountId: ACCOUNT,
		model: MODEL,
		conversationIdentity: CONVERSATION,
		requestId: "request-1",
		attemptId: "attempt-1",
		attemptCause: "initial",
		eligibleEndpoint: true,
		hosted: false,
		lineage: { kind: "none" },
		...overrides,
	};
}

function lineage(...ids: string[]) {
	return normalizeCodexTurnStateCallIds(ids);
}

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
});

describe("Codex turn-state config", () => {
	test("strictly parses bounded defaults and exact allowlists", () => {
		process.env[CODEX_TURN_STATE_PERCENT_ENV] = "101";
		process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV] = " account-a,account-b ";
		process.env[CODEX_TURN_STATE_MODELS_ENV] = "GPT-5.6-SOL,gpt-5.4";
		process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] =
			"0123456789abcdef,NOT-A-COHORT";
		process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV] = "true";
		process.env[CODEX_TURN_STATE_MAX_ENTRIES_ENV] = "999999";
		process.env[CODEX_TURN_STATE_IDLE_TTL_MS_ENV] = "not-a-number";

		const config = readCodexTurnStateConfig();
		expect(config.percent).toBe(100);
		expect([...config.accountIds]).toEqual(["account-a", "account-b"]);
		expect([...config.models]).toEqual(["gpt-5.6-sol", "gpt-5.4"]);
		expect([...config.cohortIds]).toEqual(["0123456789abcdef"]);
		expect(config.observeOnly).toBe(true);
		expect(config.maxEntries).toBe(2_048);
		expect(config.idleTtlMs).toBe(30 * 60_000);

		for (const raw of ["", "-1", "+1", "1.5", "1e2", " 10", "10x"]) {
			process.env[CODEX_TURN_STATE_PERCENT_ENV] = raw;
			expect(readCodexTurnStateConfig().percent).toBe(0);
		}
	});

	test("derives stable, domain-separated cohorts across model case", () => {
		const lower = deriveCodexTurnStateCohortId({
			accountId: ACCOUNT,
			model: MODEL,
			conversationIdentity: CONVERSATION,
		});
		const upper = deriveCodexTurnStateCohortId({
			accountId: ACCOUNT,
			model: MODEL.toUpperCase(),
			conversationIdentity: CONVERSATION,
		});
		expect(lower).toMatch(/^[0-9a-f]{16}$/);
		expect(upper).toBe(lower);
		expect(
			deriveCodexTurnStateCohortId({
				accountId: "account-b",
				model: MODEL,
				conversationIdentity: CONVERSATION,
			}),
		).not.toBe(lower);
	});
});

describe("Codex turn-state lineage", () => {
	test("uses only an exact latest-user tool-result set", () => {
		const extracted = extractCodexTurnStateLineage([
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "historical" }],
			},
			{ role: "assistant", content: "next" },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call-b" },
					{ type: "tool_result", tool_use_id: "call-a" },
				],
			},
		]);
		expect(extracted).toEqual(
			normalizeCodexTurnStateCallIds(["call-a", "call-b"]),
		);
		expect(extracted).not.toEqual(
			normalizeCodexTurnStateCallIds(["historical"]),
		);
	});

	test("treats a tool-result-free user message as a new turn, not ambiguity", () => {
		// Anthropic clients routinely send ordinary prompts in block-array form.
		// Classifying those as invalid would mark the turn ineligible and stop it
		// ever capturing a token.
		expect(
			extractCodexTurnStateLineage([
				{
					role: "user",
					content: [{ type: "text", text: "inspect the cache" }],
				},
			]),
		).toEqual({ kind: "none" });
		expect(
			extractCodexTurnStateLineage([
				{
					role: "user",
					content: [
						{ type: "text", text: "look at this" },
						{ type: "image", source: { type: "base64", data: "x" } },
					],
				},
			]),
		).toEqual({ kind: "none" });
		// A malformed block with no tool results is still just a new turn: no
		// lineage can be replayed, so there is nothing to get wrong.
		expect(
			extractCodexTurnStateLineage([{ role: "user", content: [null] }]),
		).toEqual({ kind: "none" });
	});

	test("rejects mixed, duplicate, control-character, oversized, and excessive lineages", () => {
		expect(
			extractCodexTurnStateLineage([
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call-a" },
						{ type: "text", text: "also do this" },
					],
				},
			]),
		).toEqual({ kind: "invalid" });
		expect(normalizeCodexTurnStateCallIds(["same", "same"])).toEqual({
			kind: "invalid",
		});
		expect(normalizeCodexTurnStateCallIds(["bad\nvalue"])).toEqual({
			kind: "invalid",
		});
		expect(normalizeCodexTurnStateCallIds(["x".repeat(513)])).toEqual({
			kind: "invalid",
		});
		expect(
			normalizeCodexTurnStateCallIds(
				Array.from({ length: 65 }, (_, index) => `call-${index}`),
			),
		).toEqual({ kind: "invalid" });
		expect(
			extractCodexTurnStateLineage([{ role: "user", content: "hello" }]),
		).toEqual({
			kind: "none",
		});
	});
});

describe("CodexTurnStateCoordinator", () => {
	test("captures the first treatment token, replays exact lineage, and advances unchanged", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		const first = coordinator.beginAttempt(beginInput());
		expect(first).toMatchObject({
			arm: "treatment",
			action: "new_turn",
			replayApplied: false,
		});
		expect(first.turnState).toBeUndefined();
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-1",
				stopReason: "tool_use",
				responseTurnState: "turn-token-1",
				outputLineage: lineage("call-1"),
			}),
		).toBe("captured");

		const continuation = coordinator.beginAttempt(
			beginInput({
				requestId: "request-2",
				attemptId: "attempt-2",
				lineage: lineage("call-1"),
			}),
		);
		expect(continuation).toMatchObject({
			arm: "treatment",
			action: "replay",
			replayApplied: true,
			turnState: "turn-token-1",
		});
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-2",
				stopReason: "tool_use",
				responseTurnState: "later-token-must-be-ignored",
				outputLineage: lineage("call-2"),
			}),
		).toBe("advanced");

		const nextContinuation = coordinator.beginAttempt(
			beginInput({
				requestId: "request-3",
				attemptId: "attempt-3",
				lineage: lineage("call-2"),
			}),
		);
		expect(nextContinuation.turnState).toBe("turn-token-1");
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-3",
				stopReason: "end_turn",
				responseTurnState: "ignored",
				outputLineage: { kind: "none" },
			}),
		).toBe("retired");
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-4",
					attemptId: "attempt-4",
					lineage: lineage("call-2"),
				}),
			),
		).toMatchObject({ action: "no_pending", replayApplied: false });
	});

	test("keeps control token-free, observe-only stateless, and treatment allowlisted", () => {
		enableEligibleControl();
		const coordinator = new CodexTurnStateCoordinator();
		const control = coordinator.beginAttempt(beginInput());
		expect(control.arm).toBe("control");
		coordinator.finalizeAttempt({
			attemptId: "attempt-1",
			stopReason: "tool_use",
			responseTurnState: "must-not-be-retained",
			outputLineage: lineage("call-1"),
		});
		const shadow = coordinator.beginAttempt(
			beginInput({
				requestId: "request-2",
				attemptId: "attempt-2",
				lineage: lineage("call-1"),
			}),
		);
		expect(shadow).toMatchObject({
			arm: "control",
			action: "would_replay",
			replayApplied: false,
		});
		expect(shadow.turnState).toBeUndefined();
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-2",
				stopReason: "tool_use",
				responseTurnState: "different-token-must-not-matter",
				outputLineage: lineage("call-2"),
			}),
		).toBe("advanced");
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-shadow-next",
					attemptId: "attempt-shadow-next",
					lineage: lineage("call-2"),
				}),
			),
		).toMatchObject({ arm: "control", action: "would_replay" });

		process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV] = "1";
		const observed = coordinator.beginAttempt(
			beginInput({
				requestId: "request-3",
				attemptId: "attempt-3",
				lineage: lineage("call-1"),
			}),
		);
		expect(observed).toMatchObject({ arm: "observe", action: "observe" });
		expect(observed.turnState).toBeUndefined();
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-3",
				stopReason: "tool_use",
				responseTurnState: "observed-only-token",
				outputLineage: lineage("call-observed"),
			}),
		).toBe("observed");

		delete process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV];
		enableTreatment();
		process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = "ffffffffffffffff";
		const notAllowlisted = new CodexTurnStateCoordinator().beginAttempt(
			beginInput(),
		);
		expect(notAllowlisted.arm).toBe("control");
	});

	test("isolates account, model, and sibling conversations", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		coordinator.beginAttempt(beginInput());
		coordinator.finalizeAttempt({
			attemptId: "attempt-1",
			stopReason: "tool_use",
			responseTurnState: "turn-token-1",
			outputLineage: lineage("call-1"),
		});

		for (const [index, override] of [
			{ accountId: "account-b" },
			{ model: "gpt-5.4" },
			{ conversationIdentity: "conversation-b" },
		].entries()) {
			const decision = coordinator.beginAttempt(
				beginInput({
					...override,
					requestId: `request-isolated-${index}`,
					attemptId: `attempt-isolated-${index}`,
					lineage: lineage("call-1"),
				}),
			);
			expect(decision.replayApplied).toBe(false);
			expect(decision.turnState).toBeUndefined();
		}
	});

	test("leases one lineage to one logical request and allows compatible retries only", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		coordinator.beginAttempt(beginInput());
		coordinator.finalizeAttempt({
			attemptId: "attempt-1",
			stopReason: "tool_use",
			responseTurnState: "turn-token-1",
			outputLineage: lineage("call-1"),
		});
		const owner = coordinator.beginAttempt(
			beginInput({
				requestId: "request-owner",
				attemptId: "attempt-owner",
				lineage: lineage("call-1"),
			}),
		);
		expect(owner.action).toBe("replay");
		const conflict = coordinator.beginAttempt(
			beginInput({
				requestId: "request-conflict",
				attemptId: "attempt-conflict",
				lineage: lineage("call-1"),
			}),
		);
		expect(conflict).toMatchObject({
			action: "concurrent_suppressed",
			replayApplied: false,
		});
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-conflict",
				stopReason: "tool_use",
				responseTurnState: "conflict-token-must-not-win",
				outputLineage: lineage("conflict-call"),
			}),
		).toBe("stale_generation");
		const retiringConflict = coordinator.beginAttempt(
			beginInput({
				requestId: "request-retiring-conflict",
				attemptId: "attempt-retiring-conflict",
				lineage: lineage("call-1"),
			}),
		);
		expect(retiringConflict.action).toBe("concurrent_suppressed");
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-retiring-conflict",
				stopReason: "end_turn",
				responseTurnState: "conflict-token-must-not-retire",
				outputLineage: { kind: "none" },
			}),
		).toBe("stale_generation");
		const retry = coordinator.beginAttempt(
			beginInput({
				requestId: "request-owner",
				attemptId: "attempt-retry",
				attemptCause: "reasoning_retry",
				lineage: lineage("call-1"),
			}),
		);
		expect(retry).toMatchObject({
			action: "retry_replay",
			replayApplied: true,
			turnState: "turn-token-1",
		});
	});

	test("suppresses rescue, failover, custom, hosted, malformed, and missing bindings", () => {
		enableTreatment();
		const cases = [
			["cache_lane_rescue", {}, "rescue_suppressed"],
			["precommit_sse_retry", {}, "rescue_suppressed"],
			["account_failover", {}, "failover_suppressed"],
			["model_fallback", {}, "failover_suppressed"],
			["initial", { eligibleEndpoint: false }, "custom_endpoint_suppressed"],
			["initial", { hosted: true }, "hosted_suppressed"],
			[
				"initial",
				{ lineage: { kind: "invalid" as const } },
				"ambiguous_lineage",
			],
			["initial", { accountId: null }, "missing_binding"],
		] as const;
		for (const [index, [attemptCause, override, action]] of cases.entries()) {
			const coordinator = new CodexTurnStateCoordinator();
			const decision = coordinator.beginAttempt(
				beginInput({
					attemptCause,
					requestId: `request-${index}`,
					attemptId: `attempt-${index}`,
					...override,
				}),
			);
			expect(decision.action).toBe(action);
			expect(decision.replayApplied).toBe(false);
		}
	});

	test("fences late responses after a new turn", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		coordinator.beginAttempt(beginInput({ attemptId: "attempt-old" }));
		coordinator.beginAttempt(
			beginInput({ requestId: "request-new", attemptId: "attempt-new" }),
		);
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-old",
				stopReason: "tool_use",
				responseTurnState: "late-token",
				outputLineage: lineage("call-late"),
			}),
		).toBe("stale_generation");
		const continuation = coordinator.beginAttempt(
			beginInput({
				requestId: "request-continuation",
				attemptId: "attempt-continuation",
				lineage: lineage("call-late"),
			}),
		);
		expect(continuation.replayApplied).toBe(false);
	});

	test("refuses terminal mutation from a request that never held the pending lease", () => {
		enableTreatment();
		for (const intruderStop of ["tool_use", "end_turn"] as const) {
			const coordinator = new CodexTurnStateCoordinator();
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-owner-1",
					attemptId: "attempt-owner-1",
				}),
			);
			expect(
				coordinator.finalizeAttempt({
					attemptId: "attempt-owner-1",
					stopReason: "tool_use",
					responseTurnState: "turn-token-1",
					outputLineage: lineage("call-1"),
				}),
			).toBe("captured");

			// The owner leases the pending lineage for its continuation.
			expect(
				coordinator.beginAttempt(
					beginInput({
						requestId: "request-owner-2",
						attemptId: "attempt-owner-2",
						lineage: lineage("call-1"),
					}),
				),
			).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });

			// A different logical request, carrying a different lineage, reaches a
			// terminal on the same scope. It must not capture over the leased entry
			// nor retire it.
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-intruder",
					attemptId: "attempt-intruder",
					lineage: lineage("call-999"),
				}),
			);
			expect(
				coordinator.finalizeAttempt({
					attemptId: "attempt-intruder",
					stopReason: intruderStop,
					responseTurnState: "intruder-token",
					outputLineage:
						intruderStop === "tool_use"
							? lineage("call-intruder")
							: { kind: "none" },
				}),
			).toBe("stale_generation");

			// The owner still advances its own turn with its own unchanged token.
			expect(
				coordinator.finalizeAttempt({
					attemptId: "attempt-owner-2",
					stopReason: "tool_use",
					responseTurnState: "turn-token-1",
					outputLineage: lineage("call-2"),
				}),
			).toBe("advanced");
			expect(
				coordinator.beginAttempt(
					beginInput({
						requestId: "request-owner-3",
						attemptId: "attempt-owner-3",
						lineage: lineage("call-2"),
					}),
				),
			).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
		}
	});

	test("refuses terminal mutation from a foreign lineage while the captured turn sits unleased", () => {
		enableTreatment();
		for (const intruderStop of ["tool_use", "end_turn"] as const) {
			const coordinator = new CodexTurnStateCoordinator();
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-owner-1",
					attemptId: "attempt-owner-1",
				}),
			);
			expect(
				coordinator.finalizeAttempt({
					attemptId: "attempt-owner-1",
					stopReason: "tool_use",
					responseTurnState: "turn-token-1",
					outputLineage: lineage("call-1"),
				}),
			).toBe("captured");

			// A capture leaves the pending entry unleased until the owner's
			// continuation arrives. A divergent request landing in that window is
			// still not the turn's owner: it must neither capture over the entry
			// nor retire it.
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-intruder",
					attemptId: "attempt-intruder",
					lineage: lineage("call-999"),
				}),
			);
			expect(
				coordinator.finalizeAttempt({
					attemptId: "attempt-intruder",
					stopReason: intruderStop,
					responseTurnState: "intruder-token",
					outputLineage:
						intruderStop === "tool_use"
							? lineage("call-intruder")
							: { kind: "none" },
				}),
			).toBe("stale_generation");

			// The owner's continuation still replays the original token.
			expect(
				coordinator.beginAttempt(
					beginInput({
						requestId: "request-owner-2",
						attemptId: "attempt-owner-2",
						lineage: lineage("call-1"),
					}),
				),
			).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
		}
	});

	test("captures and replays a turn that began as a block-array text prompt", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		const initial = coordinator.beginAttempt(
			beginInput({
				lineage: extractCodexTurnStateLineage([
					{
						role: "user",
						content: [{ type: "text", text: "inspect the cache" }],
					},
				]),
			}),
		);
		expect(initial).toMatchObject({ arm: "treatment", action: "new_turn" });
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-1",
				stopReason: "tool_use",
				responseTurnState: "turn-token-1",
				outputLineage: lineage("call-1"),
			}),
		).toBe("captured");
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-2",
					attemptId: "attempt-2",
					lineage: lineage("call-1"),
				}),
			),
		).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
	});

	test("releases a source-scope lease when the request fails over to another account", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		coordinator.beginAttempt(beginInput());
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-1",
				stopReason: "tool_use",
				responseTurnState: "turn-token-1",
				outputLineage: lineage("call-1"),
			}),
		).toBe("captured");

		// The continuation leases the turn on the source account, then errors.
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-2",
					attemptId: "attempt-2",
					lineage: lineage("call-1"),
				}),
			),
		).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-2",
				stopReason: "error",
				responseTurnState: null,
				outputLineage: { kind: "none" },
			}),
		).toBe("error_ignored");

		// The same logical request retries on a different account. That attempt is
		// suppressed on the destination scope, and the abandoned source lease has
		// to be released with it.
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-2",
					attemptId: "attempt-2-failover",
					attemptCause: "account_failover",
					accountId: "account-b",
					lineage: lineage("call-1"),
				}),
			),
		).toMatchObject({ arm: "ineligible", replayApplied: false });

		// A later continuation returning to the source account still owns its turn.
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-3",
					attemptId: "attempt-3",
					lineage: lineage("call-1"),
				}),
			),
		).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
	});

	test("keeps an active turn alive across the idle TTL boundary", () => {
		enableTreatment();
		process.env[CODEX_TURN_STATE_IDLE_TTL_MS_ENV] = "60000";
		let clock = 0;
		const coordinator = new CodexTurnStateCoordinator({ now: () => clock });

		coordinator.beginAttempt(beginInput({ attemptId: "attempt-1" }));
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-1",
				stopReason: "tool_use",
				responseTurnState: "turn-token-1",
				outputLineage: lineage("call-1"),
			}),
		).toBe("captured");

		// Activity at 40s is inside the TTL and must refresh the whole scope, not
		// just the pending entry.
		clock = 40_000;
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-2",
					attemptId: "attempt-2",
					lineage: lineage("call-1"),
				}),
			),
		).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-2",
				stopReason: "tool_use",
				responseTurnState: "turn-token-1",
				outputLineage: lineage("call-2"),
			}),
		).toBe("advanced");

		// 80s is past the TTL measured from turn creation, but only 40s since the
		// last activity, so the turn must survive.
		clock = 80_000;
		expect(
			coordinator.beginAttempt(
				beginInput({
					requestId: "request-3",
					attemptId: "attempt-3",
					lineage: lineage("call-2"),
				}),
			),
		).toMatchObject({ replayApplied: true, turnState: "turn-token-1" });
	});

	test("fences in-flight treatment responses when policy becomes observe-only", () => {
		enableTreatment();
		const coordinator = new CodexTurnStateCoordinator();
		coordinator.beginAttempt(beginInput({ attemptId: "attempt-treatment" }));

		process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV] = "1";
		coordinator.beginAttempt(
			beginInput({
				requestId: "request-observe",
				attemptId: "attempt-observe",
			}),
		);
		expect(
			coordinator.finalizeAttempt({
				attemptId: "attempt-treatment",
				stopReason: "tool_use",
				responseTurnState: "must-not-resurrect",
				outputLineage: lineage("call-late"),
			}),
		).toBe("stale_generation");

		delete process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV];
		const continuation = coordinator.beginAttempt(
			beginInput({
				requestId: "request-continuation",
				attemptId: "attempt-continuation",
				lineage: lineage("call-late"),
			}),
		);
		expect(continuation.replayApplied).toBe(false);
	});

	test("enforces max entries across generations, pending turns, and attempts", () => {
		enableTreatment();
		process.env[CODEX_TURN_STATE_MAX_ENTRIES_ENV] = "3";
		let now = 0;
		const coordinator = new CodexTurnStateCoordinator({ now: () => now });
		const seed = (conversationIdentity: string, suffix: string) => {
			process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] =
				deriveCodexTurnStateCohortId({
					accountId: ACCOUNT,
					model: MODEL,
					conversationIdentity,
				});
			coordinator.beginAttempt(
				beginInput({
					conversationIdentity,
					requestId: `request-${suffix}`,
					attemptId: `attempt-${suffix}`,
				}),
			);
			coordinator.finalizeAttempt({
				attemptId: `attempt-${suffix}`,
				stopReason: "tool_use",
				responseTurnState: `token-${suffix}`,
				outputLineage: lineage(`call-${suffix}`),
			});
		};
		seed("conversation-a", "a");
		now = 10;
		seed("conversation-b", "b");

		process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = deriveCodexTurnStateCohortId(
			{
				accountId: ACCOUNT,
				model: MODEL,
				conversationIdentity: "conversation-a",
			},
		);
		expect(
			coordinator.beginAttempt(
				beginInput({
					conversationIdentity: "conversation-a",
					requestId: "request-a2",
					attemptId: "attempt-a2",
					lineage: lineage("call-a"),
				}),
			).replayApplied,
		).toBe(false);
	});

	test("expires idle state and evicts the least-recently-used scope", () => {
		enableTreatment();
		process.env[CODEX_TURN_STATE_IDLE_TTL_MS_ENV] = "1000";
		process.env[CODEX_TURN_STATE_MAX_ENTRIES_ENV] = "2";
		let now = 0;
		const coordinator = new CodexTurnStateCoordinator({ now: () => now });
		const seed = (conversationIdentity: string, suffix: string) => {
			process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] =
				deriveCodexTurnStateCohortId({
					accountId: ACCOUNT,
					model: MODEL,
					conversationIdentity,
				});
			coordinator.beginAttempt(
				beginInput({
					conversationIdentity,
					requestId: `request-${suffix}`,
					attemptId: `attempt-${suffix}`,
				}),
			);
			coordinator.finalizeAttempt({
				attemptId: `attempt-${suffix}`,
				stopReason: "tool_use",
				responseTurnState: `token-${suffix}`,
				outputLineage: lineage(`call-${suffix}`),
			});
		};
		seed("conversation-a", "a");
		now = 10;
		seed("conversation-b", "b");
		now = 20;
		seed("conversation-c", "c");

		process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = deriveCodexTurnStateCohortId(
			{
				accountId: ACCOUNT,
				model: MODEL,
				conversationIdentity: "conversation-a",
			},
		);
		expect(
			coordinator.beginAttempt(
				beginInput({
					conversationIdentity: "conversation-a",
					requestId: "request-a2",
					attemptId: "attempt-a2",
					lineage: lineage("call-a"),
				}),
			).replayApplied,
		).toBe(false);

		now = 2_000;
		process.env[CODEX_TURN_STATE_COHORT_IDS_ENV] = deriveCodexTurnStateCohortId(
			{
				accountId: ACCOUNT,
				model: MODEL,
				conversationIdentity: "conversation-c",
			},
		);
		expect(
			coordinator.beginAttempt(
				beginInput({
					conversationIdentity: "conversation-c",
					requestId: "request-c2",
					attemptId: "attempt-c2",
					lineage: lineage("call-c"),
				}),
			).replayApplied,
		).toBe(false);
	});
});
