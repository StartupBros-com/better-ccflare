import { describe, expect, test } from "bun:test";

import { sanitizeProxyHeaders, withSanitizedProxyHeaders } from "../headers";

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
		});

		const sanitized = sanitizeProxyHeaders(original);

		expect(sanitized.has("x-better-ccflare-pool-status")).toBe(false);
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
			},
		});

		const sanitized = withSanitizedProxyHeaders(upstream);

		expect(sanitized.headers.has("x-better-ccflare-pool-status")).toBe(false);
		expect(sanitized.status).toBe(503);
	});
});
