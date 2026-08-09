import type { ServerToolReplayKeysState } from "@better-ccflare/config";
import {
	awaitServerToolReplayEnvelopeCodecReady,
	createServerToolReplayEnvelopeCodec,
	type ProviderServerToolHistoryProjector,
	type ProviderServerToolReplayIssuer,
	projectServerToolHistory,
	type ServerToolReplayEnvelopeBinding,
	type ServerToolReplayEnvelopeCodec,
	type ServerToolReplayEnvelopeKey,
	type ServerToolReplayEnvelopePayload,
	type ServerToolReplayWriterAdmission,
} from "@better-ccflare/providers";
import { opaqueRuntimeId } from "./opaque-runtime-id";

const SAFE_REPLAY_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REPLAY_KEY_BYTES = 32;
const REPLAY_AUTHORITY_TEXT_MAX_BYTES = 256;
const WRITER_ADMISSION_DISABLED = Object.freeze({ enabled: false as const });

/**
 * Reserve enough issuance counts to amortize durable coordination without
 * making crash-burn waste operationally meaningful. Unused counts are never
 * recycled, so nonce telemetry remains globally monotonic across restarts.
 */
export const SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE = 256;

export type ServerToolReplayIssuanceReservationInput = Readonly<{
	counterIdentity: string;
	reservationSize: number;
}>;

export type ServerToolReplayIssuanceReservation = Readonly<{
	counterIdentity: string;
	firstIssuanceCount: number;
	lastIssuanceCount: number;
}>;

export interface ServerToolReplayIssuanceStore {
	reserveReplayIssuanceRange(
		input: ServerToolReplayIssuanceReservationInput,
	): Promise<ServerToolReplayIssuanceReservation>;
}

export type ServerToolReplayWriterAdmissionUnavailableReason = "invalid_store";

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

export type RequestPrivateServerToolReplay = Readonly<{
	serverToolHistoryProjector: ProviderServerToolHistoryProjector;
	serverToolReplayIssuer: ProviderServerToolReplayIssuer;
}>;

export type RequestPrivateServerToolReplayBindInput = Readonly<{
	request: Request;
	apiKeyId?: string | null;
	audience: string | null;
	lineage: string | null;
}>;

export type RequestPrivateServerToolReplayResolveInput = Readonly<{
	request: Request;
	apiKeyId?: string | null;
	lineage: string | null;
}>;

type RequestPrivateServerToolReplayRecord = Readonly<{
	audience: string;
	lineage: string;
	authority: RequestPrivateServerToolReplay;
}>;

const requestPrivateServerToolReplay = new WeakMap<
	object,
	RequestPrivateServerToolReplayRecord
>();

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

function isWeakKey(value: unknown): value is object {
	return (
		(typeof value === "object" && value !== null) || typeof value === "function"
	);
}

function boundedAuthorityText(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.trim() !== value ||
		hasControlCharacter(value) ||
		new TextEncoder().encode(value).byteLength > REPLAY_AUTHORITY_TEXT_MAX_BYTES
	) {
		return null;
	}
	return value;
}

function deriveRequestAudience(
	request: Request,
	apiKeyId: string | null | undefined,
): string | null {
	if (!(request instanceof Request)) return null;
	const normalizedApiKeyId = apiKeyId?.trim() ?? "";
	if (normalizedApiKeyId.length > 0) {
		return boundedAuthorityText(`api-key-id:${normalizedApiKeyId}`);
	}

	const authorization = request.headers.get("authorization");
	const xApiKey = request.headers.get("x-api-key");
	// Without an authenticated API-key id, two credential sources do not define
	// one unambiguous replay audience even though ordinary routing has a legacy
	// precedence rule.
	if (authorization !== null && xApiKey !== null) return null;
	const credential = authorization ?? xApiKey;
	if (!credential?.trim()) return null;
	return boundedAuthorityText(
		opaqueRuntimeId("model-route-caller", credential.trim()),
	);
}

function requestLineageMatches(request: Request, lineage: string): boolean {
	return (
		request.headers.get("x-better-ccflare-keepalive") !== "true" &&
		request.headers.get("x-better-ccflare-auto-refresh") !== "true" &&
		request.headers.get("x-claude-code-session-id") === lineage
	);
}

function deepFreezeStructuredSnapshot(
	value: unknown,
	seen = new WeakSet<object>(),
): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		throw new TypeError("Invalid server-tool replay structured input");
	}
	for (const nested of Object.values(value)) {
		deepFreezeStructuredSnapshot(nested, seen);
	}
	return Object.freeze(value);
}

