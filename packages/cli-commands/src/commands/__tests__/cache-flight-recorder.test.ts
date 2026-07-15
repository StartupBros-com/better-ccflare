import { describe, expect, it } from "bun:test";
import type { CacheFlightRecorderTimeline } from "@better-ccflare/database";
import {
	buildCacheFlightRecorderReport,
	renderCacheFlightRecorderReport,
	runCacheFlightRecorderCommand,
} from "../cache-flight-recorder";

const baselineTurn = {
	sequence: 0,
	timestamp: "2026-07-15T00:00:00.000Z",
	identityFingerprint: "identity-a",
	servingAccountId: "account-a",
	prefixFingerprint: "prefix-a",
	cacheOutcome: "hit" as const,
	inputTokens: 100,
	cachedTokens: 80,
	completeness: "complete" as const,
	unavailableDimensions: [],
};
const hitTurn = {
	...baselineTurn,
	sequence: 1,
	timestamp: "2026-07-15T00:01:00.000Z",
	inputTokens: 120,
	cachedTokens: 100,
};
const hitTimeline: CacheFlightRecorderTimeline = {
	recorderConversationId: "recorder-safe-id",
	createdAt: 1_000,
	updatedAt: 2_000,
	incomplete: false,
	droppedEvents: 0,
	turns: [baselineTurn, hitTurn],
};

function capture() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		io: {
			stdout: (value: string) => stdout.push(value),
			stderr: (value: string) => stderr.push(value),
		},
	};
}

function db(overrides: Record<string, unknown> = {}) {
	return {
		lookupCacheFlightRecorderTimeline: async () => ({
			status: "found" as const,
			timeline: hitTimeline,
		}),
		getCacheFlightRecorderCounts: async () => ({
			retained: 1,
			dropped: 0,
			incomplete: 0,
		}),
		...overrides,
	};
}

describe("cache flight recorder report", () => {
	it("drives human and JSON command output from one canonical hit-only DTO", async () => {
		const dto = buildCacheFlightRecorderReport(hitTimeline);
		const human = capture();
		const json = capture();
		const command = {
			action: "report" as const,
			recorderConversationId: "recorder-safe-id",
		};

		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{ ...command, json: false },
					{ enabled: true, retentionHours: 72 },
					human.io,
				)
			).exitCode,
		).toBe(0);
		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{ ...command, json: true },
					{ enabled: true, retentionHours: 72 },
					json.io,
				)
			).exitCode,
		).toBe(0);

		expect(dto.diagnosis.cause).toBeNull();
		expect(dto.diagnosis.continuityProof).toHaveLength(3);
		expect(dto.baseline?.sequence).toBe(0);
		expect(dto.turns.map((turn) => turn.sequence)).toEqual([0, 1]);
		expect(dto.turns[1]?.tokens).toEqual({ input: 120, cached: 100 });
		expect(human.stdout).toEqual([renderCacheFlightRecorderReport(dto)]);
		expect(human.stdout[0]).toContain(
			"Diagnosis: no continuity break observed",
		);
		expect(human.stdout[0]).toContain("Completeness: complete");
		expect(JSON.parse(json.stdout.at(0) ?? "")).toEqual(dto);
		expect(human.stderr).toEqual(json.stderr);
	});

	it("reports a miss cause and ordered supporting transitions", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				...hitTimeline.turns,
				{
					...hitTurn,
					sequence: 2,
					identityFingerprint: "identity-b",
					cacheOutcome: "miss",
					cachedTokens: 0,
				},
			],
		});

		expect(dto.diagnosis.cause).toBe("identity_changed");
		expect(dto.diagnosis.supportingTransitions[0]).toMatchObject({
			dimension: "identity",
			fromSequence: 1,
			toSequence: 2,
		});
		expect(renderCacheFlightRecorderReport(dto)).toContain(
			"Diagnosis: identity changed",
		);
	});

	it("keeps incomplete timelines reportable with explicit gaps", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			incomplete: true,
			droppedEvents: 1,
			turns: [
				baselineTurn,
				{
					...hitTurn,
					sequence: 2,
					gapBefore: true,
					cacheOutcome: "unknown",
					cachedTokens: undefined,
					completeness: "incomplete",
					unavailableDimensions: ["cache_outcome"],
				},
			],
		});

		expect(dto.completeness).toBe("incomplete");
		expect(dto.diagnosis.cause).toBe("telemetry_unknown");
		expect(dto.gaps).toEqual(["gap_before_turn_2", "missing_turns_1_to_1"]);
		expect(dto.unavailableDimensions).toEqual(["cache_outcome"]);
		expect(renderCacheFlightRecorderReport(dto)).toContain(
			"Dropped evidence: 1",
		);
	});

	it("does not downgrade known timeline loss to partial", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			incomplete: true,
			turns: [
				baselineTurn,
				{
					...hitTurn,
					completeness: "partial",
					unavailableDimensions: ["token_accounting"],
				},
			],
		});

		expect(dto.completeness).toBe("incomplete");
	});

	it("renders all privacy-safe diagnosis and turn evidence", () => {
		const dto = buildCacheFlightRecorderReport({
			...hitTimeline,
			turns: [
				baselineTurn,
				{
					...hitTurn,
					identityFingerprint: "identity-b",
					prefixFingerprint: "prefix-b",
					cacheOutcome: "miss",
					completeness: "partial",
					unavailableDimensions: ["token_accounting"],
					gapBefore: true,
				},
			],
		});
		const human = renderCacheFlightRecorderReport(dto);

		expect(human).toContain("Diagnosed sequence: 1");
		expect(human).toContain(
			"kind=changed dimension=identity fromSequence=0 toSequence=1 fromValue=identity-a toValue=identity-b detail=identity_changed",
		);
		expect(human).toContain("identity=identity-b");
		expect(human).toContain("prefix=prefix-b");
		expect(human).toContain("completeness=partial");
		expect(human).toContain("unavailable=token_accounting");
		expect(human).toContain("gapBefore=true");
	});

	it("never includes raw content, rows, or errors", () => {
		const serialized = JSON.stringify(
			buildCacheFlightRecorderReport(hitTimeline),
		);
		for (const forbidden of [
			"prompt",
			"request_body",
			"response_body",
			"rawRow",
			"error",
			"private prompt content",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});
});

