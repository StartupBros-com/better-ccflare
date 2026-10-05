/**
 * The collector learns which advisor owner key (the UUID inside an
 * advisor_tool_result's encrypted blob) belongs to which first-party
 * Anthropic account, from upstream responses (streaming and non-streaming).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";

import {
	AsyncDbWriter,
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	getAdvisorResultOwnerKey,
	resetAdvisorResultOwnershipForTests,
} from "../advisor-result-ownership";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const TEST_DB_PATH = "/tmp/test-usage-collector-advisor-owner.db";
const KEY = "54f97ec3-c398-4c6b-b337-942aec61b3de";

function blob(key: string): string {
	const prefix = Buffer.from([
		0x12, 0x40, 0x0a, 0x2a, 0x08, 0x14, 0x18, 0x02, 0x22, 0x24,
	]);
	return Buffer.concat([
		prefix,
		Buffer.from(key, "ascii"),
		Buffer.alloc(40, 7),
	]).toString("base64");
}

const redactedBlock = (key: string) => ({
	type: "advisor_tool_result",
	tool_use_id: "srvtoolu_1",
	content: { type: "advisor_redacted_result", encrypted_content: blob(key) },
});

describe("UsageCollector - advisor owner-key learning", () => {
	let dbOps: DatabaseOperations;
	let asyncWriter: AsyncDbWriter;
	let collector: UsageCollector;
	let seq = 0;

	beforeAll(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		asyncWriter = new AsyncDbWriter();
		collector = new UsageCollector(
			dbOps,
			asyncWriter,
			() => false,
			() => {},
		);
	});

	afterEach(() => {
		resetAdvisorResultOwnershipForTests();
	});

	afterAll(async () => {
		collector.dispose();
		await collector.drain();
		await DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {}
	});

	function makeStart(
		requestId: string,
		accountId: string,
		providerName: string,
		isStream: boolean,
	): StartMessage {
		return {
			type: "start",
			messageId: `msg-${requestId}`,
			requestId,
			accountId,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: 200,
			responseHeaders: {},
			isStream,
			providerName,
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: null,
			accountName: null,
			agentUsed: null,
			comboName: null,
			apiKeyId: null,
			apiKeyName: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
	}

	async function runStream(
		accountId: string,
		providerName: string,
		block: unknown,
	): Promise<void> {
		const requestId = `adv-stream-${++seq}`;
		collector.handleStart(makeStart(requestId, accountId, providerName, true));
		const sse = `event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 1,
			content_block: block,
		})}\n\n`;
		collector.handleChunk(requestId, new TextEncoder().encode(sse));
		await collector.handleEnd({ type: "end", requestId, success: true });
	}

	async function runJson(
		accountId: string,
		providerName: string,
		block: unknown,
	): Promise<void> {
		const requestId = `adv-json-${++seq}`;
		collector.handleStart(makeStart(requestId, accountId, providerName, false));
		const body = JSON.stringify({
			model: "claude-test",
			content: [{ type: "text", text: "hi" }, block],
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		await collector.handleEnd({
			type: "end",
			requestId,
			success: true,
			responseBody: Buffer.from(body).toString("base64"),
		});
	}

	test("streaming advisor_tool_result records the owner key for an anthropic account", async () => {
		await runStream("acct-a", "anthropic", redactedBlock(KEY));
		expect(getAdvisorResultOwnerKey("acct-a")).toBe(KEY);
	});

	test("non-stream advisor_tool_result records the owner key", async () => {
		await runJson("acct-b", "anthropic", redactedBlock(KEY));
		expect(getAdvisorResultOwnerKey("acct-b")).toBe(KEY);
	});

	test("non-anthropic providers never record", async () => {
		await runStream("acct-c", "openai-compatible", redactedBlock(KEY));
		await runJson("acct-d", "openai-compatible", redactedBlock(KEY));
		expect(getAdvisorResultOwnerKey("acct-c")).toBeUndefined();
		expect(getAdvisorResultOwnerKey("acct-d")).toBeUndefined();
	});

	test("advisor_tool_result_error content does not record", async () => {
		const errBlock = {
			type: "advisor_tool_result",
			tool_use_id: "srvtoolu_1",
			content: {
				type: "advisor_tool_result_error",
				error_code: "overloaded",
				encrypted_content: blob(KEY),
			},
		};
		await runStream("acct-e", "anthropic", errBlock);
		await runJson("acct-f", "anthropic", errBlock);
		expect(getAdvisorResultOwnerKey("acct-e")).toBeUndefined();
		expect(getAdvisorResultOwnerKey("acct-f")).toBeUndefined();
	});
});
