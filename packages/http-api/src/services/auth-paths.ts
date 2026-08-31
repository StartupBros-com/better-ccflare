type AuthPathFamily = "api" | "v1" | "messages" | "health";

/**
 * Classify path families shared by the dashboard router and AuthService.
 *
 * The three request families intentionally preserve AuthService's existing
 * prefix semantics: no trailing slash is required. Health is the exception;
 * only the exact public endpoint belongs to that family.
 */
export function classifyAuthPath(path: string): AuthPathFamily | null {
	if (path === "/health") return "health";
	if (path.startsWith("/api")) return "api";
	if (path.startsWith("/v1")) return "v1";
	if (path.startsWith("/messages")) return "messages";
	return null;
}
