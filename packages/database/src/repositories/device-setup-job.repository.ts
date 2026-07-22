import { randomUUID } from "node:crypto";
import type { ComboFamily } from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export const DEVICE_SETUP_JOB_STATUSES = [
	"awaiting_authorization",
	"account_committed",
	"reconciling",
	"complete",
	"complete_with_actions",
	"authorization_error",
	"expired",
] as const;

export type DeviceSetupJobStatus = (typeof DEVICE_SETUP_JOB_STATUSES)[number];
export type DeviceSetupProvider = "qwen" | "codex";
export type DeviceSetupTerminalStatus = "complete" | "complete_with_actions";
export type DeviceSetupRoutingOutcomeStatus = "joined" | "action-required";
export type DeviceSetupRoutingOutcomeReason =
	| "applied"
	| "already-effective"
	| "default-downgraded"
	| "preview-missing"
	| "proposal-missing"
	| "confidence-downgraded"
	| "stale-preview"
	| "preview-failed"
	| "apply-failed"
	| "not-effective"
	| "missing-account-id";

export const DEVICE_SETUP_SAFE_ERROR_MESSAGES = {
	authorization_denied: "Authorization was not approved",
	authorization_failed: "Authorization failed",
	authorization_interrupted: "Authorization must be restarted",
	authorization_expired: "Authorization expired",
} as const;

export type DeviceSetupSafeErrorCode =
	keyof typeof DEVICE_SETUP_SAFE_ERROR_MESSAGES;

export interface DeviceSetupRoutingSelection {
	family: ComboFamily;
	proposalId: string;
}

export interface DeviceSetupRoutingOutcome extends DeviceSetupRoutingSelection {
	status: DeviceSetupRoutingOutcomeStatus;
	reason: DeviceSetupRoutingOutcomeReason;
}

export interface DeviceSetupJob {
	id: string;
	idempotencyKey: string;
	requestFingerprint: string;
	provider: DeviceSetupProvider;
	accountId: string;
	status: DeviceSetupJobStatus;
	routingSelections: DeviceSetupRoutingSelection[];
	routingOutcomes: DeviceSetupRoutingOutcome[];
	routingCursor: number;
	leaseToken: string | null;
	leaseExpiresAt: number | null;
	attemptCount: number;
	errorCode: DeviceSetupSafeErrorCode | null;
	errorMessage: string | null;
	createdAt: number;
	updatedAt: number;
	terminalAt: number | null;
	retentionExpiresAt: number | null;
}

export type DeviceSetupJobView = Omit<
	DeviceSetupJob,
	"idempotencyKey" | "requestFingerprint" | "leaseToken" | "leaseExpiresAt"
>;

export interface CreateDeviceSetupJobInput {
	idempotencyKey: string;
	requestFingerprint: string;
	provider: DeviceSetupProvider;
	routingSelections: readonly DeviceSetupRoutingSelection[];
	now?: number;
	initialLeaseToken?: string;
	initialLeaseExpiresAt?: number;
}

export interface CreateDeviceSetupJobResult {
	job: DeviceSetupJob;
	created: boolean;
}

interface DeviceSetupJobRow {
	id: string;
	idempotency_key: string;
	request_fingerprint: string;
	provider: string;
	account_id: string;
	status: string;
	routing_selections_json: string;
	routing_outcomes_json: string;
	routing_cursor: number;
	lease_token: string | null;
	lease_expires_at: number | null;
	attempt_count: number;
	error_code: string | null;
	error_message: string | null;
	created_at: number;
	updated_at: number;
	terminal_at: number | null;
	retention_expires_at: number | null;
}

interface StoredRoutingSelection {
	family: ComboFamily;
	proposal_id: string;
}

interface StoredRoutingOutcome extends StoredRoutingSelection {
	status: DeviceSetupRoutingOutcomeStatus;
	reason: DeviceSetupRoutingOutcomeReason;
}

const JOB_COLUMNS = `
	id, idempotency_key, request_fingerprint, provider, account_id, status,
	routing_selections_json, routing_outcomes_json, routing_cursor,
	lease_token, lease_expires_at, attempt_count, error_code, error_message,
	created_at, updated_at, terminal_at, retention_expires_at
`;

