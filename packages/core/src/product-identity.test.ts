import { describe, expect, it } from "bun:test";
import {
	COMMAND_NAME,
	LEGACY_COMMAND_NAME,
	PRODUCT_NAME,
} from "@better-ccflare/core/product-identity";
import cliPackage from "../../../apps/cli/package.json";
import rootPackage from "../../../package.json";

describe("public product identity", () => {
	it("adds compatible executable aliases without renaming distribution artifacts", () => {
		expect(cliPackage.name).toBe("better-ccflare");
		expect(cliPackage.bin).toEqual({
			"better-ccflare": "dist/better-ccflare",
			"wstack-router": "dist/better-ccflare",
		});
		expect(rootPackage.scripts["better-ccflare"]).toBe(
			"bun run build && bun run cli",
		);
		expect(rootPackage.scripts["wstack-router"]).toBe(
			"bun run build && bun run cli",
		);
		expect(cliPackage.repository.url).toBe(
			"git+https://github.com/StartupBros-com/better-ccflare.git",
		);
		expect(cliPackage.homepage).toBe(
			"https://github.com/StartupBros-com/better-ccflare#readme",
		);
		expect(cliPackage.bugs.url).toBe(
			"https://github.com/StartupBros-com/better-ccflare/issues",
		);
		expect(rootPackage.description).toContain("wstack Router");
		expect(cliPackage.description).toContain("wstack Router");
	});
	it("separates display and command names from the compatibility alias", () => {
		expect(PRODUCT_NAME).toBe("wstack Router");
		expect(COMMAND_NAME).toBe("wstack-router");
		expect(LEGACY_COMMAND_NAME).toBe("better-ccflare");
	});
});
