import { describe, expect, test } from "bun:test";

import {
	sanitizeProxyHeaders,
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "../headers";

// P1 spoofing (proxy side): x-better-ccflare-pool-status is a reserved,
// guard-trusted signal. If an upstream provider response could carry it
// through to the client, a malicious or misbehaving upstream could spoof
// whole-pool exhaustion (or falsely deny it) to the guard sitting in front
// of the proxy. It must never pass through from an upstream response; only
// the proxy's own synthesized pool-exhausted responses may set it, and
// those never flow through this sanitizer.
describe("sanitizeProxyHeaders", () => {
	test("strips the reserved pool-status header from an upstream response", () => {
		const original = new Headers({
			"content-type": "application/json",
			"x-better-ccflare-pool-status": "exhausted",
			"x-better-ccflare-recovery-scope": "model",
		});

		const sanitized = sanitizeProxyHeaders(original);

		expect(sanitized.has("x-better-ccflare-pool-status")).toBe(false);
		expect(sanitized.has("x-better-ccflare-recovery-scope")).toBe(false);
		expect(sanitized.get("content-type")).toBe("application/json");
	});

	test("strips the header regardless of the value an upstream sets", () => {
		const original = new Headers({
			"x-better-ccflare-pool-status": "available",
		});

		expect(
			sanitizeProxyHeaders(original).has("x-better-ccflare-pool-status"),
		).toBe(false);
	});
});

describe("withSanitizedProxyHeaders", () => {
	test("produces a response without the reserved pool-status header", () => {
		const upstream = new Response("body", {
			status: 503,
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-pool-status": "exhausted",
				"x-better-ccflare-recovery-scope": "pool",
			},
		});

		const sanitized = withSanitizedProxyHeaders(upstream);

		expect(sanitized.headers.has("x-better-ccflare-pool-status")).toBe(false);
		expect(sanitized.headers.has("x-better-ccflare-recovery-scope")).toBe(
			false,
		);
		expect(sanitized.status).toBe(503);
	});
});

describe("guard request correlation privacy", () => {
	const header = "x-better-ccflare-guard-request-id";
	const guardId = "76110a75-9e91-4ab9-89a7-3e5d25a318fc";

	test("does not persist the private guard ID in request analytics", () => {
		const original = new Headers({
			"content-type": "application/json",
			[header]: guardId,
		});

		const sanitized = sanitizeRequestHeaders(original);

		expect(sanitized.has(header)).toBe(false);
		expect(sanitized.get("content-type")).toBe("application/json");
	});

	test("does not expose a same-named upstream response header to clients", () => {
		const upstream = new Response("body", {
			headers: { [header]: guardId },
		});

		const sanitized = withSanitizedProxyHeaders(upstream);

		expect(sanitized.headers.has(header)).toBe(false);
	});
});
