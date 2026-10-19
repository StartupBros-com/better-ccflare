import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { BatchStatement } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

export interface ExternalUsageEvent {
	accountId?: string | null;
	sourceKind: "rollout" | "cloud";
	eventTs: number;
	timestamp: string;
	model: string;
	inputTokens: number;
	cacheReadInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	isFallbackModel: boolean;
	rateLimitResetsAt: number | null;
	planType: string | null;
	limitId: string | null;
	creditsHasCredits: boolean | null;
	creditsBalance: string | null;
	primaryUsedPercent: number | null;
	sessionId: string;
}
export interface ExternalUsageSource {
	path: string;
	size: number;
	mtimeNs: string;
	sessionId: string | null;
	parentId: string | null;
	sessionTimestamp: string | null;
	lastScannedAt: number;
}
export interface ExternalUsageAffected {
	accountId: string;
	eventTs: number;
}
interface Candidate {
	account_id: string;
	resets_at: number;
	started_at: number;
}
type AttributionBasis = "exact" | "near" | "vote" | "cloud";
interface Unresolved {
	account_id: string | null;
	attribution_basis: AttributionBasis | null;
	id: string;
	session_id: string;
	event_ts: number;
	rate_limit_resets_at: number | null;
}
/** Attribution never guesses when multiple accounts share the reset signal. */
function resolveAccount(
	reset: number | null,
	windows: Candidate[],
): { accountId: string; basis: "exact" | "near" } | null {
	if (reset === null) return null;
	const exact = new Set(
		windows
			.filter((w) => Number(w.resets_at) / 1000 === reset)
			.map((w) => w.account_id),
	);
	if (exact.size === 1) return { accountId: [...exact][0], basis: "exact" };
	if (exact.size > 1) return null;
	const near = new Set(
		windows
			.filter((w) => Math.abs(Number(w.resets_at) / 1000 - reset) <= 2)
			.map((w) => w.account_id),
	);
	return near.size === 1 ? { accountId: [...near][0], basis: "near" } : null;
}
export class ExternalUsageRepository extends BaseRepository<ExternalUsageEvent> {
	private scanOwner: string | null = null;
	private windowFingerprint: string | null = null;
	private evidenceChanged = false;
	async acquireScanLease(
		owner: string,
		now = Date.now(),
		ttlMs = 120000,
	): Promise<boolean> {
		const changed = await this.adapter.runWithChanges(
			`INSERT INTO external_usage_scan_lease(id,owner,expires_at) VALUES('scan',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE external_usage_scan_lease.expires_at<=?`,
			[owner, now + ttlMs, now],
		);
		if (changed) this.scanOwner = owner;
		return changed === 1;
	}
	async renewScanLease(
		owner: string,
		now = Date.now(),
		ttlMs = 120000,
	): Promise<boolean> {
		return (
			(await this.adapter.runWithChanges(
				`UPDATE external_usage_scan_lease SET expires_at=CASE WHEN expires_at<? THEN ? ELSE expires_at END WHERE id='scan' AND owner=? AND expires_at>?`,
				[now + ttlMs, now + ttlMs, owner, now],
			)) === 1
		);
	}
	async releaseScanLease(owner: string): Promise<void> {
		await this.adapter.run(
			"DELETE FROM external_usage_scan_lease WHERE id='scan' AND owner=?",
			[owner],
		);
		if (this.scanOwner === owner) this.scanOwner = null;
	}
	/** The lease check and each bounded mutation batch share a transaction, fencing a stale process. */
	private async mutationBatch(statements: BatchStatement[]): Promise<number[]> {
		if (!this.scanOwner) return this.adapter.runBatchWithChanges(statements);
		const now = Date.now();
		const changes = await this.adapter.runBatchWithChanges([
			{
				sql: "UPDATE external_usage_scan_lease SET expires_at=expires_at WHERE id='scan' AND owner=? AND expires_at>?",
				params: [this.scanOwner, now],
				expectedChanges: 1,
			},
			...statements,
		]);
		return changes.slice(1);
	}
	protected override async run(
		sql: string,
		params: unknown[] = [],
	): Promise<void> {
		await this.mutationBatch([{ sql, params }]);
	}
	protected override async runWithChanges(
		sql: string,
		params: unknown[] = [],
	): Promise<number> {
		return (await this.mutationBatch([{ sql, params }]))[0];
	}

