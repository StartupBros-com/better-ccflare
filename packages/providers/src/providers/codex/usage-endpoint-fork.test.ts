import { afterEach, expect, test } from "bun:test";
import { CODEX_USAGE_ENDPOINT, fetchCodexUsageData } from "./usage-endpoint";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("free usage keeps the fork endpoint fallback and metadata without inventing unknown percentages", async () => {
	const urls: string[] = [];
	globalThis.fetch = (async (url: RequestInfo | URL) => {
		urls.push(String(url));
		if (urls.length === 1) return new Response("moved", { status: 404 });
		return Response.json({
			plan_type: "pro",
			credits: { balance: "12.5" },
			rate_limit: {
				primary_window: { limit_window_seconds: 18000, reset_at: 1908000000 },
				secondary_window: {
					limit_window_seconds: 604800,
					used_percent: 42,
					reset_at: 1909000000,
				},
			},
			code_review_rate_limit: {
				primary_window: { used_percent: 100, reset_at: 1909000000 },
			},
		});
	}) as typeof fetch;
	const result = await fetchCodexUsageData("token");
	expect(urls).toEqual([
		CODEX_USAGE_ENDPOINT,
		"https://chatgpt.com/api/codex/usage",
	]);
	expect(result.data?.five_hour).toBeUndefined();
	expect(result.data).toMatchObject({
		plan_type: "pro",
		credits_balance: 12.5,
		code_review_used_percent: 100,
		seven_day: { utilization: 42 },
	});
	await fetchCodexUsageData("token");
	expect(urls[2]).toBe("https://chatgpt.com/api/codex/usage");
});
