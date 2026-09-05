import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Account } from "../../packages/types/src/account";
import { createRoutingTerminalResponse } from "../../packages/proxy/src/handlers/routing-terminal";
import { evaluateGuardRetry } from "../ccflare-guard-policy.mjs";
import { createGuard } from "../ccflare-guard.mjs";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");

// Offline characterization of the capacity predicate established by the
// operator's Claude Code source inspection for this issue. This does not load
// Claude Code, change its settings, or claim to run its watchdog implementation.
function documentedWatchdogCapacityPredicate(
	status: number,
	errorType: string | undefined,
): boolean {
	return status === 429 || status === 529 || errorType === "overloaded_error";
}

function nativeTerminal(kind: "quota_wait" | "temporary_unavailable") {
	return createRoutingTerminalResponse({
		source: "attempts",
		accounts: [
			{
				id: "offline-native-account",
				name: "offline-native-account",
				provider: "anthropic",
				api_key: null,
				refresh_token: "offline-fixture",
				access_token: "offline-fixture",
				paused: false,
				requires_reauth: false,
				rate_limited_until: null,
			},
		] as Account[],
		capacityContext: null,
		rateLimitOutcomes: [],
		upstreamAttempts: 1,
		now: NOW,
		nativeQuotaPresentation:
			kind === "quota_wait"
				? {
						kind,
						reason: "shared_capacity",
						requestedModel: "claude-fable-5",
						family: "fable",
						comboId: "offline-native-combo",
						resetAt: NOW + 5 * 60 * 60_000,
						nextRecheckAt: NOW + 60_000,
					}
				: {
						kind,
						requestedModel: "claude-fable-5",
						family: "fable",
						comboId: "offline-native-combo",
						nextRecheckAt: NOW + 5_000,
					},
	}).response;
}

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections?.();
					server.close(() => resolve());
				}),
		),
	);
});

describe("native quota client and guard contract", () => {
	test.each([
		["quota_wait", 429, "rate_limit_error"],
		["temporary_unavailable", 529, "overloaded_error"],
	] as const)("%s reaches the documented persistent-capacity predicate", async (kind, status, type) => {
		const response = nativeTerminal(kind);
		const payload = await response.json();
		expect(response.status).toBe(status);
		expect(payload).toMatchObject({ type: "error", error: { type } });
		expect(
			documentedWatchdogCapacityPredicate(response.status, payload.error.type),
		).toBe(true);
		expect(response.headers.get("x-should-retry")).toBe("true");
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
			1,
		);
		expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(60);
		expect(response.headers.has("x-better-ccflare-pool-status")).toBe(false);
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBe(false);
	});

	test.each([
		"quota_wait",
		"temporary_unavailable",
	] as const)("%s never authorizes guard replay", async (kind) => {
		const response = nativeTerminal(kind);
		const decision = evaluateGuardRetry({
			status: response.status,
			headers: response.headers,
			bodyText: await response.text(),
			nowMs: NOW,
			allowLegacyBody: true,
		});
		expect(decision.retry).toBe(false);
		expect(decision.delayMs).toBe(0);
	});

	test.each([
		"quota_wait",
		"temporary_unavailable",
	] as const)("guard forwards %s once without sleeping until reset", async (kind) => {
		const terminal = nativeTerminal(kind);
		const payload = await terminal.text();
		let upstreamCalls = 0;
		const upstream = createServer((_req, res) => {
			upstreamCalls++;
			res.writeHead(terminal.status, Object.fromEntries(terminal.headers));
			res.end(payload);
		});
		servers.push(upstream);
		await new Promise<void>((resolve) =>
			upstream.listen(0, "127.0.0.1", resolve),
		);
		const upstreamAddress = upstream.address();
		if (!upstreamAddress || typeof upstreamAddress === "string")
			throw new Error("missing local fixture address");
		const guard = createGuard({
			listenHost: "127.0.0.1",
			listenPort: 0,
			upstreamBase: `http://127.0.0.1:${upstreamAddress.port}`,
			maxActive: 1,
			maxQueue: 1,
			maxWaitMs: 1_000,
			totalDeadlineMs: 1_000,
			retryAttemptHeadroomMs: 10,
			jitterMs: 0,
			logger: () => {},
		});
		servers.push(guard.server);
		const address = await guard.listen();
		const response = await fetch(
			`http://127.0.0.1:${address.port}/v1/messages`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "offline-mock", messages: [] }),
				signal: AbortSignal.timeout(2_000),
			},
		);
		expect(response.status).toBe(terminal.status);
		expect(await response.text()).toBe(payload);
		expect(upstreamCalls).toBe(1);
		expect(response.headers.get("retry-after")).toBe(
			terminal.headers.get("retry-after"),
		);
	});

	test.each([
		[400, "invalid_request_error"],
		[401, "authentication_error"],
		[402, "billing_error"],
		[404, "not_found_error"],
		[503, "pool_exhausted"],
		[503, "route_unavailable"],
	] as const)("HTTP %i %s is not classified as persistent capacity", (status, type) => {
		expect(documentedWatchdogCapacityPredicate(status, type)).toBe(false);
	});

	test("legacy 503 contract remains unchanged without an opt-in presentation", () => {
		const response = createRoutingTerminalResponse({
			source: "selection",
			accounts: [],
			capacityContext: null,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
			now: NOW,
		}).response;
		expect(response.status).toBe(503);
		expect(response.headers.has("x-should-retry")).toBe(false);
	});
});
