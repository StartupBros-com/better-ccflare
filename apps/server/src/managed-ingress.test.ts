import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	bootIdentity,
	createAcceptedTiming,
	monotonicNowNs,
	registerManagedTerminal,
	signManagedTiming,
} from "../../../scripts/ccflare-managed-timing.mjs";
import { createManagedIngress } from "./managed-ingress";

const secret = randomBytes(32),
	nonce = "a".repeat(32),
	source = "b".repeat(40);
function fixture(
	cap = "120",
	onSecondary?: (cause: "cleanup_timeout") => void,
) {
	const binding = {
		bootId: bootIdentity(),
		ingressNonce: "1".repeat(32),
		candidateNonce: nonce,
		generation: 1,
		backendSourceSha: source,
		requestId: "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a01",
		attemptOrdinal: 1,
		method: "POST",
		path: "/v1/messages",
	};
	const timing = createAcceptedTiming(monotonicNowNs(), cap);
	const req = new Request("http://localhost/v1/messages", {
		method: "POST",
		body: "{}",
		headers: {
			"x-better-ccflare-managed-timing": signManagedTiming(
				timing,
				binding,
				secret,
			),
		},
	});
	const ingress = createManagedIngress({
		secret,
		generation: 1,
		ingressNonce: "1".repeat(32),
		candidateNonce: nonce,
		sourceSha: source,
		onSecondary,
	});
	return { req, ingress };
}
test("managed rejection precedes auth/body/provider and replay sends zero work", async () => {
	const f = fixture("1000");
	let calls = 0;
	const action = async () => {
		calls++;
		return new Response("done");
	};
	expect(
		(await f.ingress(new Request("http://localhost/v1/messages"), action))
			.status,
	).toBe(503);
	expect(calls).toBe(0);
	expect((await f.ingress(f.req, action)).status).toBe(200);
	expect((await f.ingress(f.req, action)).status).toBe(503);
	expect(calls).toBe(1);
});
test("postcommit accepted expiry publishes first terminal before cancellation", async () => {
	const f = fixture();
	const order: string[] = [];
	let interval: ReturnType<typeof setInterval>;
	const response = await f.ingress(f.req, async (req) => {
		expect(req.headers.has("x-better-ccflare-managed-timing")).toBe(false);
		registerManagedTerminal(req, () => {
			order.push("terminal");
		});
		req.signal.addEventListener("abort", () => order.push("abort"));
		return new Response(
			new ReadableStream({
				start(c) {
					interval = setInterval(
						() => c.enqueue(new TextEncoder().encode(": ping\n\n")),
						10,
					);
				},
				cancel() {
					clearInterval(interval);
					order.push("cancel");
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	const text = await response.text();
	expect(response.status).toBe(200);
	expect(text.match(/accepted_request_deadline/g)).toHaveLength(1);
	expect(order.indexOf("terminal")).toBeLessThan(order.indexOf("abort"));
	expect(order.filter((v) => v === "cancel")).toHaveLength(1);
});

test("hung owned cancellation is bounded and classified secondary without changing primary", async () => {
	const secondary: string[] = [];
	const f = fixture("120", (cause) => secondary.push(cause));
	const response = await f.ingress(
		f.req,
		async () =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode(": ping\n\n"));
					},
					cancel() {
						return new Promise(() => {});
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	expect(await response.text()).toContain("accepted_request_deadline");
	await Bun.sleep(60);
	expect(secondary).toEqual(["cleanup_timeout"]);
});

test("explicit managed mode never falls back when startup identity or credential is absent", () => {
	for (const invalid of [
		{ secret: undefined },
		{ secret: new Uint8Array(31) },
		{ ingressNonce: "1".repeat(32), candidateNonce: "" },
		{ generation: 0 },
		{ sourceSha: "" },
	])
		expect(() =>
			createManagedIngress({
				enabled: true,
				secret,
				ingressNonce: "1".repeat(32),
				candidateNonce: nonce,
				generation: 1,
				sourceSha: source,
				...invalid,
			}),
		).toThrow();
	expect(() =>
		createManagedIngress({
			enabled: false,
			generation: 0,
			ingressNonce: "1".repeat(32),
			candidateNonce: "",
			sourceSha: "",
		}),
	).not.toThrow();
});

test("late response hung cancellation retains the original cleanup ceiling", async () => {
	const secondary: string[] = [];
	const f = fixture("120", (cause) => secondary.push(cause));
	const response = await f.ingress(f.req, async () => {
		await Bun.sleep(105);
		return new Response(
			new ReadableStream({
				cancel() {
					return new Promise(() => {});
				},
			}),
		);
	});
	expect(response.status).toBe(504);
	await Bun.sleep(70);
	expect(secondary).toEqual(["cleanup_timeout"]);
});

test("normal downstream cancellation settles within original cleanup ceiling without accepted cause", async () => {
	const secondary: string[] = [],
		primary: string[] = [];
	const f = fixture("120", (cause) => secondary.push(cause));
	const response = await f.ingress(f.req, async (req) => {
		registerManagedTerminal(req, (cause) => primary.push(cause));
		return new Response(
			new ReadableStream({
				cancel() {
					return new Promise(() => {});
				},
			}),
		);
	});
	await response.body?.cancel("downstream_closed");
	expect(secondary).toEqual(["cleanup_timeout"]);
	expect(primary).toEqual([]);
});

test.each([
	"/v1/messages",
	"/v1/responses",
	"/v1/chat/completions",
	"/v1/other",
])("real managed route %s emits its own committed SSE failure protocol", async (path) => {
	const binding = {
		bootId: bootIdentity(),
		ingressNonce: "1".repeat(32),
		candidateNonce: nonce,
		generation: 1,
		backendSourceSha: source,
		requestId: crypto.randomUUID(),
		attemptOrdinal: 1,
		method: "POST",
		path,
	};
	const ingress = createManagedIngress({
		enabled: true,
		secret,
		generation: 1,
		ingressNonce: "1".repeat(32),
		candidateNonce: nonce,
		sourceSha: source,
	});
	let cancelled = 0;
	const primary: string[] = [];
	const created = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 7, response: { id: "resp_fixture", model: "fixture_model", created_at: 1, status: "in_progress", output: [] } })}\n\n`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) =>
			ingress(request, async (req) => {
				registerManagedTerminal(req, (cause) => primary.push(cause));
				return new Response(
					new ReadableStream({
						start(c) {
							const bytes = new TextEncoder().encode(
								path === "/v1/responses" ? created : ": ping\n\n",
							);
							c.enqueue(bytes.slice(0, 13));
							c.enqueue(bytes.slice(13));
						},
						cancel() {
							cancelled++;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}),
	});
	try {
		const timing = createAcceptedTiming(monotonicNowNs(), "240");
		const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
			method: "POST",
			body: "{}",
			headers: {
				"x-better-ccflare-managed-timing": signManagedTiming(
					timing,
					binding,
					secret,
				),
			},
		});
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(primary).toEqual(["accepted_request_deadline"]);
		expect(cancelled).toBe(1);
		if (path === "/v1/responses") {
			expect(text).toContain("event: response.failed");
			const rawFailure = text
				.split("event: response.failed\ndata: ")[1]
				?.split("\n")[0];
			if (!rawFailure) throw new Error("missing Responses failure frame");
			const failure = JSON.parse(rawFailure);
			expect(failure.type).toBe("response.failed");
			expect(failure.response.id).toBe("resp_fixture");
			expect(failure.response.model).toBe("fixture_model");
			expect(failure.sequence_number).toBe(8);
			expect(failure.response.status).toBe("failed");
			expect(failure.response.error.code).toBe("accepted_request_deadline");
			expect(text).not.toContain("response.completed");
		} else if (path === "/v1/chat/completions") {
			expect(text).not.toContain("event: error");
			expect(text).not.toContain("[DONE]");
			const rawFailure = text.split("data: ").at(-1)?.trim();
			if (!rawFailure) throw new Error("missing Chat failure frame");
			const failure = JSON.parse(rawFailure);
			expect(failure.error.code).toBe("accepted_request_deadline");
			expect(failure.type).toBeUndefined();
		} else if (path === "/v1/messages")
			expect(text).toContain('"type":"error","error":{"type":"api_error"');
		else expect(text).not.toContain('"type":"error","error"');
	} finally {
		await server.stop(true);
	}
});
test("committed non-stream Responses compact closes with typed accepted failure", async () => {
	const path = "/v1/responses/compact",
		binding = {
			bootId: bootIdentity(),
			ingressNonce: "1".repeat(32),
			candidateNonce: nonce,
			generation: 1,
			backendSourceSha: source,
			requestId: crypto.randomUUID(),
			attemptOrdinal: 1,
			method: "POST",
			path,
		};
	const ingress = createManagedIngress({
		enabled: true,
		secret,
		generation: 1,
		ingressNonce: "1".repeat(32),
		candidateNonce: nonce,
		sourceSha: source,
	});
	const timing = createAcceptedTiming(monotonicNowNs(), "120");
	let cause = "";
	const response = await ingress(
		new Request(`http://localhost${path}`, {
			method: "POST",
			body: "{}",
			headers: {
				"x-better-ccflare-managed-timing": signManagedTiming(
					timing,
					binding,
					secret,
				),
			},
		}),
		async (req) => {
			registerManagedTerminal(req, (c) => {
				cause = c;
			});
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode('{"partial":'));
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	);
	expect(response.status).toBe(200);
	await expect(response.text()).rejects.toThrow(
		"Accepted request deadline expired",
	);
	expect(cause).toBe("accepted_request_deadline");
});
