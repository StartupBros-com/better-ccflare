/**
 * R11: the terminal message_delta that advisor emulation emits (interceptor.ts
 * header) flows through the usage collector unchanged. These tests feed that
 * exact shape - summed worker usage plus
 * iterations [message, advisor_message, message...] - and price it against a
 * stubbed models.dev catalogue carrying the 2026-10-13 Codex rates. Nothing
 * here mocks @better-ccflare/core: the real PriceCatalogue is fed through a
 * fake globalThis.fetch (restored in afterEach) and the preload-isolated
 * TMPDIR, so no network call is made and no real cache is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { logBus } from "@better-ccflare/logger";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const WORKER = "emu-worker-test";
const ASTRA = "gpt-6-astra";
const SOL = "gpt-6.1-sol";
const UNPRICED = "gpt-6-unlisted-test";

const cost = (input: number, output: number, cache_read: number) => ({
	input,
	output,
	cache_read,
});
const model = (id: string, c: ReturnType<typeof cost>) => ({
	id,
	name: id,
	cost: c,
});

// Rates are USD per MTok, as of 2026-10-13.
const CATALOGUE = {
	openai: {
		models: {
			[ASTRA]: model(ASTRA, cost(10, 50, 1)),
			[SOL]: model(SOL, cost(2, 10, 0.1)),
		},
	},
	emutest: { models: { [WORKER]: model(WORKER, cost(3, 15, 0.3)) } },
};

const originalFetch = globalThis.fetch;
const originalOffline = process.env.CF_PRICING_OFFLINE;

beforeEach(() => {
	// The preload gives this process its own TMPDIR; refuse to run against a
	// shared one so the catalogue cache can never be the production cache.
	expect(tmpdir()).toContain("ccflare-test-");
	delete process.env.CF_PRICING_OFFLINE;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		const body =
			url === "https://models.dev/api.json"
				? CATALOGUE
				: { object: "list", data: [] };
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalOffline === undefined) delete process.env.CF_PRICING_OFFLINE;
	else process.env.CF_PRICING_OFFLINE = originalOffline;
});

type SavedUsage = Record<string, unknown>;

function makeHarness() {
	const saved = new Map<string, SavedUsage>();
	const dbOps = {
		async updateAccountUsage() {},
		async saveRequest(requestId: string, ...args: unknown[]) {
			const usage = args[8];
			if (usage && typeof usage === "object") {
				saved.set(requestId, usage as SavedUsage);
			}
		},
		async saveRequestPayloadRaw() {},
	};
	const pending = new Set<Promise<void>>();
	const asyncWriter = {
		enqueue(task: () => Promise<void> | void) {
			const p = Promise.resolve().then(task);
			pending.add(p);
			void p.finally(() => pending.delete(p));
			return true;
		},
		async dispose() {
			await Promise.allSettled([...pending]);
		},
		canAcceptPayload: () => true,
		enqueuePayload(_id: string, _b: number, task: () => Promise<void> | void) {
			this.enqueue(task);
			return true;
		},
	};
	const collector = new UsageCollector(
		dbOps as never,
		asyncWriter as never,
		() => false,
		() => {},
	);
	return { collector, saved };
}

function startMessage(requestId: string): StartMessage {
	return {
		type: "start",
		messageId: `message-${requestId}`,
		requestId,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "text/event-stream" },
		isStream: true,
		providerName: "codex",
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
	};
}

interface Tok {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
}
const worker = (t: Tok) => ({ type: "message", model: WORKER, ...t });
const advisor = (m: string, t: Tok) => ({
	type: "advisor_message",
	model: m,
	...t,
});

function sum(workers: Tok[]): Tok {
	return workers.reduce(
		(a, t) => ({
			input_tokens: a.input_tokens + t.input_tokens,
			output_tokens: a.output_tokens + t.output_tokens,
			cache_read_input_tokens:
				(a.cache_read_input_tokens ?? 0) + (t.cache_read_input_tokens ?? 0),
		}),
		{ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
	);
}

/** The U4 stream: worker message_start, then ONE terminal message_delta. */
function emulatedStream(iterations: unknown[], topLevel: Tok): Uint8Array {
	return new TextEncoder().encode(
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { model: WORKER, usage: { input_tokens: 1, output_tokens: 0 } },
		})}\n\nevent: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { ...topLevel, iterations },
		})}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
	);
}

