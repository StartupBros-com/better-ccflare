import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
		const open = spyOn(fs, "openSync");
		const fstat = spyOn(fs, "fstatSync");
		const read = spyOn(fs, "readSync");
		const close = spyOn(fs, "closeSync");
		try {
			writeFileSync(file, verified("0.190.0", verifiedAt));
			expect(resolveCodexClientIdentity(() => now.time).fresh).toBe(true);
			const afterFirst = {
				open: open.mock.calls.length,
				fstat: fstat.mock.calls.length,
				read: read.mock.calls.length,
				close: close.mock.calls.length,
			};
			expect(afterFirst.open).toBeGreaterThan(0);
			expect(afterFirst.fstat).toBeGreaterThan(0);
			expect(afterFirst.read).toBeGreaterThan(0);
			expect(afterFirst.close).toBeGreaterThan(0);

			// Within the READ_CACHE_MS window: zero open/fstat/read/close syscalls.
			now.time += 500;
			expect(resolveCodexClientIdentity(() => now.time).fresh).toBe(true);
			expect(open.mock.calls.length).toBe(afterFirst.open);
			expect(fstat.mock.calls.length).toBe(afterFirst.fstat);
			expect(read.mock.calls.length).toBe(afterFirst.read);
			expect(close.mock.calls.length).toBe(afterFirst.close);

			now.time += 1_100;
			expect(resolveCodexClientIdentity(() => now.time)).toMatchObject({
				version: "0.190.0",
				fresh: false,
				error: "stale_record",
			});
			expect(open.mock.calls.length).toBeGreaterThan(afterFirst.open);

			writeFileSync(file, verified("0.189.0", new Date(start).toISOString()));
			now.time += 1_100;
			expect(resolveCodexClientIdentity(() => now.time)).toMatchObject({
				version: "0.189.0",
				fresh: true,
			});
		} finally {
			open.mockRestore();
			fstat.mockRestore();
			read.mockRestore();
			close.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("validates UTC dates, rejects future and classifies stale without erasing source history", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-"));
		const file = join(dir, "version.json");
		// A mutable clock: each rewrite below is followed by a >READ_CACHE_MS
		// advance so the resolve call after it is guaranteed to revalidate
		// rather than reuse the prior call's memoized outcome.
		const clock = { time: Date.parse("2026-09-24T12:00:00Z") };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		try {
			writeFileSync(file, verified("0.170.0", "2026-09-24T11:00:00Z"));
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.170.0",
				source: "verified",
				fresh: true,
			});
			clock.time += 1_100;
			writeFileSync(file, verified("0.180.0", "2026-09-24T12:06:00Z"));
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.170.0",
				fresh: false,
				error: "invalid_record",
			});
			for (const date of [
				"2026-02-30T12:00:00Z",
				"2026-09-24T12:00:00+00:00",
				"2026-09-24T12:00:60Z",
			]) {
				clock.time += 1_100;
				writeFileSync(file, verified("0.180.0", date));
				expect(resolveCodexClientIdentity(getNow).version).toBe("0.170.0");
			}
			clock.time += 1_100;
			writeFileSync(file, verified("0.159.0", "2026-08-01T12:00:00Z"));
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.159.0",
				source: "verified",
				fresh: false,
				error: "stale_record",
			});
			clock.time += 1_100;
			writeFileSync(file, "{bad");
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.159.0",
				fresh: false,
				error: "invalid_record",
			});
			clock.time += 1_100;
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = join(dir, "missing");
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
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
		// Injected clock so each rewrite below is validated fresh instead of
		// possibly landing inside the previous call's READ_CACHE_MS window.
		const clock = { time: Date.now() };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		try {
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = first;
			writeFileSync(
				first,
				verified("0.181.0", new Date(clock.time).toISOString()),
			);
			expect(resolveCodexClientIdentity(getNow).version).toBe("0.181.0");
			clock.time += 1_100;
			writeFileSync(first, "{bad");
			expect(resolveCodexClientIdentity(getNow).version).toBe("0.181.0");
			clock.time += 1_100;
			writeFileSync(
				first,
				verified("0.170.0", new Date(clock.time).toISOString()),
			);
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.170.0",
				fresh: true,
			});
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = second;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: CODEX_VERSION,
				source: "default",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns an identical snapshot within the window after the file changes, observing it only once the window elapses", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-window-"));
		const file = join(dir, "record");
		const clock = { time: Date.now() };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		const open = spyOn(fs, "openSync");
		const fstat = spyOn(fs, "fstatSync");
		const read = spyOn(fs, "readSync");
		const close = spyOn(fs, "closeSync");
		try {
			writeFileSync(
				file,
				verified("0.200.0", new Date(clock.time).toISOString()),
			);
			const first = resolveCodexClientIdentity(getNow);
			expect(first).toMatchObject({
				version: "0.200.0",
				source: "verified",
				fresh: true,
			});
			const afterFirst = {
				open: open.mock.calls.length,
				fstat: fstat.mock.calls.length,
				read: read.mock.calls.length,
				close: close.mock.calls.length,
			};
			expect(afterFirst.open).toBeGreaterThan(0);

			// Delete the file; within the window this must not be observed and
			// must cost zero open/fstat/read/close syscalls.
			rmSync(file);
			clock.time += 500;
			const second = resolveCodexClientIdentity(getNow);
			expect(second).toEqual(first);
			expect(open.mock.calls.length).toBe(afterFirst.open);
			expect(fstat.mock.calls.length).toBe(afterFirst.fstat);
			expect(read.mock.calls.length).toBe(afterFirst.read);
			expect(close.mock.calls.length).toBe(afterFirst.close);

			// Past the window: the deletion is now observed.
			clock.time += 1_100;
			const third = resolveCodexClientIdentity(getNow);
			expect(third).toMatchObject({
				version: "0.200.0",
				source: "verified",
				fresh: false,
				error: "unavailable_record",
			});
			expect(open.mock.calls.length).toBeGreaterThan(afterFirst.open);
		} finally {
			open.mockRestore();
			fstat.mockRestore();
			read.mockRestore();
			close.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("memoizes a missing-file outcome for the window before observing that the file now exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-missing-"));
		const file = join(dir, "record");
		const clock = { time: Date.now() };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		const open = spyOn(fs, "openSync");
		try {
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: CODEX_VERSION,
				source: "default",
				error: "unavailable_record",
			});
			const afterFirst = open.mock.calls.length;
			expect(afterFirst).toBeGreaterThan(0);

			writeFileSync(
				file,
				verified("0.210.0", new Date(clock.time).toISOString()),
			);
			clock.time += 500;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: CODEX_VERSION,
				source: "default",
				error: "unavailable_record",
			});
			expect(open.mock.calls.length).toBe(afterFirst);

			clock.time += 1_100;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.210.0",
				source: "verified",
				fresh: true,
			});
			expect(open.mock.calls.length).toBeGreaterThan(afterFirst);
		} finally {
			open.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("switching the path env to a different file bypasses the other path's window immediately", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-switch-"));
		const fileA = join(dir, "a");
		const fileB = join(dir, "b");
		const clock = { time: Date.now() };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		try {
			writeFileSync(
				fileA,
				verified("0.220.0", new Date(clock.time).toISOString()),
			);
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = fileA;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.220.0",
				source: "verified",
			});

			writeFileSync(
				fileB,
				verified("0.221.0", new Date(clock.time).toISOString()),
			);
			process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = fileB;
			// Same `now`, well inside fileA's window: a different path must not
			// be blocked by another path's memo.
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.221.0",
				source: "verified",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an explicit version set inside the window wins over the verified file immediately", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-explicit-"));
		const file = join(dir, "record");
		const clock = { time: Date.now() };
		const getNow = () => clock.time;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		try {
			writeFileSync(
				file,
				verified("0.230.0", new Date(clock.time).toISOString()),
			);
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.230.0",
				source: "verified",
			});
			process.env.CCFLARE_CODEX_CLIENT_VERSION = "9.9.9";
			clock.time += 500;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "9.9.9",
				source: "explicit",
				fresh: true,
			});
		} finally {
			delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a memoized fresh record flips to stale mid-window via pure arithmetic, without a new read", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-stale-window-"));
		const file = join(dir, "record");
		const start = Date.now();
		const verifiedAt = new Date(
			start - 30 * 24 * 60 * 60_000 + 300,
		).toISOString();
		const clock = { time: start };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		const open = spyOn(fs, "openSync");
		try {
			writeFileSync(file, verified("0.240.0", verifiedAt));
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.240.0",
				fresh: true,
			});
			const afterFirst = open.mock.calls.length;

			// Still inside the 1000ms window, but the record's own age crosses
			// the 30-day boundary: freshness must flip with zero new syscalls.
			clock.time += 500;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.240.0",
				fresh: false,
				error: "stale_record",
			});
			expect(open.mock.calls.length).toBe(afterFirst);
		} finally {
			open.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a clock step backwards revalidates instead of extending the memo for the size of the step", () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-identity-backwards-"));
		const file = join(dir, "record");
		const clock = { time: Date.now() };
		const getNow = () => clock.time;
		delete process.env.CCFLARE_CODEX_CLIENT_VERSION;
		process.env.CCFLARE_CODEX_VERIFIED_VERSION_FILE = file;
		try {
			writeFileSync(
				file,
				verified("0.260.0", new Date(clock.time).toISOString()),
			);
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.260.0",
				source: "verified",
			});

			writeFileSync(
				file,
				verified("0.261.0", new Date(clock.time).toISOString()),
			);
			// Simulate a wall-clock step backwards (e.g. an NTP correction) well
			// past READ_CACHE_MS. A memo recorded "at" a later timestamp than
			// `now` must not be reused just because `now` is still less than
			// `memo.until` -- it must be reusable only within ~READ_CACHE_MS of
			// when it was recorded, so the rewrite above is observed here rather
			// than the step pinning the stale memo for the size of the step.
			clock.time -= 5_000;
			expect(resolveCodexClientIdentity(getNow)).toMatchObject({
				version: "0.261.0",
				source: "verified",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
