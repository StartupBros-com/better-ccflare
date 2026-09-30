import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import "@better-ccflare/core";
import {
	type RequestRow,
	sanitizeQualityDecision,
	toRequest,
	toRequestResponse,
} from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { runMigrations } from "../../migrations";
import { RequestRepository } from "../request.repository";

const decision = {
	version: 1,
	policyRevision: "quality-policy-v1:synthetic",
	requested: { kind: "main", preference: "auto" },
	selected: {
		accountId: "synthetic-account",
		provider: "codex",
		lane: "astra",
		line: "gpt-astra",
		physicalModel: "gpt-astra-test",
		catalogRevision: "synthetic",
		evidenceRef: "synthetic",
	},
	skippedLanes: [{ lane: "fable", reasons: { "subscription-exhausted": 2 } }],
	accounting: {
		source: "local-envelope-v1",
		kind: "estimate",
		envelopeBytes: 256,
		inputEstimate: 64,
		requestedOutput: 32,
		headroom: 128,
	},
} as const;

test("quality explanation survives repository, late save, and authenticated history mapping", async () => {
	const db = new Database(":memory:");
	try {
		runMigrations(db);
		const repo = new RequestRepository(new BunSqlAdapter(db));
		const data = {
			id: "quality-first",
			method: "POST",
			path: "/v1/messages",
			accountUsed: null,
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTime: 10,
			failoverAttempts: 0,
		};
		await repo.save({ ...data, qualityDecision: decision });
		await repo.save(data);
		const row = db
			.query("SELECT * FROM requests WHERE id = ?")
			.get(data.id) as RequestRow;
		expect(toRequestResponse(toRequest(row)).qualityDecision).toEqual(
			sanitizeQualityDecision(decision),
		);
		expect(row.route_repin_reason).toBeNull();
		await repo.save({
			...data,
			qualityDecision: {
				...decision,
				selected: { ...decision.selected, physicalModel: "wrong-late-model" },
			},
		});
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id = ?")
					.get(data.id) as RequestRow,
			).qualityDecision?.selected?.physicalModel,
		).toBe("gpt-astra-test");
		await repo.save({
			...data,
			id: "terminal",
			success: false,
			statusCode: 503,
			qualityDecision: { ...decision, selected: null },
		});
		const terminal = db
			.query("SELECT * FROM requests WHERE id = 'terminal'")
			.get() as RequestRow;
		expect(toRequest(terminal).qualityDecision?.selected).toBeNull();
		expect(toRequest(terminal).qualityDecision?.skippedLanes).toEqual(
			decision.skippedLanes,
		);
		await repo.save({ ...data, id: "legacy" });
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id = 'legacy'")
					.get() as RequestRow,
			).qualityDecision,
		).toBeNull();
		db.run("UPDATE requests SET quality_decision = ? WHERE id = ?", [
			"{malformed",
			data.id,
		]);
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id = ?")
					.get(data.id) as RequestRow,
			).qualityDecision,
		).toBeNull();
		db.run("ALTER TABLE requests DROP COLUMN quality_decision");
		runMigrations(db);
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id = ?")
					.get(data.id) as RequestRow,
			).qualityDecision,
		).toBeNull();
		await repo.save({ ...data, qualityDecision: decision });
		expect(
			toRequest(
				db
					.query("SELECT * FROM requests WHERE id = ?")
					.get(data.id) as RequestRow,
			).qualityDecision?.selected?.physicalModel,
		).toBe("gpt-astra-test");
	} finally {
		db.close();
	}
});

test("quality sanitizer rejects malformed, oversized, unknown and injected data", () => {
	const clean = sanitizeQualityDecision(JSON.stringify(decision));
	expect(clean).toEqual({
		...decision,
		selected: {
			accountId: "synthetic-account",
			provider: "codex",
			lane: "astra",
			line: "gpt-astra",
			physicalModel: "gpt-astra-test",
		},
	});
	for (const value of [
		undefined,
		"{",
		"x".repeat(8193),
		{ ...decision, version: 2 },
		{ ...decision, secret: "credentials" },
		{ ...decision, requested: { kind: "main", preference: ["auto"] } },
		{ ...decision, requested: { kind: "worker", role: ["standard"] } },
		{ ...decision, selected: { ...decision.selected, provider: ["codex"] } },
		{ ...decision, selected: { ...decision.selected, lane: ["astra"] } },
		{ ...decision, selected: { ...decision.selected, line: ["gpt-astra"] } },
		{
			...decision,
			skippedLanes: [
				{ lane: ["fable"], reasons: { "subscription-exhausted": 1 } },
			],
		},
		{ ...decision, skippedLanes: Array(4).fill(decision.skippedLanes[0]) },
		{
			...decision,
			selected: { ...decision.selected, physicalModel: "secret\nheader" },
		},
		{
			...decision,
			accounting: { ...decision.accounting, inputEstimate: Infinity },
		},
		{
			...decision,
			skippedLanes: [{ lane: "fable", reasons: { "raw-secret": 1 } }],
		},
	]) {
		expect(sanitizeQualityDecision(value)).toBeNull();
	}
});
