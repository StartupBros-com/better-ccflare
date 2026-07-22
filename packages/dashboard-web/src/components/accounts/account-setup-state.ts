import type {
	DeviceSetupJobView,
	DeviceSetupProvider,
} from "@better-ccflare/types";
import type {
	AccountRoutingOutcome,
	AccountRoutingSelection,
} from "./account-routing";
import { missingAccountIdentityOutcomes } from "./account-routing";

export interface AccountCreationIdentity {
	accountId: string;
}

export const ACCOUNT_SETUP_STAGES = [
	"details",
	"review",
	"creating",
	"finalizing",
	"outcome",
] as const;

export type AccountSetupRoutingStage = (typeof ACCOUNT_SETUP_STAGES)[number];

export type AccountSetupCreationKind =
	| "authorization-code"
	| "device-flow"
	| "direct";

export interface AccountSetupState {
	stage: AccountSetupRoutingStage;
	previewDraftKey: string | null;
	reviewed: boolean;
	finalizationLocked: boolean;
	createdAccountId: string | null;
	outcomes: AccountRoutingOutcome[];
	error: string | null;
}

export interface AccountSetupFinalizationResult {
	accountId: string | null;
	outcomes: AccountRoutingOutcome[];
	error: string | null;
	reportedErrors: string[];
}

export type AccountSetupEvent =
	| { type: "preview-loaded"; draftKey: string }
	| { type: "review-consent-changed"; reviewed: boolean }
	| { type: "draft-changed"; draftKey: string }
	| { type: "creation-started"; kind: AccountSetupCreationKind }
	| { type: "finalization-started" }
	| { type: "identity-created"; accountId: string }
	| {
			type: "finalization-completed";
			result: AccountSetupFinalizationResult;
	  }
	| {
			type: "creation-failed";
			error: unknown;
			retryStage?: "review" | "creating";
			ambiguousCommit?: boolean;
	  }
	| { type: "error-changed"; error: string | null }
	| { type: "back-to-details" }
	| { type: "cancelled" }
	| { type: "done" }
	| { type: "device-job-updated"; job: DeviceSetupJobView };

export const ACCOUNT_SETUP_EVENT_TYPES = [
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
] as const satisfies readonly AccountSetupEvent["type"][];

export interface DeviceSetupAttemptKeyStore {
	get(provider: DeviceSetupProvider): string;
	reset(provider?: DeviceSetupProvider): void;
}

/** One key per logical attempt; transport retries reuse it until terminal reset. */
export function createDeviceSetupAttemptKeyStore(
	createKey: () => string = () => `device-setup-${crypto.randomUUID()}`,
): DeviceSetupAttemptKeyStore {
	const keys = new Map<DeviceSetupProvider, string>();
	return {
		get(provider) {
			const existing = keys.get(provider);
			if (existing) return existing;
			const created = createKey();
			keys.set(provider, created);
			return created;
		},
		reset(provider) {
			if (provider) keys.delete(provider);
			else keys.clear();
		},
	};
}

export function createInitialAccountSetupState(): AccountSetupState {
	return {
		stage: "details",
		previewDraftKey: null,
		reviewed: false,
		finalizationLocked: false,
		createdAccountId: null,
		outcomes: [],
		error: null,
	};
}

export function accountSetupCanCancel(state: AccountSetupState): boolean {
	return (
		!state.finalizationLocked &&
		state.stage !== "finalizing" &&
		state.stage !== "outcome"
	);
}

export function accountSetupCanCreate(
	state: AccountSetupState,
	currentDraftKey: string,
): boolean {
	return (
		state.stage === "review" &&
		state.reviewed &&
		state.previewDraftKey === currentDraftKey
	);
}

function creationFailureMessage(
	error: unknown,
	ambiguousCommit: boolean,
): string {
	const baseMessage =
		error instanceof Error ? error.message : "Unable to create the account";
	return ambiguousCommit
		? `${baseMessage} The request may have created the account. Check the account list before retrying.`
		: baseMessage;
}