const CLAIMABLE_STATUS_SQL =
	"('awaiting_authorization', 'account_committed', 'reconciling')";
const TERMINAL_STATUS_SQL =
	"('complete', 'complete_with_actions', 'authorization_error', 'expired')";

const COMBO_FAMILIES = new Set<ComboFamily>([
	"fable",
	"opus",
	"sonnet",
	"haiku",
]);
const OUTCOME_STATUSES = new Set<DeviceSetupRoutingOutcomeStatus>([
	"joined",
	"action-required",
]);
const OUTCOME_REASONS = new Set<DeviceSetupRoutingOutcomeReason>([
	"applied",
	"already-effective",
	"default-downgraded",
	"preview-missing",
	"proposal-missing",
	"confidence-downgraded",
	"stale-preview",
	"preview-failed",
	"apply-failed",
	"not-effective",
	"missing-account-id",
]);
const JOB_STATUSES = new Set<DeviceSetupJobStatus>(DEVICE_SETUP_JOB_STATUSES);
const PROVIDERS = new Set<DeviceSetupProvider>(["qwen", "codex"]);
const SAFE_ERROR_CODES = new Set<DeviceSetupSafeErrorCode>(
	Object.keys(DEVICE_SETUP_SAFE_ERROR_MESSAGES) as DeviceSetupSafeErrorCode[],
);

export class DeviceSetupIdempotencyConflictError extends Error {
	readonly code = "idempotency_conflict";

	constructor() {
		super("Idempotency key was already used for a different request");
		this.name = "DeviceSetupIdempotencyConflictError";
	}
}

export class DeviceSetupDataIntegrityError extends Error {
	readonly code = "device_setup_data_integrity_error";

	constructor(message: string) {
		super(message);
		this.name = "DeviceSetupDataIntegrityError";
	}
}

function requireNonEmpty(value: string, field: string): string {
	if (value.length === 0) {
		throw new TypeError(`${field} must not be empty`);
	}
	return value;
}

function requireTimestamp(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function toStoredSelection(
	selection: DeviceSetupRoutingSelection,
): StoredRoutingSelection {
	if (!COMBO_FAMILIES.has(selection.family)) {
		throw new TypeError(`Unsupported routing family: ${selection.family}`);
	}
	return {
		family: selection.family,
		proposal_id: requireNonEmpty(selection.proposalId, "proposalId"),
	};
}

function serializeSelections(
	selections: readonly DeviceSetupRoutingSelection[],
): string {
	const seenFamilies = new Set<ComboFamily>();
	const stored = selections.map((selection) => {
		const normalized = toStoredSelection(selection);
		if (seenFamilies.has(normalized.family)) {
			throw new TypeError(
				`Only one reviewed routing selection is allowed for ${normalized.family}`,
			);
		}
		seenFamilies.add(normalized.family);
		return normalized;
	});
	return JSON.stringify(stored);
}

function toStoredOutcome(
	outcome: DeviceSetupRoutingOutcome,
): StoredRoutingOutcome {
	const selection = toStoredSelection(outcome);
	if (!OUTCOME_STATUSES.has(outcome.status)) {
		throw new TypeError(
			`Unsupported routing outcome status: ${outcome.status}`,
		);
	}
	if (!OUTCOME_REASONS.has(outcome.reason)) {
		throw new TypeError(
			`Unsupported routing outcome reason: ${outcome.reason}`,
		);
	}
	return {
		...selection,
		status: outcome.status,
		reason: outcome.reason,
	};
}

function parseJsonArray(value: string, field: string): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new DeviceSetupDataIntegrityError(`${field} contains invalid JSON`);
	}
	if (!Array.isArray(parsed)) {
		throw new DeviceSetupDataIntegrityError(
			`${field} must contain a JSON array`,
		);
	}
	return parsed;
}

