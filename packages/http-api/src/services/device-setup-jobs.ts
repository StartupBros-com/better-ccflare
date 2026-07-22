import { createHash } from "node:crypto";
import type {
	DeviceSetupAuthorizationView,
	DeviceSetupJobStatus,
	DeviceSetupJobView,
	DeviceSetupProvider,
	DeviceSetupRoutingOutcome,
	DeviceSetupRoutingOutcomeReason,
	DeviceSetupRoutingSelection,
	DeviceSetupSafeErrorCode,
	DeviceSetupStartResult,
} from "@better-ccflare/types";

// Keep the service runtime free of the types-package barrel's legacy runtime
// cycle. The public constants in @better-ccflare/types use these exact values.
const SAFE_ERROR_MESSAGES = {
	authorization_denied: "Authorization was not approved",
	authorization_failed: "Authorization failed",
	authorization_interrupted: "Authorization must be restarted",
	authorization_expired: "Authorization expired",
} as const satisfies Record<DeviceSetupSafeErrorCode, string>;

const FAMILIES = new Set(["fable", "opus", "sonnet", "haiku"] as const);
const COMMAND_FIELDS = new Set([
	"name",
	"priority",
	"idempotencyKey",
	"reviewed",
]);
const SELECTION_FIELDS = new Set(["family", "proposalId"]);
const TERMINAL_ACCOUNT_STATUSES = new Set<DeviceSetupJobStatus>([
	"account_committed",
	"reconciling",
	"complete",
	"complete_with_actions",
]);
const TERMINAL_JOB_STATUSES = new Set<DeviceSetupJobStatus>([
	"complete",
	"complete_with_actions",
	"authorization_error",
	"expired",
]);
const OUTCOME_REASONS = new Set<DeviceSetupRoutingOutcomeReason>([
	"applied",
	"already-effective",
	"preview-missing",
	"proposal-missing",
	"confidence-downgraded",
	"default-downgraded",
	"stale-preview",
	"preview-failed",
	"apply-failed",
	"not-effective",
	"missing-account-id",
]);
const MAX_ACCOUNT_NAME_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PROPOSAL_ID_LENGTH = 512;
const MAX_RECENT_JOBS = 100;
const DEFAULT_RECENT_JOBS = 50;
const DEFAULT_CLAIM_BATCH = 50;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETENTION_MS = 10 * 60_000;

export interface DeviceSetupCommand {
	name: string;
	priority: number;
	idempotencyKey: string;
	reviewed: DeviceSetupRoutingSelection[];
}