export function reduceAccountSetupState(
	state: AccountSetupState,
	event: AccountSetupEvent,
): AccountSetupState {
	switch (event.type) {
		case "preview-loaded":
			if (state.finalizationLocked) return state;
			return {
				...state,
				stage: "review",
				previewDraftKey: event.draftKey,
				reviewed: false,
				createdAccountId: null,
				outcomes: [],
				error: null,
			};
		case "review-consent-changed":
			if (state.stage !== "review" || state.reviewed === event.reviewed) {
				return state;
			}
			return { ...state, reviewed: event.reviewed };
		case "draft-changed":
			if (
				state.finalizationLocked ||
				state.previewDraftKey === null ||
				state.previewDraftKey === event.draftKey
			) {
				return state;
			}
			return createInitialAccountSetupState();
		case "creation-started": {
			if (
				state.stage !== "review" ||
				!state.reviewed ||
				state.previewDraftKey === null
			) {
				return state;
			}
			if (event.kind === "authorization-code") {
				return {
					...state,
					stage: "creating",
					finalizationLocked: false,
					error: null,
				};
			}
			return {
				...state,
				stage: event.kind === "device-flow" ? "creating" : "finalizing",
				finalizationLocked: true,
				error: null,
			};
		}
		case "finalization-started":
			if (state.stage === "finalizing" && state.finalizationLocked) {
				return state;
			}
			if (state.stage !== "creating") return state;
			return {
				...state,
				stage: "finalizing",
				finalizationLocked: true,
				error: null,
			};
		case "identity-created":
			if (state.stage !== "finalizing" || !state.finalizationLocked) {
				return state;
			}
			return { ...state, createdAccountId: event.accountId, error: null };
		case "finalization-completed":
			if (state.stage !== "finalizing" || !state.finalizationLocked) {
				return state;
			}
			return {
				...state,
				stage: "outcome",
				finalizationLocked: true,
				createdAccountId: event.result.accountId,
				outcomes: event.result.outcomes,
				error: event.result.error,
			};
		case "creation-failed":
			return {
				...state,
				stage: event.retryStage ?? "review",
				finalizationLocked: false,
				createdAccountId: null,
				outcomes: [],
				reviewed: event.ambiguousCommit ? false : state.reviewed,
				error: creationFailureMessage(
					event.error,
					event.ambiguousCommit ?? false,
				),
			};
		case "error-changed":
			return state.error === event.error
				? state
				: { ...state, error: event.error };
		case "back-to-details":
			if (state.finalizationLocked || state.stage !== "review") return state;
			return { ...state, stage: "details", reviewed: false, error: null };
		case "cancelled":
			return accountSetupCanCancel(state)
				? createInitialAccountSetupState()
				: state;
		case "done":
			return state.stage === "outcome" && state.createdAccountId !== null
				? createInitialAccountSetupState()
				: state;
		case "device-job-updated": {
			const { job } = event;
			if (job.status === "awaiting_authorization") {
				return {
					...state,
					stage: "creating",
					finalizationLocked: true,
					error: null,
				};
			}
			if (job.status === "account_committed" || job.status === "reconciling") {
				const identity = accountCreationIdentityFromTerminalStatus(job);
				return {
					...state,
					stage: "finalizing",
					finalizationLocked: true,
					createdAccountId: identity?.accountId ?? null,
					error: identity ? null : "Account identity is unavailable",
				};
			}
			if (job.status === "complete" || job.status === "complete_with_actions") {
				const identity = accountCreationIdentityFromTerminalStatus(job);
				if (!identity) {
					return {
						...state,
						stage: "review",
						finalizationLocked: false,
						reviewed: false,
						createdAccountId: null,
						outcomes: [],
						error: "Account setup completed without an immutable account ID",
					};
				}
				return {
					...state,
					stage: "outcome",
					finalizationLocked: true,
					createdAccountId: identity.accountId,
					outcomes: job.routingOutcomes.map((outcome) => ({
						...outcome,
						member: null,
					})),
					error: null,
				};
			}
			return {
				...state,
				stage: "review",
				finalizationLocked: false,
				reviewed: false,
				createdAccountId: null,
				outcomes: [],
				error:
					job.errorMessage ??
					(job.status === "expired"
						? "Authorization expired"
						: "Authorization failed"),
			};
		}
		default: {
			const exhaustiveEvent: never = event;
			return exhaustiveEvent;
		}
	}
}

/** Device-flow completion must fail closed when immutable identity is absent. */
export function accountCreationIdentityFromTerminalStatus(status: {
	status?: unknown;
	accountId?: unknown;
}): AccountCreationIdentity | null {
	if (
		typeof status.accountId !== "string" ||
		!status.accountId ||
		status.accountId.trim() !== status.accountId
	) {
		return null;
	}
	return { accountId: status.accountId };
}

function actionRequiredOutcomes(
	selections: readonly AccountRoutingSelection[],
): AccountRoutingOutcome[] {
	return selections.map((selection) => ({
		family: selection.family,
		proposalId: selection.proposalId,
		status: "action-required",
		reason: "apply-failed",
		member: null,
	}));
}

function messageFrom(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export async function finalizeAccountSetup(params: {
	result: { accountId?: unknown };
	selections: readonly AccountRoutingSelection[];
	missingIdentityMessage?: string;
	onIdentity?: (identity: AccountCreationIdentity) => void;
	reconcile: (
		identity: AccountCreationIdentity,
		selections: readonly AccountRoutingSelection[],
	) => Promise<AccountRoutingOutcome[]>;
	notify: (
		identity: AccountCreationIdentity,
		outcomes: readonly AccountRoutingOutcome[],
	) => void | Promise<void>;
}): Promise<AccountSetupFinalizationResult> {
	const identity = accountCreationIdentityFromTerminalStatus(params.result);
	if (!identity) {
		const error =
			params.missingIdentityMessage ??
			"Account creation completed without an immutable account ID";
		return {
			accountId: null,
			outcomes: missingAccountIdentityOutcomes(params.selections),
			error,
			reportedErrors: [error],
		};
	}

	params.onIdentity?.(identity);
	const reportedErrors: string[] = [];
	let outcomes: AccountRoutingOutcome[];
	try {
		outcomes = await params.reconcile(identity, params.selections);
	} catch (error) {
		const detail = messageFrom(error, "unknown reconciliation error");
		reportedErrors.push(
			`Account was created, but routing reconciliation could not finish: ${detail}`,
		);
		outcomes = actionRequiredOutcomes(params.selections);
	}

	try {
		await params.notify(identity, outcomes);
	} catch (error) {
		reportedErrors.push(
			messageFrom(error, "Account routing changed, but refresh failed"),
		);
	}

	return {
		accountId: identity.accountId,
		outcomes,
		error: reportedErrors.at(-1) ?? null,
		reportedErrors,
	};
}

export interface DeviceFlowPollGuard {
	tryBegin: () => boolean;
	release: () => void;
	finish: () => void;
	reset: () => void;
}

/** Keep interval callbacks single-flight and terminal completion exactly once. */
export function createDeviceFlowPollGuard(): DeviceFlowPollGuard {
	let inFlight = false;
	let terminal = false;

	return {
		tryBegin: () => {
			if (inFlight || terminal) return false;
			inFlight = true;
			return true;
		},
		release: () => {
			inFlight = false;
		},
		finish: () => {
			terminal = true;
		},
		reset: () => {
			inFlight = false;
			terminal = false;
		},
	};
}
