const PROTOCOL = "bccf2" as const;
const SUITE = "A256GCM" as const;
const SCHEMA_REVISION = 2 as const;
const SOURCE_LOCATOR_REVISION = 1 as const;
const KEY_BYTES = 32;
const SOURCE_LOCATOR_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BITS = 128;
const TAG_BYTES = TAG_BITS / 8;
const DIGEST_BYTES = 32;
const MAX_TOKEN_BYTES = 4096;
const MAX_TOOL_TYPE_BYTES = 128;
const MAX_CONTEXT_BYTES = 256;
const MAX_VISIBLE_QUERY_BYTES = 8 * 1024;
const MAX_EVIDENCE = 64;
const MAX_EVIDENCE_URL_BYTES = 8 * 1024;
const MAX_EVIDENCE_TITLE_BYTES = 2 * 1024;
const MAX_EVIDENCE_CITED_TEXT_BYTES = 8 * 1024;
const MAX_EVIDENCE_PAGE_AGE_BYTES = 256;
const MAX_EVIDENCE_BYTES =
	MAX_EVIDENCE *
	(MAX_EVIDENCE_URL_BYTES +
		MAX_EVIDENCE_TITLE_BYTES +
		MAX_EVIDENCE_CITED_TEXT_BYTES +
		MAX_EVIDENCE_PAGE_AGE_BYTES);
const MAX_PAYLOAD_FIELD_BYTES = 256;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/u;
const DISALLOWED_CONTROL = /[\p{Cc}\p{Cf}]/u;
const RESULT_STATES: ReadonlySet<ServerToolReplayResultState> = new Set([
	"result",
	"empty",
	"error",
]);
const ENVELOPE_KINDS = new Set(["source", "citation"]);
const DIGEST_KEY_HKDF_SALT = "bccf2.A256GCM.replay-envelope.digest-key.salt.v1";
const DIGEST_KEY_HKDF_INFO = "bccf2.A256GCM.replay-envelope.visible-fields.v1";
const LOCATOR_KEY_HKDF_SALT =
	"bccf2.A256GCM.replay-envelope.locator-key.salt.v1";
const LOCATOR_KEY_HKDF_INFO = "bccf2.A256GCM.replay-envelope.source-locator.v1";
const FLEET_FINGERPRINT_DOMAIN =
	"better-ccflare.server-tool-replay.aes-256-gcm.fleet-key-fingerprint.v1\0";
const FLEET_FINGERPRINT_PREFIX = "better-ccflare.aes-256-gcm.keyfp.v1.";
const FLEET_ROTATION_COUNT = 2 ** 31;
const FLEET_EXHAUSTED_COUNT = 2 ** 32;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_REPLAY_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export const INVALID_SERVER_TOOL_REPLAY_ENVELOPE_CODE =
	"invalid_server_tool_replay_envelope" as const;
export const INVALID_SERVER_TOOL_REPLAY_ENVELOPE_MESSAGE =
	"Invalid server tool replay envelope." as const;
export const SERVER_TOOL_REPLAY_ADMISSION_ERROR_CODE =
	"server_tool_replay_admission_error" as const;
export const SERVER_TOOL_REPLAY_ADMISSION_ERROR_MESSAGE =
	"Server tool replay writer admission is unavailable." as const;
export const SERVER_TOOL_REPLAY_ENVELOPE_PREFIX =
	`${PROTOCOL}.${SUITE}.` as const;

export class InvalidServerToolReplayEnvelopeError extends Error {
	readonly code = INVALID_SERVER_TOOL_REPLAY_ENVELOPE_CODE;

	constructor() {
		super(INVALID_SERVER_TOOL_REPLAY_ENVELOPE_MESSAGE);
		this.name = "InvalidServerToolReplayEnvelopeError";
	}
}

export class ServerToolReplayAdmissionError extends Error {
	readonly code = SERVER_TOOL_REPLAY_ADMISSION_ERROR_CODE;

	constructor() {
		super(SERVER_TOOL_REPLAY_ADMISSION_ERROR_MESSAGE);
		this.name = "ServerToolReplayAdmissionError";
	}
}

export interface ServerToolReplayEnvelopeKey {
	readonly id: string;
	readonly key: Uint8Array;
}

export interface ServerToolReplayVisibleEvidence {
	readonly url: string;
	readonly title: string;
	readonly citedText: string;
	readonly pageAge?: string | null;
}

export type ServerToolReplayResultState = "result" | "empty" | "error";

export interface ServerToolReplayEnvelopeBinding {
	readonly envelopeKind: "source" | "citation";
	readonly toolType: string;
	readonly audience: string;
	readonly lineage: string;
	readonly callId: string;
	readonly visibleQuery: string;
	readonly resultState: ServerToolReplayResultState;
	readonly ordinal: number;
	readonly linkage: string | null;
	readonly visibleEvidence: readonly ServerToolReplayVisibleEvidence[];
}

export interface ServerToolReplayEnvelopePayload {
	readonly provider: string;
	readonly model: string;
	readonly fidelity: string;
}

export interface DecodedServerToolReplayEnvelope
	extends ServerToolReplayEnvelopeBinding,
		ServerToolReplayEnvelopePayload {
	readonly issuedAtMs: number;
}

