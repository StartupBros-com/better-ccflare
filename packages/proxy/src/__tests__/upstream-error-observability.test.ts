import { describe, expect, it } from "bun:test";
import {
	extractUpstreamErrorTelemetry,
	MAX_UPSTREAM_ERROR_OBSERVATION_BYTES,
} from "../upstream-error-observability";

describe("extractUpstreamErrorTelemetry", () => {
	it("extracts bounded type/code and transport status without retaining the message", () => {
		const result = extractUpstreamErrorTelemetry(
			JSON.stringify({
				type: "error",
				error: {
					type: "permission_error",
					code: "login_required",
					status: 403,
					message: "private account and prompt details",
				},
			}),
			403,
		);

		expect(result).toEqual({
			errorType: "permission_error",
			errorCode: "login_required",
			upstreamStatus: 403,
		});
		expect(JSON.stringify(result)).not.toContain("private account");
	});

	it("supports OpenAI/Codex-shaped error envelopes", () => {
		expect(
			extractUpstreamErrorTelemetry(
				JSON.stringify({
					error: {
						type: "invalid_request_error",
						code: "usage_not_included",
						message: "private detail",
					},
				}),
				403,
			),
		).toEqual({
			errorType: "invalid_request_error",
			errorCode: "usage_not_included",
			upstreamStatus: 403,
		});
	});

	it("drops unsafe fields and never parses an oversized body prefix", () => {
		const unsafe = extractUpstreamErrorTelemetry(
			JSON.stringify({
				error: {
					type: "permission error\nforged-log-line",
					code: "bad code\nwith controls",
					message: "private detail",
				},
			}),
			403,
		);
		expect(unsafe).toEqual({ upstreamStatus: 403 });

		const oversized = `${JSON.stringify({
			error: { type: "permission_error", code: "login_required" },
		})}${"x".repeat(MAX_UPSTREAM_ERROR_OBSERVATION_BYTES)}`;
		expect(extractUpstreamErrorTelemetry(oversized, 403)).toEqual({
			upstreamStatus: 403,
		});
	});

	it("does not emit a synthetic upstream error for non-error statuses", () => {
		expect(
			extractUpstreamErrorTelemetry(
				JSON.stringify({
					error: { type: "permission_error", code: "login_required" },
				}),
				200,
			),
		).toBeNull();
	});

	it("keeps a status-only record when a 403 has no parseable JSON body", () => {
		expect(extractUpstreamErrorTelemetry("Forbidden", 403)).toEqual({
			upstreamStatus: 403,
		});
	});
});
