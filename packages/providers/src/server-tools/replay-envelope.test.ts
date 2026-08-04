import { describe, expect, spyOn, test } from "bun:test";

import {
	createServerToolReplayEnvelopeCodec,
	InvalidServerToolReplayEnvelopeError,
	inspectServerToolReplayEnvelopeHeader,
	SERVER_TOOL_REPLAY_ENVELOPE_PREFIX,
	ServerToolReplayAdmissionError,
	type ServerToolReplayEnvelopeBinding,
	type ServerToolReplayEnvelopePayload,
	type ServerToolReplayWriterAdmission,
} from "./replay-envelope";

const ACTIVE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const RETAINED_KEY = Uint8Array.from(
	{ length: 32 },
	(_, index) => 0x20 + index,
);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 0x40 + index);
const FIXED_NONCE = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
const FIXED_NOW_MS = 1_700_000_000_123;
const NOOP_RECORD_ISSUED = (_keyFingerprint: string): void => undefined;
const GOLDEN_TOKEN =
	"bccf2.A256GCM.active-2026.eJ8F_ULECkFbkO5RSI0QQg.oKGio6Slpqeoqaqr.vSpQHHL7Mo9SVbfjN0vy7VyOOn_20jpOsCxB9guGQC_kVGvdwU0hUD7wbbJsHqHVZWk2BCP9bgsuKEM36yK8yYbxzQ1ild2yvYOKXbyCo4z4au7O8qXxMaQ-XMuTtm_e7NcbwkbP_ffQsHMA4cqZBUUqNZqbDNR3QpjunIUv3waSXPkaiQblTQYA3KdJe73gvoTw___4zgDjxPzwYN0fJhL0Tw";
const HKDF_SALT = "bccf2.A256GCM.replay-envelope.digest-key.salt.v1";
const HKDF_INFO = "bccf2.A256GCM.replay-envelope.visible-fields.v1";
const LOCATOR_HKDF_SALT = "bccf2.A256GCM.replay-envelope.locator-key.salt.v1";
const LOCATOR_HKDF_INFO = "bccf2.A256GCM.replay-envelope.source-locator.v1";
const FLEET_FINGERPRINT_DOMAIN =
	"better-ccflare.server-tool-replay.aes-256-gcm.fleet-key-fingerprint.v1\0";
const FLEET_FINGERPRINT_PREFIX = "better-ccflare.aes-256-gcm.keyfp.v1.";

const binding: ServerToolReplayEnvelopeBinding = {
	envelopeKind: "source",
	toolType: "web_search_20250305",
	audience: "api-key:tenant-a",
	lineage: "session:affinity-7",
	callId: "srvtoolu_01",
	visibleQuery: "weather in Miami",
	resultState: "result",
	ordinal: 2,
	linkage: "srvtoolu_00",
	visibleEvidence: [
		{
			url: "https://example.com/weather",
			title: "Miami weather",
			citedText: "Sunny and warm.",
			pageAge: "2 hours ago",
		},
	],
};

const payload: ServerToolReplayEnvelopePayload = {
	provider: "codex",
	model: "gpt-5.6",
	fidelity: "normalized",
};

function deterministicCodec(
	overrides: Partial<
		Parameters<typeof createServerToolReplayEnvelopeCodec>[0]
	> = {},
) {
	return createServerToolReplayEnvelopeCodec({
		activeKey: { id: "active-2026", key: ACTIVE_KEY },
		retainedKeys: [],
		randomBytes: () => FIXED_NONCE.slice(),
		nowMs: () => FIXED_NOW_MS,
		writerAdmission: {
			enabled: true,
			readFleetIssuedCount: () => 0,
			recordIssued: NOOP_RECORD_ISSUED,
		},
		...overrides,
	});
}

async function captureInvalid(operation: () => Promise<unknown>) {
	try {
		await operation();
		throw new Error("expected replay envelope rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(InvalidServerToolReplayEnvelopeError);
		expect(error).toMatchObject({
			name: "InvalidServerToolReplayEnvelopeError",
			code: "invalid_server_tool_replay_envelope",
			message: "Invalid server tool replay envelope.",
		});
		return error as InvalidServerToolReplayEnvelopeError;
	}
}

async function captureAdmission(operation: () => Promise<unknown>) {
	try {
		await operation();
		throw new Error("expected replay writer admission rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(ServerToolReplayAdmissionError);
		expect(error).toMatchObject({
			name: "ServerToolReplayAdmissionError",
			code: "server_tool_replay_admission_error",
			message: "Server tool replay writer admission is unavailable.",
		});
		return error as ServerToolReplayAdmissionError;
	}
}

function captureInvalidHeader(operation: () => unknown) {
	try {
		operation();
		throw new Error("expected replay envelope header rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(InvalidServerToolReplayEnvelopeError);
		expect(error).toMatchObject({
			name: "InvalidServerToolReplayEnvelopeError",
			code: "invalid_server_tool_replay_envelope",
			message: "Invalid server tool replay envelope.",
		});
		return error as InvalidServerToolReplayEnvelopeError;
	}
}

function encodeBase64UrlForVector(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

async function independentlyFingerprintFleetKey(
	key: Uint8Array,
): Promise<string> {
	const domain = new TextEncoder().encode(FLEET_FINGERPRINT_DOMAIN);
	const input = new Uint8Array(domain.byteLength + key.byteLength);
	input.set(domain);
	input.set(key, domain.byteLength);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
	return `${FLEET_FINGERPRINT_PREFIX}${encodeBase64UrlForVector(digest)}`;
}

function decodeBase64UrlForVector(value: string): Uint8Array {
	const binary = atob(
		`${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`,
	);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function independentlyInspectGoldenVector() {
	const encoder = new TextEncoder();
	const rootKey = await crypto.subtle.importKey(
		"raw",
		ACTIVE_KEY,
		"HKDF",
		false,
		["deriveKey"],
	);
	const digestKey = await crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: encoder.encode(HKDF_SALT),
			info: encoder.encode(HKDF_INFO),
		},
		rootKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		true,
		["sign"],
	);
	const locatorKey = await crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: encoder.encode(LOCATOR_HKDF_SALT),
			info: encoder.encode(LOCATOR_HKDF_INFO),
		},
		rootKey,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		true,
		["sign"],
	);
	const derivedKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", digestKey),
	);
	const derivedLocatorKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", locatorKey),
	);
	const queryMessage = encoder.encode(
		JSON.stringify([2, "query", binding.visibleQuery.normalize("NFC")]),
	);
	const evidence = binding.visibleEvidence[0];
	if (!evidence) throw new Error("golden evidence is required");
	const evidenceMessage = encoder.encode(
		JSON.stringify([
			2,
			"evidence",
			evidence.url.normalize("NFC"),
			evidence.title.normalize("NFC"),
			evidence.citedText.normalize("NFC"),
			evidence.pageAge?.normalize("NFC") ?? null,
		]),
	);
	const queryDigest = new Uint8Array(
		await crypto.subtle.sign("HMAC", digestKey, queryMessage),
	);
	const evidenceDigest = new Uint8Array(
		await crypto.subtle.sign("HMAC", digestKey, evidenceMessage),
	);
	const queryDigestText = encodeBase64UrlForVector(queryDigest);
	const evidenceDigestsText = encodeBase64UrlForVector(evidenceDigest);
	const locatorMessage = encoder.encode(
		JSON.stringify([
			1,
			"bccf2",
			"A256GCM",
			binding.toolType,
			binding.audience,
			binding.lineage,
			binding.callId,
			queryDigestText,
			binding.resultState,
			binding.ordinal,
			binding.visibleEvidence.map((source) => [
				source.url.normalize("NFC"),
				source.title.normalize("NFC"),
				source.pageAge?.normalize("NFC") ?? null,
			]),
		]),
	);
	const locatorDigest = new Uint8Array(
		await crypto.subtle.sign("HMAC", locatorKey, locatorMessage),
	);
	const sourceLocator = locatorDigest.slice(0, 16);
	const sourceLocatorText = encodeBase64UrlForVector(sourceLocator);
	const aadJson = JSON.stringify([
		2,
		"bccf2",
		"A256GCM",
		"active-2026",
		sourceLocatorText,
		binding.envelopeKind,
		binding.toolType,
		binding.audience,
		binding.lineage,
		binding.callId,
		binding.resultState,
		binding.ordinal,
		binding.linkage,
		queryDigestText,
		evidenceDigestsText,
	]);
	const [, , , locatorSegment, nonceSegment, ciphertextSegment] =
		GOLDEN_TOKEN.split(".");
	if (!locatorSegment || !nonceSegment || !ciphertextSegment)
		throw new Error("golden token is malformed");
	if (locatorSegment !== sourceLocatorText)
		throw new Error("golden locator does not match the independent derivation");
	const aesKey = await crypto.subtle.importKey(
		"raw",
		ACTIVE_KEY,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const plaintext = new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: decodeBase64UrlForVector(nonceSegment),
				additionalData: encoder.encode(aadJson),
				tagLength: 128,
			},
			aesKey,
			decodeBase64UrlForVector(ciphertextSegment),
		),
	);

	return {
		derivedKey,
		derivedLocatorKey,
		queryMessage,
		queryDigest,
		evidenceMessage,
		evidenceDigest,
		locatorMessage,
		locatorDigest,
		sourceLocator,
		aad: encoder.encode(aadJson),
		plaintext,
	};
}

