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
	afterEach(() => {
		db.close();
		rmSync(directory, { recursive: true });
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
