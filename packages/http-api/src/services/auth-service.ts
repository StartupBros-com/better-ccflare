import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKey,
	type ApiKeyRole,
	NodeCryptoUtils,
} from "@better-ccflare/types";
import { extractApiKey } from "./extract-api-key";

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKey?: ApiKey;
	apiKeyId?: string;
	apiKeyName?: string;
	role?: ApiKeyRole;
	error?: string;
}

/**
 * Exact shape of the status-line read route `GET /api/sessions/:id/account`:
 * five segments, `/api/sessions/<id>/account`. Kept identical to the router's
 * own match so the auth exemption never covers a path the router won't serve
 * (which would otherwise fall through to the upstream proxy).
 */
function isSessionAccountPath(path: string): boolean {
	const parts = path.split("/");
	return (
		parts.length === 5 &&
		parts[1] === "api" &&
		parts[2] === "sessions" &&
		parts[4] === "account"
	);
}

export class AuthService {
	private crypto: NodeCryptoUtils;
	private dbOps: DatabaseOperations;

	constructor(dbOps: DatabaseOperations) {
		this.dbOps = dbOps;
		this.crypto = new NodeCryptoUtils();
	}

	/**
	 * Check if API authentication is enabled (has at least one active API key)
	 */
	async isAuthenticationEnabled(): Promise<boolean> {
		return (await this.dbOps.countActiveApiKeys()) > 0;
	}

	/**
	 * Validate API key from request header
	 */
	async validateApiKey(apiKey: string): Promise<AuthenticationResult> {
		if (!apiKey) {
			return {
				isAuthenticated: false,
				error: "API key required",
			};
		}

		// If no API keys are configured, authentication is disabled
		if (!(await this.isAuthenticationEnabled())) {
			return {
				isAuthenticated: true,
				error: undefined,
			};
		}

		// Get all active API keys
		const activeApiKeys = await this.dbOps.getActiveApiKeys();

		// Derive the last-8 suffix of the incoming key for a cheap pre-filter.
		// This matches how `prefixLast8` is stored: apiKey.slice(-8).
		const incomingLast8 = apiKey.slice(-8);

		// Check each API key
		for (const keyRecord of activeApiKeys) {
			// Short-circuit: skip expensive scrypt if the last-8 suffix doesn't match
			if (keyRecord.prefixLast8 && keyRecord.prefixLast8 !== incomingLast8) {
				continue;
			}
			const isValid = await this.crypto.verifyApiKey(
				apiKey,
				keyRecord.hashedKey,
			);
			if (isValid) {
				// Update usage statistics
				this.dbOps.updateApiKeyUsage(keyRecord.id, Date.now());

				return {
					isAuthenticated: true,
					apiKey: keyRecord,
					apiKeyId: keyRecord.id,
					apiKeyName: keyRecord.name,
					role: keyRecord.role,
				};
			}
		}

		return {
			isAuthenticated: false,
			error: "Invalid API key",
		};
	}

	/**
	 * Authorize endpoint access based on API key role
	 */
	async authorizeEndpoint(
		apiKey: ApiKey,
		path: string,
		_method: string,
	): Promise<{ authorized: boolean; reason?: string }> {
		// Admin keys have full access
		if (apiKey.role === "admin") {
			return { authorized: true };
		}

		// Debug endpoints are admin-only (heap snapshots contain secrets)
		if (path.startsWith("/api/debug/")) {
			return {
				authorized: false,
				reason: "Unauthorized: Debug endpoints require an admin API key",
			};
		}

		// API-only keys: Only allow /v1/* and /messages/* (proxy endpoints)
		const isProxyEndpoint =
			path.startsWith("/v1/") || path.startsWith("/messages/");

		if (!isProxyEndpoint) {
			return {
				authorized: false,
				reason: "Unauthorized: This API key does not have dashboard access",
			};
		}

		return { authorized: true };
	}

	extractApiKey(req: Request): string | null {
		return extractApiKey(req);
	}

