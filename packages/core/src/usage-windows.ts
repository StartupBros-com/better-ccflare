import type { CanonicalUsageWindow } from "@better-ccflare/types";
import { getModelFamily, weeklyScopedWindowKey } from "./model-mappings";

type UsageRecord = Record<string, unknown>;

function asRecord(value: unknown): UsageRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UsageRecord)
		: null;
}

/**
 * Coerce a provider's utilization onto the canonical 0-100 scale.
 *
 * A value above 100 is NOT malformed — it is an account past its limit, and
 * several providers report it. NanoGPT's fetcher documents it explicitly
 * ("Can exceed 100% if daily limit is overridden by user"). Rejecting it would
 * drop the window from both usage history and alert evaluation, suppressing the
 * exhaustion alert precisely while the account is exhausted, so overage
 * saturates at 100 instead.
 *
 * Negative and non-finite values are still rejected: those are malformed
 * readings, and coercing them to 0% would invent capacity that does not exist.
 */
function finitePercent(value: unknown, scale = 1): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const percent = value * scale;
	if (!Number.isFinite(percent) || percent < 0) return null;
	return Math.min(percent, 100);
}

function resetMs(
	value: unknown,
): { valid: true; value: number | null } | { valid: false } {
	if (value === null || value === undefined) {
		return { valid: true, value: null };
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? { valid: true, value } : { valid: false };
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed)
			? { valid: true, value: parsed }
			: { valid: false };
	}
	return { valid: false };
}

function scopeForKey(
	windowKey: string,
): Pick<CanonicalUsageWindow, "scope" | "modelFamily"> {
	if (!windowKey.startsWith("seven_day_")) {
		return { scope: "account", modelFamily: null };
	}
	const modelFamily = getModelFamily(windowKey.slice("seven_day_".length));
	return modelFamily
		? { scope: "family", modelFamily }
		: { scope: "other", modelFamily: null };
}

function makeWindow(
	windowKey: string,
	utilization: unknown,
	reset: unknown,
	scale = 1,
	active = true,
): CanonicalUsageWindow | null {
	const percent = finitePercent(utilization, scale);
	if (percent === null) return null;
	const parsedReset = resetMs(reset);
	if (!parsedReset.valid) return null;
	const identity = scopeForKey(windowKey);
	return {
		windowKey,
		utilization: percent,
		resetsAtMs: parsedReset.value,
		...identity,
		active,
	};
}

export interface AutoCapacityEvidence {
	readonly source: "limits" | "flat";
	readonly window: string;
	readonly scope: "account" | "family" | "model" | "unknown";
	readonly model: string | null;
	readonly active: boolean | null;
	readonly utilization: number | null;
	readonly resetsAtMs: number | null;
	/** Only Anthropic scoped allowance semantics are established here. */
	readonly semantics: "included-allowance" | "provider-limit";
}

/** Auto-only projection. History and manual throttling retain their contracts.
 * Keep duplicate and invalid rows: omission must not manufacture capacity.
 * Generic presence, not validity, suppresses a legacy mirror.
 */
export function collectAutoCapacityEvidence(
	usage: unknown,
	provider: string,
): readonly AutoCapacityEvidence[] {
	const data = asRecord(usage);
	if (!data || (provider !== "anthropic" && provider !== "codex")) return [];
	const rows: AutoCapacityEvidence[] = [];
	const mirrored = new Set<string>();
	const add = (
		source: "limits" | "flat",
		window: string,
		scope: AutoCapacityEvidence["scope"],
		model: string | null,
		row: UsageRecord,
		percent: unknown,
		reset: unknown,
	) => {
		const parsed = resetMs(reset);
		rows.push(
			Object.freeze({
				source,
				window,
				scope,
				model,
				active:
					row.is_active === undefined
						? true
						: typeof row.is_active === "boolean"
							? row.is_active
							: null,
				utilization: finitePercent(percent),
				resetsAtMs: parsed.valid ? parsed.value : null,
				semantics:
					provider === "anthropic" && scope !== "account" && scope !== "unknown"
						? "included-allowance"
						: "provider-limit",
			}),
		);
	};
	if (Array.isArray(data.limits)) {
		for (const value of data.limits) {
			const row = asRecord(value);
			if (!row) {
				add("limits", "unknown", "unknown", null, {}, null, null);
				continue;
			}
			if (row.kind === "session" || row.kind === "weekly_all") {
				const key = row.kind === "session" ? "five_hour" : "seven_day";
				mirrored.add(key);
				add("limits", key, "account", null, row, row.percent, row.resets_at);
			} else if (row.kind === "weekly_scoped") {
				const model = asRecord(asRecord(row.scope)?.model);
				const id =
					typeof model?.id === "string" && model.id.trim()
						? model.id.trim()
						: null;
				const name =
					typeof model?.display_name === "string"
						? model.display_name.trim()
						: null;
				// A concrete ID is never widened into a whole-family restriction.
				const identity = id || name;
				const family = identity ? getModelFamily(identity) : null;
				const exact = id !== null && id !== family;
				const key = identity
					? weeklyScopedWindowKey(identity)
					: "seven_day_unknown";
				mirrored.add(key);
				if (name) mirrored.add(weeklyScopedWindowKey(name));
				add(
					"limits",
					key,
					exact ? "model" : family ? "family" : "unknown",
					exact ? id : family,
					row,
					row.percent,
					row.resets_at,
				);
			} else {
				add(
					"limits",
					"unknown",
					"unknown",
					null,
					row,
					row.percent,
					row.resets_at,
				);
			}
		}
	}
	for (const [key, value] of Object.entries(data)) {
		if (
			mirrored.has(key) ||
			(key !== "five_hour" &&
				key !== "seven_day" &&
				!key.startsWith("seven_day_"))
		)
			continue;
		const row = asRecord(value);
		if (!row) continue;
		const identity = scopeForKey(key);
		add(
			"flat",
			key,
			identity.scope === "other" ? "unknown" : identity.scope,
			identity.modelFamily,
			row,
			row.utilization,
			row.resets_at,
		);
	}
	return Object.freeze(rows);
}

