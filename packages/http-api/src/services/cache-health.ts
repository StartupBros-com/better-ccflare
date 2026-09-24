import { cacheReadSharePercent } from "@better-ccflare/core";
import {
	CACHE_HEALTH_BUCKET_MS,
	CACHE_HEALTH_CATCHUP_MS,
	CACHE_HEALTH_DEFAULT_POLICY,
	CACHE_HEALTH_SETTLEMENT_MS,
	type CacheHealthAlertDecision,
	type CacheHealthBucket,
	type CacheHealthEvidence,
	type CacheHealthPolicy,
	type CacheHealthScope,
	type CacheHealthSignalState,
	type CacheHealthState,
	type CacheHealthStreak,
	cacheHealthScopeKey,
} from "@better-ccflare/types";

export { CACHE_HEALTH_DEFAULT_POLICY } from "@better-ccflare/types";

const BASELINE_MS = 24 * 60 * 60_000;

export function cacheHealthQueryWindow(nowMs: number): {
	startMs: number;
	endMs: number;
} {
	const endMs =
		Math.floor((nowMs - CACHE_HEALTH_SETTLEMENT_MS) / CACHE_HEALTH_BUCKET_MS) *
		CACHE_HEALTH_BUCKET_MS;
	return { startMs: endMs - CACHE_HEALTH_CATCHUP_MS, endMs };
}

export function cacheHealthPolicyFingerprint(
	policy: CacheHealthPolicy,
): string {
	return JSON.stringify([
		1,
		...Object.keys(CACHE_HEALTH_DEFAULT_POLICY).map(
			(key) => policy[key as keyof CacheHealthPolicy],
		),
	]);
}

function emptySignal(): CacheHealthSignalState {
	return { sequence: 0, incident: null, bad: null, recovery: null };
}

export function createCacheHealthState(
	scope: CacheHealthScope,
): CacheHealthState {
	return {
		version: 1,
		scope,
		revision: 0,
		lastBucketEnd: 0,
		policyFingerprint: "",
		enrolled: false,
		healthyEnds: [],
		reportingEnd: null,
		contributors: [],
		reuse: emptySignal(),
		telemetry: emptySignal(),
	};
}

const COUNTS = [
	"eligible",
	"measured",
	"missing",
	"invalid",
	"zeroInput",
	"failed",
	"internal",
	"zeroHit",
	"inputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
] as const;

