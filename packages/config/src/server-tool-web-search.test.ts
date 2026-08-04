import { describe, expect, it } from "bun:test";
import {
	CCFLARE_SERVER_TOOL_WEB_SEARCH_ENV,
	isServerToolWebSearchEnabled,
} from "./server-tool-web-search";

describe("server-tool web-search admission flag", () => {
	it("uses the documented environment key", () => {
		expect(CCFLARE_SERVER_TOOL_WEB_SEARCH_ENV).toBe(
			"CCFLARE_SERVER_TOOL_WEB_SEARCH",
		);
	});

	it("enables admission only for the exact string 1", () => {
		expect(
			isServerToolWebSearchEnabled({ CCFLARE_SERVER_TOOL_WEB_SEARCH: "1" }),
		).toBeTrue();

		for (const value of [undefined, "", "0", "true", "TRUE", " 1", "1 "]) {
			expect(
				isServerToolWebSearchEnabled({
					CCFLARE_SERVER_TOOL_WEB_SEARCH: value,
				}),
			).toBeFalse();
		}
	});
});
