import type {
	DegradedModePhysicalAttemptKind,
	DegradedModeRequestTracker,
} from "../anthropic-degraded-observability";

function normalizeConcreteModel(
	model: string | null | undefined,
): string | null {
	const normalized = model?.trim().toLowerCase();
	return normalized ? normalized : null;
}

/**
 * Deferred ownership of one already-classified upstream terminal response.
 * The request loop delivers it once after every unique route is spent, releases
 * it after a later route succeeds or throws, or replaces it with a later
 * retained terminal (which releases the previous response exactly once).
 */
export type RetainedTerminalKind =
	| "authoritative_context_overflow"
	| "legacy_context_overflow";

/** Durable account-level authentication outcomes observed in this request. */
export type UpstreamAuthFailureReason = "oauth_invalid_grant" | "auth_failure";

/**
 * One request-local deterministic failure bound to a concrete provider
 * capability. Account identity is deliberately absent: equivalent accounts
 * must not replay a failure that the endpoint/model capability already proved.
 */
export interface DeterministicFailureCapabilityKey {
	readonly failureKind: "authoritative_context_overflow";
	readonly provider: "codex";
	readonly endpoint: string;
	readonly model?: string | null;
}

function deterministicFailureCapabilityKey(
	input: DeterministicFailureCapabilityKey,
): string {
	return JSON.stringify([
		"deterministic-failure-capability-v1",
		input.failureKind,
		input.provider,
		input.endpoint.trim(),
		normalizeConcreteModel(input.model),
	]);
}

export interface RetainedTerminalResponse {
	readonly terminalKind?: RetainedTerminalKind;
	deliver(failoverAttempts: number): Promise<Response>;
	discard(): Promise<void>;
}

export interface PhysicalAttemptTelemetryInput {
	readonly accountId?: string | null;
	readonly candidateId?: string | null;
	readonly laneKey?: string | null;
	readonly recoveryProbe?: boolean;
}

export type HostedDispatchState = "undispatched" | "hosted_dispatched";

/**
 * Request-local ledger of concrete upstream route candidates. It deliberately
 * lives above combo and normal fallback loops so the same account/model pair is
 * never sent twice merely because it appeared through two routing surfaces.
 * In-place transport retries do not call claim and therefore remain unaffected.
 */
export class RoutingAttemptLedger {
	private readonly attempted = new Set<string>();
	private readonly retried = new Set<string>();
	private readonly blockedAccounts = new Set<string>();
	private readonly authFailures = new Map<string, UpstreamAuthFailureReason>();
	private readonly deterministicFailures = new Set<string>();
	private physicalAttempts = 0;
	private degradedTracker: DegradedModeRequestTracker | null = null;
	private guardAttemptOrdinal: number | undefined;
	private lastPhysicalAccountId: string | null | undefined;
	private retainedTerminalResponse: RetainedTerminalResponse | null = null;
	private hostedDispatch: HostedDispatchState = "undispatched";

	get attemptedCount(): number {
		return this.attempted.size;
	}

	/** Number of unique accounts that returned a definitive upstream 401. */
	get authFailureCount(): number {
		return this.authFailures.size;
	}

	/** True when at least one candidate was quarantined for upstream auth. */
	get hasAuthFailures(): boolean {
		return this.authFailures.size > 0;
	}

	/** Snapshot of account/reason pairs for terminal telemetry. */
	get authFailureEntries(): readonly {
		accountId: string;
		reason: UpstreamAuthFailureReason;
	}[] {
		return Array.from(this.authFailures, ([accountId, reason]) => ({
			accountId,
			reason,
		}));
	}

	/** Number of actual provider transports, including in-place retries. */
	get physicalAttemptCount(): number {
		return this.physicalAttempts;
	}

	/** Monotonic request-local ownership state for hosted server-tool dispatch. */
	get hostedDispatchState(): HostedDispatchState {
		return this.hostedDispatch;
	}

	/**
	 * Claim the request's single hosted server-tool dispatch. The synchronous
	 * check-and-set makes the first caller the exclusive owner; ownership is
	 * intentionally never released or reset by retries or route failover.
	 */
	claimHostedDispatch(): boolean {
		if (this.hostedDispatch === "hosted_dispatched") return false;
		this.hostedDispatch = "hosted_dispatched";
		return true;
	}

