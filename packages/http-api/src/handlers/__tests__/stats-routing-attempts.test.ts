import { describe, expect, it, mock } from "bun:test";
import { createStatsResetHandler } from "../stats";

describe("createStatsResetHandler routing-attempt cleanup", () => {
	it("delegates all statistics cleanup to the atomic database operation without changing its existing response", async () => {
		const resetStatistics = mock(async () => undefined);
		const handler = createStatsResetHandler({ resetStatistics } as never);

		const response = await handler();
		expect(response.status).toBe(200);
		expect(resetStatistics).toHaveBeenCalledTimes(1);
		expect(await response.json()).toEqual({
			success: true,
			message: "Statistics reset successfully",
		});
	});
});
