import { describe, expect, test } from "bun:test";
import {
	RECOVERY_SCOPE_HEADER as SHARED_RECOVERY_SCOPE_HEADER,
	RECOVERY_SCOPES as SHARED_RECOVERY_SCOPES,
	RECOVERY_STATUS_EXHAUSTED as SHARED_RECOVERY_STATUS_EXHAUSTED,
	RECOVERY_STATUS_HEADER as SHARED_RECOVERY_STATUS_HEADER,
} from "../../packages/types/src/routing-recovery";

import {
	DEFAULT_GUARD_POLICY_ID,
	evaluateGuardRetry,
	parseRetryAfterMs,
	poolHeaderStatus,
	RECOVERY_SCOPE_HEADER,
	RECOVERY_SCOPES,
	RECOVERY_STATUS_EXHAUSTED,
	RECOVERY_STATUS_HEADER,
	recoveryHeaderStatus,
} from "../ccflare-guard-policy.mjs";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function evaluate({
	status = 503,
	headers = {},
	body = {
		type: "error",
		error: { type: "pool_exhausted" },
	},
	allowLegacyBody = false,
}: {
	status?: number;
	headers?: Record<string, string>;
	body?: unknown;
	allowLegacyBody?: boolean;
}) {
	return evaluateGuardRetry({
		status,
		headers: new Headers(headers),
		bodyText: typeof body === "string" ? body : JSON.stringify(body),
		nowMs: NOW,
		allowLegacyBody,
	});
}

describe("guard retry policy identity", () => {
	test("has a stable, source-controlled policy id", () => {
		expect(DEFAULT_GUARD_POLICY_ID).toBe("pool-exhaustion-finite-recovery-v1");
	});

	test("keeps standalone policy literals in parity with the shared TypeScript contract", () => {
		expect(RECOVERY_STATUS_HEADER).toBe(SHARED_RECOVERY_STATUS_HEADER);
		expect(RECOVERY_STATUS_EXHAUSTED).toBe(
			SHARED_RECOVERY_STATUS_EXHAUSTED,
		);
		expect(RECOVERY_SCOPE_HEADER).toBe(SHARED_RECOVERY_SCOPE_HEADER);
		expect(RECOVERY_SCOPES).toEqual([...SHARED_RECOVERY_SCOPES]);
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
		expect(parseRetryAfterMs("01", NOW)).toBeNull();
		expect(parseRetryAfterMs("9007199254741", NOW)).toBeNull();
		expect(parseRetryAfterMs("later", NOW)).toBeNull();
		expect(
			parseRetryAfterMs("Fri, 17 Jul 2026 11:59:59 GMT", NOW),
		).toBeNull();
	});
});

// P1 ordering: the header must be classifiable at HEADER time, before any
// body I/O, so retry authorization for a confirmed-exhausted 503 can never
// be lost to an oversized, stalled, or malformed body.
describe("poolHeaderStatus", () => {
	test("confirms exhaustion only for a 503 with the exhausted header", () => {
		expect(
			poolHeaderStatus({
				status: 503,
				headers: new Headers({ "x-better-ccflare-pool-status": "exhausted" }),
			}),
		).toBe("confirmed");
	});

	test("denies when the header is present but not exhausted", () => {
		expect(
			poolHeaderStatus({
				status: 503,
				headers: new Headers({ "x-better-ccflare-pool-status": "available" }),
			}),
		).toBe("denied");
	});

	test("reports absent when the header is missing entirely", () => {
		expect(
			poolHeaderStatus({ status: 503, headers: new Headers({}) }),
		).toBe("absent");
	});

	test("is not applicable to non-503 statuses regardless of the header", () => {
		expect(
			poolHeaderStatus({
				status: 500,
				headers: new Headers({ "x-better-ccflare-pool-status": "exhausted" }),
			}),
		).toBe("not_applicable");
	});
});

describe("recoveryHeaderStatus", () => {
	test.each(["pool", "model"] as const)(
		"confirms a trusted finite %s recovery scope",
		(scope) => {
			expect(
				recoveryHeaderStatus({
					status: 503,
					headers: new Headers({
						"x-better-ccflare-pool-status": "exhausted",
						"x-better-ccflare-recovery-scope": scope,
					}),
				}),
			).toEqual({ kind: "confirmed", scope });
		},
	);

	test("keeps marker-only responses as explicit legacy compatibility", () => {
		expect(
			recoveryHeaderStatus({
				status: 503,
				headers: new Headers({
					"x-better-ccflare-pool-status": "exhausted",
				}),
			}),
		).toEqual({ kind: "confirmed", scope: "legacy" });
	});

	test("denies an unrecognized recovery scope instead of widening trust", () => {
		expect(
			recoveryHeaderStatus({
				status: 503,
				headers: new Headers({
					"x-better-ccflare-pool-status": "exhausted",
					"x-better-ccflare-recovery-scope": "provider",
				}),
			}),
		).toEqual({ kind: "denied", scope: null });
	});

	test("denies a scope without its trusted status marker", () => {
		expect(
			recoveryHeaderStatus({
				status: 503,
				headers: new Headers({
					"x-better-ccflare-recovery-scope": "model",
				}),
			}),
		).toEqual({ kind: "denied", scope: null });
	});
});

