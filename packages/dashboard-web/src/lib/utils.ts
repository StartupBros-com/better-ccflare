import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Canonical short "Xh Ym" / "Ym" duration label. Negative spans clamp to
 * "0m". The single shared implementation for usage-pace cards,
 * RateLimitProgress rows, and PoolMetricCard tiles — do not re-declare
 * per-component copies (review finding on PR #130).
 */
export function formatShortDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}
