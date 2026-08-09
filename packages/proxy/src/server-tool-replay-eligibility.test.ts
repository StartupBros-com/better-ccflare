import { describe, expect, it } from "bun:test";
import type { ServerToolRequirements } from "@better-ccflare/types";
import { evaluateServerToolReplayEligibility } from "./server-tool-replay-eligibility";
import type { ServerToolReplayRuntimeState } from "./server-tool-replay-runtime";

const REQUIREMENTS: ServerToolRequirements = Object.freeze({
	revision: 2,
	replay: Object.freeze({
		input: Object.freeze([]),
		output: Object.freeze([]),
		requiresOutputReplay: true,
	}),
});

function readyRuntime(writerStatus: "ready" | "disabled") {
	return {
		status: "ready",
		codec: {
			getWriterReadiness: () => ({ status: writerStatus }),
		},
	} as unknown as ServerToolReplayRuntimeState;
}

describe("evaluateServerToolReplayEligibility", () => {
	it("admits native replay without a proxy runtime", () => {
		expect(
			evaluateServerToolReplayEligibility(
				REQUIREMENTS,
				[],
				["native-Anthropic"],
				{ status: "disabled" },
			),
		).toEqual({ eligible: true, status: "not_required" });
	});

	it("does not require runtime merely because a proof advertises proxy input", () => {
		expect(
			evaluateServerToolReplayEligibility(
				REQUIREMENTS,
				["proxy-evidence-v1"],
				["native-Anthropic"],
				{ status: "disabled" },
			),
		).toEqual({ eligible: true, status: "not_required" });

		const proxyInputRequirements: ServerToolRequirements = {
			...REQUIREMENTS,
			replay: {
				...REQUIREMENTS.replay,
				input: ["proxy-evidence-v1"],
			},
		};
		expect(
			evaluateServerToolReplayEligibility(
				proxyInputRequirements,
				["native-Anthropic", "proxy-evidence-v1"],
				["native-Anthropic"],
				{ status: "disabled" },
			),
		).toEqual({ eligible: false, status: "input_unavailable" });
	});

	it("requires writer readiness for proxy output", () => {
		expect(
			evaluateServerToolReplayEligibility(
				REQUIREMENTS,
				[],
				["proxy-evidence-v1"],
				readyRuntime("disabled"),
			),
		).toEqual({ eligible: false, status: "output_unavailable" });
		expect(
			evaluateServerToolReplayEligibility(
				REQUIREMENTS,
				[],
				["native-Anthropic", "proxy-evidence-v1"],
				{ status: "disabled" },
			),
		).toEqual({ eligible: true, status: "not_required" });
		expect(
			evaluateServerToolReplayEligibility(
				REQUIREMENTS,
				["proxy-evidence-v1"],
				["proxy-evidence-v1"],
				readyRuntime("ready"),
			),
		).toEqual({ eligible: true, status: "ready" });
	});

	it("requires only reader readiness for historical proxy output", () => {
		const historicalProxyRequirements: ServerToolRequirements = {
			...REQUIREMENTS,
			replay: {
				input: [],
				output: ["proxy-evidence-v1"],
				requiresOutputReplay: false,
			},
		};
		expect(
			evaluateServerToolReplayEligibility(
				historicalProxyRequirements,
				[],
				["proxy-evidence-v1"],
				{ status: "disabled" },
			),
		).toEqual({ eligible: false, status: "output_unavailable" });
		expect(
			evaluateServerToolReplayEligibility(
				historicalProxyRequirements,
				[],
				["proxy-evidence-v1"],
				readyRuntime("disabled"),
			),
		).toEqual({ eligible: true, status: "ready" });
	});

	it("rejects proof modes that do not cover the request or contain invalid atoms", () => {
		const nativeInputRequirements: ServerToolRequirements = {
			...REQUIREMENTS,
			replay: { ...REQUIREMENTS.replay, input: ["native-Anthropic"] },
		};
		expect(
			evaluateServerToolReplayEligibility(
				nativeInputRequirements,
				[],
				["native-Anthropic"],
				undefined,
			),
		).toEqual({ eligible: false, status: "input_unavailable" });
		expect(
			evaluateServerToolReplayEligibility(
				REQUIREMENTS,
				["invalid" as never],
				["native-Anthropic"],
				undefined,
			),
		).toEqual({ eligible: false, status: "input_unavailable" });
	});
});
