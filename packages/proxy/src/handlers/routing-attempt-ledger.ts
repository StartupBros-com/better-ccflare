function normalizeConcreteModel(
	model: string | null | undefined,
): string | null {
	const normalized = model?.trim().toLowerCase();
	return normalized ? normalized : null;
}

/**
 * Deferred ownership of one already-classified upstream terminal response.
 * The request loop either delivers it once after every unique route is spent,
 * or discards it once when a later unique route supersedes it or succeeds.
 */
export interface RetainedTerminalResponse {
	deliver(failoverAttempts: number): Promise<Response>;
	discard(): Promise<void>;
}

/**
 * Request-local ledger of concrete upstream route candidates. It deliberately
 * lives above combo and normal fallback loops so the same account/model pair is
 * never sent twice merely because it appeared through two routing surfaces.
 * In-place transport retries do not call claim and therefore remain unaffected.
 */
export class RoutingAttemptLedger {
	private readonly attempted = new Set<string>();
	private readonly blockedAccounts = new Set<string>();
	private retainedTerminalResponse: RetainedTerminalResponse | null = null;

	get attemptedCount(): number {
		return this.attempted.size;
	}

	claim(accountId: string, concreteModel?: string | null): boolean {
		if (this.blockedAccounts.has(accountId)) return false;
		const key = JSON.stringify([
			"routing-attempt-v1",
			accountId,
			normalizeConcreteModel(concreteModel),
		]);
		if (this.attempted.has(key)) return false;
		this.attempted.add(key);
		return true;
	}

	/** Prevent every later sibling-model route for an account-wide failure. */
	blockAccount(accountId: string): void {
		this.blockedAccounts.add(accountId);
	}

	/** Replace the deferred terminal response, releasing prior ownership once. */
	async retainTerminalResponse(
		response: RetainedTerminalResponse,
	): Promise<void> {
		const previous = this.retainedTerminalResponse;
		this.retainedTerminalResponse = response;
		if (previous) await previous.discard();
	}

	/** Transfer deferred terminal ownership to the request loop. */
	takeTerminalResponse(): RetainedTerminalResponse | null {
		const retained = this.retainedTerminalResponse;
		this.retainedTerminalResponse = null;
		return retained;
	}

	/** Release deferred terminal ownership, if any. Safe to call repeatedly. */
	async discardTerminalResponse(): Promise<void> {
		const retained = this.takeTerminalResponse();
		if (retained) await retained.discard();
	}
}

/** Build user-facing attempt telemetry from the authoritative transport ledger. */
export function formatRoutingAttemptMessage(
	message: string,
	ledger: Pick<RoutingAttemptLedger, "attemptedCount">,
): string {
	return `${message} (${ledger.attemptedCount} attempted)`;
}
