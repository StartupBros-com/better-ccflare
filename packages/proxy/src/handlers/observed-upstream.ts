import { Logger } from "@better-ccflare/logger";
import type {
	Provider,
	UpstreamObservationContext,
} from "@better-ccflare/providers";

const log = new Logger("ObservedUpstream");

/**
 * Thin transport wrapper that gives a provider's optional `observeUpstream`
 * hook a look at the request/response closest to the physical wire (KTD8),
 * without ever being able to affect the request path itself.
 *
 * Diagnostics-only, by construction:
 * - `provider.observeUpstream` is invoked in isolation; a throw there is
 *   logged and swallowed, never propagated -- `dispatch()` still runs exactly
 *   as it would with no observer at all.
 * - The observation handle's `response()`/`error()` hooks are likewise
 *   isolated: a throw from either is logged and swallowed. The response (or
 *   thrown error) `dispatch()` actually produced is what the caller sees --
 *   `response()`'s return value is used only when it doesn't throw, and it
 *   is never allowed to replace a successful dispatch with a rejection.
 * - Nothing here carries routing or continuation authority: `context` is a
 *   read-only, request-local snapshot (see `UpstreamObservationContext`),
 *   and this function's own return value is exactly what `dispatch()`
 *   produced (or that same value, observed, when a provider defines the
 *   hook) -- never something the observer independently constructs.
 */
export async function forwardObservedUpstream(
	provider: Provider,
	request: Request,
	context: UpstreamObservationContext,
	dispatch: () => Promise<Response>,
): Promise<Response> {
	let observation:
		| Awaited<ReturnType<NonNullable<Provider["observeUpstream"]>>>
		| undefined;
	try {
		observation = await provider.observeUpstream?.(request, context);
	} catch (error) {
		log.warn("observeUpstream failed; continuing without diagnostics", {
			error: error instanceof Error ? error.message : String(error),
		});
		observation = undefined;
	}

	if (!observation) {
		return dispatch();
	}

	let response: Response;
	try {
		response = await dispatch();
	} catch (error) {
		try {
			observation.error(error);
		} catch (observerError) {
			log.warn("observeUpstream error() hook failed", {
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
			"observeUpstream response() hook failed; forwarding the unobserved response",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return response;
	}
}
