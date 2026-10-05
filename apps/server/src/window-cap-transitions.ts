import type { WindowCapState } from "@better-ccflare/proxy/usage-throttling";

/** Points above the cap at which an engaged window is considered to be leaking. */
export const WINDOW_CAP_LEAK_MARGIN = 10;

export interface WindowCapLogEvent {
	readonly kind: "engaged" | "released" | "cap-leak";
	readonly level: "info" | "warn";
	readonly message: string;
	readonly fields: {
		readonly accountId: string;
		readonly accountName: string;
		readonly window: string;
		readonly utilization: number | null;
		readonly cap: number;
		readonly reason: WindowCapState["reason"];
	};
}

interface WindowTrackState {
	engaged: boolean;
	/** resetsAtMs of the cycle a cap-leak warning was already emitted for. */
	leakWarnedCycle: number | null | undefined;
}

/**
 * Poll-time cap transition memory (KTD7): turns per-poll WindowCapState lists
 * into at most one log event per engage/release transition, plus one cap-leak
 * warning per window per reset cycle. In-memory only: a restart re-logs an
 * engaged window once, and logs nothing for a window that is not engaged.
 */
export class WindowCapTransitionTracker {
	private readonly windows = new Map<string, WindowTrackState>();

	observe(
		accountId: string,
		accountName: string,
		states: readonly WindowCapState[],
	): WindowCapLogEvent[] {
		const events: WindowCapLogEvent[] = [];
		for (const state of states) {
			const key = `${accountId}\u0000${state.windowKey}`;
			const previous = this.windows.get(key);
			const fields = {
				accountId,
				accountName,
				window: state.windowKey,
				utilization: state.utilization,
				cap: state.cap,
				reason: state.reason,
			};
			const wasEngaged = previous?.engaged ?? false;
			let leakWarnedCycle = previous?.leakWarnedCycle;

			if (state.engaged && !wasEngaged) {
				events.push({
					kind: "engaged",
					level: "info",
					message: `Usage cap engaged for account ${accountName} (${accountId}): ${state.windowKey} ${state.reason === "stale" ? "has no current reading (snapshot stale or window not in the usage payload)" : `at ${state.utilization}%`} against cap ${state.cap}% (${state.reason})`,
					fields,
				});
			} else if (!state.engaged && wasEngaged) {
				events.push({
					kind: "released",
					level: "info",
					message: `Usage cap released for account ${accountName} (${accountId}): ${state.windowKey} at ${state.utilization ?? "unknown"}% against cap ${state.cap}% (${state.reason})`,
					fields,
				});
			}

			if (
				state.engaged &&
				state.utilization !== null &&
				state.utilization >= state.cap + WINDOW_CAP_LEAK_MARGIN &&
				leakWarnedCycle !== state.resetsAtMs
			) {
				leakWarnedCycle = state.resetsAtMs;
				events.push({
					kind: "cap-leak",
					level: "warn",
					message: `Usage cap leak for account ${accountName} (${accountId}): ${state.windowKey} reached ${state.utilization}% with cap ${state.cap}% engaged; traffic is reaching the account outside the proxy's control`,
					fields,
				});
			}

			this.windows.set(key, { engaged: state.engaged, leakWarnedCycle });
		}
		return events;
	}
}

/** One startup warning per capped account id that matches no loaded account. */
/**
 * Caps read Anthropic-format usage windows (five_hour, seven_day,
 * seven_day_<family>), which Anthropic and Codex accounts report. On any other
 * provider the capped window never appears, so the cap holds that scope
 * excluded indefinitely; say so once at startup.
 */
export function unsupportedProviderWindowCapWarnings(
	caps: Readonly<Record<string, unknown>>,
	accounts: readonly { id: string; name: string; provider: string }[],
): string[] {
	return accounts
		.filter(
			(account) =>
				Object.hasOwn(caps, account.id) &&
				account.provider !== "anthropic" &&
				account.provider !== "codex",
		)
		.map(
			(account) =>
				`account_window_caps on account ${account.name} (${account.id}) cannot be evaluated: ${account.provider} accounts do not report the usage windows caps read, so the capped scope stays excluded`,
		);
}

export function unknownWindowCapWarnings(
	unknownIds: readonly string[],
): string[] {
	return unknownIds.map(
		(id) =>
			`account_window_caps names account id ${id}, which matches no loaded account; its caps are ignored`,
	);
}
