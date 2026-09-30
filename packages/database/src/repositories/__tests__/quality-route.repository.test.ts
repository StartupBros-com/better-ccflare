import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QualityVerifiedSession } from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { QualityRouteRepository } from "../quality-route.repository";

export const target = {
	accountId: "astra-account",
	provider: "codex",
	lane: "astra",
	line: "gpt-astra",
	physicalModel: "gpt-astra-model",
	catalogRevision: "catalog-1",
	evidenceRef: "evidence-1",
} as const;
const scope: QualityVerifiedSession = {
	verified: true,
	principalId: "principal",
	sessionId: "session",
};

describe("durable quality routing", () => {
	let directory: string;
	let connections: [Database, Database];
	let first: QualityRouteRepository;
	let second: QualityRouteRepository;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "quality-routing-"));
		const primary = new Database(join(directory, "test.db"));
		ensureSchema(primary);
		runMigrations(primary);
		connections = [primary, new Database(join(directory, "test.db"))];
		first = new QualityRouteRepository(new BunSqlAdapter(connections[0]));
		second = new QualityRouteRepository(new BunSqlAdapter(connections[1]));
	});
	afterEach(() => {
		for (const db of connections) db.close();
		rmSync(directory, { recursive: true });
	});
	it("diagnostics cannot extend expiry, cross principals, or overwrite retry intent", async () => {
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 100);
		const before = await first.status(scope, 101);
		const decision = {
			version: 1,
			policyRevision: "quality-policy-v1:fixture",
			requested: { kind: "main", preference: "auto" },
			selected: null,
			skippedLanes: [{ lane: "fable", reasons: { "account-unavailable": 1 } }],
		};
		await first.recordRejectedDecision(
			scope,
			ticket.incarnation,
			"$root",
			1,
			"request-one",
			decision,
			102,
		);
		const after = await second.status(scope, 103);
		expect(after?.expiresAt).toBe(before?.expiresAt);
		expect(after?.root).toEqual(before?.root);
		expect(after?.conversations[0]?.home).toBeNull();
		expect(after?.conversations[0]?.decision?.value).toEqual(decision);
		await expect(
			first.recordRejectedDecision(
				{ ...scope, principalId: "other" },
				ticket.incarnation,
				"$root",
				1,
				"request-other",
				decision,
				104,
			),
		).rejects.toThrow();
		await second.retryPreferred(
			{
				session: scope,
				incarnation: ticket.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "retry",
			},
			105,
		);
		await expect(
			first.recordRejectedDecision(
				scope,
				ticket.incarnation,
				"$root",
				1,
				"request-old",
				decision,
				106,
			),
		).rejects.toThrow();
		expect(
			(await first.status(scope, 107))?.conversations[0]?.decision,
		).toBeNull();
		if (!after) throw new Error("Missing session fixture");
		expect(await first.status(scope, after.expiresAt + 1000)).toBeNull();
	});

	it("delayed old child activity cannot shorten newer root expiry across connections", async () => {
		const db = connections[0];
		if (!db) throw new Error("Missing fixture connection");
		const adapter = new BunSqlAdapter(db);
		first = new QualityRouteRepository(adapter, { idleTtlMs: 10 });
		const other = connections[1];
		if (!other) throw new Error("Missing second connection");
		second = new QualityRouteRepository(new BunSqlAdapter(other), {
			idleTtlMs: 10,
		});
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 100);
		await first.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "worker" },
			"standard",
			null,
			100,
		);
		const recent = await second.reserveIngress(scope, 101);
		const update = adapter.runWithChanges.bind(adapter);
		spyOn(adapter, "runWithChanges").mockImplementationOnce(
			async (sql, params) => {
				await second.acceptRoot(recent, "auto", 109);
				return update(sql, params);
			},
		);
		await first.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "worker" },
			"standard",
			1,
			101,
		);
		expect((await second.status(scope, 110))?.expiresAt).toBe(119);
		expect(await second.cleanup(112)).toBe(0);
	});
	it("delayed lease renewal preserves newer renewal within the original deadline", async () => {
		const db = connections[0];
		if (!db) throw new Error("Missing fixture connection");
		const adapter = new BunSqlAdapter(db);
		const limits = { idleTtlMs: 10, leaseMs: 20, maxLeaseLifetimeMs: 40 };
		first = new QualityRouteRepository(adapter, limits);
		const other = connections[1];
		if (!other) throw new Error("Missing second connection");
		second = new QualityRouteRepository(new BunSqlAdapter(other), limits);
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 100);
		const lease = await first.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
			100,
		);
		const update = adapter.runWithChanges.bind(adapter);
		spyOn(adapter, "runWithChanges").mockImplementationOnce(
			async (sql, params) => {
				expect(await second.renewLease(lease, 119)).toBe(139);
				return update(sql, params);
			},
		);
		expect(await first.renewLease(lease, 101)).toBe(139);
		expect(await second.cleanup(130)).toBe(0);
		expect(await second.renewLease(lease, 138)).toBe(140);
		expect(await second.cleanup(149)).toBe(1);
	});
	it("retry is durable and idempotent, fences older completion, and never refreshes TTL on duplicate/status", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		const lease = await first.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
			1002,
		);
		await first.beginDispatch(lease, target, null, 1003);
		const input = {
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "retry-token",
		};
		const results = await Promise.all([
			first.retryPreferred(input, 1004),
			second.retryPreferred(input, 1004),
		]);
		expect(results[0]).toEqual(results[1]);
		expect(results[0]?.intentRevision).toBe(2);
		const before = await second.status(scope, 1005);
		expect(await second.retryPreferred(input, 9000)).toEqual(results[0]);
		expect((await first.status(scope, 9001))?.expiresAt).toBe(
			before?.expiresAt,
		);
		await expect(
			second.retryPreferred({ ...input, expectedIntentRevision: 2 }, 9002),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			first.settleDispatch(lease, { kind: "validated-success" }, 9003),
		).rejects.toMatchObject({ code: "stale" });
	});
	it("a committed retry whose response is lost returns its original outcome after reconstruction", async () => {
		const adapter = new BunSqlAdapter(connections[0]);
		first = new QualityRouteRepository(adapter);
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 100);
		const input = {
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "lost-retry-response",
		};
		const update = adapter.runWithChanges.bind(adapter);
		spyOn(adapter, "runWithChanges").mockImplementationOnce(
			async (sql, params) => {
				expect(await update(sql, params)).toBe(1);
				throw new Error("retry response lost after commit");
			},
		);
		await expect(first.retryPreferred(input, 101)).rejects.toThrow(
			"response lost",
		);
		const before = await second.status(scope, 102);
		const recovered = await new QualityRouteRepository(
			new BunSqlAdapter(connections[1]),
		).retryPreferred(input, 103);
		expect(recovered).toEqual(before?.commands[0]?.outcome);
		expect(recovered.intentRevision).toBe(2);
		expect((await second.status(scope, 104))?.expiresAt).toBe(
			before?.expiresAt,
		);
		expect(JSON.stringify(before)).not.toContain(input.idempotencyToken);
	});
	it("children retain independent homes when root leaves; unstable identities are request-only", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		expect(
			await first.acceptChild(
				scope,
				ticket.incarnation,
				null,
				"standard",
				null,
				1002,
			),
		).toBeNull();
		const child = await first.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "child-1" },
			"standard",
			null,
			1003,
		);
		if (!child) throw new Error("Expected enrolled child");
		const lease = await first.acquireLease(
			scope,
			ticket.incarnation,
			child.key,
			child.revision,
			1004,
		);
		await first.beginDispatch(lease, target, null, 1005);
		await first.settleDispatch(lease, { kind: "validated-success" }, 1006);
		const leave = await second.reserveIngress(scope, 1007);
		await second.acceptRoot(leave, null, 1008);
		expect(
			(await first.status(scope, 1009))?.conversations.find(
				(item) => item.key === "child:child-1",
			)?.home?.target,
		).toEqual(target);
		await expect(
			first.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: "new-child" },
				"standard",
				null,
				1010,
			),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(
			(
				await first.acceptChild(
					scope,
					ticket.incarnation,
					{ trusted: true, conversationId: "child-1" },
					"standard",
					1,
					1011,
				)
			)?.revision,
		).toBe(1);
		expect((await first.status(scope, 1012))?.root?.revision).toBe(2);
	});
	it("bounded lease renewal protects a stream but cannot keep an abandoned incarnation forever", async () => {
		first = new QualityRouteRepository(new BunSqlAdapter(connections[0]), {
			idleTtlMs: 10,
			leaseMs: 20,
			maxLeaseLifetimeMs: 40,
		});
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		const lease = await first.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
			1002,
		);
		expect(await first.cleanup(1015)).toBe(0);
		expect(await first.renewLease(lease, 1020)).toBe(1040);
		expect(await first.renewLease(lease, 1039)).toBe(1042);
		expect(await first.cleanup(1041)).toBe(0);
		expect(await first.cleanup(1043)).toBe(1);
		const recreated = await first.reserveIngress(scope, 1044);
		expect(recreated.incarnation).not.toBe(ticket.incarnation);
		await first.acceptRoot(recreated, "fable", 1045);
		await expect(first.acceptRoot(ticket, "astra", 1046)).rejects.toMatchObject(
			{ code: "stale" },
		);
		await expect(
			first.beginDispatch(lease, target, null, 1046),
		).rejects.toMatchObject({ code: "stale" });
	});
	it("competing first successes can install only one home across separate connections", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		const leases = await Promise.all([
			first.acquireLease(scope, ticket.incarnation, "$root", 1, 1002),
			second.acquireLease(scope, ticket.incarnation, "$root", 1, 1002),
		]);
		const starts = await Promise.allSettled([
			first.beginDispatch(leases[0], target, null, 1003),
			second.beginDispatch(
				leases[1],
				{ ...target, accountId: "other" },
				null,
				1003,
			),
		]);
		expect(
			starts.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const results = await Promise.allSettled([
			first.settleDispatch(leases[0], { kind: "validated-success" }, 1004),
			second.settleDispatch(leases[1], { kind: "validated-success" }, 1004),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			(await first.status(scope, 1005))?.conversations[0]?.homeVersion,
		).toBe(1);
	});
	it("distinct concurrent retry tokens with one revision have one winner", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		const input = {
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "one",
		};
		const results = await Promise.allSettled([
			first.retryPreferred(input, 1002),
			second.retryPreferred({ ...input, idempotencyToken: "two" }, 1002),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect((await first.status(scope, 1003))?.root?.revision).toBe(2);
	});
	it("retry and leave fence already-reserved delayed bodies without erasing child homes", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		const delayed = await first.reserveIngress(scope, 1002);
		await second.retryPreferred(
			{
				session: scope,
				incarnation: ticket.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "retry",
			},
			1003,
		);
		await expect(
			first.acceptRoot(delayed, "fable", 1004),
		).rejects.toMatchObject({ code: "stale" });
		const anotherDelayed = await first.reserveIngress(scope, 1005);
		const leave = await second.reserveIngress(scope, 1006);
		await second.acceptRoot(leave, null, 1007);
		await expect(
			first.acceptRoot(anotherDelayed, "auto", 1008),
		).rejects.toMatchObject({ code: "stale" });
		expect((await first.status(scope, 1009))?.root?.preference).toBeNull();
	});
	it("caller namespace isolates identical session strings and controls cannot enroll", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		const other = { ...scope, principalId: "different-caller" };
		expect(await second.status(other, 1002)).toBeNull();
		await expect(
			second.retryPreferred(
				{
					session: other,
					incarnation: ticket.incarnation,
					expectedIntentRevision: 1,
					idempotencyToken: "attack",
				},
				1003,
			),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			second.acceptRoot({ ...ticket, session: other }, "astra", 1004),
		).rejects.toMatchObject({ code: "unavailable" });
		expect((await first.status(scope, 1005))?.root?.revision).toBe(1);
	});
	it("global admission across distinct keys and connections cannot exceed the limit", async () => {
		first = new QualityRouteRepository(new BunSqlAdapter(connections[0]), {
			maxSessions: 1,
		});
		second = new QualityRouteRepository(new BunSqlAdapter(connections[1]), {
			maxSessions: 1,
		});
		const results = await Promise.allSettled([
			first.reserveIngress(scope, 100),
			second.reserveIngress({ ...scope, sessionId: "other" }, 100),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		if (!rejected || rejected.status !== "rejected")
			throw new Error("Expected admission rejection");
		expect(rejected.reason).toMatchObject({ code: "capacity" });
	});
	it("conversation and lease capacity preserve existing homes and reject excess growth", async () => {
		first = new QualityRouteRepository(new BunSqlAdapter(connections[0]), {
			maxConversations: 2,
			maxLeases: 1,
			leaseMs: 10,
		});
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 100);
		await first.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "one" },
			"standard",
			null,
			100,
		);
		await expect(
			first.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: "two" },
				"standard",
				null,
				100,
			),
		).rejects.toMatchObject({ code: "capacity" });
		const lease = await first.acquireLease(
			scope,
			ticket.incarnation,
			"$root",
			1,
			100,
		);
		await expect(
			first.acquireLease(scope, ticket.incarnation, "child:one", 1, 101),
		).rejects.toMatchObject({ code: "capacity" });
		await first.beginDispatch(lease, target, null, 102);
		await expect(
			first.acquireLease(scope, ticket.incarnation, "child:one", 1, 120),
		).rejects.toMatchObject({ code: "capacity" });
		await first.settleDispatch(lease, { kind: "validated-success" }, 121);
		expect(
			await first.acquireLease(scope, ticket.incarnation, "child:one", 1, 122),
		).toMatchObject({ conversation: "child:one" });
		expect(
			(await second.status(scope, 123))?.conversations[0]?.home?.target,
		).toEqual(target);
	});
	it("cleanup cannot erase activity that wins a race with an old cleanup request", async () => {
		const adapter = new BunSqlAdapter(connections[0]);
		first = new QualityRouteRepository(adapter, { idleTtlMs: 10 });
		second = new QualityRouteRepository(new BunSqlAdapter(connections[1]), {
			idleTtlMs: 10,
		});
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 100);
		const next = await second.reserveIngress(scope, 101);
		const update = adapter.runWithChanges.bind(adapter);
		spyOn(adapter, "runWithChanges").mockImplementationOnce(
			async (sql, params) => {
				await second.acceptRoot(next, "auto", 109);
				return update(sql, params);
			},
		);
		expect(await first.cleanup(112)).toBe(0);
		expect((await second.status(scope, 112))?.expiresAt).toBe(119);
	});
	it("capacity rejects admission and control growth without evicting current state", async () => {
		first = new QualityRouteRepository(new BunSqlAdapter(connections[0]), {
			maxSessions: 1,
			maxCommands: 1,
		});
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		await expect(
			first.reserveIngress({ ...scope, sessionId: "extra" }, 1002),
		).rejects.toMatchObject({ code: "capacity" });
		const input = {
			session: scope,
			incarnation: ticket.incarnation,
			expectedIntentRevision: 1,
			idempotencyToken: "first",
		};
		await first.retryPreferred(input, 1003);
		await expect(
			first.retryPreferred(
				{ ...input, expectedIntentRevision: 2, idempotencyToken: "extra" },
				1004,
			),
		).rejects.toMatchObject({ code: "capacity" });
		expect((await first.status(scope, 1005))?.root?.revision).toBe(2);
	});
	it("unknown, provisional and expired controls stay unavailable; valid inference refreshes idle TTL", async () => {
		first = new QualityRouteRepository(new BunSqlAdapter(connections[0]), {
			idleTtlMs: 10,
		});
		expect(await first.status(scope, 1000)).toBeNull();
		const ticket = await first.reserveIngress(scope, 1001);
		expect(await first.status(scope, 1002)).toBeNull();
		await expect(
			first.retryPreferred(
				{
					session: scope,
					incarnation: ticket.incarnation,
					expectedIntentRevision: 0,
					idempotencyToken: "early",
				},
				1003,
			),
		).rejects.toMatchObject({ code: "unavailable" });
		await first.acceptRoot(ticket, "auto", 1004);
		const continuation = await first.reserveIngress(scope, 1013);
		expect((await first.status(scope, 1013))?.expiresAt).toBe(1014);
		await first.acceptRoot(continuation, "auto", 1013);
		expect((await first.status(scope, 1014))?.expiresAt).toBe(1023);
		expect(await first.status(scope, 1023)).toBeNull();
		await expect(
			first.retryPreferred(
				{
					session: scope,
					incarnation: ticket.incarnation,
					expectedIntentRevision: 1,
					idempotencyToken: "late",
				},
				1024,
			),
		).rejects.toMatchObject({ code: "unavailable" });
	});
	it("failed, cancelled, truncated and losing completions never install homes", async () => {
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		for (const kind of [
			"failed",
			"cancelled",
			"truncated",
			"losing",
		] as const) {
			const lease = await first.acquireLease(
				scope,
				ticket.incarnation,
				"$root",
				1,
				1002,
			);
			await first.beginDispatch(lease, target, null, 1003);
			expect(await first.settleDispatch(lease, { kind }, 1004)).toBeNull();
		}
		expect(
			(await first.status(scope, 1005))?.conversations[0]?.homeVersion,
		).toBe(0);
	});
	it("database admission failure is propagated instead of creating stateless intent", async () => {
		connections[0]?.run(
			"CREATE TRIGGER refuse_quality BEFORE INSERT ON quality_route_sessions BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END",
		);
		await expect(first.reserveIngress(scope, 1000)).rejects.toThrow(
			"storage unavailable",
		);
		expect(await second.status(scope, 1001)).toBeNull();
	});
	it("fresh and upgrade paths install matching queryable schema and cleanup index", async () => {
		const db = connections[0];
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_quality_route_expiry'",
				)
				.get(),
		).not.toBeNull();
		db.run("DROP TABLE quality_route_sessions");
		db.run("DROP TABLE quality_route_admission");
		runMigrations(db);
		const ticket = await first.reserveIngress(scope, 1000);
		await first.acceptRoot(ticket, "auto", 1001);
		expect((await second.status(scope, 1002))?.root?.revision).toBe(1);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_quality_route_expiry'",
				)
				.get(),
		).not.toBeNull();
	});
	it("durably orders ingress across connections and rejects a delayed old preference", async () => {
		const old = await first.reserveIngress(scope, 1000);
		const recent = await second.reserveIngress(scope, 1001);
		const accepted = await second.acceptRoot(recent, "astra", 1002);
		expect(accepted.root?.preference).toBe("astra");
		await expect(first.acceptRoot(old, "fable", 1003)).rejects.toMatchObject({
			code: "stale",
		});
		expect((await first.status(scope, 1004))?.root?.preference).toBe("astra");
	});
});
