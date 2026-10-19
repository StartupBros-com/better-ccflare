import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ExternalCodexCloudRoot } from "@better-ccflare/config";
import type {
	ExternalUsageAffected,
	ExternalUsageEvent,
	ExternalUsageRepository,
	ExternalUsageSource,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { discoverCodexFiles, streamCodexLines } from "./external-codex-files";
import {
	type ParsedCodexSession,
	parseCodexLines,
	suppressCodexReplay,
} from "./external-codex-parser";

type Repository = Pick<
	ExternalUsageRepository,
	| "getSources"
	| "saveSource"
	| "ingest"
	| "report"
	| "replaceSources"
	| "acquireScanLease"
	| "renewScanLease"
	| "releaseScanLease"
>;
export interface ExternalCodexSources {
	homes: readonly string[];
	cloudRoots: readonly ExternalCodexCloudRoot[];
	invalidCloudRoots?: readonly string[];
}
export interface ExternalCodexScanSummary {
	filesScanned: number;
	filesDeferred: number;
	directoriesSkipped: number;
	skippedCloudRoots: Array<{
		accountName: string;
		reason: "invalid" | "no-account" | "ambiguous-account";
	}>;
	windowsRewritten: number;
	windowsSkippedRetention: number;
	windowsFailed: number;
	rowsInserted: number;
	rowsReattributed: number;
	rowsUnattributed: number;
	malformedLines: number;
}
/** Retains metadata only. Files are reparsed whole when changed; SQL is the global dedupe authority. */
export class ExternalCodexScanner {
	private running = false;
	constructor(
		private repository: Repository,
		private onAffected?: (affected: ExternalUsageAffected[]) => Promise<{
			rewritten: number;
			skippedRetention: number;
			failed: number;
		}>,
	) {}
	async scan(
		sources: ExternalCodexSources,
		accounts: readonly { id: string; name: string; provider: string }[] = [],
	): Promise<ExternalCodexScanSummary> {
		if (this.running) throw new Error("External Codex scan already running");
		this.running = true;
		const summary: ExternalCodexScanSummary = {
			filesScanned: 0,
			filesDeferred: 0,
			directoriesSkipped: 0,
			skippedCloudRoots: [],
			windowsRewritten: 0,
			windowsSkippedRetention: 0,
			windowsFailed: 0,
			rowsInserted: 0,
			rowsReattributed: 0,
			rowsUnattributed: 0,
			malformedLines: 0,
		};

		const log = new Logger("ExternalCodexUsage");
		const ownerId = randomUUID();
		let acquired = false;
		let leaseFailure: Error | null = null;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		try {
			acquired = await this.repository.acquireScanLease(ownerId);
			if (!acquired)
				throw new Error("Another external Codex scan holds the database lease");
			heartbeat = setInterval(() => {
				this.repository
					.renewScanLease(ownerId)
					.then((valid) => {
						if (!valid)
							leaseFailure = new Error("External Codex scan lease was lost");
					})
					.catch(() => {
						leaseFailure = new Error(
							"External Codex scan lease could not be renewed",
						);
					});
			}, 30_000);

			const previous = new Map(
				(await this.repository.getSources()).map((s) => [s.path, s]),
			);
			const files: Array<{
				path: string;
				home: string;
				sourceDir: string;
				sourceKind: "rollout" | "cloud";
				accountId: string | null;
			}> = [];
			const discoveryOptions = {
				onUnreadable: (dir: string, error: unknown) => {
					summary.directoriesSkipped++;
					log.warn(
						`External Codex directory skipped: ${dir}: ${String(error)}`,
					);
				},
			};
			for (const raw of sources.invalidCloudRoots ?? []) {
				summary.skippedCloudRoots.push({ accountName: raw, reason: "invalid" });
				log.warn(`External Codex cloud root is invalid: ${raw}`);
			}
			for (const f of await discoverCodexFiles(sources.homes, discoveryOptions))
				files.push({ ...f, sourceKind: "rollout", accountId: null });
			for (const root of sources.cloudRoots) {
				const matches = accounts.filter(
					(a) => a.name === root.accountName && a.provider === "codex",
				);
				if (matches.length !== 1) {
					const reason =
						matches.length === 0 ? "no-account" : "ambiguous-account";
					summary.skippedCloudRoots.push({
						accountName: root.accountName,
						reason,
					});
					log.warn(
						`External Codex cloud root skipped: ${root.accountName}: ${reason}`,
					);
					continue;
				}
				for (const f of await discoverCodexFiles([root.path], discoveryOptions))
					files.push({ ...f, sourceKind: "cloud", accountId: matches[0].id });
			}
			const parsed = new Map<string, ParsedCodexSession>();
			const metadata = new Map<string, ExternalUsageSource>();
			const sessionPaths = new Map<string, string>();
			const healthy = new Set<string>();
			const failed = new Set<string>();
			const defer = (path: string, error: unknown) => {
				healthy.delete(path);
				metadata.delete(path);
				if (failed.has(path)) return;
				failed.add(path);
				summary.filesDeferred++;
				log.warn(`External Codex source deferred: ${path}: ${String(error)}`);
			};
			for (const file of files) {
				const old = previous.get(file.path);
				// Keep a known parent discoverable even if its stat/read fails.
				if (old?.sessionId && !sessionPaths.has(old.sessionId))
					sessionPaths.set(old.sessionId, file.path);
				try {
					const info = await stat(file.path, { bigint: true });
					if (
						old &&
						old.size === Number(info.size) &&
						old.mtimeNs === String(info.mtimeNs)
					) {
						if (old.sessionId && !sessionPaths.has(old.sessionId))
							sessionPaths.set(old.sessionId, file.path);
						healthy.add(file.path);
						continue;
					}
					const session = await parseCodexLines(streamCodexLines(file.path), {
						sessionId: basename(file.path).replace(/\.jsonl(?:\.zst)?$/, ""),
						fallbackTimestamp: new Date(Number(info.mtimeMs)).toISOString(),
					});
					parsed.set(file.path, session);
					summary.filesScanned++;
					summary.malformedLines += session.malformedLines;
					metadata.set(file.path, {
						path: file.path,
						size: Number(info.size),
						mtimeNs: String(info.mtimeNs),
						sessionId: session.sessionId,
						parentId: session.parentId,
						sessionTimestamp:
							session.sessionTimestamp === null
								? null
								: String(session.sessionTimestamp),
						lastScannedAt: Date.now(),
					});
					if (session.sessionId && !sessionPaths.has(session.sessionId))
						sessionPaths.set(session.sessionId, file.path);
				} catch (error) {
					defer(file.path, error);
				}
				await new Promise<void>((resolve) => setImmediate(resolve));
			}

			// A newly found or rewritten parent changes replay suppression even when a child is byte-identical.
			const changedSessionIds = new Set(
				[...parsed.values()].map((session) => session.sessionId),
			);
			for (let expanded = true; expanded; ) {
				expanded = false;
				for (const file of files) {
					if (parsed.has(file.path) || failed.has(file.path)) continue;
					const old = previous.get(file.path);
					if (!old?.parentId || !changedSessionIds.has(old.parentId)) continue;
					try {
						const info = await stat(file.path, { bigint: true });
						const session = await parseCodexLines(streamCodexLines(file.path), {
							sessionId: old.sessionId ?? undefined,
							fallbackTimestamp: new Date(Number(info.mtimeMs)).toISOString(),
						});
						parsed.set(file.path, session);
						changedSessionIds.add(session.sessionId);
						summary.filesScanned++;
						summary.malformedLines += session.malformedLines;
						metadata.set(file.path, {
							...old,
							size: Number(info.size),
							mtimeNs: String(info.mtimeNs),
							lastScannedAt: Date.now(),
						});
						expanded = true;
					} catch (error) {
						defer(file.path, error);
					}
				}
			}
			// Load every required unchanged parent before building any replacements.
			// A read failure must also defer descendants, independently of discovery order.
			const parentSessions = new Map<string, ParsedCodexSession>();
			for (const [path, session] of parsed) {
				if (failed.has(path) || !session.parentId) continue;
				const parentPath = sessionPaths.get(session.parentId);
				if (
					!parentPath ||
					parsed.has(parentPath) ||
					parentSessions.has(parentPath) ||
					failed.has(parentPath)
				)
					continue;
				try {
					const info = await stat(parentPath);
					parentSessions.set(
						parentPath,
						await parseCodexLines(streamCodexLines(parentPath), {
							fallbackTimestamp: info.mtime.toISOString(),
						}),
					);
				} catch (error) {
					failed.add(parentPath);
					healthy.delete(parentPath);
					log.warn(
						`External Codex parent unavailable: ${parentPath}: ${String(error)}`,
					);
				}
			}
			for (let expanded = true; expanded; ) {
				expanded = false;
				for (const file of files) {
					const parentId =
						parsed.get(file.path)?.parentId ??
						previous.get(file.path)?.parentId;
					const parentPath = parentId ? sessionPaths.get(parentId) : undefined;
					if (parentPath && failed.has(parentPath) && !failed.has(file.path)) {
						defer(file.path, `parent unavailable: ${parentPath}`);
						expanded = true;
					}
				}
			}
			const replacements: Array<{
				path: string;
				events: ExternalUsageEvent[];
			}> = [];

			for (const file of files) {
				const session = parsed.get(file.path);
				if (!session || failed.has(file.path)) continue;
				const parentPath = session.parentId
					? sessionPaths.get(session.parentId)
					: undefined;
				const parent = parentPath
					? (parsed.get(parentPath) ?? parentSessions.get(parentPath))
					: undefined;
				const events: ExternalUsageEvent[] = [];
				for (const event of suppressCodexReplay(session, parent))
					events.push({
						...event,
						inputTokens: event.inputTokens - event.cachedInputTokens,
						cacheReadInputTokens: event.cachedInputTokens,
						sourceKind: file.sourceKind,
						accountId: file.accountId,
					});
				healthy.add(file.path);
				replacements.push({ path: file.path, events });
				await new Promise<void>((resolve) => setImmediate(resolve));
			}

			// Retire only copies superseded by discovery precedence. Removed roots retain historical usage.
			const selectedPaths = new Set(files.map((file) => file.path));
			const retired = new Set<string>();
			for (const file of files) {
				if (!healthy.has(file.path) || failed.has(file.path)) continue;
				const logical = relative(file.sourceDir, file.path).replace(
					/\.zst$/,
					"",
				);
				for (const dir of new Set([
					file.sourceDir,
					join(file.home, "sessions"),
					join(file.home, "archived_sessions"),
				])) {
					for (const suffix of ["", ".zst"]) {
						const candidate = join(dir, logical + suffix);
						if (
							previous.has(candidate) &&
							previous.get(candidate)?.size !== -1 &&
							!selectedPaths.has(candidate) &&
							!retired.has(candidate)
						) {
							retired.add(candidate);
							replacements.push({ path: candidate, events: [] });
						}
					}
				}
			}
			if (leaseFailure) throw leaseFailure;
			const result = await this.repository.replaceSources(replacements);
			summary.rowsInserted = result.inserted;
			summary.rowsReattributed = result.reattributed;
			if (this.onAffected) {
				const windows = await this.onAffected(result.affected);
				summary.windowsRewritten = windows.rewritten;
				summary.windowsSkippedRetention = windows.skippedRetention;
				summary.windowsFailed = windows.failed;
			}

			for (const path of retired) {
				const old = previous.get(path);
				if (old)
					await this.repository.saveSource({
						...old,
						size: -1,
						mtimeNs: "",
						lastScannedAt: Date.now(),
					});
			}
			// Persist source metadata only after successful ingest and window backfill.
			for (const source of metadata.values()) {
				let current: import("node:fs").BigIntStats;
				try {
					current = await stat(source.path, { bigint: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT")
						log.warn(
							`External Codex metadata skipped: ${source.path}: ${String(error)}`,
						);
					continue;
				}
				if (
					Number(current.size) === source.size &&
					String(current.mtimeNs) === source.mtimeNs
				)
					await this.repository.saveSource(source);
			}
			const report = await this.repository.report();
			summary.rowsUnattributed = report
				.filter((r) => !r.attributed)
				.reduce((sum, row) => sum + row.rows, 0);
			log.info(
				`External Codex scan: files scanned=${summary.filesScanned}, rows inserted=${summary.rowsInserted}, rows unattributed=${summary.rowsUnattributed}, malformed lines=${summary.malformedLines}, files deferred=${summary.filesDeferred}, directories skipped=${summary.directoriesSkipped}, cloud roots skipped=${summary.skippedCloudRoots.length}`,
			);
			return summary;
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			try {
				if (acquired) await this.repository.releaseScanLease(ownerId);
			} finally {
				this.running = false;
			}
		}
	}
}
