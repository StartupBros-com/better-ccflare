/**
 * Discord-shaped alert webhook delivery (issue: model_routing_drift /
 * unknown_model fired 2026-09-22 but never reached the operator's Discord
 * channel — the legacy `{type:"alert", alert}` body isn't a shape Discord's
 * webhook endpoint accepts, and delivery never checked the response status).
 *
 * Covers, in order:
 *  - isDiscordWebhookUrl: host+path matching for the four Discord domains
 *  - buildDiscordWebhookBody / buildDiscordAlertContent: Discord body shape,
 *    field ordering, allowed_mentions
 *  - truncateToCodepoints: 2000-codepoint bound, boundary case, multibyte
 *    (astral/surrogate-pair) safety
 *  - deliverAlertWebhook: User-Agent header, legacy body for non-Discord
 *    URLs, non-2xx handling (warns without leaking the URL, never throws)
 *  - isAlertTypeAllowedForWebhook: the optional type allowlist
 *  - end-to-end wiring through AlertService.persistAndEmit (real DB, mocked
 *    fetch, restored in afterEach)
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { alertEvents, authFailureEvents } from "@better-ccflare/core";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import { logBus } from "@better-ccflare/logger";
import type { AlertEvent, AlertType, LogEvent } from "@better-ccflare/types";
import {
	AlertService,
	buildDiscordAlertContent,
	buildDiscordWebhookBody,
	deliverAlertWebhook,
	isAlertAllowedForWebhook,
	isAlertTypeAllowedForWebhook,
	isDiscordWebhookUrl,
	truncateToCodepoints,
} from "../alerts";

const BASE_ALERT: AlertEvent = {
	id: "alert-1",
	timestamp: 1_700_000_000_000,
	type: "usage_window_threshold",
	severity: "warning",
	title: "Usage window nearing capacity",
	message: "five_hour window for account acct-1 is at 92% utilization.",
	value: 92,
	threshold: 80,
	account: "acct-1",
	model: "claude-opus-4-8",
	project: null,
	requestId: null,
	acknowledged: false,
};

/** True if `s` contains a high surrogate not immediately followed by a low
 * surrogate, or a low surrogate not immediately preceded by a high
 * surrogate — i.e. a surrogate pair (astral codepoint) was split in half. */
function hasUnpairedSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		const isHigh = code >= 0xd800 && code <= 0xdbff;
		const isLow = code >= 0xdc00 && code <= 0xdfff;
		if (isHigh) {
			const next = s.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (isLow) {
			return true;
		}
	}
	return false;
}

function collectWarnLogs(): { logs: LogEvent[]; stop: () => void } {
	const logs: LogEvent[] = [];
	const listener = (event: LogEvent) => {
		if (event.level === "WARN") logs.push(event);
	};
	logBus.on("log", listener);
	return { logs, stop: () => logBus.off("log", listener) };
}

describe("isDiscordWebhookUrl", () => {
	it("matches all four Discord webhook hosts with the /api/webhooks/ path", () => {
		for (const host of [
			"discord.com",
			"discordapp.com",
			"ptb.discord.com",
			"canary.discord.com",
		]) {
			const url = new URL(`https://${host}/api/webhooks/123/token-abc`);
			expect(isDiscordWebhookUrl(url)).toBe(true);
		}
	});

	it("rejects a non-Discord host", () => {
		const url = new URL("https://example.com/api/webhooks/123/token-abc");
		expect(isDiscordWebhookUrl(url)).toBe(false);
	});

	it("rejects a Discord host with a non-webhook path", () => {
		const url = new URL("https://discord.com/api/v10/channels/123/messages");
		expect(isDiscordWebhookUrl(url)).toBe(false);
	});

	it("rejects a lookalike host that merely ends with discord.com", () => {
		const url = new URL("https://evil-discord.com/api/webhooks/123/token");
		expect(isDiscordWebhookUrl(url)).toBe(false);
	});
});

