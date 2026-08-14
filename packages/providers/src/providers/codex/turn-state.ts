import { createHash } from "node:crypto";

export const CODEX_TURN_STATE_PERCENT_ENV = "CCFLARE_CODEX_TURN_STATE_PERCENT";
export const CODEX_TURN_STATE_ACCOUNT_IDS_ENV =
	"CCFLARE_CODEX_TURN_STATE_ACCOUNT_IDS";
export const CODEX_TURN_STATE_MODELS_ENV = "CCFLARE_CODEX_TURN_STATE_MODELS";
export const CODEX_TURN_STATE_COHORT_IDS_ENV =
	"CCFLARE_CODEX_TURN_STATE_COHORT_IDS";
export const CODEX_TURN_STATE_OBSERVE_ONLY_ENV =
	"CCFLARE_CODEX_TURN_STATE_OBSERVE_ONLY";
export const CODEX_TURN_STATE_MAX_ENTRIES_ENV =
	"CCFLARE_CODEX_TURN_STATE_MAX_ENTRIES";
export const CODEX_TURN_STATE_IDLE_TTL_MS_ENV =
	"CCFLARE_CODEX_TURN_STATE_IDLE_TTL_MS";

const DEFAULT_MAX_ENTRIES = 2_048;
const MAX_MAX_ENTRIES = 10_000;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const MAX_IDLE_TTL_MS = 24 * 60 * 60_000;
const MAX_CALL_IDS = 64;
const MAX_CALL_ID_BYTES = 512;
const MAX_TURN_STATE_BYTES = 4_096;
const COHORT_PATTERN = /^[0-9a-f]{16}$/;
const SCOPE_DOMAIN = "better-ccflare:codex-turn-state-scope:v1\0";
const COHORT_DOMAIN = "better-ccflare:codex-turn-state-cohort:v1\0";
const BUCKET_DOMAIN = "better-ccflare:codex-turn-state-bucket:v1\0";
const CALL_ID_DOMAIN = "better-ccflare:codex-turn-state-call-id:v1\0";
const encoder = new TextEncoder();

export type CodexTurnStateArm =
	| "observe"
	| "control"
	| "treatment"
	| "ineligible";

export type CodexTurnStateRequestAction =
	| "new_turn"
	| "replay"
	| "retry_replay"
	| "would_replay"
	| "observe"
	| "no_pending"
	| "no_token"
	| "concurrent_suppressed"
	| "rescue_suppressed"
	| "failover_suppressed"
	| "custom_endpoint_suppressed"
	| "hosted_suppressed"
	| "ambiguous_lineage"
	| "appended_input_suppressed"
	| "missing_binding"
	| "account_not_allowlisted"
	| "model_not_allowlisted"
	| "percent_control"
	| "cohort_not_allowlisted";

export type CodexTurnStateTerminalAction =
	| "captured"
	| "advanced"
	| "retired"
	| "error_ignored"
	| "invalid_token"
	| "ambiguous_calls"
	| "stale_generation"
	| "observed"
	| "ineligible"
	| "unknown_attempt";

export type CodexTurnStateAttemptCause =
	| "initial"
	| "model_fallback"
	| "overload_529"
	| "thinking_retry"
	| "reasoning_retry"
	| "cache_control_retry"
	| "prompt_cache_breakpoint_retry"
	| "cache_lane_rescue"
	| "precommit_sse_retry"
	| "account_failover"
	| "other_retry";

export type CodexTurnStateLineage =
	| { readonly kind: "none" }
	| { readonly kind: "invalid" }
	| {
			readonly kind: "valid";
			readonly fingerprints: readonly string[];
			readonly key: string;
	  };

export interface CodexTurnStateConfig {
	readonly percent: number;
	readonly accountIds: ReadonlySet<string>;
	readonly models: ReadonlySet<string>;
	readonly cohortIds: ReadonlySet<string>;
	readonly observeOnly: boolean;
	readonly maxEntries: number;
	readonly idleTtlMs: number;
}

export interface CodexTurnStateScopeInput {
	readonly accountId: string | null | undefined;
	readonly model: string | null | undefined;
	readonly conversationIdentity: string | null | undefined;
}

export interface CodexTurnStateBeginInput extends CodexTurnStateScopeInput {
	readonly requestId: string | null | undefined;
	readonly attemptId: string | null | undefined;
	readonly attemptCause: CodexTurnStateAttemptCause | null | undefined;
	readonly eligibleEndpoint: boolean;
	readonly hosted: boolean;
	readonly lineage: CodexTurnStateLineage;
	/**
	 * Whether the converted request still ends at the tool output its lineage was
	 * validated against. `false` means conversion appended something after it, so
	 * the wire request is not an exact same-turn continuation. Optional because
	 * absence means "nothing known to have been appended"; only an explicit
	 * `false` suppresses.
	 */
	readonly continuationTailIntact?: boolean;
}