	async getSources(): Promise<ExternalUsageSource[]> {
		const rows = await this.query<{
			path: string;
			size: number;
			mtime_ns: string;
			session_id: string | null;
			parent_id: string | null;
			session_timestamp: string | null;
			last_scanned_at: number;
		}>("SELECT * FROM external_usage_sources");
		return rows.map((r) => ({
			path: r.path,
			size: Number(r.size),
			mtimeNs: r.mtime_ns,
			sessionId: r.session_id,
			parentId: r.parent_id,
			sessionTimestamp: r.session_timestamp,
			lastScannedAt: Number(r.last_scanned_at),
		}));
	}
	async saveSource(s: ExternalUsageSource): Promise<void> {
		await this.run(
			`INSERT INTO external_usage_sources(path,size,mtime_ns,session_id,parent_id,session_timestamp,last_scanned_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime_ns=excluded.mtime_ns,session_id=excluded.session_id,parent_id=excluded.parent_id,session_timestamp=excluded.session_timestamp,last_scanned_at=excluded.last_scanned_at`,
			[
				s.path,
				s.size,
				s.mtimeNs,
				s.sessionId,
				s.parentId,
				s.sessionTimestamp,
				s.lastScannedAt,
			],
		);
	}
	/** Atomically journal a closed-window repair with its source mutation. */
	private async runWithPending(
		accountId: string | null,
		eventTs: number,
		sql: string,
		params: unknown[],
	): Promise<number> {
		if (accountId === null) return this.runWithChanges(sql, params);
		const changes = await this.mutationBatch([
			{
				sql: `INSERT INTO external_usage_pending_windows(window_id,revision)
 SELECT id,? FROM usage_windows WHERE account_id=? AND window_key='seven_day' AND started_at<=? AND COALESCE(closed_at,resets_at)>?
 ON CONFLICT(window_id) DO UPDATE SET revision=excluded.revision`,
				params: [randomUUID(), accountId, eventTs, eventTs],
			},
			{ sql, params },
		]);
		return changes[1];
	}
	async pendingAffected(): Promise<ExternalUsageAffected[]> {
		return (
			await this.query<{ account_id: string; started_at: number }>(
				`SELECT w.account_id,w.started_at FROM external_usage_pending_windows p JOIN usage_windows w ON w.id=p.window_id WHERE w.closed_at IS NOT NULL`,
			)
		).map((row) => ({
			accountId: row.account_id,
			eventTs: Number(row.started_at),
		}));
	}
	async ingest(
		events: ExternalUsageEvent[],
		options: { resolve?: boolean } = {},
	): Promise<{
		inserted: number;
		reattributed: number;
		affected: ExternalUsageAffected[];
	}> {
		const windows = await this.query<Candidate>(
			`SELECT w.account_id,w.resets_at,w.started_at FROM usage_windows w JOIN accounts a ON a.id=w.account_id WHERE a.provider='codex' AND w.window_key='seven_day'`,
		);
		const affected: ExternalUsageAffected[] = [];
		let inserted = 0;
		let reattributed = 0;

		// A bounded SQL transaction amortizes fsync during a cold scan without holding
		// the proxy event loop for an entire corpus. The lease fences each batch.
		for (let offset = 0; offset < events.length; offset += 256) {
			const statements: BatchStatement[] = [];
			const outcomes: Array<{
				event: ExternalUsageEvent;
				account: string | null;
				insert: number;
				cloudUpdate?: number;
			}> = [];
			for (const e of events.slice(offset, offset + 256)) {
				const resolution =
					e.sourceKind === "cloud"
						? e.accountId
							? { accountId: e.accountId, basis: "cloud" as const }
							: null
						: resolveAccount(e.rateLimitResetsAt, windows);
				const account = resolution?.accountId ?? null;
				const dedupe =
					"timestamp=? AND model=? AND input_tokens=? AND cache_read_input_tokens=? AND output_tokens=? AND reasoning_output_tokens=? AND total_tokens=?";
				const dedupeParams = [
					e.timestamp,
					e.model,
					e.inputTokens,
					e.cacheReadInputTokens,
					e.outputTokens,
					e.reasoningOutputTokens,
					e.totalTokens,
				];
				if (account)
					statements.push({
						sql: `INSERT INTO external_usage_pending_windows(window_id,revision)
 SELECT id,? FROM usage_windows WHERE account_id=? AND window_key='seven_day' AND started_at<=? AND COALESCE(closed_at,resets_at)>?
 AND (NOT EXISTS(SELECT 1 FROM external_usage_events WHERE ${dedupe})${e.sourceKind === "cloud" ? ` OR EXISTS(SELECT 1 FROM external_usage_events WHERE ${dedupe} AND account_id IS NULL)` : ""})
 ON CONFLICT(window_id) DO UPDATE SET revision=excluded.revision`,
						params: [
							randomUUID(),
							account,
							e.eventTs,
							e.eventTs,
							...dedupeParams,
							...(e.sourceKind === "cloud" ? dedupeParams : []),
						],
					});
				const insert = statements.length;
				statements.push({
					sql: `INSERT INTO external_usage_events(id,account_id,attribution_basis,source_kind,event_ts,timestamp,model,input_tokens,cache_read_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,is_fallback_model,rate_limit_resets_at,plan_type,limit_id,credits_has_credits,credits_balance,primary_used_percent,session_id,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(timestamp,model,input_tokens,cache_read_input_tokens,output_tokens,reasoning_output_tokens,total_tokens) DO NOTHING`,
					params: [
						randomUUID(),
						account,
						resolution?.basis ?? null,
						e.sourceKind,
						e.eventTs,
						e.timestamp,
						e.model,
						e.inputTokens,
						e.cacheReadInputTokens,
						e.outputTokens,
						e.reasoningOutputTokens,
						e.totalTokens,
						e.isFallbackModel ? 1 : 0,
						e.rateLimitResetsAt,
						e.planType,
						e.limitId,
						e.creditsHasCredits === null ? null : e.creditsHasCredits ? 1 : 0,
						e.creditsBalance,
						e.primaryUsedPercent,
						e.sessionId,
						Date.now(),
					],
				});
				let cloudUpdate: number | undefined;
				if (account && e.sourceKind === "cloud") {
					cloudUpdate = statements.length;
					statements.push({
						sql: `UPDATE external_usage_events SET account_id=?,attribution_basis='cloud' WHERE timestamp=? AND model=? AND input_tokens=? AND cache_read_input_tokens=? AND output_tokens=? AND reasoning_output_tokens=? AND total_tokens=? AND account_id IS NULL`,
						params: [
							account,
							e.timestamp,
							e.model,
							e.inputTokens,
							e.cacheReadInputTokens,
							e.outputTokens,
							e.reasoningOutputTokens,
							e.totalTokens,
						],
					});
				}
				outcomes.push({ event: e, account, insert, cloudUpdate });
			}
			const changes = await this.mutationBatch(statements);
			for (const outcome of outcomes) {
				const n = changes[outcome.insert];
				const updated =
					outcome.cloudUpdate === undefined ? 0 : changes[outcome.cloudUpdate];
				inserted += n;
				reattributed += updated;
				if (outcome.account && (n || updated))
					affected.push({
						accountId: outcome.account,
						eventTs: outcome.event.eventTs,
					});
			}
			await setImmediate();
		}

		this.evidenceChanged ||= inserted > 0 || reattributed > 0;
		if (options.resolve !== false) {
			const fingerprint = JSON.stringify(
				windows
					.map((w) => [w.account_id, Number(w.resets_at)])
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			);
			if (this.evidenceChanged || this.windowFingerprint !== fingerprint) {
				if (windows.length) {
					const bound = Math.min(...windows.map((w) => Number(w.started_at)));
					const pending = await this.query<Unresolved>(
						"SELECT id,session_id,event_ts,rate_limit_resets_at,account_id,attribution_basis FROM external_usage_events WHERE source_kind='rollout' AND (account_id IS NULL OR attribution_basis='vote') AND event_ts>=?",
						[bound],
					);
					const tallies = new Map<string, Map<string, number>>();
					const sessions = [...new Set(pending.map((row) => row.session_id))];
					for (let offset = 0; offset < sessions.length; offset += 200) {
						const batch = sessions.slice(offset, offset + 200);
						const evidence = await this.query<{
							session_id: string;
							rate_limit_resets_at: number | null;
						}>(
							`SELECT session_id,rate_limit_resets_at FROM external_usage_events WHERE source_kind='rollout' AND session_id IN (${batch.map(() => "?").join(",")})`,
							batch,
						);
						for (const row of evidence) {
							const direct = resolveAccount(
								row.rate_limit_resets_at === null
									? null
									: Number(row.rate_limit_resets_at),
								windows,
							);
							if (!direct) continue;
							let tally = tallies.get(row.session_id);
							if (!tally) {
								tally = new Map();
								tallies.set(row.session_id, tally);
							}
							tally.set(
								direct.accountId,
								(tally.get(direct.accountId) ?? 0) + 1,
							);
						}
					}
					const winners = new Map<string, string>();
					for (const [session, tally] of tallies) {
						let winner: string | null = null;
						let largest = 0;
						let tied = false;
						for (const [account, count] of tally) {
							if (count > largest) {
								winner = account;
								largest = count;
								tied = false;
							} else if (count === largest) tied = true;
						}
						if (winner && !tied) winners.set(session, winner);
					}
					const assignments: Array<{
						row: Unresolved;
						account: string;
						basis: AttributionBasis;
					}> = [];
					for (const row of pending) {
						const direct = resolveAccount(
							row.rate_limit_resets_at === null
								? null
								: Number(row.rate_limit_resets_at),
							windows,
						);
						const account = direct?.accountId ?? winners.get(row.session_id);
						if (!account) continue;
						const basis = direct?.basis ?? "vote";
						if (account === row.account_id && basis === row.attribution_basis)
							continue;
						assignments.push({ row, account, basis });
					}
					for (let offset = 0; offset < assignments.length; offset += 256) {
						const batch = assignments.slice(offset, offset + 256);
						const statements: BatchStatement[] = [];
						const indexes: number[] = [];
						for (const { row, account, basis } of batch) {
							const guard =
								"id=? AND account_id IS NOT DISTINCT FROM ? AND attribution_basis IS NOT DISTINCT FROM ?";
							const old = [row.id, row.account_id, row.attribution_basis];
							for (const target of new Set([row.account_id, account])) {
								if (target === null) continue;
								statements.push({
									sql: `INSERT INTO external_usage_pending_windows(window_id,revision) SELECT id,? FROM usage_windows WHERE account_id=? AND window_key='seven_day' AND started_at<=? AND COALESCE(closed_at,resets_at)>? AND EXISTS(SELECT 1 FROM external_usage_events WHERE ${guard}) ON CONFLICT(window_id) DO UPDATE SET revision=excluded.revision`,
									params: [
										randomUUID(),
										target,
										Number(row.event_ts),
										Number(row.event_ts),
										...old,
									],
								});
							}
							indexes.push(statements.length);
							statements.push({
								sql: `UPDATE external_usage_events SET account_id=?,attribution_basis=? WHERE ${guard}`,
								params: [account, basis, ...old],
							});
						}
						const changes = await this.mutationBatch(statements);
						batch.forEach(({ row, account }, i) => {
							if (changes[indexes[i]]) {
								reattributed++;
								for (const target of new Set([row.account_id, account]))
									if (target)
										affected.push({
											accountId: target,
											eventTs: Number(row.event_ts),
										});
							}
						});
						await setImmediate();
					}
				}
				this.windowFingerprint = fingerprint;
				this.evidenceChanged = false;
			}
			affected.push(...(await this.pendingAffected()));
		}
		return { inserted, reattributed, affected: this.dedupeAffected(affected) };
	}
	private dedupeAffected(
		affected: ExternalUsageAffected[],
	): ExternalUsageAffected[] {
		return [
			...new Map(
				affected.map((row) => [
					JSON.stringify([row.accountId, row.eventTs]),
					row,
				]),
			).values(),
		];
	}

