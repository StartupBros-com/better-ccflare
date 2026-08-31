import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../../migrations-pg";
import { RequestRepository } from "../request.repository";
import {
	type RoutingAttemptData,
	RoutingAttemptRepository,
} from "../routing-attempt.repository";

const now = Date.now();

function attempt(
	overrides: Partial<RoutingAttemptData> = {},
): RoutingAttemptData {
	return {
		id: crypto.randomUUID(),
		parentRequestId: "request-1",
		timestamp: now,
		provider: "anthropic",
		accountId: "account-1",
		attemptedModel: "claude-opus-4",
		modelFamily: "opus",
		statusCode: 429,
		reason: "model_scoped_429",
		scope: "model",
		availableAt: null,
		failoverAttempts: 1,
		physicalAttempt: 2,
		accountBenched: false,
		routeSuppressed: true,
		circuitCounted: false,
		upstreamEvidence: null,
		...overrides,
	};
}

function terminal(
	id: string,
	success: boolean,
): Parameters<RequestRepository["save"]>[0] {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		accountUsed: "account-1",
		statusCode: success ? 200 : 429,
		success,
		errorMessage: success ? null : "terminal error",
		responseTime: 1,
		failoverAttempts: 0,
	};
}

describe("RoutingAttemptRepository", () => {
	let db: Database;
	let attempts: RoutingAttemptRepository;
	let requests: RequestRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		attempts = new RoutingAttemptRepository(adapter);
		requests = new RequestRepository(adapter);
	});

	afterEach(() => db.close());

	it("appends an attempt before its terminal request without a foreign-key dependency", async () => {
		await attempts.append(attempt());
		expect(
			db.prepare("SELECT parent_request_id FROM routing_attempts").get(),
		).toEqual({
			parent_request_id: "request-1",
		});
	});

	it("appends after a terminal request and permits multiple attempts per parent", async () => {
		await requests.save(terminal("request-1", true));
		await attempts.append(attempt({ id: "attempt-1", physicalAttempt: 1 }));
		await attempts.append(attempt({ id: "attempt-2", physicalAttempt: 2 }));
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM routing_attempts").get(),
		).toEqual({ count: 2 });
	});

	it("round trips nullable sanitized upstream evidence", async () => {
		const evidence = JSON.stringify({
			status: 429,
			headers: { "x-should-retry": "true" },
			body_snippet: "rate limit exceeded",
		});
		await attempts.append(
			attempt({ id: "with-evidence", upstreamEvidence: evidence }),
		);
		await attempts.append(
			attempt({ id: "without-evidence", upstreamEvidence: null }),
		);

		expect(
			db
				.prepare(
					"SELECT id, upstream_evidence FROM routing_attempts ORDER BY id ASC",
				)
				.all(),
		).toEqual([
			{ id: "with-evidence", upstream_evidence: evidence },
			{ id: "without-evidence", upstream_evidence: null },
		]);
	});

	it("round trips candidate fallback provenance", async () => {
		await attempts.append(
			attempt({
				id: "with-route-provenance",
				routeFallbackRung: "profile_root_model",
				routeCandidateId: "candidate-root",
			}),
		);

		expect(
			db
				.prepare(
					"SELECT route_fallback_rung, route_candidate_id FROM routing_attempts WHERE id = ?",
				)
				.get("with-route-provenance"),
		).toEqual({
			route_fallback_rung: "profile_root_model",
			route_candidate_id: "candidate-root",
		});
	});

	it("rejects duplicate immutable attempt ids", async () => {
		const data = attempt({ id: "duplicate" });
		await attempts.append(data);
		await expect(attempts.append(data)).rejects.toThrow();
	});

	it("rejects zero physical attempt ordinals while allowing null", async () => {
		await expect(
			attempts.append(attempt({ id: "zero-ordinal", physicalAttempt: 0 })),
		).rejects.toThrow();
		await expect(
			attempts.append(attempt({ id: "null-ordinal", physicalAttempt: null })),
		).resolves.toBeUndefined();
	});

	it("correlates unique attempted parents with recovered, terminal failure, and awaiting terminal states", async () => {
		await requests.save(terminal("recovered", true));
		await requests.save(terminal("failed", false));
		await attempts.append(
			attempt({
				id: "recovered-1",
				parentRequestId: "recovered",
				reason: "model_scoped_429",
				scope: "model",
			}),
		);
		await attempts.append(
			attempt({
				id: "recovered-2",
				parentRequestId: "recovered",
				reason: "out_of_credits",
				scope: "family",
			}),
		);
		await attempts.append(
			attempt({
				id: "failed-1",
				parentRequestId: "failed",
				reason: "upstream_402_payment_required",
				scope: "account",
			}),
		);
		await attempts.append(
			attempt({
				id: "awaiting-1",
				parentRequestId: "awaiting",
				reason: "windowless_429",
				scope: "request",
			}),
		);

		expect(await attempts.getSummary("1h", now)).toEqual({
			firstObservedAt: new Date(now).toISOString(),
			totalAttempts: 4,
			distinctRequests: 3,
			recoveredRequests: 1,
			terminalFailureRequests: 1,
			awaitingTerminalRequests: 1,
			byReasonScope: [
				{
					reason: "model_scoped_429",
					scope: "model",
					attemptCount: 1,
					distinctRequests: 1,
					recoveredRequests: 1,
					terminalFailureRequests: 0,
					awaitingTerminalRequests: 0,
				},
				{
					reason: "out_of_credits",
					scope: "family",
					attemptCount: 1,
					distinctRequests: 1,
					recoveredRequests: 1,
					terminalFailureRequests: 0,
					awaitingTerminalRequests: 0,
				},
				{
					reason: "upstream_402_payment_required",
					scope: "account",
					attemptCount: 1,
					distinctRequests: 1,
					recoveredRequests: 0,
					terminalFailureRequests: 1,
					awaitingTerminalRequests: 0,
				},
				{
					reason: "windowless_429",
					scope: "request",
					attemptCount: 1,
					distinctRequests: 1,
					recoveredRequests: 0,
					terminalFailureRequests: 0,
					awaitingTerminalRequests: 1,
				},
			],
		});
	});

	it("reports the earliest retained attempt even when it predates the summary window", async () => {
		await attempts.append(
			attempt({ id: "older", timestamp: now - 8 * 24 * 60 * 60 * 1000 }),
		);
		await attempts.append(attempt({ id: "current", timestamp: now - 1 }));

		const summary = await attempts.getSummary("24h", now);

		expect(summary.totalAttempts).toBe(1);
		expect(summary.firstObservedAt).toBe(
			new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
		);
	});

	it("returns one empty headline and no groups when no routing attempts have been retained", async () => {
		expect(await attempts.getSummary("24h", now)).toEqual({
			firstObservedAt: null,
			totalAttempts: 0,
			distinctRequests: 0,
			recoveredRequests: 0,
			terminalFailureRequests: 0,
			awaitingTerminalRequests: 0,
			byReasonScope: [],
		});
	});

	it("excludes attempts after the supplied now boundary", async () => {
		await attempts.append(attempt({ id: "current", timestamp: now }));
		await attempts.append(attempt({ id: "future", timestamp: now + 1 }));

		const summary = await attempts.getSummary("24h", now);
		expect(summary.totalAttempts).toBe(1);
		expect(summary.distinctRequests).toBe(1);
		expect(summary.byReasonScope).toHaveLength(1);
		expect(summary.byReasonScope[0]?.attemptCount).toBe(1);
	});

	it("keeps grouped attempt counts internally consistent with the headline", async () => {
		await attempts.append(
			attempt({ id: "model", reason: "model_scoped_429", scope: "model" }),
		);
		await attempts.append(
			attempt({ id: "account", reason: "out_of_credits", scope: "account" }),
		);
		await attempts.append(
			attempt({ id: "request", reason: "windowless_429", scope: "request" }),
		);

		const summary = await attempts.getSummary("24h", now);
		expect(
			summary.byReasonScope.reduce(
				(total, group) => total + group.attemptCount,
				0,
			),
		).toBe(summary.totalAttempts);
	});

	it("classifies a persisted null-success request as awaiting terminal, not a terminal failure", async () => {
		await requests.save(terminal("unknown", false));
		db.run("UPDATE requests SET success = NULL WHERE id = 'unknown'");
		await attempts.append(
			attempt({ id: "unknown-attempt", parentRequestId: "unknown" }),
		);

		expect(await attempts.getSummary("1h", now)).toEqual({
			firstObservedAt: new Date(now).toISOString(),
			totalAttempts: 1,
			distinctRequests: 1,
			recoveredRequests: 0,
			terminalFailureRequests: 0,
			awaitingTerminalRequests: 1,
			byReasonScope: [
				{
					reason: "model_scoped_429",
					scope: "model",
					attemptCount: 1,
					distinctRequests: 1,
					recoveredRequests: 0,
					terminalFailureRequests: 0,
					awaitingTerminalRequests: 1,
				},
			],
		});
	});

	it("bounds retention by timestamp without consulting parent request existence", async () => {
		await attempts.append(
			attempt({
				id: "old",
				parentRequestId: "missing-parent",
				timestamp: now - 10_000,
			}),
		);
		await attempts.append(attempt({ id: "new", timestamp: now - 1_000 }));
		expect(await attempts.deleteOlderThan(now - 5_000)).toBe(1);
		expect(db.prepare("SELECT id FROM routing_attempts").all()).toEqual([
			{ id: "new" },
		]);
	});

	it("does not affect existing terminal request aggregates", async () => {
		await requests.save(terminal("terminal-success", true));
		await requests.save(terminal("terminal-failure", false));
		await attempts.append(attempt({ parentRequestId: "terminal-success" }));
		const aggregate = await requests.aggregateStats(24 * 60 * 60 * 1000);
		expect(aggregate.totalRequests).toBe(2);
		expect(aggregate.successfulRequests).toBe(1);
		expect(aggregate.totalRequests - aggregate.successfulRequests).toBe(1);
	});

	it("uses one adapter query for a snapshot-consistent headline and groups", async () => {
		let queryCount = 0;
		const repo = new RoutingAttemptRepository({
			query: async (sql: string, params: unknown[]) => {
				queryCount++;
				if (queryCount > 1) throw new Error("getSummary issued a second query");
				expect(sql).toContain("windowed_attempts AS");
				expect(sql).toContain("retained_history AS");
				expect(params).toEqual([now - 24 * 60 * 60 * 1000, now]);
				return [
					{
						row_kind: "headline",
						first_observed_at: "1724666400000",
						total_attempts: "4",
						distinct_requests: "3",
						recovered_requests: "1",
						terminal_failure_requests: "1",
						awaiting_terminal_requests: "1",
						reason: null,
						scope: null,
						attempt_count: null,
					},
					{
						row_kind: "group",
						first_observed_at: null,
						total_attempts: null,
						distinct_requests: "3",
						recovered_requests: "1",
						terminal_failure_requests: "1",
						awaiting_terminal_requests: "1",
						reason: "model_scoped_429",
						scope: "model",
						attempt_count: "4",
					},
				];
			},
		} as unknown as BunSqlAdapter);

		expect(await repo.getSummary("24h", now)).toEqual({
			firstObservedAt: "2024-08-26T10:00:00.000Z",
			totalAttempts: 4,
			distinctRequests: 3,
			recoveredRequests: 1,
			terminalFailureRequests: 1,
			awaitingTerminalRequests: 1,
			byReasonScope: [
				{
					reason: "model_scoped_429",
					scope: "model",
					attemptCount: 4,
					distinctRequests: 3,
					recoveredRequests: 1,
					terminalFailureRequests: 1,
					awaitingTerminalRequests: 1,
				},
			],
		});
		expect(queryCount).toBe(1);
	});
});

