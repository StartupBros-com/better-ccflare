import { getModelFamily, mapModelName } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account, LogicalModelCapability } from "@better-ccflare/types";
import type { RateLimitInfo } from "../../types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";
import { sanitizeMuseSparkRequestBody } from "./request-sanitizer";

const log = new Logger("MuseSparkProvider");

/** Meta Model API base for the Anthropic-compatible Messages surface. */
export const MUSE_SPARK_DEFAULT_ENDPOINT = "https://api.meta.ai";

/** Current standard-tier checkpoint. */
export const MUSE_SPARK_DEFAULT_MODEL = "muse-spark-1.2";

/** Model IDs the Meta Model API publishes. */
export const MUSE_SPARK_MODEL_IDS = {
	MUSE_SPARK_1_1: "muse-spark-1.1",
	MUSE_SPARK_1_2: "muse-spark-1.2",
	MUSE_SPARK_1_2_CONTRIBUTOR: "muse-spark-1.2-contributor",
} as const;

/**
 * Default logical-family routing. Meta serves one model per tier, so every
 * Claude family collapses onto the current standard checkpoint — the same
 * shape as Meta's own Claude Code setup, which points OPUS, SONNET and HAIKU
 * at a single model ID.
 */
export const MUSE_SPARK_MODEL_MAPPINGS: Record<string, string> = {
	opus: MUSE_SPARK_DEFAULT_MODEL,
	sonnet: MUSE_SPARK_DEFAULT_MODEL,
	haiku: MUSE_SPARK_DEFAULT_MODEL,
	fable: MUSE_SPARK_DEFAULT_MODEL,
};

/** Whether a model ID already names a Muse Spark checkpoint. */
export function isMuseSparkModel(model: string): boolean {
	return model.trim().toLowerCase().startsWith("muse-spark");
}

/**
 * Whether a request targets the Anthropic Messages surface (`/v1/messages` or
 * `/v1/messages/count_tokens`), the only endpoints whose body follows the
 * contract the request sanitizer enforces.
 */
export function isMuseSparkMessagesPath(url: string): boolean {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		pathname = url;
	}
	return (
		pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens"
	);
}