export type ServerToolReplayEnvelopeHeader = Readonly<{
	keyId: string;
	sourceLocator: string;
}>;

export type ServerToolReplayIssuanceClaim = Readonly<{
	counterIdentity: string;
	issuedAtMs: number;
}>;

export type ServerToolReplayWriterAdmission =
	| Readonly<{ enabled: false }>
	| Readonly<{
			enabled: true;
			claimIssuance: (
				claim: ServerToolReplayIssuanceClaim,
			) => Promise<number | undefined>;
	  }>;

export type ServerToolReplayWriterReadiness = Readonly<{
	status:
		| "ready"
		| "disabled"
		| "telemetry_unavailable"
		| "rotate_required"
		| "exhausted";
}>;

export interface ServerToolReplayEnvelopeCodecOptions {
	readonly activeKey: ServerToolReplayEnvelopeKey;
	readonly retainedKeys?: readonly ServerToolReplayEnvelopeKey[];
	readonly randomBytes?: (length: number) => Uint8Array;
	readonly nowMs?: () => number;
	readonly writerAdmission?: ServerToolReplayWriterAdmission;
}

export interface ServerToolReplayEnvelopeCodec {
	getWriterReadiness(): ServerToolReplayWriterReadiness;
	encode(
		binding: ServerToolReplayEnvelopeBinding,
		payload: ServerToolReplayEnvelopePayload,
	): Promise<string>;
	decode(
		token: string,
		binding: ServerToolReplayEnvelopeBinding,
	): Promise<DecodedServerToolReplayEnvelope>;
}

const replayEnvelopeCodecReadiness = new WeakMap<
	ServerToolReplayEnvelopeCodec,
	Promise<void>
>();
const replayEnvelopeCodecCounterIdentity = new WeakMap<
	ServerToolReplayEnvelopeCodec,
	string
>();

type ImportedKey = {
	readonly id: string;
	readonly fleetFingerprint: string;
	readonly material: Promise<ImportedKeyMaterial>;
};

type ImportedKeyMaterial = Readonly<{
	encryptionKey: CryptoKey;
	digestKey: CryptoKey;
	locatorKey: CryptoKey;
}>;

type CryptoBytes = Uint8Array<ArrayBuffer>;

type CanonicalEvidence = Readonly<{
	url: string;
	title: string;
	citedText: string;
	pageAge: string | null;
}>;

type CanonicalBinding = Readonly<{
	envelopeKind: "source" | "citation";
	toolType: string;
	audience: string;
	lineage: string;
	callId: string;
	visibleQuery: string;
	resultState: ServerToolReplayResultState;
	ordinal: number;
	linkage: string | null;
	visibleEvidence: readonly CanonicalEvidence[];
	evidenceUtf8Bytes: number;
}>;

type ProtectedDigests = Readonly<{
	query: string;
	evidence: string;
}>;

type SourceLocator = Readonly<{
	text: string;
	bytes: CryptoBytes;
}>;

type ParsedWireEnvelope = Readonly<{
	keyId: string;
	sourceLocator: string;
	sourceLocatorBytes: CryptoBytes;
	nonce: CryptoBytes;
	ciphertext: CryptoBytes;
}>;

type EvidenceCounts = readonly [count: number, utf8Bytes: number];

type WriterAdmissionSnapshot =
	| Readonly<{ enabled: false }>
	| Readonly<{ enabled: true; valid: false }>
	| Readonly<{
			enabled: true;
			valid: true;
			claimIssuance: (
				claim: ServerToolReplayIssuanceClaim,
			) => Promise<number | undefined>;
	  }>;

type ParsedPlaintext = Readonly<
	ServerToolReplayEnvelopePayload & {
		issuedAtMs: number;
		digests: ProtectedDigests;
		evidenceCounts: EvidenceCounts;
	}
>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const digestKeySalt = textEncoder.encode(DIGEST_KEY_HKDF_SALT);
const digestKeyInfo = textEncoder.encode(DIGEST_KEY_HKDF_INFO);
const locatorKeySalt = textEncoder.encode(LOCATOR_KEY_HKDF_SALT);
const locatorKeyInfo = textEncoder.encode(LOCATOR_KEY_HKDF_INFO);
const fleetFingerprintDomain = textEncoder.encode(FLEET_FINGERPRINT_DOMAIN);
const writerReadiness = Object.freeze({
	ready: Object.freeze({ status: "ready" as const }),
	disabled: Object.freeze({ status: "disabled" as const }),
	telemetryUnavailable: Object.freeze({
		status: "telemetry_unavailable" as const,
	}),
	rotateRequired: Object.freeze({ status: "rotate_required" as const }),
	exhausted: Object.freeze({ status: "exhausted" as const }),
});
const disabledWriterAdmission = Object.freeze({ enabled: false as const });
const invalidWriterAdmission = Object.freeze({
	enabled: true as const,
	valid: false as const,
});

function invalidEnvelope(): InvalidServerToolReplayEnvelopeError {
	return new InvalidServerToolReplayEnvelopeError();
}

function admissionError(): ServerToolReplayAdmissionError {
	return new ServerToolReplayAdmissionError();
}