	/** Replace normalized events only after every replacement source has linked its survivors.
	 * Stale links remain until deletion completes, so a crash is safe to retry. */
	async replaceSources(
		sources: Array<{ path: string; events: ExternalUsageEvent[] }>,
	) {
		const result = await this.ingest(
			sources.flatMap((source) => source.events),
			{ resolve: false },
		);
		const generation = randomUUID();

		let linkBatch: BatchStatement[] = [];
		for (const source of sources)
			for (const e of source.events) {
				linkBatch.push({
					sql: `INSERT INTO external_usage_event_sources(path,event_id,generation)
 SELECT ?,id,? FROM external_usage_events WHERE timestamp=? AND model=? AND input_tokens=? AND cache_read_input_tokens=? AND output_tokens=? AND reasoning_output_tokens=? AND total_tokens=?
 ON CONFLICT(path,event_id) DO UPDATE SET generation=excluded.generation`,
					params: [
						source.path,
						generation,
						e.timestamp,
						e.model,
						e.inputTokens,
						e.cacheReadInputTokens,
						e.outputTokens,
						e.reasoningOutputTokens,
						e.totalTokens,
					],
				});
				if (linkBatch.length === 256) {
					await this.mutationBatch(linkBatch);
					linkBatch = [];
					await setImmediate();
				}
			}
		if (linkBatch.length) await this.mutationBatch(linkBatch);

		for (const source of sources) {
			const stale = await this.query<{
				id: string;
				account_id: string | null;
				event_ts: number;
			}>(
				`SELECT e.id,e.account_id,e.event_ts FROM external_usage_events e JOIN external_usage_event_sources s ON s.event_id=e.id WHERE s.path=? AND s.generation<>? AND NOT EXISTS(SELECT 1 FROM external_usage_event_sources keep WHERE keep.event_id=e.id AND (keep.path<>? OR keep.generation=?))`,
				[source.path, generation, source.path, generation],
			);
			for (const row of stale) {
				if (row.account_id) {
					result.affected.push({
						accountId: row.account_id,
						eventTs: Number(row.event_ts),
					});
				}
				const deleted = await this.runWithPending(
					row.account_id,
					Number(row.event_ts),
					`DELETE FROM external_usage_events WHERE id=? AND NOT EXISTS(SELECT 1 FROM external_usage_event_sources keep WHERE keep.event_id=? AND (keep.path<>? OR keep.generation=?))`,
					[row.id, row.id, source.path, generation],
				);
				this.evidenceChanged ||= deleted > 0;
			}
			await this.run(
				"DELETE FROM external_usage_event_sources WHERE path=? AND generation<>?",
				[source.path, generation],
			);
		}
		const resolved = await this.ingest([]);
		result.reattributed += resolved.reattributed;
		result.affected.push(...resolved.affected);
		result.affected = this.dedupeAffected(result.affected);
		return result;
	}
	async report() {
		const rows = await this.query<{
			model: string;
			account_id: string | null;
			rows: number;
			input_tokens: number;
			cache_read_input_tokens: number;
			output_tokens: number;
			reasoning_output_tokens: number;
			total_tokens: number;
		}>(
			`SELECT model,account_id,COUNT(*) AS rows,SUM(input_tokens) AS input_tokens,SUM(cache_read_input_tokens) AS cache_read_input_tokens,SUM(output_tokens) AS output_tokens,SUM(reasoning_output_tokens) AS reasoning_output_tokens,SUM(total_tokens) AS total_tokens FROM external_usage_events GROUP BY model,account_id ORDER BY model,account_id`,
		);
		return rows.map((r) => ({
			model: r.model,
			accountId: r.account_id,
			attributed: r.account_id !== null,
			rows: Number(r.rows),
			inputTokens: Number(r.input_tokens),
			cacheReadInputTokens: Number(r.cache_read_input_tokens),
			outputTokens: Number(r.output_tokens),
			reasoningOutputTokens: Number(r.reasoning_output_tokens),
			totalTokens: Number(r.total_tokens),
		}));
	}
}
