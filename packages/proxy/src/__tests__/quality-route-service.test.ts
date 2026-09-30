import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	QualityPhysicalTarget,
	QualityVerifiedSession,
} from "@better-ccflare/types";
import { BunSqlAdapter } from "../../../database/src/adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../../database/src/database-operations";
import { ensureSchema } from "../../../database/src/migrations";
import { QualityRouteRepository } from "../../../database/src/repositories/quality-route.repository";
import { QualityRouteService } from "../quality-route-service";

const scope: QualityVerifiedSession = {
	verified: true,
	principalId: "caller-a",
	sessionId: "cc-session",
};
const astra: QualityPhysicalTarget = {
	accountId: "a",
	provider: "codex",
	lane: "astra",
	line: "gpt-astra",
	physicalModel: "astra-concrete",
	catalogRevision: "c1",
	evidenceRef: "verified-1",
};
const fable: QualityPhysicalTarget = {
	accountId: "b",
	provider: "anthropic",
	lane: "fable",
	line: "claude-fable",
	physicalModel: "fable-concrete",
	catalogRevision: "c2",
	evidenceRef: "verified-2",
};

function scheduler() {
	const pending = new Map<() => void | Promise<void>, number>();
	return {
		pending,
		schedule(callback: () => void | Promise<void>, delay: number) {
			pending.set(callback, delay);
			return () => {
				pending.delete(callback);
			};
		},
		async tick() {
			const callback = pending.keys().next().value;
			if (!callback) throw new Error("No scheduled recovery");
			pending.delete(callback);
			await callback();
		},
	};
}

