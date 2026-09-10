import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { makeProxyRequest } from "../request-handler";

/**
 * Regression for tombii#336 / Greptile P1 "Probe Secret Reaches Provider Path":
 * the internal probe secret (and the marker headers it gates) must be stripped
 * before the request is forwarded upstream, so a provider or custom endpoint
 * never receives the process-local capability secret.
 */
describe("makeProxyRequest strips internal control headers before provider forward", () => {
	let realFetch: typeof globalThis.fetch;
	let sentHeaders: Headers | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		sentHeaders = undefined;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			sentHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("does not forward the probe secret or markers on the headers-param path", async () => {
		const headers = new Headers({
			"x-better-ccflare-internal-probe-secret": "s3cr3t",
			"x-better-ccflare-responses-adapter-secret": "s3cr3t",
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-guard-request-id": "signed-envelope",
			"x-better-ccflare-guard-correlation-secret": "must-never-be-http",
			"x-better-ccflare-request-id": "req-1",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-codex-custom-tools": "true",
			"x-better-ccflare-native-responses": "true",
			"x-better-ccflare-authenticated-caller": "apikey-1",
			"x-better-ccflare-exclude-providers": "codex",
			"x-better-ccflare-codex-continuation": "1",
			authorization: "Bearer token",
			"content-type": "application/json",
		});
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-responses-adapter-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-auto-refresh")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-guard-request-id")).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-guard-correlation-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-id")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-stream")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-codex-custom-tools")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-native-responses")).toBeNull();
		// Regression for the risk the upstream port itself calls out: an
		// external caller forging this header must never have it reach the
		// provider either (see CODEX_AUTHENTICATED_CALLER_HEADER's own
		// "deleted before any outbound transport" contract in provider.ts).
		expect(
			sentHeaders?.get("x-better-ccflare-authenticated-caller"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-exclude-providers")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-codex-continuation")).toBeNull();
		// unrelated headers still forwarded
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("does not forward the probe secret on the Request-target path", async () => {
		const req = new Request("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-better-ccflare-internal-probe-secret": "s3cr3t",
				"x-better-ccflare-responses-adapter-secret": "s3cr3t",
				"x-better-ccflare-keepalive": "true",
				"x-better-ccflare-guard-request-id": "signed-envelope",
				"x-better-ccflare-guard-correlation-secret": "must-never-be-http",
				"x-better-ccflare-request-id": "req-1",
				"x-better-ccflare-authenticated-caller": "apikey-1",
				authorization: "Bearer token",
			},
		});
		await makeProxyRequest(req);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-responses-adapter-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-guard-request-id")).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-guard-correlation-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-id")).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-authenticated-caller"),
		).toBeNull();
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});
});
