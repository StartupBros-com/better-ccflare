import { describe, expect, it, mock } from "bun:test";
import type {
	DeviceSetupJobStatus,
	DeviceSetupProvider,
	DeviceSetupRoutingOutcome,
	DeviceSetupRoutingSelection,
} from "@better-ccflare/types";
import {
	createDeviceSetupCoordinator,
	DeviceSetupIdempotencyConflictError,
	type DeviceSetupJobRepository,
	DeviceSetupValidationError,
	fingerprintDeviceSetupCommand,
	type PersistedDeviceSetupJob,
	validateDeviceSetupCommand,
} from "./device-setup-jobs";

const NOW = 1_000_000;

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function persistedJob(
	overrides: Partial<PersistedDeviceSetupJob> = {},
): PersistedDeviceSetupJob {
	return {
		id: "job-1",
		idempotencyKey: "idempotency-key-1",
		requestFingerprint: "sha256:fingerprint",
		provider: "qwen",
		accountId: "account-preallocated-1",
		status: "awaiting_authorization",
		routingSelections: [{ family: "opus", proposalId: "proposal-opus" }],
		routingOutcomes: [],
		routingCursor: 0,
		leaseToken: null,
		leaseExpiresAt: null,
		attemptCount: 0,
		errorCode: null,
		errorMessage: null,
		createdAt: NOW,
		updatedAt: NOW,
		terminalAt: null,
		retentionExpiresAt: null,
		...overrides,
	};
}

class FakeRepository implements DeviceSetupJobRepository {
	readonly jobs = new Map<string, PersistedDeviceSetupJob>();
	readonly byIdempotencyKey = new Map<string, string>();
	createCount = 0;
	tryClaimCount = 0;
	listGate: Promise<void> | null = null;

	async createOrGet(input: {
		idempotencyKey: string;
		requestFingerprint: string;
		provider: DeviceSetupProvider;
		routingSelections: readonly DeviceSetupRoutingSelection[];
		now: number;
		initialLeaseToken?: string;
		initialLeaseExpiresAt?: number;
	}) {
		const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
		if (existingId) {
			const existing = this.jobs.get(existingId);
			if (!existing) throw new Error("missing fake job");
			return { job: structuredClone(existing), created: false };
		}
		this.createCount += 1;
		const job = persistedJob({
			id: `job-${this.createCount}`,
			accountId: `preallocated-account-${this.createCount}`,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint: input.requestFingerprint,
			provider: input.provider,
			routingSelections: [...input.routingSelections],
			leaseToken: input.initialLeaseToken ?? null,
			leaseExpiresAt: input.initialLeaseExpiresAt ?? null,
			attemptCount: input.initialLeaseToken ? 1 : 0,
			createdAt: input.now,
			updatedAt: input.now,
		});
		this.jobs.set(job.id, job);
		this.byIdempotencyKey.set(job.idempotencyKey, job.id);
		return { job: structuredClone(job), created: true };
	}

	async findById(id: string) {
		const job = this.jobs.get(id);
		return job ? structuredClone(job) : null;
	}

	async listRecent(limit: number) {
		return [...this.jobs.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit)
			.map((job) => structuredClone(job));
	}

	async listClaimable(now: number, limit: number) {
		if (this.listGate) await this.listGate;
		return [...this.jobs.values()]
			.filter(
				(job) =>
					[
						"awaiting_authorization",
						"account_committed",
						"reconciling",
					].includes(job.status) &&
					(job.leaseExpiresAt === null || job.leaseExpiresAt <= now),
			)
			.slice(0, limit)
			.map((job) => structuredClone(job));
	}

	async tryClaim(
		id: string,
		leaseToken: string,
		now: number,
		leaseExpiresAt: number,
	) {
		this.tryClaimCount += 1;
		const job = this.jobs.get(id);
		if (
			!job ||
			!["awaiting_authorization", "account_committed", "reconciling"].includes(
				job.status,
			) ||
			(job.leaseExpiresAt !== null && job.leaseExpiresAt > now)
		) {
			return false;
		}
		job.leaseToken = leaseToken;
		job.leaseExpiresAt = leaseExpiresAt;
		job.attemptCount += 1;
		job.updatedAt = now;
		return true;
	}

