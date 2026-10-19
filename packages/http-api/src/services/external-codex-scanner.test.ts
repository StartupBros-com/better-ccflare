import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { ExternalCodexScanner } from "./external-codex-scanner";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
test("scan skips unchanged sources, retries recent corrupt zstd, and reports metadata only", async () => {
	const home = await mkdtemp(join(tmpdir(), "scan-test-"));
	dirs.push(home);
	await mkdir(join(home, "sessions"));
	const path = join(home, "sessions", "rollout-a.jsonl");
	await writeFile(
		path,
		JSON.stringify({
			type: "session_meta",
			timestamp: "2026-10-18T00:00:00Z",
			payload: { id: "session-a" },
		}) +
			"\n" +
			JSON.stringify({
				type: "event_msg",
				timestamp: "2026-10-18T00:00:01Z",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: 100,
							cached_input_tokens: 10,
							output_tokens: 20,
							reasoning_output_tokens: 5,
							total_tokens: 120,
						},
					},
				},
			}),
	);
	await writeFile(join(home, "sessions", "rollout-b.jsonl.zst"), "in-flight");
	const sources = new Map();
	const batches: unknown[][] = [];
	const repository = {
		acquireScanLease: async () => true,
		renewScanLease: async () => true,
		releaseScanLease: async () => {},
		getSources: async () => [...sources.values()],
		saveSource: async (s: { path: string }) => {
			sources.set(s.path, s);
		},
		replaceSources: async (
			replacements: Array<{ path: string; events: unknown[] }>,
		) => {
			const events = replacements.flatMap((source) => source.events);
			batches.push(events);
			return {
				inserted: events.length,
				reattributed: 0,
				conflicts: 0,
				affected: [],
			};
		},
		ingest: async () => ({
			inserted: 0,
			reattributed: 0,
			conflicts: 0,
			affected: [],
		}),
		report: async () => [],
	};
	const scanner = new ExternalCodexScanner(repository);
	const first = await scanner.scan({ homes: [home], cloudRoots: [] });
	expect(first.filesScanned).toBe(1);
	expect(first.filesDeferred).toBe(1);
	expect(first.rowsInserted).toBe(1);
	expect(sources.size).toBe(1);
	const second = await scanner.scan({ homes: [home], cloudRoots: [] });
	expect(second.filesScanned).toBe(0);
	expect(second.filesDeferred).toBe(1);
	expect(batches[1]).toEqual([]);
	expect(batches[0][0]).toMatchObject({
		inputTokens: 90,
		cacheReadInputTokens: 10,
		totalTokens: 120,
	});
	expect(JSON.stringify(batches)).not.toContain("session_meta");
});

test("late parent discovery reparses unchanged child and retracts orphan replay rows", async () => {
	const { Database } = await import("bun:sqlite");
	const { BunSqlAdapter } = await import(
		"../../../database/src/adapters/bun-sql-adapter"
	);
	const { runMigrations } = await import("../../../database/src/migrations");
	const { ExternalUsageRepository } = await import(
		"../../../database/src/repositories/external-usage.repository"
	);
	const db = new Database(":memory:");
	runMigrations(db);
	const repo = new ExternalUsageRepository(new BunSqlAdapter(db));
	const home = await mkdtemp(join(tmpdir(), "late-parent-"));
	dirs.push(home);
	await mkdir(join(home, "sessions"));
	const line = (type: string, timestamp: string, payload: unknown) =>
		JSON.stringify({ type, timestamp, payload });
	const usage = (timestamp: string, n: number) =>
		line("event_msg", timestamp, {
			type: "token_count",
			info: {
				last_token_usage: {
					input_tokens: n,
					cached_input_tokens: 0,
					output_tokens: 0,
					reasoning_output_tokens: 0,
					total_tokens: n,
				},
			},
		});
	const child = [
		line("session_meta", "2026-10-18T00:01:00Z", {
			id: "child",
			forked_from_id: "parent",
		}),
		usage("2026-10-18T00:02:00Z", 100),
		usage("2026-10-18T00:02:03Z", 200),
		usage("2026-10-18T00:02:06Z", 50),
	].join("\n");
	await writeFile(join(home, "sessions/rollout-child.jsonl"), child);
	const scanner = new ExternalCodexScanner(repo);
	await scanner.scan({ homes: [home], cloudRoots: [] });
	expect(
		(await repo.report()).reduce((sum, row) => sum + row.totalTokens, 0),
	).toBe(350);
	await writeFile(
		join(home, "sessions/rollout-parent.jsonl"),
		[
			line("session_meta", "2026-10-18T00:00:00Z", { id: "parent" }),
			usage("2026-10-18T00:00:01Z", 100),
			usage("2026-10-18T00:00:04Z", 200),
		].join("\n"),
	);
	const second = await scanner.scan({ homes: [home], cloudRoots: [] });
	expect(second.filesScanned).toBe(2);
	expect(
		(await repo.report()).reduce((sum, row) => sum + row.totalTokens, 0),
	).toBe(350);
	db.close();
});