describe("evaluateGuardRetry", () => {
	test("reports the trusted model recovery scope", () => {
		const decision = evaluate({
			headers: {
				"x-better-ccflare-pool-status": "exhausted",
				"x-better-ccflare-recovery-scope": "model",
				"retry-after": "5",
			},
		});

		expect(decision).toMatchObject({
			retry: true,
			reason: "trusted_finite_recovery",
			recoveryScope: "model",
		});
	});

	test("retries an explicitly exhausted whole pool with Retry-After", () => {
		const decision = evaluate({
			headers: {
				"x-better-ccflare-pool-status": "exhausted",
				"retry-after": "5",
			},
		});

		expect(decision).toMatchObject({
			retry: true,
			reason: "trusted_finite_recovery",
			recoveryScope: "legacy",
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

	test("treats Retry-After as a minimum while allowing a later body blocker", () => {
		const earlierBody = evaluate({
			headers: {
				"x-better-ccflare-pool-status": "exhausted",
				"retry-after": "5",
			},
			body: {
				error: {
					type: "pool_exhausted",
					next_available_at: "2026-07-17T12:00:04.000Z",
				},
			},
		});
		expect(earlierBody).toMatchObject({
			delayMs: 5_000,
			recoverySource: "retry-after",
		});

		const laterBody = evaluate({
			headers: {
				"x-better-ccflare-pool-status": "exhausted",
				"retry-after": "5",
			},
			body: {
				error: {
					type: "pool_exhausted",
					next_available_at: "2026-07-17T12:00:09.000Z",
				},
			},
		});
		expect(laterBody).toMatchObject({
			delayMs: 9_000,
			recoverySource: "error.next_available_at",
		});
	});

	// R17: the guard's stable x-better-ccflare-pool-status: exhausted header is
	// the primary, sufficient signal. Bounded structured-body detection is only
	// a rolling-upgrade fallback for when that header is absent from an older
	// proxy. Header confirmation alone is authoritative: the guard no longer
	// requires a parseable, type-matching body once the header confirms.
	test("a confirmed header retries even with a malformed body", () => {
		const decision = evaluate({
			headers: { "x-better-ccflare-pool-status": "exhausted" },
			body: "not-json",
		});
		expect(decision).toMatchObject({
			retry: true,
			reason: "trusted_finite_recovery",
		});
	});

	test("a confirmed header retries even with no body at all", () => {
		const decision = evaluate({
			headers: { "x-better-ccflare-pool-status": "exhausted" },
			body: "",
		});
		expect(decision).toMatchObject({
			retry: true,
			reason: "trusted_finite_recovery",
		});
	});

	test("a confirmed header retries even when the body disagrees, falling back to no delay", () => {
		const decision = evaluate({
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
		});
		expect(decision).toMatchObject({
			retry: true,
			reason: "trusted_finite_recovery",
			delayMs: 0,
			recoverySource: null,
		});
	});

	test("the rolling-upgrade fallback retries a legacy pool_exhausted body when the header is absent AND explicitly enabled", () => {
		const decision = evaluate({
			headers: { "retry-after": "5" },
			body: { type: "error", error: { type: "pool_exhausted" } },
			allowLegacyBody: true,
		});
		expect(decision).toMatchObject({
			retry: true,
			reason: "trusted_finite_recovery",
			recoveryScope: "legacy",
			delayMs: 5_000,
			recoverySource: "retry-after",
		});
	});

	// P1 spoofing (guard side): any upstream 503 body can be shaped like
	// pool_exhausted, which would otherwise authorize up to maxAttempts
	// replays of a possibly non-idempotent request. The legacy body-only
	// fallback is OFF by default; only the header may authorize a retry
	// unless an operator has explicitly opted into the rolling-upgrade
	// escape hatch.
	test("a legacy pool_exhausted body with the header absent never retries by default", () => {
		const decision = evaluate({
			headers: { "retry-after": "5" },
			body: { type: "error", error: { type: "pool_exhausted" } },
		});
		expect(decision).toMatchObject({
			retry: false,
			reason: "header_absent_legacy_body_disabled",
		});
	});

	test("an unconfirmed, non-absent header (e.g. available) never retries regardless of body", () => {
		expect(
			evaluate({
				headers: {
					"x-better-ccflare-pool-status": "available",
					"retry-after": "5",
				},
			}).retry,
		).toBe(false);
	});

	test("header absent and a non-pool body or status never retries", () => {
		expect(
			evaluate({
				headers: { "retry-after": "5" },
				body: { error: { type: "service_unavailable" } },
			}).retry,
		).toBe(false);
		expect(
			evaluate({
				headers: {},
				body: "not-json",
			}).retry,
		).toBe(false);
	});

	test.each([
		"model_pool_exhausted",
		"route_unavailable",
		"force_route_unavailable",
	])("never retries %s when the pool header is absent", (type) => {
		expect(
			evaluate({
				headers: { "retry-after": "5" },
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
