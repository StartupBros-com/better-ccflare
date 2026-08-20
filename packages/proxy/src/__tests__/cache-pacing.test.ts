import { afterEach, describe, expect, test } from "bun:test";
import {
	acquireCachePacing,
	CACHE_PACING_MS_ENV,
	CODEX_CACHE_PACING_SETTLE_MS_ENV,
	CODEX_PACING_BYPASS_PERCENT_ENV,
	derivePacingCohortKey,
	finishPacing,
	getCachePacingRouteStats,
	getCachePacingStats,
	isCodexPacingBypassCandidate,
	observeCachePacing,
	readCachePacingMs,
	readCodexCachePacingSettleMs,
	readCodexPacingBypassPercent,
	recordCachePacingRoute,
	resetCachePacing,
} from "../cache-pacing";

afterEach(() => {
	resetCachePacing();
	delete process.env[CACHE_PACING_MS_ENV];
	delete process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV];
	delete process.env[CODEX_PACING_BYPASS_PERCENT_ENV];
});

function sseResponse(chunks: string[], delayMs = 0): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				if (delayMs > 0) {
					await new Promise((r) => setTimeout(r, delayMs));
				}
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function controlledResponse(): {
	response: Response;
	enqueue(chunk: string): void;
	close(): void;
	error(error: Error): void;
} {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(nextController) {
			controller = nextController;
		},
	});
	return {
		response: new Response(stream, { status: 200 }),
		enqueue(chunk) {
			controller.enqueue(encoder.encode(chunk));
		},
		close() {
			controller.close();
		},
		error(error) {
			controller.error(error);
		},
	};
}