test("file changed during ingest is retried and scan remains responsive", async () => {
	const home = await mkdtemp(join(tmpdir(), "scan-live-"));
	dirs.push(home);
	await mkdir(join(home, "sessions"));
	const path = join(home, "sessions", "rollout-live.jsonl");
	await writeFile(path, "{}\n".repeat(50_000));
	const sources = new Map();
	let first = true;
	const repo = {
		acquireScanLease: async () => true,
		renewScanLease: async () => true,
		releaseScanLease: async () => {},
		getSources: async () => [...sources.values()],
		saveSource: async (s: { path: string }) => {
			sources.set(s.path, s);
		},
		replaceSources: async () => {
			if (first) {
				first = false;
				await writeFile(path, "{}\n".repeat(50_001));
			}
			return { inserted: 0, reattributed: 0, conflicts: 0, affected: [] };
		},
		ingest: async () => ({
			inserted: 0,
			reattributed: 0,
			conflicts: 0,
			affected: [],
		}),
		report: async () => [],
	};
	const scanner = new ExternalCodexScanner(repo);
	let ticks = 0;
	const timer = setInterval(() => ticks++, 1);
	try {
		await scanner.scan({ homes: [home], cloudRoots: [] });
	} finally {
		clearInterval(timer);
	}
	expect(ticks).toBeGreaterThan(0);
	expect(sources.size).toBe(0);
	expect(
		(await scanner.scan({ homes: [home], cloudRoots: [] })).filesScanned,
	).toBe(1);
	expect(sources.size).toBe(1);
});

test("cloud root requires a configured Codex subscription account", async () => {
	const repo = {
		acquireScanLease: async () => true,
		renewScanLease: async () => true,
		releaseScanLease: async () => {},
		getSources: async () => [],
		saveSource: async () => {},
		replaceSources: async () => ({
			inserted: 0,
			reattributed: 0,
			conflicts: 0,
			affected: [],
		}),
		ingest: async () => ({
			inserted: 0,
			reattributed: 0,
			conflicts: 0,
			affected: [],
		}),
		report: async () => [],
	};
	const scanner = new ExternalCodexScanner(repo);
	const result = await scanner.scan(
		{
			homes: [],
			cloudRoots: [{ accountName: "wrong-provider", path: "/unused" }],
		},
		[{ id: "a", name: "wrong-provider", provider: "anthropic" }],
	);
	expect(result.skippedCloudRoots).toEqual([
		{ accountName: "wrong-provider", reason: "no-account" },
	]);
});

test("database scan lease rejects concurrent operator scan and can retry", async () => {
	let available = false;
	let releases = 0;
	const repo = {
		acquireScanLease: async () => available,
		renewScanLease: async () => true,
		releaseScanLease: async () => {
			releases++;
		},
		getSources: async () => [],
		saveSource: async () => {},
		replaceSources: async () => ({
			inserted: 0,
			reattributed: 0,
			conflicts: 0,
			affected: [],
		}),
		ingest: async () => ({
			inserted: 0,
			reattributed: 0,
			conflicts: 0,
			affected: [],
		}),
		report: async () => [],
	};
	const scanner = new ExternalCodexScanner(repo);
	await expect(scanner.scan({ homes: [], cloudRoots: [] })).rejects.toThrow(
		"database lease",
	);
	expect(releases).toBe(0);
	available = true;
	await scanner.scan({ homes: [], cloudRoots: [] });
	expect(releases).toBe(1);
});