describe("buildDiscordAlertContent / buildDiscordWebhookBody", () => {
	it("renders affected thing, observation, unknown impact, action and evidence without raw numerical details", () => {
		const content = buildDiscordAlertContent(BASE_ALERT);
		const lines = content.split("\n");
		expect(lines[0]).toContain("**");
		expect(lines[0]).toContain("WARNING");
		expect(lines[0]).toContain("capacity");
		expect(content).not.toContain(BASE_ALERT.message);
		expect(content).toContain("acct-1");
		expect(content).toContain("claude-opus-4-8");
		expect(content).toContain("Impact:");
		expect(content).toContain("unknown");
		expect(content).toContain("Action:");
		expect(content).toContain("Evidence:");
		expect(content).not.toContain("92");
		expect(content).not.toContain("80");
	});

	it("renders a named account as 'account <name>' on the Affected line", () => {
		const content = buildDiscordAlertContent({
			...BASE_ALERT,
			type: "model_routing_drift",
			account: "work-pro",
		});
		expect(content).toContain("account work-pro");
	});

	it("regression #471: confirmed exhausted capacity is not rendered as a projection", () => {
		const content = buildDiscordAlertContent({
			...BASE_ALERT,
			type: "usage_window_exhaustion_projected",
			value: 100,
			severity: "critical",
		});
		expect(content).toContain("fully exhausted");
		expect(content).not.toContain("projected");
		expect(content).toContain("fallback");
	});

	it("regression #471: bounded account labels never split Unicode surrogate pairs", () => {
		const content = buildDiscordAlertContent({
			...BASE_ALERT,
			account: `${"a".repeat(159)}\u{1F600}suffix`,
		});
		expect(hasUnpairedSurrogate(content)).toBe(false);
	});

	it("omits account/model/value lines when the alert doesn't carry them", () => {
		const content = buildDiscordAlertContent({
			...BASE_ALERT,
			account: null,
			model: null,
			value: null,
			threshold: null,
		});
		expect(content).not.toContain("Account:");
		expect(content).not.toContain("Model:");
		expect(content).not.toContain("Value:");
	});

	it("builds the Discord body with content + allowed_mentions.parse: []", () => {
		const body = buildDiscordWebhookBody(BASE_ALERT);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		expect(typeof body.content).toBe("string");
		expect(body.content.length).toBeGreaterThan(0);
	});
});

describe("truncateToCodepoints", () => {
	it("leaves content at or under the limit untouched", () => {
		const text = "x".repeat(2000);
		const result = truncateToCodepoints(text, 2000);
		expect(result.text).toBe(text);
		expect(result.omittedCount).toBe(0);
	});

	it("truncates content one codepoint over the limit and states the omitted count", () => {
		const text = "x".repeat(2001);
		const result = truncateToCodepoints(text, 2000);
		expect(Array.from(result.text).length).toBeLessThanOrEqual(2000);
		expect(result.omittedCount).toBeGreaterThan(0);
		expect(result.text).toContain(String(result.omittedCount));
		expect(result.text.toLowerCase()).toContain("truncat");
	});

	it("never splits a surrogate pair when the cut falls on a multibyte (astral) character", () => {
		// U+1F600 GRINNING FACE is one codepoint but two UTF-16 code units.
		// Placing it exactly at codepoint index 1999 means a naive
		// `.slice(0, 2000)` over UTF-16 *units* (instead of codepoints) would
		// cut the pair in half, leaving a lone high surrogate at position
		// 1999-2000. A codepoint-correct implementation keeps the emoji
		// whole (or drops it whole) and never produces an unpaired half.
		const emoji = "\u{1F600}";
		const text = `${"a".repeat(1999)}${emoji}${"a".repeat(50)}`; // 2050 codepoints
		expect(Array.from(text).length).toBe(2050);

		const result = truncateToCodepoints(text, 2000);

		expect(hasUnpairedSurrogate(result.text)).toBe(false);
		expect(Array.from(result.text).length).toBeLessThanOrEqual(2000);
		expect(result.omittedCount).toBeGreaterThanOrEqual(50);
		expect(result.text).toContain(String(result.omittedCount));
	});

	it("never exceeds the codepoint cap even after appending the marker", () => {
		const text = "y".repeat(5000);
		const result = truncateToCodepoints(text, 2000);
		expect(Array.from(result.text).length).toBeLessThanOrEqual(2000);
	});
});

describe("isAlertTypeAllowedForWebhook", () => {
	it("allows every type when the allowlist is empty", () => {
		expect(isAlertTypeAllowedForWebhook("auth_failure", [])).toBe(true);
		expect(isAlertTypeAllowedForWebhook("model_routing_drift", [])).toBe(true);
	});

	it("allows only listed types when the allowlist is non-empty", () => {
		const allowed: readonly AlertType[] = ["auth_failure"];
		expect(isAlertTypeAllowedForWebhook("auth_failure", allowed)).toBe(true);
		expect(isAlertTypeAllowedForWebhook("model_routing_drift", allowed)).toBe(
			false,
		);
	});
});