function requireSafeTestPostgresUrl(rawUrl: string): string {
	const url = new URL(rawUrl);
	const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
		url.hostname,
	);
	if (!isLoopback || !/(?:^|[_-])test(?:$|[_-])/i.test(databaseName)) {
		throw new Error(
			"BETTER_CCFLARE_TEST_POSTGRES_URL must target a loopback-hosted database with 'test' in its name",
		);
	}
	return url.toString();
}

const configuredPostgresUrl = process.env.BETTER_CCFLARE_TEST_POSTGRES_URL;
const postgresUrl = configuredPostgresUrl
	? requireSafeTestPostgresUrl(configuredPostgresUrl)
	: undefined;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres("RoutingAttemptRepository PostgreSQL parity", () => {
	it("returns a one-statement, bounded summary from a disposable database", async () => {
		if (!postgresUrl) throw new Error("PostgreSQL integration URL is required");
		const databaseName = `ccflare_routing_attempt_test_${crypto.randomUUID().replaceAll("-", "")}`;
		const adminSql = new SQL({ url: postgresUrl, max: 1, prepare: false });
		const databaseUrl = new URL(postgresUrl);
		databaseUrl.pathname = `/${databaseName}`;
		let adapter: BunSqlAdapter | undefined;
		let databaseCreated = false;
		try {
			await adminSql.unsafe(`CREATE DATABASE ${databaseName}`);
			databaseCreated = true;
			adapter = new BunSqlAdapter(
				new SQL({ url: databaseUrl.toString(), max: 1, prepare: false }),
				false,
			);
			await ensureSchemaPg(adapter);
			await runMigrationsPg(adapter);
			const repository = new RoutingAttemptRepository(adapter);
			const requestRepository = new RequestRepository(adapter);
			const testNow = 1_725_000_000_000;
			await requestRepository.save(terminal("pg-recovered", true));
			await repository.append(
				attempt({
					id: "pg-retained",
					parentRequestId: "pg-recovered",
					timestamp: testNow - 1,
				}),
			);
			await repository.append(
				attempt({
					id: "pg-future",
					parentRequestId: "pg-future",
					timestamp: testNow + 1,
				}),
			);

			expect(await repository.getSummary("24h", testNow)).toEqual({
				firstObservedAt: new Date(testNow - 1).toISOString(),
				totalAttempts: 1,
				distinctRequests: 1,
				recoveredRequests: 1,
				terminalFailureRequests: 0,
				awaitingTerminalRequests: 0,
				byReasonScope: [
					{
						reason: "model_scoped_429",
						scope: "model",
						attemptCount: 1,
						distinctRequests: 1,
						recoveredRequests: 1,
						terminalFailureRequests: 0,
						awaitingTerminalRequests: 0,
					},
				],
			});
		} finally {
			await adapter?.close();
			if (databaseCreated) {
				await adminSql.unsafe(
					["DROP", "DATABASE IF EXISTS", databaseName, "WITH (FORCE)"].join(
						" ",
					),
				);
			}
			await adminSql.end();
		}
	});
});
