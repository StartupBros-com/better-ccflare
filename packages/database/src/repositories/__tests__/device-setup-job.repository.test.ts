import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import {
	DeviceSetupIdempotencyConflictError,
	DeviceSetupJobRepository,
	type DeviceSetupRoutingOutcome,
	type DeviceSetupRoutingSelection,
} from "../device-setup-job.repository";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("DeviceSetupJobRepository", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let repository: DeviceSetupJobRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		adapter = new BunSqlAdapter(db);
		repository = new DeviceSetupJobRepository(adapter);
	});

	afterEach(() => {
		db.close();
	});

	async function createJob(
		overrides: Partial<
			Parameters<DeviceSetupJobRepository["createOrGet"]>[0]
		> = {},
	) {
		return repository.createOrGet({
			idempotencyKey: "setup-idempotency-key",
			requestFingerprint: "sha256:request-one",
			provider: "qwen",
			routingSelections: [{ family: "sonnet", proposalId: "proposal-sonnet" }],
			now: 1_000,
			...overrides,
		});
	}

	function insertAccount(accountId: string, name = "committed-account") {
		db.prepare(
			`INSERT INTO accounts (id, name, provider, created_at)
			 VALUES (?, ?, 'qwen', ?)`,
		).run(accountId, name, 1_100);
	}

	it("creates unguessable identifiers and returns the existing job for an idempotent retry", async () => {
		const first = await createJob();
		const retry = await createJob({ now: 1_100 });

		expect(first.created).toBe(true);
		expect(first.job.id).toMatch(UUID_PATTERN);
		expect(first.job.accountId).toMatch(UUID_PATTERN);
		expect(first.job.id).not.toBe(first.job.accountId);
		expect(first.job.status).toBe("awaiting_authorization");
		expect(retry.created).toBe(false);
		expect(retry.job.id).toBe(first.job.id);
		expect(retry.job.accountId).toBe(first.job.accountId);
		expect(retry.job.createdAt).toBe(1_000);
	});

	it("atomically leases only the inserted authorization job and preserves it on replay", async () => {
		const first = await createJob({
			initialLeaseToken: "authorization-owner-a",
			initialLeaseExpiresAt: 2_000,
		});
		const replay = await createJob({
			now: 1_100,
			initialLeaseToken: "authorization-owner-b",
			initialLeaseExpiresAt: 2_100,
		});

		expect(first.created).toBe(true);
		expect(first.job).toMatchObject({
			leaseToken: "authorization-owner-a",
			leaseExpiresAt: 2_000,
			attemptCount: 1,
		});
		expect(replay.created).toBe(false);
		expect(replay.job).toMatchObject({
			id: first.job.id,
			leaseToken: "authorization-owner-a",
			leaseExpiresAt: 2_000,
			attemptCount: 1,
		});
		expect(
			await repository.tryClaim(first.job.id, "worker", 1_500, 2_500),
		).toBe(false);
	});

	it("rejects an idempotency key reused for a different request fingerprint", async () => {
		await createJob();

		await expect(
			createJob({ requestFingerprint: "sha256:different-request" }),
		).rejects.toBeInstanceOf(DeviceSetupIdempotencyConflictError);
	});

	it("allows only one worker lease and fences the stale worker after expiry", async () => {
		const { job } = await createJob();

		expect(await repository.tryClaim(job.id, "worker-a", 1_100, 2_100)).toBe(
			true,
		);
		expect(await repository.tryClaim(job.id, "worker-b", 1_100, 2_100)).toBe(
			false,
		);
		expect(await repository.renewLease(job.id, "worker-b", 1_200, 2_200)).toBe(
			false,
		);
		expect(await repository.renewLease(job.id, "worker-a", 1_200, 2_200)).toBe(
			true,
		);

		expect(await repository.tryClaim(job.id, "worker-b", 2_201, 3_201)).toBe(
			true,
		);
		expect(
			await repository.markAuthorizationError(
				job.id,
				"worker-a",
				"authorization_interrupted",
				2_202,
				12_202,
			),
		).toBe(false);

		const claimed = await repository.findById(job.id);
		expect(claimed?.leaseToken).toBe("worker-b");
		expect(claimed?.attemptCount).toBe(2);
	});

	it("does not move lease timestamps backward when an older renewal finishes last", async () => {
		const { job } = await createJob();

		expect(await repository.tryClaim(job.id, "worker-a", 1_100, 2_100)).toBe(
			true,
		);
		expect(await repository.renewLease(job.id, "worker-a", 1_300, 2_300)).toBe(
			true,
		);
		expect(await repository.renewLease(job.id, "worker-a", 1_200, 2_200)).toBe(
			true,
		);

		expect(await repository.findById(job.id)).toMatchObject({
			leaseToken: "worker-a",
			leaseExpiresAt: 2_300,
			updatedAt: 1_300,
		});
	});

	it("recovers an account commit only from the exact preallocated account id", async () => {
		const { job } = await createJob();
		await repository.tryClaim(job.id, "worker", 1_100, 2_100);
		insertAccount("00000000-0000-4000-8000-000000000000", "other-account");

		expect(await repository.markAccountCommitted(job.id, "worker", 1_200)).toBe(
			false,
		);

		insertAccount(job.accountId);
		expect(await repository.markAccountCommitted(job.id, "worker", 1_300)).toBe(
			true,
		);
		expect((await repository.findById(job.id))?.status).toBe(
			"account_committed",
		);
	});

	it("advances routing outcomes with lease and cursor compare-and-swap fencing", async () => {
		const { job } = await createJob();
		await repository.tryClaim(job.id, "worker", 1_100, 5_000);
		insertAccount(job.accountId);
		await repository.markAccountCommitted(job.id, "worker", 1_200);
		expect(await repository.beginReconciliation(job.id, "worker", 1_300)).toBe(
			true,
		);

		const outcome: DeviceSetupRoutingOutcome = {
			family: "sonnet",
			proposalId: "proposal-sonnet",
			status: "joined",
			reason: "default-downgraded",
		};
		expect(
			await repository.advanceRoutingOutcome(
				job.id,
				"worker",
				0,
				outcome,
				1_400,
			),
		).toBe(true);
		expect(
			await repository.advanceRoutingOutcome(
				job.id,
				"worker",
				0,
				outcome,
				1_401,
			),
		).toBe(false);
		expect(
			await repository.advanceRoutingOutcome(
				job.id,
				"stale-worker",
				1,
				outcome,
				1_402,
			),
		).toBe(false);

		const advanced = await repository.findById(job.id);
		expect(advanced?.routingCursor).toBe(1);
		expect(advanced?.routingOutcomes).toEqual([outcome]);
	});

	it("retains terminal jobs until their explicit retention deadline", async () => {
		const { job } = await createJob({ routingSelections: [] });
		await repository.tryClaim(job.id, "worker", 1_100, 5_000);
		insertAccount(job.accountId);
		await repository.markAccountCommitted(job.id, "worker", 1_200);
		await repository.beginReconciliation(job.id, "worker", 1_300);
		expect(
			await repository.finish(job.id, "worker", 0, "complete", 1_400, 10_000),
		).toBe(true);

		expect(await repository.deleteTerminalBefore(9_999)).toBe(0);
		expect(await repository.findById(job.id)).not.toBeNull();
		expect(await repository.deleteTerminalBefore(10_000)).toBe(1);
		expect(await repository.findById(job.id)).toBeNull();
	});

	it("lists active and retained terminal jobs through a UI-safe projection", async () => {
		const { job: active } = await createJob({
			idempotencyKey: "active-job",
			routingSelections: [],
			now: 1_000,
		});
		const { job: recentTerminal } = await createJob({
			idempotencyKey: "recent-terminal-job",
			routingSelections: [],
			now: 2_000,
		});
		await repository.tryClaim(recentTerminal.id, "recent-worker", 2_100, 9_000);
		insertAccount(recentTerminal.accountId, "recent-account");
		await repository.markAccountCommitted(
			recentTerminal.id,
			"recent-worker",
			2_200,
		);
		await repository.beginReconciliation(
			recentTerminal.id,
			"recent-worker",
			2_300,
		);
		await repository.finish(
			recentTerminal.id,
			"recent-worker",
			0,
			"complete",
			2_400,
			10_000,
		);

		const { job: expiredTerminal } = await createJob({
			idempotencyKey: "expired-terminal-job",
			routingSelections: [],
			now: 3_000,
		});
		await repository.tryClaim(
			expiredTerminal.id,
			"expired-worker",
			3_100,
			9_000,
		);
		insertAccount(expiredTerminal.accountId, "expired-account");
		await repository.markAccountCommitted(
			expiredTerminal.id,
			"expired-worker",
			3_200,
		);
		await repository.beginReconciliation(
			expiredTerminal.id,
			"expired-worker",
			3_300,
		);
		await repository.finish(
			expiredTerminal.id,
			"expired-worker",
			0,
			"complete",
			3_400,
			4_000,
		);

		const visible = await repository.listRecent(10, 5_000);
		expect(visible.map((job) => job.id)).toEqual([
			recentTerminal.id,
			active.id,
		]);
		expect(
			(await repository.listRecent(1, 5_000)).map((job) => job.id),
		).toEqual([recentTerminal.id]);
		for (const job of visible) {
			expect("idempotencyKey" in job).toBe(false);
			expect("requestFingerprint" in job).toBe(false);
			expect("leaseToken" in job).toBe(false);
			expect("leaseExpiresAt" in job).toBe(false);
		}
	});

	it("persists only reviewed routing identities and narrow outcomes", async () => {
		const selections = [
			{
				family: "sonnet",
				proposalId: "proposal-sonnet",
				deviceCode: "provider-device-secret",
				accountName: "private-account-name",
				priority: 99,
			},
		] as Array<DeviceSetupRoutingSelection & Record<string, unknown>>;
		const { job } = await createJob({ routingSelections: selections });
		await repository.tryClaim(job.id, "worker", 1_100, 5_000);
		insertAccount(job.accountId);
		await repository.markAccountCommitted(job.id, "worker", 1_200);
		await repository.beginReconciliation(job.id, "worker", 1_300);

		const outcome = {
			family: "sonnet",
			proposalId: "proposal-sonnet",
			status: "action-required",
			reason: "stale-preview",
			providerResponse: "provider-response-secret",
			member: { account_name: "private-account-name" },
		} as DeviceSetupRoutingOutcome & Record<string, unknown>;
		await repository.advanceRoutingOutcome(job.id, "worker", 0, outcome, 1_400);

		const raw = db
			.prepare(
				`SELECT routing_selections_json, routing_outcomes_json
				 FROM device_setup_jobs WHERE id = ?`,
			)
			.get(job.id) as {
			routing_selections_json: string;
			routing_outcomes_json: string;
		};
		expect(JSON.parse(raw.routing_selections_json)).toEqual([
			{ family: "sonnet", proposal_id: "proposal-sonnet" },
		]);
		expect(JSON.parse(raw.routing_outcomes_json)).toEqual([
			{
				family: "sonnet",
				proposal_id: "proposal-sonnet",
				status: "action-required",
				reason: "stale-preview",
			},
		]);
		const persisted = JSON.stringify(raw);
		expect(persisted).not.toContain("provider-device-secret");
		expect(persisted).not.toContain("provider-response-secret");
		expect(persisted).not.toContain("private-account-name");
		expect(persisted).not.toContain("priority");
	});
});