function evidence(bucket: CacheHealthEvidence): CacheHealthEvidence {
	const result: CacheHealthEvidence = {
		startMs: bucket.startMs,
		endMs: bucket.endMs,
		contributors: bucket.contributors.map((c) => ({ ...c })),
		totalsValid: bucket.totalsValid,
		eligible: 0,
		measured: 0,
		missing: 0,
		invalid: 0,
		zeroInput: 0,
		failed: 0,
		internal: 0,
		zeroHit: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	for (const key of COUNTS) result[key] = bucket[key];
	return result;
}

function combine(
	left: CacheHealthEvidence,
	right: CacheHealthEvidence,
): CacheHealthEvidence {
	const result = evidence(right);
	result.startMs = Math.min(left.startMs, right.startMs);
	result.endMs = Math.max(left.endMs, right.endMs);
	result.totalsValid &&= left.totalsValid;
	for (const key of COUNTS) {
		const sum = left[key] + right[key];
		if (!Number.isSafeInteger(sum) || sum < 0) {
			result.totalsValid = false;
			result[key] = 0;
		} else result[key] = sum;
	}
	const contributors = new Map(
		[...left.contributors, ...right.contributors].map((c) => [
			JSON.stringify([c.accountId, c.accountGeneration]),
			c,
		]),
	);
	result.contributors = [...contributors.values()];
	return result;
}

function extend(
	streak: CacheHealthStreak | null,
	bucket: CacheHealthBucket,
	limit: number,
): CacheHealthStreak {
	if (!streak || streak.buckets >= limit)
		return { buckets: 1, evidence: evidence(bucket) };
	return {
		buckets: streak.buckets + 1,
		evidence: combine(streak.evidence, bucket),
	};
}

function rates(e: CacheHealthEvidence) {
	return {
		reusePercent:
			e.totalsValid &&
			e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens > 0
				? cacheReadSharePercent({
						shape: "additive",
						uncachedInputTokens: e.inputTokens,
						cacheReadInputTokens: e.cacheReadTokens,
						cacheWriteInputTokens: e.cacheWriteTokens,
					})
				: null,
		coveragePercent: e.eligible > 0 ? (e.measured * 100) / e.eligible : null,
		zeroHitPercent: e.measured > 0 ? (e.zeroHit * 100) / e.measured : null,
	};
}

/** Clock-injected transition. No IO; duplicate, unsettled and old replay buckets are inert. */
export function advanceCacheHealth(
	previous: CacheHealthState,
	bucket: CacheHealthBucket,
	policy: CacheHealthPolicy = CACHE_HEALTH_DEFAULT_POLICY,
	nowMs: number = bucket.endMs + CACHE_HEALTH_SETTLEMENT_MS,
): { state: CacheHealthState; alerts: CacheHealthAlertDecision[] } {
	if (cacheHealthScopeKey(previous.scope) !== cacheHealthScopeKey(bucket.scope))
		throw new Error("Cache health scope mismatch");
	const window = cacheHealthQueryWindow(nowMs);
	if (
		bucket.endMs <= previous.lastBucketEnd ||
		bucket.endMs > window.endMs ||
		bucket.startMs < window.startMs
	)
		return { state: previous, alerts: [] };
	if (
		bucket.endMs - bucket.startMs !== CACHE_HEALTH_BUCKET_MS ||
		bucket.startMs % CACHE_HEALTH_BUCKET_MS !== 0
	)
		throw new Error("Invalid cache health bucket");
	const state = structuredClone(previous);
	const fingerprint = cacheHealthPolicyFingerprint(policy);
	if (
		state.policyFingerprint !== fingerprint ||
		state.lastBucketEnd !== bucket.startMs
	) {
		state.reuse.bad =
			state.reuse.recovery =
			state.telemetry.bad =
			state.telemetry.recovery =
				null;
	}
	if (state.policyFingerprint !== fingerprint) {
		state.healthyEnds = [];
		state.reportingEnd = null;
	}
	state.policyFingerprint = fingerprint;
	state.lastBucketEnd = bucket.endMs;
	state.revision++;
	state.contributors = bucket.contributors.map((c) => ({ ...c }));
	state.enrolled ||=
		bucket.totalsValid && bucket.cacheReadTokens > 0 && bucket.measured > 0;
	state.healthyEnds = state.healthyEnds.filter(
		(end) => end >= bucket.endMs - BASELINE_MS,
	);
	const alerts: CacheHealthAlertDecision[] = [];
	const current = rates(bucket);
	const eligibleScope = bucket.native || state.enrolled;
	const qualified =
		eligibleScope &&
		bucket.measured >= policy.minimumRequests &&
		current.coveragePercent !== null &&
		current.coveragePercent >= policy.minimumCoveragePercent &&
		current.reusePercent !== null &&
		bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens >=
			policy.minimumInputTokens;
	const telemetryQualified =
		eligibleScope &&
		bucket.eligible >= policy.minimumRequests &&
		current.coveragePercent !== null;

	function notify(
		reason: "reuse" | "telemetry",
		phase: CacheHealthAlertDecision["phase"],
		sample: CacheHealthEvidence,
		threshold: number,
	): void {
		const signal = state[reason];
		const incident = signal.incident;
		if (!incident) return;
		incident.lastNotificationAt = nowMs;
		const type =
			phase === "recovered"
				? "cache_efficiency_recovered"
				: reason === "telemetry"
					? "cache_telemetry_gap"
					: incident.severity === "critical"
						? "cache_efficiency_critical"
						: "cache_efficiency_low";
		alerts.push({
			id: JSON.stringify([
				"cache-health",
				cacheHealthScopeKey(state.scope),
				reason,
				incident.sequence,
				phase,
				bucket.endMs,
			]),
			type,
			severity: phase === "recovered" ? "info" : incident.severity,
			scope: state.scope,
			reason,
			phase,
			sequence: incident.sequence,
			timestamp: nowMs,
			threshold,
			...rates(sample),
			evidence: sample,
		});
	}

	function transition(
		reason: "reuse" | "telemetry",
		bad: boolean,
		healthy: boolean,
		critical: boolean,
		triggerAllowed: boolean,
		badLimit: number,
		badThreshold: number,
		recoveryThreshold: number,
	): void {
		const signal = state[reason];
		signal.bad = bad ? extend(signal.bad, bucket, badLimit) : null;
		signal.recovery = healthy
			? extend(signal.recovery, bucket, policy.recoveryBuckets)
			: null;
		if (
			signal.incident &&
			signal.recovery &&
			signal.recovery.buckets >= policy.recoveryBuckets
		) {
			notify(reason, "recovered", signal.recovery.evidence, recoveryThreshold);
			signal.incident = null;
			signal.recovery = null;
		} else if (
			!signal.incident &&
			triggerAllowed &&
			(critical || (signal.bad && signal.bad.buckets >= badLimit))
		) {
			signal.incident = {
				sequence: ++signal.sequence,
				severity: critical ? "critical" : "warning",
				lastNotificationAt: nowMs,
			};
			notify(
				reason,
				"opened",
				critical
					? evidence(bucket)
					: (signal.bad as CacheHealthStreak).evidence,
				critical ? policy.criticalPercent : badThreshold,
			);
			signal.bad = null;
		} else if (
			signal.incident &&
			critical &&
			signal.incident.severity !== "critical"
		) {
			signal.incident.severity = "critical";
			notify(reason, "escalated", evidence(bucket), policy.criticalPercent);
		} else if (
			signal.incident &&
			bad &&
			nowMs - signal.incident.lastNotificationAt >= policy.reminderMs
		) {
			notify(reason, "reminder", evidence(bucket), badThreshold);
		}
	}

	transition(
		"reuse",
		qualified && (current.reusePercent as number) < policy.warningPercent,
		qualified && (current.reusePercent as number) >= policy.recoveryPercent,
		qualified &&
			(current.reusePercent as number) < policy.criticalPercent &&
			state.healthyEnds.length >= 2,
		true,
		policy.warningBuckets,
		policy.warningPercent,
		policy.recoveryPercent,
	);
	transition(
		"telemetry",
		telemetryQualified &&
			(current.coveragePercent as number) < policy.telemetryGapPercent,
		telemetryQualified &&
			(current.coveragePercent as number) >= policy.telemetryRecoveryPercent,
		false,
		state.reportingEnd !== null,
		policy.telemetryBuckets,
		policy.telemetryGapPercent,
		policy.telemetryRecoveryPercent,
	);
	if (qualified && (current.reusePercent as number) >= policy.recoveryPercent)
		state.healthyEnds = [...state.healthyEnds, bucket.endMs].slice(-2);
	if (
		telemetryQualified &&
		(current.coveragePercent as number) >= policy.telemetryReportingPercent
	)
		state.reportingEnd = bucket.endMs;
	// The commit must fence every generation used in an opening/recovery
	// window, including contributors from earlier buckets in that window.
	const contributing = [
		...bucket.contributors,
		...alerts.flatMap((alert) => alert.evidence.contributors),
		...[
			state.reuse.bad,
			state.reuse.recovery,
			state.telemetry.bad,
			state.telemetry.recovery,
		].flatMap((streak) => streak?.evidence.contributors ?? []),
	];
	state.contributors = [
		...new Map(
			contributing.map((c) => [
				JSON.stringify([c.accountId, c.accountGeneration]),
				c,
			]),
		).values(),
	];
	return { state, alerts };
}

/** Account enrollment is carried into provider samples before volume floors. */
export function aggregateProviderCacheBuckets(
	buckets: readonly CacheHealthBucket[],
	enrolledScopeKeys: ReadonlySet<string> = new Set(),
): CacheHealthBucket[] {
	const groups = new Map<string, CacheHealthBucket>();
	const enrolled = new Set(enrolledScopeKeys);
	for (const bucket of [...buckets].sort((a, b) => a.endMs - b.endMs)) {
		if (bucket.scope.kind !== "account") continue;
		const accountKey = cacheHealthScopeKey(bucket.scope);
		if (bucket.totalsValid && bucket.cacheReadTokens > 0 && bucket.measured > 0)
			enrolled.add(accountKey);
		if (!bucket.native && !enrolled.has(accountKey)) continue;
		const scope: CacheHealthScope = {
			kind: "provider",
			provider: bucket.scope.provider,
			model: bucket.scope.model,
			accountId: null,
			accountGeneration: null,
		};
		const key = JSON.stringify([cacheHealthScopeKey(scope), bucket.endMs]);
		const prior = groups.get(key);
		const sample = evidence(bucket);
		if (bucket.eligible === 0) sample.contributors = [];
		groups.set(key, {
			...(prior ? combine(prior, sample) : sample),
			scope,
			native: true,
		});
	}
	return [...groups.values()]
		.filter((bucket) => bucket.eligible > 0)
		.sort(
			(a, b) =>
				a.endMs - b.endMs ||
				cacheHealthScopeKey(a.scope).localeCompare(
					cacheHealthScopeKey(b.scope),
				),
		);
}

export function isRedundantProviderCacheAlert(
	decision: CacheHealthAlertDecision,
	accountDecisions: readonly CacheHealthAlertDecision[],
	accountStates: readonly CacheHealthState[] = [],
): boolean {
	if (
		decision.scope.kind !== "provider" ||
		decision.evidence.contributors.length !== 1
	)
		return false;
	const [contributor] = decision.evidence.contributors;
	const sameAccount = (scope: CacheHealthScope) =>
		scope.kind === "account" &&
		scope.accountId === contributor.accountId &&
		scope.accountGeneration === contributor.accountGeneration &&
		scope.provider === decision.scope.provider &&
		scope.model === decision.scope.model;
	return (
		accountDecisions.some(
			(a) =>
				sameAccount(a.scope) &&
				a.reason === decision.reason &&
				a.type === decision.type &&
				a.phase === decision.phase &&
				a.evidence.startMs <= decision.evidence.startMs &&
				a.evidence.endMs >= decision.evidence.endMs,
		) ||
		(decision.phase !== "recovered" &&
			accountStates.some((state) => {
				const incident = state[decision.reason].incident;
				return (
					sameAccount(state.scope) &&
					state.lastBucketEnd >= decision.evidence.endMs &&
					incident !== null &&
					(incident.severity === "critical" || decision.severity !== "critical")
				);
			}))
	);
}
