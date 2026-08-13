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
	arm: CodexTurnStateArm;
	requestId: string;
	replayApplied: boolean;
	terminalMutationAllowed: boolean;
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
	for (const block of latestUser.content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			return { kind: "invalid" };
		}
		const record = block as Record<string, unknown>;
		if (record.type !== "tool_result") return { kind: "invalid" };
		callIds.push(record.tool_use_id);
	}
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
			return this.recordAttempt(
				input,
				scopeKey,
				"ineligible",
				cohortId,
				"hosted_suppressed",
				false,
				now,
				config,
			);
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
		if (
			pending.leaseRequestId !== undefined &&
			pending.leaseRequestId !== input.requestId
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
			delete pending.token;
			pending.arm = "control";
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
		if (input.stopReason !== "tool_use") {
			this.pending.delete(attempt.scopeKey);
			return "retired";
		}
		if (input.outputLineage.kind !== "valid") {
			this.pending.delete(attempt.scopeKey);
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
			this.touch(this.pending, attempt.scopeKey, existing);
			this.enforceEntryLimit(config.maxEntries);
			return "advanced";
		}

		const responseToken = validateTurnState(input.responseTurnState);
		if (!responseToken) {
			this.pending.delete(attempt.scopeKey);
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
		this.touch(this.pending, attempt.scopeKey, pending);
		this.enforceEntryLimit(config.maxEntries);
		return "captured";
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
		const generation = this.generations.get(scopeKey)?.generation ?? null;
		if (input.attemptId && input.requestId) {
			this.touch(this.attempts, input.attemptId, {
				scopeKey,
				generation,
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

	private sweep(now: number, config: CodexTurnStateConfig): void {
		const cutoff = now - config.idleTtlMs;
		for (const [key, entry] of this.pending) {
			if (entry.updatedAt < cutoff) this.pending.delete(key);
		}
		for (const [key, entry] of this.attempts) {
			if (entry.updatedAt < cutoff) this.attempts.delete(key);
		}
		for (const [key, entry] of this.generations) {
			if (entry.updatedAt < cutoff) {
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

	private enforceEntryLimit(maximum: number): void {
		while (
			this.generations.size + this.pending.size + this.attempts.size >
			maximum
		) {
			const oldestGeneration = this.oldestEntry("generation", this.generations);
			const oldestPending = this.oldestEntry("pending", this.pending);
			const oldestAttempt = this.oldestEntry("attempt", this.attempts);
			const oldest = [oldestGeneration, oldestPending, oldestAttempt]
				.filter(
					(
						entry,
					): entry is {
						kind: "generation" | "pending" | "attempt";
						key: string;
						updatedAt: number;
					} => entry !== null,
				)
				.sort((left, right) => left.updatedAt - right.updatedAt)[0];
			if (!oldest) return;
			if (oldest.kind === "attempt") {
				this.attempts.delete(oldest.key);
			} else {
				this.generations.delete(oldest.key);
				this.pending.delete(oldest.key);
			}
		}
	}

	private oldestEntry<V extends { updatedAt: number }>(
		kind: "generation" | "pending" | "attempt",
		map: Map<string, V>,
	): {
		kind: "generation" | "pending" | "attempt";
		key: string;
		updatedAt: number;
	} | null {
		const first = map.entries().next().value as [string, V] | undefined;
		if (!first) return null;
		return {
			kind,
			key: first[0],
			updatedAt: first[1].updatedAt,
		};
	}
}
