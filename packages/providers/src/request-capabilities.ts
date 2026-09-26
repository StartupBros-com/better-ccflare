import { getConfiguredModelMapping } from "@better-ccflare/core";
import type {
	Account,
	ComboRouteClass,
	LogicalModelCapability,
} from "@better-ccflare/types";
import { PROVIDER_NAMES } from "@better-ccflare/types";
import { getCapabilityProvider } from "./registry";

const OAUTH_SUBSCRIPTION_PROVIDERS = new Set<string>([
	PROVIDER_NAMES.ANTHROPIC,
	PROVIDER_NAMES.CODEX,
	PROVIDER_NAMES.QWEN,
	PROVIDER_NAMES.XAI,
]);
const API_KEY_PROVIDERS = new Set<string>([
	PROVIDER_NAMES.CLAUDE_CONSOLE_API,
	PROVIDER_NAMES.ZAI,
	PROVIDER_NAMES.MINIMAX,
	PROVIDER_NAMES.ANTHROPIC_COMPATIBLE,
	PROVIDER_NAMES.OPENAI_COMPATIBLE,
	PROVIDER_NAMES.NANOGPT,
	PROVIDER_NAMES.KILO,
	PROVIDER_NAMES.OPENROUTER,
	PROVIDER_NAMES.ALIBABA_CODING_PLAN,
	PROVIDER_NAMES.OLLAMA_CLOUD,
	PROVIDER_NAMES.META,
]);
const CUSTOM_BILLING_PROVIDERS = new Set<string>([
	PROVIDER_NAMES.ANTHROPIC_COMPATIBLE,
	PROVIDER_NAMES.OPENAI_COMPATIBLE,
]);
const LOCAL_PROVIDERS = new Set<string>([PROVIDER_NAMES.OLLAMA]);
const CLOUD_CREDENTIAL_PROVIDERS = new Set<string>([
	PROVIDER_NAMES.BEDROCK,
	PROVIDER_NAMES.VERTEX_AI,
]);

/** Derive the durable, non-secret enrollment boundary for an account. */
export function deriveComboRouteClass(
	account: Pick<
		Account,
		"provider" | "billing_type" | "api_key" | "refresh_token" | "access_token"
	>,
): ComboRouteClass | null {
	if (LOCAL_PROVIDERS.has(account.provider)) return "local";
	if (CLOUD_CREDENTIAL_PROVIDERS.has(account.provider)) {
		return "cloud-credential";
	}

	const isOAuthProvider = OAUTH_SUBSCRIPTION_PROVIDERS.has(account.provider);
	const isApiKeyProvider = API_KEY_PROVIDERS.has(account.provider);
	if (!isOAuthProvider && !isApiKeyProvider) return null;

	const billingType = account.billing_type?.trim().toLowerCase() || null;
	if (billingType !== null && billingType !== "plan" && billingType !== "api") {
		return null;
	}

	// Secrets never participate in a selector. Their presence is reduced to a
	// boolean auth shape so contradictory persisted records can fail closed.
	const hasApiKey = Boolean(account.api_key?.trim());
	const hasOAuthCredential = Boolean(
		account.refresh_token?.trim() || account.access_token?.trim(),
	);
	// Older direct-create HTTP handlers mirrored one API key byte-for-byte into
	// all three credential columns. Treat only that exact, provider-appropriate
	// storage shape as a single API-key credential; any partial or differing
	// mixture remains contradictory and fails closed.
	const hasLegacyMirroredApiKey =
		isApiKeyProvider &&
		hasApiKey &&
		Boolean(account.refresh_token) &&
		Boolean(account.access_token) &&
		account.refresh_token === account.api_key &&
		account.access_token === account.api_key;
	const hasEffectiveOAuthCredential =
		hasOAuthCredential && !hasLegacyMirroredApiKey;
	if (hasApiKey && hasEffectiveOAuthCredential) return null;

	if (isOAuthProvider) {
		if (billingType === "api" || hasApiKey) return null;
		return "oauth-subscription";
	}

	if (hasEffectiveOAuthCredential) return null;
	if (CUSTOM_BILLING_PROVIDERS.has(account.provider)) {
		return billingType === "plan" ? "oauth-subscription" : "api-key";
	}
	if (billingType === "plan") return null;
	return "api-key";
}

