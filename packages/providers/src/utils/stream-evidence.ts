import type { RoutingStreamEvidence } from "@better-ccflare/types/request";

export type RawStreamEvidence = Pick<
	RoutingStreamEvidence,
	"rawEventCounts" | "rawVisibleEvents" | "providerTerminal"
>;
const readers = new WeakMap<
	ReadableStream<Uint8Array>,
	() => RawStreamEvidence
>();

/** In-process observation only; never grants replay authority or retains raw frames. */
export function attachStreamEvidenceReader(
	body: ReadableStream<Uint8Array>,
	read: () => RawStreamEvidence,
): void {
	readers.set(body, read);
}
export function readStreamEvidence(
	body: ReadableStream<Uint8Array>,
): RawStreamEvidence | null {
	try {
		return readers.get(body)?.() ?? null;
	} catch {
		return null;
	}
}
