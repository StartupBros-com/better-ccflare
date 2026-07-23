import https from "node:https";
import type { Config } from "@better-ccflare/config";
import { registerHeartbeat } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { type CachedRequestEntry, cacheBodyStore } from "./cache-body-store";
import { CACHE_REPLAY_MODEL_HEADER } from "./cache-transport-staging";
import { stampInternalAutoRefreshAuth } from "./internal-probe-auth";
import type { ProxyContext } from "./proxy";

const log = new Logger("CacheKeepaliveScheduler");

/**
 * Patch a staged request body for replay as a cache keepalive.
 *
 * max_tokens is set to 1 and stream to false to minimize quota and transport
 * cost. Neither field is part of any prompt-cache tier's identity, so the
 * replay still reads (and thereby TTL-refreshes) every cache entry the
 * original request wrote.
 *
 * We deliberately do NOT use the documented max_tokens: 0 pre-warm shape:
 * that shape rejects bodies carrying stream, enabled thinking, forced
 * tool_choice, or output_config.format, and stripping those fields changes
 * the messages-tier cache identity (thinking and tool_choice are part of
 * it). A stripped warmup would refresh only the tools+system tiers and let
 * the far larger conversation tier expire, silently defeating the feature.
 *
 * Parsing errors are handled gracefully: if the body is not valid JSON the
 * original bytes are replayed unpatched.
 */
export function sanitizeKeepaliveBody(
	body: Uint8Array | ArrayBuffer,
): string | ArrayBuffer {
	const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
	try {
		const bodyJson = JSON.parse(new TextDecoder().decode(bytes)) as Record<
			string,
			unknown
		>;
		if (typeof bodyJson === "object" && bodyJson !== null) {
			bodyJson.max_tokens = 1;
			bodyJson.stream = false;
			// Staged bodies are Anthropic-shaped and re-enter the proxy for
			// provider conversion. Set Anthropic reasoning.effort=low so the
			// converter emits nested effort; XaiProvider.afterConvert mirrors
			// that to Chat Completions reasoning_effort. Effort is not part of
			// xAI's messages-array prefix identity. Grok-4.5 cannot disable
			// reasoning and defaults to high, so keepalives must force low.
			const existingReasoning =
				typeof bodyJson.reasoning === "object" && bodyJson.reasoning !== null
					? (bodyJson.reasoning as Record<string, unknown>)
					: {};
			bodyJson.reasoning = {
				...existingReasoning,
				effort: "low",
			};
			return JSON.stringify(bodyJson);
		}
	} catch {
		// Body isn't valid JSON - skip patching and use original
	}
	// Fresh copy so the return is a plain ArrayBuffer regardless of the
	// source view's offset or backing buffer type.
	return bytes.slice().buffer;
}

/** Effective keepalive TTL for one staged entry given global + xAI knobs. */
export function resolveKeepaliveTtlMinutes(
	providerName: string | null | undefined,
	globalTtlMinutes: number,
	xaiTtlMinutes: number,
): number {
	if (providerName === "xai") {
		// Prefer the xAI-specific knob when set so Grok can be canaried without
		// enabling Anthropic keepalives. Fall back to the global TTL when the
		// operator only configured CACHE_KEEPALIVE_TTL_MINUTES.
		if (xaiTtlMinutes > 0) return xaiTtlMinutes;
		return globalTtlMinutes > 0 ? globalTtlMinutes : 0;
	}
	return globalTtlMinutes > 0 ? globalTtlMinutes : 0;
}

/**
 * Skip synthetic keepalive when real traffic is still fresher than half the
 * TTL window. Active multi-turn sessions already refresh the prefix; replaying
 * full contexts against limited Grok quota is pure waste in that window.
 */
export function shouldSkipKeepaliveForFreshness(
	entryTimestamp: number,
	ttlMinutes: number,
	nowMs: number = Date.now(),
): boolean {
	if (ttlMinutes <= 0) return true;
	const ageMs = nowMs - entryTimestamp;
	if (!Number.isFinite(ageMs) || ageMs < 0) return true;
	const freshnessMs = Math.max(30_000, (ttlMinutes * 60_000) / 2);
	return ageMs < freshnessMs;
}

/** Heartbeat interval from the tightest active TTL (seconds). */
export function keepaliveIntervalSeconds(
	globalTtlMinutes: number,
	xaiTtlMinutes: number,
): number {
	const active = [globalTtlMinutes, xaiTtlMinutes].filter((ttl) => ttl > 0);
	if (active.length === 0) return 0;
	const minTtl = Math.min(...active);
	// Fire (ttl - 1) minutes before expiry, minimum 60s.
	return Math.floor(Math.max(60_000, (minTtl - 1) * 60_000) / 1_000);
}