/**
 * Build a non-secret account shape for draft route-class validation. Credential
 * transport and billing class are distinct: compatible-provider plan accounts
 * still use an API key even though their enrollment route is subscription.
 */
export function createComboRouteClassDraftProbe(input: {
	provider: string;
	routeClass: ComboRouteClass;
	billingType: "plan" | "api" | null;
}): Pick<
	Account,
	"provider" | "billing_type" | "api_key" | "refresh_token" | "access_token"
> | null {
	const marker = "present-for-route-shape-validation";
	let apiKey: string | null = null;
	let refreshToken = "";

	switch (input.routeClass) {
		case "oauth-subscription":
			if (OAUTH_SUBSCRIPTION_PROVIDERS.has(input.provider)) {
				refreshToken = marker;
			} else if (CUSTOM_BILLING_PROVIDERS.has(input.provider)) {
				apiKey = marker;
			} else {
				return null;
			}
			break;
		case "api-key":
			if (!API_KEY_PROVIDERS.has(input.provider)) return null;
			apiKey = marker;
			break;
		case "local":
			if (!LOCAL_PROVIDERS.has(input.provider)) return null;
			break;
		case "cloud-credential":
			if (!CLOUD_CREDENTIAL_PROVIDERS.has(input.provider)) return null;
			break;
	}

	const probe = {
		provider: input.provider,
		billing_type: input.billingType,
		api_key: apiKey,
		refresh_token: refreshToken,
		access_token: null,
	};
	return deriveComboRouteClass(probe) === input.routeClass ? probe : null;
}

const UNKNOWN_LOGICAL_MODEL_CAPABILITY: LogicalModelCapability = {
	status: "unknown",
	provenance: "undeclared",
	reason: "unknown",
};

/**
 * Resolve managed-routing model support without provider I/O. The transport
 * provider must exist before account mappings are trusted, so unknown provider
 * strings fail closed even when they carry mapping-shaped data.
 */
export function resolveAccountLogicalModelCapability(
	account: Account,
	logicalModel: string,
	capabilityProviderLookup: typeof getCapabilityProvider = getCapabilityProvider,
): LogicalModelCapability {
	const provider = capabilityProviderLookup(account.provider);
	if (!provider) return UNKNOWN_LOGICAL_MODEL_CAPABILITY;

	const configured = getConfiguredModelMapping(logicalModel, account);
	if (configured) {
		return configured.models.some(
			(model) => typeof model === "string" && model.trim().length > 0,
		)
			? {
					status: "supported",
					provenance: "explicit_account_mapping",
					reason: "included",
				}
			: UNKNOWN_LOGICAL_MODEL_CAPABILITY;
	}

	return (
		provider.getLogicalModelCapability?.(logicalModel, account) ??
		UNKNOWN_LOGICAL_MODEL_CAPABILITY
	);
}

export interface ModelContextCapability {
	provider: string;
	model: string;
	family: string;
	/** Catalog default/recommended window (`context_window`). Informational. */
	defaultContextWindow: number;
	/** Catalog maximum window (`max_context_window`): the operational client capacity. */
	maxContextWindow: number;
	/**
	 * Compatibility projection of {@link maxContextWindow}. Historically this
	 * held a single number that conflated catalog default with capacity; it now
	 * always equals the max, because every operational consumer (admission,
	 * response context-window telemetry, trace utilization) needs capacity, not
	 * the recommendation.
	 */
	rawContextWindow: number;
	effectiveContextWindow: number;
	effectiveContextPercent: number;
	match: "exact" | "prefix";
}

interface ModelContextMetadata {
	defaultContextWindow: number;
	maxContextWindow: number;
	effectiveContextPercent: number;
}

/** Account-local catalog projection, replaced as a single successful generation. */
const codexCatalogContextByAccount = new Map<
	string,
	ReadonlyMap<string, ModelContextMetadata | null>
>();