	async renewLease(
		id: string,
		leaseToken: string,
		now: number,
		leaseExpiresAt: number,
	) {
		const job = this.jobs.get(id);
		if (
			!job ||
			job.leaseToken !== leaseToken ||
			job.leaseExpiresAt === null ||
			job.leaseExpiresAt <= now
		) {
			return false;
		}
		job.leaseExpiresAt = leaseExpiresAt;
		job.updatedAt = now;
		return true;
	}

	async markAccountCommitted(id: string, leaseToken: string, now: number) {
		const job = this.claimed(id, leaseToken, now);
		if (!job || job.status !== "awaiting_authorization") return false;
		job.status = "account_committed";
		job.updatedAt = now;
		return true;
	}

	async beginReconciliation(id: string, leaseToken: string, now: number) {
		const job = this.claimed(id, leaseToken, now);
		if (!job || job.status !== "account_committed") return false;
		job.status = "reconciling";
		job.updatedAt = now;
		return true;
	}

	async advanceRoutingOutcome(
		id: string,
		leaseToken: string,
		expectedCursor: number,
		outcome: DeviceSetupRoutingOutcome,
		now: number,
	) {
		const job = this.claimed(id, leaseToken, now);
		if (
			!job ||
			job.status !== "reconciling" ||
			job.routingCursor !== expectedCursor
		) {
			return false;
		}
		job.routingOutcomes.push(structuredClone(outcome));
		job.routingCursor += 1;
		job.updatedAt = now;
		return true;
	}

	async finish(
		id: string,
		leaseToken: string,
		expectedCursor: number,
		status: "complete" | "complete_with_actions",
		now: number,
		retentionExpiresAt: number,
	) {
		const job = this.claimed(id, leaseToken, now);
		if (
			!job ||
			job.status !== "reconciling" ||
			job.routingCursor !== expectedCursor ||
			job.routingSelections.length !== expectedCursor
		) {
			return false;
		}
		job.status = status;
		job.updatedAt = now;
		job.terminalAt = now;
		job.retentionExpiresAt = retentionExpiresAt;
		job.leaseToken = null;
		job.leaseExpiresAt = null;
		return true;
	}

	async markAuthorizationError(
		id: string,
		leaseToken: string,
		errorCode:
			| "authorization_denied"
			| "authorization_failed"
			| "authorization_interrupted",
		now: number,
		retentionExpiresAt: number,
	) {
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
	) {
		return this.finishAuthorization(
			id,
			leaseToken,
			"expired",
			"authorization_expired",
			now,
			retentionExpiresAt,
		);
	}

	async deleteTerminalBefore(now: number) {
		let deleted = 0;
		for (const [id, job] of this.jobs) {
			if (
				job.terminalAt !== null &&
				job.retentionExpiresAt !== null &&
				job.retentionExpiresAt <= now
			) {
				this.jobs.delete(id);
				deleted += 1;
			}
		}
		return deleted;
	}

	private claimed(id: string, leaseToken: string, now: number) {
		const job = this.jobs.get(id);
		return job?.leaseToken === leaseToken &&
			job.leaseExpiresAt !== null &&
			job.leaseExpiresAt > now
			? job
			: null;
	}

	private async finishAuthorization(
		id: string,
		leaseToken: string,
		status: "authorization_error" | "expired",
		errorCode:
			| "authorization_denied"
			| "authorization_failed"
			| "authorization_interrupted"
			| "authorization_expired",
		now: number,
		retentionExpiresAt: number,
	) {
		const job = this.claimed(id, leaseToken, now);
		if (!job || job.status !== "awaiting_authorization") return false;
		job.status = status;
		job.errorCode = errorCode;
		job.errorMessage = `unsafe repository message for ${errorCode}`;
		job.updatedAt = now;
		job.terminalAt = now;
		job.retentionExpiresAt = retentionExpiresAt;
		job.leaseToken = null;
		job.leaseExpiresAt = null;
		return true;
	}
}

function command(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		name: "codex-primary",
		priority: 0,
		idempotencyKey: "idempotency-key-1",
		reviewed: [
			{ family: "fable", proposalId: "proposal-fable" },
			{ family: "opus", proposalId: "proposal-opus" },
		],
		...overrides,
	};
}

