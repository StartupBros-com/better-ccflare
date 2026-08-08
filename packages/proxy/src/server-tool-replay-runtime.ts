import type { ServerToolReplayKeysState } from "@better-ccflare/config";
import {
	awaitServerToolReplayEnvelopeCodecReady,
	createServerToolReplayEnvelopeCodec,
	type ServerToolReplayEnvelopeCodec,
	type ServerToolReplayEnvelopeKey,
	type ServerToolReplayWriterAdmission,
} from "@better-ccflare/providers";

const SAFE_REPLAY_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REPLAY_KEY_BYTES = 32;
const REPLAY_PROVENANCE_TEXT_MAX_LENGTH = 256;
const WRITER_ADMISSION_DISABLED = Object.freeze({ enabled: false as const });

export const SERVER_TOOL_REPLAY_WRITER_REVISION =
	"bccf2.A256GCM.writer.v1" as const;
export const SERVER_TOOL_REPLAY_DECODER_REVISION =
	"bccf2.A256GCM.decoder.v1" as const;

export type ServerToolReplayWriterProvenance = Readonly<{
	writerRevision: string;
	buildSha: string | null;
	decoderRevision: string;
}>;

export type ServerToolReplayIssuanceReservationInput = Readonly<{
	counterIdentity: string;
	writerRevision: string;
	buildSha: string;
	decoderRevision: string;
	now: number;
}>;

export interface ServerToolReplayIssuanceStore {
	reserveReplayIssuance(
		input: ServerToolReplayIssuanceReservationInput,
	): Promise<Readonly<{ issuanceCount: number }>>;
}

export type ServerToolReplayWriterAdmissionUnavailableReason =
	| "invalid_store"
	| "invalid_provenance_shape"
	| "invalid_writer_revision"
	| "missing_build_sha"
	| "invalid_build_sha"
	| "invalid_decoder_revision";

export type ServerToolReplayWriterAdmissionBuildResult =
	| Readonly<{
			status: "ready";
			writerAdmission: Extract<
				ServerToolReplayWriterAdmission,
				Readonly<{ enabled: true }>
			>;
	  }>
	| Readonly<{
			status: "unavailable";
			reason: ServerToolReplayWriterAdmissionUnavailableReason;
			writerAdmission: Extract<
				ServerToolReplayWriterAdmission,
				Readonly<{ enabled: false }>
			>;
	  }>;

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

export type ServerToolReplayRuntimeOptions = Readonly<{
	writerAdmission?: ServerToolReplayWriterAdmission;
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

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
}

function isBoundedOpaqueText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= REPLAY_PROVENANCE_TEXT_MAX_LENGTH &&
		value.trim() === value &&
		!hasControlCharacter(value)
	);
}

function unavailableWriterAdmission(
	reason: ServerToolReplayWriterAdmissionUnavailableReason,
): ServerToolReplayWriterAdmissionBuildResult {
	return Object.freeze({
		status: "unavailable",
		reason,
		writerAdmission: WRITER_ADMISSION_DISABLED,
	});
}

function snapshotBoundReplayIssuanceReservation(
	store: unknown,
): ServerToolReplayIssuanceStore["reserveReplayIssuance"] | undefined {
	if (!isRecord(store)) return undefined;

	try {
		let owner: object | null = store;
		while (owner !== null) {
			const descriptor = Object.getOwnPropertyDescriptor(
				owner,
				"reserveReplayIssuance",
			);
			if (descriptor !== undefined) {
				if (
					!("value" in descriptor) ||
					typeof descriptor.value !== "function"
				) {
					return undefined;
				}
				return Reflect.apply(Function.prototype.bind, descriptor.value, [
					store,
				]) as ServerToolReplayIssuanceStore["reserveReplayIssuance"];
			}
			owner = Object.getPrototypeOf(owner) as object | null;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

/**
 * Adapt the durable issuance repository's narrow atomic reservation operation
 * to the codec writer-admission contract. Provenance is snapshotted once and
 * never participates in the aggregate counter identity.
 */
export function createDurableServerToolReplayWriterAdmission(
	store: ServerToolReplayIssuanceStore,
	provenance: ServerToolReplayWriterProvenance,
): ServerToolReplayWriterAdmissionBuildResult {
	const reserveReplayIssuance = snapshotBoundReplayIssuanceReservation(store);
	if (reserveReplayIssuance === undefined) {
		return unavailableWriterAdmission("invalid_store");
	}
	if (
		!isRecord(provenance) ||
		!hasExactProperties(provenance, [
			"buildSha",
			"decoderRevision",
			"writerRevision",
		])
	) {
		return unavailableWriterAdmission("invalid_provenance_shape");
	}

	const writerRevision = provenance.writerRevision;
	const buildSha = provenance.buildSha;
	const decoderRevision = provenance.decoderRevision;
	if (!isBoundedOpaqueText(writerRevision)) {
		return unavailableWriterAdmission("invalid_writer_revision");
	}
	if (
		buildSha === null ||
		(typeof buildSha === "string" && buildSha.toLowerCase() === "unknown")
	) {
		return unavailableWriterAdmission("missing_build_sha");
	}
	if (!isBoundedOpaqueText(buildSha)) {
		return unavailableWriterAdmission("invalid_build_sha");
	}
	if (!isBoundedOpaqueText(decoderRevision)) {
		return unavailableWriterAdmission("invalid_decoder_revision");
	}

	const frozenProvenance = Object.freeze({
		writerRevision,
		buildSha,
		decoderRevision,
	});
	const writerAdmission = Object.freeze({
		enabled: true as const,
		claimIssuance: async (
			claim: Readonly<{ counterIdentity: string; issuedAtMs: number }>,
		): Promise<number> => {
			const reservation = await reserveReplayIssuance(
				Object.freeze({
					counterIdentity: claim.counterIdentity,
					writerRevision: frozenProvenance.writerRevision,
					buildSha: frozenProvenance.buildSha,
					decoderRevision: frozenProvenance.decoderRevision,
					now: claim.issuedAtMs,
				}),
			);
			return reservation.issuanceCount;
		},
	});
	return Object.freeze({ status: "ready", writerAdmission });
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

async function composeReadyRuntime(
	state: Record<string, unknown>,
	writerAdmission: ServerToolReplayWriterAdmission,
): Promise<ServerToolReplayRuntimeState> {
	const temporaryKeyCopies: Uint8Array[] = [];
	let codec: ServerToolReplayEnvelopeCodec | undefined;
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

		codec = createServerToolReplayEnvelopeCodec({
			activeKey,
			retainedKeys,
			writerAdmission,
		});
	} catch {
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	} finally {
		for (const key of temporaryKeyCopies) key.fill(0);
	}

	try {
		await awaitServerToolReplayEnvelopeCodecReady(codec);
		return Object.freeze({ status: "ready", codec: Object.freeze(codec) });
	} catch {
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	}
}

/**
 * Convert structural, restart-scoped key configuration into a reader-only
 * replay runtime without exposing key material or key identifiers.
 */
export async function createServerToolReplayRuntime(
	keysState: ServerToolReplayKeysState,
	options: ServerToolReplayRuntimeOptions = {},
): Promise<ServerToolReplayRuntimeState> {
	try {
		const writerAdmission =
			options.writerAdmission ?? WRITER_ADMISSION_DISABLED;
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
		if (keysState.status === "ready")
			return await composeReadyRuntime(keysState, writerAdmission);
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	} catch {
		return SERVER_TOOL_REPLAY_UNAVAILABLE;
	}
}
