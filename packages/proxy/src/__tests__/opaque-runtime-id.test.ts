import { describe, expect, test } from "bun:test";
import {
	createOpaqueRuntimeIdFactory,
	OPAQUE_RUNTIME_ID_DOMAINS,
	opaqueRuntimeId,
} from "../opaque-runtime-id";

function digest(id: string): string {
	return id.slice(id.indexOf("_") + 1);
}

describe("opaqueRuntimeId framing", () => {
	test("does not alias tuples whose NUL-delimited concatenation is identical", () => {
		const embeddedNulInFirst = opaqueRuntimeId("test", "a\0b", "c");
		const embeddedNulInSecond = opaqueRuntimeId("test", "a", "b\0c");

		expect(embeddedNulInFirst).not.toBe(embeddedNulInSecond);
	});

	test("includes the namespace in the keyed digest domain", () => {
		const diagnosis = opaqueRuntimeId("diag", "same-session");
		const pacing = opaqueRuntimeId("pacing", "same-session");

		expect(digest(diagnosis)).not.toBe(digest(pacing));
	});

	test("distinguishes absent and explicit empty tuple parts", () => {
		const nullPart = opaqueRuntimeId("test", null);
		const undefinedPart = opaqueRuntimeId("test", undefined);
		const emptyPart = opaqueRuntimeId("test", "");

		expect(new Set([nullPart, undefinedPart, emptyPart]).size).toBe(3);
	});
});

describe("OpaqueRuntimeIdFactory", () => {
	const secret = new Uint8Array(32).fill(3);
	const bootNonce = new Uint8Array(32).fill(5);

	test("uses explicit domains and a full safe SHA-256 output", () => {
		const factory = createOpaqueRuntimeIdFactory({ secret, bootNonce });
		const ids = OPAQUE_RUNTIME_ID_DOMAINS.map((domain) =>
			factory.id(domain, "same-raw-input"),
		);

		expect(new Set(ids).size).toBe(OPAQUE_RUNTIME_ID_DOMAINS.length);
		for (const [index, id] of ids.entries()) {
			expect(id).toMatch(
				new RegExp(
					`^or1_${OPAQUE_RUNTIME_ID_DOMAINS[index]}_[A-Za-z0-9_-]{43}$`,
				),
			);
		}
		expect(factory.bootId).toBe(factory.bootId);
		expect(factory.bootId).toBe(factory.id("boot", "runtime"));
	});

	test("is deterministic only within the injected restart secret and nonce", () => {
		const first = createOpaqueRuntimeIdFactory({ secret, bootNonce });
		const sameRestart = createOpaqueRuntimeIdFactory({ secret, bootNonce });
		const rotatedSecret = createOpaqueRuntimeIdFactory({
			secret: new Uint8Array(32).fill(4),
			bootNonce,
		});
		const rotatedNonce = createOpaqueRuntimeIdFactory({
			secret,
			bootNonce: new Uint8Array(32).fill(6),
		});

		const firstId = first.id("logical_request", "request");
		expect(sameRestart.id("logical_request", "request")).toBe(firstId);
		expect(rotatedSecret.id("logical_request", "request")).not.toBe(firstId);
		expect(rotatedNonce.id("logical_request", "request")).not.toBe(firstId);
		expect(rotatedNonce.bootId).not.toBe(first.bootId);
	});

	test("frames NUL, newlines, and Unicode without output injection or tuple aliasing", () => {
		const factory = createOpaqueRuntimeIdFactory({ secret, bootNonce });
		const first = factory.id("cohort", "a\0b", "c\n雪");
		const second = factory.id("cohort", "a", "b\0c\n雪");

		expect(first).not.toBe(second);
		expect(first).not.toContain("\0");
		expect(first).not.toContain("\n");
		expect(first).not.toContain("雪");
		expect(first).toMatch(/^or1_cohort_[A-Za-z0-9_-]{43}$/);
	});

	test("rejects undersized injected key material", () => {
		expect(() =>
			createOpaqueRuntimeIdFactory({
				secret: new Uint8Array(31),
				bootNonce,
			}),
		).toThrow();
		expect(() =>
			createOpaqueRuntimeIdFactory({
				secret,
				bootNonce: new Uint8Array(15),
			}),
		).toThrow();
	});

	test("keeps the runtime domain allowlist immutable and rejects cast values", () => {
		const factory = createOpaqueRuntimeIdFactory({ secret, bootNonce });

		expect(Object.isFrozen(OPAQUE_RUNTIME_ID_DOMAINS)).toBe(true);
		expect(() => factory.id("not-a-domain\n" as never, "raw-input")).toThrow();
	});
});
