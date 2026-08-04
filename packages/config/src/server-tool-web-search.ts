/**
 * Strict, restart-scoped opt-in for hosted web-search admission and routing.
 *
 * Keep this env-only so the inactive foundation does not expand ConfigData,
 * persisted configuration, health output, or generic config enumeration.
 */
export const CCFLARE_SERVER_TOOL_WEB_SEARCH_ENV =
	"CCFLARE_SERVER_TOOL_WEB_SEARCH" as const;

export function isServerToolWebSearchEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env[CCFLARE_SERVER_TOOL_WEB_SEARCH_ENV] === "1";
}
