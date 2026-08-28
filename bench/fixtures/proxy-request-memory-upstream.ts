#!/usr/bin/env bun

export const REQUEST_BODY_UPSTREAM_READY_TYPE =
	"proxy-request-memory-upstream-ready";
export const REQUEST_BODY_UPSTREAM_PATH = "/v1/messages";
export const REQUEST_BODY_UPSTREAM_STATS_PATH =
	"/__better_ccflare_request_memory_stats";

export type RequestBodyUpstreamReadyMessage = {
	type: typeof REQUEST_BODY_UPSTREAM_READY_TYPE;
	port: number;
};

export type RequestBodyUpstreamState = {
	requests: number;
	receivedBodyBytes: number[];
	receivedModels: Array<string | null>;
	completed: number;
	cancelled: number;
	aborted: number;
	responseStream: {
		pulls: number;
		completed: number;
		cancelled: number;
		aborted: number;
	};
};

function snapshot(state: RequestBodyUpstreamState): RequestBodyUpstreamState {
	return {
		...state,
		receivedBodyBytes: [...state.receivedBodyBytes],
		receivedModels: [...state.receivedModels],
		responseStream: { ...state.responseStream },
	};
}

function parseOptions(args: string[]): {
	bodyBytes: number;
	expectedModel: string;
} {
	const bodyBytes = Number.parseInt(args[0] ?? "", 10);
	const expectedModel = args[1];
	if (!Number.isSafeInteger(bodyBytes) || bodyBytes <= 0) {
		throw new Error("fixture bodyBytes must be a positive integer");
	}
	if (!expectedModel) {
		throw new Error("fixture expectedModel must be non-empty");
	}
	return { bodyBytes, expectedModel };
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const decoder = new TextDecoder();
	const state: RequestBodyUpstreamState = {
		requests: 0,
		receivedBodyBytes: [],
		receivedModels: [],
		completed: 0,
		cancelled: 0,
		aborted: 0,
		responseStream: {
			pulls: 0,
			completed: 0,
			cancelled: 0,
			aborted: 0,
		},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (
				request.method === "GET" &&
				url.pathname === REQUEST_BODY_UPSTREAM_STATS_PATH
			) {
				return Response.json(snapshot(state));
			}
			if (
				request.method !== "POST" ||
				url.pathname !== REQUEST_BODY_UPSTREAM_PATH
			) {
				return new Response(null, { status: 404 });
			}

			state.requests += 1;
			let terminal = false;
			request.signal.addEventListener(
				"abort",
				() => {
					if (!terminal) state.aborted += 1;
				},
				{ once: true },
			);
			try {
				const received = new Uint8Array(await request.arrayBuffer());
				state.receivedBodyBytes.push(received.byteLength);
				let receivedModel: string | null = null;
				try {
					const parsed = JSON.parse(decoder.decode(received)) as Record<
						string,
						unknown
					>;
					receivedModel =
						typeof parsed.model === "string" ? parsed.model : null;
				} catch {
					// The fixture deliberately reports only the null model marker, never
					// body contents or parser diagnostics.
				}
				state.receivedModels.push(receivedModel);
				if (
					received.byteLength !== options.bodyBytes ||
					receivedModel !== options.expectedModel
				) {
					state.cancelled += 1;
					return new Response(null, { status: 400 });
				}
				state.completed += 1;
				// A bodyless success keeps response allocation outside this request-body
				// oracle. All request decoding and validation lives in this child.
				return new Response(null, { status: 204 });
			} catch {
				state.cancelled += 1;
				return new Response(null, { status: 400 });
			} finally {
				terminal = true;
			}
		},
	});

	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		server.stop(true);
		process.exit(0);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);

	const ready: RequestBodyUpstreamReadyMessage = {
		type: REQUEST_BODY_UPSTREAM_READY_TYPE,
		port: server.port,
	};
	process.stdout.write(`${JSON.stringify(ready)}\n`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("request-body upstream fixture failed:", error);
		process.exit(1);
	});
}