describe("human webhook admission", () => {
	const discord = "https://discord.com/api/webhooks/1/test";
	it("preserves exact explicit opt-in and generic legacy admission for observations", () => {
		for (const type of [
			"cache_efficiency_low",
			"cache_efficiency_critical",
			"cache_efficiency_recovered",
			"model_routing_drift",
		] as const) {
			const alert: AlertEvent = {
				...BASE_ALERT,
				type,
				id: "model_routing_drift:unknown_model:opus:1",
			};
			expect(isAlertAllowedForWebhook(alert, discord, [type])).toBe(true);
			expect(isAlertAllowedForWebhook(alert, discord, ["auth_failure"])).toBe(
				false,
			);
			expect(
				isAlertAllowedForWebhook(alert, "https://example.com/hook", []),
			).toBe(true);
		}
	});
	it("classifies independent telemetry recovery from metadata and the legacy structured ID, never from titles", () => {
		const recovered: AlertEvent = {
			...BASE_ALERT,
			type: "cache_efficiency_recovered",
			title: "Unknown model requested",
			id: JSON.stringify([
				"cache-health",
				"scope",
				"telemetry",
				1,
				"recovered",
				1,
			]),
		};
		expect(isAlertAllowedForWebhook(recovered, discord, [])).toBe(true);
		expect(
			isAlertAllowedForWebhook(
				{
					...recovered,
					id: "new-id",
					classification: { reason: "cache_telemetry", phase: "recovered" },
				},
				discord,
				[],
			),
		).toBe(true);
		expect(
			isAlertAllowedForWebhook(
				{
					...recovered,
					classification: { reason: "cache_efficiency", phase: "recovered" },
				},
				discord,
				[],
			),
		).toBe(false);
		expect(
			isAlertAllowedForWebhook(
				{
					...BASE_ALERT,
					type: "model_routing_drift",
					title: "Unknown model requested",
					id: "model_routing_drift:stale_policy:opus:1",
				},
				discord,
				[],
			),
		).toBe(true);
		expect(
			isAlertAllowedForWebhook(
				{
					...BASE_ALERT,
					type: "model_routing_drift",
					id: "new-observation-id",
					classification: { reason: "unknown_model" },
				},
				discord,
				[],
			),
		).toBe(false);
		expect(
			isAlertAllowedForWebhook(
				{
					...BASE_ALERT,
					type: "model_routing_drift",
					id: "unclassified-legacy",
				},
				discord,
				[],
			),
		).toBe(true);
	});
	it("keeps UUIDs, floats, raw token tables and accidental mentions out of human content", () => {
		const body = buildDiscordWebhookBody({
			...BASE_ALERT,
			account: "550e8400-e29b-41d4-a716-446655440000 @everyone @here",
			message: "input_tokens: 123456; reuse 0.123456789",
			value: 0.123456789,
		});
		expect(body.content).not.toContain("550e8400");
		expect(body.content).not.toContain("0.123456789");
		expect(body.content).not.toContain("input_tokens");
		expect(body.content).not.toContain("@everyone");
		expect(body.content).not.toContain("@here");
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});
});

