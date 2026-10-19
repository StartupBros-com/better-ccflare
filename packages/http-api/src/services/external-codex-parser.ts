// Counting and replay semantics ported from ryoppippi/ccusage@v20.0.19 (MIT).
// Service tiers affect the oracle's costs, not its token counts, and are omitted.
import autoReviewFallbacks from "./codex-auto-review-fallbacks.json";

export interface RawCodexUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
}
export interface ParsedCodexEvent extends RawCodexUsage {
	timestamp: string;
	eventTs: number;
	model: string;
	isFallbackModel: boolean;
	sessionId: string;
	rateLimitResetsAt: number | null;
	planType: string | null;
	limitId: string | null;
	creditsHasCredits: boolean | null;
	creditsBalance: string | null;
	primaryUsedPercent: number | null;
}
export interface ParsedCodexSession {
	sessionId: string;
	parentId: string | null;
	forked: boolean;
	sessionTimestamp: number | null;
	burstStart: number | null;
	events: ParsedCodexEvent[];
	malformedLines: number;
}
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: {};
const text = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value.trim() : null;
const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
const unsigned = (value: unknown): number | null => {
	if (typeof value === "string" && !/^\+?\d+$/.test(value.trim())) return null;
	if (typeof value !== "number" && typeof value !== "string") return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};
