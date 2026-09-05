import {
	getModelList,
	getStrictClaudeModelFamily,
	resolveStoredPolicyAliasModel,
} from "@better-ccflare/core";
import { validateNativeQuotaRouteShape } from "@better-ccflare/core/managed-routing";
import type {
	FamilyScopedRejectionEvidence,
	UsageSnapshot,
} from "@better-ccflare/providers";
import type {
	Account,
	ComboFamily,
	ComboRoutingPolicySnapshot,
	EffectiveComboMember,
} from "@better-ccflare/types";
import {
	collectWindows,
	DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS,
	evaluateHardCapacity,
	type HardCapacityExclusion,
} from "./usage-throttling";

export type NativeQuotaTerminalPresentation = {
	readonly requestedModel: string;
	readonly family: ComboFamily;
	readonly comboId: string;
	readonly comboName?: string;
	readonly nextRecheckAt: number;
} & (
	| {
			readonly kind: "quota_wait";
			readonly reason: "shared_capacity" | "family_capacity";
			readonly resetAt: number | null;
	  }
	| { readonly kind: "temporary_unavailable"; readonly resetAt?: null }
);

export interface NativeQuotaContext {
	readonly family: ComboFamily;
	readonly comboId: string;
	readonly comboName?: string;
	readonly requestedModel: string;
	readonly members: readonly EffectiveComboMember[];
	readonly accounts: readonly Account[];
	readonly structuralError: string | null;
}

export interface NativeQuotaFamilyMarker {
	readonly family: string;
	readonly markedAt: number;
	readonly expiresAt: number;
	readonly evidence?: FamilyScopedRejectionEvidence;
}

export interface NativeQuotaFamilyProof {
	readonly source: "usage_snapshot" | "reactive_family";
	readonly expiresAt: number;
	readonly resetAt: number;
}

export interface NativeQuotaEvaluation {
	readonly structuralError: string | null;
	readonly primaryAccountIds: readonly string[];
	readonly backupAllowedAccountIds: readonly string[];
	readonly familyProofs: ReadonlyMap<string, NativeQuotaFamilyProof>;
	/** Candidate-local quota checks, separate from cooldown/circuit/auth availability. */
	readonly capacities: ReadonlyMap<string, readonly HardCapacityExclusion[]>;
	/** Configured physical models from the same account snapshot validated here. */
	readonly physicalModels: ReadonlyMap<string, readonly string[]>;
	readonly admittedCandidateIds: readonly string[];
	readonly wait: NativeQuotaTerminalPresentation | null;
}

/** Capture structural membership before filtering cooldowns, auth or circuits. */
export function createNativeQuotaContext(input: {
	family: ComboFamily;
	comboId: string;
	comboName?: string;
	requestedModel: string;
	members: readonly EffectiveComboMember[];
	accounts: readonly Account[];
}): NativeQuotaContext {
	const shape = validateNativeQuotaRouteShape(input);
	return {
		...input,
		members: [...input.members],
		accounts: [...input.accounts],
		structuralError: shape.valid ? null : shape.reason,
	};
}

/** Explicit routes and old/mocked assignments preserve their established routing. */
export function resolveNativeQuotaContext(input: {
	snapshot: ComboRoutingPolicySnapshot;
	members: readonly EffectiveComboMember[];
	accounts: readonly Account[];
	requestedModel: string;
	explicitRoute?: boolean;
	combosEnabled?: boolean;
}): NativeQuotaContext | null {
	const { snapshot } = input;
	if (
		input.explicitRoute ||
		input.combosEnabled === false ||
		snapshot.assignment.exhaustion_policy !== "native_quota_wait" ||
		!snapshot.assignment.enabled ||
		!snapshot.assignment.combo_id ||
		!snapshot.combo?.enabled ||
		snapshot.combo.id !== snapshot.assignment.combo_id ||
		getStrictClaudeModelFamily(
			resolveStoredPolicyAliasModel(input.requestedModel),
		) !== snapshot.assignment.family
	)
		return null;
	return createNativeQuotaContext({
		family: snapshot.assignment.family,
		comboId: snapshot.combo.id,
		comboName: snapshot.combo.name,
		requestedModel: input.requestedModel,
		members: input.members,
		accounts: input.accounts,
	});
}

interface NativeLimit {
	kind?: unknown;
	percent?: unknown;
	is_active?: unknown;
	resets_at?: unknown;
	scope?: { model?: { id?: unknown; display_name?: unknown } | null } | null;
}

