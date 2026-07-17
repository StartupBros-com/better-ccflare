import { describe, expect, test } from "bun:test";

import {
	DEFAULT_GUARD_POLICY_ID,
	evaluateGuardRetry,
	parseRetryAfterMs,
} from "../ccflare-guard-policy.mjs";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function evaluate({
	status = 503,
	headers = {},
	body = {
		type: "error",
		error: { type: "pool_exhausted" },
	},
}: {
	status?: number;
	headers?: Record<string, string>;
	body?: unknown;
}) {
	return evaluateGuardRetry({
		status,
		headers: new Headers(headers),
		bodyText: typeof body === "string" ? body : JSON.stringify(body),
		nowMs: NOW,
	});
}

describe("guard retry policy identity", () => {
	test("has a stable, source-controlled policy id", () => {
		expect(DEFAULT_GUARD_POLICY_ID).toBe("pool-exhaustion-finite-recovery-v1");
	});
});

describe("parseRetryAfterMs", () => {
	test("accepts positive delta-seconds and future HTTP dates", () => {
		expect(parseRetryAfterMs("2", NOW)).toBe(2_000);
		expect(
			parseRetryAfterMs("Fri, 17 Jul 2026 12:00:03 GMT", NOW),
		).toBe(3_000);
	});

	test("rejects zero, negative, malformed, and past recovery signals", () => {
		expect(parseRetryAfterMs("0", NOW)).toBeNull();
		expect(parseRetryAfterMs("-1", NOW)).toBeNull();
		expect(parseRetryAfterMs("2.5", NOW)).toBeNull();
		expect(parseRetryAfterMs("later", NOW)).toBeNull();
		expect(
			parseRetryAfterMs("Fri, 17 Jul 2026 11:59:59 GMT", NOW),
		).toBeNull();
	});
});

describe("evaluateGuardRetry", () => {
	test("retries an explicitly exhausted whole pool with Retry-After", () => {
		const decision = evaluate({
			headers: {
				"x-better-ccflare-pool-status": "exhausted",
				"retry-after": "5",
			},
		});

		expect(decision).toMatchObject({
			retry: true,
			reason: "pool_exhausted",
			delayMs: 5_000,
			recoverySource: "retry-after",
		});
	});

	test("uses the earliest finite future body recovery signal", () => {
		const decision = evaluate({
			headers: { "x-better-ccflare-pool-status": "exhausted" },
			body: {
				type: "error",
				error: {
					type: "pool_exhausted",
					next_available_at: "2026-07-17T12:00:09.000Z",
					accounts: [
						{ available_at: "invalid" },
						{ available_at: "2026-07-17T12:00:04.000Z" },
					],
				},
			},
		});

		expect(decision).toMatchObject({
			retry: true,
			delayMs: 4_000,
			recoverySource: "account.available_at",
		});
	});

	test("requires both the exact pool header and exact error type", () => {
		expect(evaluate({ headers: { "retry-after": "5" } }).retry).toBe(false);
		expect(
			evaluate({
				headers: {
					"x-better-ccflare-pool-status": "available",
					"retry-after": "5",
				},
			}).retry,
		).toBe(false);
		expect(
			evaluate({
				headers: {
					"x-better-ccflare-pool-status": "exhausted",
					"retry-after": "5",
				},
				body: { error: { type: "service_unavailable" } },
			}).retry,
		).toBe(false);
	});

	test("forwards malformed or indefinitely exhausted pool responses once", () => {
		expect(
			evaluate({
				headers: { "x-better-ccflare-pool-status": "exhausted" },
				body: "not-json",
			}).retry,
		).toBe(false);
		expect(
			evaluate({
				headers: { "x-better-ccflare-pool-status": "exhausted" },
			}).retry,
		).toBe(false);
		expect(
			evaluate({
				headers: {
					"x-better-ccflare-pool-status": "exhausted",
					"retry-after": "0",
				},
				body: {
					error: {
						type: "pool_exhausted",
						next_available_at: "2026-07-17T11:59:59.000Z",
					},
				},
			}).retry,
		).toBe(false);
	});

	test.each([
		"model_pool_exhausted",
		"route_unavailable",
		"force_route_unavailable",
	])("never retries %s", (type) => {
		expect(
			evaluate({
				headers: {
					"x-better-ccflare-pool-status": "exhausted",
					"retry-after": "5",
				},
				body: { error: { type } },
			}).retry,
		).toBe(false);
	});

	test.each([402, 429, 500, 502, 504, 529])(
		"never retries raw HTTP %i",
		(status) => {
			expect(
				evaluate({
					status,
					headers: {
						"x-better-ccflare-pool-status": "exhausted",
						"retry-after": "5",
					},
				}).retry,
			).toBe(false);
		},
	);

	test("never retries generic 503 or overload-shaped bodies", () => {
		expect(
			evaluate({
				status: 503,
				headers: { "retry-after": "5" },
				body: { error: { type: "overloaded_error" } },
			}).retry,
		).toBe(false);
		expect(
			evaluate({
				status: 503,
				headers: { "retry-after": "5" },
				body: "upstream overloaded",
			}).retry,
		).toBe(false);
	});
});