function snapshotWriterAdmission(
	options: ServerToolReplayEnvelopeCodecOptions,
): WriterAdmissionSnapshot {
	try {
		const admission: unknown = options.writerAdmission;
		if (admission === undefined) return disabledWriterAdmission;
		if (typeof admission !== "object" || admission === null) {
			return invalidWriterAdmission;
		}
		const enabled = Reflect.get(admission, "enabled");
		if (enabled === false) return disabledWriterAdmission;
		if (enabled !== true) return invalidWriterAdmission;

		const claimIssuance = Reflect.get(admission, "claimIssuance");
		if (typeof claimIssuance !== "function") {
			return invalidWriterAdmission;
		}
		return Object.freeze({
			enabled: true,
			valid: true,
			claimIssuance,
		});
	} catch {
		return invalidWriterAdmission;
	}
}

function initialWriterReadiness(
	admission: WriterAdmissionSnapshot,
): ServerToolReplayWriterReadiness {
	if (!admission.enabled) return writerReadiness.disabled;
	if (!admission.valid) return writerReadiness.telemetryUnavailable;
	return writerReadiness.ready;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (
		(typeof value !== "object" && typeof value !== "function") ||
		value === null
	)
		return false;
	try {
		return typeof Reflect.get(value, "then") === "function";
	} catch {
		return false;
	}
}

function validNowMs(nowMs: () => number): number {
	const value = nowMs();
	if (!Number.isSafeInteger(value) || value < 0) throw invalidEnvelope();
	return value;
}

function assertAuthenticatedAge(
	issuedAtMs: number,
	currentTimeMs: number,
): void {
	if (
		issuedAtMs - currentTimeMs > MAX_FUTURE_SKEW_MS ||
		currentTimeMs - issuedAtMs > MAX_REPLAY_AGE_MS
	) {
		throw invalidEnvelope();
	}
}

function copyBytes(bytes: Uint8Array): CryptoBytes {
	const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
	copy.set(bytes);
	return copy;
}

function fleetKeyFingerprint(key: CryptoBytes): string {
	const input = new Uint8Array(
		new ArrayBuffer(fleetFingerprintDomain.byteLength + key.byteLength),
	);
	input.set(fleetFingerprintDomain);
	input.set(key, fleetFingerprintDomain.byteLength);
	try {
		// The domain-separated digest is a stable, non-secret fleet identifier.
		// Neither the raw AES key nor its mutable wire key ID reaches telemetry.
		const digest = Bun.CryptoHasher.hash("sha256", input);
		if (digest.byteLength !== DIGEST_BYTES) {
			throw new TypeError("SHA-256 is required for replay fleet telemetry.");
		}
		return `${FLEET_FINGERPRINT_PREFIX}${encodeBase64Url(digest)}`;
	} finally {
		input.fill(0);
	}
}

