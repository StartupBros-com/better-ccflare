import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const names = [
	"CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES",
	"CCFLARE_MAX_BODY_ADMISSION_QUEUE",
] as const;
const original = Object.fromEntries(
	names.map((name) => [name, process.env[name]]),
);

function config(): { instance: Config; cleanup: () => void } {
	const directory = mkdtempSync(
		join(tmpdir(), "ccflare-body-admission-config-"),
	);
	return {
		instance: new Config(join(directory, "config.json")),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

afterEach(() => {
	for (const name of names) {
		const value = original[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("body-admission environment", () => {
	test("defaults to a 256 MiB budget and 500 queued requests", () => {
		const { instance, cleanup } = config();
		try {
			expect(instance.getMaxBufferedRequestBodyBytes()).toBe(256 * 1024 * 1024);
			expect(instance.getMaxBodyAdmissionQueue()).toBe(500);
		} finally {
			cleanup();
		}
	});

	test("accepts only exact in-range integer overrides", () => {
		process.env.CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES = String(
			1024 * 1024 * 1024,
		);
		process.env.CCFLARE_MAX_BODY_ADMISSION_QUEUE = "0";
		let fixture = config();
		try {
			expect(fixture.instance.getMaxBufferedRequestBodyBytes()).toBe(
				1024 * 1024 * 1024,
			);
			expect(fixture.instance.getMaxBodyAdmissionQueue()).toBe(0);
		} finally {
			fixture.cleanup();
		}

		process.env.CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES = String(
			256 * 1024 * 1024,
		);
		process.env.CCFLARE_MAX_BODY_ADMISSION_QUEUE = "5000";
		fixture = config();
		try {
			expect(fixture.instance.getMaxBufferedRequestBodyBytes()).toBe(
				256 * 1024 * 1024,
			);
			expect(fixture.instance.getMaxBodyAdmissionQueue()).toBe(5000);
		} finally {
			fixture.cleanup();
		}
	});

	test("fails safe to defaults for malformed and out-of-range values", () => {
		for (const [budget, queue] of [
			["1", "5001"],
			["268435456oops", "1.2"],
			["1073741825", "-1"],
		] as const) {
			process.env.CCFLARE_MAX_BUFFERED_REQUEST_BODY_BYTES = budget;
			process.env.CCFLARE_MAX_BODY_ADMISSION_QUEUE = queue;
			const { instance, cleanup } = config();
			try {
				expect(instance.getMaxBufferedRequestBodyBytes()).toBe(
					256 * 1024 * 1024,
				);
				expect(instance.getMaxBodyAdmissionQueue()).toBe(500);
			} finally {
				cleanup();
			}
		}
	});
});