function snapshotStructuredInput(value: unknown): unknown {
	try {
		return deepFreezeStructuredSnapshot(structuredClone(value));
	} catch {
		throw new TypeError("Invalid server-tool replay structured input");
	}
}

function snapshotReplayBinding(
	binding: Omit<ServerToolReplayEnvelopeBinding, "audience" | "lineage">,
	audience: string,
	lineage: string,
): ServerToolReplayEnvelopeBinding {
	const snapshot = snapshotStructuredInput(binding);
	if (!isRecord(snapshot)) {
		throw new TypeError("Invalid server-tool replay binding");
	}
	return Object.freeze({
		envelopeKind: snapshot.envelopeKind,
		toolType: snapshot.toolType,
		audience,
		lineage,
		callId: snapshot.callId,
		visibleQuery: snapshot.visibleQuery,
		resultState: snapshot.resultState,
		ordinal: snapshot.ordinal,
		linkage: snapshot.linkage,
		visibleEvidence: snapshot.visibleEvidence,
	} as ServerToolReplayEnvelopeBinding);
}

function snapshotReplayPayload(
	payload: ServerToolReplayEnvelopePayload,
): ServerToolReplayEnvelopePayload {
	const snapshot = snapshotStructuredInput(payload);
	if (!isRecord(snapshot)) {
		throw new TypeError("Invalid server-tool replay payload");
	}
	return Object.freeze({
		provider: snapshot.provider,
		model: snapshot.model,
		fidelity: snapshot.fidelity,
	} as ServerToolReplayEnvelopePayload);
}

function createRequestPrivateReplayAuthority(
	codec: ServerToolReplayEnvelopeCodec,
	audience: string,
	lineage: string,
): RequestPrivateServerToolReplay | null {
	const encode = codec.encode;
	const decode = codec.decode;
	if (typeof encode !== "function" || typeof decode !== "function") return null;

	const replayContext = Object.freeze({ audience, lineage });
	const decoder = Object.freeze({
		decodeReplayToken: Object.freeze(
			(token: string, binding: ServerToolReplayEnvelopeBinding) =>
				Reflect.apply(decode, codec, [
					token,
					snapshotReplayBinding(binding, audience, lineage),
				]),
		),
	});
	const serverToolHistoryProjector: ProviderServerToolHistoryProjector =
		Object.freeze(async (messages: unknown) =>
			projectServerToolHistory({
				messages: snapshotStructuredInput(messages),
				replayContext,
				decoder,
			}),
		);
	const serverToolReplayIssuer: ProviderServerToolReplayIssuer = Object.freeze(
		async (binding, payload) =>
			Reflect.apply(encode, codec, [
				snapshotReplayBinding(binding, audience, lineage),
				snapshotReplayPayload(payload),
			]),
	);
	return Object.freeze({
		serverToolHistoryProjector,
		serverToolReplayIssuer,
	});
}

/**
 * Bind replay authority to one non-serializable request owner. The WeakMap is
 * the only link between RequestMeta and the replay codec; no secret-bearing
 * value is attached to metadata or returned from this operation.
 */
export function bindRequestPrivateServerToolReplay(
	owner: object,
	runtime: ServerToolReplayRuntimeState | undefined,
	input: RequestPrivateServerToolReplayBindInput,
): boolean {
	if (
		!isWeakKey(owner) ||
		requestPrivateServerToolReplay.has(owner) ||
		runtime?.status !== "ready" ||
		!isRecord(input) ||
		!(input.request instanceof Request)
	) {
		return false;
	}
	const audience = boundedAuthorityText(input.audience);
	const lineage = boundedAuthorityText(input.lineage);
	if (
		audience === null ||
		lineage === null ||
		deriveRequestAudience(input.request, input.apiKeyId) !== audience ||
		!requestLineageMatches(input.request, lineage)
	) {
		return false;
	}
	const authority = createRequestPrivateReplayAuthority(
		runtime.codec,
		audience,
		lineage,
	);
	if (authority === null) return false;
	requestPrivateServerToolReplay.set(
		owner,
		Object.freeze({ audience, lineage, authority }),
	);
	return true;
}