export class CacheKeepaliveScheduler {
	private proxyContext: ProxyContext;
	private config: Config;
	private unregisterInterval: (() => void) | null = null;
	private currentGlobalTtlMinutes = 0;
	private currentXaiTtlMinutes = 0;
	private boundConfigChangeHandler:
		| ((event: { key: string; newValue: unknown }) => void)
		| null = null;

	constructor(proxyContext: ProxyContext, config: Config) {
		this.proxyContext = proxyContext;
		this.config = config;
	}

	private readTtls(): { globalTtl: number; xaiTtl: number } {
		const globalTtl = this.config.getCacheKeepaliveTtlMinutes();
		const xaiTtl =
			typeof this.config.getXaiCacheKeepaliveTtlMinutes === "function"
				? this.config.getXaiCacheKeepaliveTtlMinutes()
				: 0;
		return { globalTtl, xaiTtl };
	}

	private anyTtlEnabled(globalTtl: number, xaiTtl: number): boolean {
		return globalTtl > 0 || xaiTtl > 0;
	}

	start(): void {
		const { globalTtl, xaiTtl } = this.readTtls();
		this.currentGlobalTtlMinutes = globalTtl;
		this.currentXaiTtlMinutes = xaiTtl;
		cacheBodyStore.setEnabled(this.anyTtlEnabled(globalTtl, xaiTtl));

		// Adjust dynamically when TTL config changes
		this.boundConfigChangeHandler = ({
			key,
			newValue,
		}: {
			key: string;
			newValue: unknown;
		}) => {
			if (
				key !== "cache_keepalive_ttl_minutes" &&
				key !== "xai_cache_keepalive_ttl_minutes"
			) {
				return;
			}
			const { globalTtl: nextGlobal, xaiTtl: nextXai } = this.readTtls();
			// Prefer event payload when present so tests can drive TTL without a
			// full Config implementation.
			const appliedGlobal =
				key === "cache_keepalive_ttl_minutes" && typeof newValue === "number"
					? newValue
					: nextGlobal;
			const appliedXai =
				key === "xai_cache_keepalive_ttl_minutes" &&
				typeof newValue === "number"
					? newValue
					: nextXai;
			if (
				appliedGlobal !== this.currentGlobalTtlMinutes ||
				appliedXai !== this.currentXaiTtlMinutes
			) {
				this.currentGlobalTtlMinutes = appliedGlobal;
				this.currentXaiTtlMinutes = appliedXai;
				cacheBodyStore.setEnabled(
					this.anyTtlEnabled(appliedGlobal, appliedXai),
				);
				this.restart();
			}
		};
		this.config.on("change", this.boundConfigChangeHandler);

		this.startInterval();
	}

	stop(): void {
		this.stopInterval();
		if (this.boundConfigChangeHandler) {
			this.config.off("change", this.boundConfigChangeHandler);
			this.boundConfigChangeHandler = null;
		}
	}

	private stopInterval(): void {
		if (this.unregisterInterval) {
			this.unregisterInterval();
			this.unregisterInterval = null;
		}
	}

	private restart(): void {
		this.stopInterval();
		this.startInterval();
	}

	private startInterval(): void {
		const intervalSeconds = keepaliveIntervalSeconds(
			this.currentGlobalTtlMinutes,
			this.currentXaiTtlMinutes,
		);
		if (intervalSeconds <= 0) {
			log.info("Cache keepalive disabled (global and xAI TTL = 0)");
			return;
		}

		log.info(
			`Starting cache keepalive scheduler, interval: ${intervalSeconds}s (global_ttl: ${this.currentGlobalTtlMinutes}min, xai_ttl: ${this.currentXaiTtlMinutes}min)`,
		);

		this.unregisterInterval = registerHeartbeat({
			id: "cache-keepalive-scheduler",
			callback: () => this.sendKeepalives(),
			seconds: intervalSeconds,
			description: `Cache keepalive scheduler (global ${this.currentGlobalTtlMinutes}min / xai ${this.currentXaiTtlMinutes}min)`,
		});
	}

