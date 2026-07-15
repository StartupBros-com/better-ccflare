/**
 * U5 Product Contract matrix for the Grok Cache Flight Recorder.
 *
 * Fixtures are the merge gate (AE1-AE10). AE11 is an operator-run live canary:
 * set CCFLARE_LIVE_XAI_CANARY=1 with a force-routed official-xAI account and
 * run scripts/cache-flight-recorder-canary.sh against a local non-Anthropic
 * server. Never automate Anthropic or the `claude` account.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	type DiagnosisCause,
	diagnoseTimeline,
	type TurnEvidence,
} from "@better-ccflare/core";
import {
	buildCacheFlightRecorderReport,
	renderCacheFlightRecorderReport,
	runCacheFlightRecorderCommand,
} from "../../../cli-commands/src/commands/cache-flight-recorder";
import { BunSqlAdapter } from "../../../database/src/adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../../database/src/migrations";
import { CacheFlightRecorderRepository } from "../../../database/src/repositories/cache-flight-recorder.repository";

const CONTENT_MARKERS = [
	"raw prompt",
	"system prompt content",
	"tool_payload",
	"reasoning content",
	"response body secret",
	'"messages"',
	"please leak this",
] as const;

function turn(
	sequence: number,
	overrides: Partial<TurnEvidence> = {},
): TurnEvidence {
	return {
		sequence,
		timestamp: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
		identityFingerprint: "identity-a",
		servingAccountId: "account-a",
		prefixFingerprint: "prefix-a",
		cacheOutcome: "hit",
		inputTokens: 100,
		cachedTokens: 80,
		completeness: "complete",
		unavailableDimensions: [],
		...overrides,
	};
}

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

function assertPrivacySafe(serialized: string): void {
	for (const marker of CONTENT_MARKERS) {
		expect(serialized).not.toContain(marker);
	}
	expect(serialized).not.toMatch(/"prompt"\s*:/);
	expect(serialized).not.toMatch(/"request_body"\s*:/);
	expect(serialized).not.toMatch(/"response_body"\s*:/);
	expect(serialized).not.toMatch(/"reasoning"\s*:/);
}

function makeRepo(): {
	db: Database;
	repo: CacheFlightRecorderRepository;
	commandDb: {
		lookupCacheFlightRecorderTimeline: CacheFlightRecorderRepository["lookupTimeline"];
		getCacheFlightRecorderCounts: () => Promise<{
			retained: number;
			dropped: number;
			incomplete: number;
		}>;
	};
} {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON");
	ensureSchema(db);
	runMigrations(db);
	const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
	return {
		db,
		repo,
		commandDb: {
			lookupCacheFlightRecorderTimeline: (id: string) =>
				repo.lookupTimeline(id),
			getCacheFlightRecorderCounts: async () => {
				const [retained, evidence] = await Promise.all([
					repo.countRetained(),
					repo.countDroppedIncomplete(),
				]);
				return { retained, ...evidence };
			},
		},
	};
}

async function withRepo<T>(
	run: (ctx: ReturnType<typeof makeRepo>) => Promise<T>,
): Promise<T> {
	const ctx = makeRepo();
	try {
		return await run(ctx);
	} finally {
		ctx.db.close();
	}
}

async function persistTimeline(
	repo: CacheFlightRecorderRepository,
	recorderConversationId: string,
	turns: TurnEvidence[],
	baseAt = 1_000,
): Promise<void> {
	for (let index = 0; index < turns.length; index++) {
		await repo.appendTurn(
			recorderConversationId,
			turns[index] as TurnEvidence,
			baseAt + index,
		);
	}
}

describe("cache flight recorder product contract matrix", () => {
	describe("AE1-AE7 pure diagnosis matrix", () => {
		const cases: Array<{
			name: string;
			turns: TurnEvidence[];
			cause: DiagnosisCause | null;
			diagnosedSequence?: number | null;
		}> = [
			{
				name: "AE baseline: first eligible turn has no diagnosis",
				turns: [turn(1, { cacheOutcome: "miss", cachedTokens: 0 })],
				cause: null,
				diagnosedSequence: null,
			},
			{
				name: "AE1 hit-only continuity proof",
				turns: [turn(1), turn(2)],
				cause: null,
			},
			{
				name: "AE2 identity_changed",
				turns: [
					turn(1),
					turn(2, {
						identityFingerprint: "identity-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					}),
				],
				cause: "identity_changed",
				diagnosedSequence: 2,
			},
			{
				name: "AE3 serving_account_changed",
				turns: [
					turn(1),
					turn(2, {
						servingAccountId: "account-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					}),
				],
				cause: "serving_account_changed",
				diagnosedSequence: 2,
			},
			{
				name: "AE4 cacheable_prefix_changed",
				turns: [
					turn(1),
					turn(2, {
						prefixFingerprint: "prefix-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					}),
				],
				cause: "cacheable_prefix_changed",
				diagnosedSequence: 2,
			},
			{
				name: "AE5 upstream_miss_despite_stable_lineage",
				turns: [turn(1), turn(2, { cacheOutcome: "miss", cachedTokens: 0 })],
				cause: "upstream_miss_despite_stable_lineage",
				diagnosedSequence: 2,
			},
			{
				name: "AE6 gap => telemetry_unknown",
				turns: [
					turn(1),
					turn(2, {
						cacheOutcome: "miss",
						cachedTokens: 0,
						gapBefore: true,
					}),
				],
				cause: "telemetry_unknown",
				diagnosedSequence: 2,
			},
			{
				name: "AE6 contradictory tokens => telemetry_unknown",
				turns: [turn(1), turn(2, { cacheOutcome: "miss", cachedTokens: 25 })],
				cause: "telemetry_unknown",
				diagnosedSequence: 2,
			},
			{
				name: "AE7 multi-change precedence keeps identity first",
				turns: [
					turn(1),
					turn(2, {
						identityFingerprint: "identity-b",
						servingAccountId: "account-b",
						prefixFingerprint: "prefix-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					}),
				],
				cause: "identity_changed",
				diagnosedSequence: 2,
			},
		];

		for (const fixture of cases) {
			it(fixture.name, () => {
				const report = diagnoseTimeline({
					recorderConversationId: "matrix-recorder-id",
					turns: fixture.turns,
				});
				expect(report.cause).toBe(fixture.cause);
				if (fixture.diagnosedSequence !== undefined) {
					expect(report.diagnosedSequence).toBe(fixture.diagnosedSequence);
				}
				if (fixture.cause === null && fixture.turns.length > 1) {
					expect(
						report.continuityProof.every((item) => item.kind === "stable"),
					).toBe(true);
				}
				if (fixture.name.includes("AE7")) {
					expect(
						report.supportingEvidence
							.filter((item) => item.kind === "changed")
							.map((item) => item.dimension),
					).toEqual(["identity", "serving_account", "cacheable_prefix"]);
				}
			});
		}
	});

	describe("persist → diagnose → CLI report round-trip", () => {
		it("AE1: hit-only timeline renders continuity proof without a miss cause", async () => {
			await withRepo(async ({ repo, commandDb }) => {
				const id = "cfr_hitonly01234567890123456789012";
				await persistTimeline(repo, id, [turn(0), turn(1)]);
				const lookup = await repo.lookupTimeline(id);
				expect(lookup.status).toBe("found");
				if (lookup.status !== "found") return;

				const dto = buildCacheFlightRecorderReport(lookup.timeline);
				expect(dto.diagnosis.cause).toBeNull();
				expect(dto.diagnosis.continuityProof).toHaveLength(3);
				expect(dto.turns.map((item) => item.sequence)).toEqual([0, 1]);
				expect(dto.completeness).toBe("complete");

				const human = capture();
				const json = capture();
				expect(
					(
						await runCacheFlightRecorderCommand(
							commandDb,
							{ action: "report", recorderConversationId: id, json: false },
							{ enabled: true, retentionHours: 72 },
							human.io,
						)
					).exitCode,
				).toBe(0);
				expect(
					(
						await runCacheFlightRecorderCommand(
							commandDb,
							{ action: "report", recorderConversationId: id, json: true },
							{ enabled: true, retentionHours: 72 },
							json.io,
						)
					).exitCode,
				).toBe(0);
				expect(human.stdout[0]).toBe(renderCacheFlightRecorderReport(dto));
				expect(human.stdout[0]).toContain(
					"Diagnosis: no continuity break observed",
				);
				expect(JSON.parse(json.stdout[0] ?? "")).toEqual(dto);
				assertPrivacySafe(human.stdout[0] ?? "");
				assertPrivacySafe(json.stdout[0] ?? "");
			});
		});

		it("AE2-AE5: each supported miss cause survives persistence and CLI report", async () => {
			const scenarios: Array<{
				id: string;
				second: Partial<TurnEvidence>;
				cause: DiagnosisCause;
				label: string;
			}> = [
				{
					id: "cfr_identity0123456789012345678901",
					second: {
						identityFingerprint: "identity-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					},
					cause: "identity_changed",
					label: "identity changed",
				},
				{
					id: "cfr_account01234567890123456789012",
					second: {
						servingAccountId: "account-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					},
					cause: "serving_account_changed",
					label: "serving account changed",
				},
				{
					id: "cfr_prefix012345678901234567890123",
					second: {
						prefixFingerprint: "prefix-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					},
					cause: "cacheable_prefix_changed",
					label: "cacheable prefix changed",
				},
				{
					id: "cfr_upstream0123456789012345678901",
					second: { cacheOutcome: "miss", cachedTokens: 0 },
					cause: "upstream_miss_despite_stable_lineage",
					label: "upstream miss despite stable observed lineage",
				},
			];

			await withRepo(async ({ repo, commandDb }) => {
				for (const scenario of scenarios) {
					await persistTimeline(repo, scenario.id, [
						turn(0),
						turn(1, scenario.second),
					]);
					const lookup = await repo.lookupTimeline(scenario.id);
					expect(lookup.status).toBe("found");
					if (lookup.status !== "found") continue;

					const dto = buildCacheFlightRecorderReport(lookup.timeline);
					expect(dto.diagnosis.cause).toBe(scenario.cause);
					expect(dto.diagnosis.diagnosedSequence).toBe(1);

					const human = capture();
					const result = await runCacheFlightRecorderCommand(
						commandDb,
						{
							action: "report",
							recorderConversationId: scenario.id,
							json: false,
						},
						{ enabled: true, retentionHours: 72 },
						human.io,
					);
					expect(result.exitCode).toBe(0);
					expect(human.stdout[0]).toContain(`Diagnosis: ${scenario.label}`);
					assertPrivacySafe(human.stdout[0] ?? "");
					assertPrivacySafe(JSON.stringify(dto));
				}
			});
		});

		it("AE6: gaps and contradictions surface as telemetry_unknown after round-trip", async () => {
			await withRepo(async ({ repo }) => {
				const gapId = "cfr_gap000012345678901234567890123";
				await persistTimeline(repo, gapId, [
					turn(0),
					turn(1, {
						cacheOutcome: "miss",
						cachedTokens: 0,
						gapBefore: true,
					}),
				]);
				const gapLookup = await repo.lookupTimeline(gapId);
				expect(gapLookup.status).toBe("found");
				if (gapLookup.status === "found") {
					const gapDto = buildCacheFlightRecorderReport(gapLookup.timeline);
					expect(gapDto.diagnosis.cause).toBe("telemetry_unknown");
					expect(gapDto.gaps).toContain("gap_before_turn_1");
					expect(renderCacheFlightRecorderReport(gapDto)).toContain(
						"telemetry unknown",
					);
				}

				const contradictionId = "cfr_contradict0123456789012345678";
				await persistTimeline(repo, contradictionId, [
					turn(0),
					turn(1, { cacheOutcome: "miss", cachedTokens: 25 }),
				]);
				const contradictionLookup = await repo.lookupTimeline(contradictionId);
				expect(contradictionLookup.status).toBe("found");
				if (contradictionLookup.status === "found") {
					const dto = buildCacheFlightRecorderReport(
						contradictionLookup.timeline,
					);
					expect(dto.diagnosis.cause).toBe("telemetry_unknown");
					expect(dto.completeness).toBe("contradictory");
					expect(
						dto.diagnosis.supportingTransitions.some(
							(item) => item.kind === "contradiction",
						),
					).toBe(true);
				}
			});
		});

		it("AE7: multi-change supporting transitions remain ordered after CLI render", async () => {
			await withRepo(async ({ repo }) => {
				const id = "cfr_multichange0123456789012345678";
				await persistTimeline(repo, id, [
					turn(0),
					turn(1, {
						identityFingerprint: "identity-b",
						servingAccountId: "account-b",
						prefixFingerprint: "prefix-b",
						cacheOutcome: "miss",
						cachedTokens: 0,
					}),
				]);
				const lookup = await repo.lookupTimeline(id);
				expect(lookup.status).toBe("found");
				if (lookup.status !== "found") return;
				const dto = buildCacheFlightRecorderReport(lookup.timeline);
				expect(dto.diagnosis.cause).toBe("identity_changed");
				expect(
					dto.diagnosis.supportingTransitions
						.filter((item) => item.kind === "changed")
						.map((item) => item.dimension),
				).toEqual(["identity", "serving_account", "cacheable_prefix"]);
				const rendered = renderCacheFlightRecorderReport(dto);
				expect(rendered).toContain("identity changed");
				expect(rendered).toContain("dimension=serving_account");
				expect(rendered).toContain("dimension=cacheable_prefix");
			});
		});

		it("AE8: recorder-only partial evidence stays partial and unknown", async () => {
			await withRepo(async ({ repo }) => {
				const id = "cfr_partial0123456789012345678901";
				await persistTimeline(repo, id, [
					turn(0, {
						identityFingerprint: undefined,
						prefixFingerprint: undefined,
						completeness: "partial",
						unavailableDimensions: ["identity", "cacheable_prefix"],
						cacheOutcome: "hit",
						cachedTokens: 12,
						inputTokens: 32,
					}),
					turn(1, {
						identityFingerprint: undefined,
						prefixFingerprint: undefined,
						completeness: "partial",
						unavailableDimensions: ["identity", "cacheable_prefix"],
						cacheOutcome: "miss",
						cachedTokens: 0,
						inputTokens: 40,
					}),
				]);
				const lookup = await repo.lookupTimeline(id);
				expect(lookup.status).toBe("found");
				if (lookup.status !== "found") return;
				const dto = buildCacheFlightRecorderReport(lookup.timeline);
				expect(dto.diagnosis.cause).toBe("telemetry_unknown");
				expect(dto.unavailableDimensions).toEqual(
					expect.arrayContaining(["identity", "cacheable_prefix"]),
				);
				expect(
					dto.completeness === "partial" || dto.completeness === "incomplete",
				).toBe(true);
				expect(
					dto.turns.every((item) => item.identityFingerprint === undefined),
				).toBe(true);
				const rendered = renderCacheFlightRecorderReport(dto);
				expect(rendered).toContain("unavailable=identity|cacheable_prefix");
				assertPrivacySafe(rendered);
			});
		});

		it("AE9: persistence failure markers keep health degraded without inventing content", async () => {
			await withRepo(async ({ repo, commandDb }) => {
				const id = "cfr_failure0123456789012345678901";
				await persistTimeline(repo, id, [turn(0)]);
				await repo.markIncomplete(id, {
					dropped: true,
					at: 5_000,
				});

				const lookup = await repo.lookupTimeline(id);
				expect(lookup.status).toBe("found");
				if (lookup.status === "found") {
					expect(lookup.timeline.incomplete).toBe(true);
					expect(lookup.timeline.droppedEvents).toBe(1);
					const dto = buildCacheFlightRecorderReport(lookup.timeline);
					expect(dto.droppedEvidence).toBe(1);
					expect(dto.completeness).toBe("incomplete");
					assertPrivacySafe(renderCacheFlightRecorderReport(dto));
				}

				const health = capture();
				const result = await runCacheFlightRecorderCommand(
					commandDb,
					{ action: "health", json: true },
					{ enabled: true, retentionHours: 72 },
					health.io,
				);
				expect(result.exitCode).toBe(0);
				const payload = JSON.parse(health.stdout[0] ?? "{}") as {
					droppedCount: number;
					incompleteCount: number;
					persistenceHealth: string;
				};
				expect(payload.droppedCount).toBe(1);
				expect(payload.incompleteCount).toBe(1);
				expect(payload.persistenceHealth).toBe("unhealthy");
				assertPrivacySafe(health.stdout[0] ?? "");
			});
		});

		it("AE10: expiry tombstones are distinct from not_found and strip retained turns", async () => {
			await withRepo(async ({ repo, commandDb }) => {
				const expiredId = "cfr_expired0123456789012345678901";
				const liveId = "cfr_live0000123456789012345678901";
				await persistTimeline(repo, expiredId, [turn(0)], 1_000);
				await persistTimeline(repo, liveId, [turn(0)], 5_000);

				expect(await repo.expireOlderThan(3_000, 7_000)).toBe(1);

				const expiredLookup = await repo.lookupTimeline(expiredId);
				const missingLookup = await repo.lookupTimeline(
					"cfr_neverseen012345678901234567",
				);
				const liveLookup = await repo.lookupTimeline(liveId);
				expect(expiredLookup).toEqual({ status: "expired" });
				expect(missingLookup).toEqual({ status: "not_found" });
				expect(liveLookup.status).toBe("found");

				const expiredHuman = capture();
				const expiredResult = await runCacheFlightRecorderCommand(
					commandDb,
					{
						action: "report",
						recorderConversationId: expiredId,
						json: true,
					},
					{ enabled: true, retentionHours: 72 },
					expiredHuman.io,
				);
				expect(expiredResult.exitCode).toBe(2);
				expect(expiredHuman.stderr[0]).toContain("expired");
				expect(JSON.parse(expiredHuman.stdout[0] ?? "")).toMatchObject({
					kind: "error",
					status: "expired",
				});

				const health = capture();
				await runCacheFlightRecorderCommand(
					commandDb,
					{ action: "health", json: true },
					{ enabled: true, retentionHours: 72 },
					health.io,
				);
				const healthPayload = JSON.parse(health.stdout[0] ?? "{}") as {
					retainedCount: number;
					retentionHours: number;
				};
				expect(healthPayload.retainedCount).toBe(1);
				expect(healthPayload.retentionHours).toBe(72);
			});
		});

		it("privacy: repository and CLI never retain or print content-bearing fields", async () => {
			await withRepo(async ({ repo }) => {
				const id = "cfr_privacy0123456789012345678901";
				const safeTurn = turn(0);
				await repo.appendTurn(id, safeTurn, 1_000);

				await expect(
					repo.appendTurn(
						id,
						{
							...turn(1),
							// Force a content-bearing field through the type boundary.
							prompt: "raw prompt please leak this",
						} as TurnEvidence & { prompt: string },
						2_000,
					),
				).rejects.toThrow(/unsupported fields/);

				const lookup = await repo.lookupTimeline(id);
				expect(lookup.status).toBe("found");
				if (lookup.status !== "found") return;
				const dto = buildCacheFlightRecorderReport(lookup.timeline);
				const human = renderCacheFlightRecorderReport(dto);
				const json = JSON.stringify(dto);
				assertPrivacySafe(human);
				assertPrivacySafe(json);
				assertPrivacySafe(JSON.stringify(lookup.timeline));
			});
		});
	});

	describe("AE11 live official-xAI canary recipe", () => {
		const liveEnabled = process.env.CCFLARE_LIVE_XAI_CANARY === "1";
		const accountId = process.env.CCFLARE_LIVE_XAI_ACCOUNT_ID;
		const baseUrl =
			process.env.CCFLARE_LIVE_XAI_BASE_URL ?? "http://127.0.0.1:8081";

		it("documents the operator-run canary and skips without credentials", () => {
			// Operator recipe (never Anthropic / never the claude account):
			// 1. Start better-ccflare with:
			//      CCFLARE_CACHE_FLIGHT_RECORDER=1
			//      CCFLARE_XAI_CACHE_NATIVE=1
			// 2. Confirm an official-xAI account id (not claude/Anthropic).
			// 3. Run scripts/cache-flight-recorder-canary.sh with:
			//      CCFLARE_LIVE_XAI_CANARY=1
			//      CCFLARE_LIVE_XAI_ACCOUNT_ID=<official-xai-account-id>
			//      CCFLARE_LIVE_XAI_BASE_URL=http://127.0.0.1:8081
			// 4. Force-route multi-turn Grok traffic via x-better-ccflare-account-id.
			// 5. Capture x-better-ccflare-cache-flight-recorder-id from the response.
			// 6. bun run cli -- --cache-flight-recorder-report <id> [--json]
			// Fixtures above remain the merge gate when this path is skipped.
			if (!liveEnabled || !accountId) {
				expect(Boolean(liveEnabled && accountId)).toBe(false);
				return;
			}
			expect(accountId.length).toBeGreaterThan(0);
			expect(baseUrl.startsWith("http")).toBe(true);
		});

		it("optional live canary: multi-turn official xAI timeline is privacy-safe", async () => {
			if (!liveEnabled || !accountId) {
				return;
			}

			const sessionId = "11111111-1111-4111-8111-111111111111";
			const system = "cache flight recorder live canary system seed";
			const firstUser = "cache flight recorder live canary turn one";
			const secondUser = "cache flight recorder live canary turn two";
			const auth = process.env.CCFLARE_LIVE_XAI_AUTH_TOKEN ?? "test";

			async function postTurn(
				messages: Array<{ role: string; content: string }>,
			) {
				const response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${auth}`,
						"x-better-ccflare-account-id": accountId,
					},
					body: JSON.stringify({
						model: "grok-4",
						max_tokens: 16,
						system,
						metadata: {
							user_id: JSON.stringify({ session_id: sessionId }),
						},
						messages,
					}),
				});
				const recorderId = response.headers.get(
					"x-better-ccflare-cache-flight-recorder-id",
				);
				const bodyText = await response.text();
				return { response, recorderId, bodyText };
			}

			const first = await postTurn([{ role: "user", content: firstUser }]);
			expect(first.response.ok).toBe(true);
			expect(first.recorderId).toMatch(/^cfr_[0-9a-f]{32}$/);
			expect(first.recorderId).not.toContain(sessionId);
			assertPrivacySafe(first.bodyText);

			const second = await postTurn([
				{ role: "user", content: firstUser },
				{ role: "assistant", content: "ack" },
				{ role: "user", content: secondUser },
			]);
			expect(second.response.ok).toBe(true);
			expect(second.recorderId).toBe(first.recorderId);

			// Live canary only proves persistence + privacy-safe rendering when the
			// operator also has CLI access to the same DB. When the matrix runs
			// against a remote process DB we stop after response-header stability.
			const localDbPath = process.env.CCFLARE_LIVE_XAI_DB_PATH;
			if (!localDbPath) {
				return;
			}

			const db = new Database(localDbPath, { readonly: true });
			try {
				const repo = new CacheFlightRecorderRepository(new BunSqlAdapter(db));
				const lookup = await repo.lookupTimeline(first.recorderId as string);
				expect(lookup.status).toBe("found");
				if (lookup.status !== "found") return;
				expect(lookup.timeline.turns.length).toBeGreaterThanOrEqual(2);
				const dto = buildCacheFlightRecorderReport(lookup.timeline);
				const human = renderCacheFlightRecorderReport(dto);
				const json = JSON.stringify(dto);
				assertPrivacySafe(human);
				assertPrivacySafe(json);
				assertPrivacySafe(JSON.stringify(lookup.timeline));
				expect(human).not.toContain(firstUser);
				expect(human).not.toContain(secondUser);
				expect(human).not.toContain(system);
				expect(human).not.toContain(sessionId);
			} finally {
				db.close();
			}
		});
	});
});
