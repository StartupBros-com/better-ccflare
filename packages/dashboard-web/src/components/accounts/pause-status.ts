/**
 * Pure, testable pause-status display helper for AccountListItem.
 *
 * R25 (OAuth control-plane hotfix, U8): terminal auth pauses
 * (pause_reason === "oauth_invalid_grant") must be shown distinctly so
 * reauthentication reads as the primary action, not just another pause.
 * Every other value -- known reasons like "manual"/"overage", null, and any
 * unknown/legacy string -- must remain safely renderable as generic
 * "Paused" copy: this function must never throw or return something
 * misleading for a reason it doesn't specifically recognize.
 */
import { PAUSE_REASON_NEEDS_REAUTH } from "@better-ccflare/core";

export interface PauseStatusDisplay {
	/** Copy to render next to/instead of the generic "Paused" badge. */
	label: string;
	/** True when reauthentication is the action that will actually unblock the account. */
	reauthRequired: boolean;
}

export function pauseStatusDisplay(
	pauseReason: string | null | undefined,
): PauseStatusDisplay {
	if (pauseReason === PAUSE_REASON_NEEDS_REAUTH) {
		return { label: "Re-authentication required", reauthRequired: true };
	}
	return { label: "Paused", reauthRequired: false };
}