describe("QualityRouteService persistence-only lifecycle", () => {
	let directory: string;
	let db: Database;
	let service: QualityRouteService;
	let now: number;
	const reopen = () => {
		db = new Database(join(directory, "test.db"));
		ensureSchema(db);
		service = new QualityRouteService(
			new QualityRouteRepository(new BunSqlAdapter(db)),
			() => now,
		);
	};
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "quality-service-"));
		now = 1000;
		reopen();
	});
	afterEach(async () => {
		await service.stop();
		db.close();
		rmSync(directory, { recursive: true });
	});
	const observedFixture = async (capacity = 2, mode = "root") => {
		const clock = scheduler();
		service = new QualityRouteService(
			new QualityRouteRepository(new BunSqlAdapter(db)),
			() => now,
			{ capacity, schedule: clock.schedule },
		);
		const ticket = await service.reserveIngress(scope);
		await service.acceptRoot(ticket, "auto");
		let conversation: string | null = "$root";
		if (mode === "request-only") conversation = null;
		if (mode === "child") {
			const child = await service.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: "worker" },
				"standard",
				null,
			);
			conversation = child?.key ?? null;
			expect(conversation).not.toBeNull();
		}
		const reserved = service.reserveObservedSettlement();
		if (!reserved) throw new Error("Missing reservation");
		const lease = await service.acquireLease(
			scope,
			ticket.incarnation,
			conversation,
			1,
		);
		await reserved.bind(lease);
		await service.beginDispatch(lease, astra, null);
		return { clock, reserved, lease, ticket, conversation };
	};
	it.each([
		"root",
		"child",
		"request-only",
	])("owned %s success survives real SQLite write outage without inference", async (mode) => {
		const { clock, reserved, conversation } = await observedFixture(1, mode);
		db.run(
			"CREATE TRIGGER outage BEFORE UPDATE ON quality_route_sessions BEGIN SELECT RAISE(ABORT, 'database unavailable'); END",
		);
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
		expect(service.reserveObservedSettlement()).toBeNull();
		for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
			expect([...clock.pending.values()]).toEqual([delay]);
			await clock.tick();
		}
		db.run("DROP TRIGGER outage");
		await clock.tick();
		const status = await service.status(scope);
		expect(status?.unresolved).toHaveLength(0);
		if (conversation)
			expect(
				status?.conversations.find((item) => item.key === conversation)?.home
					?.target,
			).toEqual(astra);
		else
			expect(status?.conversations.every((item) => item.home === null)).toBe(
				true,
			);
		expect(clock.pending.size).toBe(0);
		expect(service.reserveObservedSettlement()).not.toBeNull();
	});
	it.each([
		"failed",
		"truncated",
		"cancelled",
		"losing",
	] as const)("recovered %s outcome never installs a home", async (kind) => {
		const { clock, reserved } = await observedFixture();
		const write = spyOn(service, "settleDispatch").mockRejectedValue(
			new Error("outage"),
		);
		expect(await reserved.settle({ kind })).toBe(false);
		expect(write).toHaveBeenCalledTimes(3);
		write.mockRestore();
		await clock.tick();
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
		expect((await service.status(scope))?.conversations[0]?.home).toBeNull();
	});
	it.each([
		"validated-success",
		"failed",
	] as const)("acknowledged %s remains idempotent after ownership retires", async (kind) => {
		const { reserved, lease } = await observedFixture();
		const duplicate = service.reserveObservedSettlement();
		if (!duplicate) throw new Error("Missing duplicate reservation");
		await duplicate.bind(lease);
		const write = spyOn(service, "settleDispatch");
		try {
			expect(await reserved.settle({ kind })).toBe(true);
			expect(await reserved.settle({ kind })).toBe(true);
			expect(await duplicate.settle({ kind })).toBe(true);
			expect(
				await duplicate.settle({
					kind: kind === "failed" ? "validated-success" : "failed",
				}),
			).toBe(false);
			expect(write).toHaveBeenCalledTimes(1);
		} finally {
			write.mockRestore();
		}
	});
	it("concurrent same-lease completions deduplicate and retain immutable bounded evidence", async () => {
		const { clock, reserved, lease } = await observedFixture();
		const duplicate = service.reserveObservedSettlement();
		if (!duplicate) throw new Error("Missing duplicate reservation");
		await duplicate.bind(lease);
		const outcome = { kind: "validated-success" as const };
		const diagnostics = {
			requestId: "original",
			decision: {
				version: 1 as const,
				policyRevision: "quality-policy-v1:test" as const,
				requested: { kind: "main" as const, preference: "auto" as const },
				selected: { ...astra },
				skippedLanes: [],
			},
		};
		const write = spyOn(service, "settleDispatch").mockRejectedValue(
			new Error("outage"),
		);
		const first = reserved.settle(outcome, diagnostics);
		expect(duplicate.settle(outcome, diagnostics)).toBe(first);
		expect(await duplicate.settle({ kind: "failed" })).toBe(false);
		await first;
		expect(write).toHaveBeenCalledTimes(3);
		(outcome as { kind: string }).kind = "failed";
		lease.session = { ...lease.session, sessionId: "mutated" };
		diagnostics.requestId = "changed";
		diagnostics.decision.selected.physicalModel = "changed";
		write.mockRestore();
		await clock.tick();
		const state = await service.status({ ...scope, sessionId: "cc-session" });
		expect(state?.conversations[0]?.home?.target).toEqual(astra);
		expect(state?.conversations[0]?.decision?.requestId).toBe("original");
		expect(
			state?.conversations[0]?.decision?.value.selected?.physicalModel,
		).toBe("astra-concrete");
	});
	it.each([
		"root",
		"request-only",
	])("unknown %s ownership retires only after committed parent retry", async (mode) => {
		const { reserved, ticket } = await observedFixture(1, mode);
		const input = {
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "retry-unknown",
		};
		expect(service.reserveObservedSettlement()).toBeNull();
		await expect(
			service.retryPreferred({ ...input, expectedIntentRevision: 9 }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(service.reserveObservedSettlement()).toBeNull();
		await service.retryPreferred(input);
		const next = service.reserveObservedSettlement();
		expect(next).not.toBeNull();
		if (!next) return;
		const lease = await service.acquireLease(
			scope,
			ticket.incarnation,
			mode === "root" ? "$root" : null,
			2,
		);
		await next.bind(lease);
		await service.beginDispatch(lease, astra, null);
		await service.retryPreferred(input);
		expect(service.reserveObservedSettlement()).toBeNull();
		const write = spyOn(service, "settleDispatch");
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
		expect(write).not.toHaveBeenCalled();
		write.mockRestore();
		expect(
			(await service.status(scope))?.unresolved.map((item) => item.identity),
		).toEqual([lease]);
	});
	it("unknown root ownership retires on changed accepted preference, not unchanged preference", async () => {
		await observedFixture(1);
		await service.acceptRoot(await service.reserveIngress(scope), "auto");
		expect(service.reserveObservedSettlement()).toBeNull();
		await service.acceptRoot(await service.reserveIngress(scope), "opus");
		expect(service.reserveObservedSettlement()).not.toBeNull();
	});
	it("root controls retain unknown identified child ownership until its own role changes", async () => {
		const { ticket } = await observedFixture(1, "child");
		await service.retryPreferred({
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "parent",
		});
		await service.acceptRoot(await service.reserveIngress(scope), "opus");
		expect(service.reserveObservedSettlement()).toBeNull();
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
		await service.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "worker" },
			"standard",
			1,
		);
		expect(service.reserveObservedSettlement()).toBeNull();
		await service.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "worker" },
			"lightweight",
			1,
		);
		expect(service.reserveObservedSettlement()).not.toBeNull();
	});
	it("retired in-flight write remains charged and late callbacks cannot write", async () => {
		const { reserved, ticket } = await observedFixture(1);
		const flight = Promise.withResolvers<never>();
		const write = spyOn(service, "settleDispatch").mockImplementation(
			() => flight.promise,
		);
		const settling = reserved.settle({ kind: "validated-success" });
		await service.retryPreferred({
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "flight",
		});
		expect(service.reserveObservedSettlement()).toBeNull();
		flight.reject(new Error("outage"));
		await settling;
		expect(service.reserveObservedSettlement()).not.toBeNull();
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
		expect(write).toHaveBeenCalledTimes(1);
		write.mockRestore();
	});
	it("late binding reconciles a control committed while reservation was unbound", async () => {
		const { reserved, lease, ticket } = await observedFixture(1);
		reserved.release();
		const late = service.reserveObservedSettlement();
		if (!late) throw new Error("Missing late reservation");
		await service.retryPreferred({
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "late",
		});
		await late.bind(lease);
		expect(service.reserveObservedSettlement()).not.toBeNull();
		const write = spyOn(service, "settleDispatch");
		expect(await late.settle({ kind: "failed" })).toBe(false);
		expect(write).not.toHaveBeenCalled();
		write.mockRestore();
	});
	it("a control completing during binding retires ownership despite an older status snapshot", async () => {
		const { reserved, lease, ticket } = await observedFixture(1);
		reserved.release();
		const late = service.reserveObservedSettlement();
		if (!late) throw new Error("Missing late reservation");
		const captured = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const original = QualityRouteRepository.prototype.status;
		const read = spyOn(
			QualityRouteRepository.prototype,
			"status",
		).mockImplementationOnce(async function (
			this: QualityRouteRepository,
			...args
		) {
			const snapshot = await original.apply(this, args);
			captured.resolve();
			await resume.promise;
			return snapshot;
		});
		const binding = late.bind(lease);
		try {
			await captured.promise;
			await service.retryPreferred({
				session: scope,
				incarnation: ticket.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "during-bind",
			});
		} finally {
			resume.resolve();
			await binding;
			read.mockRestore();
		}
		expect(service.reserveObservedSettlement()).not.toBeNull();
		const write = spyOn(service, "settleDispatch");
		try {
			expect(await late.settle({ kind: "validated-success" })).toBe(false);
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});
	it("failed first outcome cannot be upgraded by a conflicting callback during recovery", async () => {
		const { clock, reserved } = await observedFixture(1);
		db.run(
			"CREATE TRIGGER outage BEFORE UPDATE ON quality_route_sessions BEGIN SELECT RAISE(ABORT, 'database unavailable'); END",
		);
		expect(await reserved.settle({ kind: "failed" })).toBe(false);
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
		expect(service.reserveObservedSettlement()).toBeNull();
		db.run("DROP TRIGGER outage");
		await clock.tick();
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
		expect((await service.status(scope))?.conversations[0]?.home).toBeNull();
		expect(await reserved.settle({ kind: "failed" })).toBe(true);
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
	});
	it("stale recovery discards old evidence without replacing newer intent", async () => {
		const { clock, reserved, ticket } = await observedFixture(1);
		const write = spyOn(service, "settleDispatch").mockRejectedValue(
			new Error("outage"),
		);
		await reserved.settle({ kind: "validated-success" });
		write.mockRestore();
		await service.retryPreferred({
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "retry",
		});
		const before = await service.status(scope);
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
		expect(await service.status(scope)).toEqual(before);
		expect(clock.pending.size).toBe(0);
		expect(service.reserveObservedSettlement()).not.toBeNull();
	});
	it("stop cancels retry timers, refuses capacity and preserves unknown restart fences", async () => {
		const { clock, reserved } = await observedFixture();
		const write = spyOn(service, "settleDispatch").mockRejectedValue(
			new Error("outage"),
		);
		await reserved.settle({ kind: "validated-success" });
		await service.stop();
		expect(clock.pending.size).toBe(0);
		expect(service.reserveObservedSettlement()).toBeNull();
		write.mockRestore();
		db.close();
		reopen();
		now += 100_000_000;
		expect(await service.cleanup()).toBe(0);
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
	});
	it("capacity reservations are synchronous and aborted preparation returns only memory", async () => {
		const { reserved } = await observedFixture(1);
		expect(service.reserveObservedSettlement()).toBeNull();
		reserved.release();
		reserved.release();
		expect(service.reserveObservedSettlement()).not.toBeNull();
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
	});
	it("stop waits for an active persistence attempt and does not schedule further writes", async () => {
		const { clock, reserved } = await observedFixture();
		const release = Promise.withResolvers<never>();
		const write = spyOn(service, "settleDispatch").mockImplementation(
			() => release.promise,
		);
		const settlement = reserved.settle({ kind: "validated-success" });
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release.reject(new Error("closing outage"));
		expect(await settlement).toBe(false);
		await stopping;
		expect(stopped).toBe(true);
		expect(clock.pending.size).toBe(0);
		expect(write).toHaveBeenCalledTimes(1);
		write.mockRestore();
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
	});
	it("untrusted diagnostics are discarded rather than retained or persisted", async () => {
		const { clock, reserved } = await observedFixture();
		const write = spyOn(service, "settleDispatch").mockRejectedValue(
			new Error("outage"),
		);
		await reserved.settle(
			{ kind: "validated-success" },
			{
				requestId: "x".repeat(129),
				decision: { secret: "must-not-retain" } as never,
			},
		);
		expect(write.mock.calls.every((call) => call[2] === undefined)).toBe(true);
		write.mockRestore();
		await clock.tick();
		expect(
			(await service.status(scope))?.conversations[0]?.decision,
		).toBeNull();
	});
	it("owned recovery tolerates a committed write with three lost acknowledgements", async () => {
		const { clock, reserved } = await observedFixture();
		const original = service.settleDispatch.bind(service);
		const write = spyOn(service, "settleDispatch").mockImplementation(
			async (...args) => {
				await original(...args);
				throw new Error("acknowledgement lost");
			},
		);
		expect(await reserved.settle({ kind: "validated-success" })).toBe(false);
		expect(write).toHaveBeenCalledTimes(3);
		expect((await service.status(scope))?.conversations[0]?.home?.version).toBe(
			1,
		);
		write.mockRestore();
		await clock.tick();
		expect((await service.status(scope))?.conversations[0]?.home?.version).toBe(
			1,
		);
		expect(clock.pending.size).toBe(0);
	});
	it("database facade supplies one usable repository on the existing database connection", async () => {
		if (process.env.DATABASE_URL)
			throw new Error("Run this SQLite fixture without DATABASE_URL");
		const operations = new DatabaseOperations(join(directory, "facade.db"));
		try {
			const repository = operations.getQualityRouteRepository();
			expect(operations.getQualityRouteRepository()).toBe(repository);
			const routed = new QualityRouteService(repository, () => now);
			const ticket = await routed.reserveIngress(scope);
			await routed.acceptRoot(ticket, "auto");
			expect((await routed.status(scope))?.intentRevision).toBe(1);
		} finally {
			await operations.close();
		}
	});
	it("reconstruction retains exact fallback; transient success cannot promote a healthy home", async () => {
		const ticket = await service.reserveIngress(scope);
		await service.acceptRoot(ticket, "auto");
		const first = await service.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
		);
		await service.beginDispatch(first, astra, null);
		await service.settleDispatch(first, { kind: "validated-success" });
		db.close();
		reopen();
		const status = await service.status(scope);
		expect(status?.conversations[0]?.home?.target).toEqual(astra);
		const continuation = await service.reserveIngress(scope);
		await service.acceptRoot(continuation, "auto");
		const fallback = await service.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
		);
		await service.beginDispatch(fallback, fable, null);
		await service.settleDispatch(fallback, { kind: "validated-success" });
		expect(
			(await service.status(scope))?.conversations[0]?.home?.target,
		).toEqual(astra);
	});
	it("committed settlement with a lost response recovers the saved result after restart without inference", async () => {
		const adapter = new BunSqlAdapter(db);
		service = new QualityRouteService(
			new QualityRouteRepository(adapter),
			() => now,
		);
		const ticket = await service.reserveIngress(scope);
		await service.acceptRoot(ticket, "auto");
		const lease = await service.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
		);
		await service.beginDispatch(lease, astra, null);
		const update = adapter.runWithChanges.bind(adapter);
		spyOn(adapter, "runWithChanges").mockImplementationOnce(
			async (sql, params) => {
				expect(await update(sql, params)).toBe(1);
				throw new Error("committed response lost");
			},
		);
		await expect(
			service.settleDispatch(lease, { kind: "validated-success" }),
		).rejects.toThrow("committed response lost");
		db.close();
		reopen();
		const before = await service.status(scope);
		expect(before?.unresolved).toHaveLength(0);
		expect(before?.conversations[0]?.home?.version).toBe(1);
		now += 100;
		expect(
			await service.settleDispatch(lease, { kind: "validated-success" }),
		).toEqual(before?.conversations[0]?.home);
		expect((await service.status(scope))?.expiresAt).toBe(before?.expiresAt);
		await expect(
			service.settleDispatch(lease, { kind: "failed" }),
		).rejects.toMatchObject({ code: "conflict" });
	});
	it.each([
		"validated-success",
		"failed",
	] as const)("request-only %s lost acknowledgement recovers after restart without a home", async (kind) => {
		const adapter = new BunSqlAdapter(db);
		service = new QualityRouteService(
			new QualityRouteRepository(adapter),
			() => now,
		);
		const ticket = await service.reserveIngress(scope);
		await service.acceptRoot(ticket, "auto");
		const before = (await service.status(scope))?.conversations;
		const lease = await service.acquireLease(
			scope,
			ticket.incarnation,
			null,
			1,
		);
		await service.beginDispatch(lease, astra, null);
		const update = adapter.runWithChanges.bind(adapter);
		spyOn(adapter, "runWithChanges").mockImplementationOnce(
			async (sql, params) => {
				expect(await update(sql, params)).toBe(1);
				throw new Error("committed response lost");
			},
		);
		await expect(service.settleDispatch(lease, { kind })).rejects.toThrow(
			"committed response lost",
		);
		db.close();
		reopen();
		expect(await service.settleDispatch(lease, { kind })).toBeNull();
		expect((await service.status(scope))?.conversations).toEqual(before);
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
	});
	it("request-only failed persistence retains its unresolved fence through restart and cleanup", async () => {
		const ticket = await service.reserveIngress(scope);
		await service.acceptRoot(ticket, "auto");
		const before = (await service.status(scope))?.conversations;
		const lease = await service.acquireLease(
			scope,
			ticket.incarnation,
			null,
			1,
		);
		await service.beginDispatch(lease, astra, null);
		db.run(
			"CREATE TRIGGER fail_request_only BEFORE UPDATE ON quality_route_sessions BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END",
		);
		await expect(
			service.settleDispatch(lease, { kind: "validated-success" }),
		).rejects.toThrow("settlement unavailable");
		db.close();
		reopen();
		now += 100_000_000;
		expect(await service.cleanup()).toBe(0);
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
		await expect(
			service.acquireLease(scope, ticket.incarnation, null, 1),
		).rejects.toMatchObject({ code: "unresolved" });
		db.run("DROP TRIGGER fail_request_only");
		expect(
			await service.settleDispatch(lease, { kind: "validated-success" }),
		).toBeNull();
		expect((await service.status(scope))?.conversations).toEqual(before);
	});
	it("failed settlement survives restart and expired lease; recovery persists only the saved candidate", async () => {
		const ticket = await service.reserveIngress(scope);
		await service.acceptRoot(ticket, "auto");
		const lease = await service.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
		);
		await service.beginDispatch(lease, astra, null);
		db.run(
			"CREATE TRIGGER fail_settlement BEFORE UPDATE ON quality_route_sessions BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END",
		);
		await expect(
			service.settleDispatch(lease, { kind: "validated-success" }),
		).rejects.toThrow("settlement unavailable");
		db.close();
		reopen();
		now += 100_000_000;
		expect(await service.cleanup()).toBe(0);
		expect((await service.status(scope))?.unresolved).toHaveLength(1);
		db.run("DROP TRIGGER fail_settlement");
		await expect(
			service.acquireLease(scope, ticket.incarnation, "$root", 1),
		).rejects.toMatchObject({ code: "unresolved" });
		expect(
			(await service.settleDispatch(lease, { kind: "validated-success" }))
				?.target,
		).toEqual(astra);
		expect((await service.status(scope))?.unresolved).toHaveLength(0);
		expect(
			(await service.settleDispatch(lease, { kind: "validated-success" }))
				?.version,
		).toBe(1);
	});
});