describe("cache flight recorder command", () => {
	it("writes exactly one JSON object to stdout", async () => {
		const output = capture();
		const result = await runCacheFlightRecorderCommand(
			db(),
			{
				action: "report",
				recorderConversationId: "recorder-safe-id",
				json: true,
			},
			{ enabled: true, retentionHours: 72 },
			output.io,
		);
		expect(result.exitCode).toBe(0);
		expect(output.stdout).toHaveLength(1);
		expect(JSON.parse(output.stdout.at(0) ?? "")).toMatchObject({
			kind: "report",
			recorderConversationId: "recorder-safe-id",
		});
		expect(output.stderr).toEqual([]);
	});

	it.each([
		["expired", "expired"],
		["not_found", "not found"],
	] as const)("distinguishes %s lookup", async (status, diagnostic) => {
		const output = capture();
		const result = await runCacheFlightRecorderCommand(
			db({ lookupCacheFlightRecorderTimeline: async () => ({ status }) }),
			{
				action: "report",
				recorderConversationId: "recorder-safe-id",
				json: true,
			},
			{ enabled: true, retentionHours: 72 },
			output.io,
		);
		expect(result.exitCode).toBe(2);
		expect(output.stdout).toHaveLength(1);
		expect(JSON.parse(output.stdout.at(0) ?? "")).toEqual({
			kind: "error",
			status,
			recorderConversationId: "recorder-safe-id",
		});
		expect(output.stderr.join("\n")).toContain(diagnostic);
	});

	it.each([
		[{ retained: 4, dropped: 0, incomplete: 0 }, "healthy"],
		[{ retained: 4, dropped: 0, incomplete: 1 }, "degraded"],
		[{ retained: 4, dropped: 2, incomplete: 0 }, "unhealthy"],
	] as const)("reports truthful minimal health for %j", async (counts, persistenceHealth) => {
		const output = capture();
		const result = await runCacheFlightRecorderCommand(
			db({ getCacheFlightRecorderCounts: async () => counts }),
			{ action: "health", json: true },
			{ enabled: true, retentionHours: 72 },
			output.io,
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(output.stdout.at(0) ?? "")).toEqual({
			kind: "health",
			enabled: true,
			retentionHours: 72,
			retainedCount: counts.retained,
			droppedCount: counts.dropped,
			incompleteCount: counts.incomplete,
			persistenceHealth,
		});
		expect(output.stdout[0]).not.toContain("causeRate");
	});

	it("uses explicit nonzero exits for invalid args and DB failures", async () => {
		const invalid = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					db(),
					{
						action: "report",
						recorderConversationId: "not safe!",
						json: false,
					},
					{ enabled: true, retentionHours: 72 },
					invalid.io,
				)
			).exitCode,
		).toBe(2);
		expect(invalid.stderr.join("\n")).toContain("Invalid recorder ID");

		const failed = capture();
		expect(
			(
				await runCacheFlightRecorderCommand(
					db({
						lookupCacheFlightRecorderTimeline: async () => {
							throw new Error("database contains private details");
						},
					}),
					{
						action: "report",
						recorderConversationId: "recorder-safe-id",
						json: true,
					},
					{ enabled: true, retentionHours: 72 },
					failed.io,
				)
			).exitCode,
		).toBe(1);
		expect(failed.stdout).toEqual([
			JSON.stringify({ kind: "error", status: "operational_failure" }),
		]);
		expect(failed.stderr).toEqual(["Cache flight recorder operation failed"]);
	});
});
