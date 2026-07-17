import type { Account } from "./account";

export enum StrategyName {
	Session = "session",
	LeastUsed = "least-used",
	SessionAffinity = "session-affinity",
}

/**
 * Interface for strategy-specific database operations
 * Allows strategies to interact with the database without direct SQL access
 */
export interface StrategyStore {
	/**
	 * Reset session for an account
	 * Updates session_start and session_request_count
	 */
	resetAccountSession(accountId: string, timestamp: number): void;

	/**
	 * Get all accounts (optional method for strategies that need full account list)
	 */
	getAllAccounts?(): Account[] | Promise<Account[]>;

	/**
	 * Update account request count
	 */
	updateAccountRequestCount?(accountId: string, count: number): void;

	/**
	 * Get account by ID
	 */
	getAccount?(accountId: string): Account | null | Promise<Account | null>;

	/**
	 * Pause an account
	 */
	pauseAccount?(accountId: string): void;

	/**
	 * Resume a paused account
	 *
	 * Declared `void` for the widest implementer compatibility, but a real
	 * implementer (e.g. DatabaseOperations.resumeAccount) may return a richer
	 * async result such as `Promise<{ resumed: boolean; pauseReason: string
	 * | null }>` -- TypeScript's void-return covariance allows that, but
	 * callers going through this interface type only ever see `void` and
	 * silently discard the richer result. Callers that need the resumed/
	 * pauseReason outcome (e.g. the R23 guard) must call the concrete
	 * DatabaseOperations method directly rather than through StrategyStore.
	 */
	resumeAccount?(accountId: string): void;

	/**
	 * Get the representative utilization (0–100) for an account based on its
	 * most-constrained usage window. Returns null when no usage data is available.
	 */
	getAccountUtilization?(accountId: string, provider: string): number | null;
}