export interface CodexTurnStateRequestDecision {
	readonly arm: CodexTurnStateArm;
	readonly cohortId: string | null;
	readonly action: CodexTurnStateRequestAction;
	readonly replayApplied: boolean;
	readonly turnState?: string;
}

export interface CodexTurnStateFinalizeInput {
	readonly attemptId: string;
	readonly stopReason:
		| "tool_use"
		| "end_turn"
		| "max_tokens"
		| "refusal"
		| "error";
	readonly responseTurnState: string | null | undefined;
	readonly outputLineage: CodexTurnStateLineage;
}

interface GenerationEntry {
	generation: number;
	arm: CodexTurnStateArm;
	/**
	 * Counts every change to this scope's pending turn state within the current
	 * generation. The generation number alone cannot separate two logical
	 * requests that legitimately began while the scope held nothing to protect:
	 * both see the same generation, so both are allowed to mutate at their
	 * terminal. Attempts carry the revision they observed at begin and may only
	 * mutate while it still holds.
	 */
	pendingRevision: number;
	updatedAt: number;
}

interface PendingEntry {
	generation: number;
	arm: "control" | "treatment";
	lineageKey: string;
	validTokenObserved: boolean;
	token?: string;
	leaseRequestId?: string;
	updatedAt: number;
}

interface AttemptEntry {
	scopeKey: string | null;
	generation: number | null;
	pendingRevision: number | null;
	arm: CodexTurnStateArm;
	requestId: string;
	replayApplied: boolean;
	terminalMutationAllowed: boolean;
	updatedAt: number;
}

/**
 * How many idle periods an attempt may keep its scope from expiring.
 *
 * Attempts are exempt from the idle sweep because a slow response is live work,
 * not idle state. That exemption needs a ceiling: `beginAttempt` registers an
 * attempt during request transformation, before physical dispatch, so a
 * candidate abandoned after registration -- on any path that does not reach
 * `abortAttempt` -- would otherwise pin its scope and hold its lease forever.
 * Four idle periods (two hours at the defaults) is far longer than any real
 * response and still bounded.
 */
const ATTEMPT_TTL_MULTIPLIER = 4;

interface CoordinatorEntryRef {
	kind: "generation" | "pending" | "attempt";
	key: string;
	updatedAt: number;
}

function strictUnsignedInteger(
	raw: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
		? parsed
		: fallback;
}

function hasHeaderControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

function readCsvSet(raw: string | undefined, normalize = false): Set<string> {
	const result = new Set<string>();
	for (const item of raw?.split(",") ?? []) {
		const trimmed = item.trim();
		if (!trimmed || hasHeaderControlCharacters(trimmed)) continue;
		result.add(normalize ? trimmed.toLowerCase() : trimmed);
	}
	return result;
}

export function readCodexTurnStateConfig(): CodexTurnStateConfig {
	const cohortIds = new Set(
		[...readCsvSet(process.env[CODEX_TURN_STATE_COHORT_IDS_ENV], true)].filter(
			(value) => COHORT_PATTERN.test(value),
		),
	);
	return {
		percent: Math.min(
			strictUnsignedInteger(
				process.env[CODEX_TURN_STATE_PERCENT_ENV],
				0,
				0,
				Number.MAX_SAFE_INTEGER,
			),
			100,
		),
		accountIds: readCsvSet(process.env[CODEX_TURN_STATE_ACCOUNT_IDS_ENV]),
		models: readCsvSet(process.env[CODEX_TURN_STATE_MODELS_ENV], true),
		cohortIds,
		observeOnly:
			process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV] === "1" ||
			process.env[CODEX_TURN_STATE_OBSERVE_ONLY_ENV] === "true",
		maxEntries: strictUnsignedInteger(
			process.env[CODEX_TURN_STATE_MAX_ENTRIES_ENV],
			DEFAULT_MAX_ENTRIES,
			1,
			MAX_MAX_ENTRIES,
		),
		idleTtlMs: strictUnsignedInteger(
			process.env[CODEX_TURN_STATE_IDLE_TTL_MS_ENV],
			DEFAULT_IDLE_TTL_MS,
			1,
			MAX_IDLE_TTL_MS,
		),
	};
}

function normalizedScopeParts(
	input: CodexTurnStateScopeInput,
): { accountId: string; model: string; conversationIdentity: string } | null {
	const accountId = input.accountId?.trim();
	const model = input.model?.trim().toLowerCase();
	const conversationIdentity = input.conversationIdentity?.trim();
	if (!accountId || !model || !conversationIdentity) return null;
	return { accountId, model, conversationIdentity };
}

function updateScopeHash(
	hash: ReturnType<typeof createHash>,
	input: CodexTurnStateScopeInput,
): ReturnType<typeof createHash> | null {
	const parts = normalizedScopeParts(input);
	if (!parts) return null;
	return hash
		.update(parts.accountId)
		.update("\0")
		.update(parts.model)
		.update("\0")
		.update(parts.conversationIdentity);
}