function route(
	observation: Awaited<ReturnType<typeof observeCachePacing>>,
	provider: string,
): void {
	recordCachePacingRoute(observation, {
		accountId: `${provider}-account`,
		accountName: `${provider}-account`,
		provider,
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireReader(
	response: Response,
): ReadableStreamDefaultReader<Uint8Array> {
	if (!response.body) throw new Error("expected response body");
	return response.body.getReader();
}

describe("readCachePacingMs", () => {
	test("disabled by default, parses overrides, rejects nonsense", () => {
		expect(readCachePacingMs()).toBe(0);
		process.env[CACHE_PACING_MS_ENV] = "15000";
		expect(readCachePacingMs()).toBe(15_000);
		process.env[CACHE_PACING_MS_ENV] = "junk";
		expect(readCachePacingMs()).toBe(0);
	});
});

describe("readCodexCachePacingSettleMs", () => {
	test("defaults off, parses unsigned integers strictly, and clamps at ten seconds", () => {
		expect(readCodexCachePacingSettleMs()).toBe(0);
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "0";
		expect(readCodexCachePacingSettleMs()).toBe(0);
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "6000";
		expect(readCodexCachePacingSettleMs()).toBe(6_000);
		for (const invalid of ["5ms", "1e3", "+5", "-1", "1.5", " 5", "5 "]) {
			process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = invalid;
			expect(readCodexCachePacingSettleMs()).toBe(0);
		}
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "999999";
		expect(readCodexCachePacingSettleMs()).toBe(10_000);
	});
});

describe("Codex pacing bypass cohort", () => {
	test("defaults off, parses strictly, and clamps to 100", () => {
		expect(readCodexPacingBypassPercent()).toBe(0);
		for (const invalid of ["junk", "1e2", "-1", "1.5"]) {
			process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = invalid;
			expect(readCodexPacingBypassPercent()).toBe(0);
		}
		process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = "17";
		expect(readCodexPacingBypassPercent()).toBe(17);
		process.env[CODEX_PACING_BYPASS_PERCENT_ENV] = "999";
		expect(readCodexPacingBypassPercent()).toBe(100);
	});

	test("assignment is deterministic by conversation and missing identity stays control", () => {
		process.env[CACHE_PACING_MS_ENV] = "15000";
		const turn1 = derivePacingCohortKey("session-a", {
			system: "same system",
			messages: [{ role: "user", content: "task A" }],
		});
		const turn2 = derivePacingCohortKey("session-a", {
			system: "same system",
			messages: [
				{ role: "user", content: "task A" },
				{ role: "assistant", content: "working" },
				{ role: "user", content: "continue" },
			],
		});
		const sibling = derivePacingCohortKey("session-a", {
			system: "same system",
			messages: [{ role: "user", content: "task B" }],
		});
		expect(turn1).toBe(turn2);
		expect(sibling).not.toBe(turn1);
		expect(derivePacingCohortKey(null, { messages: [] })).toBeNull();
		expect(isCodexPacingBypassCandidate(null, 100)).toBe(false);
		expect(isCodexPacingBypassCandidate(turn1, 0)).toBe(false);
		expect(isCodexPacingBypassCandidate(turn1, 100)).toBe(true);
		const first = isCodexPacingBypassCandidate(turn1, 37);
		for (let i = 0; i < 20; i++) {
			expect(isCodexPacingBypassCandidate(turn1, 37)).toBe(first);
		}
	});

	test("records treatment, control, and crossovers separately", () => {
		const codex = {
			accountId: "pro",
			accountName: "pro-primary",
			provider: "codex",
		};
		const anthropic = {
			accountId: "max",
			accountName: "max-secondary",
			provider: "anthropic",
		};
		recordCachePacingRoute(null, codex, {
			candidate: true,
			assignedBypass: true,
		});
		const control = {
			key: "k",
			role: "leader" as const,
			waitedMs: 0,
			releaseReason: null,
			slot: null,
		};
		recordCachePacingRoute(control, codex, {
			candidate: true,
			assignedBypass: false,
		});
		// The ordinary non-treatment population is also part of control.
		recordCachePacingRoute(control, codex, {
			candidate: true,
			assignedBypass: false,
		});
		recordCachePacingRoute(null, anthropic, {
			candidate: true,
			assignedBypass: true,
		});

		const routes = getCachePacingRouteStats();
		expect(routes.pro.canaryBypassServed).toBe(1);
		expect(routes.pro.canaryControlServed).toBe(2);
		expect(routes.pro.canaryCrossovers).toBe(0);
		expect(routes.max.canaryCrossovers).toBe(1);
		expect(routes.max.canaryBypassServed).toBe(0);
	});
});

describe("acquireCachePacing", () => {
	test("uses an opaque coordination key and exposes no raw session material", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const rawSession = "raw-private-session-key";
		const rawModel = "claude-private-model-marker";
		const observation = await observeCachePacing({
			sessionKey: rawSession,
			model: rawModel,
		});

		expect(observation?.key).toMatch(/^pacing_[a-f0-9]{64}$/);
		expect(observation?.key).not.toContain(rawSession);
		expect(observation?.key).not.toContain(rawModel);
		expect(observation?.slot?.key).toBe(observation?.key);
		expect(JSON.stringify(getCachePacingStats())).not.toContain(rawSession);
		expect(JSON.stringify(getCachePacingRouteStats())).not.toContain(
			rawSession,
		);
		observation?.slot?.abandon();
	});

	test("preserves one coordination cohort for omitted, null, and empty models", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const omitted = await observeCachePacing({ sessionKey: "same-session" });
		omitted?.slot?.abandon();
		const nullModel = await observeCachePacing({
			sessionKey: "same-session",
			model: null,
		});
		nullModel?.slot?.abandon();
		const emptyModel = await observeCachePacing({
			sessionKey: "same-session",
			model: "",
		});
		emptyModel?.slot?.abandon();

		expect(omitted?.key).toBe(nullModel?.key);
		expect(nullModel?.key).toBe(emptyModel?.key);
	});

	test("returns null when disabled or session missing", async () => {
		expect(
			await acquireCachePacing({ sessionKey: "s1", model: "m" }),
		).toBeNull();
		process.env[CACHE_PACING_MS_ENV] = "1000";
		expect(
			await acquireCachePacing({ sessionKey: null, model: "m" }),
		).toBeNull();
	});

	test("first request leads immediately, follower waits for first body chunk", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s1", model: "m" });
		expect(leader).not.toBeNull();

		let followerReleased = false;
		const followerPromise = acquireCachePacing({
			sessionKey: "s1",
			model: "m",
		}).then((slot) => {
			followerReleased = true;
			return slot;
		});

		await new Promise((r) => setTimeout(r, 30));
		expect(followerReleased).toBe(false);

		// Leader's response starts streaming: first chunk releases the follower.
		const wrapped = finishPacing(leader, sseResponse(["event: a\n\n"], 10));
		await wrapped.text();

		const followerSlot = await followerPromise;
		expect(followerReleased).toBe(true);
		expect(followerSlot).toBeNull();
	});

	test("wrapped body passes through byte-identical", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s2", model: "m" });
		const wrapped = finishPacing(leader, sseResponse(["hello ", "world"], 1));
		expect(await wrapped.text()).toBe("hello world");
		expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
	});

	test("Anthropic releases a follower at the first chunk even when Codex settling is enabled", async () => {
		process.env[CACHE_PACING_MS_ENV] = "500";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "100";
		const leader = await observeCachePacing({
			sessionKey: "anthropic-first",
			model: "m",
		});
		route(leader, "anthropic");
		const follower = observeCachePacing({
			sessionKey: "anthropic-first",
			model: "m",
		});
		const source = controlledResponse();
		const reader = requireReader(
			finishPacing(leader?.slot ?? null, source.response),
		);
		source.enqueue("first");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
		await follower;
		source.close();
	});

	test("Codex holds through clean EOF, preserves chunks, then settles before releasing", async () => {
		process.env[CACHE_PACING_MS_ENV] = "500";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "60";
		const leader = await observeCachePacing({
			sessionKey: "codex-terminal",
			model: "m",
		});
		route(leader, "codex");
		const follower = observeCachePacing({
			sessionKey: "codex-terminal",
			model: "m",
		});
		const source = controlledResponse();
		const reader = requireReader(
			finishPacing(leader?.slot ?? null, source.response),
		);
		source.enqueue("first");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
		await wait(15);
		let followerReleased = false;
		void follower.then(() => {
			followerReleased = true;
		});
		expect(followerReleased).toBe(false);
		source.enqueue(" second");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			" second",
		);
		source.close();
		expect((await reader.read()).done).toBe(true);
		await wait(25);
		expect(followerReleased).toBe(false);
		await follower;
		expect(
			getCachePacingRouteStats()["codex-account"].leadersReachedTerminal,
		).toBe(1);
		expect(
			getCachePacingRouteStats()["codex-account"].leadersReleasedAfterSettle,
		).toBe(1);
	});

	test("Codex cancellation and stream errors release followers immediately", async () => {
		process.env[CACHE_PACING_MS_ENV] = "500";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "200";
		for (const mode of ["cancel", "error"] as const) {
			const leader = await observeCachePacing({
				sessionKey: `codex-${mode}`,
				model: "m",
			});
			route(leader, "codex");
			const follower = observeCachePacing({
				sessionKey: `codex-${mode}`,
				model: "m",
			});
			const source = controlledResponse();
			const reader = requireReader(
				finishPacing(leader?.slot ?? null, source.response),
			);
			if (mode === "cancel") {
				await reader.cancel();
			} else {
				source.error(new Error("upstream failed"));
				await expect(reader.read()).rejects.toThrow("upstream failed");
			}
			await follower;
		}
	});

	test("bodyless and non-OK responses release Codex leaders immediately", async () => {
		process.env[CACHE_PACING_MS_ENV] = "500";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "200";
		for (const response of [
			new Response(null, { status: 204 }),
			new Response("bad", { status: 503 }),
		]) {
			const leader = await observeCachePacing({
				sessionKey: `immediate-${response.status}`,
				model: "m",
			});
			route(leader, "codex");
			const follower = observeCachePacing({
				sessionKey: `immediate-${response.status}`,
				model: "m",
			});
			finishPacing(leader?.slot ?? null, response);
			await follower;
		}
	});

	test("follower cap bounds a longer Codex settle delay", async () => {
		process.env[CACHE_PACING_MS_ENV] = "40";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "200";
		const leader = await observeCachePacing({
			sessionKey: "codex-cap",
			model: "m",
		});
		route(leader, "codex");
		const wrapped = finishPacing(leader?.slot ?? null, sseResponse(["done"]));
		await wrapped.text();
		const start = Date.now();
		await observeCachePacing({ sessionKey: "codex-cap", model: "m" });
		expect(Date.now() - start).toBeLessThan(150);
	});

	test("Anthropic winner after Codex intent uses default first-chunk release", async () => {
		process.env[CACHE_PACING_MS_ENV] = "500";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "100";
		const leader = await observeCachePacing({
			sessionKey: "codex-failover",
			model: "gpt-5",
		});
		route(leader, "anthropic");
		const follower = observeCachePacing({
			sessionKey: "codex-failover",
			model: "gpt-5",
		});
		const source = controlledResponse();
		const reader = requireReader(
			finishPacing(leader?.slot ?? null, source.response),
		);
		source.enqueue("first");
		await reader.read();
		await follower;
		source.close();
	});

	test("a stale delayed leader cannot delete its replacement", async () => {
		process.env[CACHE_PACING_MS_ENV] = "100";
		process.env[CODEX_CACHE_PACING_SETTLE_MS_ENV] = "60";
		let clock = 0;
		const first = await observeCachePacing({
			sessionKey: "replace",
			model: "m",
			now: () => clock,
		});
		route(first, "codex");
		const firstResponse = finishPacing(
			first?.slot ?? null,
			sseResponse(["done"]),
		);
		await firstResponse.text();
		clock = 300;
		const replacement = await observeCachePacing({
			sessionKey: "replace",
			model: "m",
			now: () => clock,
		});
		await wait(80);
		const follower = observeCachePacing({
			sessionKey: "replace",
			model: "m",
			now: () => clock,
		});
		await wait(5);
		let released = false;
		void follower.then(() => {
			released = true;
		});
		expect(released).toBe(false);
		replacement?.slot?.abandon();
		await follower;
	});

	test("abandon releases followers immediately", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s3", model: "m" });
		const start = Date.now();
		const followerPromise = acquireCachePacing({
			sessionKey: "s3",
			model: "m",
		});
		leader?.abandon();
		await followerPromise;
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	test("non-ok leader response abandons instead of wrapping", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({ sessionKey: "s4", model: "m" });
		const followerPromise = acquireCachePacing({
			sessionKey: "s4",
			model: "m",
		});
		const errorResponse = new Response("nope", { status: 503 });
		const finished = finishPacing(leader, errorResponse);
		expect(finished.status).toBe(503);
		await followerPromise; // resolves promptly because abandon fired
	});

	test("follower releases at the cap when the leader never streams", async () => {
		process.env[CACHE_PACING_MS_ENV] = "50";
		await acquireCachePacing({ sessionKey: "s5", model: "m" });
		const start = Date.now();
		await acquireCachePacing({ sessionKey: "s5", model: "m" });
		const held = Date.now() - start;
		expect(held).toBeGreaterThanOrEqual(40);
		expect(held).toBeLessThan(2_000);
	});

	test("different sessions and models do not block each other", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const start = Date.now();
		await acquireCachePacing({ sessionKey: "s6", model: "m1" });
		await acquireCachePacing({ sessionKey: "s6", model: "m2" });
		await acquireCachePacing({ sessionKey: "s7", model: "m1" });
		expect(Date.now() - start).toBeLessThan(1_000);
	});

	test("stale leader is replaced instead of waited on", async () => {
		process.env[CACHE_PACING_MS_ENV] = "100";
		let clock = 1_000_000;
		const now = () => clock;
		const first = await acquireCachePacing({
			sessionKey: "s8",
			model: "m",
			now,
		});
		expect(first).not.toBeNull();
		// Advance beyond 2x the cap: the dead leader must not hold newcomers.
		clock += 500;
		const start = Date.now();
		const second = await acquireCachePacing({
			sessionKey: "s8",
			model: "m",
			now,
		});
		expect(second).not.toBeNull();
		expect(Date.now() - start).toBeLessThan(1_000);
		expect(getCachePacingStats().other?.staleLeadersReplaced).toBe(1);
	});
});