describe("deliverAlertWebhook", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends the Discord-shaped body and an explicit User-Agent to a Discord URL", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		await deliverAlertWebhook(
			"https://discord.com/api/webhooks/123/token-abc",
			BASE_ALERT,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://discord.com/api/webhooks/123/token-abc");
		const headers = new Headers(init.headers);
		expect(headers.get("User-Agent")).toBe("better-ccflare-alerts/1.0");
		expect(headers.get("Content-Type")).toBe("application/json");
		const parsed = JSON.parse(String(init.body));
		expect(parsed.allowed_mentions).toEqual({ parse: [] });
		expect(typeof parsed.content).toBe("string");
	});

	it("keeps the legacy {type,alert} body for a non-Discord URL, but still sets User-Agent", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 200 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		await deliverAlertWebhook("https://example.com/hook", BASE_ALERT);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = new Headers(init.headers);
		expect(headers.get("User-Agent")).toBe("better-ccflare-alerts/1.0");
		const parsed = JSON.parse(String(init.body));
		expect(parsed).toEqual({ type: "alert", alert: BASE_ALERT });
	});

	it("publication classification never changes the generic webhook body", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		await deliverAlertWebhook("https://example.com/hook", {
			...BASE_ALERT,
			classification: { reason: "unknown_model" },
		});
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({
			type: "alert",
			alert: BASE_ALERT,
		});
	});

	it("logs a warning with the status code on a non-2xx response, without leaking the URL, and never throws", async () => {
		const fetchMock = mock(
			async () => new Response("forbidden", { status: 403 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const { logs, stop } = collectWarnLogs();

		try {
			await expect(
				deliverAlertWebhook(
					"https://discord.com/api/webhooks/123/super-secret-token",
					BASE_ALERT,
				),
			).resolves.toBeUndefined();

			const relevant = logs.filter((l) => l.msg.includes("403"));
			expect(relevant.length).toBeGreaterThan(0);
			for (const l of logs) {
				expect(l.msg).not.toContain("super-secret-token");
				expect(l.msg).not.toContain("discord.com/api/webhooks");
			}
		} finally {
			stop();
		}
	});

	it("never throws when the fetch itself rejects (network error)", async () => {
		const fetchMock = mock(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;

		await expect(
			deliverAlertWebhook("https://example.com/hook", BASE_ALERT),
		).resolves.toBeUndefined();
	});

	it("does not leak the configured URL or its secret token when the URL fails to parse", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const { logs, stop } = collectWarnLogs();

		try {
			// Missing scheme: WHATWG URL parsing throws, and both Bun's and
			// Node's error message embeds the entire original input string —
			// including the secret token in the path.
			await expect(
				deliverAlertWebhook(
					"discord.com/api/webhooks/123/SUPER-SECRET-TOKEN-ABC",
					BASE_ALERT,
				),
			).resolves.toBeUndefined();

			expect(fetchMock).not.toHaveBeenCalled();
			expect(logs.length).toBeGreaterThan(0);
			for (const l of logs) {
				expect(l.msg).not.toContain("SUPER-SECRET-TOKEN-ABC");
				expect(l.msg).not.toContain("discord.com/api/webhooks");
			}
		} finally {
			stop();
		}
	});
});

describe("AlertService webhook wiring (end-to-end)", () => {
	function makeConfig(
		overrides: Partial<{ webhookUrl: string; webhookTypes: AlertType[] }> = {},
	): Config {
		const store = new Map<string, string | number | boolean>();
		return Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertUsageWindowThresholdPercent: () => 0,
			getAlertAnomalyEnabled: () => false,
			getAlertAnomalyIntervalMinutes: () => 15,
			getAlertAnomalyBaselineWindowMinutes: () => 1440,
			getAlertAnomalyLoopMinRequests: () => 25,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () =>
				overrides.webhookUrl ?? "https://discord.com/api/webhooks/1/tok",
			getAlertWebhookTypes: () => overrides.webhookTypes ?? [],
			get: (
				key: string,
				defaultValue?: string | number | boolean,
			): string | number | boolean | undefined => {
				if (store.has(key)) return store.get(key);
				if (defaultValue !== undefined) {
					store.set(key, defaultValue);
					return defaultValue;
				}
				return undefined;
			},
			set: (key: string, value: string | number | boolean): void => {
				store.set(key, value);
			},
		}) as unknown as Config;
	}

	async function waitFor(predicate: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (predicate()) return;
			await Bun.sleep(5);
		}
		throw new Error("Timed out waiting for alert processing");
	}

	let sqlite: Database;
	let service: AlertService;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		service.stop();
		globalThis.fetch = originalFetch;
		sqlite.close();
	});

	it("regression #471: replayed cache efficiency and unknown catalog chatter stays in history and SSE without default Discord delivery", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		const published: AlertEvent[] = [];
		const listener = (event: { payload: AlertEvent }) =>
			published.push(event.payload);
		alertEvents.on("event", listener);
		try {
			const observations: AlertEvent[] = [
				...(
					[
						"cache_efficiency_low",
						"cache_efficiency_critical",
						"cache_efficiency_recovered",
					] as const
				).map((type) => ({
					...BASE_ALERT,
					type,
					id: `${type}:efficiency:observation-1`,
				})),
				{
					...BASE_ALERT,
					type: "model_routing_drift",
					id: "model_routing_drift:unknown_model:opus:1",
				},
			];
			for (const observation of observations) {
				for (const id of [
					observation.id,
					observation.id,
					`${observation.id}:new-run`,
					`${observation.id}:next-cooldown`,
				]) {
					await (
						service as unknown as {
							persistAndEmit: (alert: AlertEvent, url: string) => Promise<void>;
						}
					).persistAndEmit(
						{ ...observation, id },
						makeConfig().getAlertWebhookUrl(),
					);
				}
			}
			expect((await service.listAlerts()).length).toBe(12);
			expect(published.length).toBe(12);
			expect(fetchMock).toHaveBeenCalledTimes(0);
		} finally {
			alertEvents.off("event", listener);
		}
	});

	it("still delivers auth, capacity, stale rewrites and independent monitoring gaps and recovery", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		const alerts: AlertEvent[] = [
			...(
				[
					"auth_failure",
					"usage_window_threshold",
					"usage_window_exhaustion_projected",
					"cache_telemetry_gap",
				] as const
			).map((type) => ({ ...BASE_ALERT, type, id: type })),
			{
				...BASE_ALERT,
				type: "model_routing_drift",
				id: "model_routing_drift:stale_policy:opus:1",
			},
			{
				...BASE_ALERT,
				type: "cache_efficiency_recovered",
				id: "telemetry-recovery",
				classification: { reason: "cache_telemetry", phase: "recovered" },
			},
		];
		for (const alert of alerts)
			await (
				service as unknown as {
					persistAndEmit: (alert: AlertEvent, url: string) => Promise<void>;
				}
			).persistAndEmit(alert, makeConfig().getAlertWebhookUrl());
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect((await service.listAlerts()).length).toBe(6);
	});

	it("explicit opt-in delivers the quiet observation while generic transport keeps its original body", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ webhookTypes: ["cache_efficiency_low"] }),
		);
		const alert: AlertEvent = {
			...BASE_ALERT,
			type: "cache_efficiency_low",
			id: "opt-in",
			message: "Raw evidence 0.123456 and input tokens 789",
		};
		const publish = (value: AlertEvent, url: string) =>
			(
				service as unknown as {
					persistAndEmit: (alert: AlertEvent, url: string) => Promise<void>;
				}
			).persistAndEmit(value, url);
		await publish(alert, makeConfig().getAlertWebhookUrl());
		await publish({ ...alert, id: "generic" }, "https://example.com/hook");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({
			type: "alert",
			alert: { ...alert, id: "generic" },
		});
		expect((await service.listAlerts())[0]?.message).toBe(alert.message);
	});

	it("documents existing delivery gap: a failed opening persists, replay does not retry, and telemetry recovery can still send", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 503 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		const publish = (value: AlertEvent) =>
			(
				service as unknown as {
					persistAndEmit: (alert: AlertEvent, url: string) => Promise<void>;
				}
			).persistAndEmit(value, makeConfig().getAlertWebhookUrl());
		const opening: AlertEvent = {
			...BASE_ALERT,
			type: "cache_telemetry_gap",
			id: "telemetry-opening",
		};
		const { logs, stop } = collectWarnLogs();
		try {
			await publish(opening);
			await publish(opening);
			await publish({
				...opening,
				type: "cache_efficiency_recovered",
				id: "telemetry-recovered",
				classification: { reason: "cache_telemetry", phase: "recovered" },
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect((await service.listAlerts()).length).toBe(2);
			expect(logs.some((event) => event.msg.includes("503"))).toBe(true);
		} finally {
			stop();
		}
	});

	it("delivers the Discord body when the type allowlist is empty (deliver all)", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		service.start();

		authFailureEvents.emit("event", {
			accountId: "account-1",
			accountName: "Backup account",
			provider: "anthropic",
			reason: "invalid_grant",
		});

		await waitFor(() => fetchMock.mock.calls.length === 1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const parsed = JSON.parse(String(init.body));
		expect(parsed.allowed_mentions).toEqual({ parse: [] });
		expect(parsed.content).toContain("authentication failed");
	});

	it("suppresses delivery for a type not on the allowlist, without affecting persistence", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		service = new AlertService(
			new BunSqlAdapter(sqlite),
			makeConfig({ webhookTypes: ["model_routing_drift"] }),
		);
		service.start();

		authFailureEvents.emit("event", {
			accountId: "account-1",
			accountName: "Backup account",
			provider: "anthropic",
			reason: "invalid_grant",
		});

		let alertCount = 0;
		for (let attempt = 0; attempt < 100; attempt++) {
			alertCount = (await service.listAlerts()).length;
			if (alertCount === 1) break;
			await Bun.sleep(5);
		}
		expect(alertCount).toBe(1);
		// Give any (incorrect) fire-and-forget delivery a moment to land.
		await Bun.sleep(20);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});
});
