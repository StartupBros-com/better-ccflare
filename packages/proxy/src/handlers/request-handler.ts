import crypto from "node:crypto";
import { TIME_CONSTANTS, ValidationError } from "@better-ccflare/core";
import {
	GUARD_CORRELATION_SECRET_HEADER,
	GUARD_REQUEST_ID_HEADER,
} from "@better-ccflare/http-common";
import type { Provider } from "@better-ccflare/providers";
import { registerResponseDrainTransport } from "@better-ccflare/providers/stream-drain";
import type { RequestMeta } from "@better-ccflare/types";
import { chatGptCloudflareCookieJar } from "../chatgpt-cloudflare-cookies";
import type { GuardCorrelationVerifier } from "./guard-correlation-auth";
import { ERROR_MESSAGES, INTERNAL_PROBE_SECRET_HEADER } from "./proxy-types";

/**
 * Internal proxy control headers that must NEVER be forwarded to the upstream
 * provider: they gate privileged proxy behaviour (see isInternalProbe), and a
 * provider or custom endpoint that received them — the probe secret above all —
 * could replay them with a marker to forge privileged requests.
 */
function stripInternalControlHeaders(headers: Headers): void {
	headers.delete(INTERNAL_PROBE_SECRET_HEADER);
	headers.delete("x-better-ccflare-auto-refresh");
	headers.delete("x-better-ccflare-keepalive");
	headers.delete(GUARD_REQUEST_ID_HEADER);
	headers.delete(GUARD_CORRELATION_SECRET_HEADER);
}

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
export function createRequestMetadata(
	req: Request,
	url: URL,
	verifyGuardCorrelation?: GuardCorrelationVerifier,
): RequestMeta {
	const guardCorrelation = verifyGuardCorrelation?.(req.headers);
	return {
		id: guardCorrelation?.requestId ?? crypto.randomUUID(),
		guardAttemptOrdinal: guardCorrelation?.attemptOrdinal,
		method: req.method,
		path: url.pathname,
		timestamp: Date.now(),
		headers: req.headers,
	};
}

/**
 * Validates that the provider can handle the requested path
 * @param provider - The provider instance
 * @param pathname - The request path
 * @throws {ValidationError} If provider cannot handle the path
 */
export function validateProviderPath(
	provider: Provider,
	pathname: string,
): void {
	if (!provider.canHandle(pathname)) {
		throw new ValidationError(
			`${ERROR_MESSAGES.PROVIDER_CANNOT_HANDLE}: ${pathname}`,
			"path",
			pathname,
		);
	}
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
export async function prepareRequestBody(req: Request): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	let buffer: ArrayBuffer | null = null;

	if (req.body) {
		buffer = await req.arrayBuffer();
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
export async function makeProxyRequest(
	target: string | Request,
	method?: string,
	headers?: Headers,
	createBodyStream?: () => ReadableStream<Uint8Array> | undefined,
	hasBody?: boolean,
	signal?: AbortSignal,
): Promise<Response> {
	// The header-phase timeout is always armed, independent of any caller
	// signal, so it can abort the fetch even after headers arrive — a client
	// that disconnects mid-stream (Claude Code's idle watchdog, Ctrl-C, a
	// dropped network) would otherwise leak the upstream connection, since
	// reader.cancel() doesn't close the socket in Bun, only abort() does.
	const headerTimeoutController = new AbortController();
	const timeoutId = setTimeout(
		() => headerTimeoutController.abort(),
		TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,
	);
	// Combine every abort source that can legitimately end this fetch: an
	// explicit caller signal, the signal already carried by a Request target
	// (Request derivation preserves it), the header-phase timeout above, and a
	// controller owned only by this response's discard lifecycle. The latter is
	// registered after fetch resolves so a bounded abandoned-body drain can tear
	// down this exact transport without poisoning a later retry.
	const responseDrainController = new AbortController();
	const signals = [
		...(signal ? [signal] : []),
		...(target instanceof Request ? [target.signal] : []),
		headerTimeoutController.signal,
		responseDrainController.signal,
	];
	const effectiveSignal =
		signals.length === 1 ? signals[0] : AbortSignal.any(signals);

	try {
		if (target instanceof Request) {
			const targetUrl = target.url;
			const mutableHeaders = new Headers(target.headers);
			stripInternalControlHeaders(mutableHeaders);
			chatGptCloudflareCookieJar.applyCookieHeader(targetUrl, mutableHeaders);

			const response = await fetch(
				new Request(target, {
					headers: mutableHeaders,
					signal: effectiveSignal,
				}),
			);
			chatGptCloudflareCookieJar.captureFromResponse(targetUrl, response);
			registerResponseDrainTransport(response, responseDrainController);
			return response;
		}

		const mutableHeaders = new Headers(headers);
		stripInternalControlHeaders(mutableHeaders);
		chatGptCloudflareCookieJar.applyCookieHeader(target, mutableHeaders);

		const response = await fetch(target, {
			method,
			headers: mutableHeaders,
			body: createBodyStream ? createBodyStream() : undefined,
			signal: effectiveSignal,
			...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
		});
		chatGptCloudflareCookieJar.captureFromResponse(target, response);
		registerResponseDrainTransport(response, responseDrainController);
		return response;
	} finally {
		clearTimeout(timeoutId);
	}
}
