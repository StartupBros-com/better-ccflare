import type {
	AnthropicDegradedCohortKey,
	AnthropicDegradedPermit,
	AnthropicDegradedPermitOutcome,
} from "./anthropic-degraded-mode";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AnthropicDegradedResponseLifecycleOptions {
	readonly permit: AnthropicDegradedPermit;
	readonly accountId: string;
	readonly cohortKey: AnthropicDegradedCohortKey;
	readonly enforced: boolean;
	readonly now?: () => number;
	readonly setTimer?: typeof setTimeout;
	readonly clearTimer?: typeof clearTimeout;
	readonly onSuccess?: () => void;
	/** Invoked best-effort only after the permit authority accepts settlement. */
	readonly onSettled?: (outcome: AnthropicDegradedPermitOutcome) => void;
}

/**
 * Runtime-owned continuation of one committed degraded-mode permit.
 *
 * The coordinator remains pure: this adapter owns transport cancellation,
 * response transfer, and the watchdog. Every terminal callback races through
 * one local settlement flag before it can mutate the fenced permit.
 */
export class AnthropicDegradedResponseLifecycle {
	readonly permit: AnthropicDegradedPermit;
	readonly accountId: string;
	readonly cohortKey: AnthropicDegradedCohortKey;
	readonly enforced: boolean;
	readonly transportSignal: AbortSignal;

	private readonly transportController = new AbortController();
	private readonly now: () => number;
	private readonly setTimer: typeof setTimeout;
	private readonly clearTimer: typeof clearTimeout;
	private readonly onSuccess?: () => void;
	private readonly onSettled?: (
		outcome: AnthropicDegradedPermitOutcome,
	) => void;
	private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	private transferred = false;
	private settled = false;

	constructor(options: AnthropicDegradedResponseLifecycleOptions) {
		this.permit = options.permit;
		this.accountId = options.accountId;
		this.cohortKey = options.cohortKey;
		this.enforced = options.enforced;
		this.transportSignal = this.transportController.signal;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearTimer = options.clearTimer ?? clearTimeout;
		this.onSuccess = options.onSuccess;
		this.onSettled = options.onSettled;

		if (
			this.enforced &&
			this.permit.kind === "probe" &&
			this.permit.leaseExpiresAt !== null
		) {
			this.armWatchdog();
		}
	}

	get isTransferred(): boolean {
		return this.transferred;
	}

	get isSettled(): boolean {
		return this.settled;
	}

	matches(
		accountId: string,
		cohortKey: AnthropicDegradedCohortKey | null,
	): boolean {
		return this.accountId === accountId && this.cohortKey === cohortKey;
	}

	transferToResponse(): boolean {
		if (this.transferred || this.settled) return false;
		this.transferred = true;
		return true;
	}

	settle(
		outcome: AnthropicDegradedPermitOutcome,
		retryAfter?: unknown,
	): boolean {
		if (this.settled) return false;
		this.settled = true;
		this.clearWatchdog();

		let completed: boolean;
		try {
			completed = this.permit.complete(outcome, retryAfter);
		} catch (error) {
			if (this.enforced) throw error;
			return false;
		}
		if (!completed) return false;
		if (outcome === "success") {
			try {
				this.onSuccess?.();
			} catch {
				// Recovery bookkeeping is already committed. Overlay/affinity
				// retention is best-effort and must not revise the terminal result.
			}
		}
		try {
			this.onSettled?.(outcome);
		} catch {
			// Telemetry observes authority; it can never revise settlement.
		}
		return true;
	}

	private armWatchdog(): void {
		const leaseExpiresAt = this.permit.leaseExpiresAt;
		if (leaseExpiresAt === null || this.settled) return;
		const remainingMs = leaseExpiresAt - this.now();
		const delayMs = Math.min(
			MAX_TIMER_DELAY_MS,
			Math.max(0, Math.ceil(remainingMs)),
		);
		this.watchdogTimer = this.setTimer(() => {
			this.watchdogTimer = undefined;
			if (this.settled) return;
			// Timer resolution, fake clocks, and very long clamped timers can all
			// fire before the coordinator's lease clock reaches the deadline.
			if (this.now() < leaseExpiresAt) {
				this.armWatchdog();
				return;
			}

			// Win local settlement before any abort callback can race completion.
			this.settled = true;
			this.transportController.abort(
				new DOMException(
					"Anthropic degraded-mode recovery probe lease expired",
					"TimeoutError",
				),
			);
			// Abort propagation is synchronous. Fence/release only after the
			// transport has observed cancellation.
			try {
				if (this.permit.expire()) {
					try {
						this.onSettled?.("timeout");
					} catch {
						// Telemetry cannot revise watchdog fencing.
					}
				}
			} catch {
				// Timer callbacks cannot throw into the runtime. A generation-fenced
				// permit that is already stale is safely terminal from this adapter.
			}
		}, delayMs);
		this.watchdogTimer.unref?.();
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer === undefined) return;
		this.clearTimer(this.watchdogTimer);
		this.watchdogTimer = undefined;
	}
}
