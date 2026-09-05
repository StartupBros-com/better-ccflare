import { describe, expect, it } from "bun:test";
import type { NativeQuotaTerminalPresentation } from "../native-quota-policy";
import { createRoutingTerminalResponse } from "../routing-terminal";

const now = 1_800_000_000_000;
const presentation: NativeQuotaTerminalPresentation = {
	kind: "quota_wait",
	reason: "shared_capacity",
	requestedModel: "claude-fable-5",
	family: "fable",
	comboId: "native",
	resetAt: now + 5 * 60 * 60 * 1000,
	nextRecheckAt: now + 60_000,
};
const options = {
	source: "selection" as const,
	accounts: [],
	capacityContext: null,
	rateLimitOutcomes: [],
	upstreamAttempts: 0,
	now,
	nativeQuotaPresentation: presentation,
};

describe("native quota terminal presentation", () => {
	it.each([
		"selection",
		"attempts",
	] as const)("%s gives Claude Code native quota retry without guard authorization", async (source) => {
		const { response } = createRoutingTerminalResponse({ ...options, source });
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(response.headers.get("x-should-retry")).toBe("true");
		expect(response.headers.get("x-better-ccflare-pool-status")).toBeNull();
		expect(response.headers.get("x-better-ccflare-recovery-scope")).toBeNull();
		expect(
			[...response.headers.keys()].some((key) => key.startsWith("anthropic-")),
		).toBe(false);
		expect(await response.json()).toMatchObject({
			type: "error",
			error: {
				type: "rate_limit_error",
				code: "native_quota_wait",
				model: "claude-fable-5",
				family: "fable",
				combo_id: "native",
				reason: "shared_capacity",
				reset_at: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
				next_recheck_at: new Date(now + 60_000).toISOString(),
			},
		});
	});
	it.each([
		now + 1,
		now + 999999999,
		NaN,
		Infinity,
		now - 100,
	])("retry guidance %s stays finite and bounded", async (nextRecheckAt) => {
		const { response } = createRoutingTerminalResponse({
			...options,
			nativeQuotaPresentation: { ...presentation, nextRecheckAt },
		});
		const retry = Number(response.headers.get("retry-after"));
		expect(retry >= 1 && retry <= 60).toBe(true);
		const body = await response.json();
		expect(Date.parse(body.error.next_recheck_at)).toBe(now + retry * 1000);
	});
	it("temporary pre-byte availability presents an honest 529", async () => {
		const { response } = createRoutingTerminalResponse({
			...options,
			nativeQuotaPresentation: {
				kind: "temporary_unavailable",
				requestedModel: "claude-fable-5",
				family: "fable",
				comboId: "native",
				nextRecheckAt: now + 10_000,
			},
		});
		expect(response.status).toBe(529);
		expect(await response.json()).toMatchObject({
			error: {
				type: "overloaded_error",
				code: "native_route_temporarily_unavailable",
			},
		});
		expect(response.headers.get("x-should-retry")).toBe("true");
	});
	it("hosted commitment and authentication retain nonretrying precedence", () => {
		const committed = createRoutingTerminalResponse({
			...options,
			hostedDispatchState: "hosted_dispatched",
		});
		expect(committed.response.status).toBe(503);
		expect(committed.response.headers.get("retry-after")).toBeNull();
		const auth = createRoutingTerminalResponse({
			...options,
			source: "attempts",
			upstreamAttempts: 1,
			authFailureCount: 1,
		});
		expect(auth.response.status).toBe(401);
		expect(auth.response.headers.get("x-should-retry")).toBeNull();
	});
	it("legacy presentation remains 503", () => {
		expect(
			createRoutingTerminalResponse({
				...options,
				nativeQuotaPresentation: undefined,
			}).response.status,
		).toBe(503);
	});
	it("billing failures cannot become native infinite quota retries", () => {
		const { response } = createRoutingTerminalResponse({
			...options,
			source: "attempts",
			upstreamAttempts: 1,
			rateLimitOutcomes: [
				{
					accountId: "a",
					status: 402,
					scope: "account",
					family: "fable",
					attemptedModel: "claude-fable-5",
					reason: "out_of_credits",
					availableAt: now + 60000,
				},
			],
		});
		expect(response.status).not.toBe(429);
		expect(response.status).not.toBe(529);
		expect(response.headers.get("x-should-retry")).toBeNull();
	});
	it("unrepresentable reset metadata is omitted without losing bounded retry guidance", async () => {
		const { response } = createRoutingTerminalResponse({
			...options,
			nativeQuotaPresentation: { ...presentation, resetAt: 1e20 },
		});
		expect(response.status).toBe(429);
		expect((await response.json()).error.reset_at).toBeNull();
	});
});
