import { createHash } from "node:crypto";
import type {
	QualityApprovedLine,
	QualityProvider,
} from "@better-ccflare/types";

type EvidenceValue =
	| null
	| boolean
	| number
	| string
	| readonly EvidenceValue[]
	| { readonly [key: string]: EvidenceValue };

/** Facts only. Null is unknown, never a provider default or predecessor value. */
export interface AutoModelCapabilities {
	readonly contextWindow: number | null;
	readonly maxContextWindow: number | null;
	readonly effectiveContextPercent: number | null;
	readonly maxOutputTokens: number | null;
	/** Only Codex's absent/null catalog field delegates acceptance, not malformed data. */
	readonly providerManagedOutput: boolean;
	readonly inputModalities: readonly string[] | null;
	/** Provider-specific evidence, not a generic tool support grant. */
	readonly toolEvidence: Readonly<Record<string, EvidenceValue>>;
	readonly nativeCapabilities: EvidenceValue;
	readonly revision: string;
}

/** Exact supported identities, oldest to newest. This is not lane policy or
 * entitlement: the compiled U1 policy still owns assignments/enrollment. No
 * prefix matcher, catalog priority or upgrade-to-an-unfamiliar-name adds an ID.
 * Sources: approved native model facts and observed Codex catalog identities.
 * New identities require reviewed support evidence before joining this adapter.
 */
const SUPPORTED_IDENTITIES: Readonly<
	Record<
		QualityApprovedLine,
		{ provider: QualityProvider; models: readonly string[] }
	>
> = {
	"claude-fable": { provider: "anthropic", models: ["claude-fable-5-1"] },
	"gpt-astra": { provider: "codex", models: ["gpt-6-astra"] },
	"claude-opus": { provider: "anthropic", models: ["claude-opus-5-5"] },
	"gpt-sol": { provider: "codex", models: ["gpt-5.6-sol", "gpt-6.1-sol"] },
	"claude-sonnet": { provider: "anthropic", models: ["claude-sonnet-5-5"] },
	"claude-haiku": {
		provider: "anthropic",
		models: ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
	},
};

export interface AutoCatalogModel {
	readonly id: string;
	readonly capabilities?: AutoModelCapabilities;
}
/** Auto validity is deliberately no longer than one ordinary refresh interval:
 * Codex refreshes every 15 minutes; native defaults to 168 hours. Native callers
 * may shorten this to their configured interval. Scheduler jitter, retry backoff,
 * stale-alert grace periods and disabled refresh never extend this evidence.
 * These are evidence lifetimes, not model capacity or legacy cache TTLs.
 */
export const AUTO_CATALOG_MAX_AGE_MS = Object.freeze({
	codex: 15 * 60_000,
	anthropic: 168 * 60 * 60_000,
});

export interface AutoCatalogEvidence {
	/** Source acquisition time and exclusive expiry, in epoch milliseconds. */
	readonly fetchedAt: number;
	readonly expiresAt: number;
	readonly accountId: string;
	readonly provider: QualityProvider;
	readonly source: "provider-catalog";
	readonly revision: string;
	readonly models: readonly AutoCatalogModel[];
}
export interface AutoModelTargetEvidence {
	readonly accountId: string;
	readonly provider: QualityProvider;
	readonly line: QualityApprovedLine;
	readonly physicalModel: string;
	readonly catalogRevision: string;
	readonly capabilityRevision: string | null;
	readonly evidenceRef: string;
	readonly capabilities: AutoModelCapabilities | null;
}

/** Recheck even retained snapshots: neither reading nor failed refresh renews
 * acquisition time. This establishes freshness only, NOT credential-epoch fit.
 */
export function isAutoCatalogEvidenceCurrent(
	evidence: Pick<
		AutoCatalogEvidence,
		"provider" | "fetchedAt" | "expiresAt"
	> | null,
): boolean {
	if (!evidence) return false;
	const now = Date.now();
	return (
		Number.isSafeInteger(now) &&
		Number.isSafeInteger(evidence.fetchedAt) &&
		Number.isSafeInteger(evidence.expiresAt) &&
		evidence.fetchedAt >= 0 &&
		evidence.fetchedAt <= now &&
		evidence.expiresAt > now &&
		evidence.expiresAt - evidence.fetchedAt <=
			AUTO_CATALOG_MAX_AGE_MS[evidence.provider]
	);
}

/** Pure snapshot constructor. Only an owned listing is evidence of availability.
 * Capacity/tool admission is deliberately separate: a target with null facts is
 * still unknown, never admitted by this adapter. Shared/global disk catalogs must
 * not be passed off as live/cached own listings by callers.
 */
