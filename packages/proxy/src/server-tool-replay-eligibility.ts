import type {
	ServerToolReplayAtom,
	ServerToolRequirements,
} from "@better-ccflare/types";
import type { ServerToolReplayRuntimeState } from "./server-tool-replay-runtime";

export type ServerToolReplayRuntimeStatus =
	| "not_required"
	| "ready"
	| "input_unavailable"
	| "output_unavailable";

export interface ServerToolReplayEligibility {
	readonly eligible: boolean;
	readonly status: ServerToolReplayRuntimeStatus;
}

function replayBits(atoms: readonly ServerToolReplayAtom[]): number | null {
	if (!Array.isArray(atoms)) return null;
	let bits = 0;
	for (const atom of atoms) {
		const bit =
			atom === "native-Anthropic" ? 1 : atom === "proxy-evidence-v1" ? 2 : null;
		if (bit === null) return null;
		if ((bits & bit) !== 0) return null;
		bits |= bit;
	}
	return bits;
}

function covers(
	required: readonly ServerToolReplayAtom[],
	actual: readonly ServerToolReplayAtom[],
): boolean {
	const requiredBits = replayBits(required);
	const actualBits = replayBits(actual);
	return (
		requiredBits !== null &&
		actualBits !== null &&
		(actualBits & requiredBits) === requiredBits
	);
}

function result(
	status: ServerToolReplayRuntimeStatus,
): ServerToolReplayEligibility {
	return Object.freeze({
		eligible: status === "not_required" || status === "ready",
		status,
	});
}

/**
 * One fail-closed replay-runtime policy shared by selection and final physical
 * attempt binding. It validates the proof-owned modes against the request before
 * consulting reader/writer runtime state.
 */
export function evaluateServerToolReplayEligibility(
	requirements: ServerToolRequirements,
	inputReplayMode: readonly ServerToolReplayAtom[],
	outputReplayMode: readonly ServerToolReplayAtom[],
	runtime: ServerToolReplayRuntimeState | undefined,
): ServerToolReplayEligibility {
	if (!covers(requirements.replay.input, inputReplayMode)) {
		return result("input_unavailable");
	}
	if (
		!covers(requirements.replay.output, outputReplayMode) ||
		(requirements.replay.requiresOutputReplay && outputReplayMode.length === 0)
	) {
		return result("output_unavailable");
	}

	const needsProxyInputReader =
		requirements.replay.input.includes("proxy-evidence-v1");
	const needsProxyOutputReader =
		requirements.replay.output.includes("proxy-evidence-v1");
	const needsProxyOutputWriter =
		requirements.replay.requiresOutputReplay &&
		!outputReplayMode.includes("native-Anthropic");
	if (
		!needsProxyInputReader &&
		!needsProxyOutputReader &&
		!needsProxyOutputWriter
	) {
		return result("not_required");
	}
	if (needsProxyInputReader && runtime?.status !== "ready") {
		return result("input_unavailable");
	}
	if (
		(needsProxyOutputReader || needsProxyOutputWriter) &&
		runtime?.status !== "ready"
	) {
		return result("output_unavailable");
	}
	if (needsProxyOutputWriter) {
		try {
			if (runtime?.status !== "ready") return result("output_unavailable");
			if (runtime.codec.getWriterReadiness().status !== "ready") {
				return result("output_unavailable");
			}
		} catch {
			return result("output_unavailable");
		}
	}
	return result("ready");
}
