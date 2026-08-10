import { useEffect, useState } from "react";

const DEFAULT_ZERO_TEXT = "resetting…";

export interface LiveCountdownProps {
	/** Reset target: epoch milliseconds or an ISO-8601 string. */
	target: number | string;
	/** Appended after the ticking duration while time remains (e.g. " until refresh"). Dropped once expired. */
	suffix?: string;
	/** Rendered once the countdown reaches zero, in place of the duration + suffix. */
	zeroText?: string;
	className?: string;
}

/** Parse a countdown target into epoch milliseconds. Invalid input yields NaN. */
export function resolveCountdownTargetMs(target: number | string): number {
	return typeof target === "number" ? target : new Date(target).getTime();
}

/**
 * Format a remaining duration as "Xh Ym Zs", dropping empty leading units:
 * under an hour omits "Xh", under a minute shows seconds only. Non-positive
 * input renders "0s" -- callers that need the "expired" state (as opposed to
 * a literal zero-second countdown) use formatCountdownLabel, which owns that
 * distinction.
 */
export function formatCountdownDuration(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * Full label for a live countdown: the ticking duration + suffix while time
 * remains, or zeroText (suffix dropped) once expired or the target is
 * invalid/non-finite.
 */
export function formatCountdownLabel(
	remainingMs: number,
	suffix = "",
	zeroText: string = DEFAULT_ZERO_TEXT,
): string {
	if (!Number.isFinite(remainingMs) || remainingMs <= 0) return zeroText;
	return `${formatCountdownDuration(remainingMs)}${suffix}`;
}

/**
 * Self-ticking countdown to `target`, updating every second via its own
 * setInterval -- independent of the app's 30s registerUIRefresh tick used
 * elsewhere in the dashboard (RateLimitProgress's `now` state). State is
 * local only; nothing here triggers a parent re-render. Stops ticking once
 * it reaches zero.
 */
export function LiveCountdown({
	target,
	suffix = "",
	zeroText = DEFAULT_ZERO_TEXT,
	className,
}: LiveCountdownProps) {
	const targetMs = resolveCountdownTargetMs(target);
	const [remainingMs, setRemainingMs] = useState(() => targetMs - Date.now());

	useEffect(() => {
		setRemainingMs(targetMs - Date.now());
		if (!Number.isFinite(targetMs) || targetMs - Date.now() <= 0) {
			return;
		}
		const interval = setInterval(() => {
			const next = targetMs - Date.now();
			setRemainingMs(next);
			if (next <= 0) {
				clearInterval(interval);
			}
		}, 1000);
		return () => clearInterval(interval);
	}, [targetMs]);

	return (
		<span className={className}>
			{formatCountdownLabel(remainingMs, suffix, zeroText)}
		</span>
	);
}
