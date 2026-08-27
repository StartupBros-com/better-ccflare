import { describe, expect, it, mock } from "bun:test";
import type { RoutingAttemptSummary } from "@better-ccflare/types";
import { createRoutingAttemptsSummaryHandler } from "../routing-attempts";

const summary: RoutingAttemptSummary = {
	firstObservedAt: "2026-08-25T10:00:00.000Z",
	totalAttempts: 4,
	distinctRequests: 3,
	recoveredRequests: 1,
	terminalFailureRequests: 1,
	awaitingTerminalRequests: 1,
	byReasonScope: [
		{
			reason: "model_scoped_429",
			scope: "model",
			attemptCount: 4,
			distinctRequests: 3,
			recoveredRequests: 1,
			terminalFailureRequests: 1,
			awaitingTerminalRequests: 1,
		},
	],
};

function makeHandler() {
	const getRoutingAttemptSummary = mock(async () => summary);
	return {
		getRoutingAttemptSummary,
		handler: createRoutingAttemptsSummaryHandler({
			getRoutingAttemptSummary,
		}),
	};
}

describe("createRoutingAttemptsSummaryHandler", () => {
	it("defaults to a 24h aggregate window and keeps the response identifier-free", async () => {
		const { handler, getRoutingAttemptSummary } = makeHandler();
		const before = Date.now();
		const response = await handler(
			new URL("http://localhost/api/routing-attempts/summary"),
		);
		const after = Date.now();
		expect(response.status).toBe(200);
		expect(getRoutingAttemptSummary).toHaveBeenCalledTimes(1);
		expect(getRoutingAttemptSummary).toHaveBeenCalledWith(
			expect.objectContaining({ window: "24h" }),
		);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ window: "24h", ...summary });
		expect(body.firstObservedAt).toBe("2026-08-25T10:00:00.000Z");
		expect(typeof body.generatedAt).toBe("string");
		expect(typeof body.windowStart).toBe("string");
		expect(typeof body.windowEnd).toBe("string");
		expect(Date.parse(body.generatedAt as string)).toBeGreaterThanOrEqual(
			before,
		);
		expect(Date.parse(body.generatedAt as string)).toBeLessThanOrEqual(after);
		expect(JSON.stringify(body)).not.toMatch(
			/accountId|parentRequestId|attemptedModel|modelFamily|provider|"id"/,
		);
	});

	it("forwards each supported window through the object-shaped facade", async () => {
		const { handler, getRoutingAttemptSummary } = makeHandler();
		const response = await handler(
			new URL("http://localhost/api/routing-attempts/summary?window=7d"),
		);
		expect(response.status).toBe(200);
		expect(getRoutingAttemptSummary).toHaveBeenCalledWith(
			expect.objectContaining({ window: "7d" }),
		);
		const body = (await response.json()) as { window: string };
		expect(body.window).toBe("7d");
	});

	for (const query of ["?window=6h", "?window=1h&window=24h"]) {
		it(`returns the shared typed 400 response for invalid ${query}`, async () => {
			const { handler, getRoutingAttemptSummary } = makeHandler();
			const response = await handler(
				new URL(`http://localhost/api/routing-attempts/summary${query}`),
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toMatch(/application\/json/);
			expect(getRoutingAttemptSummary).not.toHaveBeenCalled();
		});
	}

	for (const window of ["toString", "constructor", "__proto__"]) {
		it(`rejects inherited ${window} window names without invoking the reader`, async () => {
			const { handler, getRoutingAttemptSummary } = makeHandler();
			const response = await handler(
				new URL(
					`http://localhost/api/routing-attempts/summary?window=${window}`,
				),
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toMatch(/application\/json/);
			expect(getRoutingAttemptSummary).not.toHaveBeenCalled();
		});
	}
});
