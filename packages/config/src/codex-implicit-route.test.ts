import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

describe("getCodexImplicitRouteEnabled", () => {
	const originalEnv = process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
	let directory: string;
	let config: Config;

	beforeEach(() => {
		delete process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
		directory = mkdtempSync(join(tmpdir(), "ccflare-codex-implicit-route-"));
		config = new Config(join(directory, "config.json"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
		if (originalEnv === undefined) {
			delete process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
		} else {
			process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = originalEnv;
		}
	});

	it("enables implicit Codex routing by default", () => {
		expect(config.getCodexImplicitRouteEnabled()).toBe(true);
	});

	it("disables implicit routing only for the literal environment value 0", () => {
		process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = "0";
		expect(config.getCodexImplicitRouteEnabled()).toBe(false);
	});

	it("keeps implicit routing enabled for other environment values", () => {
		for (const value of ["1", "true", "false", "", " 0 "]) {
			process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = value;
			expect(config.getCodexImplicitRouteEnabled()).toBe(true);
		}
	});

	it("reads the environment switch without persisting or caching it", () => {
		process.env.CCFLARE_CODEX_IMPLICIT_ROUTE = "0";
		expect(config.getCodexImplicitRouteEnabled()).toBe(false);
		delete process.env.CCFLARE_CODEX_IMPLICIT_ROUTE;
		expect(config.getCodexImplicitRouteEnabled()).toBe(true);
	});
});
