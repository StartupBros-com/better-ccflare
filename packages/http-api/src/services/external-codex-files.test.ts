import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { discoverCodexFiles, streamCodexLines } from "./external-codex-files";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function home() {
	const dir = await mkdtemp(join(tmpdir(), "external-files-"));
	dirs.push(dir);
	return dir;
}
async function put(
	root: string,
	name: string,
	data: string | Uint8Array = "{}",
) {
	const path = join(root, name);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, data);
	return path;
}
test("discovery active copy beats matching archived relative path; plain beats zstd twin; excludes credentials", async () => {
	const root = await home();
	const active = await put(root, "sessions/2026/rollout-a.jsonl");
	await put(root, "archived_sessions/2026/rollout-a.jsonl");
	await put(root, "sessions/2026/rollout-a.jsonl.zst");
	const archived = await put(root, "archived_sessions/rollout-b.jsonl.zst");
	await put(root, "auth.json");
	expect((await discoverCodexFiles([root, root])).map((f) => f.path)).toEqual([
		active,
		archived,
	]);
});
test("direct cloud roots are discovered when no session directories exist", async () => {
	const root = await home();
	const path = await put(root, "2026/rollout-cloud.jsonl");
	expect((await discoverCodexFiles([root])).map((f) => f.path)).toEqual([path]);
});
test("node:zlib zstd decoding works under Bun and streams all lines", async () => {
	const root = await home();
	const path = await put(
		root,
		"rollout-z.jsonl.zst",
		zstdCompressSync(Buffer.from("one\ntwo\nthree")),
	);
	const lines = [];
	for await (const line of streamCodexLines(path)) lines.push(line);
	expect(lines).toEqual(["one", "two", "three"]);
});
test("large streaming source lets event loop timers run before completion", async () => {
	const root = await home();
	const path = await put(root, "rollout-large.jsonl", "{}\n".repeat(100_000));
	let ticks = 0;
	const timer = setInterval(() => ticks++, 1);
	let count = 0;
	try {
		for await (const _line of streamCodexLines(path)) count++;
	} finally {
		clearInterval(timer);
	}
	expect(count).toBe(100_000);
	expect(ticks).toBeGreaterThan(0);
});

test("active compressed copy wins over an archived plain copy at the same relative path", async () => {
	const root = await home();
	const active = await put(root, "sessions/2026/rollout-a.jsonl.zst");
	await put(root, "archived_sessions/2026/rollout-a.jsonl");
	expect((await discoverCodexFiles([root])).map((f) => f.path)).toEqual([
		active,
	]);
});

test("oracle discovery includes headless jsonl names and excludes credential filenames", async () => {
	const root = await home();
	const path = await put(root, "sessions/headless-exec.jsonl");
	await put(root, "sessions/auth.jsonl");
	await put(root, "sessions/credentials.jsonl.zst");
	expect((await discoverCodexFiles([root])).map((f) => f.path)).toEqual([path]);
});

test("unreadable subdirectory is reported without losing readable files", async () => {
	const root = await home();
	const good = await put(root, "sessions/readable/rollout-good.jsonl");
	await put(root, "sessions/locked/rollout-hidden.jsonl");
	const locked = join(root, "sessions/locked");
	await chmod(locked, 0);
	const skipped: string[] = [];
	try {
		const files = await discoverCodexFiles([root], {
			onUnreadable: (dir) => skipped.push(dir),
		});
		expect(files.map((f) => f.path)).toEqual([good]);
		expect(skipped).toEqual([locked]);
	} finally {
		await chmod(locked, 0o700);
	}
});
