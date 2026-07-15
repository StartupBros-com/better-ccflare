export interface ModelContextCapability {
	provider: string;
	model: string;
	family: string;
	rawContextWindow: number;
	effectiveContextWindow: number;
	effectiveContextPercent: number;
	match: "exact" | "prefix";
}

interface ModelContextMetadata {
	rawContextWindow: number;
	effectiveContextPercent: number;
}

// Synced from the Codex CLI model cache (~/.codex/models_cache.json,
// codex-cli 0.144.1). This is the single source for Codex context capability.
const CODEX_MODEL_CONTEXT_METADATA: Readonly<
	Record<string, ModelContextMetadata>
> = {
	"gpt-5.3-codex": { rawContextWindow: 272_000, effectiveContextPercent: 95 },
	"gpt-5.3-codex-spark": {
		rawContextWindow: 128_000,
		effectiveContextPercent: 95,
	},
	"gpt-5.4": { rawContextWindow: 272_000, effectiveContextPercent: 95 },
	"gpt-5.4-mini": { rawContextWindow: 272_000, effectiveContextPercent: 95 },
	"gpt-5.5": { rawContextWindow: 272_000, effectiveContextPercent: 95 },
	"gpt-5.6-sol": { rawContextWindow: 372_000, effectiveContextPercent: 95 },
	"gpt-5.6-terra": { rawContextWindow: 372_000, effectiveContextPercent: 95 },
	"gpt-5.6-luna": { rawContextWindow: 372_000, effectiveContextPercent: 95 },
};

export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> =
	Object.fromEntries(
		Object.entries(CODEX_MODEL_CONTEXT_METADATA).map(([model, metadata]) => [
			model,
			metadata.rawContextWindow,
		]),
	);

export function resolveModelContextCapability(
	provider: string,
	model: string,
): ModelContextCapability | undefined {
	if (provider.toLowerCase() !== "codex" || typeof model !== "string") {
		return undefined;
	}
	const exact = CODEX_MODEL_CONTEXT_METADATA[model];
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
		rawContextWindow: metadata.rawContextWindow,
		effectiveContextWindow: Math.floor(
			(metadata.rawContextWindow * metadata.effectiveContextPercent) / 100,
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
