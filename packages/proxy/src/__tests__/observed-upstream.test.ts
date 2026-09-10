import { describe, expect, it } from "bun:test";
import type {
	Provider,
	UpstreamObservation,
	UpstreamObservationContext,
} from "@better-ccflare/providers";
import { forwardObservedUpstream } from "../handlers/observed-upstream";

function makeContext(
	overrides: Partial<UpstreamObservationContext> = {},
): UpstreamObservationContext {
	return {
		requestId: "req-1",
		account: null,
		sourceBody: null,
		sourceHeaders: new Headers(),
		nativeResponses: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

/** Minimal Provider stub; only the fields forwardObservedUpstream touches. */
function makeProvider(observeUpstream?: Provider["observeUpstream"]): Provider {
	return {
		name: "stub",
		canHandle: () => true,
		buildUrl: (path: string) => `https://stub.invalid${path}`,
		prepareHeaders: (headers: Headers) => headers,
		observeUpstream,
	} as unknown as Provider;
}

describe("forwardObservedUpstream", () => {
	it("dispatches unmodified when the provider defines no observeUpstream hook", async () => {
		const provider = makeProvider(undefined);
		const request = new Request("https://stub.invalid/x");
		const upstreamResponse = new Response("ok", { status: 200 });
		let dispatchCalls = 0;
		const dispatch = async () => {
			dispatchCalls++;
			return upstreamResponse;
		};

		const result = await forwardObservedUpstream(
			provider,
			request,
			makeContext(),
			dispatch,
		);

		expect(dispatchCalls).toBe(1);
		expect(result).toBe(upstreamResponse);
	});

	it("calls dispatch even when observeUpstream itself throws (diagnostics failure is never fatal)", async () => {
		const provider = makeProvider(async () => {
			throw new Error("diagnostics boom");
		});
		const request = new Request("https://stub.invalid/x");
		const upstreamResponse = new Response("ok", { status: 200 });
		let dispatchCalls = 0;
		const dispatch = async () => {
			dispatchCalls++;
			return upstreamResponse;
		};

		const result = await forwardObservedUpstream(
			provider,
			request,
			makeContext(),
			dispatch,
		);

		expect(dispatchCalls).toBe(1);
		expect(result).toBe(upstreamResponse);
	});

	it("invokes observation.response() on a successful dispatch and returns its result", async () => {
		let responseCalledWith: Response | undefined;
		const observation: UpstreamObservation = {
			response: (response) => {
				responseCalledWith = response;
				return response;
			},
			error: () => {
				throw new Error("error() must not be called on success");
			},
		};
		const provider = makeProvider(async () => observation);
		const request = new Request("https://stub.invalid/x");
		const upstreamResponse = new Response("ok", { status: 200 });
		const dispatch = async () => upstreamResponse;

		const result = await forwardObservedUpstream(
			provider,
			request,
			makeContext(),
			dispatch,
		);

		expect(responseCalledWith).toBe(upstreamResponse);
		expect(result).toBe(upstreamResponse);
	});

	it("invokes observation.error() on a failed dispatch and still rejects with the original error", async () => {
		let errorCalledWith: unknown;
		const observation: UpstreamObservation = {
			response: () => {
				throw new Error("response() must not be called on failure");
			},
			error: (error) => {
				errorCalledWith = error;
			},
		};
		const provider = makeProvider(async () => observation);
		const request = new Request("https://stub.invalid/x");
		const dispatchError = new Error("upstream transport failure");
		const dispatch = async () => {
			throw dispatchError;
		};

		await expect(
			forwardObservedUpstream(provider, request, makeContext(), dispatch),
		).rejects.toBe(dispatchError);
		expect(errorCalledWith).toBe(dispatchError);
	});

	it("swallows a throw from observation.response() and forwards the real dispatch response", async () => {
		const observation: UpstreamObservation = {
			response: () => {
				throw new Error("observer response() boom");
			},
			error: () => {},
		};
		const provider = makeProvider(async () => observation);
		const request = new Request("https://stub.invalid/x");
		const upstreamResponse = new Response("ok", { status: 200 });
		const dispatch = async () => upstreamResponse;

		const result = await forwardObservedUpstream(
			provider,
			request,
			makeContext(),
			dispatch,
		);

		expect(result).toBe(upstreamResponse);
	});

	it("swallows a throw from observation.error() and still rejects with the original dispatch error", async () => {
		const observation: UpstreamObservation = {
			response: () => {
				throw new Error("response() must not be called on failure");
			},
			error: () => {
				throw new Error("observer error() boom");
			},
		};
		const provider = makeProvider(async () => observation);
		const request = new Request("https://stub.invalid/x");
		const dispatchError = new Error("upstream transport failure");
		const dispatch = async () => {
			throw dispatchError;
		};

		await expect(
			forwardObservedUpstream(provider, request, makeContext(), dispatch),
		).rejects.toBe(dispatchError);
	});

	it("passes the exact request and context through to observeUpstream unmodified", async () => {
		let receivedRequest: Request | undefined;
		let receivedContext: UpstreamObservationContext | undefined;
		const provider = makeProvider(async (request, context) => {
			receivedRequest = request;
			receivedContext = context;
			return undefined;
		});
		const request = new Request("https://stub.invalid/y");
		const context = makeContext({ requestId: "req-distinct" });
		const upstreamResponse = new Response("ok");
		await forwardObservedUpstream(
			provider,
			request,
			context,
			async () => upstreamResponse,
		);

		expect(receivedRequest).toBe(request);
		expect(receivedContext).toBe(context);
	});
});
