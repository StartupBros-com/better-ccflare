import { randomUUID } from "node:crypto";
import { BaseRepository } from "./base.repository";

export const USAGE_WINDOW_GRANT_TYPES = [
	"natural",
	"early_reset",
	"first_observed",
] as const;

export type UsageWindowGrantType = (typeof USAGE_WINDOW_GRANT_TYPES)[number];

const GRANT_TYPE_SET: ReadonlySet<string> = new Set(USAGE_WINDOW_GRANT_TYPES);

export interface UsageWindow {
	id: string;
	accountId: string;
	windowKey: string;
	startedAt: number;
	resetsAt: number;
	closedAt: number | null;
	grantType: UsageWindowGrantType;
	peakUtilization: number;
	first100At: number | null;
	valueUsd: number | null;
	inputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	outputTokens: number | null;
	requestCount: number | null;
	modelBreakdown: Record<string, unknown> | null;
	unpricedTokens: number | null;
	projectionVersion: string | null;
}

export interface OpenWindowInput {
	accountId: string;
	windowKey: string;
	startedAt: number;
	resetsAt: number;
	grantType: UsageWindowGrantType;
}

export interface CloseWindowAggregates {
	valueUsd: number | null;
	inputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	outputTokens: number | null;
	requestCount: number | null;
	modelBreakdown: Record<string, unknown> | null;
	unpricedTokens: number | null;
	projectionVersion: string | null;
}

export interface CloseWindowInput extends CloseWindowAggregates {
	closedAt: number;
}

export interface ListWindowsOptions {
	accountId?: string;
	windowKey?: string;
	sinceMs?: number;
}

interface UsageWindowRow {
	id: string;
	account_id: string;
	window_key: string;
	started_at: number;
	resets_at: number;
	closed_at: number | null;
	grant_type: string;
	peak_utilization: number;
	first_100_at: number | null;
	value_usd: number | null;
	input_tokens: number | null;
	cache_read_input_tokens: number | null;
	cache_creation_input_tokens: number | null;
	output_tokens: number | null;
	request_count: number | null;
	model_breakdown: string | null;
	unpriced_tokens: number | null;
	projection_version: string | null;
}

const WINDOW_COLUMNS = `
	id, account_id, window_key, started_at, resets_at, closed_at, grant_type,
	peak_utilization, first_100_at, value_usd, input_tokens,
	cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
	request_count, model_breakdown, unpriced_tokens, projection_version`;

export class UsageWindowDataIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageWindowDataIntegrityError";
	}
}

function requireNonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireTimestamp(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function requireGrantType(value: UsageWindowGrantType): UsageWindowGrantType {
	if (!GRANT_TYPE_SET.has(value)) {
		throw new TypeError(`Unsupported grant type: ${value}`);
	}
	return value;
}

function parseModelBreakdown(
	value: string | null,
): Record<string, unknown> | null {
	if (value == null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new UsageWindowDataIntegrityError(
			"usage window model_breakdown contains invalid JSON",
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new UsageWindowDataIntegrityError(
			"usage window model_breakdown must be a JSON object",
		);
	}
	return parsed as Record<string, unknown>;
}

function toUsageWindow(row: UsageWindowRow): UsageWindow {
	if (!GRANT_TYPE_SET.has(row.grant_type)) {
		throw new UsageWindowDataIntegrityError(
			`usage window ${row.id} has invalid grant_type: ${row.grant_type}`,
		);
	}
	return {
		id: row.id,
		accountId: row.account_id,
		windowKey: row.window_key,
		startedAt: Number(row.started_at),
		resetsAt: Number(row.resets_at),
		closedAt: row.closed_at == null ? null : Number(row.closed_at),
		grantType: row.grant_type as UsageWindowGrantType,
		peakUtilization: Number(row.peak_utilization),
		first100At: row.first_100_at == null ? null : Number(row.first_100_at),
		valueUsd: row.value_usd == null ? null : Number(row.value_usd),
		inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
		cacheReadInputTokens:
			row.cache_read_input_tokens == null
				? null
				: Number(row.cache_read_input_tokens),
		cacheCreationInputTokens:
			row.cache_creation_input_tokens == null
				? null
				: Number(row.cache_creation_input_tokens),
		outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
		requestCount: row.request_count == null ? null : Number(row.request_count),
		modelBreakdown: parseModelBreakdown(row.model_breakdown),
		unpricedTokens:
			row.unpriced_tokens == null ? null : Number(row.unpriced_tokens),
		projectionVersion: row.projection_version,
	};
}

/**
 * One row per derived provider usage window (e.g. one five_hour cycle),
 * settled with its final value/aggregates once the window rolls over.
 * Backs the Window Value Ledger feature (issue #252). See usage-history
 * repository for the sibling raw-utilization time series this is derived
 * from.
 */
export class UsageWindowsRepository extends BaseRepository<UsageWindow> {
	async getOpenWindow(
		accountId: string,
		windowKey: string,
	): Promise<UsageWindow | null> {
		requireNonEmpty(accountId, "accountId");
		requireNonEmpty(windowKey, "windowKey");
		const row = await this.get<UsageWindowRow>(
			`SELECT ${WINDOW_COLUMNS} FROM usage_windows
			 WHERE account_id = ? AND window_key = ? AND closed_at IS NULL
			 ORDER BY resets_at DESC LIMIT 1`,
			[accountId, windowKey],
		);
		return row ? toUsageWindow(row) : null;
	}

	/**
	 * Opens a usage window, or returns the existing one if a row already
	 * exists on the (account_id, window_key, resets_at) unique key — the
	 * idempotent backfill anchor. Mirrors DeviceSetupJobRepository's
	 * createOrGet: INSERT ... ON CONFLICT DO NOTHING, then fetch by the
	 * natural key so a losing insert (its generated id discarded) still
	 * returns the surviving row.
	 */
	async openWindow(input: OpenWindowInput): Promise<UsageWindow>;
	async openWindow(
		input: OpenWindowInput,
		expectedCreatedAt: number,
	): Promise<UsageWindow | null>;
	async openWindow(
		input: OpenWindowInput,
		expectedCreatedAt?: number,
	): Promise<UsageWindow | null> {
		const accountId = requireNonEmpty(input.accountId, "accountId");
		const windowKey = requireNonEmpty(input.windowKey, "windowKey");
		const startedAt = requireTimestamp(input.startedAt, "startedAt");
		const resetsAt = requireTimestamp(input.resetsAt, "resetsAt");
		const grantType = requireGrantType(input.grantType);
		const id = randomUUID();
		if (expectedCreatedAt === undefined) {
			await this.run(
				`INSERT INTO usage_windows (
					id, account_id, window_key, started_at, resets_at, closed_at,
					grant_type, peak_utilization
				 ) VALUES (?, ?, ?, ?, ?, NULL, ?, 0)
				 ON CONFLICT (account_id, window_key, resets_at) DO NOTHING`,
				[id, accountId, windowKey, startedAt, resetsAt, grantType],
			);
			const row = await this.get<UsageWindowRow>(
				`SELECT ${WINDOW_COLUMNS} FROM usage_windows
				 WHERE account_id = ? AND window_key = ? AND resets_at = ?`,
				[accountId, windowKey, resetsAt],
			);
			if (!row) throw new Error("Failed to open or load usage window");
			return toUsageWindow(row);
		}

		await this.run(
			`INSERT INTO usage_windows (
				id, account_id, window_key, started_at, resets_at, closed_at,
				grant_type, peak_utilization
			 ) SELECT ?, ?, ?, ?, ?, NULL, ?, 0
			 WHERE EXISTS (
				SELECT 1 FROM accounts WHERE id = ? AND created_at = ?
			 ) ON CONFLICT (account_id, window_key, resets_at) DO NOTHING`,
			[
				id,
				accountId,
				windowKey,
				startedAt,
				resetsAt,
				grantType,
				accountId,
				expectedCreatedAt,
			],
		);
		const row = await this.get<UsageWindowRow>(
			`SELECT ${WINDOW_COLUMNS} FROM usage_windows
			 WHERE account_id = ? AND window_key = ? AND resets_at = ?
			   AND EXISTS (
					SELECT 1 FROM accounts WHERE id = ? AND created_at = ?
			   )`,
			[accountId, windowKey, resetsAt, accountId, expectedCreatedAt],
		);
		return row ? toUsageWindow(row) : null;
	}

	/**
	 * Raises peak_utilization if `utilization` is higher, and sets
	 * first_100_at exactly once, the first time utilization reaches 100.
	 * Both are computed inside a single UPDATE so concurrent pollers can't
	 * race a read-then-write.
	 */
	async recordUtilization(
		id: string,
		utilization: number,
		timestampMs: number,
		expectedCreatedAt?: number,
	): Promise<void> {
		requireNonEmpty(id, "id");
		if (!Number.isFinite(utilization)) {
			throw new TypeError("utilization must be a finite number");
		}
		requireTimestamp(timestampMs, "timestampMs");
		const generationClause =
			expectedCreatedAt === undefined
				? ""
				: ` AND EXISTS (
					SELECT 1 FROM accounts
					WHERE id = usage_windows.account_id AND created_at = ?
				)`;
		await this.run(
			`UPDATE usage_windows
			 SET peak_utilization = CASE WHEN ? > peak_utilization THEN ? ELSE peak_utilization END,
			     first_100_at = CASE WHEN first_100_at IS NULL AND ? >= 100 THEN ? ELSE first_100_at END
			 WHERE id = ?${generationClause}`,
			[
				utilization,
				utilization,
				utilization,
				timestampMs,
				id,
				...(expectedCreatedAt === undefined ? [] : [expectedCreatedAt]),
			],
		);
	}

	/**
	 * Closes a window and records its final aggregates. Guarded by
	 * `closed_at IS NULL` so a repeated close (e.g. a retried poll) can't
	 * silently overwrite an already-settled row with stale aggregates.
	 * Returns false (no-op) if the window was already closed.
	 */
	async closeWindow(
		id: string,
		input: CloseWindowInput,
		expectedCreatedAt?: number,
	): Promise<boolean> {
		requireNonEmpty(id, "id");
		const closedAt = requireTimestamp(input.closedAt, "closedAt");
		const modelBreakdownJson =
			input.modelBreakdown == null
				? null
				: JSON.stringify(input.modelBreakdown);
		const generationClause =
			expectedCreatedAt === undefined
				? ""
				: ` AND EXISTS (
					SELECT 1 FROM accounts
					WHERE id = usage_windows.account_id AND created_at = ?
				)`;
		const changes = await this.runWithChanges(
			`UPDATE usage_windows
			 SET closed_at = ?, value_usd = ?, input_tokens = ?,
			     cache_read_input_tokens = ?, cache_creation_input_tokens = ?,
			     output_tokens = ?, request_count = ?, model_breakdown = ?,
			     unpriced_tokens = ?, projection_version = ?
			 WHERE id = ? AND closed_at IS NULL${generationClause}`,
			[
				closedAt,
				input.valueUsd,
				input.inputTokens,
				input.cacheReadInputTokens,
				input.cacheCreationInputTokens,
				input.outputTokens,
				input.requestCount,
				modelBreakdownJson,
				input.unpricedTokens,
				input.projectionVersion,
				id,
				...(expectedCreatedAt === undefined ? [] : [expectedCreatedAt]),
			],
		);
		return changes === 1;
	}

	async listWindows(options: ListWindowsOptions = {}): Promise<UsageWindow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (options.accountId != null) {
			clauses.push("account_id = ?");
			params.push(options.accountId);
		}
		if (options.windowKey != null) {
			clauses.push("window_key = ?");
			params.push(options.windowKey);
		}
		if (options.sinceMs != null) {
			clauses.push("resets_at >= ?");
			params.push(options.sinceMs);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = await this.query<UsageWindowRow>(
			`SELECT ${WINDOW_COLUMNS} FROM usage_windows
			 ${where}
			 ORDER BY resets_at DESC`,
			params,
		);
		return rows.map(toUsageWindow);
	}
}
