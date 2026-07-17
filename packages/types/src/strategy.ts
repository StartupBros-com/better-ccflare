import type { Account } from "./account";

export enum StrategyName {
	Session = "session",
	LeastUsed = "least-used",
	SessionAffinity = "session-affinity",
}

/**
 * Outcome of a {@link StrategyStore.resumeAccount} call. `resumed: false`
 * means the DB refused the resume (e.g. it is paused for a reason the guard
 * blocks, or a concurrent writer already changed its state) -- callers must
 * not treat the account as unpaused when this happens.
 */
export interface ResumeResult {
	resumed: boolean;
	pauseReason: string | null;
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
	 * Resume a paused account. Callers MUST await the result and only treat
	 * the account as unpaused when `resumed === true` -- the DB may refuse
	 * (e.g. blocked pause reason, or a concurrent writer already changed the
	 * row), and optimistically flipping the in-memory `paused` flag anyway
	 * would route a request through an account the DB just refused to
	 * resume.
	 */
	resumeAccount?(accountId: string): Promise<ResumeResult>;

	/**
	 * Get the representative utilization (0–100) for an account based on its
	 * most-constrained usage window. Returns null when no usage data is available.
	 */
	getAccountUtilization?(accountId: string, provider: string): number | null;
}
