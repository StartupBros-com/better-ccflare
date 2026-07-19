import { describe, expect, it, mock } from "bun:test";
import { ANTHROPIC_MESSAGE_STOP_FRAME } from "../anthropic-terminal-recovery";
import type { ProxyContext } from "../handlers";

// The source worktree intentionally excludes generated database worker bundles.
// ResponseHandler only reaches these constructors through UsageCollector, which
// this filtered probe path never initializes or calls.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { forwardToClient } = await import("../response-handler");

const encoder = new TextEncoder();
const terminalDelta =
	'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n';
const committedPartial = [
	"event: message_start",
	'data: {"type":"message_start","message":{"content":[]}}',
	"",
	"event: content_block_delta",
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
	"",
	"",
].join("\n");
const semanticTimeoutFrame =
	'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Response stalled after partial output"}}\n\n';

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

function immediateStream(chunk: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
}

function stalledCommittedStream(
	onCancel: () => void,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes(committedPartial));
		},
		cancel() {
			onCancel();
		},
	});
}

function nativeAnthropicCtx(providerName = "anthropic"): ProxyContext {
	return {
		strategy: {},
		dbOps: {},
		runtime: { port: 8080, tlsEnabled: false },
		config: { getStorePayloads: () => true },
		provider: {
			name: providerName,
			isStreamingResponse: () => true,
		},
		refreshInFlight: new Map<string, Promise<string>>(),
		asyncWriter: {},
	} as unknown as ProxyContext;
}

async function forwardClosedStream({
	requestHeaders,
	providerName = "anthropic",
	path = "/v1/messages",
	method = "POST",
	status = 200,
	contentType = "text/event-stream; charset=utf-8",
}: {
	requestHeaders: Headers;
	providerName?: string;
	path?: string;
	method?: string;
	status?: number;
	contentType?: string;
}): Promise<string> {
	const response = await forwardToClient(
		{
			requestId: crypto.randomUUID(),
			method,
			path,
			account: null,
			requestHeaders,
			requestBody: bytes("{}"),
			response: new Response(immediateStream(bytes(terminalDelta)), {
				status,
				headers: { "content-type": contentType },
			}),
			timestamp: Date.now(),
			retryAttempt: 0,
			failoverAttempts: 0,
		},
		nativeAnthropicCtx(providerName),
	);

	return response.text();
}

describe("forwardToClient Anthropic terminal recovery integration", () => {
	it("recovers native Anthropic Messages SSE responses", async () => {
		const requestHeaders = new Headers({
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-auto-refresh": "true",
		});

		await expect(forwardClosedStream({ requestHeaders })).resolves.toBe(
			`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`,
		);
	});

	it("recovers provider-transformed downstream Anthropic Messages SSE exactly once", async () => {
		const requestHeaders = new Headers({
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-auto-refresh": "true",
		});

		const body = await forwardClosedStream({
			requestHeaders,
			providerName: "anthropic-compatible",
		});

		expect(body).toBe(`${terminalDelta}${ANTHROPIC_MESSAGE_STOP_FRAME}`);
		expect(body.match(/event: message_stop/g)).toHaveLength(1);
	});

	it("leaves non-Anthropic request protocols and non-Messages streams unchanged", async () => {
		const filteredHeaders = new Headers({
			"x-better-ccflare-auto-refresh": "true",
		});
		const nativeHeaders = new Headers(filteredHeaders);
		nativeHeaders.set("anthropic-version", "2023-06-01");

		await expect(
			forwardClosedStream({ requestHeaders: filteredHeaders }),
		).resolves.toBe(terminalDelta);
		await expect(
			forwardClosedStream({
				requestHeaders: nativeHeaders,
				path: "/v1/complete",
			}),
		).resolves.toBe(terminalDelta);
	});

	it("leaves GET, non-2xx, and non-SSE Anthropic Messages responses unchanged", async () => {
		const nativeHeaders = new Headers({
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-auto-refresh": "true",
		});

		await expect(
			forwardClosedStream({ requestHeaders: nativeHeaders, method: "GET" }),
		).resolves.toBe(terminalDelta);
		await expect(
			forwardClosedStream({ requestHeaders: nativeHeaders, status: 500 }),
		).resolves.toBe(terminalDelta);
		await expect(
			forwardClosedStream({
				requestHeaders: nativeHeaders,
				contentType: "application/json",
			}),
		).resolves.toBe(terminalDelta);
	});

	it("terminates safely without a route penalty when routing metadata is absent", async () => {
		const timeoutEnv = "CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS";
		const progressEnv =
			"CCFLARE_ANTHROPIC_POSTCOMMIT_MEANINGFUL_PROGRESS_TIMEOUT_MS";
		const originalTimeout = process.env[timeoutEnv];
		const originalProgress = process.env[progressEnv];
		process.env[timeoutEnv] = "10";
		process.env[progressEnv] = "20";
		const reportCandidateFailure = mock(() => undefined);
		const ctx = nativeAnthropicCtx();
		ctx.strategy.reportCandidateFailure = reportCandidateFailure;
		let cancelCount = 0;

		try {
			const response = await forwardToClient(
				{
					requestId: crypto.randomUUID(),
					method: "POST",
					path: "/v1/messages",
					account: null,
					requestHeaders: new Headers({
						"anthropic-version": "2023-06-01",
						"x-better-ccflare-auto-refresh": "true",
					}),
					requestBody: bytes("{}"),
					response: new Response(
						stalledCommittedStream(() => cancelCount++),
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					),
					timestamp: Date.now(),
					retryAttempt: 0,
					failoverAttempts: 0,
					attemptedModel: "claude-opus-4-8",
					routeCandidateId: "account:route-without-metadata",
				},
				ctx,
			);

			expect(await response.text()).toBe(
				`${committedPartial}${semanticTimeoutFrame}`,
			);
			expect(cancelCount).toBe(1);
			expect(reportCandidateFailure).not.toHaveBeenCalled();
		} finally {
			if (originalTimeout === undefined) delete process.env[timeoutEnv];
			else process.env[timeoutEnv] = originalTimeout;
			if (originalProgress === undefined) delete process.env[progressEnv];
			else process.env[progressEnv] = originalProgress;
		}
	});
});
