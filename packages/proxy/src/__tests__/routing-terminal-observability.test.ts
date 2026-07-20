import { afterEach, describe, expect, it, mock } from "bun:test";
import type { RequestMeta } from "@better-ccflare/types";
import {
	ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
	coordinateAnthropicPreCommitRescue,
	createAnthropicPreCommitRescueActivation,
} from "../anthropic-precommit-rescue";
import type { StartMessage } from "../worker-messages";

// Loading UsageCollector in this focused test must not pull the CLI's embedded
// database worker artifacts into Bun's module graph.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { recordRoutingTerminalRequest } = await import(
	"../routing-terminal-recorder"
);
const { UsageCollector } = await import("../usage-collector");

type UsageCollectorInstance = InstanceType<typeof UsageCollector>;

interface CollectorHarness {
	collector: UsageCollectorInstance;
	observed: Pick<UsageCollectorInstance, "handleStart" | "handleEnd">;
	starts: StartMessage[];
	ends: Array<{ requestId: string; success: boolean; error?: string }>;
	savedRequests: unknown[][];
}

const collectors: UsageCollectorInstance[] = [];

afterEach(() => {
	for (const collector of collectors.splice(0)) collector.dispose();
});

function createCollectorHarness(): CollectorHarness {
	const savedRequests: unknown[][] = [];
	const pending = new Set<Promise<void>>();
	const dbOps = {
		async saveRequest(...args: unknown[]): Promise<void> {
			savedRequests.push(args);
		},
	};
	const asyncWriter = {
		enqueue(task: () => Promise<void> | void): boolean {
			const pendingTask = Promise.resolve().then(task);
			pending.add(pendingTask);
			void pendingTask.finally(() => pending.delete(pendingTask));
			return true;
		},
		enqueuePayload(): boolean {
			return false;
		},
		canAcceptPayload(): boolean {
			return false;
		},
		async dispose(): Promise<void> {
			await Promise.allSettled([...pending]);
		},
	};
	const collector = new UsageCollector(
		dbOps as never,
		asyncWriter as never,
		() => false,
		() => undefined,
	);
	collectors.push(collector);

	const starts: StartMessage[] = [];
	const ends: Array<{
		requestId: string;
		success: boolean;
		error?: string;
	}> = [];
	return {
		collector,
		starts,
		ends,
		savedRequests,
		observed: {
			handleStart(message) {
				starts.push({
					...message,
					requestHeaders: { ...message.requestHeaders },
					responseHeaders: { ...message.responseHeaders },
				});
				collector.handleStart(message);
			},
			handleEnd(message) {
				ends.push(message);
				return collector.handleEnd(message);
			},
		},
	};
}

function requestMeta(id: string): RequestMeta {
	return {
		id,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now() - 25,
		project: "terminal-observability",
		projectAttributionSource: "header_project",
		agentUsed: "test-agent",
		agentAttributionSource: "header_agent",
		originalModel: "claude-opus-4-6",
		appliedModel: "claude-sonnet-4-6",
		comboName: "opus-fable",
	};
}

function requestHeaders(): Headers {
	return new Headers({
		authorization: "Bearer must-not-persist",
		"content-type": "application/json",
		"x-request-context": "safe-value",
	});
}

