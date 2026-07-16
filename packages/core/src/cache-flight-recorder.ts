export type CacheOutcome = "hit" | "miss" | "unknown";

export type DiagnosisCause =
	| "identity_changed"
	| "serving_account_changed"
	| "cacheable_prefix_changed"
	| "upstream_miss_despite_stable_lineage"
	| "telemetry_unknown";

export type Completeness =
	| "complete"
	| "partial"
	| "incomplete"
	| "contradictory";

export type EvidenceDimension =
	| "identity"
	| "serving_account"
	| "cacheable_prefix"
	| "cache_outcome"
	| "token_accounting"
	| "timeline";

export type EvidenceKind =
	| "changed"
	| "stable"
	| "observed"
	| "unavailable"
	| "gap"
	| "contradiction";

export interface TurnEvidence {
	sequence: number;
	timestamp: string;
	identityFingerprint?: string;
	servingAccountId?: string;
	prefixFingerprint?: string;
	cacheOutcome: CacheOutcome;
	inputTokens?: number;
	cachedTokens?: number;
	completeness: Completeness;
	unavailableDimensions: string[];
	gapBefore?: boolean;
}

export interface Timeline {
	recorderConversationId: string;
	turns: readonly TurnEvidence[];
}

export interface DiagnosisEvidence {
	kind: EvidenceKind;
	dimension: EvidenceDimension;
	fromSequence?: number;
	toSequence: number;
	fromValue?: string | number;
	toValue?: string | number;
	detail: string;
}

export interface DiagnosisReport {
	recorderConversationId: string;
	baselineSequence: number | null;
	diagnosedSequence: number | null;
	cause: DiagnosisCause | null;
	completeness: Completeness;
	supportingEvidence: DiagnosisEvidence[];
	continuityProof: DiagnosisEvidence[];
	gaps: string[];
	unavailableDimensions: string[];
}

interface IntegrityResult {
	completeness: Completeness;
	gaps: string[];
	unavailableDimensions: string[];
	evidence: DiagnosisEvidence[];
}

const completenessRank: Record<Completeness, number> = {
	complete: 0,
	partial: 1,
	incomplete: 2,
	contradictory: 3,
};

function lessComplete(left: Completeness, right: Completeness): Completeness {
	return completenessRank[left] >= completenessRank[right] ? left : right;
}

function tokenContradiction(turn: TurnEvidence): string | null {
	const { inputTokens, cachedTokens, cacheOutcome } = turn;
	if (
		inputTokens !== undefined &&
		(!Number.isFinite(inputTokens) || inputTokens < 0)
	)
		return "input_tokens_invalid";
	if (
		cachedTokens !== undefined &&
		(!Number.isFinite(cachedTokens) || cachedTokens < 0)
	)
		return "cached_tokens_invalid";
	if (
		inputTokens !== undefined &&
		cachedTokens !== undefined &&
		cachedTokens > inputTokens
	)
		return "cached_tokens_exceed_input_tokens";
	if (
		cacheOutcome === "hit" &&
		(cachedTokens === undefined || cachedTokens <= 0)
	)
		return "hit_without_positive_cached_tokens";
	if (cacheOutcome === "miss" && cachedTokens !== 0)
		return "miss_without_zero_cached_tokens";
	return null;
}

/** Reconcile cache outcome and token counts without deriving missing telemetry. */
export function reconcileTurnTokens(turn: TurnEvidence): Completeness {
	return tokenContradiction(turn) ? "contradictory" : turn.completeness;
}

/** Return explicit and sequence-derived gaps in deterministic turn order. */
export function detectTimelineGaps(turns: readonly TurnEvidence[]): string[] {
	const ordered = [...turns].sort((a, b) => a.sequence - b.sequence);
	const gaps: string[] = [];
	for (let index = 0; index < ordered.length; index++) {
		const current = ordered[index] as TurnEvidence;
		const previous = ordered[index - 1];
		if (current.gapBefore) gaps.push(`gap_before_turn_${current.sequence}`);
		if (!previous) continue;
		if (current.sequence === previous.sequence) {
			gaps.push(`duplicate_turn_${current.sequence}`);
		} else if (current.sequence > previous.sequence + 1) {
			gaps.push(
				`missing_turns_${previous.sequence + 1}_to_${current.sequence - 1}`,
			);
		}
	}
	return [...new Set(gaps)];
}

function inspectIntegrity(turns: readonly TurnEvidence[]): IntegrityResult {
	let completeness: Completeness = "complete";
	const unavailableDimensions = new Set<string>();
	const evidence: DiagnosisEvidence[] = [];
	const gaps = detectTimelineGaps(turns);
	if (gaps.length > 0) completeness = "incomplete";
	for (const turn of turns) {
		completeness = lessComplete(completeness, turn.completeness);
		for (const dimension of turn.unavailableDimensions)
			unavailableDimensions.add(dimension);
		const contradiction = tokenContradiction(turn);
		if (contradiction) {
			completeness = "contradictory";
			evidence.push({
				kind: "contradiction",
				dimension: "token_accounting",
				toSequence: turn.sequence,
				detail: contradiction,
			});
		}
	}
	for (const gap of gaps) {
		const sequence = Number(gap.match(/\d+/)?.[0] ?? 0);
		evidence.push({
			kind: gap.startsWith("duplicate") ? "contradiction" : "gap",
			dimension: "timeline",
			toSequence: sequence,
			detail: gap,
		});
	}
	if (unavailableDimensions.size > 0)
		completeness = lessComplete(completeness, "partial");
	return {
		completeness,
		gaps,
		unavailableDimensions: [...unavailableDimensions].sort(),
		evidence,
	};
}