export function deriveCodexTurnStateCohortId(
	input: CodexTurnStateScopeInput,
): string {
	return (
		updateScopeHash(createHash("sha256").update(COHORT_DOMAIN), input)?.digest(
			"hex",
		) ?? ""
	).slice(0, 16);
}

function deriveScopeKey(input: CodexTurnStateScopeInput): string | null {
	return (
		updateScopeHash(createHash("sha256").update(SCOPE_DOMAIN), input)?.digest(
			"hex",
		) ?? null
	);
}

function deriveBucket(input: CodexTurnStateScopeInput): number {
	const digest = updateScopeHash(
		createHash("sha256").update(BUCKET_DOMAIN),
		input,
	)?.digest();
	return digest ? digest.readUInt32BE(0) % 100 : 100;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function fingerprintCodexTurnStateCallId(
	candidate: unknown,
): string | null {
	if (
		typeof candidate !== "string" ||
		candidate.length === 0 ||
		encoder.encode(candidate).length > MAX_CALL_ID_BYTES ||
		hasHeaderControlCharacters(candidate)
	) {
		return null;
	}
	return createHash("sha256")
		.update(CALL_ID_DOMAIN)
		.update(candidate)
		.digest("hex");
}

export function normalizeCodexTurnStateFingerprints(
	candidates: readonly unknown[],
): CodexTurnStateLineage {
	if (candidates.length === 0) return { kind: "none" };
	if (candidates.length > MAX_CALL_IDS) return { kind: "invalid" };
	const fingerprints: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || !FINGERPRINT_PATTERN.test(candidate)) {
			return { kind: "invalid" };
		}
		if (seen.has(candidate)) return { kind: "invalid" };
		seen.add(candidate);
		fingerprints.push(candidate);
	}
	fingerprints.sort();
	return {
		kind: "valid",
		fingerprints,
		key: createHash("sha256")
			.update(fingerprints.map((value) => `${value.length}:${value}`).join(""))
			.digest("hex"),
	};
}

export function normalizeCodexTurnStateCallIds(
	callIds: readonly unknown[],
): CodexTurnStateLineage {
	const fingerprints: string[] = [];
	for (const candidate of callIds) {
		const fingerprint = fingerprintCodexTurnStateCallId(candidate);
		if (!fingerprint) return { kind: "invalid" };
		fingerprints.push(fingerprint);
	}
	return normalizeCodexTurnStateFingerprints(fingerprints);
}

/**
 * Whether the converted Codex input still ends at a tool output.
 *
 * A same-turn tool continuation must reach upstream as exactly that. Conversion
 * can append items after the tool outputs the lineage was derived from, so this
 * reports the tail of what will actually be sent rather than of what the client
 * supplied. Reports the fact only; `beginAttempt` owns what to do about it.
 */
export function codexInputEndsWithToolOutput(
	input: readonly unknown[] | null | undefined,
): boolean {
	if (!Array.isArray(input) || input.length === 0) return false;
	const last = input[input.length - 1];
	if (!last || typeof last !== "object" || Array.isArray(last)) return false;
	return (last as Record<string, unknown>).type === "function_call_output";
}

export function extractCodexTurnStateLineage(
	messages: readonly unknown[],
): CodexTurnStateLineage {
	let latestUser: Record<string, unknown> | null = null;
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index];
		if (
			candidate &&
			typeof candidate === "object" &&
			!Array.isArray(candidate) &&
			(candidate as Record<string, unknown>).role === "user"
		) {
			latestUser = candidate as Record<string, unknown>;
			break;
		}
	}
	if (!latestUser || !Array.isArray(latestUser.content))
		return { kind: "none" };
	const callIds: unknown[] = [];
	let sawNonToolResultBlock = false;
	for (const block of latestUser.content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			sawNonToolResultBlock = true;
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type !== "tool_result") {
			sawNonToolResultBlock = true;
			continue;
		}
		callIds.push(record.tool_use_id);
	}
	// A user message carrying no tool results is an ordinary new turn, not a
	// malformed continuation. Anthropic clients routinely send plain text as
	// `[{ type: "text", ... }]`, so rejecting every non-tool_result block would
	// classify the common case as ambiguous and make it permanently ineligible.
	// `invalid` stays reserved for a genuinely ambiguous continuation: tool
	// results mixed with other or malformed blocks, where the exact lineage of
	// the turn cannot be determined.
	if (callIds.length === 0) return { kind: "none" };
	if (sawNonToolResultBlock) return { kind: "invalid" };
	return normalizeCodexTurnStateCallIds(callIds);
}

function validateTurnState(value: string | null | undefined): string | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		encoder.encode(value).length > MAX_TURN_STATE_BYTES ||
		hasHeaderControlCharacters(value)
	) {
		return null;
	}
	return value;
}