test("new active copy retires archived source usage and retired source can return", async () => {
	const { Database } = await import("bun:sqlite");
	const { BunSqlAdapter } = await import(
		"../../../database/src/adapters/bun-sql-adapter"
	);
	const { runMigrations } = await import("../../../database/src/migrations");
	const { ExternalUsageRepository } = await import(
		"../../../database/src/repositories/external-usage.repository"
	);
	const db = new Database(":memory:");
	runMigrations(db);
	const repo = new ExternalUsageRepository(new BunSqlAdapter(db));
	const home = await mkdtemp(join(tmpdir(), "active-replace-"));
	dirs.push(home);
	await mkdir(join(home, "archived_sessions"));
	const data = (n: number) =>
		JSON.stringify({
			type: "event_msg",
			timestamp: "2026-10-18T00:00:00Z",
			payload: {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: n,
						output_tokens: 0,
						total_tokens: n,
					},
				},
			},
		});
	const archived = join(home, "archived_sessions", "rollout-twin.jsonl");
	const active = join(home, "sessions", "rollout-twin.jsonl");
	await writeFile(archived, data(100));
	const scanner = new ExternalCodexScanner(repo);
	await scanner.scan({ homes: [home], cloudRoots: [] });
	expect((await repo.report())[0].totalTokens).toBe(100);
	await mkdir(join(home, "sessions"));
	await writeFile(active, data(200));
	await scanner.scan({ homes: [home], cloudRoots: [] });
	expect(
		(await repo.report()).reduce((sum, row) => sum + row.totalTokens, 0),
	).toBe(200);
	await rm(active);
	await scanner.scan({ homes: [home], cloudRoots: [] });
	expect(
		(await repo.report()).reduce((sum, row) => sum + row.totalTokens, 0),
	).toBe(100);
	db.close();
});

const fixture = (id: string, parent?: string, n = 100) =>
	[
		JSON.stringify({
			type: "session_meta",
			timestamp: "2026-10-18T00:01:00Z",
			payload: { id, forked_from_id: parent },
		}),
		JSON.stringify({
			type: "event_msg",
			timestamp: "2026-10-18T00:00:01Z",
			payload: {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: n,
						output_tokens: 0,
						total_tokens: n,
					},
				},
			},
		}),
		JSON.stringify({
			type: "event_msg",
			timestamp: "2026-10-18T00:02:00Z",
			payload: {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: 7,
						output_tokens: 0,
						total_tokens: 7,
					},
				},
			},
		}),
	].join("\n");
