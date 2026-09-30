import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import type { APIContext, QualityVerifiedSession } from "@better-ccflare/types";
import { NodeCryptoUtils } from "@better-ccflare/types/api-key";
import {
	type RequestRow,
	sanitizeQualityDecision,
	toRequest,
} from "@better-ccflare/types/request";
import { SQL } from "bun";
import { APIRouter } from "../../../http-api/src/router";
import { QualityRouteService } from "../../../proxy/src/quality-route-service";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema } from "../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../migrations-pg";
import { ApiKeyRepository } from "../repositories/api-key.repository";
import { QualityRouteRepository } from "../repositories/quality-route.repository";
import { RequestRepository } from "../repositories/request.repository";

// Deliberately never consumes an ambient production DATABASE_URL.
const configuredUrl = process.env.BETTER_CCFLARE_TEST_POSTGRES_URL;
function safeUrl(raw: string): string {
	const url = new URL(raw);
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ||
		!/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))
	) {
		throw new Error(
			"Quality routing PG tests require a disposable loopback test database",
		);
	}
	return url.toString();
}
const postgresUrl = configuredUrl ? safeUrl(configuredUrl) : undefined;
if (process.env.CCFLARE_REQUIRE_LIVE_PG_MIGRATIONS === "true" && !postgresUrl) {
	throw new Error(
		"Required quality routing PG verification needs BETTER_CCFLARE_TEST_POSTGRES_URL",
	);
}
const scope: QualityVerifiedSession = {
	verified: true,
	principalId: "caller",
	sessionId: "session",
};
const target = {
	accountId: "a",
	provider: "codex",
	lane: "astra",
	line: "gpt-astra",
	physicalModel: "astra-fixture",
	catalogRevision: "catalog-1",
	evidenceRef: "fixture-1",
} as const;