/** Internal durable row shape required from the database repository. */
export interface PersistedDeviceSetupJob {
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

export type RecentDeviceSetupJob = Pick<
	PersistedDeviceSetupJob,
	| "id"
	| "provider"
	| "accountId"
	| "status"
	| "routingOutcomes"
	| "errorCode"
	| "createdAt"
	| "updatedAt"
	| "terminalAt"
>;

export interface DeviceSetupJobRepository {
	createOrGet(input: {
		idempotencyKey: string;
		requestFingerprint: string;
		provider: DeviceSetupProvider;
		routingSelections: readonly DeviceSetupRoutingSelection[];
		now: number;
		initialLeaseToken?: string;
		initialLeaseExpiresAt?: number;
	}): Promise<{ job: PersistedDeviceSetupJob; created: boolean }>;
	findById(id: string): Promise<PersistedDeviceSetupJob | null>;
	/** Recent terminal and non-terminal jobs for authenticated UI recovery. */
	listRecent(limit: number): Promise<RecentDeviceSetupJob[]>;
	listClaimable(now: number, limit: number): Promise<PersistedDeviceSetupJob[]>;
	tryClaim(
		id: string,
		leaseToken: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<boolean>;
	renewLease(
		id: string,
		leaseToken: string,
		now: number,
		leaseExpiresAt: number,
	): Promise<boolean>;
	markAccountCommitted(
		id: string,
		leaseToken: string,
		now: number,
	): Promise<boolean>;
	beginReconciliation(
		id: string,
		leaseToken: string,
		now: number,
	): Promise<boolean>;
	advanceRoutingOutcome(
		id: string,
		leaseToken: string,
		expectedCursor: number,
		outcome: DeviceSetupRoutingOutcome,
		now: number,
	): Promise<boolean>;
	finish(
		id: string,
		leaseToken: string,
		expectedCursor: number,
		status: "complete" | "complete_with_actions",
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean>;
	markAuthorizationError(
		id: string,
		leaseToken: string,
		errorCode: Exclude<DeviceSetupSafeErrorCode, "authorization_expired">,
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean>;
	markExpired(
		id: string,
		leaseToken: string,
		now: number,
		retentionExpiresAt: number,
	): Promise<boolean>;
	deleteTerminalBefore(now: number): Promise<number>;
}

export interface DeviceSetupProviderStart {
	verificationUrl: string;
	userCode: string;
	/** Secret provider state. Kept in memory only and never projected. */
	continuation: unknown;
}

export interface DeviceSetupProviderDriver {
	initiate(): Promise<DeviceSetupProviderStart>;
	poll(continuation: unknown): Promise<unknown>;
}

export interface DeviceSetupRoutingFinalizationResult {
	accountId: string;
	outcomes: Array<{
		family: DeviceSetupRoutingSelection["family"];
		proposalId: string;
		status: "joined" | "action-required";
		reason: DeviceSetupRoutingOutcomeReason;
	}>;
}

export interface DeviceSetupCoordinatorDependencies {
	repository: DeviceSetupJobRepository;
	providers: Record<DeviceSetupProvider, DeviceSetupProviderDriver>;
	commitAuthorizedAccount(input: {
		provider: DeviceSetupProvider;
		accountId: string;
		name: string;
		priority: number;
		credential: unknown;
	}): Promise<void>;
	accountExists(accountId: string): Promise<boolean>;
	finalizeRouting(input: {
		accountId: string;
		reviewed: readonly DeviceSetupRoutingSelection[];
	}): Promise<DeviceSetupRoutingFinalizationResult>;
	now?: () => number;
	randomId?: () => string;
	runInBackground?: (task: () => Promise<void>) => void;
	leaseMs?: number;
	retentionMs?: number;
	claimBatch?: number;
	startLeaseHeartbeat?: (
		task: () => Promise<void>,
		intervalMs: number,
	) => () => void;
}

export interface DeviceSetupCoordinator {
	initQwen(input: unknown): Promise<DeviceSetupStartResult>;
	initCodex(input: unknown): Promise<DeviceSetupStartResult>;
	get(id: string): Promise<DeviceSetupJobView | null>;
	listRecent(limit?: number): Promise<DeviceSetupJobView[]>;
	tick(): Promise<void>;
	dispose(): void;
	drain(): Promise<void>;
}

export class DeviceSetupValidationError extends Error {
	readonly code = "invalid_device_setup_request";

	constructor(message: string) {
		super(message);
		this.name = "DeviceSetupValidationError";
	}
}

export class DeviceSetupIdempotencyConflictError extends Error {
	readonly code = "idempotency_conflict";

	constructor() {
		super("Idempotency key was already used for a different request");
		this.name = "DeviceSetupIdempotencyConflictError";
	}
}

/**
 * Database adapters intentionally do not depend on this HTTP service, so their
 * concrete conflict class has a different prototype. Translate only the exact
 * stable repository error contract at the coordinator boundary.
 */
function isRepositoryIdempotencyConflict(
	error: unknown,
): error is Error & { readonly code: "idempotency_conflict" } {
	return (
		error instanceof Error &&
		error.name === "DeviceSetupIdempotencyConflictError" &&
		"code" in error &&
		(error as { code?: unknown }).code === "idempotency_conflict"
	);
}

export class DeviceSetupAuthorizationUnavailableError extends Error {
	readonly code = "authorization_unavailable";

	constructor() {
		super("Authorization must be restarted with a new idempotency key");
		this.name = "DeviceSetupAuthorizationUnavailableError";
	}
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DeviceSetupValidationError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireExactFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	field: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new DeviceSetupValidationError(
				`${field} contains unknown field ${key}`,
			);
		}
	}
}

function requireBoundedString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value.trim() !== value
	) {
		throw new DeviceSetupValidationError(
			`${field} must be a non-empty, unpadded string of at most ${maxLength} characters`,
		);
	}
	return value;
}