function defaultRandomBytes(length: number): CryptoBytes {
	const bytes = new Uint8Array(new ArrayBuffer(length));
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function boundedCanonicalString(
	value: unknown,
	maxBytes: number,
	normalizeNfc: boolean,
	requireControlFree: boolean,
): Readonly<{ value: string; utf8Bytes: number }> {
	if (
		typeof value !== "string" ||
		value.length > maxBytes ||
		hasLoneSurrogate(value) ||
		(requireControlFree && DISALLOWED_CONTROL.test(value))
	) {
		throw invalidEnvelope();
	}
	const canonical = normalizeNfc ? value.normalize("NFC") : value;
	if (
		canonical.length > maxBytes ||
		hasLoneSurrogate(canonical) ||
		(requireControlFree && DISALLOWED_CONTROL.test(canonical))
	) {
		throw invalidEnvelope();
	}
	const utf8Bytes = textEncoder.encode(canonical).byteLength;
	if (utf8Bytes > maxBytes) throw invalidEnvelope();
	return Object.freeze({ value: canonical, utf8Bytes });
}

function boundedStructuralString(
	value: unknown,
	maxBytes: number,
	normalizeNfc = false,
): Readonly<{ value: string; utf8Bytes: number }> {
	return boundedCanonicalString(value, maxBytes, normalizeNfc, true);
}

function boundedVisibleString(
	value: unknown,
	maxBytes: number,
): Readonly<{ value: string; utf8Bytes: number }> {
	return boundedCanonicalString(value, maxBytes, true, false);
}

function requiredBoundedString(
	value: unknown,
	maxBytes: number,
): Readonly<{ value: string; utf8Bytes: number }> {
	const bounded = boundedStructuralString(value, maxBytes);
	if (bounded.utf8Bytes === 0) throw invalidEnvelope();
	return bounded;
}

function isResultState(value: string): value is ServerToolReplayResultState {
	return RESULT_STATES.has(value as ServerToolReplayResultState);
}

function canonicalizeBinding(
	binding: ServerToolReplayEnvelopeBinding,
): CanonicalBinding {
	if (typeof binding !== "object" || binding === null) throw invalidEnvelope();
	if (!ENVELOPE_KINDS.has(binding.envelopeKind)) throw invalidEnvelope();
	const toolType = requiredBoundedString(binding.toolType, MAX_TOOL_TYPE_BYTES);
	const audience = requiredBoundedString(binding.audience, MAX_CONTEXT_BYTES);
	const lineage = requiredBoundedString(binding.lineage, MAX_CONTEXT_BYTES);
	const callId = requiredBoundedString(binding.callId, MAX_CONTEXT_BYTES);
	const visibleQuery = boundedVisibleString(
		binding.visibleQuery,
		MAX_VISIBLE_QUERY_BYTES,
	);
	const resultState = boundedStructuralString(
		binding.resultState,
		MAX_CONTEXT_BYTES,
	);
	if (!isResultState(resultState.value)) throw invalidEnvelope();
	if (
		!Number.isSafeInteger(binding.ordinal) ||
		binding.ordinal < 0 ||
		binding.ordinal > 255
	)
		throw invalidEnvelope();
	const linkage =
		binding.linkage === null
			? null
			: boundedStructuralString(binding.linkage, MAX_CONTEXT_BYTES).value;
	if (!Array.isArray(binding.visibleEvidence)) throw invalidEnvelope();
	if (binding.visibleEvidence.length > MAX_EVIDENCE) throw invalidEnvelope();

	let evidenceUtf8Bytes = 0;
	const visibleEvidence = binding.visibleEvidence.map((evidence) => {
		if (typeof evidence !== "object" || evidence === null)
			throw invalidEnvelope();
		const url = boundedStructuralString(
			evidence.url,
			MAX_EVIDENCE_URL_BYTES,
			true,
		);
		const title = boundedVisibleString(
			evidence.title,
			MAX_EVIDENCE_TITLE_BYTES,
		);
		const citedText = boundedVisibleString(
			evidence.citedText,
			MAX_EVIDENCE_CITED_TEXT_BYTES,
		);
		const pageAge =
			evidence.pageAge === undefined || evidence.pageAge === null
				? null
				: boundedVisibleString(evidence.pageAge, MAX_EVIDENCE_PAGE_AGE_BYTES)
						.value;
		evidenceUtf8Bytes +=
			url.utf8Bytes +
			title.utf8Bytes +
			citedText.utf8Bytes +
			(pageAge === null ? 0 : textEncoder.encode(pageAge).byteLength);
		return Object.freeze({
			url: url.value,
			title: title.value,
			citedText: citedText.value,
			pageAge,
		});
	});

	return Object.freeze({
		envelopeKind: binding.envelopeKind,
		toolType: toolType.value,
		audience: audience.value,
		lineage: lineage.value,
		callId: callId.value,
		visibleQuery: visibleQuery.value,
		resultState: resultState.value,
		ordinal: binding.ordinal,
		linkage,
		visibleEvidence: Object.freeze(visibleEvidence),
		evidenceUtf8Bytes,
	});
}

function canonicalizePayload(
	payload: ServerToolReplayEnvelopePayload,
): ServerToolReplayEnvelopePayload {
	if (typeof payload !== "object" || payload === null) throw invalidEnvelope();
	const provider = boundedStructuralString(
		payload.provider,
		MAX_PAYLOAD_FIELD_BYTES,
	);
	const model = boundedStructuralString(payload.model, MAX_PAYLOAD_FIELD_BYTES);
	const fidelity = boundedStructuralString(
		payload.fidelity,
		MAX_PAYLOAD_FIELD_BYTES,
	);
	return Object.freeze({
		provider: provider.value,
		model: model.value,
		fidelity: fidelity.value,
	});
}

function aadBytes(
	keyId: string,
	sourceLocator: string,
	binding: CanonicalBinding,
	digests: ProtectedDigests,
): CryptoBytes {
	return textEncoder.encode(
		JSON.stringify([
			SCHEMA_REVISION,
			PROTOCOL,
			SUITE,
			keyId,
			sourceLocator,
			binding.envelopeKind,
			binding.toolType,
			binding.audience,
			binding.lineage,
			binding.callId,
			binding.resultState,
			binding.ordinal,
			binding.linkage,
			digests.query,
			digests.evidence,
		]),
	);
}

function plaintextBytes(
	issuedAtMs: number,
	payload: ServerToolReplayEnvelopePayload,
	digests: ProtectedDigests,
	evidenceCounts: EvidenceCounts,
): CryptoBytes {
	return textEncoder.encode(
		JSON.stringify([
			SCHEMA_REVISION,
			issuedAtMs,
			payload.provider,
			payload.model,
			payload.fidelity,
			digests.query,
			digests.evidence,
			evidenceCounts,
		]),
	);
}

function base64UrlLength(byteLength: number): number {
	return Math.ceil((byteLength * 4) / 3);
}

function predictTokenLength(keyId: string, plaintextLength: number): number {
	return (
		PROTOCOL.length +
		1 +
		SUITE.length +
		1 +
		keyId.length +
		1 +
		base64UrlLength(SOURCE_LOCATOR_BYTES) +
		1 +
		base64UrlLength(NONCE_BYTES) +
		1 +
		base64UrlLength(plaintextLength + TAG_BYTES)
	);
}

function evidenceCounts(binding: CanonicalBinding): EvidenceCounts {
	return Object.freeze([
		binding.visibleEvidence.length,
		binding.evidenceUtf8Bytes,
	]);
}

function placeholderDigests(binding: CanonicalBinding): ProtectedDigests {
	return Object.freeze({
		query: "A".repeat(base64UrlLength(DIGEST_BYTES)),
		evidence: "A".repeat(
			base64UrlLength(binding.visibleEvidence.length * DIGEST_BYTES),
		),
	});
}

async function signDigest(
	subtle: SubtleCrypto,
	digestKey: CryptoKey,
	message: readonly unknown[],
): Promise<CryptoBytes> {
	return new Uint8Array(
		await subtle.sign(
			"HMAC",
			digestKey,
			textEncoder.encode(JSON.stringify(message)),
		),
	);
}

async function protectedDigests(
	subtle: SubtleCrypto,
	digestKey: CryptoKey,
	binding: CanonicalBinding,
): Promise<ProtectedDigests> {
	const queryPromise = signDigest(subtle, digestKey, [
		SCHEMA_REVISION,
		"query",
		binding.visibleQuery,
	]);
	const evidencePromises = binding.visibleEvidence.map((evidence) =>
		signDigest(subtle, digestKey, [
			SCHEMA_REVISION,
			"evidence",
			evidence.url,
			evidence.title,
			evidence.citedText,
			evidence.pageAge,
		]),
	);
	const [query, evidence] = await Promise.all([
		queryPromise,
		Promise.all(evidencePromises),
	]);
	const packedEvidence = new Uint8Array(
		new ArrayBuffer(evidence.length * DIGEST_BYTES),
	);
	for (const [index, digest] of evidence.entries()) {
		if (digest.byteLength !== DIGEST_BYTES) throw invalidEnvelope();
		packedEvidence.set(digest, index * DIGEST_BYTES);
	}
	if (query.byteLength !== DIGEST_BYTES) throw invalidEnvelope();
	return Object.freeze({
		query: encodeBase64Url(query),
		evidence: encodeBase64Url(packedEvidence),
	});
}

async function deriveSourceLocator(
	subtle: SubtleCrypto,
	locatorKey: CryptoKey,
	binding: CanonicalBinding,
	digests: ProtectedDigests,
): Promise<SourceLocator> {
	const digest = await signDigest(subtle, locatorKey, [
		SOURCE_LOCATOR_REVISION,
		PROTOCOL,
		SUITE,
		binding.toolType,
		binding.audience,
		binding.lineage,
		binding.callId,
		digests.query,
		binding.resultState,
		binding.ordinal,
		binding.visibleEvidence.map((evidence) => [
			evidence.url,
			evidence.title,
			evidence.pageAge,
		]),
	]);
	if (digest.byteLength !== DIGEST_BYTES) throw invalidEnvelope();
	const bytes = copyBytes(digest.subarray(0, SOURCE_LOCATOR_BYTES));
	return Object.freeze({
		text: encodeBase64Url(bytes),
		bytes,
	});
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function decodeCanonicalBase64Url(value: string): CryptoBytes {
	if (
		!CANONICAL_BASE64URL.test(value) ||
		value.includes("=") ||
		value.length % 4 === 1
	) {
		throw invalidEnvelope();
	}

	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(`${base64}${padding}`);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	if (encodeBase64Url(bytes) !== value) throw invalidEnvelope();
	return bytes;
}

function parseWireEnvelope(token: string): ParsedWireEnvelope {
	if (typeof token !== "string" || token.length > MAX_TOKEN_BYTES) {
		throw invalidEnvelope();
	}
	const segments = token.split(".");
	if (segments.length !== 6) throw invalidEnvelope();
	const [
		protocol,
		suite,
		keyId,
		sourceLocator,
		nonceSegment,
		ciphertextSegment,
	] = segments;
	if (
		protocol !== PROTOCOL ||
		suite !== SUITE ||
		!keyId ||
		!SAFE_KEY_ID.test(keyId) ||
		!sourceLocator ||
		!nonceSegment ||
		!ciphertextSegment
	) {
		throw invalidEnvelope();
	}

	const sourceLocatorBytes = decodeCanonicalBase64Url(sourceLocator);
	const nonce = decodeCanonicalBase64Url(nonceSegment);
	const ciphertext = decodeCanonicalBase64Url(ciphertextSegment);
	if (
		sourceLocatorBytes.byteLength !== SOURCE_LOCATOR_BYTES ||
		nonce.byteLength !== NONCE_BYTES ||
		ciphertext.byteLength < TAG_BYTES
	) {
		throw invalidEnvelope();
	}
	return Object.freeze({
		keyId,
		sourceLocator,
		sourceLocatorBytes,
		nonce,
		ciphertext,
	});
}

export function inspectServerToolReplayEnvelopeHeader(
	token: string,
): ServerToolReplayEnvelopeHeader {
	try {
		const parsed = parseWireEnvelope(token);
		return Object.freeze({
			keyId: parsed.keyId,
			sourceLocator: parsed.sourceLocator,
		});
	} catch {
		throw invalidEnvelope();
	}
}

function decodeCanonicalDigest(
	value: unknown,
	byteLength: number,
): CryptoBytes {
	if (typeof value !== "string" || value.length !== base64UrlLength(byteLength))
		throw invalidEnvelope();
	if (byteLength === 0) {
		if (value !== "") throw invalidEnvelope();
		return new Uint8Array(new ArrayBuffer(0));
	}
	const decoded = decodeCanonicalBase64Url(value);
	if (decoded.byteLength !== byteLength) throw invalidEnvelope();
	return decoded;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

function parsePlaintext(plaintext: Uint8Array): ParsedPlaintext {
	const canonicalJson = textDecoder.decode(plaintext);
	const decoded: unknown = JSON.parse(canonicalJson);
	if (!Array.isArray(decoded) || decoded.length !== 8) throw invalidEnvelope();
	const [
		revision,
		issuedAtMs,
		provider,
		model,
		fidelity,
		queryDigest,
		evidenceDigests,
		counts,
	] = decoded;
	if (
		revision !== SCHEMA_REVISION ||
		!Number.isSafeInteger(issuedAtMs) ||
		(issuedAtMs as number) < 0 ||
		!Array.isArray(counts) ||
		counts.length !== 2 ||
		!Number.isSafeInteger(counts[0]) ||
		counts[0] < 0 ||
		counts[0] > MAX_EVIDENCE ||
		!Number.isSafeInteger(counts[1]) ||
		counts[1] < 0 ||
		counts[1] > MAX_EVIDENCE_BYTES ||
		JSON.stringify(decoded) !== canonicalJson
	) {
		throw invalidEnvelope();
	}
	const payload = canonicalizePayload({
		provider: provider as string,
		model: model as string,
		fidelity: fidelity as string,
	});
	decodeCanonicalDigest(queryDigest, DIGEST_BYTES);
	decodeCanonicalDigest(evidenceDigests, counts[0] * DIGEST_BYTES);

	return Object.freeze({
		issuedAtMs: issuedAtMs as number,
		...payload,
		digests: Object.freeze({
			query: queryDigest as string,
			evidence: evidenceDigests as string,
		}),
		evidenceCounts: Object.freeze([counts[0], counts[1]]) as EvidenceCounts,
	});
}

function assertProtectedBinding(
	parsed: ParsedPlaintext,
	recomputedDigests: ProtectedDigests,
	recomputedCounts: EvidenceCounts,
): void {
	if (
		parsed.evidenceCounts[0] !== recomputedCounts[0] ||
		parsed.evidenceCounts[1] !== recomputedCounts[1]
	) {
		throw invalidEnvelope();
	}
	const parsedQuery = decodeCanonicalDigest(parsed.digests.query, DIGEST_BYTES);
	const recomputedQuery = decodeCanonicalDigest(
		recomputedDigests.query,
		DIGEST_BYTES,
	);
	const evidenceByteLength = recomputedCounts[0] * DIGEST_BYTES;
	const parsedEvidence = decodeCanonicalDigest(
		parsed.digests.evidence,
		evidenceByteLength,
	);
	const recomputedEvidence = decodeCanonicalDigest(
		recomputedDigests.evidence,
		evidenceByteLength,
	);
	if (
		!equalBytes(parsedQuery, recomputedQuery) ||
		!equalBytes(parsedEvidence, recomputedEvidence)
	) {
		throw invalidEnvelope();
	}
}

function freezeDecoded(
	binding: CanonicalBinding,
	payload: ParsedPlaintext,
): DecodedServerToolReplayEnvelope {
	return Object.freeze({
		envelopeKind: binding.envelopeKind,
		toolType: binding.toolType,
		audience: binding.audience,
		lineage: binding.lineage,
		callId: binding.callId,
		visibleQuery: binding.visibleQuery,
		resultState: binding.resultState,
		ordinal: binding.ordinal,
		linkage: binding.linkage,
		visibleEvidence: binding.visibleEvidence,
		provider: payload.provider,
		model: payload.model,
		fidelity: payload.fidelity,
		issuedAtMs: payload.issuedAtMs,
	});
}

function validateKey(key: ServerToolReplayEnvelopeKey): void {
	if (
		typeof key !== "object" ||
		key === null ||
		typeof key.id !== "string" ||
		!SAFE_KEY_ID.test(key.id) ||
		!(key.key instanceof Uint8Array) ||
		key.key.byteLength !== KEY_BYTES
	) {
		throw new TypeError(
			"Server-tool replay keys require a safe ID and exactly 32 bytes.",
		);
	}
}

async function importEncryptionKey(
	webCrypto: Crypto,
	rawKey: CryptoBytes,
	keyUsages: KeyUsage[],
): Promise<CryptoKey> {
	try {
		return await webCrypto.subtle.importKey(
			"raw",
			rawKey,
			{ name: "AES-GCM", length: 256 },
			false,
			keyUsages,
		);
	} finally {
		rawKey.fill(0);
	}
}

async function deriveDigestKey(
	webCrypto: Crypto,
	rawKey: CryptoBytes,
): Promise<CryptoKey> {
	let rootKey: CryptoKey;
	try {
		rootKey = await webCrypto.subtle.importKey("raw", rawKey, "HKDF", false, [
			"deriveKey",
		]);
	} finally {
		rawKey.fill(0);
	}
	return webCrypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: digestKeySalt,
			info: digestKeyInfo,
		},
		rootKey,
		{ name: "HMAC", hash: "SHA-256", length: DIGEST_BYTES * 8 },
		false,
		["sign"],
	);
}

async function deriveLocatorKey(
	webCrypto: Crypto,
	rawKey: CryptoBytes,
): Promise<CryptoKey> {
	let rootKey: CryptoKey;
	try {
		rootKey = await webCrypto.subtle.importKey("raw", rawKey, "HKDF", false, [
			"deriveKey",
		]);
	} finally {
		rawKey.fill(0);
	}
	return webCrypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: locatorKeySalt,
			info: locatorKeyInfo,
		},
		rootKey,
		{ name: "HMAC", hash: "SHA-256", length: DIGEST_BYTES * 8 },
		false,
		["sign"],
	);
}