async function sealWithGoldenAad(
	aad: Uint8Array,
	plaintext: Uint8Array,
): Promise<string> {
	const [, , , sourceLocator] = GOLDEN_TOKEN.split(".");
	if (!sourceLocator) throw new Error("golden locator is required");
	const key = await crypto.subtle.importKey(
		"raw",
		ACTIVE_KEY,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: FIXED_NONCE,
				additionalData: aad,
				tagLength: 128,
			},
			key,
			plaintext,
		),
	);
	return [
		"bccf2",
		"A256GCM",
		"active-2026",
		sourceLocator,
		encodeBase64UrlForVector(FIXED_NONCE),
		encodeBase64UrlForVector(ciphertext),
	].join(".");
}

describe("server-tool replay envelope", () => {
	test("projects a frozen bounded bccf2 header without key lookup", async () => {
		expect(SERVER_TOOL_REPLAY_ENVELOPE_PREFIX).toBe("bccf2.A256GCM.");
		const token = await deterministicCodec().encode(binding, payload);
		const header = inspectServerToolReplayEnvelopeHeader(token);
		expect(token.startsWith(SERVER_TOOL_REPLAY_ENVELOPE_PREFIX)).toBe(true);
		expect(token.split(".")).toHaveLength(6);
		expect(header).toEqual({
			keyId: "active-2026",
			sourceLocator: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u),
		});
		expect(Object.keys(header)).toEqual(["keyId", "sourceLocator"]);
		expect(Object.isFrozen(header)).toBe(true);

		const segments = token.split(".");
		segments[2] = "not-configured";
		expect(inspectServerToolReplayEnvelopeHeader(segments.join("."))).toEqual({
			keyId: "not-configured",
			sourceLocator: header.sourceLocator,
		});
	});

	test("shares a locator across source and citation envelopes for one source", async () => {
		const sourceBinding = { ...binding, envelopeKind: "source" as const };
		const citationBinding = {
			...binding,
			envelopeKind: "citation" as const,
			linkage: "citation:7",
			visibleEvidence: binding.visibleEvidence.map((evidence) => ({
				...evidence,
				citedText: "A different citation excerpt.",
			})),
		};
		const codec = deterministicCodec();
		const sourceToken = await codec.encode(sourceBinding, payload);
		const citationToken = await codec.encode(citationBinding, payload);
		const relabeledCodec = deterministicCodec({
			activeKey: { id: "same-key-new-label", key: ACTIVE_KEY },
			randomBytes: () => new Uint8Array(12).fill(0x5a),
			nowMs: () => FIXED_NOW_MS + 999,
		});
		const relabeledToken = await relabeledCodec.encode(citationBinding, {
			provider: "different-provider",
			model: "different-model",
			fidelity: "different-fidelity",
		});

		const sourceLocator =
			inspectServerToolReplayEnvelopeHeader(sourceToken).sourceLocator;
		expect(
			inspectServerToolReplayEnvelopeHeader(citationToken).sourceLocator,
		).toBe(sourceLocator);
		expect(
			inspectServerToolReplayEnvelopeHeader(relabeledToken).sourceLocator,
		).toBe(sourceLocator);
		expect(sourceToken).not.toBe(citationToken);
		expect(citationToken).not.toBe(relabeledToken);
	});

	test("separates duplicate source metadata by exact call and source ordinal", async () => {
		const codec = deterministicCodec();
		const locators = await Promise.all(
			[
				binding,
				{ ...binding, callId: "srvtoolu_duplicate_call" },
				{ ...binding, ordinal: binding.ordinal + 1 },
			].map(
				async (candidate) =>
					inspectServerToolReplayEnvelopeHeader(
						await codec.encode(candidate, payload),
					).sourceLocator,
			),
		);

		expect(new Set(locators).size).toBe(3);
	});

	test("rejects locator tamper before one-decrypt validation and authenticates kind", async () => {
		const codec = deterministicCodec();
		const token = await codec.encode(binding, payload);
		const segments = token.split(".");
		segments[3] = encodeBase64UrlForVector(new Uint8Array(16).fill(0xff));
		const tamperedLocator = segments.join(".");
		const decrypt = spyOn(crypto.subtle, "decrypt");

		try {
			await captureInvalid(() => codec.decode(tamperedLocator, binding));
			expect(decrypt).not.toHaveBeenCalled();
			await expect(codec.decode(token, binding)).resolves.toMatchObject(
				payload,
			);
			expect(decrypt).toHaveBeenCalledTimes(1);
			await captureInvalid(() =>
				codec.decode(token, { ...binding, envelopeKind: "citation" }),
			);
			expect(decrypt).toHaveBeenCalledTimes(2);
		} finally {
			decrypt.mockRestore();
		}
	});

	test("uniformly rejects malformed, legacy, and unknown replay headers", async () => {
		const token = await deterministicCodec().encode(binding, payload);
		const [protocol, suite, keyId, locator, nonce, ciphertext] =
			token.split(".");
		if (!protocol || !suite || !keyId || !locator || !nonce || !ciphertext) {
			throw new Error("fixed token is malformed");
		}
		const canonicalZeroLocator = encodeBase64UrlForVector(new Uint8Array(16));
		const invalidTokens = [
			token.replace(/^bccf2\./u, "bccf1."),
			token.replace(/^bccf2\./u, "bccf9."),
			[protocol, suite, keyId, nonce, ciphertext].join("."),
			[protocol, suite, keyId, locator, nonce, ciphertext, "extra"].join("."),
			[protocol, suite, "-unsafe", locator, nonce, ciphertext].join("."),
			[protocol, suite, keyId, `${locator}=`, nonce, ciphertext].join("."),
			[
				protocol,
				suite,
				keyId,
				`${canonicalZeroLocator.slice(0, -1)}B`,
				nonce,
				ciphertext,
			].join("."),
			[
				protocol,
				suite,
				keyId,
				encodeBase64UrlForVector(new Uint8Array(15)),
				nonce,
				ciphertext,
			].join("."),
			[
				protocol,
				suite,
				keyId,
				locator,
				encodeBase64UrlForVector(new Uint8Array(11)),
				ciphertext,
			].join("."),
			[
				protocol,
				suite,
				keyId,
				locator,
				nonce,
				encodeBase64UrlForVector(new Uint8Array(15)),
			].join("."),
			`${token}${"A".repeat(4097)}`,
		];
		captureInvalidHeader(() =>
			inspectServerToolReplayEnvelopeHeader(undefined as unknown as string),
		);

		for (const invalidToken of invalidTokens) {
			captureInvalidHeader(() =>
				inspectServerToolReplayEnvelopeHeader(invalidToken),
			);
			await captureInvalid(() =>
				deterministicCodec().decode(invalidToken, binding),
			);
		}
	});

	test("keeps omitted and disabled writers reader-capable while failing encode closed", async () => {
		const codecs = [
			createServerToolReplayEnvelopeCodec({
				activeKey: { id: "active-2026", key: ACTIVE_KEY },
				randomBytes: () => {
					throw new Error("reader-only codec must not request entropy");
				},
			}),
			createServerToolReplayEnvelopeCodec({
				activeKey: { id: "active-2026", key: ACTIVE_KEY },
				randomBytes: () => {
					throw new Error("disabled codec must not request entropy");
				},
				writerAdmission: { enabled: false },
			}),
		];

		for (const codec of codecs) {
			const readiness = codec.getWriterReadiness();
			expect(readiness).toEqual({ status: "disabled" });
			expect(Object.keys(readiness)).toEqual(["status"]);
			expect(Object.isFrozen(readiness)).toBe(true);
			expect(await codec.decode(GOLDEN_TOKEN, binding)).toMatchObject(payload);
			await captureAdmission(() => codec.encode(binding, payload));
		}
	});

	test.each([
		["missing", undefined],
		["negative", -1],
		["fractional", 0.5],
		["NaN", Number.NaN],
		["infinite", Number.POSITIVE_INFINITY],
		["unsafe", Number.MAX_SAFE_INTEGER + 1],
	] as const)("fails closed when fleet telemetry is %s", async (_label, count) => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => count,
				recordIssued: NOOP_RECORD_ISSUED,
			},
		});

		expect(codec.getWriterReadiness()).toEqual({
			status: "telemetry_unavailable",
		});
		await captureAdmission(() => codec.encode(binding, payload));
		expect(randomCalls).toBe(0);
	});

	test("keys fleet telemetry by stable key-material fingerprint rather than wire key ID", async () => {
		const readFingerprints: string[] = [];
		const recordedFingerprints: string[] = [];
		const writerAdmission: ServerToolReplayWriterAdmission = {
			enabled: true,
			readFleetIssuedCount: (fingerprint) => {
				readFingerprints.push(fingerprint);
				return 0;
			},
			recordIssued: (fingerprint) => {
				recordedFingerprints.push(fingerprint);
			},
		};
		for (const id of ["first-label", "second-label"]) {
			const codec = createServerToolReplayEnvelopeCodec({
				activeKey: { id, key: ACTIVE_KEY },
				randomBytes: () => FIXED_NONCE.slice(),
				nowMs: () => FIXED_NOW_MS,
				writerAdmission,
			});
			await codec.encode(binding, payload);
		}

		const expectedFingerprint =
			await independentlyFingerprintFleetKey(ACTIVE_KEY);
		expect(readFingerprints).toEqual([
			expectedFingerprint,
			expectedFingerprint,
		]);
		expect(recordedFingerprints).toEqual([
			expectedFingerprint,
			expectedFingerprint,
		]);
		expect(expectedFingerprint).toMatch(
			/^better-ccflare\.aes-256-gcm\.keyfp\.v1\.[A-Za-z0-9_-]{43}$/u,
		);
		expect(expectedFingerprint).not.toContain("bccf2");
		expect(expectedFingerprint).not.toContain("A256GCM");
		expect([...readFingerprints, ...recordedFingerprints]).not.toContain(
			"first-label",
		);
		expect([...readFingerprints, ...recordedFingerprints]).not.toContain(
			"second-label",
		);
	});

	test("rejects duplicate configured key material even when IDs differ", () => {
		expect(() =>
			createServerToolReplayEnvelopeCodec({
				activeKey: { id: "active", key: ACTIVE_KEY },
				retainedKeys: [{ id: "same-key-new-label", key: ACTIVE_KEY.slice() }],
			}),
		).toThrow("Server-tool replay key bytes must be unique.");
	});

	test.each([
		["missing fleet reader", undefined, NOOP_RECORD_ISSUED],
		["malformed fleet reader", "not-a-function", NOOP_RECORD_ISSUED],
		["missing fleet recorder", () => 0, undefined],
		["malformed fleet recorder", () => 0, "not-a-function"],
	] as const)("fails closed when the enabled %s is invalid", async (_label, readFleetIssuedCount, recordIssued) => {
		let randomCalls = 0;
		const writerAdmission = {
			enabled: true,
			readFleetIssuedCount,
			recordIssued,
		} as unknown as ServerToolReplayWriterAdmission;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
			writerAdmission,
		});

		expect(codec.getWriterReadiness()).toEqual({
			status: "telemetry_unavailable",
		});
		await captureAdmission(() => codec.encode(binding, payload));
		expect(randomCalls).toBe(0);
	});

	test("maps fleet-count boundaries to ready, rotate-required, and exhausted", async () => {
		let count = 2 ** 31 - 1;
		const recordedFingerprints: string[] = [];
		const expectedFingerprint =
			await independentlyFingerprintFleetKey(ACTIVE_KEY);
		const codec = deterministicCodec({
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => count,
				recordIssued: (fingerprint) => recordedFingerprints.push(fingerprint),
			},
		});

		expect(codec.getWriterReadiness()).toEqual({ status: "ready" });
		expect(await codec.encode(binding, payload)).toBe(GOLDEN_TOKEN);
		expect(recordedFingerprints).toEqual([expectedFingerprint]);

		count = 2 ** 31;
		expect(codec.getWriterReadiness()).toEqual({ status: "rotate_required" });
		await captureAdmission(() => codec.encode(binding, payload));

		count = 2 ** 32;
		expect(codec.getWriterReadiness()).toEqual({ status: "exhausted" });
		await captureAdmission(() => codec.encode(binding, payload));
		expect(recordedFingerprints).toEqual([expectedFingerprint]);
	});

	test("records exactly once after a valid token is built and sanitizes accounting failure", async () => {
		const events: string[] = [];
		const expectedFingerprint =
			await independentlyFingerprintFleetKey(ACTIVE_KEY);
		const codec = deterministicCodec({
			randomBytes: () => {
				events.push("random");
				return FIXED_NONCE.slice();
			},
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => 0,
				recordIssued: (fingerprint) => events.push(`record:${fingerprint}`),
			},
		});

		const token = await codec.encode(binding, payload);
		events.push("returned");
		expect(token).toBe(GOLDEN_TOKEN);
		expect(events).toEqual([
			"random",
			`record:${expectedFingerprint}`,
			"returned",
		]);

		let invalidBuildRecords = 0;
		const invalidBuild = deterministicCodec({
			randomBytes: () => new Uint8Array(11),
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => 0,
				recordIssued: () => {
					invalidBuildRecords += 1;
				},
			},
		});
		await captureInvalid(() => invalidBuild.encode(binding, payload));
		expect(invalidBuildRecords).toBe(0);

		const failedAccounting = deterministicCodec({
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => 0,
				recordIssued: () => {
					throw new Error("fleet-counter-secret");
				},
			},
		});
		const error = await captureAdmission(() =>
			failedAccounting.encode(binding, payload),
		);
		expect(error.message).not.toContain("fleet-counter-secret");
	});

	test("awaits asynchronous accounting and sanitizes asynchronous rejection", async () => {
		const events: string[] = [];
		let releaseAccounting = (): void => {
			throw new Error("accounting release was not initialized");
		};
		let markAccountingStarted = (): void => {
			throw new Error("accounting start was not initialized");
		};
		const accountingGate = new Promise<void>((resolve) => {
			releaseAccounting = resolve;
		});
		const accountingStarted = new Promise<void>((resolve) => {
			markAccountingStarted = resolve;
		});
		const codec = deterministicCodec({
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => 0,
				recordIssued: async () => {
					events.push("record:start");
					markAccountingStarted();
					await accountingGate;
					events.push("record:complete");
				},
			},
		});

		const tokenPromise = codec.encode(binding, payload).then((token) => {
			events.push("returned");
			return token;
		});
		await accountingStarted;
		await Promise.resolve();
		expect(events).toEqual(["record:start"]);
		releaseAccounting();
		expect(await tokenPromise).toBe(GOLDEN_TOKEN);
		expect(events).toEqual(["record:start", "record:complete", "returned"]);

		const failedAccounting = deterministicCodec({
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => 0,
				recordIssued: async () => {
					await Promise.resolve();
					throw new Error("async-fleet-counter-secret");
				},
			},
		});
		const error = await captureAdmission(() =>
			failedAccounting.encode(binding, payload),
		);
		expect(error.message).not.toContain("async-fleet-counter-secret");
	});

	test("snapshots writer admission state and callback identities at factory creation", async () => {
		const events: string[] = [];
		const mutableAdmission = {
			enabled: true,
			readFleetIssuedCount: () => {
				events.push("read:original");
				return 0;
			},
			recordIssued: () => {
				events.push("record:original");
			},
		};
		const codec = deterministicCodec({
			writerAdmission: mutableAdmission as ServerToolReplayWriterAdmission,
		});
		mutableAdmission.enabled = false;
		mutableAdmission.readFleetIssuedCount = () => {
			events.push("read:mutated");
			return 2 ** 32;
		};
		mutableAdmission.recordIssued = () => {
			events.push("record:mutated");
		};

		expect(codec.getWriterReadiness()).toEqual({ status: "ready" });
		expect(await codec.encode(binding, payload)).toBe(GOLDEN_TOKEN);
		expect(events).toEqual([
			"read:original",
			"read:original",
			"record:original",
		]);

		const originallyDisabled = {
			enabled: false,
			readFleetIssuedCount: () => 0,
			recordIssued: NOOP_RECORD_ISSUED,
		};
		const disabledCodec = deterministicCodec({
			writerAdmission:
				originallyDisabled as unknown as ServerToolReplayWriterAdmission,
		});
		originallyDisabled.enabled = true;
		expect(disabledCodec.getWriterReadiness()).toEqual({ status: "disabled" });
		await captureAdmission(() => disabledCodec.encode(binding, payload));
	});

	test("uses the rotated active key's independent fleet budget and retains old-key decode", async () => {
		const oldFingerprint = await independentlyFingerprintFleetKey(RETAINED_KEY);
		const newFingerprint = await independentlyFingerprintFleetKey(ACTIVE_KEY);
		const counts = new Map([
			[oldFingerprint, 0],
			[newFingerprint, 0],
		]);
		const reads: string[] = [];
		const writerAdmission: ServerToolReplayWriterAdmission = {
			enabled: true,
			readFleetIssuedCount: (fingerprint) => {
				reads.push(fingerprint);
				return counts.get(fingerprint);
			},
			recordIssued: NOOP_RECORD_ISSUED,
		};
		const oldWriter = createServerToolReplayEnvelopeCodec({
			activeKey: { id: "old", key: RETAINED_KEY },
			randomBytes: () => FIXED_NONCE.slice(),
			nowMs: () => FIXED_NOW_MS,
			writerAdmission,
		});
		const oldToken = await oldWriter.encode(binding, payload);
		counts.set(oldFingerprint, 2 ** 31);

		const rotated = createServerToolReplayEnvelopeCodec({
			activeKey: { id: "new", key: ACTIVE_KEY },
			retainedKeys: [{ id: "old", key: RETAINED_KEY }],
			randomBytes: () => FIXED_NONCE.slice(),
			nowMs: () => FIXED_NOW_MS,
			writerAdmission,
		});
		const readsBeforeDecode = reads.length;
		expect(await rotated.decode(oldToken, binding)).toMatchObject(payload);
		expect(reads).toHaveLength(readsBeforeDecode);
		expect(rotated.getWriterReadiness()).toEqual({ status: "ready" });
		await expect(rotated.encode(binding, payload)).resolves.toBeString();
		expect(reads.slice(readsBeforeDecode)).toEqual([
			newFingerprint,
			newFingerprint,
		]);
	});

	test("supports a reader-only restart after issuance", async () => {
		const token = await deterministicCodec().encode(binding, payload);
		const restartedReader = createServerToolReplayEnvelopeCodec({
			activeKey: { id: "replacement", key: OTHER_KEY },
			retainedKeys: [{ id: "active-2026", key: ACTIVE_KEY }],
		});

		expect(restartedReader.getWriterReadiness()).toEqual({
			status: "disabled",
		});
		expect(await restartedReader.decode(token, binding)).toMatchObject(payload);
		await captureAdmission(() => restartedReader.encode(binding, payload));
	});

	test("does not request entropy or invoke envelope crypto for blocked writers", async () => {
		const sign = spyOn(crypto.subtle, "sign");
		const encrypt = spyOn(crypto.subtle, "encrypt");
		let randomCalls = 0;
		const admissions: readonly (ServerToolReplayWriterAdmission | undefined)[] =
			[
				undefined,
				{ enabled: false },
				{
					enabled: true,
					readFleetIssuedCount: () => undefined,
					recordIssued: NOOP_RECORD_ISSUED,
				},
				{
					enabled: true,
					readFleetIssuedCount: () => 2 ** 31,
					recordIssued: NOOP_RECORD_ISSUED,
				},
				{
					enabled: true,
					readFleetIssuedCount: () => 2 ** 32,
					recordIssued: NOOP_RECORD_ISSUED,
				},
			];

		try {
			for (const writerAdmission of admissions) {
				const codec = createServerToolReplayEnvelopeCodec({
					activeKey: { id: "active-2026", key: ACTIVE_KEY },
					randomBytes: () => {
						randomCalls += 1;
						return FIXED_NONCE.slice();
					},
					...(writerAdmission ? { writerAdmission } : {}),
				});
				await captureAdmission(() => codec.encode(binding, payload));
			}
			expect(randomCalls).toBe(0);
			expect(sign).not.toHaveBeenCalled();
			expect(encrypt).not.toHaveBeenCalled();
		} finally {
			sign.mockRestore();
			encrypt.mockRestore();
		}
	});

	test("pins and independently decodes the bccf2.A256GCM wire vector", async () => {
		const independent = await independentlyInspectGoldenVector();
		expect(hex(independent.derivedKey)).toBe(
			"fe2bf62f2feae535bf94d42f74248e2c5ad58751d513e4f5be5adb28b56d9871",
		);
		expect(hex(independent.derivedLocatorKey)).toBe(
			"6884dfbf19b7f633592a680c975cd30dfd3924e8694c65ed834d046c1a8f0cde",
		);
		expect(hex(independent.queryMessage)).toBe(
			"5b322c227175657279222c227765617468657220696e204d69616d69225d",
		);
		expect(hex(independent.queryDigest)).toBe(
			"ae92c0fadba8bc788e47dcb63076d1d3d4486ae1372e8eb96848fb76128929b4",
		);
		expect(hex(independent.evidenceMessage)).toBe(
			"5b322c2265766964656e6365222c2268747470733a2f2f6578616d706c652e636f6d2f77656174686572222c224d69616d692077656174686572222c2253756e6e7920616e64207761726d2e222c223220686f7572732061676f225d",
		);
		expect(hex(independent.evidenceDigest)).toBe(
			"25c4b48846ab94d92e3dd06df9acd3e04f4e2a65b4f35cfe2963087990de6756",
		);
		expect(hex(independent.locatorMessage)).toBe(
			"5b312c226263636632222c224132353647434d222c227765625f7365617263685f3230323530333035222c226170692d6b65793a74656e616e742d61222c2273657373696f6e3a616666696e6974792d37222c22737276746f6f6c755f3031222c2272704c412d74756f7648694f523979324d48625230395249617545334c6f363561456a3764684b4a4b6251222c22726573756c74222c322c5b5b2268747470733a2f2f6578616d706c652e636f6d2f77656174686572222c224d69616d692077656174686572222c223220686f7572732061676f225d5d5d",
		);
		expect(hex(independent.locatorDigest)).toBe(
			"789f05fd42c40a415b90ee51488d1042d4dd6cffc6475d9ddf4c62a267df2da8",
		);
		expect(hex(independent.sourceLocator)).toBe(
			"789f05fd42c40a415b90ee51488d1042",
		);
		expect(hex(independent.aad)).toBe(
			"5b322c226263636632222c224132353647434d222c226163746976652d32303236222c22654a38465f554c45436b46626b4f3552534930515167222c22736f75726365222c227765625f7365617263685f3230323530333035222c226170692d6b65793a74656e616e742d61222c2273657373696f6e3a616666696e6974792d37222c22737276746f6f6c755f3031222c22726573756c74222c322c22737276746f6f6c755f3030222c2272704c412d74756f7648694f523979324d48625230395249617545334c6f363561456a3764684b4a4b6251222c224a635330694561726c4e6b75506442742d617a543445394f4b6d573038317a2d4b574d49655a44655a3159225d",
		);
		expect(hex(independent.plaintext)).toBe(
			"5b322c313730303030303030303132332c22636f646578222c226770742d352e36222c226e6f726d616c697a6564222c2272704c412d74756f7648694f523979324d48625230395249617545334c6f363561456a3764684b4a4b6251222c224a635330694561726c4e6b75506442742d617a543445394f4b6d573038317a2d4b574d49655a44655a3159222c5b312c36365d5d",
		);
		const locatorTuple = new TextDecoder().decode(independent.locatorMessage);
		expect(locatorTuple).toContain(binding.visibleEvidence[0]?.url ?? "");
		expect(locatorTuple).toContain(binding.visibleEvidence[0]?.title ?? "");
		expect(locatorTuple).not.toContain(
			binding.visibleEvidence[0]?.citedText ?? "",
		);
		expect(locatorTuple).not.toContain(binding.linkage ?? "");
		expect(locatorTuple).not.toContain(payload.provider);
		expect(new TextDecoder().decode(independent.aad)).not.toContain(
			binding.visibleQuery,
		);
		for (const value of [
			binding.visibleEvidence[0]?.url,
			binding.visibleEvidence[0]?.title,
			binding.visibleEvidence[0]?.citedText,
		]) {
			expect(new TextDecoder().decode(independent.aad)).not.toContain(
				value ?? "",
			);
		}

		const cleanReader = deterministicCodec({
			randomBytes: () => {
				throw new Error("literal-vector decode must not request entropy");
			},
			nowMs: () => 0,
		});
		expect(await cleanReader.decode(GOLDEN_TOKEN, binding)).toEqual({
			...binding,
			...payload,
			issuedAtMs: FIXED_NOW_MS,
		});
		expect(await deterministicCodec().encode(binding, payload)).toBe(
			GOLDEN_TOKEN,
		);
		expect(GOLDEN_TOKEN.split(".")).toHaveLength(6);
	});

	test("round trips every binding and protected field into a deeply frozen value", async () => {
		const codec = deterministicCodec();
		const token = await codec.encode(binding, payload);
		const decoded = await codec.decode(token, binding);

		expect(decoded).toEqual({
			...binding,
			...payload,
			issuedAtMs: FIXED_NOW_MS,
		});
		expect(Object.isFrozen(decoded)).toBe(true);
		expect(Object.isFrozen(decoded.visibleEvidence)).toBe(true);
		expect(Object.isFrozen(decoded.visibleEvidence[0])).toBe(true);
	});

	test("decodes a previous active key in clean instances regardless of retained-key order", async () => {
		const oldWriter = createServerToolReplayEnvelopeCodec({
			activeKey: { id: "old", key: RETAINED_KEY },
			retainedKeys: [],
			randomBytes: () => FIXED_NONCE.slice(),
			nowMs: () => FIXED_NOW_MS,
			writerAdmission: {
				enabled: true,
				readFleetIssuedCount: () => 0,
				recordIssued: NOOP_RECORD_ISSUED,
			},
		});
		const token = await oldWriter.encode(binding, payload);

		for (const retainedKeys of [
			[
				{ id: "other", key: OTHER_KEY },
				{ id: "old", key: RETAINED_KEY },
			],
			[
				{ id: "old", key: RETAINED_KEY },
				{ id: "other", key: OTHER_KEY },
			],
		] as const) {
			const cleanReader = createServerToolReplayEnvelopeCodec({
				activeKey: { id: "new", key: ACTIVE_KEY },
				retainedKeys,
				randomBytes: () => {
					throw new Error("decode must not request entropy");
				},
				nowMs: () => 0,
			});
			expect(await cleanReader.decode(token, binding)).toMatchObject(payload);
		}
	});

	test("requests exactly one independent 12-byte nonce per issuance", async () => {
		const requestedLengths: number[] = [];
		const codec = deterministicCodec({
			randomBytes: (length) => {
				requestedLengths.push(length);
				return FIXED_NONCE.slice();
			},
		});

		await codec.encode(binding, payload);
		expect(requestedLengths).toEqual([12]);
	});

	test("uses one sanitized error for tamper, unknown keys, and malformed wire data", async () => {
		const codec = deterministicCodec();
		const token = await codec.encode(binding, payload);
		const segments = token.split(".");
		const last = segments[5]?.at(-1);
		if (!last) throw new Error("fixed token is missing ciphertext");
		const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
		const unknownKey = token.replace(".active-2026.", ".missing-key.");
		const padded = `${token}=`;
		const downgraded = token.replace(".A256GCM.", ".A128GCM.");

		const errors = await Promise.all([
			captureInvalid(() => codec.decode(tampered, binding)),
			captureInvalid(() => codec.decode(unknownKey, binding)),
			captureInvalid(() => codec.decode(padded, binding)),
			captureInvalid(() => codec.decode(downgraded, binding)),
		]);

		expect(
			new Set(errors.map((error) => `${error.code}:${error.message}`)),
		).toEqual(
			new Set([
				"invalid_server_tool_replay_envelope:Invalid server tool replay envelope.",
			]),
		);
	});

	test.each([
		["tool type", { ...binding, toolType: "web_search_20990101" }],
		["audience", { ...binding, audience: "api-key:tenant-b" }],
		["lineage", { ...binding, lineage: "session:affinity-8" }],
		["call id", { ...binding, callId: "srvtoolu_02" }],
		["visible query", { ...binding, visibleQuery: "weather in Tampa" }],
		["result state", { ...binding, resultState: "error" }],
		["ordinal", { ...binding, ordinal: 3 }],
		["linkage", { ...binding, linkage: "srvtoolu_other" }],
		[
			"visible evidence",
			{
				...binding,
				visibleEvidence: [
					{ ...binding.visibleEvidence[0], title: "Changed title" },
				],
			},
		],
		[
			"visible cited text",
			{
				...binding,
				visibleEvidence: [
					{
						...binding.visibleEvidence[0],
						citedText: "Changed citation text",
					},
				],
			},
		],
	] as const)("rejects a wrong %s binding", async (_label, wrongBinding) => {
		const codec = deterministicCodec();
		const token = await codec.encode(binding, payload);

		await captureInvalid(() => codec.decode(token, wrongBinding));
	});

	test("rechecks protected digests and compact evidence counts after decryption", async () => {
		const independent = await independentlyInspectGoldenVector();
		const original = JSON.parse(
			new TextDecoder().decode(independent.plaintext),
		);
		if (!Array.isArray(original))
			throw new Error("golden plaintext must be a tuple");

		for (const changed of [
			original.map((value, index) => (index === 5 ? "A".repeat(43) : value)),
			original.map((value, index) => (index === 6 ? "B".repeat(43) : value)),
			original.map((value, index) => (index === 7 ? [1, 65] : value)),
			original.map((value, index) =>
				index === 5 ? `${String(value)}=` : value,
			),
		]) {
			const forged = await sealWithGoldenAad(
				independent.aad,
				new TextEncoder().encode(JSON.stringify(changed)),
			);
			await captureInvalid(() => deterministicCodec().decode(forged, binding));
		}
	});

	test("accepts N-1/N ASCII token bounds and rejects N+1 before entropy", async () => {
		const boundaryBinding = {
			...binding,
			visibleEvidence: Array.from({ length: 52 }, () => ({
				url: "",
				title: "",
				citedText: "",
				pageAge: null,
			})),
		};
		const payloadAt4095 = {
			provider: "p".repeat(256),
			model: "m".repeat(256),
			fidelity: "f".repeat(200),
		};
		const codecAt4095 = deterministicCodec({
			activeKey: { id: "k", key: ACTIVE_KEY },
		});
		const tokenAt4095 = await codecAt4095.encode(
			boundaryBinding,
			payloadAt4095,
		);
		expect(tokenAt4095.length).toBe(4095);
		expect(
			await codecAt4095.decode(tokenAt4095, boundaryBinding),
		).toMatchObject(payloadAt4095);

		const payloadAt4096 = {
			...payloadAt4095,
			fidelity: `${payloadAt4095.fidelity}f`,
		};
		const codecAt4096 = deterministicCodec({
			activeKey: { id: "k", key: ACTIVE_KEY },
		});
		const tokenAt4096 = await codecAt4096.encode(
			boundaryBinding,
			payloadAt4096,
		);
		expect(tokenAt4096.length).toBe(4096);
		expect(
			await codecAt4096.decode(tokenAt4096, boundaryBinding),
		).toMatchObject(payloadAt4096);

		let randomCalls = 0;
		const codecAt4097 = deterministicCodec({
			activeKey: { id: "k", key: ACTIVE_KEY },
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});
		const payloadAt4097 = {
			...payloadAt4096,
			fidelity: `${payloadAt4096.fidelity}f`,
		};
		await captureInvalid(() =>
			codecAt4097.encode(boundaryBinding, payloadAt4097),
		);
		expect(randomCalls).toBe(0);
		expect(inspectServerToolReplayEnvelopeHeader(tokenAt4096)).toMatchObject({
			keyId: "k",
		});
		captureInvalidHeader(() =>
			inspectServerToolReplayEnvelopeHeader(`${tokenAt4096}A`),
		);
		await captureInvalid(() =>
			codecAt4096.decode(`${tokenAt4096}A`, boundaryBinding),
		);
	});

	test.each([
		["tool type", "toolType"],
		["audience", "audience"],
		["lineage", "lineage"],
		["call ID", "callId"],
	] as const)("rejects an empty %s before entropy or crypto", async (_label, field) => {
		const sign = spyOn(crypto.subtle, "sign");
		const encrypt = spyOn(crypto.subtle, "encrypt");
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});

		try {
			await captureInvalid(() =>
				codec.encode({ ...binding, [field]: "" }, payload),
			);
			expect(randomCalls).toBe(0);
			expect(sign).not.toHaveBeenCalled();
			expect(encrypt).not.toHaveBeenCalled();
		} finally {
			sign.mockRestore();
			encrypt.mockRestore();
		}
	});

	test("rejects an unknown envelope kind before entropy or crypto", async () => {
		const sign = spyOn(crypto.subtle, "sign");
		const encrypt = spyOn(crypto.subtle, "encrypt");
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});
		const invalidBinding = {
			...binding,
			envelopeKind: "native",
		} as unknown as ServerToolReplayEnvelopeBinding;

		try {
			await captureInvalid(() => codec.encode(invalidBinding, payload));
			expect(randomCalls).toBe(0);
			expect(sign).not.toHaveBeenCalled();
			expect(encrypt).not.toHaveBeenCalled();
		} finally {
			sign.mockRestore();
			encrypt.mockRestore();
		}
	});

	test.each([
		["tool type", "toolType", 128],
		["audience", "audience", 256],
		["lineage", "lineage", 256],
		["call id", "callId", 256],
		["visible query", "visibleQuery", 8 * 1024],
	] as const)("enforces the %s UTF-8 byte cap before requesting entropy", async (_label, field, limit) => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});

		await expect(
			codec.encode({ ...binding, [field]: "x".repeat(limit - 1) }, payload),
		).resolves.toBeString();
		await expect(
			codec.encode({ ...binding, [field]: "x".repeat(limit) }, payload),
		).resolves.toBeString();
		const callsAtLimit = randomCalls;
		await captureInvalid(() =>
			codec.encode({ ...binding, [field]: "x".repeat(limit + 1) }, payload),
		);
		expect(randomCalls).toBe(callsAtLimit);
	});

	test.each([
		["linkage", "linkage", 256],
		["evidence URL", "url", 8 * 1024],
		["evidence title", "title", 2 * 1024],
		["evidence cited text", "citedText", 8 * 1024],
		["evidence page age", "pageAge", 256],
	] as const)("enforces the %s N-1/N/N+1 UTF-8 byte boundary", async (_label, field, limit) => {
		const codec = deterministicCodec();
		const withSizedField = (size: number): ServerToolReplayEnvelopeBinding =>
			field === "linkage"
				? { ...binding, linkage: "x".repeat(size) }
				: {
						...binding,
						visibleEvidence: [
							{
								...binding.visibleEvidence[0],
								[field]: "x".repeat(size),
							},
						],
					};

		await expect(
			codec.encode(withSizedField(limit - 1), payload),
		).resolves.toBeString();
		await expect(
			codec.encode(withSizedField(limit), payload),
		).resolves.toBeString();
		await captureInvalid(() =>
			codec.encode(withSizedField(limit + 1), payload),
		);
	});

	test("enforces the source-count N-1/N/N+1 boundary", async () => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});
		const withSources = (count: number): ServerToolReplayEnvelopeBinding => ({
			...binding,
			visibleEvidence: Array.from({ length: count }, () => ({
				url: "",
				title: "",
				citedText: "",
				pageAge: null,
			})),
		});

		await expect(codec.encode(withSources(63), payload)).resolves.toBeString();
		await expect(codec.encode(withSources(64), payload)).resolves.toBeString();
		const callsAtLimit = randomCalls;
		await captureInvalid(() => codec.encode(withSources(65), payload));
		expect(randomCalls).toBe(callsAtLimit);
	});

	test("normalizes visible strings to NFC before digesting and returning them", async () => {
		const decomposed = {
			...binding,
			visibleQuery: "caf\u0065\u0301",
			visibleEvidence: [
				{
					url: "https://example.com/caf\u0065\u0301",
					title: "caf\u0065\u0301",
					citedText: "caf\u0065\u0301",
					pageAge: "caf\u0065\u0301",
				},
			],
		};
		const normalized = {
			...decomposed,
			visibleQuery: decomposed.visibleQuery.normalize("NFC"),
			visibleEvidence: decomposed.visibleEvidence.map((evidence) => ({
				url: evidence.url.normalize("NFC"),
				title: evidence.title.normalize("NFC"),
				citedText: evidence.citedText.normalize("NFC"),
				pageAge: evidence.pageAge.normalize("NFC"),
			})),
		};

		expect(await deterministicCodec().encode(decomposed, payload)).toBe(
			await deterministicCodec().encode(normalized, payload),
		);
		const decoded = await deterministicCodec().decode(
			await deterministicCodec().encode(decomposed, payload),
			decomposed,
		);
		expect(decoded.visibleQuery).toBe(normalized.visibleQuery);
		expect(decoded.visibleEvidence).toEqual(normalized.visibleEvidence);
	});

	test("round trips bounded visible controls and pins their source locator", async () => {
		const visibleControls: ServerToolReplayEnvelopeBinding = {
			...binding,
			visibleQuery: "weather\r\n\tin Miami\u200dtoday",
			visibleEvidence: [
				{
					url: "https://example.com/visible-controls",
					title: "Miami\nforecast\tmap\u200dlayer",
					citedText: "Sunny\r\n\tand warm\u200d.",
					pageAge: "2\thours\nago\u200d",
				},
			],
		};
		const codec = deterministicCodec();
		const token = await codec.encode(visibleControls, payload);
		const header = inspectServerToolReplayEnvelopeHeader(token);

		expect(header.sourceLocator).toBe("tNV69OjceIhT9KkkFoyyXA");
		expect(await codec.decode(token, visibleControls)).toMatchObject({
			visibleQuery: visibleControls.visibleQuery,
			visibleEvidence: visibleControls.visibleEvidence,
		});

		const changedCitation = {
			...visibleControls,
			visibleEvidence: visibleControls.visibleEvidence.map((evidence) => ({
				...evidence,
				citedText: `${evidence.citedText}\nadditional citation`,
			})),
		};
		const changedCitationToken = await codec.encode(changedCitation, payload);
		expect(
			inspectServerToolReplayEnvelopeHeader(changedCitationToken).sourceLocator,
		).toBe(header.sourceLocator);
		expect(changedCitationToken).not.toBe(token);
	});

	test("normalizes missing and explicit null page age identically", async () => {
		const first = binding.visibleEvidence[0];
		if (!first) throw new Error("test evidence is required");
		const { pageAge: _pageAge, ...withoutPageAge } = first;
		const missing = { ...binding, visibleEvidence: [withoutPageAge] };
		const explicitNull = {
			...binding,
			visibleEvidence: [{ ...withoutPageAge, pageAge: null }],
		};

		const token = await deterministicCodec().encode(missing, payload);
		expect(token).toBe(
			await deterministicCodec().encode(explicitNull, payload),
		);
		expect(
			(await deterministicCodec().decode(token, missing)).visibleEvidence[0]
				?.pageAge,
		).toBeNull();
	});

	test("uses UTF-8 bytes rather than UTF-16 length for caps", async () => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});
		await expect(
			codec.encode({ ...binding, toolType: "é".repeat(64) }, payload),
		).resolves.toBeString();
		const callsAtLimit = randomCalls;
		await captureInvalid(() =>
			codec.encode({ ...binding, toolType: "é".repeat(65) }, payload),
		);
		expect(randomCalls).toBe(callsAtLimit);
	});

	test("accepts only the exact result-state enum and ordinal range", async () => {
		for (const resultState of ["result", "empty", "error"]) {
			for (const ordinal of [254, 255]) {
				const candidate = { ...binding, resultState, ordinal };
				const token = await deterministicCodec().encode(candidate, payload);
				expect(
					await deterministicCodec().decode(token, candidate),
				).toMatchObject({
					resultState,
					ordinal,
				});
			}
		}
		await captureInvalid(() =>
			deterministicCodec().encode({ ...binding, ordinal: 256 }, payload),
		);
	});

	test.each([
		"provider",
		"model",
		"fidelity",
	] as const)("enforces the %s N-1/N/N+1 UTF-8 byte boundary", async (field) => {
		const codec = deterministicCodec();
		await expect(
			codec.encode(binding, { ...payload, [field]: "x".repeat(255) }),
		).resolves.toBeString();
		await expect(
			codec.encode(binding, { ...payload, [field]: "x".repeat(256) }),
		).resolves.toBeString();
		await captureInvalid(() =>
			codec.encode(binding, { ...payload, [field]: "x".repeat(257) }),
		);
	});

	test("rejects invalid result states, ordinals, and source counts before entropy", async () => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});

		for (const invalidBinding of [
			{ ...binding, resultState: "partial" },
			{ ...binding, ordinal: 256 },
			{
				...binding,
				visibleEvidence: Array(65).fill(binding.visibleEvidence[0]),
			},
		]) {
			await captureInvalid(() => codec.encode(invalidBinding, payload));
		}
		expect(randomCalls).toBe(0);
	});

	test.each([
		["lone high surrogate", "bad\ud800value"],
		["lone low surrogate", "bad\udfffvalue"],
	] as const)("rejects a %s before entropy", async (_label, invalidText) => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});

		await captureInvalid(() =>
			codec.encode({ ...binding, visibleQuery: invalidText }, payload),
		);
		expect(randomCalls).toBe(0);
	});

	test("keeps structural fields and evidence URLs control-free", async () => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});

		for (const control of ["\n", "\t", "\u200d"]) {
			const invalidBindings: ServerToolReplayEnvelopeBinding[] = [
				{ ...binding, toolType: `bad${control}tool` },
				{ ...binding, audience: `bad${control}audience` },
				{ ...binding, lineage: `bad${control}lineage` },
				{ ...binding, callId: `bad${control}call` },
				{ ...binding, linkage: `bad${control}link` },
				{
					...binding,
					visibleEvidence: binding.visibleEvidence.map((evidence) => ({
						...evidence,
						url: `https://example.com/bad${control}url`,
					})),
				},
			];
			for (const invalidBinding of invalidBindings) {
				await captureInvalid(() => codec.encode(invalidBinding, payload));
			}
			for (const field of ["provider", "model", "fidelity"] as const) {
				await captureInvalid(() =>
					codec.encode(binding, {
						...payload,
						[field]: `bad${control}${field}`,
					}),
				);
			}
		}
		expect(randomCalls).toBe(0);
	});

	test("predicts an oversized digest-bearing token before requesting entropy", async () => {
		let randomCalls = 0;
		const codec = deterministicCodec({
			activeKey: { id: "k".repeat(64), key: ACTIVE_KEY },
			randomBytes: () => {
				randomCalls += 1;
				return FIXED_NONCE.slice();
			},
		});
		const maximumSources = Array.from({ length: 64 }, (_, index) => ({
			url: `https://example.com/${index}`,
			title: `title ${index}`,
			citedText: `citation ${index}`,
		}));

		await captureInvalid(() =>
			codec.encode(
				{ ...binding, visibleEvidence: maximumSources },
				{
					provider: "p".repeat(256),
					model: "m".repeat(256),
					fidelity: "f".repeat(256),
				},
			),
		);
		expect(randomCalls).toBe(0);
	});

	test("sanitizes RNG failures and rejects every wrong nonce length", async () => {
		for (const randomBytes of [
			() => {
				throw new Error("rng-secret-sentinel");
			},
			() => new Uint8Array(11),
			() => new Uint8Array(13),
		]) {
			const error = await captureInvalid(() =>
				deterministicCodec({ randomBytes }).encode(binding, payload),
			);
			expect(error.message).not.toContain("rng-secret-sentinel");
		}
	});

	test("rejects a ciphertext truncated below the complete GCM tag", async () => {
		const [, , , sourceLocator, nonce, ciphertext] = GOLDEN_TOKEN.split(".");
		if (!sourceLocator || !nonce || !ciphertext)
			throw new Error("golden token is malformed");
		const truncated = [
			"bccf2",
			"A256GCM",
			"active-2026",
			sourceLocator,
			nonce,
			encodeBase64UrlForVector(
				decodeBase64UrlForVector(ciphertext).slice(0, 15),
			),
		].join(".");
		await captureInvalid(() => deterministicCodec().decode(truncated, binding));
	});

	test("rejects unsafe and duplicate configured key IDs without exposing keys", () => {
		for (const id of [
			"",
			"-leading",
			"has.dot",
			"space key",
			"é",
			"x".repeat(65),
		]) {
			expect(() =>
				createServerToolReplayEnvelopeCodec({
					activeKey: { id, key: ACTIVE_KEY },
				}),
			).toThrow(TypeError);
		}
		expect(() =>
			createServerToolReplayEnvelopeCodec({
				activeKey: { id: "duplicate", key: ACTIVE_KEY },
				retainedKeys: [{ id: "duplicate", key: RETAINED_KEY }],
			}),
		).toThrow("Server-tool replay key IDs must be unique.");
	});

	test("copies key bytes at factory creation", async () => {
		const callerOwnedKey = ACTIVE_KEY.slice();
		const codec = deterministicCodec({
			activeKey: { id: "active-2026", key: callerOwnedKey },
		});
		callerOwnedKey.fill(0xff);

		expect(await codec.encode(binding, payload)).toBe(GOLDEN_TOKEN);
		expect(await codec.decode(GOLDEN_TOKEN, binding)).toMatchObject(payload);
	});

	test("zeroes every codec-owned raw-key import buffer after WebCrypto consumes it", async () => {
		const importKey = spyOn(crypto.subtle, "importKey");
		try {
			const codec = deterministicCodec();
			await codec.encode(binding, payload);
			const rawKeyInputs = importKey.mock.calls.flatMap((call) => {
				const [format, keyData] = call;
				return format === "raw" && keyData instanceof Uint8Array
					? [keyData]
					: [];
			});
			expect(rawKeyInputs).toHaveLength(3);
			for (const rawKeyInput of rawKeyInputs) {
				expect(rawKeyInput).toEqual(new Uint8Array(32));
			}
		} finally {
			importKey.mockRestore();
		}
	});
});
