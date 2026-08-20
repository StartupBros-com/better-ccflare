/** Canonical maximum request body accepted for direct proxy and adapter defense. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

export type RequestBodyTooLargeSource = "declared" | "streamed";

/** A request body exceeded the configured byte limit before it could be replayed. */
export class RequestBodyTooLargeError extends Error {
	readonly source: RequestBodyTooLargeSource;
	readonly limit: number;

	constructor(source: RequestBodyTooLargeSource, limit: number) {
		super(`Request body exceeds the ${limit}-byte limit.`);
		this.name = "RequestBodyTooLargeError";
		this.source = source;
		this.limit = limit;
	}
}

/** JSON serialization crossed its bounded synthetic-body admission limit. */
export class BoundedJsonTooLargeError extends Error {}

function isJsonOmittable(value: unknown): boolean {
	return (
		typeof value === "undefined" ||
		typeof value === "function" ||
		typeof value === "symbol"
	);
}

function jsonLeafByteLength(value: unknown): number | undefined {
	const serialized = JSON.stringify(value);
	return serialized === undefined
		? undefined
		: Buffer.byteLength(serialized, "utf8");
}

/**
 * Serializes a synthetic JSON body without materializing output beyond `limit`.
 * It follows JSON.stringify's traversal semantics for values, toJSON methods,
 * omitted properties, arrays, circular references, and bigint values.
 */
export function serializeBoundedJson(value: unknown, limit: number): string {
	const ancestors = new Set<object>();
	const add = (total: number, increment: number): number => {
		if (increment > limit - total) throw new BoundedJsonTooLargeError();
		return total + increment;
	};
	const estimate = (current: unknown, key: string): number | undefined => {
		if (current === null || typeof current !== "object") {
			if (typeof current === "bigint") {
				throw new TypeError("Cannot serialize bigint as JSON");
			}
			return jsonLeafByteLength(current);
		}

		// JSON.stringify invokes toJSON before beginning circular-reference
		// tracking for the value it returns. A self-return is therefore traversed
		// once as the original object, not recursively re-serialized through toJSON.
		const toJson = (current as { toJSON?: unknown }).toJSON;
		if (typeof toJson === "function") {
			const replacement = toJson.call(current, key);
			if (replacement !== current) return estimate(replacement, key);
		}

		if (ancestors.has(current)) {
			throw new TypeError("Cannot serialize circular JSON");
		}
		ancestors.add(current);
		try {
			if (Array.isArray(current)) {
				let total = 2; // []
				for (let index = 0; index < current.length; index += 1) {
					if (index > 0) total = add(total, 1); // comma
					const item = current[index];
					const itemSize = isJsonOmittable(item)
						? Buffer.byteLength("null")
						: estimate(item, String(index));
					total = add(total, itemSize ?? Buffer.byteLength("null"));
				}
				if (total > limit) throw new BoundedJsonTooLargeError();
				return total;
			}

			let total = 2; // {}
			let properties = 0;
			for (const property of Object.keys(current)) {
				const propertyValue = (current as Record<string, unknown>)[property];
				if (isJsonOmittable(propertyValue)) continue;
				const propertySize = estimate(propertyValue, property);
				if (propertySize === undefined) continue;
				if (properties > 0) total = add(total, 1); // comma
				total = add(total, Buffer.byteLength(JSON.stringify(property), "utf8"));
				total = add(total, 1); // colon
				total = add(total, propertySize);
				properties += 1;
			}
			if (total > limit) throw new BoundedJsonTooLargeError();
			return total;
		} finally {
			ancestors.delete(current);
		}
	};

	const total = estimate(value, "");
	if (total === undefined) throw new TypeError("Cannot serialize JSON body");
	if (total > limit) throw new BoundedJsonTooLargeError();
	const serialized = JSON.stringify(value);
	if (typeof serialized !== "string") {
		throw new TypeError("Cannot serialize JSON body");
	}
	if (Buffer.byteLength(serialized, "utf8") > limit) {
		throw new BoundedJsonTooLargeError();
	}
	return serialized;
}

function getSafeContentLength(headers: Headers): number | null {
	const value = headers.get("content-length");
	if (value === null || !/^\d+$/.test(value)) return null;

	const length = Number(value);
	return Number.isSafeInteger(length) ? length : null;
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ?? new DOMException("The request was aborted.", "AbortError")
	);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		void reader.cancel().catch(() => {
			// The primary terminal is authoritative; cancellation is cleanup.
		});
	} catch {
		// The primary terminal is authoritative; cancellation is cleanup.
	}
}

/**
 * Reads a request body into one replayable ArrayBuffer without accepting more
 * than `limit` bytes. Unlike Response.arrayBuffer(), this never retains a
 * prefix once a streamed body crosses the admission ceiling.
 */
export async function readBoundedRequestBody(
	request: Pick<Request, "body" | "headers"> & { signal?: AbortSignal },
	limit = MAX_REQUEST_BODY_BYTES,
): Promise<ArrayBuffer | null> {
	const signal = request.signal;
	if (signal?.aborted) throw abortReason(signal);

	const declaredLength = getSafeContentLength(request.headers);
	if (declaredLength !== null && declaredLength > limit) {
		throw new RequestBodyTooLargeError("declared", limit);
	}

	const body = request.body;
	if (!body) return null;

	const reader = body.getReader();
	const directBuffer =
		declaredLength === null ? undefined : new Uint8Array(declaredLength);
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	let rejectAbort: ((reason: unknown) => void) | undefined;
	const aborted = signal
		? new Promise<never>((_, reject) => {
				rejectAbort = reject;
			})
		: undefined;
	const onAbort = () => {
		chunks.length = 0;
		if (signal) rejectAbort?.(abortReason(signal));
		cancelReader(reader);
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			const read = reader.read();
			const { done, value } = aborted
				? await Promise.race([read, aborted])
				: await read;
			if (done) break;

			// Fetch request bodies are Uint8Array streams. Ignore non-conforming
			// chunks rather than retaining an arbitrary runtime value.
			if (!(value instanceof Uint8Array)) continue;
			if (value.byteLength > limit - totalLength) {
				chunks.length = 0;
				cancelReader(reader);
				throw new RequestBodyTooLargeError("streamed", limit);
			}

			if (
				directBuffer &&
				chunks.length === 0 &&
				value.byteLength <= directBuffer.byteLength - totalLength
			) {
				directBuffer.set(value, totalLength);
			} else {
				// A body that disagrees with a safe Content-Length retains the legacy
				// bounded chunk path rather than turning an under/over-length body into
				// a different admission decision.
				if (chunks.length === 0 && directBuffer && totalLength > 0) {
					chunks.push(directBuffer.subarray(0, totalLength));
				}
				chunks.push(value);
			}
			totalLength += value.byteLength;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}

	if (directBuffer && chunks.length === 0) {
		// A matching Content-Length returns its original allocation. On an
		// underlength body, copy only the actual bytes so the unused reservation is
		// not retained by the replayable result.
		return totalLength === directBuffer.byteLength
			? directBuffer.buffer
			: directBuffer.slice(0, totalLength).buffer;
	}

	const buffer = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer.buffer;
}