const keys = [
	"inputTokens",
	"cachedInputTokens",
	"outputTokens",
	"reasoningOutputTokens",
	"totalTokens",
] as const;
function rawUsage(value: unknown): RawCodexUsage | null {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	const v = object(value);
	const pick = (...names: string[]) =>
		names.map((n) => unsigned(v[n])).find((n) => n !== null) ?? 0;
	const inputTokens = pick("input_tokens", "prompt_tokens", "input");
	const outputTokens = pick("output_tokens", "completion_tokens", "output");
	return {
		inputTokens,
		outputTokens,
		cachedInputTokens: pick(
			"cached_input_tokens",
			"cache_read_input_tokens",
			"cached_tokens",
		),
		reasoningOutputTokens: pick("reasoning_output_tokens", "reasoning_tokens"),
		totalTokens: pick("total_tokens") || inputTokens + outputTokens,
	};
}
function timestamp(value: unknown, normalize = false): string | null {
	if (typeof value === "string") {
		const trimmed = text(value);
		if (!trimmed) return null;
		if (!normalize) return trimmed;
		const ms = Date.parse(trimmed);
		return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
	}
	const n = unsigned(value);
	if (n === null) return null;
	const ms = n > 10_000_000_000 ? n : n * 1000;
	return Number.isFinite(ms) && ms <= 8.64e15
		? new Date(ms).toISOString()
		: null;
}
function model(value: unknown): string | null {
	const v = object(value);
	return text(v.model) ?? text(v.model_name) ?? text(object(v.metadata).model);
}
function datePart(value: string): string | null {
	const date = value.slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const ms = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date
		? date
		: null;
}
function resultTimestamp(value: RecordValue, raw = false): string | null {
	for (const v of [
		value,
		object(value.data),
		object(value.result),
		object(value.response),
	]) {
		for (const field of ["timestamp", "created_at", "createdAt"]) {
			const candidate = v[field];
			const resolved =
				raw && typeof candidate === "string" && datePart(candidate.trim())
					? candidate.trim()
					: timestamp(candidate, true);
			if (resolved) return resolved;
		}
	}
	return null;
}
export async function parseCodexLines(
	lines: AsyncIterable<string> | Iterable<string>,
	options: { sessionId?: string; fallbackTimestamp?: string } = {},
): Promise<ParsedCodexSession> {
	const session: ParsedCodexSession = {
		sessionId: options.sessionId ?? "unknown",
		parentId: null,
		forked: false,
		sessionTimestamp: null,
		burstStart: null,
		events: [],
		malformedLines: 0,
	};
	let firstLine = true,
		previous: RawCodexUsage | null = null,
		currentModel: string | null = null,
		currentFallback = false;
	const burstTimes: number[] = [];
	for await (const line of lines) {
		let value: RecordValue;
		try {
			value = object(JSON.parse(line));
		} catch {
			if (line.trim()) session.malformedLines++;
			firstLine = false;
			continue;
		}
		const payload = object(value.payload);
		if (firstLine) {
			firstLine = false;
			const metadataMs = Date.parse(timestamp(value.timestamp, true) ?? "");
			session.sessionTimestamp = Number.isFinite(metadataMs)
				? metadataMs
				: null;
			if (value.type === "session_meta") {
				session.sessionId =
					typeof payload.id === "string" ? payload.id : session.sessionId;
				const parent =
					typeof payload.forked_from_id === "string"
						? payload.forked_from_id
						: object(object(object(payload.source).subagent).thread_spawn)
								.parent_thread_id;
				session.forked = typeof parent === "string" && parent !== "";
				session.parentId =
					typeof parent === "string" &&
					parent !== "" &&
					parent !== session.sessionId
						? parent
						: null;
			}
		}
		if (value.type === "turn_context") {
			const next = model(payload);
			if (next) {
				currentModel = next;
				currentFallback = false;
			}
			continue;
		}
		let raw: RawCodexUsage | null = null,
			stamp: string | null = null,
			modelStamp: string | null = null,
			parsedModel: string | null = null;
		if (value.type === "event_msg") {
			if (payload.type !== "token_count") continue;
			stamp = timestamp(value.timestamp);
			if (!stamp) continue;
			const info = object(payload.info),
				total = rawUsage(info.total_token_usage),
				last = rawUsage(info.last_token_usage);
			if (
				(last || total) &&
				burstTimes.length < 2 &&
				Number.isFinite(Date.parse(stamp))
			)
				burstTimes.push(Date.parse(stamp));
			const advanced =
				!total || !previous || keys.some((k) => total[k] !== previous?.[k]);
			raw =
				last && advanced
					? last
					: total
						? (Object.fromEntries(
								keys.map((k) => [
									k,
									Math.max(0, total[k] - (previous?.[k] ?? 0)),
								]),
							) as unknown as RawCodexUsage)
						: null;
			if (total) previous = total;
			if (!raw || keys.slice(0, 4).every((k) => raw?.[k] === 0)) continue;
			parsedModel = model(payload) ?? model(info);
		} else {
			// Equivalent to codex_line_usage_kind's headless usage branch. Session
			// messages with nested usage cannot become inference events accidentally.
			if (value.type === "session_meta") continue;
			for (const v of [
				value,
				object(value.data),
				object(value.result),
				object(value.response),
			]) {
				raw = rawUsage(v.usage);
				if (raw) break;
			}
			if (!raw || keys.every((k) => raw?.[k] === 0)) continue;
			stamp =
				resultTimestamp(value) ??
				options.fallbackTimestamp ??
				"1970-01-01T00:00:00.000Z";
			modelStamp =
				resultTimestamp(value, true) ?? options.fallbackTimestamp ?? stamp;
			for (const v of [
				value,
				object(value.data),
				object(value.result),
				object(value.response),
			]) {
				parsedModel = model(v);
				if (parsedModel) break;
			}
		}
		if (parsedModel) {
			currentModel = parsedModel;
			currentFallback = false;
		}
		if (!currentModel) {
			currentModel = "gpt-5";
			currentFallback = true;
		}
		let resolvedModel = currentModel,
			isFallbackModel = currentFallback;
		if (resolvedModel === "codex-auto-review") {
			const date = datePart(modelStamp ?? stamp);
			resolvedModel =
				(date
					? autoReviewFallbacks.find((f) => date >= f.releasedOn)?.model
					: null) ?? "gpt-5";
			isFallbackModel = true;
		}
		const limits = object(payload.rate_limits),
			primary = object(limits.primary),
			credits = object(limits.credits);
		session.events.push({
			...raw,
			cachedInputTokens: Math.min(raw.cachedInputTokens, raw.inputTokens),
			timestamp: stamp,
			// The oracle retains malformed nonempty timestamp strings. Keep their
			// counts and identity, but park them outside tracked subscription windows.
			eventTs: Number.isFinite(Date.parse(stamp)) ? Date.parse(stamp) : 0,
			model: resolvedModel,
			isFallbackModel,
			sessionId: session.sessionId,
			rateLimitResetsAt: num(primary.resets_at),
			planType: text(limits.plan_type),
			limitId: text(limits.limit_id),
			creditsHasCredits:
				typeof credits.has_credits === "boolean" ? credits.has_credits : null,
			creditsBalance:
				typeof credits.balance === "string" ? credits.balance : null,
			primaryUsedPercent: num(primary.used_percent),
		});
	}
	if (burstTimes.length === 2) {
		const [first, second] = burstTimes as [number, number];
		if (second - first >= 0 && second - first <= 1000)
			session.burstStart = first;
	}
	return session;
}
function sameUsage(a: RawCodexUsage, b: RawCodexUsage): boolean {
	return keys.every((k) => a[k] === b[k]);
}
export function suppressCodexReplay(
	session: ParsedCodexSession,
	parent?: ParsedCodexSession,
): ParsedCodexEvent[] {
	if (!session.forked) return session.events;
	const prefix =
		parent?.events.slice(
			0,
			parent.events.findIndex(
				(e) =>
					session.sessionTimestamp !== null &&
					e.eventTs > session.sessionTimestamp,
			) === -1
				? undefined
				: parent.events.findIndex(
						(e) =>
							session.sessionTimestamp !== null &&
							e.eventTs > session.sessionTimestamp,
					),
		) ?? [];
	let matched = 0;
	while (matched < session.events.length) {
		const childEvent = session.events[matched];
		const parentEvent = prefix[matched];
		if (!childEvent || !parentEvent || !sameUsage(childEvent, parentEvent))
			break;
		matched++;
	}
	if (matched > 0) return session.events.slice(matched);
	if (session.burstStart === null) return session.events;
	let previous = session.burstStart,
		index = 0;
	for (const event of session.events) {
		const delta = event.eventTs - previous;
		if (!Number.isFinite(delta) || delta < 0 || delta > 1000) break;
		previous = event.eventTs;
		index++;
	}
	return session.events.slice(index);
}
export function codexEventDedupeKey(event: ParsedCodexEvent): string {
	return JSON.stringify([
		event.timestamp,
		event.model,
		...keys.map((k) => event[k]),
	]);
}