export class MuseSparkProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "muse-spark",
			baseUrl: MUSE_SPARK_DEFAULT_ENDPOINT,
			// Meta authenticates with a bearer token, not Anthropic's x-api-key.
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			defaultModel: MUSE_SPARK_DEFAULT_MODEL,
		});
	}

	getEndpoint(): string {
		return this.config.baseUrl || MUSE_SPARK_DEFAULT_ENDPOINT;
	}

	/**
	 * Meta serves the Messages API at `<base>/v1/messages`. A custom endpoint is
	 * honoured so the account can be pointed at a gateway or regional host; its
	 * path prefix is de-duplicated so a base already ending in `/v1` does not
	 * produce `/v1/v1/messages`.
	 */
	buildUrl(pathname: string, search: string, account?: Account): string {
		const baseUrl = account?.custom_endpoint?.trim() || this.getEndpoint();
		const cleanBaseUrl = baseUrl.replace(/\/$/, "");

		try {
			const parsed = new URL(cleanBaseUrl);
			const basePath = parsed.pathname.replace(/\/$/, "");
			const effectivePath =
				basePath && pathname.startsWith(basePath)
					? pathname.slice(basePath.length) || "/"
					: pathname;
			return `${cleanBaseUrl}${effectivePath}${search}`;
		} catch {
			return `${cleanBaseUrl}${pathname}${search}`;
		}
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);
		const token = accessToken || apiKey;

		if (token) {
			// Drop any client-supplied credential before attaching ours.
			newHeaders.delete("authorization");
			newHeaders.delete("x-api-key");
			newHeaders.set("Authorization", `Bearer ${token}`);
		}

		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");

		return newHeaders;
	}

	/**
	 * Resolve the outbound model ID.
	 *
	 * An explicit account mapping always wins. Otherwise a Claude model name is
	 * routed to the default Muse Spark checkpoint, because forwarding
	 * `claude-*` unchanged is a guaranteed `model_not_found`.
	 */
	resolveModel(model: string, account?: Account): string {
		if (!model) return model;

		if (account) {
			const mapped = mapModelName(model, account);
			if (mapped && mapped !== model) return mapped;
		}

		if (isMuseSparkModel(model)) return model;

		return this.config.defaultModel || MUSE_SPARK_DEFAULT_MODEL;
	}

	/**
	 * Map the model and normalise the body for Meta's strict validator.
	 *
	 * The body is read with `arrayBuffer()` rather than `request.clone()`: on a
	 * body-bearing Request, Bun buffers the whole body natively to feed the tee
	 * and never returns that buffer to the OS, leaking ~1x the body size on
	 * every proxied request. Because the original body is consumed here, callers
	 * must forward the returned Request.
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return request;
		}

		// The allowlist below describes the Messages contract specifically. Any
		// other JSON endpoint (files, uploads) has a different field set, so it is
		// forwarded untouched rather than gutted by a contract it does not share.
		if (!isMuseSparkMessagesPath(request.url)) {
			return request;
		}

		const rebuild = (body: BodyInit): Request =>
			new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body,
			});

		let bytes: ArrayBuffer;
		try {
			bytes = await request.arrayBuffer();
		} catch (error) {
			log.debug("Failed to read request body for Muse Spark:", error);
			return request;
		}

		try {
			const parsed = JSON.parse(new TextDecoder().decode(bytes));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return rebuild(bytes);
			}

			const body = parsed as Record<string, unknown>;
			if (typeof body.model === "string") {
				const mapped = this.resolveModel(body.model, account);
				if (mapped !== body.model) {
					log.debug(`Mapped model: ${body.model} -> ${mapped}`);
					body.model = mapped;
				}
			}

			const { body: sanitized, changes } = sanitizeMuseSparkRequestBody(body);
			if (changes.length > 0) {
				log.debug(
					`Sanitized request for Meta Model API: ${changes.join(", ")}`,
				);
			}

			return rebuild(JSON.stringify(sanitized));
		} catch (error) {
			log.debug("Failed to transform Muse Spark request body:", error);
			return rebuild(bytes);
		}
	}

	/**
	 * Meta reports quota with OpenAI-style `x-ratelimit-*` headers rather than
	 * Anthropic's `anthropic-ratelimit-unified-*` set, so the base class parser
	 * would see nothing on a successful response.
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		const remainingRequests = response.headers.get(
			"x-ratelimit-remaining-requests",
		);
		const remainingTokens = response.headers.get(
			"x-ratelimit-remaining-tokens",
		);

		const parseCount = (value: string | null): number | undefined => {
			if (value === null) return undefined;
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : undefined;
		};

		// Requests-remaining is the actionable signal for account selection;
		// fall back to tokens when the request budget is not reported.
		const remaining =
			parseCount(remainingRequests) ?? parseCount(remainingTokens);

		if (response.status !== 429) {
			return { isRateLimited: false, remaining };
		}

		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;
		if (retryAfter) {
			const seconds = Number(retryAfter);
			resetTime = Number.isNaN(seconds)
				? new Date(retryAfter).getTime()
				: Date.now() + seconds * 1000;
			if (Number.isNaN(resetTime)) resetTime = undefined;
		}

		return {
			isRateLimited: true,
			resetTime,
			statusHeader: "rate_limited",
			remaining,
		};
	}

	getLogicalModelCapability(
		logicalModel: string,
		account: Account,
	): LogicalModelCapability {
		if (isMuseSparkModel(logicalModel)) {
			return {
				status: "supported",
				provenance: "provider_default",
				reason: "included",
			};
		}

		const family = getModelFamily(logicalModel);
		if (!family) {
			return {
				status: "unknown",
				provenance: "undeclared",
				reason: "unknown",
			};
		}

		// With no explicit mapping the provider defaults route every Claude
		// family to the standard Muse Spark checkpoint.
		const usesDefaults = account.model_mappings == null;
		return usesDefaults && MUSE_SPARK_MODEL_MAPPINGS[family]
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
}