function parseStoredSelection(
	value: unknown,
	field: string,
): DeviceSetupRoutingSelection {
	if (typeof value !== "object" || value === null) {
		throw new DeviceSetupDataIntegrityError(
			`${field} contains an invalid item`,
		);
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.family !== "string" ||
		!COMBO_FAMILIES.has(candidate.family as ComboFamily) ||
		typeof candidate.proposal_id !== "string" ||
		candidate.proposal_id.length === 0
	) {
		throw new DeviceSetupDataIntegrityError(
			`${field} contains an invalid item`,
		);
	}
	return {
		family: candidate.family as ComboFamily,
		proposalId: candidate.proposal_id,
	};
}

function parseSelections(value: string): DeviceSetupRoutingSelection[] {
	return parseJsonArray(value, "routing_selections_json").map((selection) =>
		parseStoredSelection(selection, "routing_selections_json"),
	);
}

function parseOutcomes(value: string): DeviceSetupRoutingOutcome[] {
	return parseJsonArray(value, "routing_outcomes_json").map((outcome) => {
		const selection = parseStoredSelection(outcome, "routing_outcomes_json");
		const candidate = outcome as Record<string, unknown>;
		if (
			typeof candidate.status !== "string" ||
			!OUTCOME_STATUSES.has(
				candidate.status as DeviceSetupRoutingOutcomeStatus,
			) ||
			typeof candidate.reason !== "string" ||
			!OUTCOME_REASONS.has(candidate.reason as DeviceSetupRoutingOutcomeReason)
		) {
			throw new DeviceSetupDataIntegrityError(
				"routing_outcomes_json contains an invalid item",
			);
		}
		return {
			...selection,
			status: candidate.status as DeviceSetupRoutingOutcomeStatus,
			reason: candidate.reason as DeviceSetupRoutingOutcomeReason,
		};
	});
}

function optionalNumber(value: number | null): number | null {
	return value === null ? null : Number(value);
}

function toDeviceSetupJob(row: DeviceSetupJobRow): DeviceSetupJob {
	if (!PROVIDERS.has(row.provider as DeviceSetupProvider)) {
		throw new DeviceSetupDataIntegrityError(
			"device setup job has invalid provider",
		);
	}
	if (!JOB_STATUSES.has(row.status as DeviceSetupJobStatus)) {
		throw new DeviceSetupDataIntegrityError(
			"device setup job has invalid status",
		);
	}
	if (
		row.error_code !== null &&
		!SAFE_ERROR_CODES.has(row.error_code as DeviceSetupSafeErrorCode)
	) {
		throw new DeviceSetupDataIntegrityError(
			"device setup job has invalid error code",
		);
	}
	return {
		id: row.id,
		idempotencyKey: row.idempotency_key,
		requestFingerprint: row.request_fingerprint,
		provider: row.provider as DeviceSetupProvider,
		accountId: row.account_id,
		status: row.status as DeviceSetupJobStatus,
		routingSelections: parseSelections(row.routing_selections_json),
		routingOutcomes: parseOutcomes(row.routing_outcomes_json),
		routingCursor: Number(row.routing_cursor),
		leaseToken: row.lease_token,
		leaseExpiresAt: optionalNumber(row.lease_expires_at),
		attemptCount: Number(row.attempt_count),
		errorCode: row.error_code as DeviceSetupSafeErrorCode | null,
		errorMessage: row.error_message,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		terminalAt: optionalNumber(row.terminal_at),
		retentionExpiresAt: optionalNumber(row.retention_expires_at),
	};
}

function toDeviceSetupJobView(job: DeviceSetupJob): DeviceSetupJobView {
	return {
		id: job.id,
		provider: job.provider,
		accountId: job.accountId,
		status: job.status,
		routingSelections: job.routingSelections,
		routingOutcomes: job.routingOutcomes,
		routingCursor: job.routingCursor,
		attemptCount: job.attemptCount,
		errorCode: job.errorCode,
		errorMessage: job.errorMessage,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		terminalAt: job.terminalAt,
		retentionExpiresAt: job.retentionExpiresAt,
	};
}