function freshSnapshot(
	snapshot: UsageSnapshot | null,
	now: number,
): snapshot is UsageSnapshot {
	return (
		snapshot !== null &&
		typeof snapshot === "object" &&
		snapshot.data !== null &&
		typeof snapshot.data === "object" &&
		!Array.isArray(snapshot.data) &&
		Number.isFinite(now) &&
		Number.isFinite(snapshot.observedAt) &&
		snapshot.observedAt <= now &&
		now - snapshot.observedAt < DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS
	);
}

/** Reject contradictory names before using the intentionally permissive legacy normalizer. */
function consistentScopeNames(snapshot: UsageSnapshot): boolean {
	const limits = (snapshot.data as { limits?: unknown }).limits;
	if (!Array.isArray(limits)) return true;
	return limits.every((value: NativeLimit | null) => {
		if (value?.is_active != null && typeof value.is_active !== "boolean")
			return false;
		if (!value || value.is_active === false || value.kind !== "weekly_scoped")
			return true;
		const model = value.scope?.model;
		if (!model) return true;
		if (
			(model.id != null && typeof model.id !== "string") ||
			(model.display_name != null && typeof model.display_name !== "string")
		)
			return false;
		const id =
			typeof model.id === "string"
				? getStrictClaudeModelFamily(resolveStoredPolicyAliasModel(model.id))
				: null;
		const displayFamilies =
			typeof model.display_name === "string"
				? [
						...model.display_name
							.toLowerCase()
							.matchAll(/\b(fable|opus|sonnet|haiku)\b/g),
					].map((match) => match[1])
				: [];
		if (new Set(displayFamilies).size > 1) return false;
		const display = displayFamilies[0] ?? null;
		if (!id && !display) return false;
		return !(id && display && id !== display);
	});
}

function activeAccountHeadroom(snapshot: UsageSnapshot, now: number): boolean {
	const limits = (snapshot.data as { limits?: NativeLimit[] }).limits;
	if (!Array.isArray(limits)) return false;
	// The shared normalizer supplements missing active generic windows from the
	// flat Anthropic payload. Validate every active raw row first: a malformed row
	// must not disappear during normalization and make optimistic flat data win.
	const accountKinds = ["session", "weekly_all"];
	if (
		limits.some((row) => {
			if (
				!row ||
				row.is_active === false ||
				(row.kind !== "session" && row.kind !== "weekly_all")
			)
				return false;
			const reset =
				typeof row.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
			return (
				typeof row.percent !== "number" ||
				!Number.isFinite(row.percent) ||
				row.percent < 0 ||
				row.percent >= 100 ||
				!Number.isFinite(reset) ||
				reset <= now
			);
		})
	)
		return false;
	const windows = collectWindows(snapshot.data);
	return accountKinds.every((kind) => {
		const matching = windows.filter((window) => window.kind === kind);
		return (
			matching.length > 0 &&
			matching.every(
				(window) =>
					window.utilization >= 0 &&
					window.utilization < 100 &&
					window.resetAtMs !== null &&
					window.resetAtMs > now,
			)
		);
	});
}

/** Either affirmative billing signal prevents treating a family allowance as hard. */
function hasEnabledOverage(snapshot: UsageSnapshot): boolean {
	const billing = snapshot.data as {
		spend?: { enabled?: unknown } | null;
		extra_usage?: { is_enabled?: unknown } | null;
	};
	return (
		billing.spend?.enabled === true || billing.extra_usage?.is_enabled === true
	);
}

function hardEvidence(
	snapshot: UsageSnapshot | null,
	model: string,
	now: number,
	ignoreOverage = false,
): readonly HardCapacityExclusion[] {
	if (!freshSnapshot(snapshot, now) || !consistentScopeNames(snapshot))
		return [];
	try {
		return evaluateHardCapacity(snapshot.data, {
			requestModel: model,
			observedAt: snapshot.observedAt,
			provider: ignoreOverage ? "native-reactive-proof" : "anthropic",
			now,
		}).exclusions.filter(
			(row) => row.scope !== "family" || !hasEnabledOverage(snapshot),
		);
	} catch {
		return [];
	}
}

