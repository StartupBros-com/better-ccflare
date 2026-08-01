/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { GUARD_REQUEST_ID_HEADER } from "@better-ccflare/http-common";

export const GUARD_CORRELATION_VERSION = "v1" as const;
export const MAX_GUARD_ATTEMPT_ORDINAL = 1_000_000;

const SIGNING_DOMAIN = "better-ccflare/guard-correlation/v1";
const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORDINAL_PATTERN = /^[1-9]\d{0,6}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_BYTES = 32;
const SIGNATURE_BYTES = 32;

export interface AuthenticatedGuardCorrelation {
	requestId: string;
	attemptOrdinal: number;
}

export type GuardCorrelationVerifier = (
	headers: Headers,
) => AuthenticatedGuardCorrelation | undefined;

function signingInput(requestId: string, attemptOrdinal: number): string {
	return `${SIGNING_DOMAIN}\n${requestId}\n${attemptOrdinal}`;
}

function isValidSecret(secret: Uint8Array | undefined): secret is Uint8Array {
	return secret?.byteLength === SECRET_BYTES;
}

function decodeCanonicalSignature(value: string): Buffer | undefined {
	if (!SIGNATURE_PATTERN.test(value)) return undefined;
	const decoded = Buffer.from(value, "base64url");
	if (
		decoded.byteLength !== SIGNATURE_BYTES ||
		decoded.toString("base64url") !== value
	) {
		return undefined;
	}
	return decoded;
}

function sign(
	secret: Uint8Array,
	requestId: string,
	attemptOrdinal: number,
): Buffer {
	return createHmac("sha256", secret)
		.update(signingInput(requestId, attemptOrdinal), "utf8")
		.digest();
}

export function createGuardCorrelationEnvelope(
	secret: Uint8Array,
	requestId: string,
	attemptOrdinal: number,
): string {
	if (!isValidSecret(secret)) {
		throw new RangeError(
			"guard correlation secret must contain exactly 32 bytes",
		);
	}
	if (!UUID_V4_PATTERN.test(requestId)) {
		throw new TypeError(
			"guard correlation request ID must be a lowercase UUIDv4",
		);
	}
	if (
		!Number.isSafeInteger(attemptOrdinal) ||
		attemptOrdinal < 1 ||
		attemptOrdinal > MAX_GUARD_ATTEMPT_ORDINAL
	) {
		throw new RangeError(
			`guard correlation attempt ordinal must be from 1 through ${MAX_GUARD_ATTEMPT_ORDINAL}`,
		);
	}
	const signature = sign(secret, requestId, attemptOrdinal).toString(
		"base64url",
	);
	return `${GUARD_CORRELATION_VERSION}.${requestId}.${attemptOrdinal}.${signature}`;
}

export function verifyGuardCorrelationEnvelope(
	envelope: string | null | undefined,
	secret: Uint8Array | undefined,
): AuthenticatedGuardCorrelation | undefined {
	if (!isValidSecret(secret) || typeof envelope !== "string") return undefined;
	const parts = envelope.split(".");
	if (parts.length !== 4) return undefined;
	const [version, requestId, rawOrdinal, rawSignature] = parts;
	if (
		version !== GUARD_CORRELATION_VERSION ||
		!UUID_V4_PATTERN.test(requestId) ||
		!ORDINAL_PATTERN.test(rawOrdinal)
	) {
		return undefined;
	}
	const attemptOrdinal = Number(rawOrdinal);
	if (
		!Number.isSafeInteger(attemptOrdinal) ||
		attemptOrdinal < 1 ||
		attemptOrdinal > MAX_GUARD_ATTEMPT_ORDINAL
	) {
		return undefined;
	}
	const actualSignature = decodeCanonicalSignature(rawSignature);
	if (!actualSignature) return undefined;
	const expectedSignature = sign(secret, requestId, attemptOrdinal);
	// Both operands are fixed-size SHA-256 digests. Never call timingSafeEqual
	// with attacker-controlled lengths because Node intentionally throws there.
	if (
		expectedSignature.byteLength !== SIGNATURE_BYTES ||
		!timingSafeEqual(expectedSignature, actualSignature)
	) {
		return undefined;
	}
	return { requestId, attemptOrdinal };
}

export function createGuardCorrelationVerifier(
	secret: Uint8Array | undefined,
): GuardCorrelationVerifier {
	const immutableSecret = isValidSecret(secret)
		? Uint8Array.from(secret)
		: undefined;
	return (headers) =>
		verifyGuardCorrelationEnvelope(
			headers.get(GUARD_REQUEST_ID_HEADER),
			immutableSecret,
		);
}
