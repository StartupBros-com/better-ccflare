import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import { Config } from "./index";

describe("config load preservation", () => {
	let dir: string;
	let path: string;
	let error: ReturnType<typeof spyOn>;
	let warn: ReturnType<typeof spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ccflare-config-preservation-"));
		path = join(dir, "config.json");
		error = spyOn(Logger.prototype, "error").mockImplementation(() => {});
		warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		error.mockRestore();
		warn.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps malformed bytes while defaults and setters still update memory and emit changes", () => {
		const original = '{"secret":"private-token",';
		writeFileSync(path, original);
		const config = new Config(path);
		const changes: unknown[] = [];
		config.on("change", (change) => changes.push(change));

		expect(config.get("startup_default", true)).toBe(true);
		config.set("label", "updated");
		config.setProviderModelDefaultOverrides({ codex: { sonnet: "model" } });

		expect(config.get("label")).toBe("updated");
		expect(config.getProviderModelDefaultOverrides()).toEqual({
			codex: { sonnet: "model" },
		});
		expect(changes).toEqual([
			{ key: "startup_default", oldValue: undefined, newValue: true },
			{ key: "label", oldValue: undefined, newValue: "updated" },
			{
				key: "provider_model_default_overrides",
				oldValue: undefined,
				newValue: { codex: { sonnet: "model" } },
			},
		]);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it.each([
		"",
		"{",
		"null",
		"[]",
		'"text"',
		"42",
		"true",
	])("preserves invalid config root %j through startup defaults and writes", (original) => {
		writeFileSync(path, original);
		const config = new Config(path);
		expect(config.get("missing")).toBeUndefined();
		expect(config.get("default", 7)).toBe(7);
		config.set("label", "memory");
		expect(config.get("label")).toBe("memory");
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("keeps suppression after a real read failure even when the file becomes readable", () => {
		// Reading a directory deterministically fails with EISDIR, even as root.
		mkdirSync(path);
		const config = new Config(path);
		rmSync(path, { recursive: true });
		const repaired = '{"unrelated":"preserve"}';
		writeFileSync(path, repaired);
		config.set("label", "memory");
		expect(config.get("label")).toBe("memory");
		expect(readFileSync(path, "utf8")).toBe(repaired);
	});

	it("does not mistake an inaccessible child path for a missing file", () => {
		writeFileSync(path, "not a directory");
		const child = join(path, "config.json");
		// existsSync(child) returns false, but readFileSync reports ENOTDIR.
		const config = new Config(child);
		config.set("label", "memory");
		expect(config.get("label")).toBe("memory");
		expect(readFileSync(path, "utf8")).toBe("not a directory");
	});

	it("never resumes saving an incomplete snapshot after external repair or removal", () => {
		writeFileSync(path, "{");
		const stale = new Config(path);
		writeFileSync(path, '{"unrelated":"preserve"}');
		const fresh = new Config(path);
		fresh.set("label", "persisted");
		const repaired = readFileSync(path, "utf8");
		stale.set("label", "memory");
		expect(readFileSync(path, "utf8")).toBe(repaired);
		expect(JSON.parse(repaired)).toEqual({
			unrelated: "preserve",
			label: "persisted",
		});
		rmSync(path);
		stale.get("default", true);
		expect(existsSync(path)).toBe(false);
	});

	it("persists normal updates and defaults without losing unrelated valid fields", () => {
		writeFileSync(path, '{"unrelated":{"nested":true}}');
		const config = new Config(path);
		config.set("label", "persisted");
		config.get("default", 7);
		config.setProviderModelDefaultOverrides({ codex: { sonnet: "model" } });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			unrelated: { nested: true },
			label: "persisted",
			default: 7,
			provider_model_default_overrides: { codex: { sonnet: "model" } },
		});
	});

	it("creates a missing file and nested parent directories and continues saving", () => {
		path = join(dir, "nested", "child", "config.json");
		const config = new Config(path);
		expect(JSON.parse(readFileSync(path, "utf8")).lb_strategy).toBeString();
		config.set("label", "persisted");
		expect(new Config(path).get("label")).toBe("persisted");
	});

	it("rejects an unpersisted secret and sanitizes diagnostics while preserving invalid bytes", () => {
		const original = "privateSecretToken";
		writeFileSync(path, original);
		const config = new Config(path);
		expect(() => config.getLocalControlSecret()).toThrow(
			"persisted local-control secret",
		);
		expect(() => config.getLocalControlSecret()).toThrow(
			"persisted local-control secret",
		);
		expect(config.get("local_control_secret")).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(original);
		const diagnostics = JSON.stringify([error.mock.calls, warn.mock.calls]);
		expect(diagnostics).not.toContain(original);
		expect(diagnostics).toContain("memory-only");
		expect(diagnostics).toContain("preserved");
	});

	it.each([
		"set",
		"get-default",
	])("does not trust a memory-only secret injected via %s", (method) => {
		writeFileSync(path, "{");
		const config = new Config(path);
		if (method === "set") config.set("local_control_secret", "memory-secret");
		else config.get("local_control_secret", "memory-secret");
		expect(() => config.getLocalControlSecret()).toThrow(
			"persisted local-control secret",
		);
		expect(readFileSync(path, "utf8")).toBe("{");
		const repaired = '{"local_control_secret":"external","unrelated":true}';
		writeFileSync(path, repaired);
		expect(config.getLocalControlSecret()).toBe("external");
		config.set("label", "memory");
		expect(readFileSync(path, "utf8")).toBe(repaired);
	});

	it("adopts an externally persisted secret without events or lifting suppression", () => {
		writeFileSync(path, "{");
		const config = new Config(path);
		const repaired = '{"local_control_secret":"external","unrelated":true}';
		writeFileSync(path, repaired);
		const changes: unknown[] = [];
		config.on("change", (change) => changes.push(change));
		expect(config.getLocalControlSecret()).toBe("external");
		expect(changes).toEqual([]);
		config.set("label", "memory");
		expect(readFileSync(path, "utf8")).toBe(repaired);
	});

	it("rejects failed secret persistence without caching a key that a restart would lose", () => {
		writeFileSync(path, '{"unrelated":true}');
		const config = new Config(path);
		rmSync(path);
		mkdirSync(path);
		expect(() => config.getLocalControlSecret()).toThrow(
			"persist local-control secret",
		);
		expect(config.get("local_control_secret")).toBeUndefined();
		expect(() => config.getLocalControlSecret()).toThrow(
			"persist local-control secret",
		);
		rmSync(path, { recursive: true });
		writeFileSync(path, '{"unrelated":true}');
		const secret = config.getLocalControlSecret();
		expect(new Config(path).getLocalControlSecret()).toBe(secret);
		expect(new Config(path).get("unrelated")).toBe(true);
	});

	it("does not poison persistence on a secondary secret-read failure after a healthy load", () => {
		writeFileSync(path, '{"unrelated":true}');
		const config = new Config(path);
		writeFileSync(path, "{");
		const secret = config.getLocalControlSecret();
		config.set("label", "persisted");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			unrelated: true,
			local_control_secret: secret,
			label: "persisted",
		});
		expect(new Config(path).getLocalControlSecret()).toBe(secret);
	});
});
