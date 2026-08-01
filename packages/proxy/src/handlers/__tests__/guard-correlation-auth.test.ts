import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { GUARD_REQUEST_ID_HEADER } from "@better-ccflare/http-common";
import {
	createGuardCorrelationEnvelope,
	createGuardCorrelationVerifier,
	verifyGuardCorrelationEnvelope,
} from "../guard-correlation-auth";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const OTHER_SECRET = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");
const REQUEST_ID = "76110a75-9e91-4ab9-89a7-3e5d25a318fc";

function headers(value: string): Headers {
	return new Headers({ [GUARD_REQUEST_ID_HEADER]: value });
}

describe("authenticated guard correlation", () => {
	it("round-trips a canonical signed request ID and positive attempt ordinal", () => {
		const envelope = createGuardCorrelationEnvelope(SECRET, REQUEST_ID, 2);

		expect(envelope).toMatch(
			/^v1\.[0-9a-f-]{36}\.[1-9]\d{0,6}\.[A-Za-z0-9_-]{43}$/,
		);
		expect(verifyGuardCorrelationEnvelope(envelope, SECRET)).toEqual({
			requestId: REQUEST_ID,
			attemptOrdinal: 2,
		});
		expect(createGuardCorrelationVerifier(SECRET)(headers(envelope))).toEqual({
			requestId: REQUEST_ID,
			attemptOrdinal: 2,
		});
	});

	it("rejects a wrong or rotated secret and an old signature", () => {
		const envelope = createGuardCorrelationEnvelope(SECRET, REQUEST_ID, 1);
		const oldSignatureEnvelope = createGuardCorrelationEnvelope(
			OTHER_SECRET,
			REQUEST_ID,
			1,
		);

		expect(
			verifyGuardCorrelationEnvelope(envelope, OTHER_SECRET),
		).toBeUndefined();
		expect(
			verifyGuardCorrelationEnvelope(oldSignatureEnvelope, SECRET),
		).toBeUndefined();
	});

	it.each([
		["wrong version", `v2.${REQUEST_ID}.1.${"A".repeat(43)}`],
		["uppercase UUID", `v1.${REQUEST_ID.toUpperCase()}.1.${"A".repeat(43)}`],
		[
			"non-v4 UUID",
			`v1.76110a75-9e91-1ab9-89a7-3e5d25a318fc.1.${"A".repeat(43)}`,
		],
		["zero ordinal", `v1.${REQUEST_ID}.0.${"A".repeat(43)}`],
		["negative ordinal", `v1.${REQUEST_ID}.-1.${"A".repeat(43)}`],
		["leading-zero ordinal", `v1.${REQUEST_ID}.01.${"A".repeat(43)}`],
		["huge ordinal", `v1.${REQUEST_ID}.1000001.${"A".repeat(43)}`],
		["short signature", `v1.${REQUEST_ID}.1.${"A".repeat(42)}`],
		["long signature", `v1.${REQUEST_ID}.1.${"A".repeat(44)}`],
		["base64 padding", `v1.${REQUEST_ID}.1.${"A".repeat(42)}=`],
		["extra component", `v1.${REQUEST_ID}.1.${"A".repeat(43)}.extra`],
		["multi value", `v1.${REQUEST_ID}.1.${"A".repeat(43)}, spoofed`],
		["oversized request ID", `v1.${"a".repeat(2_048)}.1.${"A".repeat(43)}`],
	])("rejects malformed %s envelopes", (_name, envelope) => {
		expect(verifyGuardCorrelationEnvelope(envelope, SECRET)).toBeUndefined();
	});

	it("rejects missing or non-32-byte credentials without throwing", () => {
		const envelope = createGuardCorrelationEnvelope(SECRET, REQUEST_ID, 1);

		expect(verifyGuardCorrelationEnvelope(envelope, undefined)).toBeUndefined();
		expect(
			verifyGuardCorrelationEnvelope(envelope, Buffer.alloc(31)),
		).toBeUndefined();
		expect(createGuardCorrelationVerifier(undefined)(headers(envelope))).toBe(
			undefined,
		);
	});

	it("compares only fixed-size decoded signatures", () => {
		const envelope = createGuardCorrelationEnvelope(SECRET, REQUEST_ID, 1);
		const [version, requestId, ordinal, signature] = envelope.split(".");
		const earlyMismatch = Buffer.from(signature, "base64url");
		const lateMismatch = Buffer.from(signature, "base64url");
		earlyMismatch[0] ^= 1;
		lateMismatch[lateMismatch.byteLength - 1] ^= 1;

		expect(Buffer.from(signature, "base64url")).toHaveLength(32);
		for (const wrongDigest of [earlyMismatch, lateMismatch]) {
			expect(wrongDigest).toHaveLength(32);
			expect(
				verifyGuardCorrelationEnvelope(
					`${version}.${requestId}.${ordinal}.${wrongDigest.toString("base64url")}`,
					SECRET,
				),
			).toBeUndefined();
		}
	});
});
