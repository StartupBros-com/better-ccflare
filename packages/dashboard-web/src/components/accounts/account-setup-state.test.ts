import { describe, expect, it } from "bun:test";
import type { DeviceSetupJobView } from "@better-ccflare/types";
import type {
	AccountRoutingOutcome,
	AccountRoutingSelection,
} from "./account-routing";
import {
	ACCOUNT_SETUP_EVENT_TYPES,
	ACCOUNT_SETUP_STAGES,
	type AccountSetupEvent,
	accountCreationIdentityFromTerminalStatus,
	accountSetupCanCancel,
	accountSetupCanCreate,
	createDeviceFlowPollGuard,
	createDeviceSetupAttemptKeyStore,
	createInitialAccountSetupState,
	finalizeAccountSetup,
	reduceAccountSetupState,
} from "./account-setup-state";

const selections: AccountRoutingSelection[] = [
	{ family: "opus", proposalId: "proposal-opus" },
];

const joinedOutcomes: AccountRoutingOutcome[] = [
	{
		family: "opus",
		proposalId: "proposal-opus",
		status: "joined",
		reason: "applied",
		member: null,
	},
];

function reviewedState() {
	const previewed = reduceAccountSetupState(createInitialAccountSetupState(), {
		type: "preview-loaded",
		draftKey: "draft-a",
	});
	return reduceAccountSetupState(previewed, {
		type: "review-consent-changed",
		reviewed: true,
	});
}

function deviceJob(
	status: DeviceSetupJobView["status"],
	overrides: Partial<DeviceSetupJobView> = {},
): DeviceSetupJobView {
	return {
		id: "opaque-job-id",
		provider: "codex",
		accountId: null,
		status,
		routingOutcomes: [],
		errorCode: null,
		errorMessage: null,
		createdAt: 1,
		updatedAt: 2,
		terminalAt: null,
		...overrides,
	};
}