async function importKeyMaterial(
	webCrypto: Crypto,
	rawKey: CryptoBytes,
	encryptionKeyUsages: KeyUsage[],
): Promise<ImportedKeyMaterial> {
	let encryptionRawKey: CryptoBytes | undefined;
	let digestRawKey: CryptoBytes | undefined;
	let locatorRawKey: CryptoBytes | undefined;
	try {
		encryptionRawKey = copyBytes(rawKey);
		digestRawKey = copyBytes(rawKey);
		locatorRawKey = copyBytes(rawKey);
	} catch (error) {
		encryptionRawKey?.fill(0);
		digestRawKey?.fill(0);
		locatorRawKey?.fill(0);
		throw error;
	} finally {
		rawKey.fill(0);
	}

	const imports = await Promise.allSettled([
		importEncryptionKey(webCrypto, encryptionRawKey, encryptionKeyUsages),
		deriveDigestKey(webCrypto, digestRawKey),
		deriveLocatorKey(webCrypto, locatorRawKey),
	]);
	const rejectedImport = imports.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (rejectedImport) throw rejectedImport.reason;
	const [encryptionKey, digestKey, locatorKey] = imports.map(
		(result) => (result as PromiseFulfilledResult<CryptoKey>).value,
	);
	return Object.freeze({ encryptionKey, digestKey, locatorKey });
}

