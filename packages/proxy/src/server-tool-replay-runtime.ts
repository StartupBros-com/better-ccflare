import type { ServerToolReplayKeysState } from "@better-ccflare/config";
import {
	createServerToolReplayEnvelopeCodec,
	type ServerToolReplayEnvelopeCodec,
	type ServerToolReplayEnvelopeKey,
} from "@better-ccflare/providers";

const SAFE_REPLAY_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REPLAY_KEY_BYTES = 32;
const WRITER_ADMISSION_DISABLED = Object.freeze({ enabled: false as const });

export type ServerToolReplayRuntimeState =
	| Readonly<{ status: "disabled" }>
	| Readonly<{
			status: "unavailable";
			code: "invalid_replay_key_config";
	  }>
	| Readonly<{
			status: "ready";
			codec: ServerToolReplayEnvelopeCodec;
	  }>;

const SERVER_TOOL_REPLAY_DISABLED: ServerToolReplayRuntimeState = Object.freeze(
	{
		status: "disabled",
	},
);
const SERVER_TOOL_REPLAY_UNAVAILABLE: ServerToolReplayRuntimeState =
	Object.freeze({
		status: "unavailable",
		code: "invalid_replay_key_config",
	});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactProperties(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((property, index) => property === expected[index])
	);
}

function copyKeyBytes(value: unknown): Uint8Array | undefined {
	if (!Array.isArray(value) || value.length !== REPLAY_KEY_BYTES) {
		return undefined;
	}
	for (let index = 0; index < REPLAY_KEY_BYTES; index += 1) {
		const byte = value[index];
		if (
			typeof byte !== "number" ||
			!Number.isInteger(byte) ||
			byte < 0 ||
			byte > 255
		) {
			return undefined;
		}
	}
	return Uint8Array.from(value);
}

function composeReadyRuntime(
	state: Record<string, unknown>,
): ServerToolReplayRuntimeState {
	const temporaryKeyCopies: Uint8Array[] = [];
	try {
		if (
			!hasExactProperties(state, ["activeKeyId", "keys", "status"]) ||
			typeof state.activeKeyId !== "string" ||
			!SAFE_REPLAY_KEY_ID.test(state.activeKeyId) ||
			!Array.isArray(state.keys)
		) {
			return SERVER_TOOL_REPLAY_UNAVAILABLE;
		}

		const seenIds = new Set<string>();
		let activeKey: ServerToolReplayEnvelopeKey | undefined;
		let activeRecords = 0;
		const retainedKeys: ServerToolReplayEnvelopeKey[] = [];

		for (const candidate of state.keys) {
			if (
				!isRecord(candidate) ||
				typeof candidate.id !== "string" ||
				!SAFE_REPLAY_KEY_ID.test(candidate.id) ||
				seenIds.has(candidate.id)
			) {
				return SERVER_TOOL_REPLAY_UNAVAILABLE;
			}
			seenIds.add(candidate.id);

			if (candidate.status === "revoked") {
				if (!hasExactProperties(candidate, ["id", "status"])) {
					return SERVER_TOOL_REPLAY_UNAVAILABLE;
				}
				continue;
			}
			if (
				(candidate.status !== "active" && candidate.status !== "retained") ||
				!hasExactProperties(candidate, ["id", "key", "status"])
			) {
				return SERVER_TOOL_REPLAY_UNAVAILABLE;
			}
			const key = copyKeyBytes(candidate.key);
			if (!key) return SERVER_TOOL_REPLAY_UNAVAILABLE;
			temporaryKeyCopies.push(key);
			const codecKey: ServerToolReplayEnvelopeKey = { id: candidate.id, key };

			if (candidate.status === "active") {
				activeRecords += 1;
				if (candidate.id === state.activeKeyId) activeKey = codecKey;
			} else {
				retainedKeys.push(codecKey);
			}
		}

		if (activeRecords !== 1 || activeKey === undefined) {
			return SERVER_TOOL_REPLAY_UNAVAILABLE;
		}

		const codec = createServerToolReplayEnvelopeCodec({
			activeKey,
			retainedKeys,
			writerAdmission: WRITER_ADMISSION_DISABLED,
		});
		return Object.freeze({ status: "ready", codec: Object.freeze(codec) });
	} catch {
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	} finally {
		for (const key of temporaryKeyCopies) key.fill(0);
	}
}

/**
 * Convert structural, restart-scoped key configuration into a reader-only
 * replay runtime without exposing key material or key identifiers.
 */
export function createServerToolReplayRuntime(
	keysState: ServerToolReplayKeysState,
): ServerToolReplayRuntimeState {
	try {
		if (!isRecord(keysState) || typeof keysState.status !== "string") {
			return SERVER_TOOL_REPLAY_UNAVAILABLE;
		}
		if (
			keysState.status === "disabled" &&
			hasExactProperties(keysState, ["status"])
		) {
			return SERVER_TOOL_REPLAY_DISABLED;
		}
		if (
			keysState.status === "unavailable" &&
			hasExactProperties(keysState, ["code", "status"]) &&
			keysState.code === "invalid_replay_key_config"
		) {
			return SERVER_TOOL_REPLAY_UNAVAILABLE;
		}
		if (keysState.status === "ready") return composeReadyRuntime(keysState);
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	} catch {
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	}
}
