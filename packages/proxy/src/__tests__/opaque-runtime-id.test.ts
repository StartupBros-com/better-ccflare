import { describe, expect, test } from "bun:test";
import { opaqueRuntimeId } from "../opaque-runtime-id";

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
