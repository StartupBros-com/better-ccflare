import { BUFFER_SIZES, SseFrameBuffer } from "@better-ccflare/core";
import {
	bindManagedRequest,
	bootIdentity,
	claimManagedTiming,
	MANAGED_TIMING_HEADER,
	managedTimingBinding,
	monotonicNowNs,
	publishManagedTerminal,
	verifyManagedTiming,
} from "../../../scripts/ccflare-managed-timing.mjs";

interface ManagedIngressOptions {
	enabled?: boolean;
	secret?: Uint8Array;
	generation: number;
	candidateNonce: string;
	ingressNonce: string;
	sourceSha: string;
	onSecondary?: (cause: "cleanup_timeout") => void;
}
const expiryBody = {
	type: "error",
	error: {
		type: "api_error",
		code: "accepted_request_deadline",
		message: "Accepted request deadline expired.",
	},
};
function acceptedExpiryProtocol(path: string, requestId: string) {
	const responses =
		path === "/v1/responses" || path === "/v1/responses/compact";
	let responseId = `resp_${requestId.replaceAll("-", "")}`,
		model = "unknown",
		createdAt = Math.floor(Date.now() / 1000),
		nextSequence = 0,
		terminalSeen = false;
	let frames: SseFrameBuffer | null = responses
		? new SseFrameBuffer({
				maxFrameBytes: BUFFER_SIZES.SSE_TRANSPORT_FRAME_MAX_BYTES,
				maxBufferBytes: BUFFER_SIZES.SSE_TRANSPORT_TAIL_MAX_BYTES,
			})
		: null;
	return {
		observe(chunk: Uint8Array) {
			if (!frames || terminalSeen) return;
			try {
				for (const frame of frames.push(chunk)) {
					const data = frame
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) continue;
					const value = JSON.parse(data) as Record<string, unknown>;
					if (
						typeof value.sequence_number === "number" &&
						Number.isSafeInteger(value.sequence_number) &&
						value.sequence_number >= 0 &&
						value.sequence_number < Number.MAX_SAFE_INTEGER
					)
						nextSequence = Math.max(nextSequence, value.sequence_number + 1);
					const response = value.response as
						| Record<string, unknown>
						| undefined;
					if (response && typeof response === "object") {
						if (typeof response.id === "string" && response.id.length <= 256)
							responseId = response.id;
						if (
							typeof response.model === "string" &&
							response.model.length <= 256
						)
							model = response.model;
						if (
							typeof response.created_at === "number" &&
							Number.isFinite(response.created_at)
						)
							createdAt = response.created_at;
					}
					if (
						[
							"response.completed",
							"response.failed",
							"response.incomplete",
							"response.cancelled",
						].includes(String(value.type))
					)
						terminalSeen = true;
				}
			} catch {
				frames = null; /* Observation never changes routing or transport. */
			}
		},
		close() {
			frames = null;
		},
		terminal() {
			frames = null;
			if (terminalSeen) return "";
			if (responses) {
				const payload = {
					type: "response.failed",
					sequence_number: nextSequence,
					response: {
						id: responseId,
						object: "response",
						created_at: createdAt,
						model,
						status: "failed",
						error: {
							code: expiryBody.error.code,
							message: expiryBody.error.message,
						},
						output: [],
						usage: null,
					},
				};
				return `event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`;
			}
			if (path === "/v1/chat/completions")
				return `data: ${JSON.stringify({ error: expiryBody.error })}\n\n`;
			const payload =
				path === "/v1/messages" ? expiryBody : { error: expiryBody.error };
			return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
		},
	};
}
export function createManagedIngress(options: ManagedIngressOptions) {
	const claims = new Map<string, bigint>();
	const managed =
		options.enabled === true ||
		(options.enabled !== false && options.secret !== undefined);
	if (
		managed &&
		(options.secret?.byteLength !== 32 ||
			!Number.isSafeInteger(options.generation) ||
			options.generation < 1 ||
			!/^[0-9a-f]{32}$/.test(options.ingressNonce) ||
			!/^[0-9a-f]{32}$/.test(options.candidateNonce) ||
			!/^[0-9a-f]{40}$/.test(options.sourceSha))
	)
		throw new Error(
			"Managed ingress requires a valid generation, source, nonce and 32-byte credential",
		);
	if (managed) {
		bootIdentity();
		monotonicNowNs();
	}
	return async (
		original: Request,
		handler: (request: Request) => Promise<Response>,
	): Promise<Response> => {
		if (!managed) return handler(original);
		const url = new URL(original.url);
		// Local health/control API is not inference and is authenticated by its
		// existing API policy. The public guard always supplies timing for inference.
		if (!url.pathname.startsWith("/v1/")) {
			const response = await handler(original);
			if (url.pathname !== "/health" || response.status !== 200)
				return response;
			const health = await response.json();
			return Response.json(
				{
					...health,
					managedIngress: {
						generation: options.generation,
						candidateNonce: options.candidateNonce,
						timingContract: "v1",
						schemaDigest: process.env.CCFLARE_SCHEMA_DIGEST ?? null,
					},
				},
				{ status: response.status, headers: response.headers },
			);
		}
		const envelope = original.headers.get(MANAGED_TIMING_HEADER);
		const lookup = managedTimingBinding(envelope);
		const binding = {
			bootId: bootIdentity(),
			ingressNonce: options.ingressNonce,
			candidateNonce: options.candidateNonce,
			generation: options.generation,
			backendSourceSha: options.sourceSha,
			requestId: lookup.requestId ?? "",
			attemptOrdinal: lookup.attemptOrdinal ?? 0,
			method: original.method,
			path: `${url.pathname}${url.search}`,
		};
		const timing = verifyManagedTiming(
			envelope,
			binding,
			options.secret ?? new Uint8Array(),
			monotonicNowNs(),
		);
		if (!timing || !claimManagedTiming(claims, timing, binding))
			return Response.json(
				{
					type: "error",
					error: {
						type: "api_error",
						code: "managed_ingress_rejected",
						message: "Managed timing or dispatch identity is invalid.",
					},
				},
				{ status: 503 },
			);
		const protocol = acceptedExpiryProtocol(url.pathname, binding.requestId);
		const controller = new AbortController();
		const signal = AbortSignal.any([original.signal, controller.signal]);
		const headers = new Headers(original.headers);
		headers.delete(MANAGED_TIMING_HEADER);
		headers.delete("x-better-ccflare-timeout-ms");
		const request = new Request(original.url, {
			method: original.method,
			headers,
			signal,
			body: ["GET", "HEAD"].includes(original.method)
				? undefined
				: original.body,
			duplex: "half",
		} as RequestInit);

		let expired = false,
			settled = false,
			output: ReadableStreamDefaultController<Uint8Array> | null = null;
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
		let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
		let resolveExpiry: (response: Response) => void = () => {};
		const expiry = new Promise<Response>((resolve) => {
			resolveExpiry = resolve;
		});
		let ownedCancellation: Promise<void> | null = null;
		const cancelOwned = (cancel: () => Promise<unknown>): Promise<void> => {
			if (ownedCancellation) return ownedCancellation;
			let cancellation: Promise<unknown>;
			try {
				cancellation = Promise.resolve(cancel()).catch(() => {});
			} catch {
				cancellation = Promise.resolve();
			}
			ownedCancellation = new Promise<void>((resolve) => {
				cleanupTimer = setTimeout(
					() => {
						cleanupTimer = null;
						reader = null;
						try {
							options.onSecondary?.("cleanup_timeout");
						} catch {
							/* primary is already selected */
						}
						resolve();
					},
					Math.max(
						0,
						Number(BigInt(timing.cleanupDeadlineMonoNs) - monotonicNowNs()) /
							1_000_000,
					),
				);
				void cancellation.then(() => {
					if (cleanupTimer) clearTimeout(cleanupTimer);
					cleanupTimer = null;
					reader = null;
					resolve();
				});
			});
			return ownedCancellation;
		};
		const cancelReader = () => {
			const owned = reader;
			if (owned) cancelOwned(() => owned.cancel("accepted_request_deadline"));
		};
		const dispose = () => {
			if (settled) return;
			settled = true;
			protocol.close();
			clearTimeout(timer);
		};
		const expire = () => {
			if (expired || settled) return;
			expired = true;
			// Publish to the native one-shot collector before owned cancellation can
			// generate a losing downstream_cancelled terminal. Earlier causes win.
			publishManagedTerminal(request);
			const error = Object.assign(
				new Error("Accepted request deadline expired"),
				{ code: "ACCEPTED_REQUEST_DEADLINE" },
			);
			controller.abort(error);
			resolveExpiry(Response.json(expiryBody, { status: 504 }));
			if (output) {
				try {
					if (isSse)
						output.enqueue(new TextEncoder().encode(protocol.terminal()));
					else output.error(error);
					if (isSse) output.close();
				} catch {
					/* already closed */
				}
			}
			cancelReader();
			dispose();
		};
		let isSse = false;
		// Conservative one-tick margin gives the backend terminal arbiter first
		// chance before the guard aborts its local transport at the shared cutoff.
		const timer = setTimeout(
			expire,
			Math.max(
				0,
				Number(BigInt(timing.workDeadlineMonoNs) - monotonicNowNs()) /
					1_000_000 -
					10,
			),
		);
		bindManagedRequest(request, timing, () => expire());
		const responsePromise = Promise.resolve().then(() => handler(request));
		void responsePromise.then(
			(late) => {
				const lateBody = late.body;
				if (expired && lateBody)
					cancelOwned(() => lateBody.cancel("accepted_request_deadline"));
			},
			() => {},
		);
		let response: Response;
		try {
			response = await Promise.race([responsePromise, expiry]);
		} catch (error) {
			dispose();
			throw error;
		}
		if (expired || !response.body) {
			dispose();
			return response;
		}
		isSse =
			response.headers
				.get("content-type")
				?.toLowerCase()
				.includes("text/event-stream") === true;
		const ownedReader = response.body.getReader();
		reader = ownedReader;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				output = c;
			},
			async pull(c) {
				try {
					const result = await ownedReader.read();
					if (expired || settled) return;
					if (result.done) {
						c.close();
						dispose();
					} else {
						if (isSse) protocol.observe(result.value);
						c.enqueue(result.value);
					}
				} catch (error) {
					if (!expired && !settled) {
						c.error(error);
						dispose();
					}
				}
			},
			cancel(reason) {
				dispose();
				return cancelOwned(() => ownedReader.cancel(reason));
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