function captureAdvisorLogs(): {
	events: Array<Record<string, unknown>>;
	stop: () => void;
} {
	const events: Array<Record<string, unknown>> = [];
	const onLog = (e: { msg?: string } & Record<string, unknown>) => {
		if (e.msg === "anthropic_advisor_iterations") events.push(e);
	};
	logBus.on("log", onLog as never);
	return { events, stop: () => logBus.off("log", onLog as never) };
}

async function run(
	id: string,
	iterations: unknown[],
	workers: Tok[],
): Promise<SavedUsage> {
	const { collector, saved } = makeHarness();
	try {
		collector.handleStart(startMessage(id));
		collector.handleChunk(id, emulatedStream(iterations, sum(workers)));
		await collector.handleEnd({
			type: "end",
			requestId: id,
			success: true,
			streamTerminalState: "complete",
		});
		await collector.drain();
	} finally {
		collector.dispose();
	}
	const usage = saved.get(id);
	if (!usage) throw new Error("collector saved no usage");
	return usage;
}

const w1: Tok = {
	input_tokens: 1000,
	output_tokens: 200,
	cache_read_input_tokens: 500,
};
const w2: Tok = {
	input_tokens: 1200,
	output_tokens: 300,
	cache_read_input_tokens: 700,
};
// 2200*3 + 500*15 + 1200*0.3 = 14460 -> $0.01446
const WORKER_COST = 0.01446;
const astraT: Tok = {
	input_tokens: 4000,
	output_tokens: 800,
	cache_read_input_tokens: 2000,
};
// 4000*10 + 800*50 + 2000*1 = 82000 -> $0.082
const ASTRA_COST = 0.082;
const solT: Tok = {
	input_tokens: 3000,
	output_tokens: 600,
	cache_read_input_tokens: 1000,
};
// 3000*2 + 600*10 + 1000*0.1 = 12100 -> $0.0121
const SOL_COST = 0.0121;

