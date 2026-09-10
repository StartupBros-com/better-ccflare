import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chatGptCloudflareCookieJar } from "../../chatgpt-cloudflare-cookies";
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

/**
 * Confirmed finding (three adversarial reviewers): a client's own Cookie,
 * X-Real-IP, Forwarded, CDN-Loop, CF-* and X-Forwarded-* headers reached the
 * literal fetch to chatgpt.com's Codex backend unchanged, because nothing on
 * the path from the guard to the final `fetch` ever stripped them. The
 * `chatGptCloudflareCookieJar.applyCookieHeader` allowlist only governs what
 * the fork itself INJECTS into the Cookie header; it merges into whatever the
 * client already sent, so it never removes a client-forged cookie and passes
 * the client's Cookie header through completely unmodified when the jar has
 * captured nothing for that host.
 */
describe("makeProxyRequest strips client-supplied forwarding headers before every upstream fetch", () => {
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

	function clientForwardingHeaders(): Record<string, string> {
		return {
			cookie: "session=client-forged-value",
			"x-real-ip": "203.0.113.9",
			forwarded: "for=203.0.113.9;proto=https",
			"cdn-loop": "cloudflare",
			"cf-connecting-ip": "203.0.113.9",
			"cf-ipcountry": "US",
			"x-forwarded-for": "203.0.113.9",
			"x-forwarded-proto": "https",
			authorization: "Bearer token",
			"content-type": "application/json",
		};
	}

	it("strips client forwarding headers on the headers-param path (Codex target)", async () => {
		const headers = new Headers(clientForwardingHeaders());
		await makeProxyRequest(
			"https://chatgpt.com/backend-api/codex/responses",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(sentHeaders?.get("cookie")).toBeNull();
		expect(sentHeaders?.get("x-real-ip")).toBeNull();
		expect(sentHeaders?.get("forwarded")).toBeNull();
		expect(sentHeaders?.get("cdn-loop")).toBeNull();
		expect(sentHeaders?.get("cf-connecting-ip")).toBeNull();
		expect(sentHeaders?.get("cf-ipcountry")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-for")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-proto")).toBeNull();
		// unrelated headers still forwarded
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("strips client forwarding headers on the Request-target path (Codex target)", async () => {
		const req = new Request("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			headers: clientForwardingHeaders(),
		});
		await makeProxyRequest(req);
		expect(sentHeaders?.get("cookie")).toBeNull();
		expect(sentHeaders?.get("x-real-ip")).toBeNull();
		expect(sentHeaders?.get("forwarded")).toBeNull();
		expect(sentHeaders?.get("cdn-loop")).toBeNull();
		expect(sentHeaders?.get("cf-connecting-ip")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-for")).toBeNull();
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});

	it("also strips client forwarding headers for a non-Codex provider target (same choke point protects every provider)", async () => {
		const headers = new Headers(clientForwardingHeaders());
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(sentHeaders?.get("cookie")).toBeNull();
		expect(sentHeaders?.get("x-real-ip")).toBeNull();
		expect(sentHeaders?.get("forwarded")).toBeNull();
		expect(sentHeaders?.get("cdn-loop")).toBeNull();
		expect(sentHeaders?.get("cf-connecting-ip")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-for")).toBeNull();
		// unrelated headers still forwarded -- stripping must not be overbroad
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("still injects the fork's own allowlisted Cloudflare cookie for chatgpt.com after stripping the client's Cookie header", async () => {
		// Seed the jar the way a real prior response would: an allowlisted
		// Cloudflare cookie captured from chatgpt.com.
		chatGptCloudflareCookieJar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			new Response(null, {
				headers: [
					["set-cookie", "cf_clearance=fork-owned-clearance; Path=/; Secure"],
				],
			}),
		);

		const headers = new Headers({
			cookie: "session=client-forged-value",
			authorization: "Bearer token",
		});
		await makeProxyRequest(
			"https://chatgpt.com/backend-api/codex/responses",
			"POST",
			headers,
			undefined,
			false,
		);

		const outboundCookie = sentHeaders?.get("cookie");
		expect(outboundCookie).not.toBeNull();
		expect(outboundCookie).toContain("cf_clearance=fork-owned-clearance");
		// The client's forged cookie name must not survive the merge either.
		expect(outboundCookie).not.toContain("session=client-forged-value");
	});
});