/** Normalize one provider payload into the shared, persistence-safe window shape. */
export function normalizeProviderUsageWindows(
	usage: unknown,
	provider: string,
): CanonicalUsageWindow[] {
	const data = asRecord(usage);
	if (!data) return [];

	const out: CanonicalUsageWindow[] = [];
	const seen = new Set<string>();
	const add = (window: CanonicalUsageWindow | null): void => {
		if (!window || seen.has(window.windowKey)) return;
		seen.add(window.windowKey);
		out.push(window);
	};

	if (provider === "nanogpt") {
		if (data.active === false) return [];
		for (const key of ["daily", "monthly"]) {
			const window = asRecord(data[key]);
			add(window && makeWindow(key, window.percentUsed, window.resetAt, 100));
		}
		return out;
	}
	if (provider === "alibaba-coding-plan") {
		for (const key of ["five_hour", "weekly", "monthly"]) {
			const window = asRecord(data[key]);
			add(window && makeWindow(key, window.percentUsed, window.resetAt));
		}
		return out;
	}
	if (provider === "kilo") {
		// Kilo has a credits balance, not a usage cycle. Keep the snapshot for
		// history, but its null reset means cycle alerts will ignore it.
		add(makeWindow("credits", data.utilizationPercent, null));
		return out;
	}
	if (provider === "zai") {
		for (const [key, windowKey] of [
			["tokens_limit", "five_hour"],
			["tokens_limit_weekly", "seven_day"],
			["time_limit", "time_limit"],
		] as const) {
			const window = asRecord(data[key]);
			add(window && makeWindow(windowKey, window.percentage, window.resetAt));
		}
		return out;
	}
	if (provider === "minimax") {
		for (const key of ["five_hour", "seven_day"]) {
			const window = asRecord(data[key]);
			add(window && makeWindow(key, window.utilization, window.resetAt));
		}
		return out;
	}
	if (provider === "xai") {
		const window = asRecord(data.credits);
		add(window && makeWindow("credits", window.utilization, window.resets_at));
		return out;
	}

	// Anthropic/Codex: flat windows are authoritative when present. Limits-only
	// payloads fill missing keys, and never create duplicate history points.
	for (const [windowKey, value] of Object.entries(data)) {
		if (windowKey === "limits") continue;
		if (
			windowKey !== "five_hour" &&
			windowKey !== "seven_day" &&
			!windowKey.startsWith("seven_day_")
		)
			continue;
		const window = asRecord(value);
		if (!window || !("utilization" in window)) continue;
		add(makeWindow(windowKey, window.utilization, window.resets_at));
	}
	const limits = data.limits;
	if (!Array.isArray(limits)) return out;
	for (const value of limits) {
		const limit = asRecord(value);
		if (!limit) continue;
		let windowKey: string | null = null;
		if (limit.kind === "session") windowKey = "five_hour";
		else if (limit.kind === "weekly_all") windowKey = "seven_day";
		else if (limit.kind === "weekly_scoped") {
			const scope = asRecord(limit.scope);
			const model = scope && asRecord(scope.model);
			const displayName = model?.display_name;
			if (typeof displayName === "string" && displayName.trim()) {
				windowKey = weeklyScopedWindowKey(displayName);
			}
		}
		if (!windowKey || seen.has(windowKey)) continue;
		add(
			makeWindow(
				windowKey,
				limit.percent,
				limit.resets_at,
				1,
				limit.is_active !== false,
			),
		);
	}
	return out;
}
