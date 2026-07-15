import { afterEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	cacheOutcomeFromTokens,
	deriveXaiConversationIdentity,
	extractClaudeSessionId,
	formatXaiCacheCanary,
	isOfficialXaiEndpoint,
	isXaiCacheNativeEnabled,
	XAI_CACHE_NATIVE_ENV,
} from "./cache-native";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function body(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: "claude-3-5-sonnet-20241022",
		max_tokens: 32,
		system: "stable system",
		messages: [{ role: "user", content: "hello" }],
		metadata: {
			user_id: JSON.stringify({ session_id: SESSION_A }),
		},
		...overrides,
	};
}

function account(overrides: Partial<Account> = {}): Account {
	return {
		id: "xai-1",
		name: "xai-test",
		provider: "xai",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 50,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

describe("xAI cache-native helpers", () => {
	const original = process.env[XAI_CACHE_NATIVE_ENV];

	afterEach(() => {
		if (original === undefined) delete process.env[XAI_CACHE_NATIVE_ENV];
		else process.env[XAI_CACHE_NATIVE_ENV] = original;
	});

	it("is disabled unless the env flag is exactly 1", () => {
		delete process.env[XAI_CACHE_NATIVE_ENV];
		expect(isXaiCacheNativeEnabled()).toBe(false);
		process.env[XAI_CACHE_NATIVE_ENV] = "true";
		expect(isXaiCacheNativeEnabled()).toBe(false);
		process.env[XAI_CACHE_NATIVE_ENV] = "1";
		expect(isXaiCacheNativeEnabled()).toBe(true);
	});

	it("treats default and api.x.ai endpoints as official", () => {
		expect(isOfficialXaiEndpoint(account())).toBe(true);
		expect(
			isOfficialXaiEndpoint(
				account({ custom_endpoint: "https://api.x.ai/v1" }),
			),
		).toBe(true);
	});

	it("rejects custom hosts", () => {
		expect(
			isOfficialXaiEndpoint(
				account({ custom_endpoint: "https://proxy.example.com/v1" }),
			),
		).toBe(false);
	});

	it("extracts and lowercases a valid Claude session id", () => {
		expect(extractClaudeSessionId(body())).toBe(SESSION_A);
		expect(
			extractClaudeSessionId(
				body({
					metadata: {
						user_id: JSON.stringify({
							session_id: SESSION_A.toUpperCase(),
						}),
					},
				}),
			),
		).toBe(SESSION_A);
	});

	it("omits identity for malformed metadata", () => {
		expect(
			deriveXaiConversationIdentity(
				body({ metadata: { user_id: "not-json" } }),
			),
		).toBeUndefined();
		expect(
			deriveXaiConversationIdentity(
				body({
					metadata: {
						user_id: JSON.stringify({ session_id: "not-a-uuid" }),
					},
				}),
			),
		).toBeUndefined();
		expect(deriveXaiConversationIdentity(body({ metadata: undefined }))).toBe(
			undefined,
		);
	});

	it("is stable across turns of the same conversation", () => {
		const turn1 = deriveXaiConversationIdentity(body());
		// Growing history keeps identity when the first item is unchanged.
		const turn2 = deriveXaiConversationIdentity(
			body({
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
					{ role: "user", content: "again" },
				],
			}),
		);
		expect(turn1?.headerValue).toBe(turn2?.headerValue);
		expect(turn1?.headerValue).toMatch(/^ccflare-xai-[0-9a-f]{48}$/);
		expect(turn1?.headerValue).not.toContain(SESSION_A);
		expect(turn1?.identityFingerprint).toHaveLength(16);
		// Different first message changes identity (sibling seed).
		const siblingSeed = deriveXaiConversationIdentity(
			body({
				messages: [{ role: "user", content: "different first turn" }],
			}),
		);
		expect(siblingSeed?.headerValue).not.toBe(turn1?.headerValue);
	});

	it("partitions sibling conversations under one session", () => {
		const main = deriveXaiConversationIdentity(body());
		const sibling = deriveXaiConversationIdentity(
			body({
				system: "subagent system",
				messages: [{ role: "user", content: "subagent task" }],
			}),
		);
		const otherSession = deriveXaiConversationIdentity(
			body({
				metadata: {
					user_id: JSON.stringify({ session_id: SESSION_B }),
				},
			}),
		);
		expect(main?.headerValue).not.toBe(sibling?.headerValue);
		expect(main?.headerValue).not.toBe(otherSession?.headerValue);
	});

	it("formats canary lines without raw session content", () => {
		const line = formatXaiCacheCanary({
			requestId: "req-1",
			accountId: "acc-1",
			officialEndpoint: true,
			keyPresent: true,
			identityFingerprint: "abcd",
			prefixFingerprint: "ef01",
			cacheOutcome: "hit",
			cachedTokens: 10,
			inputTokens: 20,
		});
		expect(line).toContain("outcome=hit");
		expect(line).toContain("id=abcd");
		expect(line).not.toContain(SESSION_A);
	});

	it("maps cached token details to hit/miss/unknown", () => {
		expect(cacheOutcomeFromTokens(5, true)).toBe("hit");
		expect(cacheOutcomeFromTokens(0, true)).toBe("miss");
		expect(cacheOutcomeFromTokens(undefined, false)).toBe("unknown");
	});
});
