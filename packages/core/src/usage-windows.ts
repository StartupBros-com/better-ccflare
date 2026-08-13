import type { CanonicalUsageWindow } from "@better-ccflare/types";
import { getModelFamily, weeklyScopedWindowKey } from "./model-mappings";

type UsageRecord = Record<string, unknown>;

function asRecord(value: unknown): UsageRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UsageRecord)
		: null;
}

function finitePercent(value: unknown, scale = 1): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const percent = value * scale;
	return Number.isFinite(percent) && percent >= 0 && percent <= 100
		? percent
		: null;
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
