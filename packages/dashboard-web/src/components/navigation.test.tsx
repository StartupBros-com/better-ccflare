import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
	requestUpdateStatus,
	scheduleUpdateChecks,
	UPDATE_CHECK_INTERVAL_MS,
	UpdateStatusDetails,
	type UpdateStatusResponse,
} from "./navigation";

const DEFAULT_GUIDANCE = [
	"npm install -g better-ccflare@latest",
	"docker pull ghcr.io/tombii/better-ccflare:latest",
	"https://github.com/tombii/better-ccflare/releases/latest",
];

function status(
	overrides: Partial<UpdateStatusResponse> = {},
): UpdateStatusResponse {
	return {
		currentVersion: "1.0.0",
		availability: "unavailable",
		latestVersion: null,
		action: null,
		reason: "unknown_distribution",
		...overrides,
	};
}

describe("navigation", () => {
	it("keeps navigation items in the dynamic feature-flagged list only", () => {
		const source = readFileSync(
			join(import.meta.dir, "navigation.tsx"),
			"utf8",
		);

		expect(source).not.toContain("const _navItems");
		expect(source).toContain("const navItems: NavItem[] = useMemo");
	});
});

describe("navigation update status", () => {
	it("schedules one hourly refresh and cleans it up on unmount", () => {
		let scheduled: (() => void) | undefined;
		let scheduledDelay: number | undefined;
		let cleared: unknown;
		const interval = {};
		let checks = 0;

		const cleanup = scheduleUpdateChecks(
			(): void => {
				checks += 1;
			},
			{
				setInterval(callback: () => void, delay: number): object {
					scheduled = callback;
					scheduledDelay = delay;
					return interval;
				},
				clearInterval(handle: unknown): void {
					cleared = handle;
				},
			},
		);

		expect(scheduledDelay).toBe(UPDATE_CHECK_INTERVAL_MS);
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
		scheduled?.();
		expect(checks).toBe(1);
		cleanup();
		expect(cleared).toBe(interval);
	});

	it("requests the server-authoritative aggregate status exactly once", async () => {
		const requested: string[] = [];
		const result = await requestUpdateStatus(async (input) => {
			requested.push(String(input));
			return Response.json(
				status({
					availability: "available",
					latestVersion: "1.1.0",
					action: { kind: "command", value: "server-authored action" },
					reason: "update_available",
				}),
			);
		});

		expect(requested).toEqual(["/api/version/check"]);
		expect(requested).not.toContain("/api/system/package-manager");
		expect(result.action).toEqual({
			kind: "command",
			value: "server-authored action",
		});
	});

	it("renders only the server-authored actionable command", () => {
		const html = renderToStaticMarkup(
			<UpdateStatusDetails
				status="available"
				result={status({
					availability: "available",
					latestVersion: "1.1.0",
					action: { kind: "command", value: "server-authored action" },
					reason: "update_available",
				})}
			/>,
		);

		expect(html).toContain("server-authored action");
		for (const guidance of DEFAULT_GUIDANCE)
			expect(html).not.toContain(guidance);
	});

	it("does not invent a command for managed, unknown, non-actionable, or failed checks", () => {
		for (const [state, result] of [
			["unavailable", status({ reason: "proven_non_actionable" })],
			["unavailable", status({ reason: "unknown_distribution" })],
			[
				"unavailable",
				status({
					reason: "invalid_source_sha",
					action: { kind: "command", value: "forged action" },
				}),
			],
			["error", null],
		] as const) {
			const html = renderToStaticMarkup(
				<UpdateStatusDetails status={state} result={result} />,
			);
			expect(html).not.toContain("forged action");
			for (const guidance of DEFAULT_GUIDANCE)
				expect(html).not.toContain(guidance);
		}
	});
});
