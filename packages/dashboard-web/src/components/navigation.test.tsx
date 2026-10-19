import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBuildProvenance } from "@better-ccflare/core";
import { renderToStaticMarkup } from "react-dom/server";
import { createUpdateStatusService } from "../../../http-api/src/handlers/version";
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

describe("navigation identity", () => {
	it("uses the safe identity subpath for desktop, mobile, and static title labels", () => {
		const source = readFileSync(
			join(import.meta.dir, "navigation.tsx"),
			"utf8",
		);
		const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
		const html = readFileSync(join(import.meta.dir, "../index.html"), "utf8");

		expect(source).toContain('from "@better-ccflare/core/product-identity"');
		expect(source).not.toContain('from "@better-ccflare/core"');
		expect(source.match(/\{PRODUCT_NAME\}/g)?.length).toBe(2);
		expect(source).not.toContain(">better-ccflare<");
		expect(html).toContain("<title>wstack Router Dashboard</title>");
		expect(app).toContain("Monitor your wstack Router performance and usage");
	});

	it("renders no action for genuinely resolved branded U1 provenance", async () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		let lookups = 0;
		for (const [token, mode] of [
			["v1:startupbros-wstack-router-binary", "binary"],
			["v1:startupbros-wstack-router-package", "package"],
		] as const) {
			const provenance = resolveBuildProvenance({
				CCFLARE_DISTRIBUTION: token,
				CCFLARE_VERSION: "1.0.0",
				CCFLARE_GIT_SHA: sha,
				CCFLARE_SOURCE_SHA: sha,
				CCFLARE_GIT_REF: "refs/tags/v1.0.0",
				CCFLARE_SOURCE_REF: "refs/tags/v1.0.0",
				CCFLARE_PRODUCER: "startupbros",
				CCFLARE_ARTIFACT_MODE: mode,
			});
			expect(provenance.proven).toBe(true);
			const adapter = async () => {
				lookups += 1;
				return "9.9.9";
			};
			const served = await createUpdateStatusService({
				currentVersion: () => "1.0.0",
				readProvenance: () => provenance,
				adapters: { npm: adapter, ghcr: adapter, "github-releases": adapter },
			}).check();
			const html = renderToStaticMarkup(
				<UpdateStatusDetails
					status={served.availability}
					result={{
						currentVersion: served.currentVersion,
						availability: served.availability,
						latestVersion: served.latestVersion,
						action: served.action,
						reason: served.reason,
					}}
				/>,
			);
			expect(served.action).toBeNull();
			expect(html).not.toContain("<code");
			expect(html).not.toContain("href=");
			for (const guidance of DEFAULT_GUIDANCE)
				expect(html).not.toContain(guidance);
		}
		expect(lookups).toBe(0);
	});
});

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
