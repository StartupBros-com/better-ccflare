/**
 * OAuth token endpoints are expected to return small error payloads. Keep the
 * refresh path bounded even when an upstream (or an intermediary) sends an
 * unexpectedly large body. The value is shared with the structured error
 * parsers so parsing and transport enforce the same ceiling.
 */
export const MAX_OAUTH_ERROR_INPUT_LENGTH = 64 * 1024;

export type BoundedOAuthResponseText = {
	text: string;
	/** True when the body was cut off at the byte ceiling or the stream failed. */
	truncated: boolean;
	/** Number of response bytes admitted to the bounded decoder. */
	bytesRead: number;
};

/**
 * Read an OAuth error response without using Response.text(), which buffers an
 * entire upstream body before returning. Only the first
 * MAX_OAUTH_ERROR_INPUT_LENGTH bytes are decoded and retained; once the limit
 * is reached the reader is cancelled so an oversized response cannot continue
 * accumulating in this process.
 *
 * A response from fetch always has a body for a non-empty HTTP response. The
 * null-body case is kept explicit for test doubles and unusual runtimes: it is
 * treated as an empty, non-truncated body rather than falling back to an
 * unbounded convenience method.
 */
export async function readBoundedOAuthResponseText(
	response: Pick<Response, "body">,
): Promise<BoundedOAuthResponseText> {
	const body = response.body;
	if (!body) {
		return { text: "", truncated: false, bytesRead: 0 };
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let bytesRead = 0;
	let truncated = false;

	try {
		while (bytesRead < MAX_OAUTH_ERROR_INPUT_LENGTH) {
			const { done, value } = await reader.read();
			if (done) break;

			// ReadableStream<Response> bodies are Uint8Array chunks. Be defensive
			// around a non-conforming test/runtime implementation without ever
			// retaining an arbitrary value.
			if (!(value instanceof Uint8Array)) continue;

			const remaining = MAX_OAUTH_ERROR_INPUT_LENGTH - bytesRead;
			const admitted = Math.min(remaining, value.byteLength);
			if (admitted > 0) {
				parts.push(
					decoder.decode(value.subarray(0, admitted), { stream: true }),
				);
				bytesRead += admitted;
			}

			// Do not probe for another chunk when the ceiling is exactly reached:
			// that would admit data beyond the bound before cancellation. Treat the
			// boundary as truncated conservatively; a body that ended exactly at the
			// limit is still safe to parse, while exact raw-code matching can require
			// the non-truncated flag.
			if (
				admitted < value.byteLength ||
				bytesRead >= MAX_OAUTH_ERROR_INPUT_LENGTH
			) {
				truncated = true;
				try {
					await reader.cancel();
				} catch {
					// Cancellation is best effort; the bounded buffers are already closed.
				}
				break;
			}
		}
	} catch {
		// Preserve whatever bounded prefix was decoded, but do not let a broken
		// upstream stream turn into an unbounded/error-body allocation path.
		truncated = true;
		try {
			await reader.cancel();
		} catch {
			// Ignore cancellation failures while preserving the safe prefix.
		}
	} finally {
		try {
			parts.push(decoder.decode());
		} catch {
			// TextDecoder should not throw for a Uint8Array, but a malformed runtime
			// must not prevent the caller from receiving the bounded prefix.
		}
		reader.releaseLock();
	}

	return { text: parts.join(""), truncated, bytesRead };
}