function familyProof(
	snapshot: UsageSnapshot | null,
	marker: NativeQuotaFamilyMarker | null,
	model: string,
	family: ComboFamily,
	now: number,
): NativeQuotaFamilyProof | null {
	if (!freshSnapshot(snapshot, now) || !consistentScopeNames(snapshot))
		return null;
	const proactive = hardEvidence(snapshot, model, now).filter(
		(row): row is HardCapacityExclusion & { resetAtMs: number } =>
			row.scope === "family" &&
			row.modelFamily === family &&
			row.resetAtMs !== null,
	);
	if (proactive.length > 0)
		return {
			source: "usage_snapshot",
			expiresAt: Math.min(...proactive.map((row) => row.evidenceExpiresAt)),
			resetAt: Math.max(...proactive.map((row) => row.resetAtMs)),
		};
	if (
		!marker ||
		marker.family !== family ||
		marker.evidence?.reason !== "matching_scoped_limit" ||
		marker.evidence.authoritativeNativeRejection !== true ||
		!Number.isFinite(marker.markedAt) ||
		marker.markedAt > now ||
		!Number.isFinite(marker.expiresAt) ||
		marker.expiresAt <= now ||
		now - marker.markedAt >= DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS ||
		hasEnabledOverage(snapshot) ||
		!activeAccountHeadroom(snapshot, now)
	)
		return null;
	// Read family evidence independently of any exact-model marker. Revalidate the
	// current snapshot: a newer recovered observation immediately closes the gate.
	// The trusted marker already carries matching-scoped classification; the strict
	// normalized checks here also support current mixed or flat account windows.
	const scoped = hardEvidence(snapshot, model, now, true).filter(
		(row): row is HardCapacityExclusion & { resetAtMs: number } =>
			row.scope === "family" &&
			row.modelFamily === family &&
			row.resetAtMs !== null,
	);
	if (scoped.length === 0) return null;

	return {
		source: "reactive_family",
		expiresAt: Math.min(
			marker.expiresAt,
			marker.markedAt + DEFAULT_CAPACITY_SNAPSHOT_FRESHNESS_MS,
			...scoped.map((row) => row.evidenceExpiresAt),
		),
		resetAt: Math.max(...scoped.map((row) => row.resetAtMs)),
	};
}