/** Revalidate trusted request identity before exposing proof-only closures. */
export function resolveRequestPrivateServerToolReplay(
	owner: object,
	input: RequestPrivateServerToolReplayResolveInput,
): RequestPrivateServerToolReplay | null {
	if (
		!isWeakKey(owner) ||
		!isRecord(input) ||
		!(input.request instanceof Request)
	) {
		return null;
	}
	const bound = requestPrivateServerToolReplay.get(owner);
	if (
		bound === undefined ||
		boundedAuthorityText(input.lineage) !== bound.lineage ||
		deriveRequestAudience(input.request, input.apiKeyId) !== bound.audience ||
		!requestLineageMatches(input.request, bound.lineage)
	) {
		return null;
	}
	return bound.authority;
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

function unavailableWriterAdmission(
	reason: ServerToolReplayWriterAdmissionUnavailableReason,
): ServerToolReplayWriterAdmissionBuildResult {
	return Object.freeze({
		status: "unavailable",
		reason,
		writerAdmission: WRITER_ADMISSION_DISABLED,
	});
}

function snapshotBoundReplayIssuanceRangeReservation(
	store: unknown,
): ServerToolReplayIssuanceStore["reserveReplayIssuanceRange"] | undefined {
	if (!isRecord(store)) return undefined;

	try {
		let owner: object | null = store;
		while (owner !== null) {
			const descriptor = Object.getOwnPropertyDescriptor(
				owner,
				"reserveReplayIssuanceRange",
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
				]) as ServerToolReplayIssuanceStore["reserveReplayIssuanceRange"];
			}
			owner = Object.getPrototypeOf(owner) as object | null;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

type AvailableReplayIssuanceRange = {
	nextIssuanceCount: number;
	lastIssuanceCount: number;
	pendingReservation?: Promise<void>;
};

function invalidReplayIssuanceRange(): Error {
	return new Error("Server-tool replay issuance range is invalid");
}

function validateReplayIssuanceRange(
	reservation: unknown,
	counterIdentity: string,
	previousLastIssuanceCount: number,
): ServerToolReplayIssuanceReservation {
	if (
		!isRecord(reservation) ||
		!hasExactProperties(reservation, [
			"counterIdentity",
			"firstIssuanceCount",
			"lastIssuanceCount",
		]) ||
		reservation.counterIdentity !== counterIdentity ||
		!Number.isSafeInteger(reservation.firstIssuanceCount) ||
		!Number.isSafeInteger(reservation.lastIssuanceCount)
	) {
		throw invalidReplayIssuanceRange();
	}
	const firstIssuanceCount = reservation.firstIssuanceCount as number;
	const lastIssuanceCount = reservation.lastIssuanceCount as number;
	if (
		firstIssuanceCount <= previousLastIssuanceCount ||
		lastIssuanceCount - firstIssuanceCount + 1 !==
			SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE
	) {
		throw invalidReplayIssuanceRange();
	}
	return Object.freeze({
		counterIdentity,
		firstIssuanceCount,
		lastIssuanceCount,
	});
}

/**
 * Adapt bounded durable range reservations to the codec's per-envelope claim
 * contract. Each counter identity owns one in-flight reservation and consumes
 * its range monotonically in process. A crash intentionally burns unused slots.
 */
export function createDurableServerToolReplayWriterAdmission(
	store: ServerToolReplayIssuanceStore,
): ServerToolReplayWriterAdmissionBuildResult {
	const reserveReplayIssuanceRange =
		snapshotBoundReplayIssuanceRangeReservation(store);
	if (reserveReplayIssuanceRange === undefined) {
		return unavailableWriterAdmission("invalid_store");
	}
	const availableRanges = new Map<string, AvailableReplayIssuanceRange>();
	const writerAdmission = Object.freeze({
		enabled: true as const,
		claimIssuance: async (
			claim: Readonly<{ counterIdentity: string; issuedAtMs: number }>,
		): Promise<number> => {
			let availableRange = availableRanges.get(claim.counterIdentity);
			if (availableRange === undefined) {
				availableRange = {
					nextIssuanceCount: 1,
					lastIssuanceCount: 0,
				};
				availableRanges.set(claim.counterIdentity, availableRange);
			}

			while (
				availableRange.nextIssuanceCount > availableRange.lastIssuanceCount
			) {
				if (availableRange.pendingReservation === undefined) {
					availableRange.pendingReservation = (async () => {
						const reservation = validateReplayIssuanceRange(
							await reserveReplayIssuanceRange(
								Object.freeze({
									counterIdentity: claim.counterIdentity,
									reservationSize: SERVER_TOOL_REPLAY_ISSUANCE_RANGE_SIZE,
								}),
							),
							claim.counterIdentity,
							availableRange.lastIssuanceCount,
						);
						availableRange.nextIssuanceCount = reservation.firstIssuanceCount;
						availableRange.lastIssuanceCount = reservation.lastIssuanceCount;
					})();
				}

				const pendingReservation = availableRange.pendingReservation;
				try {
					await pendingReservation;
				} finally {
					if (availableRange.pendingReservation === pendingReservation) {
						availableRange.pendingReservation = undefined;
					}
				}
			}

			const issuanceCount = availableRange.nextIssuanceCount;
			availableRange.nextIssuanceCount += 1;
			return issuanceCount;
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