	/**
	 * Check if a path is statically exempt from authentication
	 * (does not require async DB check)
	 */
	isStaticPathExempt(path: string, method?: string): boolean {
		// Health endpoint is always exempt
		if (path === "/health") {
			return true;
		}

		// NOTE: OAuth endpoints are intentionally NOT blanket-exempt here.
		// Every /api/oauth/**/init|reauth|callback route mutates stored account
		// OAuth tokens (or overwrites them via reauth), and the dashboard's own
		// API client already attaches x-api-key to every call it makes,
		// including these. A blanket exemption let any unauthenticated caller
		// overwrite a configured account's tokens (session takeover) once auth
		// was enabled. Only read-only status polling stays exempt; see the
		// method-aware gating in isPathExempt().

		// Version check returns only the latest npm-published version. The
		// dashboard's sidebar tile fires this on load with no API key in
		// headers, so it must be reachable whether or not auth is enabled.
		if (path === "/api/version/check") {
			return true;
		}

		// Session→account lookup for the local status-line badge. The caller is a
		// local status-line script with no credential store, and the payload is
		// coarse operational state (account name + usage/health) with no secrets
		// (KTD-3). Scoped to EXACTLY `GET /api/sessions/:id/account` — the same
		// method and 5-segment shape the router matches. This is load-bearing: an
		// exemption broader than its route (e.g. a POST, or extra path segments)
		// would pass auth here, fail to match any API route, and then fall through
		// to the upstream proxy — letting an unauthenticated caller drive a
		// configured account. A future write endpoint under /api/sessions/ must
		// make its own explicit auth decision.
		if (
			(method === undefined || method === "GET") &&
			isSessionAccountPath(path)
		) {
			return true;
		}

		// IMPORTANT: do NOT blanket-exempt "any non-/api, non-/v1, non-/messages
		// path". The dashboard SPA and its static assets are served directly by
		// apps/server/src/server.ts BEFORE authentication is consulted, and
		// only when the dashboard is actually available, so genuine dashboard
		// requests never reach this code path. A broad "not an API path =>
		// exempt" rule here instead let arbitrary paths (e.g. POST /foo) reach
		// the upstream proxy without an API key whenever the dashboard was
		// disabled or its assets were unavailable, since providers accept
		// arbitrary paths. Only /health is statically exempt; OAuth read-only
		// status polling is gated in isPathExempt().

		return false;
	}

	/**
	 * Check if a path should be exempt from authentication
	 */
	async isPathExempt(path: string, method: string): Promise<boolean> {
		// Static exemptions first (no DB hit). Method matters: the session-account
		// exemption is GET-only so a non-GET request can't be exempt-but-unmatched.
		if (this.isStaticPathExempt(path, method)) {
			return true;
		}

		// OAuth endpoints.
		// Read-only status polling (GET /api/oauth/{qwen,codex}/status/*) stays
		// exempt: it returns transient setup progress only (no secrets, no
		// mutation), and the setup UI may poll it before an API key exists.
		// Token-mutating endpoints (init / reauth / callback) are NOT exempt:
		// when no API keys exist authenticateRequest() still allows them
		// (initial account setup, via the isAuthenticationEnabled() check
		// below); once authentication is enabled they fall through to
		// API-key validation and authorizeEndpoint(), which only grants admin
		// keys access to non-proxy paths. This closes the unauthenticated
		// token-overwrite hole.
		if (path.startsWith("/api/oauth")) {
			return (
				method === "GET" &&
				(path.startsWith("/api/oauth/qwen/status/") ||
					path.startsWith("/api/oauth/codex/status/"))
			);
		}

		// API key management: Only allow initial key creation without auth if no keys exist
		// All other operations require authentication
		if (path.startsWith("/api/api-keys")) {
			// Only allow POST (key creation) without auth if no keys exist
			if (path === "/api/api-keys" && method === "POST") {
				return !(await this.isAuthenticationEnabled()); // Only exempt if no keys exist
			}
			// All other API key operations require authentication
			return false;
		}

		// Proxy endpoints (/v1/*, /messages/*, etc.) require authentication if enabled
		if (path.startsWith("/v1") || path.startsWith("/messages")) {
			return false;
		}

		// API endpoints require authentication if enabled
		if (path.startsWith("/api")) {
			return false;
		}

		// Everything else requires authentication when it is enabled.
		// NOTE: dashboard SPA + static assets are intentionally NOT exempt
		// here. They are served directly by apps/server/src/server.ts BEFORE
		// this authentication-gated path is ever reached, but only when the
		// dashboard is actually available. Exempting them in this SHARED path
		// (used by both the API router and the proxy fallback) previously let
		// unauthenticated requests to arbitrary non-API paths reach the proxy
		// when the dashboard was disabled or unavailable, since upstream
		// providers accept arbitrary paths. Any request that reaches here is
		// an API or proxy request and must be authenticated.
		return false;
	}

	/**
	 * Authenticate a request
	 */
	async authenticateRequest(
		req: Request,
		path: string,
		method: string,
	): Promise<AuthenticationResult> {
		// If path is exempt, allow without authentication
		if (await this.isPathExempt(path, method)) {
			return {
				isAuthenticated: true,
			};
		}

		// If authentication is not enabled (no API keys), allow
		if (!(await this.isAuthenticationEnabled())) {
			return {
				isAuthenticated: true,
			};
		}

		// Extract API key from request
		const apiKey = this.extractApiKey(req);
		if (!apiKey) {
			return {
				isAuthenticated: false,
				error:
					"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>",
			};
		}

		// Validate the API key
		return await this.validateApiKey(apiKey);
	}
}
