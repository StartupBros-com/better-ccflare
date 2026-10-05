/**
 * Successful Fable-family responses store the forwarded
 * anthropic-ratelimit-unified-* headers on the request row, bounded.
 */
import { expect, test } from "bun:test";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const PREFIX = "anthropic-ratelimit-unified-";

async function capture(
	model: string,
	status: number,
	headers: Record<string, string>,
): Promise<string | null> {
	const ambientUrl = process.env.DATABASE_URL;
	let db: DatabaseOperations;
	try {
		delete process.env.DATABASE_URL;
		db = new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
	const collector = new UsageCollector(
		db,
		new AsyncDbWriter(),
		() => false,
		() => {},
	);
	try {
		const start: StartMessage = {
			type: "start",
			messageId: "m1",
			requestId: "r1",
			accountId: null,
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			requestHeaders: {},
			requestBody: null,
			project: null,
			responseStatus: status,
			responseHeaders: headers,
			isStream: false,
			providerName: "anthropic",
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
		collector.handleStart(start);
		const body = JSON.stringify({
			model,
			content: [{ type: "text", text: "hi" }],
			usage: { input_tokens: 1, output_tokens: 1 },
		});
		await collector.handleEnd({
			type: "end",
			requestId: "r1",
			success: status < 300,
			responseBody: Buffer.from(body).toString("base64"),
		});
		await collector.drain();
		const row = (await db
			.getAdapter()
			.get(
				"SELECT unified_ratelimit_headers FROM requests WHERE id = 'r1'",
			)) as {
			unified_ratelimit_headers: string | null;
		} | null;
		return row?.unified_ratelimit_headers ?? null;
	} finally {
		collector.dispose();
		await db.close();
	}
}

function unified(
	count: number,
	valueLength = 8,
	nameSuffix = "",
): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		out[`${PREFIX}h${String(i).padStart(2, "0")}${nameSuffix}`] = "v".repeat(
			valueLength,
		);
	}
	return out;
}

test("Fable 200 with twelve unified headers stores exactly those twelve", async () => {
	const stored = await capture("claude-fable-5", 200, {
		...unified(12),
		"content-type": "application/json",
		"retry-after": "5",
	});
	const parsed = JSON.parse(stored as string);
	expect(Object.keys(parsed)).toHaveLength(12);
	expect(Object.keys(parsed).every((k) => k.startsWith(PREFIX))).toBe(true);
	expect(parsed.truncated).toBeUndefined();
});

test("Fable 200 with forty unified headers keeps the first thirty-two and marks truncation", async () => {
	const stored = await capture("claude-fable-5", 200, unified(40));
	const parsed = JSON.parse(stored as string);
	const names = Object.keys(parsed).filter((k) => k.startsWith(PREFIX));
	expect(names).toEqual(Object.keys(unified(32)));
	expect(parsed.truncated).toBe(true);
});

test("Fable 200 with twenty over-long values stops at the 4096-char bound", async () => {
	const stored = await capture(
		"claude-fable-5",
		200,
		unified(20, 200, "-".repeat(60)),
	);
	expect((stored as string).length).toBeLessThanOrEqual(4096);
	const parsed = JSON.parse(stored as string);
	const names = Object.keys(parsed).filter((k) => k.startsWith(PREFIX));
	expect(names.length).toBeGreaterThan(0);
	expect(names.length).toBeLessThan(20);
	expect(names[0]).toBe(`${PREFIX}h00${"-".repeat(60)}`);
	expect(parsed[names[0]]).toHaveLength(128);
	expect(parsed.truncated).toBe(true);
});

test("sensitive-named unified headers are dropped", async () => {
	const stored = await capture("claude-fable-5", 200, {
		[`${PREFIX}5h-utilization`]: "0.4",
		[`${PREFIX}session-token`]: "secret",
	});
	expect(JSON.parse(stored as string)).toEqual({
		[`${PREFIX}5h-utilization`]: "0.4",
	});
});

test("Sonnet 200 leaves the column null", async () => {
	expect(await capture("claude-sonnet-5-5", 200, unified(12))).toBeNull();
});

test("Fable 429 leaves the column null", async () => {
	expect(await capture("claude-fable-5", 429, unified(12))).toBeNull();
});
