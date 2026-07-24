/**
 * End-to-end tests for the comboModelOverride field on the live summary
 * event / RequestResponse (packages/proxy/src/usage-collector.ts building
 * `summary` from a StartMessage's comboModelOverrideFrom/To).
 *
 * Mirrors the pattern in usage-collector-attribution-tristate.test.ts: drive
 * the REAL UsageCollector (temp SQLite DB) through a full start->end cycle
 * and assert on the emitted RequestResponse summary, so this exercises the
 * actual gating logic (resolveComboModelOverride) rather than a re-derived
 * copy of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { UsageCollector } from "../usage-collector";
import type { EndMessage, StartMessage } from "../worker-messages";

const TEST_DB_PATH = "/tmp/test-usage-collector-combo-model-override.db";

describe("UsageCollector - comboModelOverride summary field (real collector, end-to-end)", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;
	let summaries: Map<string, RequestResponse>;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		asyncWriter = new AsyncDbWriter();
		summaries = new Map();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => false,
			(summary) => {
				summaries.set(summary.id, summary);
			},
		);
	});

	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
	});

	function makeStart(
		overrides: Partial<StartMessage> & { requestId: string },
	): StartMessage {
		return {
			type: "start",
			messageId: `msg-${overrides.requestId}`,
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream: false,
			providerName: "anthropic",
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			originalModel: null,
			appliedModel: null,
			comboName: null,
			comboModelOverrideFrom: null,
			comboModelOverrideTo: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
			...overrides,
		};
	}

	async function runRequestAndGetSummary(
		start: StartMessage,
	): Promise<RequestResponse> {
		collector.handleStart(start);
		const endMsg: EndMessage = {
			type: "end",
			requestId: start.requestId,
			success: true,
		};
		await collector.handleEnd(endMsg);
		const summary = summaries.get(start.requestId);
		if (!summary) {
			throw new Error(
				`onSummary was not invoked for requestId=${start.requestId} — request may have been silently skipped`,
			);
		}
		return summary;
	}

	test("present with correct from/to when a combo override applied on the successful attempt", async () => {
		const start = makeStart({
			requestId: "combo-override-1-present",
			comboName: "priority-combo",
			originalModel: "claude-opus-4-5",
			appliedModel: "claude-haiku-4-5",
			comboModelOverrideFrom: "claude-opus-4-5",
			comboModelOverrideTo: "claude-haiku-4-5",
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.comboModelOverride).toEqual({
			from: "claude-opus-4-5",
			to: "claude-haiku-4-5",
		});
	});

	test("null when no combo override applied at all", async () => {
		const start = makeStart({
			requestId: "combo-override-2-null-no-combo",
			comboModelOverrideFrom: null,
			comboModelOverrideTo: null,
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.comboModelOverride ?? null).toBeNull();
	});

	test("null when the combo override resolved to the same model (no real change)", async () => {
		const start = makeStart({
			requestId: "combo-override-3-null-no-change",
			comboName: "same-model-combo",
			comboModelOverrideFrom: "claude-opus-4-5",
			comboModelOverrideTo: "claude-opus-4-5",
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.comboModelOverride ?? null).toBeNull();
	});

	test("null when only one side of the pair is present (defensive re-gate)", async () => {
		const start = makeStart({
			requestId: "combo-override-4-null-one-sided",
			comboModelOverrideFrom: "claude-opus-4-5",
			comboModelOverrideTo: null,
		});

		const summary = await runRequestAndGetSummary(start);

		expect(summary.comboModelOverride ?? null).toBeNull();
	});
});