function createHarness(
	options: {
		repository?: FakeRepository;
		accounts?: Set<string>;
		finalize?: ReturnType<typeof mock>;
		pollCredential?: unknown;
		pollQwen?: ReturnType<typeof mock>;
		commitAuthorizedAccount?: ReturnType<typeof mock>;
		now?: () => number;
		leaseMs?: number;
		randomIdPrefix?: string;
		startLeaseHeartbeat?: (
			task: () => Promise<void>,
			intervalMs: number,
		) => () => void;
	} = {},
) {
	const repository = options.repository ?? new FakeRepository();
	const accounts = options.accounts ?? new Set<string>();
	const scheduled: Array<() => Promise<void>> = [];
	const initiateQwen = mock(async () => ({
		verificationUrl: "https://provider.invalid/authorize?secret=1",
		userCode: "USER-CODE-SECRET",
		continuation: { deviceCode: "DEVICE-CODE-SECRET" },
	}));
	const pollQwen =
		options.pollQwen ??
		mock(
			async () =>
				options.pollCredential ?? {
					accessToken: "ACCESS-TOKEN-SECRET",
					refreshToken: "REFRESH-TOKEN-SECRET",
				},
		);
	const initiateCodex = mock(async () => ({
		verificationUrl: "https://provider.invalid/codex",
		userCode: "CODEX-CODE-SECRET",
		continuation: { deviceAuthId: "DEVICE-AUTH-SECRET" },
	}));
	const pollCodex = mock(async () => ({ accessToken: "CODEX-TOKEN-SECRET" }));
	const commitAuthorizedAccount =
		options.commitAuthorizedAccount ??
		mock(async ({ accountId }: { accountId: string }) => {
			accounts.add(accountId);
		});
	const finalize =
		options.finalize ??
		mock(
			async ({
				accountId,
				reviewed,
			}: {
				accountId: string;
				reviewed: readonly DeviceSetupRoutingSelection[];
			}) => ({
				accountId,
				outcomes: reviewed.map((selection) => ({
					...selection,
					status: "joined" as const,
					reason: "applied" as const,
				})),
			}),
		);
	let uuid = 0;
	const coordinator = createDeviceSetupCoordinator({
		repository,
		providers: {
			qwen: { initiate: initiateQwen, poll: pollQwen },
			codex: { initiate: initiateCodex, poll: pollCodex },
		},
		commitAuthorizedAccount,
		accountExists: async (accountId) => accounts.has(accountId),
		finalizeRouting: finalize,
		now: options.now ?? (() => NOW),
		randomId: () => `${options.randomIdPrefix ?? "lease"}-${++uuid}`,
		runInBackground: (task) => scheduled.push(task),
		leaseMs: options.leaseMs,
		startLeaseHeartbeat: options.startLeaseHeartbeat,
	});
	return {
		coordinator,
		repository,
		accounts,
		scheduled,
		initiateQwen,
		pollQwen,
		initiateCodex,
		pollCodex,
		commitAuthorizedAccount,
		finalize,
	};
}

describe("device setup command contract", () => {
	it("strictly whitelists command and reviewed-selection fields", () => {
		expect(validateDeviceSetupCommand(command()).reviewed).toEqual([
			{ family: "fable", proposalId: "proposal-fable" },
			{ family: "opus", proposalId: "proposal-opus" },
		]);
		for (const invalid of [
			command({ apiKey: "must-not-enter-service" }),
			command({ reviewed: [{ family: "opus", proposalId: "p", token: "x" }] }),
			command({ reviewed: [{ family: "unknown", proposalId: "p" }] }),
			command({
				reviewed: [
					{ family: "opus", proposalId: "a" },
					{ family: "opus", proposalId: "b" },
				],
			}),
		]) {
			expect(() => validateDeviceSetupCommand(invalid)).toThrow(
				DeviceSetupValidationError,
			);
		}
	});

	it("creates an order-normalized fingerprint without serializing secrets", () => {
		const first = validateDeviceSetupCommand(command());
		const reordered = validateDeviceSetupCommand(
			command({ reviewed: [...first.reviewed].reverse() }),
		);
		expect(fingerprintDeviceSetupCommand("codex", first)).toBe(
			fingerprintDeviceSetupCommand("codex", reordered),
		);
		expect(fingerprintDeviceSetupCommand("qwen", first)).not.toBe(
			fingerprintDeviceSetupCommand("codex", first),
		);
		expect(fingerprintDeviceSetupCommand("codex", first)).not.toContain(
			"codex-primary",
		);
	});
});