/** A captured generation: subsequent publications cannot change an in-flight attempt. */
export type CodexModelContextSnapshot = ReadonlyMap<
	string,
	ModelContextMetadata | null
> | null;

export function captureCodexModelContextSnapshot(
	accountId: string,
): CodexModelContextSnapshot {
	return codexCatalogContextByAccount.get(accountId) ?? null;
}

export interface CodexModelReasoningMetadata {
	supportedEfforts: readonly (
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
	)[];
	defaultEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
const codexReasoningByAccount = new Map<
	string,
	ReadonlyMap<string, CodexModelReasoningMetadata>
>();
export function captureCodexModelReasoningSnapshot(
	accountId: string,
): ReadonlyMap<string, CodexModelReasoningMetadata> | null {
	return codexReasoningByAccount.get(accountId) ?? null;
}

export function setCodexAccountModelContextMetadata(
	accountId: string,
	models: readonly {
		id: string;
		contextWindow: number | null;
		maxContextWindow: number | null;
		effectiveContextPercent: number | null;
		supportedReasoningEfforts?: readonly string[];
		defaultReasoningEffort?: string | null;
	}[],
): void {
	const entries = new Map<string, ModelContextMetadata | null>();
	const reasoning = new Map<string, CodexModelReasoningMetadata>();
	const validEfforts = new Set([
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	const window = (n: number | null): n is number =>
		typeof n === "number" && Number.isSafeInteger(n) && n > 0;
	for (const model of models.slice(0, 1000)) {
		const supported = model.supportedReasoningEfforts;
		if (
			Array.isArray(supported) &&
			supported.length > 0 &&
			supported.length <= 6 &&
			supported.every((effort) => validEfforts.has(effort))
		) {
			const levels = [
				...new Set(supported),
			] as CodexModelReasoningMetadata["supportedEfforts"];
			const defaultEffort = model.defaultReasoningEffort;
			reasoning.set(model.id, {
				supportedEfforts: levels,
				...(defaultEffort &&
				levels.includes(defaultEffort as (typeof levels)[number])
					? { defaultEffort: defaultEffort as (typeof levels)[number] }
					: {}),
			});
		}
		const recommended = model.contextWindow;
		const max = model.maxContextWindow;
		const percent = model.effectiveContextPercent;
		entries.set(
			model.id,
			window(recommended) &&
				window(max) &&
				recommended <= max &&
				typeof percent === "number" &&
				Number.isFinite(percent) &&
				percent > 0 &&
				percent <= 100
				? {
						defaultContextWindow: recommended,
						maxContextWindow: max,
						effectiveContextPercent: percent,
					}
				: null,
		);
	}
	codexCatalogContextByAccount.set(accountId, entries);
	codexReasoningByAccount.set(accountId, reasoning);
}

export function clearCodexAccountModelContextMetadata(
	accountId?: string,
): void {
	if (accountId === undefined) {
		codexCatalogContextByAccount.clear();
		codexReasoningByAccount.clear();
	} else {
		codexCatalogContextByAccount.delete(accountId);
		codexReasoningByAccount.delete(accountId);
	}
}

// Synced from the Codex CLI model cache (~/.codex/models_cache.json,
// codex-cli 0.147.0). This is the single source for Codex context capability.
// The catalog distinguishes `context_window` (default/recommended) from
// `max_context_window` (capacity a client may opt into): gpt-5.5,
// gpt-5.4-mini, and gpt-5.3-codex-spark are published single-window
// (default === max); gpt-5.6-* carries 872k max and gpt-5.4 carries 1M max.
// gpt-5.3-codex is a legacy entry absent from the current catalog, retained
// with its historical value. A catalog max is the catalog's stated capacity,
// not an independently proven upstream hard limit — but production has
// accepted cache-inclusive prompts of 799,652 (gpt-5.6-terra) and 565,703
// (gpt-5.6-sol) tokens, so the previous invented 372k value was provably
// below real capacity and caused clients to fail large tool-result turns
// locally before any request was sent (issue #205).
const CODEX_MODEL_CONTEXT_METADATA: Readonly<
	Record<string, ModelContextMetadata>
> = {
	"gpt-5.3-codex": {
		defaultContextWindow: 272_000,
		maxContextWindow: 272_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.3-codex-spark": {
		defaultContextWindow: 128_000,
		maxContextWindow: 128_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.4": {
		defaultContextWindow: 272_000,
		maxContextWindow: 1_000_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.4-mini": {
		defaultContextWindow: 272_000,
		maxContextWindow: 272_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.5": {
		defaultContextWindow: 272_000,
		maxContextWindow: 272_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.6-sol": {
		defaultContextWindow: 272_000,
		maxContextWindow: 872_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.6-terra": {
		defaultContextWindow: 272_000,
		maxContextWindow: 872_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.6-luna": {
		defaultContextWindow: 272_000,
		maxContextWindow: 872_000,
		effectiveContextPercent: 95,
	},
};

export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> =
	Object.fromEntries(
		Object.entries(CODEX_MODEL_CONTEXT_METADATA).map(([model, metadata]) => [
			model,
			metadata.maxContextWindow,
		]),
	);

export function resolveModelContextCapability(
	provider: string,
	model: string,
	accountId?: string,
	snapshot?: CodexModelContextSnapshot,
): ModelContextCapability | undefined {
	if (provider.toLowerCase() !== "codex" || typeof model !== "string") {
		return undefined;
	}
	const catalog =
		snapshot !== undefined
			? snapshot
			: accountId
				? codexCatalogContextByAccount.get(accountId)
				: undefined;
	// A listed model with malformed/missing scalars must not inherit an old
	// generation's static ceiling via a coincidental family prefix.
	if (catalog?.has(model) && !catalog.get(model)) return undefined;
	const exact = catalog?.get(model) ?? CODEX_MODEL_CONTEXT_METADATA[model];
	let family = model;
	let metadata = exact;
	let match: ModelContextCapability["match"] = "exact";
	if (!metadata) {
		family =
			Object.keys(CODEX_MODEL_CONTEXT_METADATA)
				.filter((key) => model.startsWith(`${key}-`))
				.sort((a, b) => b.length - a.length)[0] ?? "";
		metadata = CODEX_MODEL_CONTEXT_METADATA[family];
		match = "prefix";
	}
	if (!metadata) return undefined;

	return {
		provider: "codex",
		model,
		family,
		defaultContextWindow: metadata.defaultContextWindow,
		maxContextWindow: metadata.maxContextWindow,
		rawContextWindow: metadata.maxContextWindow,
		effectiveContextWindow: Math.floor(
			(metadata.maxContextWindow * metadata.effectiveContextPercent) / 100,
		),
		effectiveContextPercent: metadata.effectiveContextPercent,
		match,
	};
}

export interface AnthropicRequestTokenEstimate {
	tokens: number;
	method: "prompt-material-chars" | "request-envelope-bytes";
	confidence: "low";
}

function appendPromptContent(chunks: string[], value: unknown): void {
	if (typeof value === "string") {
		chunks.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) appendPromptContent(chunks, item);
		return;
	}
	if (!value || typeof value !== "object") return;

	const record = value as Record<string, unknown>;
	const before = chunks.length;
	if (typeof record.text === "string") chunks.push(record.text);
	if (typeof record.name === "string") chunks.push(record.name);
	if (typeof record.description === "string") chunks.push(record.description);
	if ("input" in record) appendPromptContent(chunks, record.input);
	if ("content" in record) appendPromptContent(chunks, record.content);
	if ("input_schema" in record)
		appendPromptContent(chunks, record.input_schema);
	if ("parameters" in record) appendPromptContent(chunks, record.parameters);
	if (Object.keys(record).length > 0 && chunks.length === before) {
		try {
			chunks.push(JSON.stringify(record));
		} catch {
			// The request-level fallback handles values that cannot be serialized.
		}
	}
}

function extractAnthropicPromptMaterial(body: unknown): string[] {
	if (!body || typeof body !== "object") return [];
	const request = body as Record<string, unknown>;
	const chunks: string[] = [];
	appendPromptContent(chunks, request.system);
	if (Array.isArray(request.messages)) {
		for (const message of request.messages) {
			if (!message || typeof message !== "object") continue;
			const record = message as Record<string, unknown>;
			if (typeof record.role === "string") chunks.push(record.role);
			appendPromptContent(chunks, record.content);
		}
	}
	if (Array.isArray(request.tools)) {
		for (const tool of request.tools) appendPromptContent(chunks, tool);
	}
	return chunks;
}

export function estimateAnthropicRequestTokens(
	body: unknown,
): AnthropicRequestTokenEstimate {
	let serialized = extractAnthropicPromptMaterial(body).join("\n");
	if (serialized.length === 0) {
		try {
			serialized = JSON.stringify(body) ?? "";
		} catch {
			serialized = String(body ?? "");
		}
	}
	return {
		tokens: Math.max(1, Math.ceil(serialized.length / 3)),
		method: "prompt-material-chars",
		confidence: "low",
	};
}

/**
 * Detect an Anthropic custom tool declaration that requests deferred loading.
 * Server tools are typed; ordinary client functions omit `type` and carry a
 * name plus input schema, matching the server-tool classifier's distinction.
 */
export function hasDeferredCustomTool(body: unknown): boolean {
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	const tools = (body as Record<string, unknown>).tools;
	if (!Array.isArray(tools)) return false;

	return tools.some((tool) => {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
		const declaration = tool as Record<string, unknown>;
		return (
			declaration.type === undefined &&
			typeof declaration.name === "string" &&
			declaration.input_schema !== null &&
			typeof declaration.input_schema === "object" &&
			!Array.isArray(declaration.input_schema) &&
			declaration.defer_loading === true
		);
	});
}

export function estimateAnthropicAdmissionTokens(
	body: unknown,
): AnthropicRequestTokenEstimate {
	let serialized: string;
	try {
		serialized = JSON.stringify(body) ?? "";
	} catch {
		serialized = String(body ?? "");
	}

	const byteLength = new TextEncoder().encode(serialized).byteLength;
	// Admission is safety-critical, unlike the advisory count endpoint. Counting
	// the complete JSON envelope captures roles, block types, schemas, and framing.
	// The bytes/2 floor is deliberately conservative for Unicode and code-heavy
	// payloads while avoiding the severe inflation of treating every byte as a token.
	return {
		tokens: Math.max(
			1,
			Math.ceil(serialized.length / 3),
			Math.ceil(byteLength / 2),
		),
		method: "request-envelope-bytes",
		confidence: "low",
	};
}

export interface ContextAdmissionInput {
	inputTokens: unknown;
	effectiveContextWindow: unknown;
	requestedMaxOutputTokens: unknown;
	safetyReserveTokens: unknown;
}

export interface ContextAdmissionDecision {
	status: "admit" | "reject" | "unknown";
	inputTokens: number;
	outputReserveTokens: number;
	safetyReserveTokens: number;
	occupiedTokens: number;
	safeLimitTokens?: number;
	effectiveContextWindow?: number;
}

function clampTokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0;
}

export function decideContextAdmission(
	input: ContextAdmissionInput,
): ContextAdmissionDecision {
	const inputTokens = clampTokenCount(input.inputTokens);
	const outputReserveTokens = clampTokenCount(input.requestedMaxOutputTokens);
	const safetyReserveTokens = clampTokenCount(input.safetyReserveTokens);
	const occupiedTokens = inputTokens + outputReserveTokens;
	if (
		typeof input.effectiveContextWindow !== "number" ||
		!Number.isFinite(input.effectiveContextWindow) ||
		input.effectiveContextWindow <= 0
	) {
		return {
			status: "unknown",
			inputTokens,
			outputReserveTokens,
			safetyReserveTokens,
			occupiedTokens,
		};
	}

	const effectiveContextWindow = Math.floor(input.effectiveContextWindow);
	const safeLimitTokens = Math.max(
		0,
		effectiveContextWindow - safetyReserveTokens,
	);
	return {
		status: occupiedTokens > safeLimitTokens ? "reject" : "admit",
		inputTokens,
		outputReserveTokens,
		safetyReserveTokens,
		occupiedTokens,
		safeLimitTokens,
		effectiveContextWindow,
	};
}