/** Evaluate pool membership before cooldown/circuit/auth availability filtering. */
export function evaluateNativeQuotaPolicy(
	context: NativeQuotaContext,
	options: {
		accounts?: readonly Account[];
		now: number;
		getSnapshot: (accountId: string) => UsageSnapshot | null;
		getFamilyMarker: (
			accountId: string,
			model: string,
			now: number,
		) => NativeQuotaFamilyMarker | null;
	},
): NativeQuotaEvaluation {
	const now = options.now;
	const accounts = options.accounts ?? context.accounts;
	const shape = validateNativeQuotaRouteShape({
		family: context.family,
		members: context.members,
		accounts,
	});
	const unpaused = new Set(
		accounts.filter((account) => !account.paused).map((account) => account.id),
	);
	const primaryAccountIds = shape.valid
		? shape.primaryAccountIds.filter((id) => unpaused.has(id))
		: [];
	const structuralError =
		context.structuralError ??
		(shape.valid
			? primaryAccountIds.length
				? null
				: "Native quota wait has no unpaused primary accounts."
			: shape.reason);
	const familyProofs = new Map<string, NativeQuotaFamilyProof>();
	const candidateBlockers = new Map<string, readonly HardCapacityExclusion[]>();
	const physicalModels = new Map<string, readonly string[]>();
	if (structuralError)
		return {
			structuralError,
			primaryAccountIds,
			backupAllowedAccountIds: [],
			familyProofs,
			capacities: candidateBlockers,
			physicalModels,
			admittedCandidateIds: [],
			wait: null,
		};
	const { getSnapshot, getFamilyMarker } = options;
	const snapshots = new Map(
		primaryAccountIds.map((id) => [id, getSnapshot(id)]),
	);
	for (const id of primaryAccountIds) {
		const primary = context.members.find(
			(member) =>
				member.account_id === id &&
				getStrictClaudeModelFamily(member.logical_model) === context.family,
		);
		if (!primary) continue;
		const proof = familyProof(
			snapshots.get(id) ?? null,
			getFamilyMarker(id, primary.logical_model, now),
			primary.logical_model,
			context.family,
			now,
		);
		if (proof) familyProofs.set(id, proof);
	}
	const backupAllowedAccountIds = primaryAccountIds.filter(
		(id) =>
			context.family === "fable" &&
			familyProofs.has(id) &&
			context.members.some(
				(member) =>
					member.account_id === id &&
					getStrictClaudeModelFamily(member.logical_model) === "opus",
			),
	);
	const gatedMembers = context.members.filter(
		(member) =>
			primaryAccountIds.includes(member.account_id) &&
			(getStrictClaudeModelFamily(member.logical_model) === context.family ||
				backupAllowedAccountIds.includes(member.account_id)),
	);
	for (const member of gatedMembers) {
		const account = accounts.find((entry) => entry.id === member.account_id);
		const family = getStrictClaudeModelFamily(member.logical_model);
		if (!account || !family) continue;
		physicalModels.set(
			member.id,
			getModelList(member.logical_model, account) ?? [member.logical_model],
		);
		const snapshot = snapshots.get(member.account_id) ?? null;
		const blockers = [...hardEvidence(snapshot, member.logical_model, now)];
		const proof =
			family === context.family
				? familyProofs.get(member.account_id)
				: familyProof(
						snapshot,
						getFamilyMarker(member.account_id, member.logical_model, now),
						member.logical_model,
						family,
						now,
					);
		if (proof && !blockers.some((blocker) => blocker.scope === "family"))
			blockers.push({
				scope: "family",
				window: `reactive_${family}`,
				windowKind: "weekly_scoped",
				modelFamily: family,
				utilization: 100,
				resetAtMs: proof.resetAt,
				evidenceExpiresAt: proof.expiresAt,
			});
		candidateBlockers.set(member.id, blockers);
	}
	const admittedCandidateIds = gatedMembers
		.filter((member) => candidateBlockers.get(member.id)?.length === 0)
		.map((member) => member.id);
	let quotaWait: NativeQuotaTerminalPresentation | null = null;
	if (gatedMembers.length > 0 && admittedCandidateIds.length === 0) {
		const blockerSets = [...candidateBlockers.values()];
		const blockers = blockerSets.flat();
		const routeResets = blockerSets.map((rows) => {
			const resets = rows.map((row) => row.resetAtMs);
			return resets.every(
				(reset): reset is number =>
					reset !== null && Number.isFinite(reset) && reset > now,
			)
				? Math.max(...resets)
				: null;
		});
		const resetAt = routeResets.every(
			(reset): reset is number => reset !== null,
		)
			? Math.min(...routeResets)
			: null;
		quotaWait = {
			kind: "quota_wait",
			requestedModel: context.requestedModel,
			family: context.family,
			comboId: context.comboId,
			reason: blockers.some((row) => row.scope === "account")
				? "shared_capacity"
				: "family_capacity",
			resetAt,
			nextRecheckAt: Math.max(
				now + 1000,
				Math.min(now + 60000, ...blockers.map((row) => row.evidenceExpiresAt)),
			),
		};
	}
	return {
		structuralError: null,
		primaryAccountIds,
		backupAllowedAccountIds,
		familyProofs,
		capacities: candidateBlockers,
		physicalModels,
		admittedCandidateIds,
		wait: quotaWait,
	};
}

/** Final admission check also rejects stale strategies returning unconfigured models. */
export function isNativeQuotaCandidateAdmitted(
	context: NativeQuotaContext,
	evaluation: NativeQuotaEvaluation,
	candidate: {
		accountId: string;
		model: string;
		candidateId?: string;
		physicalModel?: string;
	},
): boolean {
	const { accountId } = candidate;
	if (
		evaluation.structuralError ||
		!evaluation.primaryAccountIds.includes(accountId)
	)
		return false;
	return context.members.some((member) => {
		if (
			member.account_id !== accountId ||
			(candidate.candidateId !== undefined &&
				member.id !== candidate.candidateId) ||
			!evaluation.admittedCandidateIds.includes(member.id)
		)
			return false;
		const destinations = evaluation.physicalModels.get(member.id);
		if (!destinations) return false;
		if (
			candidate.model !== member.logical_model &&
			!destinations.includes(candidate.model)
		)
			return false;
		if (
			candidate.physicalModel &&
			!destinations.includes(candidate.physicalModel)
		)
			return false;
		const family = getStrictClaudeModelFamily(member.logical_model);
		return (
			family === context.family ||
			(family === "opus" &&
				evaluation.backupAllowedAccountIds.includes(accountId))
		);
	});
}