function delayed<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("routing terminal observability", () => {
	it("isolates synchronous collector and observer failures from the terminal response", async () => {
		for (const collector of [
			{
				handleStart() {
					throw new Error("start failed");
				},
				handleEnd: async () => undefined,
			},
			{
				handleStart() {},
				handleEnd() {
					throw new Error("end failed");
				},
			},
		] as const) {
			const terminal = new Response('{"type":"error"}', {
				status: 503,
				headers: { "content-type": "application/json" },
			});
			let persisted: Promise<void> | undefined;

			expect(() => {
				persisted = recordRoutingTerminalRequest({
					collector: collector as never,
					requestMeta: requestMeta(crypto.randomUUID()),
					requestHeaders: requestHeaders(),
					response: terminal,
					providerName: "anthropic",
					terminalKind: "route_unavailable",
					upstreamAttempts: 0,
					onError() {
						throw new Error("observer failed");
					},
				});
			}).not.toThrow();
			await persisted;

			expect(terminal.status).toBe(503);
			expect(await terminal.text()).toBe('{"type":"error"}');
		}
	});

	it("persists a direct no-account terminal once with its original request metadata and native reason", async () => {
		const harness = createCollectorHarness();
		const meta = requestMeta("request-direct-terminal");
		const terminal = new Response('{"type":"error"}', {
			status: 503,
			headers: {
				"content-type": "application/json",
				"retry-after": "1",
			},
		});

		await recordRoutingTerminalRequest({
			collector: harness.observed,
			requestMeta: meta,
			requestHeaders: requestHeaders(),
			response: terminal,
			providerName: "anthropic",
			terminalKind: "route_unavailable",
			apiKeyId: "api-key-id",
			apiKeyName: "dogfood",
			upstreamAttempts: 2,
		});
		await harness.collector.drain();

		expect(terminal.status).toBe(503);
		expect(await terminal.text()).toBe('{"type":"error"}');
		expect(harness.starts).toHaveLength(1);
		expect(harness.starts[0]).toMatchObject({
			requestId: meta.id,
			accountId: null,
			method: meta.method,
			path: meta.path,
			timestamp: meta.timestamp,
			responseStatus: 503,
			providerName: "anthropic",
			project: meta.project,
			projectAttributionSource: "header_project",
			agentUsed: "test-agent",
			agentAttributionSource: "header_agent",
			originalModel: "claude-opus-4-6",
			appliedModel: "claude-sonnet-4-6",
			comboName: "opus-fable",
			apiKeyId: "api-key-id",
			apiKeyName: "dogfood",
			failoverAttempts: 1,
			isStream: false,
		});
		expect(harness.starts[0].requestHeaders.authorization).not.toBe(
			"Bearer must-not-persist",
		);
		expect(harness.starts[0].requestHeaders["x-request-context"]).toBe(
			"safe-value",
		);
		expect(harness.ends).toEqual([
			{
				type: "end",
				requestId: meta.id,
				success: false,
				error: "route_unavailable",
			},
		]);
		expect(harness.savedRequests).toHaveLength(1);
		expect(harness.savedRequests[0].slice(0, 7)).toEqual([
			meta.id,
			"POST",
			"/v1/messages",
			null,
			503,
			false,
			"route_unavailable",
		]);
	});

	it("persists the native terminal before an activated rescue translates it to an HTTP-200 SSE error", async () => {
		const harness = createCollectorHarness();
		const meta = requestMeta("request-rescued-terminal");
		const activation = createAnthropicPreCommitRescueActivation();
		const routed = delayed<Response>();
		activation.activate();
		const coordinated = coordinateAnthropicPreCommitRescue({
			response: routed.promise,
			activation: activation.promise,
			abortRouting: () => undefined,
			config: {
				activationGraceMs: 1,
				pingIntervalMs: 5,
				commitmentDeadlineMs: 100,
			},
		});
		await delay(5);

		const nativeTerminal = new Response('{"private":"must-not-forward"}', {
			status: 503,
			headers: { "content-type": "application/json" },
		});
		const persisted = recordRoutingTerminalRequest({
			collector: harness.observed,
			requestMeta: meta,
			requestHeaders: requestHeaders(),
			response: nativeTerminal,
			providerName: "anthropic",
			terminalKind: "all_routes_failed",
			upstreamAttempts: 2,
		});
		routed.resolve(nativeTerminal);

		const clientResponse = await coordinated;
		expect(clientResponse.status).toBe(200);
		expect(await clientResponse.text()).toEndWith(
			ANTHROPIC_PRECOMMIT_RESCUE_ERROR_FRAME,
		);
		await persisted;
		await harness.collector.drain();

		expect(harness.starts).toHaveLength(1);
		expect(harness.starts[0].requestId).toBe(meta.id);
		expect(harness.starts[0].responseStatus).toBe(503);
		expect(harness.ends).toEqual([
			{
				type: "end",
				requestId: meta.id,
				success: false,
				error: "all_routes_failed",
			},
		]);
		expect(harness.savedRequests).toHaveLength(1);
		expect(harness.savedRequests[0][0]).toBe(meta.id);
		expect(harness.savedRequests[0][4]).toBe(503);
		expect(harness.savedRequests[0][5]).toBe(false);
		expect(harness.savedRequests[0][6]).toBe("all_routes_failed");
	});
});
