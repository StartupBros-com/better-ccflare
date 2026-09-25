import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_VERSION, resolveCodexClientIdentity } from "./client-identity";

const previousPath = process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE;
const previousVersion = process.env.CCFLARE_CODEX_CLIENT_VERSION;
afterEach(() => {
	if (previousPath === undefined)
		delete process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE;
	else process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = previousPath;
	if (previousVersion === undefined)
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
	else process.env.CCFLARE_CODEX_CLIENT_VERSION = previousVersion;
});

function verified(version: string, verifiedAt: string): string {
	return JSON.stringify({
		schemaVersion: 1,
		packageName: "@openai/codex",
		version,
		verifiedAt,
	});
}

describe("verified Codex client identity", () => {
	test("reuses unchanged reads briefly, then reevaluates freshness and observes replacements", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-cache-"));
		const file = join(dir, "record");
		const start = Date.now();
		const verifiedAt = new Date(
			start - 30 * 24 * 60 * 60_000 + 1_500,
		).toISOString();
		const now = { time: start };
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		const read = spyOn(fs, "readSync");
		try {
			writeFileSync(file, verified("0.190.0", verifiedAt));
			utimesSync(file, new Date(start - 10_000), new Date(start - 10_000));
			expect(resolveCodexClientIdentity(() => now.time).fresh).toBe(true);
			const initialReads = read.mock.calls.length;
			expect(initialReads).toBeGreaterThan(0);
			now.time += 500;
			expect(resolveCodexClientIdentity(() => now.time).fresh).toBe(true);
			expect(read.mock.calls.length).toBe(initialReads);
			now.time += 1_100;
			expect(resolveCodexClientIdentity(() => now.time)).toMatchObject({
				version: "0.190.0",
				fresh: false,
				error: "stale_record",
			});
			expect(read.mock.calls.length).toBeGreaterThan(initialReads);
			writeFileSync(file, verified("0.189.0", new Date(start).toISOString()));
			expect(resolveCodexClientIdentity(() => now.time)).toMatchObject({
				version: "0.189.0",
				fresh: true,
			});
		} finally {
			read.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("validates UTC dates, rejects future and classifies stale without erasing source history", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-"));
		const file = join(dir, "version.json");
		const now = Date.parse("2026-09-24T12:00:00Z");
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		try {
			writeFileSync(file, verified("0.170.0", "2026-09-24T11:00:00Z"));
			expect(resolveCodexClientIdentity(() => now)).toMatchObject({
				version: "0.170.0",
				source: "verified",
				fresh: true,
			});
			writeFileSync(file, verified("0.180.0", "2026-09-24T12:06:00Z"));
			expect(resolveCodexClientIdentity(() => now)).toMatchObject({
				version: "0.170.0",
				fresh: false,
				error: "invalid_record",
			});
			for (const date of [
				"2026-02-30T12:00:00Z",
				"2026-09-24T12:00:00+00:00",
				"2026-09-24T12:00:60Z",
			]) {
				writeFileSync(file, verified("0.180.0", date));
				expect(resolveCodexClientIdentity(() => now).version).toBe("0.170.0");
			}
			writeFileSync(file, verified("0.159.0", "2026-08-01T12:00:00Z"));
			expect(resolveCodexClientIdentity(() => now)).toMatchObject({
				version: "0.159.0",
				source: "verified",
				fresh: false,
				error: "stale_record",
			});
			writeFileSync(file, "{bad");
			expect(resolveCodexClientIdentity(() => now)).toMatchObject({
				version: "0.159.0",
				fresh: false,
				error: "invalid_record",
			});
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = join(dir, "missing");
			expect(resolveCodexClientIdentity(() => now)).toMatchObject({
				version: CODEX_VERSION,
				source: "default",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads only regular files within 4096 bytes, and keeps explicit authority", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-"));
		const file = join(dir, "record");
		const link = join(dir, "link");
		const fifo = join(dir, "fifo");
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		try {
			writeFileSync(file, verified("0.160.0", new Date().toISOString()));
			symlinkSync(file, link);
			execFileSync("mkfifo", [fifo]);
			for (const source of [link, fifo, dir]) {
				process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = source;
				expect(resolveCodexClientIdentity()).toMatchObject({
					version: CODEX_VERSION,
					source: "default",
					error: "invalid_record",
				});
			}
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
			writeFileSync(file, "a".repeat(4097));
			expect(resolveCodexClientIdentity()).toMatchObject({
				source: "default",
				error: "invalid_record",
			});
			process.env.CCFLARE_CODEX_CLIENT_VERSION = "0.160.0";
			expect(resolveCodexClientIdentity()).toMatchObject({
				version: "0.160.0",
				source: "explicit",
				fresh: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("observes a valid rollback after a bad replacement and isolates file paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-"));
		const first = join(dir, "first");
		const second = join(dir, "second");
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		try {
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = first;
			writeFileSync(first, verified("0.181.0", new Date().toISOString()));
			expect(resolveCodexClientIdentity().version).toBe("0.181.0");
			writeFileSync(first, "{bad");
			expect(resolveCodexClientIdentity().version).toBe("0.181.0");
			writeFileSync(first, verified("0.170.0", new Date().toISOString()));
			expect(resolveCodexClientIdentity()).toMatchObject({
				version: "0.170.0",
				fresh: true,
			});
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = second;
			expect(resolveCodexClientIdentity()).toMatchObject({
				version: CODEX_VERSION,
				source: "default",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