/** Parse only the setup fields the server is willing to persist or act on. */
export function validateDeviceSetupCommand(input: unknown): DeviceSetupCommand {
	const value = requireRecord(input, "device setup request");
	requireExactFields(value, COMMAND_FIELDS, "device setup request");
	const name = requireBoundedString(
		value.name,
		"name",
		MAX_ACCOUNT_NAME_LENGTH,
	);
	if (!/^[A-Za-z0-9 ._-]+$/.test(name)) {
		throw new DeviceSetupValidationError(
			"name contains unsupported characters",
		);
	}
	if (
		!Number.isSafeInteger(value.priority) ||
		(value.priority as number) < 0 ||
		(value.priority as number) > 100
	) {
		throw new DeviceSetupValidationError(
			"priority must be an integer between 0 and 100",
		);
	}
	const idempotencyKey = requireBoundedString(
		value.idempotencyKey,
		"idempotencyKey",
		MAX_IDEMPOTENCY_KEY_LENGTH,
	);
	if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
		throw new DeviceSetupValidationError(
			"idempotencyKey contains unsupported characters",
		);
	}
	if (!Array.isArray(value.reviewed)) {
		throw new DeviceSetupValidationError("reviewed must be an array");
	}
	if (value.reviewed.length > FAMILIES.size) {
		throw new DeviceSetupValidationError(
			"reviewed contains too many selections",
		);
	}
	const seenFamilies = new Set<string>();
	const reviewed = value.reviewed.map((rawSelection, index) => {
		const selection = requireRecord(rawSelection, `reviewed[${index}]`);
		requireExactFields(selection, SELECTION_FIELDS, `reviewed[${index}]`);
		if (
			typeof selection.family !== "string" ||
			!FAMILIES.has(selection.family as never)
		) {
			throw new DeviceSetupValidationError(
				`reviewed[${index}].family is unsupported`,
			);
		}
		if (seenFamilies.has(selection.family)) {
			throw new DeviceSetupValidationError(
				`reviewed contains more than one ${selection.family} selection`,
			);
		}
		seenFamilies.add(selection.family);
		return {
			family: selection.family as DeviceSetupRoutingSelection["family"],
			proposalId: requireBoundedString(
				selection.proposalId,
				`reviewed[${index}].proposalId`,
				MAX_PROPOSAL_ID_LENGTH,
			),
		};
	});
	reviewed.sort(
		(a, b) =>
			a.family.localeCompare(b.family) ||
			a.proposalId.localeCompare(b.proposalId),
	);
	return {
		name,
		priority: value.priority as number,
		idempotencyKey,
		reviewed,
	};
}

/** Hash the canonical safe command; reviewed array order is semantically inert. */
export function fingerprintDeviceSetupCommand(
	provider: DeviceSetupProvider,
	command: DeviceSetupCommand,
): string {
	const canonical = JSON.stringify({
		provider,
		name: command.name,
		priority: command.priority,
		reviewed: [...command.reviewed]
			.sort(
				(a, b) =>
					a.family.localeCompare(b.family) ||
					a.proposalId.localeCompare(b.proposalId),
			)
			.map(({ family, proposalId }) => ({ family, proposalId })),
	});
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function publicJob(job: RecentDeviceSetupJob): DeviceSetupJobView {
	const errorCode = job.errorCode;
	return {
		id: job.id,
		provider: job.provider,
		accountId: TERMINAL_ACCOUNT_STATUSES.has(job.status) ? job.accountId : null,
		status: job.status,
		routingOutcomes: job.routingOutcomes.map((outcome) => ({ ...outcome })),
		errorCode,
		errorMessage: errorCode ? SAFE_ERROR_MESSAGES[errorCode] : null,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		terminalAt: job.terminalAt,
	};
}

function safeAuthorization(
	start: DeviceSetupProviderStart,
): DeviceSetupAuthorizationView {
	return {
		verificationUrl: requireBoundedString(
			start.verificationUrl,
			"verificationUrl",
			4_096,
		),
		userCode: requireBoundedString(start.userCode, "userCode", 512),
	};
}

function authorizationErrorCode(
	error: unknown,
): Exclude<DeviceSetupSafeErrorCode, "authorization_expired"> {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (
			code === "authorization_denied" ||
			code === "authorization_failed" ||
			code === "authorization_interrupted"
		) {
			return code;
		}
	}
	return "authorization_failed";
}

