import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseQualityRouteCommand,
	runQualityRouteCommand,
} from "../quality-route-control";

it("actual CLI transport denies ambient proxies before sending, works directly, and refuses redirects", async () => {
	let proxyCalls = 0;
	let targetCalls = 0;
	let redirect = false;
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			proxyCalls++;
			return new Response("must not receive credentials", { status: 502 });
		},
	});
	const target = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			targetCalls++;
			expect(req.headers.get("authorization")).toBe(
				"Bearer synthetic-runtime-key",
			);
			return redirect
				? new Response(null, {
						status: 302,
						headers: { location: `http://127.0.0.1:${proxy.port}/redirect` },
					})
				: Response.json({
						status: "known",
						incarnation: "one",
						intentRevision: 1,
					});
		},
	});
	const directory = mkdtempSync(join(tmpdir(), "quality-cli-transport-"));
	try {
		for (const mode of ["proxy", "direct", "redirect"]) {
			redirect = mode === "redirect";
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					new URL("../main.ts", import.meta.url).pathname,
					"--quality-routing-status",
					"session-a",
					"--origin",
					`http://127.0.0.1:${target.port}`,
					"--credential-env",
					"SYNTHETIC_INFERENCE_KEY",
				],
				{
					cwd: directory,
					env: {
						HOME: directory,
						TMPDIR: directory,
						PATH: process.env.PATH ?? "",
						SYNTHETIC_INFERENCE_KEY: "synthetic-runtime-key",
						http_proxy:
							mode === "proxy" ? `http://127.0.0.1:${proxy.port}` : "",
						HTTP_PROXY:
							mode === "proxy" ? `http://127.0.0.1:${proxy.port}` : "",
						NO_PROXY: "",
						no_proxy: "",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stdout = await new Response(child.stdout).text();
			const stderr = await new Response(child.stderr).text();
			expect({
				exit: await child.exited,
				stdout,
				stderr,
				proxyCalls,
				targetCalls,
			}).toMatchObject({
				exit: mode === "direct" ? 0 : 1,
				proxyCalls: 0,
				targetCalls: mode === "proxy" ? 0 : mode === "direct" ? 1 : 2,
			});
			if (mode === "proxy")
				expect(JSON.parse(stdout)).toEqual({
					status: "proxy-environment-denied",
				});
			expect(stdout + stderr).not.toContain("synthetic-runtime-key");
		}
		expect(targetCalls).toBe(2);
		expect(proxyCalls).toBe(0);
	} finally {
		target.stop(true);
		proxy.stop(true);
		rmSync(directory, { recursive: true });
	}
});
it("the actual CLI command never loads a dotenv credential or starts inference", async () => {
	const directory = mkdtempSync(join(tmpdir(), "quality-cli-"));
	try {
		writeFileSync(
			join(directory, ".env"),
			"SYNTHETIC_INFERENCE_KEY=synthetic-file-secret\n",
		);
		const child = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				new URL("../main.ts", import.meta.url).pathname,
				"--quality-routing-status",
				"session-a",
				"--origin",
				"http://127.0.0.1:1",
				"--credential-env",
				"SYNTHETIC_INFERENCE_KEY",
			],
			{
				cwd: directory,
				env: {
					HOME: directory,
					TMPDIR: directory,
					PATH: process.env.PATH ?? "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(1);
		expect(stdout.trim()).toBe('{"status":"missing-credential"}');
		expect(stderr).not.toContain("synthetic-file-secret");
	} finally {
		rmSync(directory, { recursive: true });
	}
});
const args = [
	"--quality-routing-retry-preferred",
	"session-a",
	"--origin",
	"http://127.0.0.1:8788",
	"--credential-env",
	"SYNTHETIC_INFERENCE_KEY",
];
it("preserves session ID character and length boundaries", () => {
	const parseSession = (sessionId: string) =>
		parseQualityRouteCommand([args[0] ?? "", sessionId, ...args.slice(2)]);
	for (const sessionId of [
		"",
		...Array.from(
			{ length: 33 },
			(_, code) => `a${String.fromCharCode(code)}b`,
		),
		"a\u007fb",
		"a/b",
		"a\\b",
		"a%b",
		"a?b",
		"a#b",
		"%2f",
		"%252f",
		"a".repeat(257),
	])
		expect(() => parseSession(sessionId)).toThrow();
	for (const sessionId of [
		"a",
		"session-A_1.2:3",
		"a".repeat(256),
		"é",
		"a\u0080b",
		"a b",
	])
		expect(parseSession(sessionId)?.sessionId).toBe(sessionId);
});
function requireCommand() {
	const command = parseQualityRouteCommand(args);
	if (!command) throw new Error("Expected quality route command");
	return command;
}
it("reads only the named credential and redelivers the identical retry after lost response", async () => {
	const command = requireCommand();
	const calls: Request[] = [];
	const bodies: string[] = [];
	const result = await runQualityRouteCommand(command, {
		getEnv: (name) => {
			expect(name).toBe("SYNTHETIC_INFERENCE_KEY");
			return "synthetic-secret";
		},
		fetch: async (request) => {
			calls.push(request);
			expect(request.redirect).toBe("error");
			expect(request.headers.get("authorization")).toBe(
				"Bearer synthetic-secret",
			);
			if (request.method === "GET")
				return Response.json({
					status: "known",
					incarnation: "incarnation-a",
					intentRevision: 4,
				});
			bodies.push(await request.text());
			if (bodies.length === 1)
				throw new Error("lost response synthetic-secret");
			return Response.json({ status: "ready", intentRevision: 5 });
		},
	});
	expect(calls.length).toBe(3);
	expect(bodies[0]).toBe(bodies[1]);
	const firstBody = bodies[0];
	if (firstBody === undefined) throw new Error("Expected retry request body");
	expect(JSON.parse(firstBody)).toMatchObject({
		incarnation: "incarnation-a",
		expectedIntentRevision: 4,
	});
	expect(result).toMatchObject({
		exitCode: 0,
		data: { status: "ready", intentRevision: 5 },
	});
	expect(JSON.stringify(result)).not.toContain("synthetic-secret");
});
it("rejects non-loopback, userinfo, alternate protocol and hostname confusion before credential access", () => {
	for (const origin of [
		"https://example.com",
		"http://localhost.evil",
		"http://localhost@evil",
		"http://user:secret@localhost",
		"file:///tmp/a",
		"ftp://localhost",
		"http://127.1",
		"http://0x7f000001",
		"http://[::ffff:127.0.0.1]",
		"http://localhost/path",
		"http://localhost/?secret=x",
		"http://localhost/#x",
		"not a url",
	])
		expect(() =>
			parseQualityRouteCommand([...args.slice(0, 3), origin, ...args.slice(4)]),
		).toThrow();
	for (const origin of [
		"http://localhost:8788",
		"http://127.0.0.1:8788",
		"http://[::1]:8788",
		"https://[::1]:8788/",
	])
		expect(
			parseQualityRouteCommand([...args.slice(0, 3), origin, ...args.slice(4)]),
		).not.toBeNull();
});
it("preserves typed stale, conflict and disabled API outcomes without echoing arbitrary error text", async () => {
	for (const [httpStatus, status] of [
		[409, "stale"],
		[409, "conflict"],
		[404, "disabled"],
		[404, "unknown"],
		[401, "denied"],
	] as const) {
		const result = await runQualityRouteCommand(requireCommand(), {
			getEnv: () => "synthetic-secret",
			fetch: async () =>
				Response.json(
					{ status, detail: "synthetic-secret" },
					{ status: httpStatus },
				),
		});
		expect(result).toEqual({ exitCode: 1, data: { status, httpStatus } });
	}
});
it("does not follow redirects or expose server/transport errors containing the credential", async () => {
	for (const response of [
		new Response(null, { status: 302, headers: { location: "http://evil" } }),
		new Response("synthetic-secret", { status: 401 }),
	]) {
		const result = await runQualityRouteCommand(requireCommand(), {
			getEnv: () => "synthetic-secret",
			fetch: async () => response,
		});
		expect(result.exitCode).toBe(1);
		expect(JSON.stringify(result)).not.toContain("synthetic-secret");
	}
});
