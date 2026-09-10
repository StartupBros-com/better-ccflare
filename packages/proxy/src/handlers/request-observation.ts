import { Logger } from "@better-ccflare/logger";
import type { Provider, RequestObservation } from "@better-ccflare/providers";
import { getProvider } from "@better-ccflare/providers";

const log = new Logger("RequestObservation");

/**
 * Companion to `forwardObservedUpstream` (KTD8), which only fires once an
 * account has been selected and a physical attempt is about to be made.
 * `forwardObservedUpstream` therefore cannot see a purely local refusal --
 * pool exhaustion, a policy exclusion, an early validation error -- that
 * never reaches physical dispatch. This gives a provider's optional
 * `observeRequest` hook a look at the very top of `handleProxy`, before
 * account selection, so that class of refusal is observed too.
 *
 * Diagnostics-only, by construction, mirroring forwardObservedUpstream's
 * guarantees:
 * - Creating the observation is isolated: a throw is logged and swallowed,
 *   never propagated into the request path.
 * - The observation handle's `response()`/`error()` hooks are likewise
 *   isolated via `forwardObservedRequest`: a throw from either is logged and
 *   swallowed. The response (or thrown error) `dispatch()` actually produced
 *   is what the caller sees -- `response()`'s return value is used only when
 *   it doesn't throw, and it is never allowed to replace a successful
 *   dispatch with a rejection.
 * - Nothing here carries routing or continuation authority: the observation
 *   is a request-local handle, and `forwardObservedRequest`'s own return
 *   value is exactly what `dispatch()` produced (or that same value,
 *   observed, when a provider defines the hook).
 */
export function beginRequestObservation(
	provider: Provider,
	headers: Headers,
	nativeResponses: boolean,
): RequestObservation | undefined {
	try {
		// The protocol default can be Anthropic before account selection, even
		// for a request that will end up on the Codex pool. The registered
		// observer gates itself on its own diagnostics switch, so falling back
		// to the Codex provider's hook when `provider` doesn't define one costs
		// nothing when diagnostics are off.
		const observerProvider = provider.observeRequest
			? provider
			: getProvider("codex");
		return observerProvider?.observeRequest?.(headers, nativeResponses);
	} catch (error) {
		log.warn("observeRequest failed; continuing without diagnostics", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Binds the observation to the request's canonical id once known. Isolated
 * like every other observation hook -- a throw here must never affect the
 * request path. */
export function bindObservedRequestId(
	observation: RequestObservation | undefined,
	requestId: string,
): void {
	if (!observation) return;
	try {
		observation.bindRequestId(requestId);
	} catch (error) {
		log.warn("observeRequest bindRequestId() hook failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function forwardObservedRequest(
	observation: RequestObservation | undefined,
	dispatch: () => Promise<Response>,
): Promise<Response> {
	if (!observation) return dispatch();

	let response: Response;
	try {
		response = await dispatch();
	} catch (error) {
		try {
			observation.error(error);
		} catch (observerError) {
			log.warn("observeRequest error() hook failed", {
				error:
					observerError instanceof Error
						? observerError.message
						: String(observerError),
			});
		}
		throw error;
	}

	try {
		return observation.response(response);
	} catch (error) {
		log.warn(
			"observeRequest response() hook failed; forwarding the unobserved response",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return response;
	}
}
