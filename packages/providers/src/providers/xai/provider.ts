import {
	getEndpointUrl,
	getModelFamily,
	validateEndpointUrl,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account, LogicalModelCapability } from "@better-ccflare/types";
import { parseStandardRetryAfter429 } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import { OpenAICompatibleProvider } from "../openai/provider";
import {
	deriveXaiConversationIdentity,
	isOfficialXaiEndpoint,
	isXaiCacheNativeEnabled,
	XAI_CONV_ID_HEADER,
} from "./cache-native";

const log = new Logger("XaiProvider");
const cacheLog = new Logger("XaiCacheNative");

export const XAI_DEFAULT_ENDPOINT = "https://api.x.ai/v1";
export const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
export const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export const XAI_MODEL_MAPPINGS = {
	opus: "grok-4.5",
	sonnet: "grok-4.5",
	haiku: "grok-4.5",
	fable: "grok-4.5",
};

export class XaiProvider extends OpenAICompatibleProvider {
	override name = "xai";

	getLogicalModelCapability(
		logicalModel: string,
		account: Account,
	): LogicalModelCapability {
		const family = getModelFamily(logicalModel);
		if (!family) {
			return {
				status: "unknown",
				provenance: "undeclared",
				reason: "unknown",
			};
		}
		const usesDefaults = account.model_mappings == null;
		return usesDefaults && XAI_MODEL_MAPPINGS[family]
			? {
					status: "supported",
					provenance: "provider_default",
					reason: "included",
				}
			: {
					status: "unsupported",
					provenance: "provider_default",
					reason: "unsupported",
				};
	}

	override async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		if (!account.refresh_token) {
			throw new Error(`No xAI refresh token for account ${account.name}`);
		}

		log.info(`Refreshing xAI token for account ${account.name}`);

		const body = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: XAI_DEFAULT_CLIENT_ID,
			refresh_token: account.refresh_token,
		});

		const response = await fetch(XAI_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!response.ok) {
			let message = response.statusText;
			try {
				const data = (await response.json()) as {
					error?: string;
					error_description?: string;
				};
				// Preserve the machine-readable OAuth error code (e.g. "invalid_grant")
				// ahead of the human description so the token-manager's requires_reauth
				// detection can classify a dead xAI refresh token.
				message =
					[data.error, data.error_description].filter(Boolean).join(": ") ||
					message;
			} catch {
				// Do not include raw response bodies in refresh errors; auth servers
				// should not echo credentials, but keeping messages structured avoids
				// accidental token exposure if that ever changes.
			}
			throw new Error(
				`Failed to refresh xAI token for account ${account.name}: ${response.status} ${message}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token) {
			throw new Error(
				`xAI refresh response for account ${account.name} did not include an access token`,
			);
		}

		const expiresInSeconds =
			typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
				? json.expires_in
				: 6 * 60 * 60;

		return {
			accessToken: json.access_token,
			refreshToken: json.refresh_token || account.refresh_token,
			expiresAt: Date.now() + expiresInSeconds * 1000,
		};
	}

	override buildUrl(path: string, query: string, account?: Account): string {
		let endpoint = XAI_DEFAULT_ENDPOINT;
		try {
			endpoint = account?.custom_endpoint
				? getEndpointUrl(account)
				: XAI_DEFAULT_ENDPOINT;
			endpoint = validateEndpointUrl(endpoint, "xAI endpoint");
		} catch (error) {
			log.warn(
				`Invalid xAI endpoint for ${account?.name ?? "unknown"}; using default`,
				error,
			);
		}

		let openaiPath = path === "/v1/messages" ? "/v1/chat/completions" : path;
		if (endpoint.endsWith("/v1") && openaiPath.startsWith("/v1/")) {
			openaiPath = openaiPath.replace(/^\/v1/, "");
		}
		return `${endpoint}${openaiPath}${query}`;
	}

	override supportsOAuth(): boolean {
		return true;
	}

	override supportsUsageTracking(): boolean {
		return true;
	}

	/**
	 * Native xAI capacity classification (R5-R7). Unlike the generic
	 * OpenAICompatibleProvider (which always reports isRateLimited:false so
	 * pool-wide model-fallback logic is not tripped by ordinary upstream
	 * errors), xAI's own 402 and 429 responses are meaningful operational
	 * signals worth attributing to a first-class failover state:
	 *  - 402 (payment/capacity): xAI's neutral signal for capacity
	 *    exhaustion, not a billing failure. Tagged with the typed reason
	 *    `xai_capacity_402` so downstream cooldown/reason plumbing can tell
	 *    it apart from ordinary upstream 429s.
	 *  - 429: standard Retry-After based classification, matching
	 *    BaseProvider's own fallback (reused via parseStandardRetryAfter429
	 *    since a naive `super.parseRateLimit()` here would hit
	 *    OpenAICompatibleProvider's always-false override instead).
	 *  - Every other status (including 400/500): not rate-limited.
	 */
	override parseRateLimit(response: Response): RateLimitInfo {
		if (response.status === 402) {
			return { isRateLimited: true, reason: "xai_capacity_402" };
		}
		if (response.status === 429) {
			return parseStandardRetryAfter429(response);
		}
		return { isRateLimited: false };
	}

	override beforeConvert(
		_body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		if (!account) return account;
		return {
			...account,
			custom_endpoint: account.custom_endpoint ?? XAI_DEFAULT_ENDPOINT,
			model_mappings:
				account.model_mappings ?? JSON.stringify(XAI_MODEL_MAPPINGS),
		};
	}

	override afterConvert(body: OpenAIRequest): void {
		// Ask OpenAI-compatible streaming APIs to include a final usage chunk when
		// supported. xAI accepts this OpenAI field and it improves request accounting
		// when the downstream client streams responses.
		if (body.stream) {
			const record = body as unknown as Record<string, unknown>;
			record.stream_options = {
				...(typeof record.stream_options === "object" && record.stream_options
					? (record.stream_options as Record<string, unknown>)
					: {}),
				include_usage: true,
			};
		}
	}

	/**
	 * Attach official xAI Chat affinity (`x-grok-conv-id`) when the cache-native
	 * feature is opted in. Header is derived from the original Anthropic body so
	 * identity is request-scoped and does not require mutable provider state.
	 */
	override async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		if (!isXaiCacheNativeEnabled() || !isOfficialXaiEndpoint(account)) {
			return super.transformRequestBody(request, account);
		}

		let originalBody: Record<string, unknown> | null = null;
		try {
			const contentType = request.headers.get("content-type");
			if (contentType?.includes("application/json")) {
				const clone = request.clone();
				originalBody = (await clone.json()) as Record<string, unknown>;
			}
		} catch {
			originalBody = null;
		}

		const transformed = await super.transformRequestBody(request, account);
		if (!originalBody) return transformed;

		const identity = deriveXaiConversationIdentity(originalBody);
		if (!identity) {
			cacheLog.debug(
				"cache-native enabled but conversation identity omitted (bad metadata)",
			);
			return transformed;
		}

		const headers = new Headers(transformed.headers);
		// Always overwrite any client-supplied value with the provider-derived one.
		headers.set(XAI_CONV_ID_HEADER, identity.headerValue);
		cacheLog.info(
			`attach ${XAI_CONV_ID_HEADER} id=${identity.identityFingerprint} prefix=${identity.prefixFingerprint} account=${account?.id ?? "none"}`,
		);

		return new Request(transformed.url, {
			method: transformed.method,
			headers,
			body: transformed.body,
		});
	}
}
