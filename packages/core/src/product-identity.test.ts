import { describe, expect, it } from "bun:test";
import * as identity from "@better-ccflare/core/product-identity";
import cliPackage from "../../../apps/cli/package.json";
import rootPackage from "../../../package.json";

describe("public product identity", () => {
	it("preserves distribution package names and version agreement", () => {
		expect(rootPackage.name).toBe("better-ccflare");
		expect(cliPackage.name).toBe("better-ccflare");
		expect(cliPackage.version).toBe(rootPackage.version);
		expect(cliPackage.license).toBe("MIT");
		expect(cliPackage.files).toEqual(["dist/better-ccflare", "README.md"]);
	});

	it("adds compatible executable aliases without renaming distribution artifacts", () => {
		expect(cliPackage.bin).toEqual({
			"hov-router": "dist/better-ccflare",
			"wstack-router": "dist/better-ccflare",
			"better-ccflare": "dist/better-ccflare",
		});
		expect(rootPackage.scripts).toMatchObject({
			"hov-router": "bun run build && bun run cli",
			"wstack-router": "bun run build && bun run cli",
			"better-ccflare": "bun run build && bun run cli",
		});
	});

	it("points public metadata to the HoV Router home", () => {
		expect(cliPackage.repository.url).toBe(
			"git+https://github.com/StartupBros/hov-router.git",
		);
		expect(cliPackage.homepage).toBe(
			"https://github.com/StartupBros/hov-router#readme",
		);
		expect(cliPackage.bugs.url).toBe(
			"https://github.com/StartupBros/hov-router/issues",
		);
		expect(rootPackage.description).toContain("HoV Router");
		expect(cliPackage.description).toBe(rootPackage.description);
	});

	it("separates display and preferred command names from the legacy alias", () => {
		expect(identity.PRODUCT_NAME).toBe("HoV Router");
		expect(identity.COMMAND_NAME).toBe("hov-router");
		expect(identity.LEGACY_COMMAND_NAME).toBe("better-ccflare");
	});

	it("lists the preferred command and both compatibility aliases exactly once", () => {
		expect(identity.COMMAND_NAMES).toEqual([
			"hov-router",
			"wstack-router",
			"better-ccflare",
		]);
	});
});
