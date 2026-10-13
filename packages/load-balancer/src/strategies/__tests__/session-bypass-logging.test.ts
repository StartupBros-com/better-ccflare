import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { Logger } from "@better-ccflare/logger";
import type { RequestMeta } from "@better-ccflare/types";
import { SessionStrategy } from "../index";

afterEach(() => mock.restore());
it("logs bypass details only for an actual bypass without changing empty-pool routing", async () => {
	const strategy = new SessionStrategy();
	const info = spyOn(
		(strategy as unknown as { log: Logger }).log,
		"info",
	).mockImplementation(() => {});
	for (const value of [null, "false", "true"]) {
		info.mockClear();
		const headers = new Headers();
		if (value !== null) headers.set("x-better-ccflare-bypass-session", value);
		expect(await strategy.select([], { headers } as RequestMeta)).toEqual([]);
		const bypass = info.mock.calls.filter(([message]) =>
			message.startsWith("Bypass header:"),
		);
		expect(bypass).toHaveLength(value === "true" ? 1 : 0);
	}
});
