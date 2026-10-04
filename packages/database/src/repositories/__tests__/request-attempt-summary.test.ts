import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import "@better-ccflare/core";
import {
	type RequestRoutingAttemptSummary,
	type RequestRow,
	toRequest,
	toRequestResponse,
} from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { ensureSchemaPg, runMigrationsPg } from "../../migrations-pg";
import { RequestRepository } from "../request.repository";

const summary: RequestRoutingAttemptSummary = {
	version: 1,
	decision: {
		version: 1,
		requestedLogicalModel: "test-logical",
		operation: "messages",
		origin: "unknown",
		reason: "route_unavailable",
		evidence: "inferred",
		inventory: "complete",
		constraints: {
			forcedRoute: false,
			capabilityProfile: false,
			routeProfile: false,
			profileId: null,
			provider: null,
			physicalModel: null,
		},
		selection: null,
		stages: [],
	},
	decisionGap: null,
	physicalAttemptCount: 2,
	routeCount: 1,
	truncated: false,
	completeness: "complete",
	outputOriginOrdinal: null,
	winnerOrdinal: null,
	nativeStatus: 503,
	wireStatus: 200,
	terminalCause: "meaningful_progress_timeout",
	cancellationOrigin: null,
	attempts: [1, 2].map((ordinal) => ({
		ordinal,
		accountId: "test-account",
		provider: "codex",
		logicalModel: "test-logical",
		physicalModel: "test-physical",
		outcome: "failed",
		cause: "meaningful_progress_timeout",
		startedAt: null,
		outcomeObservedAt: null,
		nativeStatus: 200,
		protocolFrames: 79,
		meaningfulProgress: "absent",
		terminalEvidenceSeen: false,
	})),
};
const base = {
	id: "attempt-terminal",
	method: "POST",
	path: "/v1/messages",
	accountUsed: null,
	statusCode: 503,
	success: false,
	errorMessage: "meaningful_progress_timeout",
	responseTime: 100,
	failoverAttempts: 0,
};

test("first terminal attribution survives late usage/save and reads through history", async () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);
		const repo = new RequestRepository(new BunSqlAdapter(db));
		await repo.save({
			...base,
			routingAttemptSummary: summary,
			streamTerminalState: "truncated",
		});
		await repo.updateUsage(base.id, {
			model: "late-usage-model",
			inputTokens: 12,
			outputTokens: 3,
		});
		await repo.save({
			...base,
			statusCode: 200,
			streamTerminalState: "complete",
			success: true,
			errorMessage: null,
			failoverAttempts: 99,
			routingAttemptSummary: {
				...summary,
				terminalCause: null,
				winnerOrdinal: 2,
			},
		});
		const row = db
			.query("SELECT * FROM requests WHERE id = ?")
			.get(base.id) as RequestRow;
		expect(row.status_code).toBe(503);
		expect(row.stream_terminal_state).toBe("truncated");
		expect(row.success).toBe(0);
		expect(row.error_message).toBe("meaningful_progress_timeout");
		expect(row.failover_attempts).toBe(0);
		expect(toRequestResponse(toRequest(row)).routingAttemptSummary).toEqual(
			summary,
		);
		await repo.save({ ...base, id: "legacy" });
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id='legacy'")
					.get() as RequestRow,
			).routingAttemptSummary,
		).toBeNull();
		db.run(
			"UPDATE requests SET routing_attempt_summary = '{broken' WHERE id = ?",
			[base.id],
		);
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id=?")
					.get(base.id) as RequestRow,
			).routingAttemptSummary,
		).toBeNull();
	} finally {
		db.close();
	}
});

test("additive migration upgrades old requests table and remains idempotent", async () => {
	const db = new Database(":memory:");
	try {
		ensureSchema(db);
		runMigrations(db);
		db.run("ALTER TABLE requests DROP COLUMN routing_attempt_summary");
		runMigrations(db);
		runMigrations(db);
		await new RequestRepository(new BunSqlAdapter(db)).save({
			...base,
			routingAttemptSummary: summary,
		});
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id=?")
					.get(base.id) as RequestRow,
			).routingAttemptSummary,
		).toEqual(summary);
	} finally {
		db.close();
	}
});

test("PostgreSQL fresh/upgrade schema and adapter writes preserve the bounded first terminal", async () => {
	let freshColumn = false;
	let upgradeColumn = false;
	let mode: "fresh" | "upgrade" | "write" = "fresh";
	let lastWrite: { sql: string; params: unknown[] } | null = null;
	const adapter = {
		get: async (_sql: string, params?: unknown[]) => ({
			exists:
				params?.[0] === "requests" && params?.[1] === "routing_attempt_summary"
					? 0
					: 1,
		}),
		unsafe: async (sql: string) => {
			if (mode === "fresh" && /routing_attempt_summary\s+TEXT/.test(sql))
				freshColumn = true;
			if (
				mode === "upgrade" &&
				/ADD COLUMN.*routing_attempt_summary.*TEXT/s.test(sql)
			)
				upgradeColumn = true;
			return [];
		},
		run: async (sql: string, params: unknown[]) => {
			if (mode === "write") lastWrite = { sql, params };
		},
	} as unknown as BunSqlAdapter;
	await ensureSchemaPg(adapter);
	mode = "upgrade";
	await runMigrationsPg(adapter);
	expect(freshColumn).toBe(true);
	expect(upgradeColumn).toBe(true);
	mode = "write";
	await new RequestRepository(adapter).save({
		...base,
		routingAttemptSummary: summary,
	});
	const write = lastWrite as unknown as { sql: string; params: unknown[] };
	// Bind by column position, not "last param": later columns follow it.
	const insertColumns = (
		write.sql.match(/INSERT INTO requests \(([^)]*)\)/)?.[1] ?? ""
	)
		.split(",")
		.map((column) => column.trim());
	const summaryIndex = insertColumns.indexOf("routing_attempt_summary");
	expect(summaryIndex).toBeGreaterThanOrEqual(0);
	expect(insertColumns).toHaveLength(write.params.length);
	expect(JSON.parse(write.params[summaryIndex] as string)).toEqual(summary);
	expect(write.sql).toContain(
		"routing_attempt_summary = COALESCE(requests.routing_attempt_summary, EXCLUDED.routing_attempt_summary)",
	);
	for (const field of [
		"status_code",
		"account_used",
		"success",
		"error_message",
		"failover_attempts",
		"stream_terminal_state",
	])
		expect(write.sql).toContain(
			`${field} = CASE WHEN requests.routing_attempt_summary IS NOT NULL THEN requests.${field}`,
		);
});