describe("advisor emulation terminal usage through the collector", () => {
	it("prices a gpt-6-astra advisor iteration on top of the worker", async () => {
		const usage = await run(
			"emu-astra",
			[worker(w1), advisor(ASTRA, astraT), worker(w2)],
			[w1, w2],
		);
		expect(usage.advisorUsage).toEqual([
			{
				model: ASTRA,
				inputTokens: 4000,
				outputTokens: 800,
				cacheReadInputTokens: 2000,
				cacheCreationInputTokens: 0,
			},
		]);
		expect(usage.costUsd as number).toBeGreaterThan(WORKER_COST);
		expect(usage.costUsd as number).toBeCloseTo(WORKER_COST + ASTRA_COST, 9);
		// top level is the summed WORKER usage only
		expect(usage.inputTokens).toBe(2200);
		expect(usage.outputTokens).toBe(500);
		expect(usage.cacheReadInputTokens).toBe(1200);
	});

	it("prices a gpt-6.1-sol advisor iteration at its own rates", async () => {
		const usage = await run(
			"emu-sol",
			[worker(w1), advisor(SOL, solT), worker(w2)],
			[w1, w2],
		);
		expect(usage.costUsd as number).toBeCloseTo(WORKER_COST + SOL_COST, 9);
		expect(
			(usage.advisorUsage as Array<{ model: string }>).map((a) => a.model),
		).toEqual([SOL]);
	});

	it("sums two advisor rounds on different models", async () => {
		const w3: Tok = { input_tokens: 100, output_tokens: 50 };
		const usage = await run(
			"emu-two-rounds",
			[
				worker(w1),
				advisor(ASTRA, astraT),
				worker(w2),
				advisor(SOL, solT),
				worker(w3),
			],
			[w1, w2, w3],
		);
		const workerCost = (2300 * 3 + 550 * 15 + 1200 * 0.3) / 1e6;
		expect(usage.costUsd as number).toBeCloseTo(
			workerCost + ASTRA_COST + SOL_COST,
			9,
		);
		expect(usage.advisorUsage).toHaveLength(2);
		expect(usage.inputTokens).toBe(2300);
		expect(usage.outputTokens).toBe(550);
	});

	it("two rounds on the same advisor model merge into one usage line", async () => {
		const usage = await run(
			"emu-same-model",
			[
				worker(w1),
				advisor(ASTRA, astraT),
				worker(w2),
				advisor(ASTRA, astraT),
				worker(w2),
			],
			[w1, w2, w2],
		);
		expect(usage.advisorUsage).toEqual([
			{
				model: ASTRA,
				inputTokens: 8000,
				outputTokens: 1600,
				cacheReadInputTokens: 4000,
				cacheCreationInputTokens: 0,
			},
		]);
		const workerCost = (3400 * 3 + 800 * 15 + 1900 * 0.3) / 1e6;
		expect(usage.costUsd as number).toBeCloseTo(workerCost + 2 * ASTRA_COST, 9);
	});

	it("an unpriced advisor model flags billingIncomplete and adds no phantom cost", async () => {
		const logs = captureAdvisorLogs();
		let usage: SavedUsage;
		try {
			usage = await run(
				"emu-unpriced",
				[worker(w1), advisor(UNPRICED, astraT), worker(w2)],
				[w1, w2],
			);
		} finally {
			logs.stop();
		}
		expect(usage.costUsd as number).toBeCloseTo(WORKER_COST, 9);
		// advisor tokens are still persisted for window value
		expect(
			(usage.advisorUsage as Array<{ model: string }>).map((a) => a.model),
		).toEqual([UNPRICED]);
		expect(logs.events).toHaveLength(1);
		expect(JSON.stringify(logs.events[0])).toContain(
			'"billingIncomplete":true',
		);
		expect(JSON.stringify(logs.events[0])).toContain(UNPRICED);
	});

	it("leaves billingIncomplete unset when worker and advisor are both priced", async () => {
		const logs = captureAdvisorLogs();
		try {
			await run(
				"emu-priced",
				[worker(w1), advisor(SOL, solT), worker(w2)],
				[w1, w2],
			);
		} finally {
			logs.stop();
		}
		expect(logs.events).toHaveLength(1);
		const logged = JSON.stringify(logs.events[0]);
		expect(logged).not.toContain("billingIncomplete");
		expect(logged).toContain('"advisorIterations":1');
		expect(logged).toContain('"billableAdvisorIterations":1');
	});

	it("a response without iterations (no round ran) records no advisor usage", async () => {
		const { collector, saved } = makeHarness();
		const id = "emu-none";
		try {
			collector.handleStart(startMessage(id));
			collector.handleChunk(
				id,
				new TextEncoder().encode(
					`event: message_start\ndata: ${JSON.stringify({
						type: "message_start",
						message: {
							model: WORKER,
							usage: { input_tokens: 5, output_tokens: 0 },
						},
					})}\n\nevent: message_delta\ndata: ${JSON.stringify({
						type: "message_delta",
						usage: { input_tokens: 5, output_tokens: 7 },
					})}\n\n`,
				),
			);
			await collector.handleEnd({
				type: "end",
				requestId: id,
				success: true,
				streamTerminalState: "complete",
			});
			await collector.drain();
		} finally {
			collector.dispose();
		}
		expect(saved.get(id)?.advisorUsage).toBeUndefined();
	});
});
