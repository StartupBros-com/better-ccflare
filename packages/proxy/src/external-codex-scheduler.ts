import { Logger } from "@better-ccflare/logger";
/** Source parsing runs asynchronously; one scan may be active per scheduler. */
export function startExternalCodexScheduler(
	enabled: boolean | (() => boolean),
	scan: () => Promise<unknown>,
	options: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
	if (!enabled) return () => {};
	const log = new Logger("ExternalCodexUsage");
	let running = false;
	let stopped = false;
	const tick = async () => {
		if (running || stopped || (typeof enabled === "function" && !enabled()))
			return;
		running = true;
		try {
			await scan();
		} catch (error) {
			log.error(
				`External Codex scan failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			running = false;
		}
	};
	const initial = setTimeout(tick, options.initialDelayMs ?? 30_000);
	const interval = setInterval(tick, options.intervalMs ?? 5 * 60_000);
	return () => {
		stopped = true;
		clearTimeout(initial);
		clearInterval(interval);
	};
}