export class DeviceSetupJobRepository extends BaseRepository<DeviceSetupJob> {
	async createOrGet(
		input: CreateDeviceSetupJobInput,
	): Promise<CreateDeviceSetupJobResult> {
		const idempotencyKey = requireNonEmpty(
			input.idempotencyKey,
			"idempotencyKey",
		);
		const requestFingerprint = requireNonEmpty(
			input.requestFingerprint,
			"requestFingerprint",
		);
		if (!PROVIDERS.has(input.provider)) {
			throw new TypeError(
				`Unsupported device setup provider: ${input.provider}`,
			);
		}
		const now = requireTimestamp(input.now ?? Date.now(), "now");
		const hasInitialLeaseToken = input.initialLeaseToken !== undefined;
		const hasInitialLeaseExpiry = input.initialLeaseExpiresAt !== undefined;
		if (hasInitialLeaseToken !== hasInitialLeaseExpiry) {
			throw new TypeError(
				"initialLeaseToken and initialLeaseExpiresAt must be provided together",
			);
		}
		const initialLeaseToken =
			input.initialLeaseToken === undefined
				? null
				: requireNonEmpty(input.initialLeaseToken, "initialLeaseToken");
		const initialLeaseExpiresAt =
			input.initialLeaseExpiresAt === undefined
				? null
				: requireTimestamp(
						input.initialLeaseExpiresAt,
						"initialLeaseExpiresAt",
					);
		if (initialLeaseExpiresAt !== null && initialLeaseExpiresAt <= now) {
			throw new TypeError("initialLeaseExpiresAt must be after now");
		}
		const routingSelectionsJson = serializeSelections(input.routingSelections);
		const id = randomUUID();
		const accountId = randomUUID();
		const changes = await this.runWithChanges(
			`INSERT INTO device_setup_jobs (
				id, idempotency_key, request_fingerprint, provider, account_id,
				status, routing_selections_json, routing_outcomes_json, routing_cursor,
				lease_token, lease_expires_at, attempt_count, error_code, error_message,
				created_at, updated_at, terminal_at, retention_expires_at
			) VALUES (?, ?, ?, ?, ?, 'awaiting_authorization', ?, '[]', 0,
				?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
			ON CONFLICT (idempotency_key) DO NOTHING`,
			[
				id,
				idempotencyKey,
				requestFingerprint,
				input.provider,
				accountId,
				routingSelectionsJson,
				initialLeaseToken,
				initialLeaseExpiresAt,
				initialLeaseToken === null ? 0 : 1,
				now,
				now,
			],
		);

		const job = await this.findByIdempotencyKey(idempotencyKey);
		if (!job) {
			throw new Error("Failed to create or load device setup job");
		}
		if (job.requestFingerprint !== requestFingerprint) {
			throw new DeviceSetupIdempotencyConflictError();
		}
		return { job, created: changes === 1 };
	}

	async findById(id: string): Promise<DeviceSetupJob | null> {
		const row = await this.get<DeviceSetupJobRow>(
			`SELECT ${JOB_COLUMNS} FROM device_setup_jobs WHERE id = ?`,
			[id],
		);
		return row ? toDeviceSetupJob(row) : null;
	}

	async findByIdempotencyKey(
		idempotencyKey: string,
	): Promise<DeviceSetupJob | null> {
		const row = await this.get<DeviceSetupJobRow>(
			`SELECT ${JOB_COLUMNS}
			 FROM device_setup_jobs WHERE idempotency_key = ?`,
			[idempotencyKey],
		);
		return row ? toDeviceSetupJob(row) : null;
	}

