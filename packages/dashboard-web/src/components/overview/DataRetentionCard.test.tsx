import { describe, expect, it } from "bun:test";
import type { CleanupResponse } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { DataRetentionCleanupSummary } from "./DataRetentionCard";

const cleanup: CleanupResponse = {
	removedRequests: 4,
	removedPayloads: 2,
	removedRoutingAttempts: 7,
	payloadCutoffIso: "2026-08-23T00:00:00.000Z",
	requestCutoffIso: "2026-05-28T00:00:00.000Z",
	dbSizeBytes: 0,
	tableRowCounts: [],
};

describe("DataRetentionCleanupSummary", () => {
	it("displays removed routing attempts alongside existing cleanup counts", () => {
		const html = renderToStaticMarkup(
			<DataRetentionCleanupSummary cleanup={cleanup} />,
		);

		expect(html).toContain("Removed 2 payloads");
		expect(html).toContain("4 requests");
		expect(html).toContain("7 routing attempts");
	});
});