function normalizeOutcome(
	selection: DeviceSetupRoutingSelection,
	accountId: string,
	result: DeviceSetupRoutingFinalizationResult,
): DeviceSetupRoutingOutcome {
	if (result.accountId === accountId) {
		const outcome = result.outcomes.find(
			(candidate) =>
				candidate.family === selection.family &&
				candidate.proposalId === selection.proposalId,
		);
		if (
			outcome &&
			(outcome.status === "joined" || outcome.status === "action-required") &&
			OUTCOME_REASONS.has(outcome.reason)
		) {
			return {
				family: selection.family,
				proposalId: selection.proposalId,
				status: outcome.status,
				reason: outcome.reason,
			};
		}
	}
	return {
		...selection,
		status: "action-required",
		reason: "apply-failed",
	};
}

interface ActiveAuthorization {
	command: DeviceSetupCommand;
	provider: DeviceSetupProvider;
	authorization: DeviceSetupAuthorizationView | null;
	continuation: unknown;
	leaseToken: string;
	leaseLost: boolean;
	commitStarted: boolean;
	abortController: AbortController;
	stopHeartbeat: () => void;
}

class DeviceSetupDisposedError extends Error {
	constructor() {
		super("Device setup coordinator was disposed");
		this.name = "DeviceSetupDisposedError";
	}
}

/**
 * Logically abort a provider poll without requiring provider-specific signal
 * support. The original promise remains observed, while the coordinator task
 * settles immediately and is fenced from all later database work.
 */
function pollUntilDisposed<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		void operation.catch(() => undefined);
		return Promise.reject(new DeviceSetupDisposedError());
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new DeviceSetupDisposedError());
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

class DurableDeviceSetupCoordinator implements DeviceSetupCoordinator {
	private readonly repository: DeviceSetupJobRepository;
	private readonly providers: Record<
		DeviceSetupProvider,
		DeviceSetupProviderDriver
	>;
	private readonly commitAuthorizedAccount: DeviceSetupCoordinatorDependencies["commitAuthorizedAccount"];
	private readonly accountExists: DeviceSetupCoordinatorDependencies["accountExists"];
	private readonly finalizeRouting: DeviceSetupCoordinatorDependencies["finalizeRouting"];
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly runInBackground: (task: () => Promise<void>) => void;
	private readonly leaseMs: number;
	private readonly retentionMs: number;
	private readonly claimBatch: number;
	private readonly startLeaseHeartbeat: NonNullable<
		DeviceSetupCoordinatorDependencies["startLeaseHeartbeat"]
	>;
	private readonly active = new Map<string, ActiveAuthorization>();
	private readonly initializing = new Set<string>();
	private readonly inFlightWork = new Set<Promise<void>>();
	private tickPromise: Promise<void> | null = null;
	private disposed = false;

	constructor(dependencies: DeviceSetupCoordinatorDependencies) {
		this.repository = dependencies.repository;
		this.providers = dependencies.providers;
		this.commitAuthorizedAccount = dependencies.commitAuthorizedAccount;
		this.accountExists = dependencies.accountExists;
		this.finalizeRouting = dependencies.finalizeRouting;
		this.now = dependencies.now ?? Date.now;
		this.randomId = dependencies.randomId ?? (() => crypto.randomUUID());
		this.runInBackground =
			dependencies.runInBackground ??
			((task) => {
				void task().catch(() => undefined);
			});
		this.leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS;
		this.retentionMs = dependencies.retentionMs ?? DEFAULT_RETENTION_MS;
		this.claimBatch = dependencies.claimBatch ?? DEFAULT_CLAIM_BATCH;
		this.startLeaseHeartbeat =
			dependencies.startLeaseHeartbeat ??
			((task, intervalMs) => {
				const timer = setInterval(() => {
					void task().catch(() => undefined);
				}, intervalMs);
				return () => clearInterval(timer);
			});
	}