async function harness() {
	const { Database } = await import("bun:sqlite");
	const { BunSqlAdapter } = await import(
		"../../../database/src/adapters/bun-sql-adapter"
	);
	const { runMigrations } = await import("../../../database/src/migrations");
	const { ExternalUsageRepository } = await import(
		"../../../database/src/repositories/external-usage.repository"
	);
	const db = new Database(":memory:");
	runMigrations(db);
	const repo = new ExternalUsageRepository(new BunSqlAdapter(db));
	const home = await mkdtemp(join(tmpdir(), "scanner-"));
	dirs.push(home);
	await mkdir(join(home, "sessions"));
	const path = join(home, "sessions/rollout-child.jsonl");
	await writeFile(path, fixture("child", "parent"));
	const scanner = new ExternalCodexScanner(repo);
	const scan = () => scanner.scan({ homes: [home], cloudRoots: [] });
	const tokens = async () =>
		(await repo.report()).reduce((sum, row) => sum + row.totalTokens, 0);
	return { db, repo, home, path, scan, tokens };
}
test("failed compressed active winner preserves archived plain twin until healthy", async () => {
	const h = await harness();
	const archived = join(h.home, "archived_sessions/rollout-child.jsonl");
	await mkdir(join(h.home, "archived_sessions"));
	await fs.rename(h.path, archived);
	await h.scan();
	expect(await h.tokens()).toBe(107);
	const winner = `${h.path}.zst`;
	await writeFile(winner, "corrupt zstd");
	await fs.utimes(winner, new Date(0), new Date(0));
	const failed = await h.scan();
	expect(failed.filesDeferred).toBe(1);
	expect(await h.tokens()).toBe(107);
	await writeFile(
		winner,
		zstdCompressSync(Buffer.from(fixture("child", "parent"))),
	);
	await h.scan();
	expect(await h.tokens()).toBe(107);
	expect(
		(await h.repo.getSources()).find((s) => s.path === archived)?.size,
	).toBe(-1);
	h.db.close();
});
test("first-pass vanished file is deferred and other sources are ingested", async () => {
	const h = await harness();
	const other = join(h.home, "sessions/rollout-other.jsonl");
	await writeFile(other, fixture("other", undefined, 200));
	const original = fs.stat;
	const hook = spyOn(fs, "stat").mockImplementation(
		async (...args: Parameters<typeof fs.stat>) => {
			if (args[0] === h.path) await rm(h.path, { force: true });
			return original(...args);
		},
	);
	try {
		const summary = await h.scan();
		expect(summary.filesDeferred).toBe(1);
		expect(await h.tokens()).toBe(207);
	} finally {
		hook.mockRestore();
		h.db.close();
	}
});
test("dependent child read failure preserves rows and defers once per tick", async () => {
	const h = await harness();
	await h.scan();
	const parent = join(h.home, "sessions/rollout-parent.jsonl");
	await writeFile(parent, fixture("parent"));
	const original = fs.stat;
	let childStats = 0;
	const hook = spyOn(fs, "stat").mockImplementation(
		async (...args: Parameters<typeof fs.stat>) => {
			if (args[0] === h.path && ++childStats === 2) await chmod(h.path, 0);
			return original(...args);
		},
	);
	try {
		const summary = await h.scan();
		expect(summary.filesDeferred).toBe(1);
		expect(childStats).toBe(2);
		expect(await h.tokens()).toBe(107);
	} finally {
		hook.mockRestore();
		await chmod(h.path, 0o600);
		h.db.close();
	}
});
test("known unchanged parent read failure defers child without saving metadata", async () => {
	const h = await harness();
	const parent = join(h.home, "sessions/rollout-parent.jsonl");
	await writeFile(parent, fixture("parent"));
	await h.scan();
	const before = (await h.repo.getSources()).find((s) => s.path === h.path);
	await writeFile(h.path, fixture("child", "parent", 3000));
	const original = fs.stat;
	let parentStats = 0;
	const hook = spyOn(fs, "stat").mockImplementation(
		async (...args: Parameters<typeof fs.stat>) => {
			if (args[0] === parent && ++parentStats === 2) await chmod(parent, 0);
			return original(...args);
		},
	);
	try {
		const summary = await h.scan();
		expect(summary.filesDeferred).toBe(1);
		expect(await h.tokens()).toBe(107);
		expect((await h.repo.getSources()).find((s) => s.path === h.path)).toEqual(
			before,
		);
	} finally {
		hook.mockRestore();
		await chmod(parent, 0o600);
		h.db.close();
	}
});
test("file deleted after ingest skips final metadata stat without aborting", async () => {
	const h = await harness();
	const original = h.repo.replaceSources.bind(h.repo);
	const hook = spyOn(h.repo, "replaceSources").mockImplementation(
		async (replacements) => {
			const result = await original(replacements);
			await rm(h.path);
			return result;
		},
	);
	try {
		const summary = await h.scan();
		expect(summary.rowsInserted).toBe(2);
		expect(await h.tokens()).toBe(107);
		expect(await h.repo.getSources()).toEqual([]);
	} finally {
		hook.mockRestore();
		h.db.close();
	}
});
test("valid cloud root ingests beside unmatched and invalid roots and copies window summary", async () => {
	const h = await harness();
	const account = { id: "cloud", name: "valid", provider: "codex" };
	h.db.run(
		"INSERT INTO accounts (id,name,provider,api_key,created_at) VALUES ('cloud','valid','codex','test',0)",
	);
	const scanner = new ExternalCodexScanner(h.repo, async () => ({
		rewritten: 2,
		skippedRetention: 3,
		failed: 4,
	}));
	const summary = await scanner.scan(
		{
			homes: [],
			cloudRoots: [
				{ accountName: "valid", path: h.home },
				{ accountName: "missing", path: h.home },
			],
			invalidCloudRoots: ["malformed"],
		},
		[account],
	);
	expect(await h.tokens()).toBe(107);
	expect(summary.skippedCloudRoots).toEqual([
		{ accountName: "malformed", reason: "invalid" },
		{ accountName: "missing", reason: "no-account" },
	]);
	expect(summary).toMatchObject({
		windowsRewritten: 2,
		windowsSkippedRetention: 3,
		windowsFailed: 4,
		directoriesSkipped: 0,
	});
	h.db.close();
});
test("scanner reports unreadable directories beside readable sources", async () => {
	const h = await harness();
	const locked = join(h.home, "sessions/locked");
	await mkdir(locked);
	await chmod(locked, 0);
	try {
		const summary = await h.scan();
		expect(summary.directoriesSkipped).toBe(1);
		expect(await h.tokens()).toBe(107);
	} finally {
		await chmod(locked, 0o700);
		h.db.close();
	}
});
test("metadata database failures propagate instead of being treated as file failures", async () => {
	const h = await harness();
	const hook = spyOn(h.repo, "saveSource").mockRejectedValue(
		new Error("metadata lease fence failure"),
	);
	try {
		await expect(h.scan()).rejects.toThrow("metadata lease fence failure");
	} finally {
		hook.mockRestore();
		h.db.close();
	}
});