export async function awaitServerToolReplayEnvelopeCodecReady(
	codec: ServerToolReplayEnvelopeCodec,
): Promise<void> {
	const readiness = replayEnvelopeCodecReadiness.get(codec);
	if (!readiness) {
		throw new TypeError("Unknown server-tool replay codec instance.");
	}
	await readiness;
}

export function getServerToolReplayEnvelopeCounterIdentity(
	codec: ServerToolReplayEnvelopeCodec,
): string {
	const counterIdentity = replayEnvelopeCodecCounterIdentity.get(codec);
	if (!counterIdentity) {
		throw new TypeError("Unknown server-tool replay codec instance.");
	}
	return counterIdentity;
}

export function createServerToolReplayEnvelopeCodec(
	options: ServerToolReplayEnvelopeCodecOptions,
): ServerToolReplayEnvelopeCodec {
	if (typeof options !== "object" || options === null) {
		throw new TypeError("Server-tool replay codec options are required.");
	}

	const webCrypto = globalThis.crypto;
	if (!webCrypto?.subtle) {
		throw new TypeError("Web Crypto is required for server-tool replay.");
	}

	const configuredKeys = [options.activeKey, ...(options.retainedKeys ?? [])];
	const importedKeys = new Map<string, ImportedKey>();
	const configuredFleetFingerprints = new Set<string>();
	for (const [index, key] of configuredKeys.entries()) {
		validateKey(key);
		if (importedKeys.has(key.id)) {
			throw new TypeError("Server-tool replay key IDs must be unique.");
		}
		const rawKey = copyBytes(key.key);
		try {
			const fleetFingerprint = fleetKeyFingerprint(rawKey);
			if (configuredFleetFingerprints.has(fleetFingerprint)) {
				throw new TypeError("Server-tool replay key bytes must be unique.");
			}
			configuredFleetFingerprints.add(fleetFingerprint);
			importedKeys.set(key.id, {
				id: key.id,
				fleetFingerprint,
				material: importKeyMaterial(
					webCrypto,
					rawKey,
					index === 0 ? ["encrypt", "decrypt"] : ["decrypt"],
				),
			});
		} finally {
			rawKey.fill(0);
		}
	}

	const activeKey = importedKeys.get(options.activeKey.id);
	if (!activeKey) {
		throw new TypeError("The active server-tool replay key is required.");
	}
	const randomBytes = options.randomBytes ?? defaultRandomBytes;
	const nowMs = options.nowMs ?? Date.now;
	const writerAdmission = snapshotWriterAdmission(options);
	let currentWriterReadiness = initialWriterReadiness(writerAdmission);
	const readWriterReadiness = (): ServerToolReplayWriterReadiness =>
		currentWriterReadiness;
	const unavailableAdmissionError = (): ServerToolReplayAdmissionError => {
		currentWriterReadiness = writerReadiness.telemetryUnavailable;
		return admissionError();
	};
	const claimWriterIssuance = async (issuedAtMs: number): Promise<void> => {
		if (!writerAdmission.enabled || !writerAdmission.valid) {
			throw unavailableAdmissionError();
		}
		const claim = Object.freeze({
			counterIdentity: activeKey.fleetFingerprint,
			issuedAtMs,
		});
		let pendingClaim: unknown;
		try {
			pendingClaim = writerAdmission.claimIssuance(claim);
		} catch {
			throw unavailableAdmissionError();
		}
		if (!isPromiseLike(pendingClaim)) throw unavailableAdmissionError();

		let admittedCount: unknown;
		try {
			admittedCount = await pendingClaim;
		} catch {
			throw unavailableAdmissionError();
		}
		if (!Number.isSafeInteger(admittedCount) || (admittedCount as number) < 1) {
			throw unavailableAdmissionError();
		}
		if ((admittedCount as number) >= FLEET_EXHAUSTED_COUNT) {
			currentWriterReadiness = writerReadiness.exhausted;
			throw admissionError();
		}
		if ((admittedCount as number) >= FLEET_ROTATION_COUNT) {
			currentWriterReadiness = writerReadiness.rotateRequired;
			throw admissionError();
		}
	};

	const readiness = Promise.allSettled(
		[...importedKeys.values()].map(({ material }) => material),
	).then((results) => {
		const rejectedImport = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejectedImport) throw rejectedImport.reason;
	});
	// Direct codec construction remains synchronous. Attach a rejection handler
	// immediately so a caller that never performs I/O cannot leak an unhandled
	// background import failure; readiness callers still observe the rejection.
	void readiness.catch(() => undefined);

	const codec: ServerToolReplayEnvelopeCodec = Object.freeze({
		getWriterReadiness: readWriterReadiness,

		async encode(
			binding: ServerToolReplayEnvelopeBinding,
			payload: ServerToolReplayEnvelopePayload,
		): Promise<string> {
			if (readWriterReadiness().status !== "ready") throw admissionError();
			try {
				const canonicalBinding = canonicalizeBinding(binding);
				const canonicalPayload = canonicalizePayload(payload);
				const issuedAtMs = validNowMs(nowMs);
				const counts = evidenceCounts(canonicalBinding);
				const predictedPlaintext = plaintextBytes(
					issuedAtMs,
					canonicalPayload,
					placeholderDigests(canonicalBinding),
					counts,
				);
				const predictedLength = predictTokenLength(
					activeKey.id,
					predictedPlaintext.byteLength,
				);
				if (predictedLength > MAX_TOKEN_BYTES) throw invalidEnvelope();
				await claimWriterIssuance(issuedAtMs);
				const keyMaterial = await activeKey.material;
				const digests = await protectedDigests(
					webCrypto.subtle,
					keyMaterial.digestKey,
					canonicalBinding,
				);
				const sourceLocator = await deriveSourceLocator(
					webCrypto.subtle,
					keyMaterial.locatorKey,
					canonicalBinding,
					digests,
				);
				const plaintext = plaintextBytes(
					issuedAtMs,
					canonicalPayload,
					digests,
					counts,
				);
				if (plaintext.byteLength !== predictedPlaintext.byteLength)
					throw invalidEnvelope();
				const generatedNonce = randomBytes(NONCE_BYTES);
				if (
					!(generatedNonce instanceof Uint8Array) ||
					generatedNonce.byteLength !== NONCE_BYTES
				) {
					throw invalidEnvelope();
				}
				const nonce = copyBytes(generatedNonce);

				const ciphertext = new Uint8Array(
					await webCrypto.subtle.encrypt(
						{
							name: "AES-GCM",
							iv: nonce,
							additionalData: aadBytes(
								activeKey.id,
								sourceLocator.text,
								canonicalBinding,
								digests,
							),
							tagLength: TAG_BITS,
						},
						keyMaterial.encryptionKey,
						plaintext,
					),
				);
				const token = [
					PROTOCOL,
					SUITE,
					activeKey.id,
					sourceLocator.text,
					encodeBase64Url(nonce),
					encodeBase64Url(ciphertext),
				].join(".");
				if (token.length !== predictedLength || token.length > MAX_TOKEN_BYTES)
					throw invalidEnvelope();
				return token;
			} catch (error) {
				if (error instanceof ServerToolReplayAdmissionError) throw error;
				throw invalidEnvelope();
			}
		},

		async decode(
			token: string,
			binding: ServerToolReplayEnvelopeBinding,
		): Promise<DecodedServerToolReplayEnvelope> {
			try {
				const wire = parseWireEnvelope(token);
				const importedKey = importedKeys.get(wire.keyId);
				if (!importedKey) throw invalidEnvelope();
				const keyMaterial = await importedKey.material;
				const canonicalBinding = canonicalizeBinding(binding);
				const counts = evidenceCounts(canonicalBinding);
				const digests = await protectedDigests(
					webCrypto.subtle,
					keyMaterial.digestKey,
					canonicalBinding,
				);
				const expectedLocator = await deriveSourceLocator(
					webCrypto.subtle,
					keyMaterial.locatorKey,
					canonicalBinding,
					digests,
				);
				if (!equalBytes(wire.sourceLocatorBytes, expectedLocator.bytes)) {
					throw invalidEnvelope();
				}
				const plaintext = new Uint8Array(
					await webCrypto.subtle.decrypt(
						{
							name: "AES-GCM",
							iv: wire.nonce,
							additionalData: aadBytes(
								wire.keyId,
								wire.sourceLocator,
								canonicalBinding,
								digests,
							),
							tagLength: TAG_BITS,
						},
						keyMaterial.encryptionKey,
						wire.ciphertext,
					),
				);
				const parsed = parsePlaintext(plaintext);
				assertAuthenticatedAge(parsed.issuedAtMs, validNowMs(nowMs));
				assertProtectedBinding(parsed, digests, counts);
				return freezeDecoded(canonicalBinding, parsed);
			} catch {
				throw invalidEnvelope();
			}
		},
	});
	replayEnvelopeCodecReadiness.set(codec, readiness);
	replayEnvelopeCodecCounterIdentity.set(codec, activeKey.fleetFingerprint);
	return codec;
}