function transitionEvidence(
	previous: TurnEvidence,
	current: TurnEvidence,
): DiagnosisEvidence[] {
	const definitions: Array<{
		dimension: EvidenceDimension;
		previous: string | undefined;
		current: string | undefined;
	}> = [
		{
			dimension: "identity",
			previous: previous.identityFingerprint,
			current: current.identityFingerprint,
		},
		{
			dimension: "serving_account",
			previous: previous.servingAccountId,
			current: current.servingAccountId,
		},
		{
			dimension: "cacheable_prefix",
			previous: previous.prefixFingerprint,
			current: current.prefixFingerprint,
		},
	];
	return definitions.map((definition) => {
		const available =
			definition.previous !== undefined && definition.current !== undefined;
		const kind: EvidenceKind = !available
			? "unavailable"
			: definition.previous === definition.current
				? "stable"
				: "changed";
		return {
			kind,
			dimension: definition.dimension,
			fromSequence: previous.sequence,
			toSequence: current.sequence,
			fromValue: definition.previous,
			toValue: definition.current,
			detail: `${definition.dimension}_${kind}`,
		};
	});
}

function outcomeEvidence(turn: TurnEvidence): DiagnosisEvidence {
	return {
		kind: turn.cacheOutcome === "unknown" ? "unavailable" : "observed",
		dimension: "cache_outcome",
		toSequence: turn.sequence,
		toValue: turn.cacheOutcome,
		detail:
			turn.cacheOutcome === "unknown"
				? "cache_outcome_unavailable"
				: `cache_outcome_${turn.cacheOutcome}`,
	};
}

function unknownReport(
	timeline: Timeline,
	baselineSequence: number,
	diagnosedSequence: number,
	integrity: IntegrityResult,
	extraEvidence: DiagnosisEvidence[] = [],
): DiagnosisReport {
	return {
		recorderConversationId: timeline.recorderConversationId,
		baselineSequence,
		diagnosedSequence,
		cause: "telemetry_unknown",
		completeness:
			integrity.completeness === "complete"
				? "partial"
				: integrity.completeness,
		supportingEvidence: [...integrity.evidence, ...extraEvidence],
		continuityProof: [],
		gaps: integrity.gaps,
		unavailableDimensions: integrity.unavailableDimensions,
	};
}

/** Diagnose the first cache miss after a proven hit using only retained evidence. */
export function diagnoseTimeline(timeline: Timeline): DiagnosisReport {
	const turns = [...timeline.turns].sort((a, b) => a.sequence - b.sequence);
	const baseline = turns[0];
	const integrity = inspectIntegrity(turns);
	const emptyReport: DiagnosisReport = {
		recorderConversationId: timeline.recorderConversationId,
		baselineSequence: baseline?.sequence ?? null,
		diagnosedSequence: null,
		cause: null,
		completeness: integrity.completeness,
		supportingEvidence: [],
		continuityProof: [],
		gaps: integrity.gaps,
		unavailableDimensions: integrity.unavailableDimensions,
	};
	if (!baseline || turns.length === 1) return emptyReport;

	let priorHitIndex = baseline.cacheOutcome === "hit" ? 0 : -1;
	let latestContinuity: DiagnosisEvidence[] = [];
	for (let index = 1; index < turns.length; index++) {
		const current = turns[index] as TurnEvidence;
		const previous = turns[index - 1] as TurnEvidence;
		const transition = transitionEvidence(previous, current);
		if (current.cacheOutcome === "hit") {
			priorHitIndex = index;
			latestContinuity = transition.filter((item) => item.kind === "stable");
			continue;
		}
		if (priorHitIndex < 0) continue;
		if (current.cacheOutcome === "unknown") {
			return unknownReport(
				timeline,
				baseline.sequence,
				current.sequence,
				integrity,
				[...transition, outcomeEvidence(current)],
			);
		}
		if (current.cacheOutcome !== "miss") continue;

		const lineageEvidence: DiagnosisEvidence[] = [];
		for (
			let transitionIndex = priorHitIndex + 1;
			transitionIndex <= index;
			transitionIndex++
		) {
			lineageEvidence.push(
				...transitionEvidence(
					turns[transitionIndex - 1] as TurnEvidence,
					turns[transitionIndex] as TurnEvidence,
				),
			);
		}
		const missEvidence = outcomeEvidence(current);
		if (
			integrity.completeness !== "complete" ||
			lineageEvidence.some((item) => item.kind === "unavailable")
		) {
			return unknownReport(
				timeline,
				baseline.sequence,
				current.sequence,
				integrity,
				[...lineageEvidence, missEvidence],
			);
		}
		const changed = lineageEvidence.filter((item) => item.kind === "changed");
		const cause = changed.some((item) => item.dimension === "identity")
			? "identity_changed"
			: changed.some((item) => item.dimension === "serving_account")
				? "serving_account_changed"
				: changed.some((item) => item.dimension === "cacheable_prefix")
					? "cacheable_prefix_changed"
					: "upstream_miss_despite_stable_lineage";
		return {
			recorderConversationId: timeline.recorderConversationId,
			baselineSequence: baseline.sequence,
			diagnosedSequence: current.sequence,
			cause,
			completeness: integrity.completeness,
			supportingEvidence: [...lineageEvidence, missEvidence],
			continuityProof: [],
			gaps: integrity.gaps,
			unavailableDimensions: integrity.unavailableDimensions,
		};
	}

	return {
		...emptyReport,
		continuityProof: latestContinuity,
	};
}
