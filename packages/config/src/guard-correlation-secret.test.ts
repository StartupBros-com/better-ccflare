import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import {
	GUARD_CORRELATION_SECRET_ENV,
	readGuardCorrelationSecret,
} from "./index";

describe("guard correlation credential", () => {
	it("decodes only a canonical 32-byte base64url environment value", () => {
		const bytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
		const encoded = bytes.toString("base64url");

		const decoded = readGuardCorrelationSecret({
			[GUARD_CORRELATION_SECRET_ENV]: encoded,
		});

		expect(decoded).toEqual(Uint8Array.from(bytes));
	});

	it.each([
		undefined,
		"",
		"not-base64url",
		Buffer.alloc(31).toString("base64url"),
		Buffer.alloc(33).toString("base64url"),
		`${Buffer.alloc(32).toString("base64url")}=`,
	])("fails closed for missing or malformed value %s", (value) => {
		expect(
			readGuardCorrelationSecret({
				[GUARD_CORRELATION_SECRET_ENV]: value,
			}),
		).toBeUndefined();
	});
});