const COMPATIBLE_RETRY_CAUSES = new Set<CodexTurnStateAttemptCause>([
	"thinking_retry",
	"reasoning_retry",
	"cache_control_retry",
	"prompt_cache_breakpoint_retry",
	"overload_529",
	"other_retry",
]);
const RESCUE_CAUSES = new Set<CodexTurnStateAttemptCause>([
	"cache_lane_rescue",
	"precommit_sse_retry",
]);
const FAILOVER_CAUSES = new Set<CodexTurnStateAttemptCause>([
	"account_failover",
	"model_fallback",
]);

export class CodexTurnStateCoordinator {
	private readonly now: () => number;
	private readonly generations = new Map<string, GenerationEntry>();
	private readonly pending = new Map<string, PendingEntry>();
	private readonly attempts = new Map<string, AttemptEntry>();
	private nextGeneration = 1;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	beginAttempt(input: CodexTurnStateBeginInput): CodexTurnStateRequestDecision {
		const now = this.now();
		const config = readCodexTurnStateConfig();
		this.sweep(now, config);
		const cohortId = deriveCodexTurnStateCohortId(input) || null;
		const binding = normalizedScopeParts(input);
		if (!binding || !input.requestId || !input.attemptId) {
			return this.decision("ineligible", cohortId, "missing_binding", false);
		}
		const scopeKey = deriveScopeKey(input);
		if (!scopeKey) {
			return this.decision("ineligible", cohortId, "missing_binding", false);
		}
		if (!input.eligibleEndpoint) {
			this.invalidate(scopeKey, now, config);
			return this.recordAttempt(
				input,
				scopeKey,
				"ineligible",
				cohortId,
				"custom_endpoint_suppressed",
				false,
				now,
				config,
			);
		}
		if (input.hosted) {
			this.invalidate(scopeKey, now, config);
			// Deliberately reports the decision without registering an attempt.
			// Hosted search finalizes through its own response processor and never
			// reaches `finalizeAttempt`, so a registered hosted attempt is one
			// nothing can ever resolve. It would sit in the map for the whole idle
			// TTL keeping `hasLiveAttempt` true for its logical request, which pins
			// that request's lease and suppresses every later continuation on this
			// scope, while also consuming the shared entry cap. Every other
			// suppression here does reach `processResponse`, so only this one has to
			// opt out of registration.
			return this.decision("ineligible", cohortId, "hosted_suppressed", false);
		}
		if (input.lineage.kind === "invalid") {
			this.invalidate(scopeKey, now, config);
			return this.recordAttempt(
				input,
				scopeKey,
				"ineligible",
				cohortId,
				"ambiguous_lineage",
				false,
				now,
				config,
			);
		}
		if (
			input.lineage.kind === "valid" &&
			input.continuationTailIntact === false
		) {
			// Lineage is validated against the client's Anthropic messages, but what
			// reaches Codex is the converted body, and conversion can append to it --
			// today a continue-now nudge after a final Skill result. That request is
			// no longer an exact same-turn tool continuation even though its lineage
			// still matches, which is precisely why the token would otherwise replay.
			// The caller reports only the tail fact; deciding on it here keeps the
			// policy with every other suppression, and guarding the converted tail
			// rather than Skill specifically covers any future append for free.
			this.invalidate(scopeKey, now, config);
			return this.recordAttempt(
				input,
				scopeKey,
				"ineligible",
				cohortId,
				"appended_input_suppressed",
				false,
				now,
				config,
			);
		}
		if (RESCUE_CAUSES.has(input.attemptCause ?? "initial")) {
			this.invalidate(scopeKey, now, config);
			return this.recordAttempt(
				input,
				scopeKey,
				"ineligible",
				cohortId,
				"rescue_suppressed",
				false,
				now,
				config,
			);
		}
		if (FAILOVER_CAUSES.has(input.attemptCause ?? "initial")) {
			this.invalidate(scopeKey, now, config);
			// A route change moves this logical request to a different scope key,
			// so invalidating the destination cannot reach the lease its failed
			// attempt still holds on the source account/model. Left in place, that
			// lease belongs to a request that will never come back, and every later
			// continuation on the source scope is suppressed for the rest of the
			// turn. The source turn's token and lineage stay intact; only the
			// ownership claim is released.
			this.releaseLeases(input.requestId);
			return this.recordAttempt(
				input,
				scopeKey,
				"ineligible",
				cohortId,
				"failover_suppressed",
				false,
				now,
				config,
			);
		}

		const { arm, action: assignmentAction } = this.assignArm(
			input,
			cohortId,
			config,
		);
		let generationEntry = this.generations.get(scopeKey);
		if (generationEntry && generationEntry.arm !== arm) {
			generationEntry = this.advanceGeneration(scopeKey, arm, now, config);
			this.pending.delete(scopeKey);
		}
		if (arm === "ineligible") {
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				assignmentAction,
				false,
				now,
				config,
			);
		}
		if (arm === "observe") {
			generationEntry ??= this.advanceGeneration(scopeKey, arm, now, config);
			this.pending.delete(scopeKey);
			this.bumpPendingRevision(scopeKey);
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				"observe",
				false,
				now,
				config,
			);
		}

		const retry = COMPATIBLE_RETRY_CAUSES.has(input.attemptCause ?? "initial");
		if (input.lineage.kind === "none" && !retry) {
			generationEntry = this.advanceGeneration(scopeKey, arm, now, config);
			this.pending.delete(scopeKey);
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				"new_turn",
				false,
				now,
				config,
			);
		}
		generationEntry ??= this.advanceGeneration(scopeKey, arm, now, config);
		// `touch` only reorders the LRU. Without refreshing the timestamp the sweep
		// expires a scope measured from turn creation, so an active turn whose
		// continuations keep arriving is still dropped once it outlives the TTL.
		generationEntry.updatedAt = now;
		this.touch(this.generations, scopeKey, generationEntry);
		this.enforceEntryLimit(config.maxEntries);

		const pending = this.pending.get(scopeKey);
		if (
			!pending ||
			input.lineage.kind !== "valid" ||
			pending.lineageKey !== input.lineage.key ||
			pending.generation !== generationEntry.generation
		) {
			// This attempt is not continuing the pending turn. It may still capture
			// state when there is nothing to protect -- no entry, or only a stale
			// one from a superseded generation. But a live entry in this generation
			// belongs to another logical request, whether that request currently
			// holds the lease or merely captured and has not sent its continuation
			// yet. Letting this attempt reach a mutating terminal would overwrite
			// the owner's token on `tool_use` or delete it outright on `end_turn`.
			const foreignPending =
				pending !== undefined &&
				pending.generation === generationEntry.generation &&
				pending.leaseRequestId !== input.requestId;
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				"no_pending",
				false,
				now,
				config,
				undefined,
				!foreignPending,
			);
		}
		// The lease exists to stop two *live* logical requests racing to advance one
		// turn. Held against a request that no longer has an attempt in flight it
		// fences nothing, because that request can never mutate the turn again:
		// `finalizeAttempt` deletes the attempt before it returns `error_ignored`
		// or any `stale_generation`, and when routing is exhausted or the caller
		// cancels, no failover registration and no `abortAttempt` follows to
		// release the claim. The client's next retry is a new logical request, so
		// without this liveness test it would be suppressed -- unable to replay a
		// token that is still perfectly valid -- for the rest of the idle TTL.
		// Requiring a live attempt makes the lease self-releasing on every
		// abandonment path while keeping the concurrency guarantee exact.
		if (
			pending.leaseRequestId !== undefined &&
			pending.leaseRequestId !== input.requestId &&
			this.hasLiveAttempt(scopeKey, pending.leaseRequestId)
		) {
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				"concurrent_suppressed",
				false,
				now,
				config,
				undefined,
				false,
			);
		}
		pending.leaseRequestId = input.requestId;
		pending.updatedAt = now;
		if (arm === "control") {
			// Downgrading a treatment turn to control really does change the pending
			// entry, and every attempt that began before it must be fenced. Merely
			// re-registering an entry that is already token-free control changes
			// nothing, and bumping there fences the attempt still producing this very
			// turn: a second candidate for the same logical request -- a duplicate
			// route claim, a superseded fallback -- passes the lease check, bumps, and
			// is then aborted, leaving the dispatched attempt to finalize as
			// `stale_generation` with its lineage unadvanced. Bump only on real change.
			const downgraded =
				pending.arm !== "control" || pending.token !== undefined;
			delete pending.token;
			pending.arm = "control";
			if (downgraded) this.bumpPendingRevision(scopeKey);
			this.touch(this.pending, scopeKey, pending);
			this.enforceEntryLimit(config.maxEntries);
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				"would_replay",
				false,
				now,
				config,
			);
		}
		if (!pending.token || pending.arm !== "treatment") {
			this.pending.delete(scopeKey);
			this.bumpPendingRevision(scopeKey);
			return this.recordAttempt(
				input,
				scopeKey,
				arm,
				cohortId,
				"no_token",
				false,
				now,
				config,
			);
		}
		this.touch(this.pending, scopeKey, pending);
		this.enforceEntryLimit(config.maxEntries);
		return this.recordAttempt(
			input,
			scopeKey,
			arm,
			cohortId,
			retry ? "retry_replay" : "replay",
			true,
			now,
			config,
			pending.token,
		);
	}

	finalizeAttempt(
		input: CodexTurnStateFinalizeInput,
	): CodexTurnStateTerminalAction {
		const now = this.now();
		const config = readCodexTurnStateConfig();
		this.sweep(now, config);
		const attempt = this.attempts.get(input.attemptId);
		this.attempts.delete(input.attemptId);
		if (!attempt) return "unknown_attempt";
		if (!attempt.scopeKey || attempt.generation === null) return "ineligible";
		if (!attempt.terminalMutationAllowed) return "stale_generation";
		const generation = this.generations.get(attempt.scopeKey);
		if (!generation || generation.generation !== attempt.generation) {
			return "stale_generation";
		}
		// Resolving a terminal is activity on this scope; keep it from expiring
		// mid-turn (see the matching refresh in `beginAttempt`).
		generation.updatedAt = now;
		this.touch(this.generations, attempt.scopeKey, generation);
		if (attempt.arm === "observe") return "observed";
		if (attempt.arm === "ineligible") return "ineligible";
		if (input.stopReason === "error") return "error_ignored";
		// Only the request holding the pending lease may mutate it. A request that
		// arrived with a different lineage, or that lost the lease race, still
		// reaches a terminal on this scope; capturing over the entry or retiring it
		// here would corrupt the owner's turn.
		const leased = this.pending.get(attempt.scopeKey);
		if (
			leased &&
			leased.generation === attempt.generation &&
			leased.leaseRequestId !== undefined &&
			leased.leaseRequestId !== attempt.requestId
		) {
			return "stale_generation";
		}
		// The lease check alone cannot fence two attempts that both began while
		// the scope held no pending turn: neither holds a lease, both are allowed
		// to mutate, and whichever finishes second overwrites or retires a turn it
		// never saw. The revision pins each attempt to the pending state that
		// existed when it began.
		if (generation.pendingRevision !== attempt.pendingRevision) {
			return "stale_generation";
		}
		if (input.stopReason !== "tool_use") {
			this.pending.delete(attempt.scopeKey);
			this.bumpPendingRevision(attempt.scopeKey);
			return "retired";
		}
		if (input.outputLineage.kind !== "valid") {
			this.pending.delete(attempt.scopeKey);
			this.bumpPendingRevision(attempt.scopeKey);
			return "ambiguous_calls";
		}

		const existing = this.pending.get(attempt.scopeKey);
		const advancingShadow =
			attempt.arm === "control" &&
			existing?.arm === "control" &&
			existing.leaseRequestId === attempt.requestId;
		if (attempt.replayApplied || advancingShadow) {
			if (
				!existing ||
				existing.generation !== attempt.generation ||
				existing.leaseRequestId !== attempt.requestId ||
				(attempt.arm === "treatment" && !existing.token)
			) {
				return "stale_generation";
			}
			existing.lineageKey = input.outputLineage.key;
			existing.updatedAt = now;
			delete existing.leaseRequestId;
			this.bumpPendingRevision(attempt.scopeKey);
			this.touch(this.pending, attempt.scopeKey, existing);
			this.enforceEntryLimit(config.maxEntries);
			return "advanced";
		}

		const responseToken = validateTurnState(input.responseTurnState);
		if (!responseToken) {
			this.pending.delete(attempt.scopeKey);
			this.bumpPendingRevision(attempt.scopeKey);
			return "invalid_token";
		}
		const pending: PendingEntry = {
			generation: attempt.generation,
			arm: attempt.arm,
			lineageKey: input.outputLineage.key,
			validTokenObserved: true,
			...(attempt.arm === "treatment" ? { token: responseToken } : {}),
			updatedAt: now,
		};
		this.bumpPendingRevision(attempt.scopeKey);
		this.touch(this.pending, attempt.scopeKey, pending);
		this.enforceEntryLimit(config.maxEntries);
		return "captured";
	}

	/**
	 * Releases the context registered for one attempt that will never produce a
	 * response.
	 *
	 * `beginAttempt` runs during request transformation, before route claiming
	 * and physical dispatch, so a candidate can be abandoned after it registered:
	 * a duplicate-route skip, a staging failure, or a superseded fallback. Such
	 * an attempt keeps whatever lease it took and, because in-flight attempts
	 * exempt their scope from the idle sweep, keeps that scope alive too --
	 * suppressing every matching continuation. Aborting drops the attempt and
	 * releases its lease without touching the turn itself, so the turn stays
	 * replayable and no other request is fenced.
	 *
	 * Idempotent: an unknown or already-finalized attempt is a no-op. Callers
	 * that cannot reach this (an unexpected throw, a cancellation) still self-heal
	 * through the bounded attempt TTL, just not promptly.
	 *
	 * Returns the logical request the attempt belonged to when the coordinator
	 * knew it, so the caller can bind its abort telemetry to the same request the
	 * attempt's own trace record carries; `null` for an unknown attempt.
	 */
	abortAttempt(attemptId: string | null | undefined): string | null {
		if (!attemptId) return null;
		const attempt = this.attempts.get(attemptId);
		if (!attempt) return null;
		this.attempts.delete(attemptId);
		if (!attempt.scopeKey) return attempt.requestId;
		const pending = this.pending.get(attempt.scopeKey);
		if (pending?.leaseRequestId !== attempt.requestId) return attempt.requestId;
		// The lease is held by the logical request, not this physical attempt, so
		// it may only be released once that request has no other attempt live on
		// this scope. A superseded fallback abandoned while the attempt it replaced
		// is still running must leave that attempt's lease intact.
		if (this.hasLiveAttempt(attempt.scopeKey, attempt.requestId)) {
			return attempt.requestId;
		}
		delete pending.leaseRequestId;
		return attempt.requestId;
	}

	/**
	 * Whether one logical request still has a registered, unfinalized attempt on
	 * this scope. Both the lease guard in `beginAttempt` and the release in
	 * `abortAttempt` ask this same question: an attempt is removed from the map at
	 * its terminal and at its abort, so a request with none left can no longer
	 * reach any state-mutating path and has nothing left to fence.
	 */
	private hasLiveAttempt(scopeKey: string, requestId: string): boolean {
		for (const attempt of this.attempts.values()) {
			if (attempt.scopeKey === scopeKey && attempt.requestId === requestId) {
				return true;
			}
		}
		return false;
	}

	private assignArm(
		input: CodexTurnStateBeginInput,
		cohortId: string | null,
		config: CodexTurnStateConfig,
	): { arm: CodexTurnStateArm; action: CodexTurnStateRequestAction } {
		const accountId = input.accountId?.trim() ?? "";
		const model = input.model?.trim().toLowerCase() ?? "";
		if (!config.accountIds.has(accountId)) {
			return { arm: "ineligible", action: "account_not_allowlisted" };
		}
		if (!config.models.has(model)) {
			return { arm: "ineligible", action: "model_not_allowlisted" };
		}
		if (config.observeOnly) return { arm: "observe", action: "observe" };
		if (
			config.percent === 0 ||
			(config.percent < 100 && deriveBucket(input) >= config.percent)
		) {
			return { arm: "control", action: "percent_control" };
		}
		if (!cohortId || !config.cohortIds.has(cohortId)) {
			return { arm: "control", action: "cohort_not_allowlisted" };
		}
		return { arm: "treatment", action: "new_turn" };
	}

	/**
	 * Registers the attempt context that `finalizeAttempt` later resolves.
	 *
	 * `terminalMutationAllowed` must be `false` for any attempt that lost the
	 * lease or was otherwise suppressed. Those attempts still reach a terminal
	 * state, and without the flag they would capture or advance turn state that
	 * belongs to the owning logical request. The default is `true` because the
	 * ordinary owner path is the common caller; every new suppression call site
	 * has to pass `false` explicitly.
	 */
	private recordAttempt(
		input: CodexTurnStateBeginInput,
		scopeKey: string,
		arm: CodexTurnStateArm,
		cohortId: string | null,
		action: CodexTurnStateRequestAction,
		replayApplied: boolean,
		now: number,
		config: CodexTurnStateConfig,
		turnState?: string,
		terminalMutationAllowed = true,
	): CodexTurnStateRequestDecision {
		const generationEntry = this.generations.get(scopeKey);
		if (input.attemptId && input.requestId) {
			this.touch(this.attempts, input.attemptId, {
				scopeKey,
				generation: generationEntry?.generation ?? null,
				// Read after every begin-time mutation, so an attempt that itself
				// cleared the scope carries the resulting revision, not the one it
				// replaced.
				pendingRevision: generationEntry?.pendingRevision ?? null,
				arm,
				requestId: input.requestId,
				replayApplied,
				terminalMutationAllowed,
				updatedAt: now,
			});
			this.enforceEntryLimit(config.maxEntries);
		}
		return this.decision(arm, cohortId, action, replayApplied, turnState);
	}

	private decision(
		arm: CodexTurnStateArm,
		cohortId: string | null,
		action: CodexTurnStateRequestAction,
		replayApplied: boolean,
		turnState?: string,
	): CodexTurnStateRequestDecision {
		return {
			arm,
			cohortId,
			action,
			replayApplied,
			...(turnState ? { turnState } : {}),
		};
	}

	private advanceGeneration(
		scopeKey: string,
		arm: CodexTurnStateArm,
		now: number,
		config: CodexTurnStateConfig,
	): GenerationEntry {
		const entry = {
			generation: this.nextGeneration++,
			arm,
			pendingRevision: 0,
			updatedAt: now,
		};
		this.touch(this.generations, scopeKey, entry);
		this.enforceEntryLimit(config.maxEntries);
		return entry;
	}

	private invalidate(
		scopeKey: string,
		now: number,
		config: CodexTurnStateConfig,
	): void {
		this.advanceGeneration(scopeKey, "ineligible", now, config);
		this.pending.delete(scopeKey);
	}

	/**
	 * Drops every pending lease held by one logical request, leaving the turns
	 * themselves untouched. Used when a request leaves the scope it leased, where
	 * scope-keyed invalidation cannot reach the abandoned claim.
	 */
	private releaseLeases(requestId: string): void {
		for (const entry of this.pending.values()) {
			if (entry.leaseRequestId === requestId) delete entry.leaseRequestId;
		}
	}

	/**
	 * Marks this scope's pending turn state as changed, fencing any attempt that
	 * began before the change. Call it next to every create, mutate, or delete of
	 * a `pending` entry that other in-flight attempts could still act on.
	 * Acquiring a lease is not such a change: the leasing attempt is the one that
	 * goes on to mutate, and the existing lease checks already fence the rest.
	 */
	private bumpPendingRevision(scopeKey: string): void {
		const generation = this.generations.get(scopeKey);
		if (generation) generation.pendingRevision += 1;
	}

	private sweep(now: number, config: CodexTurnStateConfig): void {
		const cutoff = now - config.idleTtlMs;
		// Attempts are in-flight requests, not idle state. A response that takes
		// longer than the idle TTL to produce its terminal is still active, and
		// dropping its context makes that terminal `unknown_attempt`, which can
		// neither capture nor retire the turn it just finished. The combined entry
		// cap and its LRU eviction keep the map bounded instead. For the same
		// reason a scope with an attempt still in flight is not idle, so its turn
		// and generation survive the sweep as well.
		// `enforceEntryLimit` applies the same exemption as an eviction
		// *preference* rather than a veto, so the cap stays a hard bound.
		const attemptCutoff = now - config.idleTtlMs * ATTEMPT_TTL_MULTIPLIER;
		const activeScopes = new Set<string>();
		for (const [key, entry] of this.attempts) {
			// An attempt this old is no longer a request in flight; it was abandoned
			// without a terminal. Drop it so the scope it was protecting can expire.
			if (entry.updatedAt < attemptCutoff) {
				this.attempts.delete(key);
				continue;
			}
			if (entry.scopeKey) activeScopes.add(entry.scopeKey);
		}
		for (const [key, entry] of this.pending) {
			if (entry.updatedAt < cutoff && !activeScopes.has(key)) {
				this.pending.delete(key);
			}
		}
		for (const [key, entry] of this.generations) {
			if (entry.updatedAt < cutoff && !activeScopes.has(key)) {
				this.generations.delete(key);
				this.pending.delete(key);
			}
		}
		this.enforceEntryLimit(config.maxEntries);
	}

	private touch<K, V>(map: Map<K, V>, key: K, value: V): void {
		map.delete(key);
		map.set(key, value);
	}

	private totalEntries(): number {
		return this.generations.size + this.pending.size + this.attempts.size;
	}

	private enforceEntryLimit(maximum: number): void {
		if (this.totalEntries() <= maximum) return;
		// A generation's `updatedAt` is frozen for as long as its response runs,
		// so a raw least-recently-touched scan makes the scope that is actively
		// streaming the *first* candidate to evict. That inverts the intent: the
		// one turn still being produced is the one destroyed. `finalizeAttempt`
		// makes it sharper still -- it sweeps before deleting its own attempt and
		// two statements before reading its own generation, so unguarded eviction
		// can drop the entry it is about to look up and report `stale_generation`
		// for a turn that never raced anything.
		//
		// Scopes with an attempt in flight are therefore evicted last, matching
		// the exemption `sweep` already applies. The cap stays a hard bound: once
		// nothing else remains, in-flight state is evicted too.
		const activeScopes = new Set<string>();
		for (const entry of this.attempts.values()) {
			if (entry.scopeKey) activeScopes.add(entry.scopeKey);
		}
		while (this.totalEntries() > maximum) {
			const oldest =
				this.oldestEvictable(activeScopes) ?? this.oldestEvictable(null);
			if (!oldest) return;
			if (oldest.kind === "attempt") {
				this.attempts.delete(oldest.key);
			} else {
				this.generations.delete(oldest.key);
				this.pending.delete(oldest.key);
			}
		}
	}

	/**
	 * Oldest entry eligible for eviction. With `protectedScopes` set, scopes with
	 * an attempt in flight are skipped and attempts themselves are never offered;
	 * passing `null` runs the unrestricted pass that keeps the cap hard.
	 */
	private oldestEvictable(
		protectedScopes: ReadonlySet<string> | null,
	): CoordinatorEntryRef | null {
		const candidates = [
			this.oldestEntry("generation", this.generations, protectedScopes),
			this.oldestEntry("pending", this.pending, protectedScopes),
			protectedScopes === null
				? this.oldestEntry("attempt", this.attempts, null)
				: null,
		].filter((entry): entry is CoordinatorEntryRef => entry !== null);
		return (
			candidates.sort((left, right) => left.updatedAt - right.updatedAt)[0] ??
			null
		);
	}

	private oldestEntry<V extends { updatedAt: number }>(
		kind: CoordinatorEntryRef["kind"],
		map: Map<string, V>,
		protectedKeys: ReadonlySet<string> | null,
	): CoordinatorEntryRef | null {
		// Insertion order is least-recently-touched order (`touch` re-inserts), so
		// the first unprotected entry is also the oldest unprotected entry.
		for (const [key, value] of map) {
			if (protectedKeys?.has(key)) continue;
			return { kind, key, updatedAt: value.updatedAt };
		}
		return null;
	}
}
