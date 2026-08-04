import { describe, expect, it } from "bun:test";
import {
	createServerToolRoutingErrorResponse,
	ServerToolRoutingError,
} from "./server-tool-routing-errors";

const CAPABILITY_SUMMARY = Object.freeze({
	structuralCandidateCount: 4,
	provenCandidateCount: 1,
	unsupportedCandidateCount: 1,
	unknownCandidateCount: 2,
	replayIneligibleCandidateCount: 1,
	temporarilyUnavailableProvenCandidateCount: 1,
	eligibleCandidateCount: 0,
});

describe("server-tool routing errors", () => {
	it.each([
		[
			"invalid_requirement",
			400,
			"invalid_request_error",
			"server_tool_invalid_requirement",
		],
		[
			"unsupported_requirement",
			400,
			"invalid_request_error",
			"server_tool_unsupported_requirement",
		],
		[
			"no_implementation",
			503,
			"service_unavailable",
			"server_tool_capability_unavailable",
		],
		[
			"replay_unavailable",
			503,
			"service_unavailable",
			"server_tool_replay_unavailable",
		],
		["temporary_unavailable", 503, "service_unavailable", "route_unavailable"],
	] as const)("serializes %s as one stable Anthropic-compatible local error", async (reason, status, type, code) => {
		const error = new ServerToolRoutingError({
			reason,
			capabilitySummary: CAPABILITY_SUMMARY,
		});
		const response = createServerToolRoutingErrorResponse(error);

		expect(response.status).toBe(status);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type,
				code,
				reason,
				message: expect.any(String),
				capability: CAPABILITY_SUMMARY,
			},
		});
	});

	it("preserves a forced incapable tuple without exposing a substitute route", async () => {
		const error = new ServerToolRoutingError({
			reason: "forced_incapable",
			accountId: "forced-account",
			capabilitySummary: CAPABILITY_SUMMARY,
		});
		const response = createServerToolRoutingErrorResponse(error);

		expect(error.reason).toBe("forced_incapable");
		expect(error.accountId).toBe("forced-account");
		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-force-route")).toBe(
			"unavailable",
		);
		expect(await response.json()).toEqual({
			type: "error",
			error: {
				type: "force_route_unavailable",
				code: "server_tool_force_route_unavailable",
				reason: "forced_incapable",
				message: expect.any(String),
				account_id: "forced-account",
				capability: CAPABILITY_SUMMARY,
			},
		});
	});

	it.each([
		"invalid_requirement",
		"unsupported_requirement",
		"no_implementation",
		"replay_unavailable",
		"forced_incapable",
	] as const)("never marks semantic outcome %s as finitely recoverable", (reason) => {
		const response = createServerToolRoutingErrorResponse(
			new ServerToolRoutingError({
				reason,
				...(reason === "forced_incapable"
					? { accountId: "forced-account" }
					: {}),
				capabilitySummary: CAPABILITY_SUMMARY,
			}),
		);

		expect(response.headers.has("x-better-ccflare-pool-status")).toBeFalse();
		expect(response.headers.has("x-better-ccflare-recovery-scope")).toBeFalse();
		expect(response.headers.has("retry-after")).toBeFalse();
	});
});
