import { describe, expect, it } from "bun:test";
import type { Provider, RequestObservation } from "@better-ccflare/providers";
import {
	beginRequestObservation,
	bindObservedRequestId,
	forwardObservedRequest,
} from "../request-observation";

/** Minimal Provider stub; only the fields these helpers touch. */
function makeProvider(observeRequest?: Provider["observeRequest"]): Provider {
	return {
		name: "stub",
		canHandle: () => true,
		buildUrl: (path: string) => `https://stub.invalid${path}`,
		prepareHeaders: (headers: Headers) => headers,
		observeRequest,
	} as unknown as Provider;
}

describe("beginRequestObservation", () => {
	it("returns undefined and falls back to the registered codex provider's hook when the given provider defines none (diagnostics off by default, so still undefined)", () => {
		// The registered CodexProvider is a real import-time side effect of
		// `@better-ccflare/providers`; with CCFLARE_CODEX_CACHE_DIAGNOSTICS unset
		// its own observeRequest is a no-op, so this also proves the fallback
		// path itself never throws even though it resolves a real provider.
		const provider = makeProvider(undefined);
		const observation = beginRequestObservation(provider, new Headers(), false);
		expect(observation).toBeUndefined();
	});

	it("uses the given provider's own hook when it defines one, without falling back", () => {
		let called = false;
		const observation = beginRequestObservation(
			makeProvider(() => {
				called = true;
				return undefined;
			}),
			new Headers(),
			false,
		);
		expect(called).toBe(true);
		expect(observation).toBeUndefined();
	});

	it("passes headers and nativeResponses through to the hook unmodified", () => {
		let receivedHeaders: Headers | undefined;
		let receivedNativeResponses: boolean | undefined;
		const headers = new Headers({ "x-test": "1" });
		beginRequestObservation(
			makeProvider((h, nativeResponses) => {
				receivedHeaders = h;
				receivedNativeResponses = nativeResponses;
				return undefined;
			}),
			headers,
			true,
		);
		expect(receivedHeaders).toBe(headers);
		expect(receivedNativeResponses).toBe(true);
	});

	it("swallows a throw from observeRequest and returns undefined (diagnostics failure is never fatal)", () => {
		const provider = makeProvider(() => {
			throw new Error("observeRequest boom");
		});
		expect(() =>
			beginRequestObservation(provider, new Headers(), false),
		).not.toThrow();
		expect(
			beginRequestObservation(provider, new Headers(), false),
		).toBeUndefined();
	});
});

describe("bindObservedRequestId", () => {
	it("is a no-op when there is no observation", () => {
		expect(() => bindObservedRequestId(undefined, "req-1")).not.toThrow();
	});

	it("calls bindRequestId with the given id", () => {
		let receivedId: string | undefined;
		const observation: RequestObservation = {
			bindRequestId: (id) => {
				receivedId = id;
			},
			response: (response) => response,
			error: () => {},
		};
		bindObservedRequestId(observation, "req-distinct");
		expect(receivedId).toBe("req-distinct");
	});

	it("swallows a throw from bindRequestId", () => {
		const observation: RequestObservation = {
			bindRequestId: () => {
				throw new Error("bindRequestId boom");
			},
			response: (response) => response,
			error: () => {},
		};
		expect(() => bindObservedRequestId(observation, "req-1")).not.toThrow();
	});
});

describe("forwardObservedRequest", () => {
	it("dispatches unmodified when there is no observation", async () => {
		const upstreamResponse = new Response("ok", { status: 200 });
		let dispatchCalls = 0;
		const dispatch = async () => {
			dispatchCalls++;
			return upstreamResponse;
		};

		const result = await forwardObservedRequest(undefined, dispatch);

		expect(dispatchCalls).toBe(1);
		expect(result).toBe(upstreamResponse);
	});

	it("invokes observation.response() on a successful dispatch and returns its result", async () => {
		let responseCalledWith: Response | undefined;
		const observation: RequestObservation = {
			bindRequestId: () => {},
			response: (response) => {
				responseCalledWith = response;
				return response;
			},
			error: () => {
				throw new Error("error() must not be called on success");
			},
		};
		const upstreamResponse = new Response("ok", { status: 200 });
		const dispatch = async () => upstreamResponse;

		const result = await forwardObservedRequest(observation, dispatch);

		expect(responseCalledWith).toBe(upstreamResponse);
		expect(result).toBe(upstreamResponse);
	});

	it("invokes observation.error() on a failed dispatch and still rejects with the original error", async () => {
		let errorCalledWith: unknown;
		const observation: RequestObservation = {
			bindRequestId: () => {},
			response: () => {
				throw new Error("response() must not be called on failure");
			},
			error: (error) => {
				errorCalledWith = error;
			},
		};
		const dispatchError = new Error("local refusal");
		const dispatch = async () => {
			throw dispatchError;
		};

		await expect(forwardObservedRequest(observation, dispatch)).rejects.toBe(
			dispatchError,
		);
		expect(errorCalledWith).toBe(dispatchError);
	});

	it("swallows a throw from observation.response() and forwards the real dispatch response", async () => {
		const observation: RequestObservation = {
			bindRequestId: () => {},
			response: () => {
				throw new Error("observer response() boom");
			},
			error: () => {},
		};
		const upstreamResponse = new Response("ok", { status: 200 });
		const dispatch = async () => upstreamResponse;

		const result = await forwardObservedRequest(observation, dispatch);

		expect(result).toBe(upstreamResponse);
	});

	it("swallows a throw from observation.error() and still rejects with the original dispatch error", async () => {
		const observation: RequestObservation = {
			bindRequestId: () => {},
			response: () => {
				throw new Error("response() must not be called on failure");
			},
			error: () => {
				throw new Error("observer error() boom");
			},
		};
		const dispatchError = new Error("local refusal");
		const dispatch = async () => {
			throw dispatchError;
		};

		await expect(forwardObservedRequest(observation, dispatch)).rejects.toBe(
			dispatchError,
		);
	});
});
