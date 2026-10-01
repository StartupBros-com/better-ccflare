export interface AcceptedTiming {
	acceptedAtMonoNs: string;
	preResponseDeadlineMonoNs: string;
	workDeadlineMonoNs: string;
	cleanupDeadlineMonoNs: string;
	effectiveCapMs: number;
	cleanupReserveMs: number;
}
export interface TimingBinding {
	bootId: string;
	ingressNonce: string;
	candidateNonce: string;
	generation: number;
	backendSourceSha: string;
	requestId: string;
	attemptOrdinal: number;
	method: string;
	path: string;
}
export const MANAGED_TIMING_VERSION: "v1";
export const MANAGED_TIMING_HEADER: string;
export const CLIENT_TIMEOUT_HEADER: string;
export const DEFAULT_ACCEPTED_CAP_MS: number;
export const DEFAULT_CLEANUP_RESERVE_MS: number;
export function monotonicNowNs(): bigint;
export function bootIdentity(): string;
export function retirementBudgetMs(appDrainMs: number): number;
export function createAcceptedTiming(
	acceptedAt: bigint,
	requested?: string | null,
	policyCapMs?: number,
	responseStartMs?: number,
): AcceptedTiming;
export function signManagedTiming(
	t: AcceptedTiming,
	b: TimingBinding,
	secret: Uint8Array,
): string;
export function verifyManagedTiming(
	envelope: string | null,
	b: TimingBinding,
	secret: Uint8Array,
	now?: bigint,
): AcceptedTiming | null;
export function claimManagedTiming(
	claims: Map<string, bigint>,
	t: AcceptedTiming,
	b: TimingBinding,
	now?: bigint,
	limit?: number,
): boolean;
export function managedTimingBinding(envelope: string | null): {
	requestId?: string;
	attemptOrdinal?: number;
	ingressNonce?: string;
};
export function bindManagedRequest(
	request: Request,
	timing: AcceptedTiming,
	abort?: (error: Error) => void,
): void;
export function managedRemainingMs(request: Request): number | null;
export function registerManagedTerminal(
	request: Request,
	recorder: (cause: "accepted_request_deadline") => void,
): void;
export function publishManagedTerminal(request: Request): void;

export function inheritManagedRequest(
	original: Request,
	derived: Request,
): void;

export function assertManagedWorkAvailable(
	request: Request,
	now?: bigint,
): void;
