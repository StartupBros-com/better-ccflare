import { Logger } from "@better-ccflare/logger";

export const PRE_TRANSPORT_AGENT_INTERCEPTION_TIMEOUT_ENV =
	"CCFLARE_AGENT_INTERCEPTION_TIMEOUT_MS";
export const PRE_TRANSPORT_ACCOUNT_SELECTION_TIMEOUT_ENV =
	"CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS";
export const PRE_TRANSPORT_CREDENTIAL_RESOLUTION_TIMEOUT_ENV =
	"CCFLARE_CREDENTIAL_RESOLUTION_TIMEOUT_MS";

export const PRE_TRANSPORT_DEFAULT_AGENT_INTERCEPTION_TIMEOUT_MS = 5_000;
export const PRE_TRANSPORT_DEFAULT_ACCOUNT_SELECTION_TIMEOUT_MS = 20_000;
export const PRE_TRANSPORT_DEFAULT_CREDENTIAL_RESOLUTION_TIMEOUT_MS = 25_000;

export const PRE_TRANSPORT_MAX_AGENT_INTERCEPTION_TIMEOUT_MS = 30_000;
export const PRE_TRANSPORT_MAX_ACCOUNT_SELECTION_TIMEOUT_MS = 60_000;
export const PRE_TRANSPORT_MAX_CREDENTIAL_RESOLUTION_TIMEOUT_MS = 60_000;

export type PreTransportPhase =
	| "agent_interception"
	| "account_selection"
	| "credential_resolution";

export interface PreTransportDeadlineConfig {
	agentInterceptionTimeoutMs: number;
	accountSelectionTimeoutMs: number;
	credentialResolutionTimeoutMs: number;
}

export interface PreTransportPhaseEvent {
	kind: "slow" | "timeout";
	phase: PreTransportPhase;
	elapsedMs: number;
	timeoutMs: number;
}

const log = new Logger("PreTransportDeadline");

function readBoundedTimeout(
	envName: string,
	fallbackMs: number,
	maximumMs: number,
): number {
	const parsed = Number.parseInt(process.env[envName] ?? "", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
	return Math.min(parsed, maximumMs);
}

export function getPreTransportDeadlineConfig(): PreTransportDeadlineConfig {
	return {
		agentInterceptionTimeoutMs: readBoundedTimeout(
			PRE_TRANSPORT_AGENT_INTERCEPTION_TIMEOUT_ENV,
			PRE_TRANSPORT_DEFAULT_AGENT_INTERCEPTION_TIMEOUT_MS,
			PRE_TRANSPORT_MAX_AGENT_INTERCEPTION_TIMEOUT_MS,
		),
		accountSelectionTimeoutMs: readBoundedTimeout(
			PRE_TRANSPORT_ACCOUNT_SELECTION_TIMEOUT_ENV,
			PRE_TRANSPORT_DEFAULT_ACCOUNT_SELECTION_TIMEOUT_MS,
			PRE_TRANSPORT_MAX_ACCOUNT_SELECTION_TIMEOUT_MS,
		),
		credentialResolutionTimeoutMs: readBoundedTimeout(
			PRE_TRANSPORT_CREDENTIAL_RESOLUTION_TIMEOUT_ENV,
			PRE_TRANSPORT_DEFAULT_CREDENTIAL_RESOLUTION_TIMEOUT_MS,
			PRE_TRANSPORT_MAX_CREDENTIAL_RESOLUTION_TIMEOUT_MS,
		),
	};
}

export class PreTransportPhaseTimeoutError extends Error {
	readonly phase: PreTransportPhase;
	readonly timeoutMs: number;

	constructor(phase: PreTransportPhase, timeoutMs: number) {
		super(`Pre-transport phase exceeded its ${timeoutMs}ms deadline`);
		this.name = "PreTransportPhaseTimeoutError";
		this.phase = phase;
		this.timeoutMs = timeoutMs;
	}
}

function emitPhaseEvent(event: PreTransportPhaseEvent): void {
	log.warn(`pre_transport_phase_${event.kind}`, {
		phase: event.phase,
		elapsedMs: event.elapsedMs,
		timeoutMs: event.timeoutMs,
	});
}

/**
 * Bound a pre-transport phase without leaking phase inputs into telemetry.
 *
 * The operation itself may not support cancellation, so its late settlement is
 * consumed but never re-enters the caller after timeout or abort. Call sites
 * must perform transport only after this promise resolves successfully.
 */
export function runWithPreTransportDeadline<T>(options: {
	phase: PreTransportPhase;
	timeoutMs: number;
	signal?: AbortSignal;
	operation: () => Promise<T> | T;
	onEvent?: (event: PreTransportPhaseEvent) => void;
}): Promise<T> {
	const { phase, timeoutMs, signal, operation } = options;
	if (signal?.aborted) {
		return Promise.reject(
			signal.reason ??
				new DOMException("The operation was aborted", "AbortError"),
		);
	}

	const startedAt = Date.now();
	const notify = options.onEvent ?? emitPhaseEvent;
	const notifySafely = (event: PreTransportPhaseEvent) => {
		try {
			notify(event);
		} catch {
			// Observability must never extend or fail a routing phase.
		}
	};
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let slowTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (slowTimer !== undefined) clearTimeout(slowTimer);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			signal?.removeEventListener("abort", onAbort);
		};
		const resolveOnce = (value: T) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const rejectOnce = (reason: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(reason);
		};
		const onAbort = () => {
			rejectOnce(
				signal?.reason ??
					new DOMException("The operation was aborted", "AbortError"),
			);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}

		const slowAfterMs = Math.max(1, Math.floor(timeoutMs / 2));
		if (slowAfterMs < timeoutMs) {
			slowTimer = setTimeout(() => {
				if (settled) return;
				notifySafely({
					kind: "slow",
					phase,
					elapsedMs: Date.now() - startedAt,
					timeoutMs,
				});
			}, slowAfterMs);
		}
		deadlineTimer = setTimeout(() => {
			if (settled) return;
			notifySafely({
				kind: "timeout",
				phase,
				elapsedMs: Date.now() - startedAt,
				timeoutMs,
			});
			rejectOnce(new PreTransportPhaseTimeoutError(phase, timeoutMs));
		}, timeoutMs);

		let operationResult: Promise<T>;
		try {
			operationResult = Promise.resolve(operation());
		} catch (error) {
			rejectOnce(error);
			return;
		}
		// Keep handlers attached after our deadline wins so a late rejection cannot
		// become unhandled and a late resolution cannot resume routing.
		operationResult.then(resolveOnce, rejectOnce);
	});
}
