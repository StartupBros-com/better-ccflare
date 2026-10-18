import { randomBytes } from "node:crypto";
import { getPrivateAiTraceRoutes } from "@better-ccflare/config";

/** Stamp only disposable HTTP headers; no body access, exporter, or routing change. */
export function applyPrivateAiTraceContext(
	headers: Headers,
	account: { id: string; provider: string } | null,
	url: string,
	requestId: string,
	sourceHeaders: Headers,
): void {
	if (account?.provider !== "openai-compatible") return;
	try {
		const origin = getPrivateAiTraceRoutes().get(account.id);
		if (!origin || new URL(url).origin !== origin) return;

		const parent =
			/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/.exec(
				sourceHeaders.get("traceparent") ?? "",
			);
		const validParent =
			parent &&
			parent[1] !== "ff" &&
			(parent[1] !== "00" || !parent[5]) &&
			parent[2] !== "0".repeat(32) &&
			parent[3] !== "0".repeat(16);
		const traceId = validParent ? parent[2] : requestId.replaceAll("-", "");
		// Canonical request IDs are UUIDs; fail open if an internal caller violates that contract.
		if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === "0".repeat(32)) return;
		let attemptId: string;
		do {
			attemptId = randomBytes(8).toString("hex");
		} while (attemptId === "0000000000000000");

		// Never accept client-injected values in our private correlation namespace.
		for (const name of [...headers.keys()]) {
			if (name.startsWith("x-private-ai-")) headers.delete(name);
		}
		headers.set("x-private-ai-request-id", requestId);
		headers.set("x-private-ai-attempt-id", attemptId);
		headers.set(
			"traceparent",
			`00-${traceId}-${attemptId}-${validParent ? parent[4] : "01"}`,
		);
		if (validParent) headers.set("x-private-ai-parent-span-id", parent[3]);
	} catch {
		// Optional correlation must never fail inference or log config/payload values.
	}
}