describe("getCachePacingStats", () => {
	test("attributes leaders and leader-released followers per family", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await acquireCachePacing({
			sessionKey: "st1",
			model: "claude-opus-4-8",
		});
		const followerPromise = acquireCachePacing({
			sessionKey: "st1",
			model: "claude-opus-4-8",
		});
		await new Promise((r) => setTimeout(r, 10));
		const wrapped = finishPacing(leader, sseResponse(["event: a\n\n"], 1));
		await wrapped.text();
		await followerPromise;

		const stats = getCachePacingStats();
		expect(stats.anthropic.leaders).toBe(1);
		expect(stats.anthropic.followersHeld).toBe(1);
		expect(stats.anthropic.followersReleasedByLeader).toBe(1);
		expect(stats.anthropic.followersReleasedByCap).toBe(0);
		expect(stats.anthropic.followerWaitMsTotal).toBeGreaterThanOrEqual(0);
		expect(stats.codex).toBeUndefined();
	});

	test("attributes cap releases and abandons, families separated", async () => {
		process.env[CACHE_PACING_MS_ENV] = "30";
		await acquireCachePacing({ sessionKey: "st2", model: "gpt-5.6-sol" });
		// Leader never streams: the follower must release at the cap.
		await acquireCachePacing({ sessionKey: "st2", model: "gpt-5.6-sol" });
		const abandoned = await acquireCachePacing({
			sessionKey: "st3",
			model: "gpt-5.6-sol",
		});
		abandoned?.abandon();

		const stats = getCachePacingStats();
		expect(stats.openai.leaders).toBe(2);
		expect(stats.openai.followersHeld).toBe(1);
		expect(stats.openai.followersReleasedByCap).toBe(1);
		expect(stats.openai.followersReleasedByLeader).toBe(0);
		expect(stats.openai.leadersAbandoned).toBe(1);
		expect(stats.openai.followerWaitMsMax).toBeGreaterThanOrEqual(20);
		expect(stats.anthropic).toBeUndefined();
	});

	test("attributes observations only after the serving route is known", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const leader = await observeCachePacing({
			sessionKey: "shadow",
			model: "claude-opus-4-8",
		});
		const followerPromise = observeCachePacing({
			sessionKey: "shadow",
			model: "claude-opus-4-8",
		});
		await new Promise((r) => setTimeout(r, 10));
		const wrapped = finishPacing(
			leader?.slot ?? null,
			sseResponse(["event: a\n\n"], 1),
		);
		await wrapped.text();
		const follower = await followerPromise;

		// No selection-time attribution: only successful routes are counted.
		expect(getCachePacingRouteStats()).toEqual({});
		recordCachePacingRoute(leader, {
			accountId: "acct-a",
			accountName: "failed-first-account",
			provider: "anthropic",
		});
		recordCachePacingRoute(follower, {
			accountId: "acct-pro",
			accountName: "pro-primary",
			provider: "codex",
		});

		const routes = getCachePacingRouteStats();
		expect(routes["acct-a"].leaders).toBe(1);
		expect(routes["acct-a"].requestsServed).toBe(1);
		expect(routes["acct-pro"].followersHeld).toBe(1);
		expect(routes["acct-pro"].followersReleasedByLeader).toBe(1);
		expect(routes["acct-pro"].followerWaitMsTotal).toBeGreaterThanOrEqual(0);
		expect(routes["acct-pro"].provider).toBe("codex");
	});

	// Route counters are the Codex-bypass counterfactual: a served Codex
	// follower's ordinary wait metrics are exactly what bypass would avoid.
	test("preserves openai family compatibility while routes carry actual provider", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const observation = await observeCachePacing({
			sessionKey: "codex",
			model: "gpt-5.6-sol",
		});
		recordCachePacingRoute(observation, {
			accountId: "acct-pro",
			accountName: "pro-primary",
			provider: "codex",
		});
		expect(getCachePacingStats().openai.leaders).toBe(1);
		expect(getCachePacingRouteStats()["acct-pro"].provider).toBe("codex");
		observation?.slot?.abandon();
	});
	test("reset clears family and route stats", async () => {
		process.env[CACHE_PACING_MS_ENV] = "5000";
		const observation = await observeCachePacing({
			sessionKey: "st4",
			model: "claude-opus-4-8",
		});
		recordCachePacingRoute(observation, {
			accountId: "acct",
			accountName: "account",
			provider: "anthropic",
		});
		resetCachePacing();
		expect(getCachePacingStats()).toEqual({});
		expect(getCachePacingRouteStats()).toEqual({});
	});
});
