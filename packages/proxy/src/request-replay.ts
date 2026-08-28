export type RequestReplayOptions = {
	readonly body?: BodyInit | null;
	readonly headers?: HeadersInit;
	readonly signal?: AbortSignal;
};

export type RequestReplay = {
	readonly bodyText: string | null;
	readonly url: string;
	readonly method: string;
	copyHeaders(): Headers;
	createRequest(options?: RequestReplayOptions): Request;
	withBodyText(bodyText: string | null): RequestReplay;
};

export type MaterializedRequest = {
	readonly request: Request;
	readonly replay: RequestReplay;
};

type RequestReplaySnapshot = {
	readonly bodyText: string | null;
	readonly headers: Headers;
	readonly method: string;
	readonly signal: AbortSignal;
	readonly url: string;
};

function createRequestFromSnapshot(
	snapshot: RequestReplaySnapshot,
	options: RequestReplayOptions = {},
): Request {
	const hasBodyOverride = Object.prototype.hasOwnProperty.call(options, "body");
	const body = hasBodyOverride ? (options.body ?? null) : snapshot.bodyText;
	const headers = new Headers(options.headers ?? snapshot.headers);
	// Request bodies are rebuilt from the replay snapshot. An inherited length
	// describes the consumed source, not necessarily the rebuilt transport body.
	headers.delete("content-length");

	const init: RequestInit & { duplex?: "half" } = {
		method: snapshot.method,
		headers,
		signal: options.signal ?? snapshot.signal,
	};
	if (body !== null) {
		init.body = body;
		if (body instanceof ReadableStream) {
			init.duplex = "half";
		}
	}
	return new Request(snapshot.url, init);
}

function fromSnapshot(snapshot: RequestReplaySnapshot): RequestReplay {
	return {
		bodyText: snapshot.bodyText,
		url: snapshot.url,
		method: snapshot.method,
		copyHeaders: () => new Headers(snapshot.headers),
		createRequest: (options) => createRequestFromSnapshot(snapshot, options),
		withBodyText: (bodyText) =>
			fromSnapshot({
				...snapshot,
				bodyText,
				headers: new Headers(snapshot.headers),
			}),
	};
}

/**
 * Capture request metadata for a replay factory without reading or teeing its
 * body. Callers that need a body override can supply it to createRequest().
 */
export function createRequestReplay(
	request: Request,
	bodyText: string | null,
): RequestReplay {
	return fromSnapshot({
		bodyText,
		headers: new Headers(request.headers),
		method: request.method,
		signal: request.signal,
		url: request.url,
	});
}

/**
 * Consume a transformed request exactly once, then create both the immediate
 * outbound request and every future retry from independently-owned text.
 */
export async function materializeRequestForTransport(
	request: Request,
): Promise<MaterializedRequest> {
	const bodyText = request.body === null ? null : await request.text();
	const replay = createRequestReplay(request, bodyText);
	return { request: replay.createRequest(), replay };
}
