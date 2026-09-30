import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { refreshCodexUsageFromMetadata } from "./server";

const originalFetch = globalThis.fetch;
const account = {
	id: "manual-codex-refresh-test",
	name: "synthetic-codex",
	provider: "codex",
	custom_endpoint: null,
	rate_limited_until: null,
} as Account;
const reset = Math.floor(Date.now() / 1000) + 3600;
const window = (used_percent: unknown) => ({ used_percent, reset_at: reset });

afterEach(() => {
	globalThis.fetch = originalFetch;
	usageCache.delete(account.id);
});

describe("manual Codex metadata refresh (fake transport)", () => {
	it.each([
		{
			name: "windowless exhaustion",
			primary: null,
			secondary: null,
			allowed: false,
			reached: true,
			limited: true,
			display: "5h: unavailable, 7d: unavailable",
		},
		{
			name: "explicit zero",
			primary: window(0),
			secondary: window(0),
			limited: false,
			display: "5h: 0%, 7d: 0%",
		},
		{
			name: "real percentages",
			primary: window(12),
			secondary: window(55),
			limited: false,
			display: "5h: 12%, 7d: 55%",
		},
		{
			name: "disallowed with windows",
			primary: window(12),
			secondary: window(55),
			allowed: false,
			limited: true,
			display: "5h: 12%, 7d: 55%",
		},
		{
			name: "limit reached with windows",
			primary: window(12),
			secondary: window(55),
			reached: true,
			limited: true,
			display: "5h: 12%, 7d: 55%",
		},
		{
			name: "exhausted percentage",
			primary: window(100),
			secondary: window(55),
			limited: true,
			display: "5h: 100%, 7d: 55%",
		},
		{
			name: "active cooldown",
			primary: window(0),
			secondary: window(0),
			cooldown: Date.now() + 600_000,
			limited: true,
			display: "5h: 0%, 7d: 0%",
		},
		{
			name: "expired cooldown",
			primary: window(0),
			secondary: window(0),
			cooldown: 1,
			limited: false,
			display: "5h: 0%, 7d: 0%",
		},
		{
			name: "omitted primary",
			secondary: window(55),
			limited: false,
			display: "5h: unavailable, 7d: 55%",
		},
		{
			name: "null primary",
			primary: null,
			secondary: window(55),
			limited: false,
			display: "5h: unavailable, 7d: 55%",
		},
		{
			name: "malformed primary",
			primary: "bad",
			secondary: window(55),
			limited: false,
			display: "5h: unavailable, 7d: 55%",
		},
		{
			name: "missing utilization",
			primary: {},
			secondary: window(55),
			limited: false,
			display: "5h: unavailable, 7d: 55%",
		},
		{
			name: "null utilization",
			primary: window(null),
			secondary: window(55),
			limited: false,
			display: "5h: unavailable, 7d: 55%",
		},
		{
			name: "malformed utilization",
			primary: window("0"),
			secondary: window(55),
			limited: false,
			display: "5h: unavailable, 7d: 55%",
		},
		{
			name: "weekly-only free plan",
			primary: window(30),
			secondary: null,
			plan: "free",
			limited: false,
			display: "5h: unavailable, 7d: 30%",
		},
		{
			name: "weekly-only primary duration",
			primary: { ...window(30), limit_window_seconds: 604800 },
			secondary: null,
			limited: false,
			display: "5h: unavailable, 7d: 30%",
		},
		{
			name: "missing windows",
			limited: false,
			display: "5h: unavailable, 7d: unavailable",
		},
	])("reports $name without inventing utilization or pinging", async (testCase) => {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request) => {
			calls.push(String(url));
			if (!String(url).includes("/usage"))
				throw new Error("unexpected inference request");
			return Response.json({
				plan_type: testCase.plan,
				rate_limit: {
					allowed: testCase.allowed ?? true,
					limit_reached: testCase.reached ?? false,
					primary_window: testCase.primary,
					secondary_window: testCase.secondary,
				},
			});
		}) as typeof fetch;
		const current = {
			...account,
			rate_limited_until: testCase.cooldown ?? null,
		};
		const logs: unknown[] = [];
		const result = await refreshCodexUsageFromMetadata(
			current,
			"fake-token",
			{
				getAccount: async () => current,
			},
			{ run: async () => {} },
			{
				info: (message) => {
					logs.push(message);
				},
				warn: () => {},
			},
		);
		expect(logs).toEqual([
			`Codex usage refreshed (free endpoint) for '${account.name}': ${testCase.display.replaceAll(": ", "=")}${testCase.limited ? " (rate-limited)" : ""}`,
		]);
		expect(result).toEqual({
			success: true,
			message: testCase.limited
				? `Usage refreshed for '${account.name}' — account is rate limited (${testCase.display}).`
				: `Usage refreshed for '${account.name}' (${testCase.display}).`,
		});
		expect(calls).toHaveLength(1);
		expect(
			usageCache.getSnapshot(account.id)?.data.codex_subscription,
		).toMatchObject({
			allowed: testCase.allowed ?? true,
			limitReached: testCase.reached ?? false,
		});
	});

	it("returns the fallback signal only when metadata actually fails", async () => {
		globalThis.fetch = (async () =>
			new Response("unavailable", { status: 503 })) as typeof fetch;
		expect(
			await refreshCodexUsageFromMetadata(
				account,
				"fake-token",
				{
					getAccount: async () => account,
				},
				{ run: async () => {} },
			),
		).toBeNull();
		expect(usageCache.getSnapshot(account.id)).toBeNull();
	});
});
