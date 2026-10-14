import crypto from "node:crypto";
import {
	readBoundedRequestBody,
	TIME_CONSTANTS,
	ValidationError,
} from "@better-ccflare/core";
import {
	GUARD_CORRELATION_SECRET_HEADER,
	GUARD_REQUEST_ID_HEADER,
	stripClientForwardingHeaders,
} from "@better-ccflare/http-common";
import type { Provider } from "@better-ccflare/providers";
import { registerResponseDrainTransport } from "@better-ccflare/providers/stream-drain";
import type { RequestMeta } from "@better-ccflare/types";
import { chatGptCloudflareCookieJar } from "../chatgpt-cloudflare-cookies";
import type { GuardCorrelationVerifier } from "./guard-correlation-auth";
import {
	ERROR_MESSAGES,
	INTERNAL_PROBE_SECRET_HEADER,
	RESPONSES_ADAPTER_SECRET_HEADER,
} from "./proxy-types";

/**
 * Internal proxy control headers that must NEVER be forwarded to the upstream
 * provider: they gate privileged proxy behaviour (see isInternalProbe), and a
 * provider or custom endpoint that received them — the probe secret above all —
 * could replay them with a marker to forge privileged requests.
 */
function stripInternalControlHeaders(headers: Headers): void {
	headers.delete(INTERNAL_PROBE_SECRET_HEADER);
	headers.delete(RESPONSES_ADAPTER_SECRET_HEADER);
	headers.delete("x-better-ccflare-auto-refresh");
	headers.delete("x-better-ccflare-keepalive");
	headers.delete(GUARD_REQUEST_ID_HEADER);
	headers.delete(GUARD_CORRELATION_SECRET_HEADER);
	// The rest of this list is every other in-use x-better-ccflare-* internal
	// signalling header read anywhere upstream of this call (account
	// selection, routing, provider request-shaping): this function runs at
	// the physical-dispatch boundary, strictly after every such read, on a
	// disposable Headers copy the caller never sees again -- so stripping
	// here cannot affect anything already read from the original headers.
	headers.delete("x-better-ccflare-request-id");
	headers.delete("x-better-ccflare-request-stream");
	headers.delete("x-better-ccflare-codex-custom-tools");
	headers.delete("x-better-ccflare-native-responses");
	headers.delete("x-better-ccflare-authenticated-caller");
	headers.delete("x-better-ccflare-exclude-providers");
	headers.delete("x-better-ccflare-codex-continuation");
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
		nativeAnthropicToolRequirement: null,
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
	const buffer = await readBoundedRequestBody(req);

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Bun's fetch arms its own 300 s idle timer unless `timeout: false` is passed.
 * On Bun 1.3.11 that timer cut a header-silent upstream at 300 s, and on a
 * reused keep-alive socket it counts from when the socket returned to the pool,
 * so a slow model was dropped at 260-300 s — long before
 * PROXY_REQUEST_TIMEOUT_MS or the precommit rescue's commitment window (#489).
 * Disabling it leaves those ccflare deadlines in charge of the header wait.
 * On 1.3.11 the same timer also reaped a body that went silent after headers,
 * including one whose reader was only cancelled; without it, that upstream is
 * held until it closes. Bun 1.4.2 cuts neither phase and closes the socket on
 * cancel, so the toolchain pin tracked in #489 closes that gap. The option
 * goes in fetch()'s init argument, where Bun reads it, not on the derived
 * Request; and bun-types does not declare it, hence the local type.
 */
const BUN_FETCH_TIMEOUT_DISABLED: RequestInit & { timeout: false } =
	Object.freeze({ timeout: false });

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
	// signal, but it bounds only the wait for headers: the finally below
	// clears it once fetch() resolves. After headers the upstream is released
	// only by an abort of the caller signal (client disconnect, routing and
	// commitment deadlines) or of the drain controller below. On Bun 1.3.11
	// reader.cancel() does not close the socket, only abort() does (#489).
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
			// Strip the CLIENT's own Cookie/CDN-Loop/Forwarded/X-Real-IP/CF-*/
			// X-Forwarded-* headers before any provider-owned cookie injection
			// below, so the fork's own Cloudflare clearance cookie is added to a
			// clean header set rather than merged with a client-forged one.
			stripClientForwardingHeaders(mutableHeaders);
			chatGptCloudflareCookieJar.applyCookieHeader(targetUrl, mutableHeaders);

			const response = await fetch(
				new Request(target, {
					headers: mutableHeaders,
					signal: effectiveSignal,
				}),
				BUN_FETCH_TIMEOUT_DISABLED,
			);
			chatGptCloudflareCookieJar.captureFromResponse(targetUrl, response);
			registerResponseDrainTransport(response, responseDrainController);
			return response;
		}

		const mutableHeaders = new Headers(headers);
		stripInternalControlHeaders(mutableHeaders);
		// See the matching comment in the Request-target branch above: strip
		// before the jar injects its own cookie, not after.
		stripClientForwardingHeaders(mutableHeaders);
		chatGptCloudflareCookieJar.applyCookieHeader(target, mutableHeaders);

		const response = await fetch(target, {
			...BUN_FETCH_TIMEOUT_DISABLED,
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