describe("durable device setup coordinator", () => {
	it("fences a second coordinator throughout polling and recovers only after heartbeat disposal and lease expiry", async () => {
		const repository = new FakeRepository();
		let now = NOW;
		let releasePoll: ((credential: unknown) => void) | undefined;
		const pendingCredential = new Promise<unknown>((resolve) => {
			releasePoll = resolve;
		});
		const pollQwen = mock(async () => pendingCredential);
		const heartbeatTasks = new Set<() => Promise<void>>();
		const startLeaseHeartbeat = mock(
			(task: () => Promise<void>, _intervalMs: number) => {
				heartbeatTasks.add(task);
				return () => heartbeatTasks.delete(task);
			},
		);
		const first = createHarness({
			repository,
			pollQwen,
			now: () => now,
			leaseMs: 100,
			randomIdPrefix: "owner-a",
			startLeaseHeartbeat,
		});
		const second = createHarness({
			repository,
			now: () => now,
			leaseMs: 100,
			randomIdPrefix: "owner-b",
		});

		const started = await first.coordinator.initQwen(command());
		expect(repository.jobs.get(started.job.id)).toMatchObject({
			leaseToken: "owner-a-1",
			leaseExpiresAt: NOW + 100,
			attemptCount: 1,
		});
		expect(heartbeatTasks.size).toBe(1);
		const polling = first.scheduled[0]?.();

		const replay = await second.coordinator.initQwen(command());
		expect(replay.replayed).toBe(true);
		expect(replay.authorization).toBeNull();
		expect(second.initiateQwen).not.toHaveBeenCalled();
		await second.coordinator.tick();
		expect(repository.jobs.get(started.job.id)?.status).toBe(
			"awaiting_authorization",
		);

		now += 75;
		await Promise.all([...heartbeatTasks].map((task) => task()));
		expect(repository.jobs.get(started.job.id)?.leaseExpiresAt).toBe(now + 100);
		now += 50;
		await second.coordinator.tick();
		expect(repository.jobs.get(started.job.id)?.status).toBe(
			"awaiting_authorization",
		);

		first.coordinator.dispose();
		expect(heartbeatTasks.size).toBe(0);
		now += 101;
		await second.coordinator.tick();
		expect(repository.jobs.get(started.job.id)).toMatchObject({
			status: "authorization_error",
			errorCode: "authorization_interrupted",
		});

		releasePoll?.({ accessToken: "late-token" });
		await polling;
		expect(first.commitAuthorizedAccount).not.toHaveBeenCalled();
	});

	it("replays one idempotent initialization without initiating twice", async () => {
		const harness = createHarness();
		const first = await harness.coordinator.initQwen(command());
		const replay = await harness.coordinator.initQwen(command());

		expect(first.job.id).toBe(replay.job.id);
		expect(first.replayed).toBe(false);
		expect(replay.replayed).toBe(true);
		expect(replay.authorization).toEqual(first.authorization);
		expect(harness.initiateQwen).toHaveBeenCalledTimes(1);
		expect(harness.scheduled).toHaveLength(1);
	});

	it("rejects one idempotency key reused for a different payload", async () => {
		const harness = createHarness();
		await harness.coordinator.initCodex(command());

		await expect(
			harness.coordinator.initCodex(command({ priority: 25 })),
		).rejects.toBeInstanceOf(DeviceSetupIdempotencyConflictError);
		expect(harness.initiateCodex).toHaveBeenCalledTimes(1);
	});

	it("commits the preallocated exact account ID and finalizes without a status poll", async () => {
		const harness = createHarness();
		const started = await harness.coordinator.initQwen(command());
		expect(started.job.accountId).toBeNull();

		await harness.scheduled[0]?.();

		expect(harness.commitAuthorizedAccount).toHaveBeenCalledTimes(1);
		expect(harness.commitAuthorizedAccount.mock.calls[0]?.[0]).toMatchObject({
			provider: "qwen",
			accountId: "preallocated-account-1",
			name: "codex-primary",
			priority: 0,
		});
		expect(harness.finalize).toHaveBeenCalledTimes(2);
		expect(
			harness.finalize.mock.calls.map(([params]) => params.reviewed),
		).toEqual([
			[{ family: "fable", proposalId: "proposal-fable" }],
			[{ family: "opus", proposalId: "proposal-opus" }],
		]);
		const job = harness.repository.jobs.get("job-1");
		expect(job?.status).toBe("complete");
		expect(job?.accountId).toBe("preallocated-account-1");
		const persisted = JSON.stringify(job);
		for (const secret of [
			"DEVICE-CODE-SECRET",
			"ACCESS-TOKEN-SECRET",
			"REFRESH-TOKEN-SECRET",
			"USER-CODE-SECRET",
			"provider.invalid",
		]) {
			expect(persisted).not.toContain(secret);
		}
	});

	it("startup recovery expires pre-token work and promotes an exact committed account", async () => {
		const repository = new FakeRepository();
		const missing = persistedJob({
			id: "missing",
			accountId: "account-missing",
		});
		const committed = persistedJob({
			id: "committed",
			accountId: "account-exists",
			routingSelections: [],
		});
		repository.jobs.set(missing.id, missing);
		repository.jobs.set(committed.id, committed);
		const harness = createHarness({
			repository,
			accounts: new Set([committed.accountId]),
		});

		await harness.coordinator.tick();

		expect(repository.jobs.get("missing")).toMatchObject({
			status: "authorization_error",
			errorCode: "authorization_interrupted",
		});
		expect(repository.jobs.get("committed")?.status).toBe("complete");
		expect(harness.finalize).not.toHaveBeenCalled();
	});

	it("resumes from the durable cursor and derives the terminal outcome", async () => {
		const repository = new FakeRepository();
		const job = persistedJob({
			status: "reconciling",
			accountId: "account-exists",
			routingSelections: [
				{ family: "fable", proposalId: "proposal-fable" },
				{ family: "opus", proposalId: "proposal-opus" },
			],
			routingOutcomes: [
				{
					family: "fable",
					proposalId: "proposal-fable",
					status: "action-required",
					reason: "stale-preview",
				},
			],
			routingCursor: 1,
		});
		repository.jobs.set(job.id, job);
		const harness = createHarness({
			repository,
			accounts: new Set([job.accountId]),
		});

		await harness.coordinator.tick();

		expect(harness.finalize).toHaveBeenCalledTimes(1);
		expect(harness.finalize.mock.calls[0]?.[0].reviewed).toEqual([
			{ family: "opus", proposalId: "proposal-opus" },
		]);
		expect(repository.jobs.get(job.id)?.status).toBe("complete_with_actions");
	});

	it("coalesces concurrent worker ticks into one lease pass", async () => {
		const repository = new FakeRepository();
		repository.jobs.set(
			"job-1",
			persistedJob({ routingSelections: [], accountId: "missing" }),
		);
		let releaseList: (() => void) | undefined;
		repository.listGate = new Promise((resolve) => {
			releaseList = resolve;
		});
		const harness = createHarness({ repository });

		const first = harness.coordinator.tick();
		const second = harness.coordinator.tick();
		releaseList?.();
		await Promise.all([first, second]);

		expect(repository.tryClaimCount).toBe(1);
	});

	it("drains an in-flight recovery tick before resources close and fences later ticks", async () => {
		const repository = new FakeRepository();
		repository.jobs.set(
			"job-1",
			persistedJob({ routingSelections: [], accountId: "missing" }),
		);
		const listGate = deferred();
		repository.listGate = listGate.promise;
		const harness = createHarness({ repository });
		const runningTick = harness.coordinator.tick();
		await Promise.resolve();

		harness.coordinator.dispose();
		let resourcesClosed = false;
		const closeResources = harness.coordinator.drain().then(() => {
			resourcesClosed = true;
		});
		await Promise.resolve();
		expect(resourcesClosed).toBe(false);

		listGate.resolve();
		await runningTick;
		await closeResources;
		expect(resourcesClosed).toBe(true);
		const claimCountAfterDrain = repository.tryClaimCount;

		await harness.coordinator.tick();
		expect(repository.tryClaimCount).toBe(claimCountAfterDrain);
	});

	it("aborts pre-commit authorization during drain and fences a late provider result", async () => {
		const providerResult = deferred<unknown>();
		const pollQwen = mock(async () => providerResult.promise);
		const harness = createHarness({ pollQwen });
		await harness.coordinator.initQwen(command());
		const authorizationTask = harness.scheduled[0]?.();
		await Promise.resolve();

		harness.coordinator.dispose();
		await harness.coordinator.drain();
		expect(harness.commitAuthorizedAccount).not.toHaveBeenCalled();

		providerResult.resolve({ accessToken: "late-token" });
		await authorizationTask;
		await Promise.resolve();
		expect(harness.commitAuthorizedAccount).not.toHaveBeenCalled();
	});

	it("drains post-commit exact-ID reconciliation instead of cancelling it", async () => {
		const accounts = new Set<string>();
		const finalizationStarted = deferred();
		const finishFinalization = deferred();
		const commitAuthorizedAccount = mock(
			async ({ accountId }: { accountId: string }) => {
				accounts.add(accountId);
			},
		);
		const finalize = mock(
			async ({
				accountId,
				reviewed,
			}: {
				accountId: string;
				reviewed: readonly DeviceSetupRoutingSelection[];
			}) => {
				finalizationStarted.resolve();
				await finishFinalization.promise;
				return {
					accountId,
					outcomes: reviewed.map((selection) => ({
						...selection,
						status: "joined" as const,
						reason: "applied" as const,
					})),
				};
			},
		);
		const harness = createHarness({
			accounts,
			commitAuthorizedAccount,
			finalize,
		});
		await harness.coordinator.initQwen(command());
		const authorizationTask = harness.scheduled[0]?.();
		await finalizationStarted.promise;

		harness.coordinator.dispose();
		let resourcesClosed = false;
		const closeResources = harness.coordinator.drain().then(() => {
			resourcesClosed = true;
		});
		await Promise.resolve();
		expect(resourcesClosed).toBe(false);

		finishFinalization.resolve();
		await authorizationTask;
		await closeResources;
		expect(resourcesClosed).toBe(true);
		expect(harness.repository.jobs.get("job-1")?.status).toBe("complete");
	});

	it("projects safe recent and individual job DTOs", async () => {
		const repository = new FakeRepository();
		const awaiting = persistedJob({
			id: "awaiting-job",
			status: "awaiting_authorization",
			accountId: "preallocated-account-must-not-leak",
			updatedAt: NOW + 1,
		});
		const complete = persistedJob({
			status: "complete_with_actions",
			accountId: "opaque-account-id",
			requestFingerprint: "sha256:must-not-leak",
			idempotencyKey: "must-not-leak-idempotency",
			leaseToken: "must-not-leak-lease",
			routingOutcomes: [
				{
					family: "opus",
					proposalId: "proposal-opus",
					status: "action-required",
					reason: "default-downgraded",
				},
			],
			routingCursor: 1,
			terminalAt: NOW,
		});
		repository.jobs.set(awaiting.id, awaiting);
		repository.jobs.set(complete.id, complete);
		const harness = createHarness({ repository });

		const [one, recent] = await Promise.all([
			harness.coordinator.get(complete.id),
			harness.coordinator.listRecent(),
		]);
		expect(one).toEqual(recent[1]);
		expect(recent[0]).toMatchObject({
			id: "awaiting-job",
			accountId: null,
			status: "awaiting_authorization",
		});
		expect(one).toMatchObject({
			id: complete.id,
			accountId: "opaque-account-id",
			status: "complete_with_actions",
		});
		const serialized = JSON.stringify(recent);
		for (const forbidden of [
			"requestFingerprint",
			"idempotencyKey",
			"leaseToken",
			"routingSelections",
			"routingCursor",
			"attemptCount",
			"retentionExpiresAt",
			"preallocated-account-must-not-leak",
			"must-not-leak",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	it("publishes only allowlisted authorization errors", async () => {
		const repository = new FakeRepository();
		const failed = persistedJob({
			status: "authorization_error",
			errorCode: "authorization_failed",
			errorMessage: "raw provider response must not leak",
			terminalAt: NOW,
		});
		repository.jobs.set(failed.id, failed);
		const harness = createHarness({ repository });

		expect(await harness.coordinator.get(failed.id)).toMatchObject({
			accountId: null,
			errorCode: "authorization_failed",
			errorMessage: "Authorization failed",
		});
	});
});

// Keep the fixture exhaustive when the shared status union changes.
const _statusCoverage = [
	"awaiting_authorization",
	"account_committed",
	"reconciling",
	"complete",
	"complete_with_actions",
	"authorization_error",
	"expired",
] satisfies DeviceSetupJobStatus[];
