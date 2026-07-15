import { describe, expect, it } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { CacheAffinityOrderer } from "../cache-affinity-orderer";

function account(id: string, provider = "xai"): Account {
	return {
		id,
		name: id,
		provider,
		api_key: null,
		refresh_token: "r",
		access_token: "t",
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
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
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
	};
}

function meta(key: string): RequestMeta {
	return {
		id: "request",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		cacheAffinityKey: key,
		xaiCacheEligibleAccountIds: new Set(["xai-a", "xai-b"]),
	};
}

describe("CacheAffinityOrderer", () => {
	it("keeps an owner across changing base-strategy order", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");

		expect(orderer.order([a, b], meta("conversation"))[0]?.id).toBe("xai-a");
		expect(orderer.order([b, a], meta("conversation"))[0]?.id).toBe("xai-a");
	});

	it("preserves ineligible provider slots", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const codex = account("codex", "codex");
		const a = account("xai-a");
		const b = account("xai-b");

		orderer.order([a, b], meta("conversation"));
		expect(
			orderer
				.order([codex, b, a], meta("conversation"))
				.map((candidate) => candidate.id),
		).toEqual(["codex", "xai-a", "xai-b"]);
	});

	it("preserves an unavailable owner mapping for recovery", () => {
		const orderer = new CacheAffinityOrderer(60_000);
		const a = account("xai-a");
		const b = account("xai-b");

		orderer.order([a, b], meta("conversation"));
		expect(orderer.order([b], meta("conversation"))[0]?.id).toBe("xai-b");
		expect(orderer.order([b, a], meta("conversation"))[0]?.id).toBe("xai-a");
	});
});
