import { describe, expect, it } from "bun:test";
import { pauseStatusDisplay } from "./pause-status";

/**
 * R25 (OAuth control-plane hotfix, U8): the dashboard must show
 * reauthentication as the primary action for terminal-auth pauses
 * (pause_reason === "oauth_invalid_grant"), while every other pause reason
 * -- including unknown/legacy strings -- must still render safely with
 * generic "Paused" copy rather than crashing or showing something misleading.
 */
describe("pauseStatusDisplay", () => {
	it("flags oauth_invalid_grant as requiring reauthentication", () => {
		const result = pauseStatusDisplay("oauth_invalid_grant");
		expect(result.reauthRequired).toBe(true);
		expect(result.label).toBe("Re-authentication required");
	});

	it("renders a manual pause with generic copy", () => {
		const result = pauseStatusDisplay("manual");
		expect(result.reauthRequired).toBe(false);
		expect(result.label).toBe("Paused");
	});

	it("renders an overage pause with generic copy", () => {
		const result = pauseStatusDisplay("overage");
		expect(result.reauthRequired).toBe(false);
		expect(result.label).toBe("Paused");
	});

	it("falls back to generic copy for an unrecognized/legacy reason string", () => {
		const result = pauseStatusDisplay("some_future_reason_not_yet_known");
		expect(result.reauthRequired).toBe(false);
		expect(result.label).toBe("Paused");
	});

	it("falls back to generic copy for null (paused with no reason recorded)", () => {
		const result = pauseStatusDisplay(null);
		expect(result.reauthRequired).toBe(false);
		expect(result.label).toBe("Paused");
	});

	it("falls back to generic copy for undefined", () => {
		const result = pauseStatusDisplay(undefined);
		expect(result.reauthRequired).toBe(false);
		expect(result.label).toBe("Paused");
	});
});
