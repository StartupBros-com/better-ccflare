import { describe, expect, it } from "bun:test";
import { ERROR_TYPES, getErrorType, HttpError } from "./index";

const messageCases = [
	[
		ERROR_TYPES.NETWORK,
		["network", "fetch failed", "connection", "econnrefused"],
	],
	[ERROR_TYPES.AUTH, ["unauthorized", "authentication", "401", "token"]],
	[ERROR_TYPES.RATE_LIMIT, ["rate limit", "too many requests", "429"]],
	[ERROR_TYPES.VALIDATION, ["validation", "invalid", "bad request"]],
	[ERROR_TYPES.SERVER, ["server error", "500", "502", "503", "504"]],
] as const;

describe("getErrorType message classification", () => {
	for (const [type, patterns] of messageCases) {
		for (const pattern of patterns) {
			it(`classifies ${JSON.stringify(pattern)} as ${type}`, () => {
				expect(
					getErrorType(new Error(`prefix ${pattern.toUpperCase()} suffix`)),
				).toBe(type);
			});
		}
	}

	it("preserves category precedence for overlapping messages", () => {
		expect(
			getErrorType(new Error("network token rate limit invalid server error")),
		).toBe(ERROR_TYPES.NETWORK);
		expect(
			getErrorType(new Error("token rate limit invalid server error")),
		).toBe(ERROR_TYPES.AUTH);
		expect(getErrorType(new Error("rate limit invalid server error"))).toBe(
			ERROR_TYPES.RATE_LIMIT,
		);
		expect(getErrorType(new Error("invalid server error"))).toBe(
			ERROR_TYPES.VALIDATION,
		);
	});

	it("keeps HttpError status classification ahead of message classification", () => {
		expect(getErrorType(new HttpError(500, "network failure"))).toBe(
			ERROR_TYPES.SERVER,
		);
	});
});