	/**
	 * Record one actual provider transport and return its request-local,
	 * one-based ordinal. This is deliberately independent of unique route
	 * claims: retries can increase this count without changing attemptedCount.
	 */
	attachDegradedTracker(
		tracker: DegradedModeRequestTracker,
		guardAttemptOrdinal?: number,
	): void {
		this.degradedTracker = tracker;
		this.guardAttemptOrdinal =
			Number.isSafeInteger(guardAttemptOrdinal) &&
			(guardAttemptOrdinal ?? 0) > 0
				? guardAttemptOrdinal
				: undefined;
	}

	recordPhysicalAttempt(input: PhysicalAttemptTelemetryInput = {}): number {
		if (this.physicalAttempts < Number.MAX_SAFE_INTEGER) {
			this.physicalAttempts++;
		}
		const accountId = input.accountId?.trim() || null;
		let kind: DegradedModePhysicalAttemptKind;
		if (input.recoveryProbe === true) {
			kind = "recovery_probe";
		} else if (
			this.physicalAttempts === 1 &&
			(this.guardAttemptOrdinal ?? 0) > 1
		) {
			kind = "guard_replay";
		} else if (this.physicalAttempts === 1) {
			kind = "initial";
		} else if (
			accountId !== null &&
			this.lastPhysicalAccountId !== undefined &&
			this.lastPhysicalAccountId !== null &&
			accountId !== this.lastPhysicalAccountId
		) {
			kind = "account_failover";
		} else {
			kind = "in_place_retry";
		}
		try {
			this.degradedTracker?.recordPhysicalAttempt({
				ordinal: this.physicalAttempts,
				kind,
				accountKey: accountId,
				candidateKey: input.candidateId,
				laneKey: input.laneKey,
			});
		} catch {
			// Telemetry never owns the provider dispatch.
		}
		this.lastPhysicalAccountId = accountId;
		return this.physicalAttempts;
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

	/**
	 * Claim the one bounded same-route retry used for a stale OAuth token.
	 *
	 * Normal route claims are intentionally one-shot so combo/model fallback
	 * surfaces cannot send the same account/model pair twice. A stale-token
	 * recovery is different: it has already claimed the route and is an
	 * explicit in-place transport retry after a refreshed credential. Keep this
	 * escape hatch narrow: it succeeds only for an existing claim and never for
	 * an account that has since been blocked by another response.
	 */
	claimRetry(accountId: string, concreteModel?: string | null): boolean {
		if (this.blockedAccounts.has(accountId)) return false;
		const key = JSON.stringify([
			"routing-attempt-v1",
			accountId,
			normalizeConcreteModel(concreteModel),
		]);
		if (!this.attempted.has(key) || this.retried.has(key)) return false;
		this.retried.add(key);
		return true;
	}

	/** Prevent every later sibling-model route for an account-wide failure. */
	blockAccount(accountId: string): void {
		this.blockedAccounts.add(accountId);
	}

	/** Record a definitive upstream auth result before the account is blocked. */
	recordAuthFailure(
		accountId: string,
		reason: UpstreamAuthFailureReason,
	): void {
		if (!accountId || this.authFailures.has(accountId)) return;
		this.authFailures.set(accountId, reason);
		this.blockedAccounts.add(accountId);
	}

	/** Record deterministic evidence without mutating account health or claims. */
	recordDeterministicFailure(
		capability: DeterministicFailureCapabilityKey,
	): void {
		this.deterministicFailures.add(
			deterministicFailureCapabilityKey(capability),
		);
	}

	/** Whether this request already proved the exact capability cannot succeed. */
	hasDeterministicFailure(
		capability: DeterministicFailureCapabilityKey,
	): boolean {
		return this.deterministicFailures.has(
			deterministicFailureCapabilityKey(capability),
		);
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

	hasRetainedTerminalKind(kind: RetainedTerminalKind): boolean {
		return this.retainedTerminalResponse?.terminalKind === kind;
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
	ledger: Pick<RoutingAttemptLedger, "attemptedCount"> &
		Partial<Pick<RoutingAttemptLedger, "authFailureCount">>,
): string {
	const routeLabel = ledger.attemptedCount === 1 ? "route" : "routes";
	const authFailureCount = ledger.authFailureCount ?? 0;
	const authSuffix =
		authFailureCount > 0
			? `; upstream authentication failed for ${authFailureCount} account${authFailureCount === 1 ? "" : "s"}`
			: "";
	return `${message} (${ledger.attemptedCount} unique account/model ${routeLabel} attempted${authSuffix})`;
}