	initQwen(input: unknown): Promise<DeviceSetupStartResult> {
		return this.initialize("qwen", input);
	}

	initCodex(input: unknown): Promise<DeviceSetupStartResult> {
		return this.initialize("codex", input);
	}

	async get(id: string): Promise<DeviceSetupJobView | null> {
		if (typeof id !== "string" || id.length === 0) return null;
		const job = await this.repository.findById(id);
		return job ? publicJob(job) : null;
	}

	async listRecent(limit = DEFAULT_RECENT_JOBS): Promise<DeviceSetupJobView[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECENT_JOBS) {
			throw new DeviceSetupValidationError(
				`limit must be an integer between 1 and ${MAX_RECENT_JOBS}`,
			);
		}
		return (await this.repository.listRecent(limit)).map(publicJob);
	}

	tick(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.tickPromise) return this.tickPromise;
		const running = this.performTick().finally(() => {
			if (this.tickPromise === running) this.tickPromise = null;
		});
		this.tickPromise = running;
		return running;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const authorization of this.active.values()) {
			authorization.stopHeartbeat();
			if (!authorization.commitStarted) {
				authorization.leaseLost = true;
				authorization.abortController.abort();
			}
		}
		this.initializing.clear();
	}

	async drain(): Promise<void> {
		while (true) {
			const pending = [...this.inFlightWork];
			if (this.tickPromise) pending.push(this.tickPromise);
			if (pending.length === 0) return;
			await Promise.allSettled(pending);
		}
	}

	private trackInFlight(task: () => Promise<void>): Promise<void> {
		let running: Promise<void>;
		try {
			running = Promise.resolve(task());
		} catch (error) {
			running = Promise.reject(error);
		}
		this.inFlightWork.add(running);
		const remove = () => this.inFlightWork.delete(running);
		void running.then(remove, remove);
		return running;
	}

	private scheduleBackgroundWork(task: () => Promise<void>): void {
		this.runInBackground(() => {
			if (this.disposed) return Promise.resolve();
			return this.trackInFlight(task);
		});
	}

	private async initialize(
		provider: DeviceSetupProvider,
		input: unknown,
	): Promise<DeviceSetupStartResult> {
		if (this.disposed) {
			throw new DeviceSetupAuthorizationUnavailableError();
		}
		const command = validateDeviceSetupCommand(input);
		const requestFingerprint = fingerprintDeviceSetupCommand(provider, command);
		const now = this.now();
		const leaseToken = this.randomId();
		let created: Awaited<ReturnType<DeviceSetupJobRepository["createOrGet"]>>;
		try {
			created = await this.repository.createOrGet({
				idempotencyKey: command.idempotencyKey,
				requestFingerprint,
				provider,
				routingSelections: command.reviewed,
				now,
				initialLeaseToken: leaseToken,
				initialLeaseExpiresAt: now + this.leaseMs,
			});
		} catch (error) {
			if (isRepositoryIdempotencyConflict(error)) {
				throw new DeviceSetupIdempotencyConflictError();
			}
			throw error;
		}
		if (
			created.job.requestFingerprint !== requestFingerprint ||
			created.job.provider !== provider
		) {
			throw new DeviceSetupIdempotencyConflictError();
		}
		if (!created.created) {
			const active = this.active.get(created.job.id);
			return {
				job: publicJob(created.job),
				authorization: active?.authorization ?? null,
				replayed: true,
			};
		}
		if (
			created.job.leaseToken !== leaseToken ||
			created.job.leaseExpiresAt === null ||
			created.job.leaseExpiresAt <= now
		) {
			throw new DeviceSetupAuthorizationUnavailableError();
		}

		this.initializing.add(created.job.id);
		const active: ActiveAuthorization = {
			command,
			provider,
			authorization: null,
			continuation: null,
			leaseToken,
			leaseLost: false,
			commitStarted: false,
			abortController: new AbortController(),
			stopHeartbeat: () => undefined,
		};
		this.active.set(created.job.id, active);
		active.stopHeartbeat = this.beginAuthorizationLeaseHeartbeat(
			created.job.id,
			active,
		);
		let start: DeviceSetupProviderStart;
		let authorization: DeviceSetupAuthorizationView;
		try {
			start = await this.providers[provider].initiate();
			authorization = safeAuthorization(start);
		} catch (error) {
			this.initializing.delete(created.job.id);
			active.stopHeartbeat();
			this.active.delete(created.job.id);
			await this.finishAuthorizationError(
				created.job.id,
				authorizationErrorCode(error),
				leaseToken,
			);
			throw new DeviceSetupAuthorizationUnavailableError();
		}
		if (this.disposed || active.leaseLost) {
			this.initializing.delete(created.job.id);
			active.stopHeartbeat();
			this.active.delete(created.job.id);
			throw new DeviceSetupAuthorizationUnavailableError();
		}
		active.authorization = authorization;
		active.continuation = start.continuation;
		this.initializing.delete(created.job.id);
		this.scheduleBackgroundWork(() =>
			this.completeAuthorization(created.job.id, active),
		);
		return {
			job: publicJob(created.job),
			authorization,
			replayed: false,
		};
	}

	private beginAuthorizationLeaseHeartbeat(
		jobId: string,
		active: ActiveAuthorization,
	): () => void {
		let stopped = false;
		let renewalInFlight = false;
		const cancel = this.startLeaseHeartbeat(
			() =>
				this.trackInFlight(async () => {
					if (stopped || this.disposed || active.leaseLost || renewalInFlight) {
						return;
					}
					renewalInFlight = true;
					try {
						await this.renewAuthorizationLease(jobId, active);
					} finally {
						renewalInFlight = false;
					}
				}),
			Math.max(1, Math.floor(this.leaseMs / 3)),
		);
		return () => {
			if (stopped) return;
			stopped = true;
			cancel();
		};
	}

	private async renewAuthorizationLease(
		jobId: string,
		active: ActiveAuthorization,
	): Promise<boolean> {
		if (this.disposed || active.leaseLost) return false;
		const now = this.now();
		try {
			const renewed = await this.repository.renewLease(
				jobId,
				active.leaseToken,
				now,
				now + this.leaseMs,
			);
			if (!renewed) active.leaseLost = true;
			return renewed;
		} catch {
			active.leaseLost = true;
			return false;
		}
	}

	private async completeAuthorization(
		jobId: string,
		active: ActiveAuthorization,
	): Promise<void> {
		try {
			const credential = await pollUntilDisposed(
				Promise.resolve().then(() =>
					this.providers[active.provider].poll(active.continuation),
				),
				active.abortController.signal,
			);
			if (
				this.disposed ||
				active.leaseLost ||
				!(await this.renewAuthorizationLease(jobId, active))
			) {
				return;
			}
			const job = await this.repository.findById(jobId);
			if (
				this.disposed ||
				active.leaseLost ||
				!job ||
				job.leaseToken !== active.leaseToken
			) {
				return;
			}
			active.commitStarted = true;
			let committed = false;
			try {
				await this.commitAuthorizedAccount({
					provider: active.provider,
					accountId: job.accountId,
					name: active.command.name,
					priority: active.command.priority,
					credential,
				});
				committed = await this.accountExists(job.accountId);
			} catch {
				// An insert may have committed before a transport/adapter error. The
				// preallocated identity makes this exact existence check authoritative.
				committed = await this.accountExists(job.accountId);
			}
			if (!committed) {
				await this.repository.markAuthorizationError(
					jobId,
					active.leaseToken,
					"authorization_failed",
					this.now(),
					this.retentionDeadline(),
				);
				return;
			}
			if (
				!(await this.repository.markAccountCommitted(
					jobId,
					active.leaseToken,
					this.now(),
				))
			) {
				return;
			}
			await this.reconcile(jobId, active.leaseToken);
		} catch (error) {
			if (!this.disposed && !active.leaseLost) {
				await this.finishAuthorizationError(
					jobId,
					authorizationErrorCode(error),
					active.leaseToken,
				);
			}
		} finally {
			active.stopHeartbeat();
			this.active.delete(jobId);
		}
	}

	private async finishAuthorizationError(
		jobId: string,
		errorCode: Exclude<DeviceSetupSafeErrorCode, "authorization_expired">,
		ownedLeaseToken?: string,
	): Promise<void> {
		const claimed = ownedLeaseToken
			? { leaseToken: ownedLeaseToken }
			: await this.claim(jobId);
		if (!claimed) return;
		await this.repository.markAuthorizationError(
			jobId,
			claimed.leaseToken,
			errorCode,
			this.now(),
			this.retentionDeadline(),
		);
	}

	private async performTick(): Promise<void> {
		if (this.disposed) return;
		const now = this.now();
		await this.repository.deleteTerminalBefore(now);
		const jobs = await this.repository.listClaimable(now, this.claimBatch);
		for (const candidate of jobs) {
			if (
				this.active.has(candidate.id) ||
				this.initializing.has(candidate.id)
			) {
				continue;
			}
			const claimed = await this.claim(candidate.id);
			if (!claimed) continue;
			let job = claimed.job;
			if (job.status === "awaiting_authorization") {
				if (!(await this.accountExists(job.accountId))) {
					await this.repository.markAuthorizationError(
						job.id,
						claimed.leaseToken,
						"authorization_interrupted",
						this.now(),
						this.retentionDeadline(),
					);
					continue;
				}
				if (
					!(await this.repository.markAccountCommitted(
						job.id,
						claimed.leaseToken,
						this.now(),
					))
				) {
					continue;
				}
				job = (await this.repository.findById(job.id)) ?? job;
			}
			if (job.status === "account_committed" || job.status === "reconciling") {
				await this.reconcile(job.id, claimed.leaseToken);
			}
		}
	}

	private async claim(
		jobId: string,
	): Promise<{ job: PersistedDeviceSetupJob; leaseToken: string } | null> {
		const now = this.now();
		const leaseToken = this.randomId();
		if (
			!(await this.repository.tryClaim(
				jobId,
				leaseToken,
				now,
				now + this.leaseMs,
			))
		) {
			return null;
		}
		const job = await this.repository.findById(jobId);
		return job ? { job, leaseToken } : null;
	}

	private async reconcile(jobId: string, leaseToken: string): Promise<void> {
		let job = await this.repository.findById(jobId);
		if (!job) return;
		if (job.status === "account_committed") {
			if (
				!(await this.repository.beginReconciliation(
					jobId,
					leaseToken,
					this.now(),
				))
			) {
				return;
			}
			job = await this.repository.findById(jobId);
			if (!job) return;
		}
		if (job.status !== "reconciling") return;

		while (job.routingCursor < job.routingSelections.length) {
			const selection = job.routingSelections[job.routingCursor];
			if (!selection) return;
			const leaseNow = this.now();
			if (
				!(await this.repository.renewLease(
					jobId,
					leaseToken,
					leaseNow,
					leaseNow + this.leaseMs,
				))
			) {
				return;
			}
			let outcome: DeviceSetupRoutingOutcome;
			try {
				const result = await this.finalizeRouting({
					accountId: job.accountId,
					reviewed: [selection],
				});
				outcome = normalizeOutcome(selection, job.accountId, result);
			} catch {
				outcome = {
					...selection,
					status: "action-required",
					reason: "apply-failed",
				};
			}
			if (
				!(await this.repository.advanceRoutingOutcome(
					jobId,
					leaseToken,
					job.routingCursor,
					outcome,
					this.now(),
				))
			) {
				return;
			}
			job = await this.repository.findById(jobId);
			if (!job || job.status !== "reconciling") return;
		}

		if (job.routingCursor !== job.routingSelections.length) return;
		const status = job.routingOutcomes.every(
			(outcome) => outcome.status === "joined",
		)
			? "complete"
			: "complete_with_actions";
		await this.repository.finish(
			jobId,
			leaseToken,
			job.routingCursor,
			status,
			this.now(),
			this.retentionDeadline(),
		);
	}

	private retentionDeadline(): number {
		return this.now() + this.retentionMs;
	}
}

export function createDeviceSetupCoordinator(
	dependencies: DeviceSetupCoordinatorDependencies,
): DeviceSetupCoordinator {
	return new DurableDeviceSetupCoordinator(dependencies);
}

export function isTerminalDeviceSetupJob(
	status: DeviceSetupJobStatus,
): boolean {
	return TERMINAL_JOB_STATUSES.has(status);
}