	async listClaimable(now: number, limit = 50): Promise<DeviceSetupJob[]> {
		requireTimestamp(now, "now");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new TypeError("limit must be an integer between 1 and 1000");
		}
		const rows = await this.query<DeviceSetupJobRow>(
			`SELECT ${JOB_COLUMNS}
			 FROM device_setup_jobs
			 WHERE status IN ${CLAIMABLE_STATUS_SQL}
			   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
			 ORDER BY updated_at ASC, id ASC
			 LIMIT ?`,
			[now, limit],
		);
		return rows.map(toDeviceSetupJob);
	}

	async listRecent(
		limit = 50,
		now = Date.now(),
	): Promise<DeviceSetupJobView[]> {
		requireTimestamp(now, "now");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new TypeError("limit must be an integer between 1 and 1000");
		}
		const rows = await this.query<DeviceSetupJobRow>(
			`SELECT ${JOB_COLUMNS}
			 FROM device_setup_jobs
			 WHERE status IN ${CLAIMABLE_STATUS_SQL}
			    OR (
			      status IN ${TERMINAL_STATUS_SQL}
			      AND retention_expires_at IS NOT NULL
			      AND retention_expires_at > ?
			    )
			 ORDER BY updated_at DESC, id DESC
			 LIMIT ?`,
			[now, limit],
		);
		return rows.map(toDeviceSetupJob).map(toDeviceSetupJobView);
	}

	async tryClaim(
		id: string,
		leaseToken: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<boolean> {
		requireNonEmpty(leaseToken, "leaseToken");
		requireTimestamp(now, "now");
		requireTimestamp(leaseExpiresAt, "leaseExpiresAt");
		if (leaseExpiresAt <= now) {
			throw new TypeError("leaseExpiresAt must be later than now");
		}
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET lease_token = ?, lease_expires_at = ?,
			     attempt_count = attempt_count + 1, updated_at = ?
			 WHERE id = ?
			   AND status IN ${CLAIMABLE_STATUS_SQL}
			   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
			[leaseToken, leaseExpiresAt, now, id, now],
		);
		return changes === 1;
	}

	async renewLease(
		id: string,
		leaseToken: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<boolean> {
		requireNonEmpty(leaseToken, "leaseToken");
		requireTimestamp(now, "now");
		requireTimestamp(leaseExpiresAt, "leaseExpiresAt");
		if (leaseExpiresAt <= now) {
			throw new TypeError("leaseExpiresAt must be later than now");
		}
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET lease_expires_at = CASE
			       WHEN lease_expires_at < ? THEN ?
			       ELSE lease_expires_at
			     END,
			     updated_at = CASE
			       WHEN updated_at < ? THEN ?
			       ELSE updated_at
			     END
			 WHERE id = ? AND lease_token = ?
			   AND status IN ${CLAIMABLE_STATUS_SQL}
			   AND lease_expires_at > ?`,
			[leaseExpiresAt, leaseExpiresAt, now, now, id, leaseToken, now],
		);
		return changes === 1;
	}

	async markAccountCommitted(
		id: string,
		leaseToken: string,
		now: number,
	): Promise<boolean> {
		requireTimestamp(now, "now");
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET status = 'account_committed', updated_at = ?
			 WHERE id = ? AND status = 'awaiting_authorization'
			   AND lease_token = ? AND lease_expires_at > ?
			   AND EXISTS (
			     SELECT 1 FROM accounts
			     WHERE accounts.id = device_setup_jobs.account_id
			   )`,
			[now, id, leaseToken, now],
		);
		return changes === 1;
	}

	async beginReconciliation(
		id: string,
		leaseToken: string,
		now: number,
	): Promise<boolean> {
		requireTimestamp(now, "now");
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET status = 'reconciling', updated_at = ?
			 WHERE id = ? AND status = 'account_committed'
			   AND lease_token = ? AND lease_expires_at > ?`,
			[now, id, leaseToken, now],
		);
		return changes === 1;
	}

	async advanceRoutingOutcome(
		id: string,
		leaseToken: string,
		expectedCursor: number,
		outcome: DeviceSetupRoutingOutcome,
		now: number,
	): Promise<boolean> {
		requireTimestamp(now, "now");
		if (!Number.isSafeInteger(expectedCursor) || expectedCursor < 0) {
			throw new TypeError("expectedCursor must be a non-negative integer");
		}
		const job = await this.findById(id);
		if (
			!job ||
			job.status !== "reconciling" ||
			job.leaseToken !== leaseToken ||
			job.leaseExpiresAt === null ||
			job.leaseExpiresAt <= now ||
			job.routingCursor !== expectedCursor
		) {
			return false;
		}
		if (job.routingOutcomes.length !== expectedCursor) {
			throw new DeviceSetupDataIntegrityError(
				"routing outcome count does not match routing cursor",
			);
		}
		const reviewed = job.routingSelections[expectedCursor];
		if (!reviewed) return false;
		const storedOutcome = toStoredOutcome(outcome);
		if (
			reviewed.family !== outcome.family ||
			reviewed.proposalId !== outcome.proposalId
		) {
			throw new TypeError("routing outcome does not match reviewed selection");
		}
		const storedOutcomes = job.routingOutcomes.map(toStoredOutcome);
		storedOutcomes.push(storedOutcome);
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET routing_outcomes_json = ?, routing_cursor = ?, updated_at = ?
			 WHERE id = ? AND status = 'reconciling'
			   AND lease_token = ? AND lease_expires_at > ?
			   AND routing_cursor = ?`,
			[
				JSON.stringify(storedOutcomes),
				expectedCursor + 1,
				now,
				id,
				leaseToken,
				now,
				expectedCursor,
			],
		);
		return changes === 1;
	}

	async finish(
		id: string,
		leaseToken: string,
		expectedCursor: number,
		status: DeviceSetupTerminalStatus,
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean> {
		requireTimestamp(now, "now");
		requireTimestamp(retentionExpiresAt, "retentionExpiresAt");
		if (retentionExpiresAt < now) {
			throw new TypeError("retentionExpiresAt must not be earlier than now");
		}
		if (!Number.isSafeInteger(expectedCursor) || expectedCursor < 0) {
			throw new TypeError("expectedCursor must be a non-negative integer");
		}
		const job = await this.findById(id);
		if (
			!job ||
			job.status !== "reconciling" ||
			job.leaseToken !== leaseToken ||
			job.leaseExpiresAt === null ||
			job.leaseExpiresAt <= now ||
			job.routingCursor !== expectedCursor
		) {
			return false;
		}
		if (
			job.routingSelections.length !== expectedCursor ||
			job.routingOutcomes.length !== expectedCursor
		) {
			return false;
		}
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET status = ?, updated_at = ?, terminal_at = ?, retention_expires_at = ?,
			     lease_token = NULL, lease_expires_at = NULL
			 WHERE id = ? AND status = 'reconciling'
			   AND lease_token = ? AND lease_expires_at > ?
			   AND routing_cursor = ?`,
			[
				status,
				now,
				now,
				retentionExpiresAt,
				id,
				leaseToken,
				now,
				expectedCursor,
			],
		);
		return changes === 1;
	}

	async markAuthorizationError(
		id: string,
		leaseToken: string,
		errorCode: Exclude<DeviceSetupSafeErrorCode, "authorization_expired">,
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean> {
		return this.finishAuthorization(
			id,
			leaseToken,
			"authorization_error",
			errorCode,
			now,
			retentionExpiresAt,
		);
	}

	async markExpired(
		id: string,
		leaseToken: string,
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean> {
		return this.finishAuthorization(
			id,
			leaseToken,
			"expired",
			"authorization_expired",
			now,
			retentionExpiresAt,
		);
	}

	private async finishAuthorization(
		id: string,
		leaseToken: string,
		status: "authorization_error" | "expired",
		errorCode: DeviceSetupSafeErrorCode,
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean> {
		requireTimestamp(now, "now");
		requireTimestamp(retentionExpiresAt, "retentionExpiresAt");
		if (retentionExpiresAt < now) {
			throw new TypeError("retentionExpiresAt must not be earlier than now");
		}
		const changes = await this.runWithChanges(
			`UPDATE device_setup_jobs
			 SET status = ?, error_code = ?, error_message = ?,
			     updated_at = ?, terminal_at = ?, retention_expires_at = ?,
			     lease_token = NULL, lease_expires_at = NULL
			 WHERE id = ? AND status = 'awaiting_authorization'
			   AND lease_token = ? AND lease_expires_at > ?`,
			[
				status,
				errorCode,
				DEVICE_SETUP_SAFE_ERROR_MESSAGES[errorCode],
				now,
				now,
				retentionExpiresAt,
				id,
				leaseToken,
				now,
			],
		);
		return changes === 1;
	}

	async deleteTerminalBefore(now: number): Promise<number> {
		requireTimestamp(now, "now");
		return this.runWithChanges(
			`DELETE FROM device_setup_jobs
			 WHERE status IN ${TERMINAL_STATUS_SQL}
			   AND retention_expires_at IS NOT NULL
			   AND retention_expires_at <= ?`,
			[now],
		);
	}
}