describe.skipIf(!postgresUrl)(
	"quality routing real PostgreSQL cross-connection contract",
	() => {
		let admin: SQL;
		let schema: string;
		let adapters: [BunSqlAdapter, BunSqlAdapter];
		let first: QualityRouteRepository;
		let second: QualityRouteRepository;
		beforeEach(async () => {
			if (!postgresUrl) throw new Error("Missing disposable PG URL");
			schema = `quality_test_${randomUUID().replaceAll("-", "")}`;
			admin = new SQL({ url: postgresUrl, max: 1, prepare: false });
			await admin.unsafe(`CREATE SCHEMA ${schema}`);
			const connect = () =>
				new BunSqlAdapter(
					new SQL({
						url: postgresUrl,
						max: 1,
						prepare: false,
						connection: { search_path: schema },
					}),
					false,
				);
			adapters = [connect(), connect()];
			await ensureSchemaPg(adapters[0]);
			first = new QualityRouteRepository(adapters[0]);
			second = new QualityRouteRepository(adapters[1]);
		});
		afterEach(async () => {
			try {
				if (adapters)
					await Promise.all(adapters.map((adapter) => adapter.close()));
			} finally {
				try {
					if (schema && admin)
						await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
				} finally {
					if (admin) await admin.end();
				}
			}
		});

		it("authenticated HTTP exposes durable provenance after reconstruction and fences retry duplicates", async () => {
			const keys = new ApiKeyRepository(adapters[0]);
			const secret = "synthetic-pg-u8-owner";
			await keys.create({
				id: scope.principalId,
				name: "synthetic",
				hashed_key: await new NodeCryptoUtils().hashApiKey(secret),
				prefix_last_8: secret.slice(-8),
				created_at: 100,
				last_used: null,
				is_active: 1,
				role: "api-only",
			});
			const service = new QualityRouteService(first, () => 1000);
			const ticket = await service.reserveIngress(scope);
			await service.acceptRoot(ticket, "auto");
			const decision = sanitizeQualityDecision({
				version: 1,
				policyRevision: "quality-policy-v1:synthetic",
				requested: { kind: "main", preference: "auto" },
				selected: target,
				skippedLanes: [
					{ lane: "fable", reasons: { "subscription-exhausted": 1 } },
				],
			});
			const lease = await service.acquireLease(
				scope,
				ticket.incarnation,
				"$root",
				1,
			);
			await service.beginDispatch(lease, target, null);
			await service.settleDispatch(
				lease,
				{ kind: "validated-success" },
				{ requestId: "pg-http-history", decision },
			);
			// Use the second real PG connection after recreating the application service.
			const restarted = new QualityRouteService(second, () => 1001);
			const router = new APIRouter({
				db: adapters[1],
				dbOps: {
					getAdapter: () => adapters[1],
					countActiveApiKeys: () => keys.countActive(),
					getActiveApiKeys: () => keys.findActive(),
					updateApiKeyUsage: (id: string, at: number) =>
						keys.updateUsage(id, at),
				},
				config: {},
				qualityRouteService: restarted,
			} as unknown as APIContext);
			const call = async (body?: unknown, authorized = true) => {
				const req = new Request(
					`http://localhost/v1/quality-routing/sessions/session${body === undefined ? "" : "/retry-preferred"}`,
					{
						method: body === undefined ? "GET" : "POST",
						headers: {
							"content-type": "application/json",
							...(authorized ? { authorization: `Bearer ${secret}` } : {}),
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					},
				);
				const response = await router.handleRequest(new URL(req.url), req);
				if (!response) throw new Error("Control route fell through");
				return response;
			};
			expect((await call(undefined, false)).status).toBe(401);
			const before = await (await call()).json();
			expect(before).toMatchObject({
				status: "known",
				intentRevision: 1,
				lastSuccessfulHome: {
					target: { accountId: "a", physicalModel: "astra-fixture" },
				},
			});
			expect(JSON.stringify(before)).toContain("pg-http-history");
			expect(before.decision.selected.evidenceRef).toBeUndefined();
			expect(before.decision.selected.catalogRevision).toBeUndefined();
			const body = {
				incarnation: ticket.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "pg-http-retry",
			};
			const retry = await call(body);
			expect(retry.status).toBe(200);
			const outcome = await retry.json();
			expect(outcome).toMatchObject({ status: "ready", intentRevision: 2 });
			expect(await (await call(body)).json()).toEqual(outcome);
			expect(
				(await call({ ...body, idempotencyToken: "stale-retry" })).status,
			).toBe(409);
			const after = await (await call()).json();
			expect(after.intentRevision).toBe(2);
			expect(after.lastSuccessfulHome).toEqual(before.lastSuccessfulHome);
			expect(after.decision).toBeNull();
		});

		it("quality explanations survive fresh/upgrade, late saves and cross-connection readback", async () => {
			const repo = new RequestRepository(adapters[0]);
			const data = {
				id: "quality-history",
				method: "POST",
				path: "/v1/messages",
				accountUsed: null,
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTime: 10,
				failoverAttempts: 0,
			};
			const decision = sanitizeQualityDecision({
				version: 1,
				policyRevision: "quality-policy-v1:synthetic",
				requested: { kind: "main", preference: "auto" },
				selected: target,
				skippedLanes: [
					{ lane: "fable", reasons: { "subscription-exhausted": 1 } },
				],
			});
			expect(decision).not.toBeNull();
			await repo.save({ ...data, qualityDecision: decision });
			await repo.save(data);
			const row = await adapters[1].get<RequestRow>(
				"SELECT * FROM requests WHERE id = ?",
				[data.id],
			);
			if (!row) throw new Error("Missing request fixture row");
			expect(toRequest(row).qualityDecision).toEqual(decision);
			await adapters[0].unsafe(
				"ALTER TABLE requests DROP COLUMN quality_decision",
			);
			await runMigrationsPg(adapters[0]);
			const old = await adapters[1].get<RequestRow>(
				"SELECT * FROM requests WHERE id = ?",
				[data.id],
			);
			if (!old) throw new Error("Missing request fixture row");
			expect(toRequest(old).qualityDecision).toBeNull();
			await repo.save({ ...data, qualityDecision: decision });
			await repo.updateUsage(data.id, {
				model: target.physicalModel,
				inputTokens: 12,
				outputTokens: 4,
			});
			const upgraded = await adapters[1].get<RequestRow>(
				"SELECT * FROM requests WHERE id = ?",
				[data.id],
			);
			if (!upgraded) throw new Error("Missing request fixture row");
			expect(toRequest(upgraded).qualityDecision).toEqual(decision);
			expect(upgraded?.model).toBe(target.physicalModel);
		});

		it("fresh and upgrade schema have SQLite column/index parity and preserve existing session state", async () => {
			const sqlite = new Database(":memory:");
			try {
				ensureSchema(sqlite);
				const inventory = async () => {
					for (const table of [
						"quality_route_sessions",
						"quality_route_admission",
					]) {
						const expected = sqlite
							.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
							.all()
							.map((row) => row.name)
							.sort();
						const rows = await adapters[0].query<{ column_name: string }>(
							"SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
							[table],
						);
						expect(rows.map((row) => row.column_name).sort()).toEqual(expected);
					}
					const index = await adapters[0].get<{ indexdef: string }>(
						"SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_quality_route_expiry'",
					);
					expect(index?.indexdef).toContain(
						"(unresolved, expires_at, lease_until)",
					);
				};
				await inventory();
				await adapters[0].unsafe("DROP TABLE quality_route_sessions");
				await adapters[0].unsafe("DROP TABLE quality_route_admission");
				await runMigrationsPg(adapters[0]);
				await inventory();
				const ticket = await first.reserveIngress(scope, 100);
				await first.acceptRoot(ticket, "auto", 100);
				await runMigrationsPg(adapters[0]);
				expect((await second.status(scope, 101))?.incarnation).toBe(
					ticket.incarnation,
				);
			} finally {
				sqlite.close();
			}
		});

		it("distinct-key concurrent admissions obey the global cap without evicting live sessions", async () => {
			first = new QualityRouteRepository(adapters[0], { maxSessions: 1 });
			second = new QualityRouteRepository(adapters[1], { maxSessions: 1 });
			const outcomes = await Promise.allSettled([
				first.reserveIngress(scope, 100),
				second.reserveIngress({ ...scope, sessionId: "other" }, 100),
			]);
			expect(
				outcomes.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const rejection = outcomes.find((result) => result.status === "rejected");
			if (!rejection || rejection.status !== "rejected")
				throw new Error("Expected capacity rejection");
			expect(rejection.reason).toMatchObject({ code: "capacity" });
			const count = await adapters[0].get<{ count: string | number }>(
				"SELECT COUNT(*) AS count FROM quality_route_sessions",
			);
			expect(Number(count?.count)).toBe(1);
		});

		it("competing leases and first successes install only one winning home", async () => {
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			const leases = await Promise.all([
				first.acquireLease(scope, ticket.incarnation, "$root", 1, 101),
				second.acquireLease(scope, ticket.incarnation, "$root", 1, 101),
			]);
			const starts = await Promise.allSettled([
				first.beginDispatch(leases[0], target, null, 102),
				second.beginDispatch(
					leases[1],
					{ ...target, accountId: "b" },
					null,
					102,
				),
			]);
			expect(
				starts.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const finishes = await Promise.allSettled([
				first.settleDispatch(leases[0], { kind: "validated-success" }, 103),
				second.settleDispatch(leases[1], { kind: "validated-success" }, 103),
			]);
			expect(
				finishes.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				(await second.status(scope, 104))?.conversations[0]?.homeVersion,
			).toBe(1);
		});

		it("retry CAS, saved duplicates, token conflicts and ingress watermark survive reconstruction", async () => {
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			const delayed = await first.reserveIngress(scope, 101);
			const input = {
				session: scope,
				incarnation: ticket.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "one",
			};
			const outcomes = await Promise.allSettled([
				first.retryPreferred(input, 102),
				second.retryPreferred({ ...input, idempotencyToken: "two" }, 102),
			]);
			expect(
				outcomes.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const winner =
				outcomes[0].status === "fulfilled"
					? input
					: { ...input, idempotencyToken: "two" };
			const before = await first.status(scope, 103);
			const restarted = new QualityRouteRepository(adapters[1]);
			expect((await restarted.retryPreferred(winner, 104)).intentRevision).toBe(
				2,
			);
			expect((await restarted.status(scope, 105))?.expiresAt).toBe(
				before?.expiresAt,
			);
			await expect(
				restarted.retryPreferred({ ...winner, expectedIntentRevision: 2 }, 106),
			).rejects.toMatchObject({ code: "conflict" });
			await expect(
				first.acceptRoot(delayed, "fable", 107),
			).rejects.toMatchObject({ code: "stale" });
			expect(JSON.stringify(before)).not.toContain('"idempotencyToken"');
		});

		it("committed retry with lost response is recovered once, including concurrent exact duplicates", async () => {
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			const input = {
				session: scope,
				incarnation: ticket.incarnation,
				expectedIntentRevision: 1,
				idempotencyToken: "lost-retry-response",
			};
			const update = adapters[0].runWithChanges.bind(adapters[0]);
			spyOn(adapters[0], "runWithChanges").mockImplementationOnce(
				async (sql, params) => {
					expect(await update(sql, params)).toBe(1);
					throw new Error("retry response lost after commit");
				},
			);
			await expect(first.retryPreferred(input, 101)).rejects.toThrow(
				"response lost",
			);
			const before = await second.status(scope, 102);
			const outcomes = await Promise.all([
				new QualityRouteRepository(adapters[0]).retryPreferred(input, 103),
				new QualityRouteRepository(adapters[1]).retryPreferred(input, 103),
			]);
			expect(outcomes[0]).toEqual(outcomes[1]);
			expect(outcomes[0]).toEqual(before?.commands[0]?.outcome);
			expect((await second.status(scope, 104))?.root?.revision).toBe(2);
			expect((await second.status(scope, 104))?.expiresAt).toBe(
				before?.expiresAt,
			);
			expect(JSON.stringify(before)).not.toContain(input.idempotencyToken);
		});

		it("delayed activity and renewal never shorten expiry, while absolute lease bounds remain", async () => {
			const limits = { idleTtlMs: 10, leaseMs: 20, maxLeaseLifetimeMs: 40 };
			first = new QualityRouteRepository(adapters[0], limits);
			second = new QualityRouteRepository(adapters[1], limits);
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			await first.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: "child" },
				"standard",
				null,
				100,
			);
			const next = await second.reserveIngress(scope, 101);
			const update = adapters[0].runWithChanges.bind(adapters[0]);
			spyOn(adapters[0], "runWithChanges").mockImplementationOnce(
				async (sql, params) => {
					await second.acceptRoot(next, "auto", 109);
					return update(sql, params);
				},
			);
			await first.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: "child" },
				"standard",
				1,
				101,
			);
			expect((await second.status(scope, 110))?.expiresAt).toBe(119);
			expect(await second.cleanup(112)).toBe(0);
			const lease = await first.acquireLease(
				scope,
				ticket.incarnation,
				"$root",
				1,
				113,
			);
			spyOn(adapters[0], "runWithChanges").mockImplementationOnce(
				async (sql, params) => {
					expect(await second.renewLease(lease, 130)).toBe(150);
					return update(sql, params);
				},
			);
			expect(await first.renewLease(lease, 114)).toBe(150);
			expect(await second.renewLease(lease, 149)).toBe(153);
			expect(await first.cleanup(152)).toBe(0);
			expect(await first.cleanup(154)).toBe(1);
			const recreated = await second.reserveIngress(scope, 155);
			await second.acceptRoot(recreated, "auto", 155);
			expect(recreated.incarnation).not.toBe(ticket.incarnation);
			await expect(
				first.beginDispatch(lease, target, null, 156),
			).rejects.toMatchObject({ code: "stale" });
		});

		it("cleanup rechecks a row after concurrent committed activity", async () => {
			first = new QualityRouteRepository(adapters[0], { idleTtlMs: 10 });
			second = new QualityRouteRepository(adapters[1], { idleTtlMs: 10 });
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			const next = await second.reserveIngress(scope, 101);
			// Hold the row lock while DELETE starts with the old expired snapshot.
			if (!postgresUrl) throw new Error("Missing disposable PG URL");
			const writer = new SQL({
				url: postgresUrl,
				max: 1,
				prepare: false,
				connection: { search_path: schema },
			});
			let pendingCleanup: Promise<number> | undefined;
			let waiting = false;
			try {
				await writer.begin(async (tx) => {
					const refreshed = await second.status(scope, 109);
					if (!refreshed) throw new Error("Missing session");
					refreshed.expiresAt = 119;
					refreshed.acceptedOrder = next.order;
					await tx.unsafe(
						"UPDATE quality_route_sessions SET state_json = $1, expires_at = 119, version = version + 1 WHERE session_id = 'session'",
						[JSON.stringify(refreshed)],
					);
					const deletion = first.cleanup(112);
					// Verify the real server has the DELETE waiting on the writer's row lock.
					for (let attempt = 0; attempt < 100; attempt++) {
						const rows = await admin.unsafe(
							"SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM quality_route_sessions%' AND datname = current_database()",
						);
						if (rows.length > 0) {
							waiting = true;
							break;
						}
						await Bun.sleep(10);
					}
					// Save the waiting promise without awaiting it until the transaction commits.
					pendingCleanup = deletion;
				});
				expect(await pendingCleanup).toBe(0);
				expect(waiting).toBe(true);
				expect((await second.status(scope, 112))?.expiresAt).toBe(119);
			} finally {
				await writer.end();
			}
		});

		it("failed and ambiguous settlement retain exactly the right fence and recover persistence only", async () => {
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			const lease = await first.acquireLease(
				scope,
				ticket.incarnation,
				"$root",
				1,
				100,
			);
			await first.beginDispatch(lease, target, null, 100);
			const update = adapters[0].runWithChanges.bind(adapters[0]);
			spyOn(adapters[0], "runWithChanges").mockImplementationOnce(async () => {
				throw new Error("database unavailable before commit");
			});
			await expect(
				first.settleDispatch(lease, { kind: "validated-success" }, 101),
			).rejects.toThrow("before commit");
			second = new QualityRouteRepository(adapters[1]);
			expect(await second.cleanup(100_000_000)).toBe(0);
			await expect(
				second.acquireLease(scope, ticket.incarnation, "$root", 1, 100_000_000),
			).rejects.toMatchObject({ code: "unresolved" });
			spyOn(adapters[0], "runWithChanges").mockImplementationOnce(
				async (sql, params) => {
					expect(await update(sql, params)).toBe(1);
					throw new Error("committed response lost");
				},
			);
			await expect(
				first.settleDispatch(lease, { kind: "validated-success" }, 100_000_001),
			).rejects.toThrow("response lost");
			const before = await second.status(scope, 100_000_002);
			expect(before?.leases.filter((entry) => entry.dispatch)).toHaveLength(0);
			expect(
				await second.settleDispatch(
					lease,
					{ kind: "validated-success" },
					100_000_003,
				),
			).toEqual(before?.conversations[0]?.home);
			expect(
				(await second.status(scope, 100_000_004))?.conversations[0]
					?.homeVersion,
			).toBe(1);
			expect((await second.status(scope, 100_000_004))?.expiresAt).toBe(
				before?.expiresAt,
			);
		});

		it("independent child homes survive root retry and leave, while old root completions stay fenced", async () => {
			const ticket = await first.reserveIngress(scope, 100);
			await first.acceptRoot(ticket, "auto", 100);
			expect(
				await first.acceptChild(
					scope,
					ticket.incarnation,
					null,
					"standard",
					null,
					100,
				),
			).toBeNull();
			const child = await first.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: "worker" },
				"standard",
				null,
				100,
			);
			if (!child) throw new Error("Expected child");
			const childLease = await first.acquireLease(
				scope,
				ticket.incarnation,
				child.key,
				child.revision,
				100,
			);
			await first.beginDispatch(childLease, target, null, 100);
			await first.settleDispatch(
				childLease,
				{ kind: "validated-success" },
				100,
			);
			const rootLease = await first.acquireLease(
				scope,
				ticket.incarnation,
				"$root",
				1,
				100,
			);
			await first.beginDispatch(rootLease, target, null, 100);
			await second.retryPreferred(
				{
					session: scope,
					incarnation: ticket.incarnation,
					expectedIntentRevision: 1,
					idempotencyToken: "retry",
				},
				101,
			);
			await expect(
				first.settleDispatch(rootLease, { kind: "validated-success" }, 102),
			).rejects.toMatchObject({ code: "stale" });
			const leave = await second.reserveIngress(scope, 103);
			await second.acceptRoot(leave, null, 103);
			expect(
				(await first.status(scope, 104))?.conversations.find(
					(item) => item.key === child.key,
				)?.home?.target,
			).toEqual(target);
			expect(
				(
					await first.acceptChild(
						scope,
						ticket.incarnation,
						{ trusted: true, conversationId: "worker" },
						"standard",
						1,
						104,
					)
				)?.revision,
			).toBe(1);
			await expect(
				first.acceptChild(
					scope,
					ticket.incarnation,
					{ trusted: true, conversationId: "new" },
					"standard",
					null,
					104,
				),
			).rejects.toMatchObject({ code: "unavailable" });
		});

		it("command, conversation and unresolved lease bounds reject growth instead of evicting records", async () => {
			first = new QualityRouteRepository(adapters[0], {
				maxCommands: 1,
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
			await first.retryPreferred(
				{
					session: scope,
					incarnation: ticket.incarnation,
					expectedIntentRevision: 1,
					idempotencyToken: "one",
				},
				100,
			);
			await expect(
				first.retryPreferred(
					{
						session: scope,
						incarnation: ticket.incarnation,
						expectedIntentRevision: 2,
						idempotencyToken: "two",
					},
					100,
				),
			).rejects.toMatchObject({ code: "capacity" });
			const lease = await first.acquireLease(
				scope,
				ticket.incarnation,
				"$root",
				2,
				100,
			);
			await first.beginDispatch(lease, target, null, 100);
			await expect(
				first.acquireLease(scope, ticket.incarnation, "child:one", 1, 120),
			).rejects.toMatchObject({ code: "capacity" });
			expect((await second.status(scope, 120))?.conversations).toHaveLength(2);
		});
	},
);