	private async sendKeepalives(): Promise<void> {
		// Evict with the loosest active TTL so short xAI windows do not wipe
		// longer-lived Anthropic entries when both are enabled.
		const evictionTtl = Math.max(
			this.currentGlobalTtlMinutes,
			this.currentXaiTtlMinutes,
		);
		if (evictionTtl > 0) {
			cacheBodyStore.evictStaleEntries(evictionTtl);
		}

		const accounts = cacheBodyStore.getAllCachedAccounts();

		if (accounts.length === 0) {
			log.debug(
				"No accounts with cached requests in memory, skipping keepalive",
			);
			return;
		}

		const eligible: Array<{ accountId: string; cached: CachedRequestEntry }> =
			[];
		for (const accountId of accounts) {
			const cached = cacheBodyStore.getLastCachedRequest(accountId);
			if (!cached) continue;
			const ttl = resolveKeepaliveTtlMinutes(
				cached.providerName,
				this.currentGlobalTtlMinutes,
				this.currentXaiTtlMinutes,
			);
			if (ttl <= 0) continue;
			if (shouldSkipKeepaliveForFreshness(cached.timestamp, ttl)) {
				log.debug(
					`Skipping fresh keepalive for account ${accountId} (provider=${cached.providerName ?? "unknown"}, age_s=${Math.round((Date.now() - cached.timestamp) / 1000)}, ttl_min=${ttl})`,
				);
				continue;
			}
			eligible.push({ accountId, cached });
		}

		if (eligible.length === 0) {
			log.debug(
				"No keepalive-eligible accounts after provider/freshness filter",
			);
			return;
		}

		log.info(`Sending cache keepalive to ${eligible.length} account(s)`);

		await Promise.allSettled(
			eligible.map(({ accountId, cached }) =>
				this.replayCachedEntry(accountId, cached),
			),
		);
	}

	private async replayCachedEntry(
		accountId: string,
		cached: CachedRequestEntry,
	): Promise<void> {
		try {
			// Reconstruct headers from the stored snapshot.
			// Anthropic's prepareHeaders() copies incoming client headers and augments
			// them, so we need to replay them faithfully. Providers that build from
			// scratch (Qwen, Bedrock) simply ignore whatever we send here.
			// Auth and internal proxy headers were stripped at capture time.
			const replayHeaders = new Headers(cached.headers);
			replayHeaders.set("content-type", "application/json");
			// Inject routing headers fresh — these were stripped from the snapshot
			replayHeaders.set("x-better-ccflare-account-id", accountId);
			replayHeaders.set("x-better-ccflare-bypass-session", "true");

			// Tag as keepalive for dual purpose:
			//  1. Visibility: request logger can identify synthetic requests
			//  2. Loop prevention: proxy skips staging to avoid infinite replay cycle
			replayHeaders.set("x-better-ccflare-keepalive", "true");
			if (cached.resolvedModel) {
				replayHeaders.set(CACHE_REPLAY_MODEL_HEADER, cached.resolvedModel);
			}
			// The model directive is privileged: authenticate this localhost hop so
			// proxy ingress can distinguish it from a caller-forged header.
			stampInternalAutoRefreshAuth(replayHeaders);
			const proxyPort = this.proxyContext.runtime.port;
			const protocol =
				process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
					? "https"
					: "http";
			const endpoint = `${protocol}://localhost:${proxyPort}${cached.path}`;

			log.debug(
				`Replaying cached request for account ${accountId} (${cached.body.length} bytes, recorded ${Math.round((Date.now() - cached.timestamp) / 1000)}s ago, provider=${cached.providerName ?? "unknown"})`,
			);

			const bodyToSend = sanitizeKeepaliveBody(cached.body);

			// For HTTPS localhost requests, use an agent that accepts self-signed certificates.
			// This is needed when SSL_KEY_PATH + SSL_CERT_PATH are configured with self-signed certs.
			// The self-loop request goes through the proxy again, so certificate validation would fail.
			const url = new URL(endpoint);
			const isLocalhost =
				url.hostname === "localhost" ||
				url.hostname === "127.0.0.1" ||
				url.hostname === "::1";
			// CodeQL[js/disabling-certificate-validation]: self-signed localhost self-loop only
			const agent =
				protocol === "https" && isLocalhost
					? new https.Agent({ rejectUnauthorized: false })
					: undefined;

			const response = await fetch(endpoint, {
				method: "POST",
				headers: replayHeaders,
				body: bodyToSend,
				// @ts-expect-error Node.js fetch accepts agent option but it's not in standard Fetch API types
				agent,
			});

			// Drain the response so the connection is released
			await response.text().catch(() => {});

			if (response.ok) {
				log.info(
					`Cache keepalive replayed successfully for account ${accountId}`,
				);
			} else {
				log.warn(
					`Cache keepalive replay returned ${response.status} for account ${accountId}`,
				);
			}
		} catch (error) {
			log.error(`Error replaying keepalive for account ${accountId}:`, error);
		}
	}
}
