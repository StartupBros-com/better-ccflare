import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@better-ccflare/core";
import {
	ACCOUNT_WINDOW_CAPS_ENV,
	Config,
	findUnknownAccountWindowCapIds,
	parseAccountWindowCaps,
} from "./index";

function withConfigFile(fileCaps: unknown, run: (path: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-window-caps-"));
	const path = join(dir, "config.json");
	try {
		if (fileCaps !== undefined) {
			writeFileSync(path, JSON.stringify({ account_window_caps: fileCaps }));
		}
		run(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("account_window_caps", () => {
	const originalEnv = process.env[ACCOUNT_WINDOW_CAPS_ENV];

	beforeEach(() => {
		delete process.env[ACCOUNT_WINDOW_CAPS_ENV];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[ACCOUNT_WINDOW_CAPS_ENV];
		else process.env[ACCOUNT_WINDOW_CAPS_ENV] = originalEnv;
	});

	it("defaults to an empty map with source 'default'", () => {
		withConfigFile(undefined, (path) => {
			const config = new Config(path);
			expect(config.getAccountWindowCaps()).toEqual({});
			expect(config.getAccountWindowCapsSource()).toBe("default");
		});
	});

	it("parses a file map and reports source 'file'", () => {
		withConfigFile({ "acct-1": { seven_day_fable: 80 } }, (path) => {
			const config = new Config(path);
			expect(config.getAccountWindowCaps()).toEqual({
				"acct-1": { seven_day_fable: 80 },
			});
			expect(config.getAccountWindowCapsSource()).toBe("file");
		});
	});

	it("lets the env JSON win over the file map", () => {
		process.env[ACCOUNT_WINDOW_CAPS_ENV] = JSON.stringify({
			"acct-2": { five_hour: 90, seven_day: 95 },
		});
		withConfigFile({ "acct-1": { seven_day_fable: 80 } }, (path) => {
			const config = new Config(path);
			expect(config.getAccountWindowCaps()).toEqual({
				"acct-2": { five_hour: 90, seven_day: 95 },
			});
			expect(config.getAccountWindowCapsSource()).toBe("env");
		});
	});

	it("reports the effective map in getAllSettings as JSON", () => {
		withConfigFile({ "acct-1": { seven_day_fable: 80 } }, (path) => {
			const settings = new Config(path).getAllSettings();
			expect(settings.account_window_caps).toBe(
				JSON.stringify({ "acct-1": { seven_day_fable: 80 } }),
			);
		});
	});

	it("treats an empty map as no caps", () => {
		expect(parseAccountWindowCaps("{}")).toEqual({});
	});

	it.each([
		0,
		100,
		150,
		80.5,
		"80",
	])("refuses percent %p naming account, window and value", (percent) => {
		process.env[ACCOUNT_WINDOW_CAPS_ENV] = JSON.stringify({
			"acct-1": { seven_day_fable: percent },
		});
		withConfigFile(undefined, (path) => {
			expect(() => new Config(path)).toThrow(ValidationError);
			expect(() => new Config(path)).toThrow(
				new RegExp(`acct-1.*seven_day_fable.*${String(percent)}`),
			);
		});
	});

	it.each([
		"weekly_fable",
		"seven_day_bogus",
		"monthly",
		"seven_day_",
		// Never equal to a normalized window key, so they would block silently.
		"seven_day_Fable",
		"seven_day_fable-pro",
	])("refuses window key %p", (key) => {
		expect(() =>
			parseAccountWindowCaps(JSON.stringify({ "acct-1": { [key]: 50 } })),
		).toThrow(ValidationError);
		expect(() =>
			parseAccountWindowCaps(JSON.stringify({ "acct-1": { [key]: 50 } })),
		).toThrow(new RegExp(key));
	});

	it("accepts a scoped key slugged from a model display name", () => {
		const caps = { a: { seven_day_opus_4_7: 70 } };
		expect(parseAccountWindowCaps(JSON.stringify(caps))).toEqual(caps);
	});

	it("accepts every canonical window key", () => {
		const caps = {
			a: {
				five_hour: 1,
				seven_day: 99,
				seven_day_fable: 80,
				seven_day_opus: 70,
				seven_day_sonnet: 60,
				seven_day_haiku: 50,
			},
		};
		expect(parseAccountWindowCaps(JSON.stringify(caps))).toEqual(caps);
	});

	it("refuses an empty account id and a non-object account value", () => {
		expect(() =>
			parseAccountWindowCaps(JSON.stringify({ " ": { five_hour: 50 } })),
		).toThrow(ValidationError);
		expect(() => parseAccountWindowCaps('{"a":null}')).toThrow(ValidationError);
		expect(() => parseAccountWindowCaps('{"a":[]}')).toThrow(ValidationError);
	});

	it("refuses malformed env JSON at startup instead of using an empty map", () => {
		process.env[ACCOUNT_WINDOW_CAPS_ENV] = "{not json";
		withConfigFile(undefined, (path) => {
			expect(() => new Config(path)).toThrow();
		});
	});

	it("refuses duplicate account ids", () => {
		expect(() =>
			parseAccountWindowCaps('{"a":{"five_hour":50},"a":{"five_hour":60}}'),
		).toThrow();
	});

	it("lists account ids that have no matching account", () => {
		const caps = { known: { five_hour: 50 }, gone: { seven_day: 90 } };
		expect(findUnknownAccountWindowCapIds(caps, ["known", "other"])).toEqual([
			"gone",
		]);
		expect(findUnknownAccountWindowCapIds({}, [])).toEqual([]);
	});
});