export function createAutoCatalogEvidence(input: {
	fetchedAt: number;
	expiresAt: number;
	accountId: string;
	provider: QualityProvider;
	source: "live" | "cached" | "shared" | "fallback";
	borrowedFrom?: string;
	models: readonly AutoCatalogModel[];
}): AutoCatalogEvidence | null {
	if (
		!isAutoCatalogEvidenceCurrent(input) ||
		!input.accountId ||
		input.borrowedFrom ||
		(input.source !== "live" && input.source !== "cached")
	)
		return null;
	const seen = new Set<string>();
	const models: AutoCatalogModel[] = [];
	for (const model of input.models) {
		if (!model.id || seen.has(model.id)) return null;
		seen.add(model.id);
		models.push(
			Object.freeze({
				id: model.id,
				...(model.capabilities
					? {
							capabilities: evidenceValue(
								model.capabilities,
							) as unknown as AutoModelCapabilities,
						}
					: {}),
			}),
		);
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return Object.freeze({
		fetchedAt: input.fetchedAt,
		expiresAt: input.expiresAt,
		accountId: input.accountId,
		provider: input.provider,
		source: "provider-catalog",
		models: Object.freeze(models),
		revision: `quality-catalog-v1:${revision([input.accountId, input.provider, models])}`,
	});
}

/** Materialize an exact healthy home independently from the newest supported
 * target. This never changes a home, grants a lane, or dispatches a request.
 */
export function resolveAutoModelTargets(
	catalog: AutoCatalogEvidence | null,
	line: QualityApprovedLine,
	storedModel?: string,
): Readonly<{
	current: AutoModelTargetEvidence | null;
	stored: AutoModelTargetEvidence | null;
}> {
	const support = SUPPORTED_IDENTITIES[line];
	if (
		!catalog ||
		!isAutoCatalogEvidenceCurrent(catalog) ||
		support.provider !== catalog.provider
	)
		return Object.freeze({ current: null, stored: null });
	const target = (id: string | undefined): AutoModelTargetEvidence | null => {
		if (!id || !support.models.includes(id)) return null;
		const model = catalog.models.find((entry) => entry.id === id);
		if (!model) return null;
		return Object.freeze({
			accountId: catalog.accountId,
			provider: catalog.provider,
			line,
			physicalModel: id,
			catalogRevision: catalog.revision,
			capabilityRevision: model.capabilities?.revision ?? null,
			evidenceRef: `${catalog.revision}/${id}/${model.capabilities?.revision ?? "unknown"}`,
			capabilities: model.capabilities ?? null,
		});
	};
	const currentId = [...support.models]
		.reverse()
		.find((id) => catalog.models.some((model) => model.id === id));
	return Object.freeze({
		current: target(currentId),
		stored: target(storedModel),
	});
}

export function positiveSafeCapacity(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}

// Canonical key order gives stable content revisions, and copies/freezes every
// retained value so mutating a transport response cannot alter frozen evidence.
function evidenceValue(value: unknown, depth = 0): EvidenceValue {
	if (depth > 12) return null;
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value))
		return Object.freeze(value.map((item) => evidenceValue(item, depth + 1)));
	if (value && typeof value === "object") {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, item]) => [key, evidenceValue(item, depth + 1)]),
			),
		);
	}
	return null;
}

function revision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeAutoModelCapabilities(
	provider: QualityProvider,
	raw: Readonly<Record<string, unknown>>,
): AutoModelCapabilities {
	const percent = raw.effective_context_window_percent;
	const modalities = raw.input_modalities;
	const inputModalities = new Set<string>(
		Array.isArray(modalities) &&
			modalities.every(
				(item) =>
					typeof item === "string" &&
					["text", "image", "audio", "video", "pdf"].includes(item),
			)
			? modalities
			: [],
	);
	const nativeCapabilities =
		provider === "anthropic" ? evidenceValue(raw.capabilities) : null;
	if (provider === "anthropic") {
		// Reviewed exact IDs share the documented text baseline; never infer by prefix.
		// https://platform.claude.com/docs/en/about-claude/models/overview.md
		if (
			Object.values(SUPPORTED_IDENTITIES).some(
				(support) =>
					support.provider === provider &&
					typeof raw.id === "string" &&
					support.models.includes(raw.id),
			)
		)
			inputModalities.add("text");
		if (
			nativeCapabilities &&
			typeof nativeCapabilities === "object" &&
			!Array.isArray(nativeCapabilities)
		) {
			for (const [key, modality] of [
				["image_input", "image"],
				["pdf_input", "pdf"],
			] as const) {
				const capability = (
					nativeCapabilities as Record<string, EvidenceValue>
				)[key];
				if (
					!capability ||
					typeof capability !== "object" ||
					Array.isArray(capability)
				)
					continue;
				const supported = (capability as Record<string, EvidenceValue>)
					.supported;
				if (supported === true) inputModalities.add(modality);
				else if (supported === false) inputModalities.delete(modality);
			}
		}
	}
	const toolEvidence: Record<string, EvidenceValue> = {};
	for (const key of [
		"tool_mode",
		"supports_search_tool",
		"web_search_tool_type",
		"experimental_supported_tools",
		"supports_image_detail_original",
	]) {
		if (Object.hasOwn(raw, key)) toolEvidence[key] = evidenceValue(raw[key]);
	}
	const facts = {
		contextWindow: positiveSafeCapacity(
			provider === "codex" ? raw.context_window : raw.max_input_tokens,
		),
		maxContextWindow: positiveSafeCapacity(
			provider === "codex" ? raw.max_context_window : raw.max_input_tokens,
		),
		effectiveContextPercent:
			provider === "codex" &&
			typeof percent === "number" &&
			Number.isFinite(percent) &&
			percent > 0 &&
			percent <= 100
				? percent
				: null,
		maxOutputTokens: positiveSafeCapacity(
			provider === "codex" ? raw.max_output_tokens : raw.max_tokens,
		),
		providerManagedOutput:
			provider === "codex" &&
			(!Object.hasOwn(raw, "max_output_tokens") ||
				raw.max_output_tokens === null),
		inputModalities: inputModalities.size
			? Object.freeze([...inputModalities])
			: null,
		toolEvidence: Object.freeze(toolEvidence),
		nativeCapabilities,
	};
	if (
		facts.contextWindow !== null &&
		facts.maxContextWindow !== null &&
		facts.contextWindow > facts.maxContextWindow
	) {
		facts.contextWindow = null;
		facts.maxContextWindow = null;
	}
	return Object.freeze({
		...facts,
		revision: `quality-capability-v1:${revision([provider, facts])}`,
	});
}