describe("account setup state", () => {
	it("keeps one opaque idempotency key stable per provider attempt", () => {
		let sequence = 0;
		const keys = createDeviceSetupAttemptKeyStore(
			() => `generated-key-${++sequence}`,
		);

		expect(keys.get("qwen")).toBe("generated-key-1");
		expect(keys.get("qwen")).toBe("generated-key-1");
		expect(keys.get("codex")).toBe("generated-key-2");
		keys.reset("qwen");
		expect(keys.get("qwen")).toBe("generated-key-3");
		expect(keys.get("codex")).toBe("generated-key-2");
	});

	it("maps every durable server phase into setup state without client reconciliation", () => {
		const creating = reduceAccountSetupState(
			reduceAccountSetupState(reviewedState(), {
				type: "creation-started",
				kind: "device-flow",
			}),
			{ type: "device-job-updated", job: deviceJob("awaiting_authorization") },
		);
		expect(creating.stage).toBe("creating");
		expect(creating.finalizationLocked).toBe(true);

		for (const status of ["account_committed", "reconciling"] as const) {
			const finalizing = reduceAccountSetupState(creating, {
				type: "device-job-updated",
				job: deviceJob(status, { accountId: "acct:opaque/Δ-01" }),
			});
			expect(finalizing.stage).toBe("finalizing");
			expect(finalizing.createdAccountId).toBe("acct:opaque/Δ-01");
		}

		for (const status of ["complete", "complete_with_actions"] as const) {
			const outcome = reduceAccountSetupState(creating, {
				type: "device-job-updated",
				job: deviceJob(status, {
					accountId: "acct:opaque/Δ-01",
					routingOutcomes: [
						{
							family: "opus",
							proposalId: "proposal:opaque/01",
							status: "action-required",
							reason: "default-downgraded",
						},
					],
				}),
			});
			expect(outcome).toMatchObject({
				stage: "outcome",
				createdAccountId: "acct:opaque/Δ-01",
				outcomes: [
					{
						family: "opus",
						proposalId: "proposal:opaque/01",
						status: "action-required",
						reason: "default-downgraded",
						member: null,
					},
				],
			});
		}
	});

	it("maps authorization errors and expiry to an explicit safe retry state", () => {
		const active = reduceAccountSetupState(reviewedState(), {
			type: "creation-started",
			kind: "device-flow",
		});
		for (const job of [
			deviceJob("authorization_error", {
				errorCode: "authorization_denied",
				errorMessage: "Authorization was not approved",
				terminalAt: 3,
			}),
			deviceJob("expired", {
				errorCode: "authorization_expired",
				errorMessage: "Authorization expired",
				terminalAt: 3,
			}),
		]) {
			const retry = reduceAccountSetupState(active, {
				type: "device-job-updated",
				job,
			});
			expect(retry.stage).toBe("review");
			expect(retry.finalizationLocked).toBe(false);
			expect(retry.reviewed).toBe(false);
			expect(retry.createdAccountId).toBeNull();
			expect(retry.error).toBe(job.errorMessage);
		}
	});

	it("treats the immutable account ID as an exact opaque server value", () => {
		expect(
			accountCreationIdentityFromTerminalStatus({
				status: "complete",
				accountId: "acct:opaque/Δ-01",
			}),
		).toEqual({ accountId: "acct:opaque/Δ-01" });
		expect(
			accountCreationIdentityFromTerminalStatus({ accountId: " leading" }),
		).toBeNull();
		expect(
			accountCreationIdentityFromTerminalStatus({ accountId: "trailing " }),
		).toBeNull();
		expect(
			accountCreationIdentityFromTerminalStatus({ accountId: "   " }),
		).toBeNull();
		expect(accountCreationIdentityFromTerminalStatus({})).toBeNull();
	});

	it("invalidates stale reviewed drafts but ignores edits after commit", () => {
		const reviewed = reviewedState();
		const sameDraft = reduceAccountSetupState(reviewed, {
			type: "draft-changed",
			draftKey: "draft-a",
		});
		expect(sameDraft).toBe(reviewed);

		const invalidated = reduceAccountSetupState(reviewed, {
			type: "draft-changed",
			draftKey: "draft-b",
		});
		expect(invalidated).toEqual(createInitialAccountSetupState());

		const committed = reduceAccountSetupState(reviewed, {
			type: "creation-started",
			kind: "device-flow",
		});
		expect(
			reduceAccountSetupState(committed, {
				type: "draft-changed",
				draftKey: "draft-b",
			}),
		).toBe(committed);
	});

	it("accepts each commit boundary once and preserves pre-commit cancellation", () => {
		const reviewed = reviewedState();
		expect(accountSetupCanCreate(reviewed, "draft-a")).toBe(true);
		expect(accountSetupCanCreate(reviewed, "draft-b")).toBe(false);

		const authorization = reduceAccountSetupState(reviewed, {
			type: "creation-started",
			kind: "authorization-code",
		});
		expect(authorization.stage).toBe("creating");
		expect(authorization.finalizationLocked).toBe(false);
		expect(accountSetupCanCancel(authorization)).toBe(true);

		const submitted = reduceAccountSetupState(authorization, {
			type: "finalization-started",
		});
		expect(submitted.stage).toBe("finalizing");
		expect(submitted.finalizationLocked).toBe(true);
		expect(accountSetupCanCancel(submitted)).toBe(false);

		const device = reduceAccountSetupState(reviewed, {
			type: "creation-started",
			kind: "device-flow",
		});
		expect(device.stage).toBe("creating");
		expect(device.finalizationLocked).toBe(true);
		expect(accountSetupCanCancel(device)).toBe(false);
		expect(
			reduceAccountSetupState(device, {
				type: "creation-started",
				kind: "device-flow",
			}),
		).toBe(device);

		const direct = reduceAccountSetupState(reviewed, {
			type: "creation-started",
			kind: "direct",
		});
		expect(direct.stage).toBe("finalizing");
		expect(direct.finalizationLocked).toBe(true);
	});

	it("stays finalizing with the opaque ID while reconciliation is deferred", async () => {
		let state = reduceAccountSetupState(reviewedState(), {
			type: "creation-started",
			kind: "direct",
		});
		let releaseReconcile: (() => void) | undefined;
		const reconcileReady = new Promise<void>((resolve) => {
			releaseReconcile = resolve;
		});
		let notificationCount = 0;

		const pending = finalizeAccountSetup({
			result: { accountId: "acct:deferred/01" },
			selections,
			onIdentity: (identity) => {
				state = reduceAccountSetupState(state, {
					type: "identity-created",
					accountId: identity.accountId,
				});
			},
			reconcile: async () => {
				await reconcileReady;
				return joinedOutcomes;
			},
			notify: async () => {
				notificationCount += 1;
			},
		});

		expect(state.stage).toBe("finalizing");
		expect(state.createdAccountId).toBe("acct:deferred/01");
		expect(state.finalizationLocked).toBe(true);
		expect(notificationCount).toBe(0);

		releaseReconcile?.();
		const result = await pending;
		state = reduceAccountSetupState(state, {
			type: "finalization-completed",
			result,
		});
		expect(state.stage).toBe("outcome");
		expect(state.createdAccountId).toBe("acct:deferred/01");
		expect(state.outcomes).toEqual(joinedOutcomes);
		expect(notificationCount).toBe(1);
	});

	it("preserves identity and mandatory outcomes through reconcile and notification failures", async () => {
		const result = await finalizeAccountSetup({
			result: { accountId: "acct:survives/failures" },
			selections,
			reconcile: async () => {
				throw new Error("preview storage unavailable");
			},
			notify: async (identity, outcomes) => {
				expect(identity.accountId).toBe("acct:survives/failures");
				expect(outcomes[0]?.reason).toBe("apply-failed");
				throw new Error("account refresh failed");
			},
		});

		expect(result.accountId).toBe("acct:survives/failures");
		expect(result.outcomes).toEqual([
			{
				family: "opus",
				proposalId: "proposal-opus",
				status: "action-required",
				reason: "apply-failed",
				member: null,
			},
		]);
		expect(result.reportedErrors).toEqual([
			"Account was created, but routing reconciliation could not finish: preview storage unavailable",
			"account refresh failed",
		]);
		expect(result.error).toBe("account refresh failed");
		if (result.accountId === null)
			throw new Error("expected persisted identity");

		const committing = reduceAccountSetupState(reviewedState(), {
			type: "creation-started",
			kind: "direct",
		});
		const outcome = reduceAccountSetupState(
			reduceAccountSetupState(committing, {
				type: "identity-created",
				accountId: result.accountId,
			}),
			{ type: "finalization-completed", result },
		);
		expect(outcome.stage).toBe("outcome");
		expect(outcome.finalizationLocked).toBe(true);
		expect(outcome.createdAccountId).toBe("acct:survives/failures");
	});

	it("requires an account-list check after ambiguous creation failure", () => {
		const committing = reduceAccountSetupState(reviewedState(), {
			type: "creation-started",
			kind: "direct",
		});
		const failed = reduceAccountSetupState(committing, {
			type: "creation-failed",
			error: new Error("connection closed"),
			ambiguousCommit: true,
		});

		expect(failed.stage).toBe("review");
		expect(failed.finalizationLocked).toBe(false);
		expect(failed.reviewed).toBe(false);
		expect(failed.createdAccountId).toBeNull();
		expect(failed.error).toBe(
			"connection closed The request may have created the account. Check the account list before retrying.",
		);
	});

	it("consumes Done exactly once only from an outcome with a persisted identity", () => {
		const finalizing = reduceAccountSetupState(reviewedState(), {
			type: "creation-started",
			kind: "direct",
		});
		const outcome = reduceAccountSetupState(finalizing, {
			type: "finalization-completed",
			result: {
				accountId: "acct:done-once",
				outcomes: joinedOutcomes,
				error: null,
				reportedErrors: [],
			},
		});
		const done = reduceAccountSetupState(outcome, { type: "done" });
		expect(done).toEqual(createInitialAccountSetupState());
		expect(reduceAccountSetupState(done, { type: "done" })).toBe(done);

		const missingIdentity = reduceAccountSetupState(finalizing, {
			type: "finalization-completed",
			result: {
				accountId: null,
				outcomes: [],
				error: "missing account",
				reportedErrors: ["missing account"],
			},
		});
		expect(reduceAccountSetupState(missingIdentity, { type: "done" })).toBe(
			missingIdentity,
		);
	});

	it("turns missing identity into action-required outcomes without side effects", async () => {
		let reconcileCount = 0;
		let notificationCount = 0;
		const result = await finalizeAccountSetup({
			result: { accountId: " invalid" },
			selections,
			missingIdentityMessage: "Codex completed without an account ID",
			reconcile: async () => {
				reconcileCount += 1;
				return joinedOutcomes;
			},
			notify: async () => {
				notificationCount += 1;
			},
		});

		expect(result.accountId).toBeNull();
		expect(result.error).toBe("Codex completed without an account ID");
		expect(result.outcomes[0]?.reason).toBe("missing-account-id");
		expect(reconcileCount).toBe(0);
		expect(notificationCount).toBe(0);
	});

	it("allows only one device-flow poll to own terminal completion", async () => {
		const guard = createDeviceFlowPollGuard();
		let releaseStatus: (() => void) | undefined;
		const statusReady = new Promise<void>((resolve) => {
			releaseStatus = resolve;
		});
		let terminalCompletions = 0;

		const poll = async () => {
			if (!guard.tryBegin()) return;
			try {
				await statusReady;
				guard.finish();
				terminalCompletions += 1;
			} finally {
				guard.release();
			}
		};

		const first = poll();
		await poll();
		releaseStatus?.();
		await first;
		await poll();
		expect(terminalCompletions).toBe(1);
	});

	it("keeps stage and event coverage intentional", () => {
		expect(ACCOUNT_SETUP_STAGES).toEqual([
			"details",
			"review",
			"creating",
			"finalizing",
			"outcome",
		]);
		const coveredEventTypes = [
			"preview-loaded",
			"review-consent-changed",
			"draft-changed",
			"creation-started",
			"finalization-started",
			"identity-created",
			"finalization-completed",
			"creation-failed",
			"error-changed",
			"back-to-details",
			"cancelled",
			"done",
			"device-job-updated",
		] satisfies AccountSetupEvent["type"][];
		expect(coveredEventTypes).toEqual([...ACCOUNT_SETUP_EVENT_TYPES]);
	});
});
