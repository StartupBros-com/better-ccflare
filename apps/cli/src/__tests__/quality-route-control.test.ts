import { expect, it } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	parseQualityRouteCommand,
	runQualityRouteCommand,
} from "../quality-route-control";

// Host builds the binary separately. Reuse the same isolated transport/credential
// tests for the compiled entrypoint instead of treating source-only tests as proof.
function cliEntrypoint(): string[] {
	const binary = process.env.BETTER_CCFLARE_TEST_COMPILED_CLI;
	if (binary) {
		if (!isAbsolute(binary))
			throw new Error("Compiled CLI test path must be absolute");
		return [binary];
	}
	return [
		process.execPath,
		"--no-env-file",
		new URL("../main.ts", import.meta.url).pathname,
	];
}

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
					...cliEntrypoint(),
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
	let calls = 0;
	const target = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			calls++;
			return Response.json({
				status: "known",
				incarnation: "synthetic",
				intentRevision: 1,
			});
		},
	});
	const directory = mkdtempSync(join(tmpdir(), "quality-cli-"));
	try {
		for (const file of [".env", ".env.local", ".env.production"]) {
			writeFileSync(
				join(directory, file),
				"SYNTHETIC_INFERENCE_KEY=synthetic-file-secret\n",
			);
		}
		const child = Bun.spawn(
			[
				...cliEntrypoint(),
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
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(1);
		expect(stdout.trim()).toBe('{"status":"missing-credential"}');
		expect(stdout + stderr).not.toContain("synthetic-file-secret");
		expect(calls).toBe(0);
	} finally {
		target.stop(true);
		rmSync(directory, { recursive: true });
	}
});
// Characterize ordinary startup with the real binary (or source runtime), not a
// replacement dotenv parser. --list only opens an empty synthetic local database.
for (const scenario of [
	{
		name: "default development",
		nodeEnv: undefined,
		files: [".env", ".env.development", ".env.production"],
		winner: "development",
	},
	{ name: "base", nodeEnv: "production", files: [".env"], winner: "base" },
	{
		name: "production",
		nodeEnv: "production",
		files: [".env", ".env.production"],
		winner: "production",
	},
	{
		name: "local",
		nodeEnv: "production",
		files: [".env", ".env.production", ".env.local"],
		winner: "local",
	},
	{
		name: "development",
		nodeEnv: "development",
		files: [".env", ".env.development"],
		winner: "development",
	},
	{
		name: "test ignores local",
		nodeEnv: "test",
		files: [".env", ".env.test", ".env.local"],
		winner: "test",
	},
	{
		name: "process wins",
		nodeEnv: "production",
		files: [".env", ".env.production", ".env.local"],
		winner: "process",
	},
]) {
	it(`ordinary CLI preserves dotenv precedence and expansion: ${scenario.name}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "quality-cli-ordinary-"));
		try {
			for (const file of scenario.files) {
				const label = file === ".env" ? "base" : file.slice(5);
				writeFileSync(
					join(directory, file),
					`SYNTHETIC_STEM=${label}\nBETTER_CCFLARE_DB_PATH="$SYNTHETIC_DIRECTORY/\${SYNTHETIC_STEM}.db"\n`,
				);
			}
			const entrypoint = process.env.BETTER_CCFLARE_TEST_COMPILED_CLI
				? cliEntrypoint()
				: [process.execPath, new URL("../main.ts", import.meta.url).pathname];
			const child = Bun.spawn([...entrypoint, "--list"], {
				cwd: directory,
				env: {
					HOME: directory,
					XDG_CONFIG_HOME: directory,
					TMPDIR: directory,
					PATH: process.env.PATH ?? "",
					NODE_ENV: scenario.nodeEnv,
					SYNTHETIC_DIRECTORY: directory,
					...(scenario.winner === "process"
						? { BETTER_CCFLARE_DB_PATH: join(directory, "process.db") }
						: {}),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(child.stdout).text();
			const stderr = await new Response(child.stderr).text();
			expect({ exit: await child.exited, stdout, stderr }).toMatchObject({
				exit: 0,
			});
			expect(stdout).toContain("No accounts configured");
			expect(existsSync(join(directory, `${scenario.winner}.db`))).toBe(true);
		} finally {
			rmSync(directory, { recursive: true });
		}
	});
}

it.skipIf(!process.env.BETTER_CCFLARE_TEST_COMPILED_CLI)(
	"compiled ordinary CLI preserves project dotenv fallback",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "quality-cli-fallback-"));
		try {
			const cwd = join(directory, "work", "cwd");
			mkdirSync(cwd, { recursive: true });
			const executable = cliEntrypoint()[0];
			if (!executable) throw new Error("Compiled CLI required");
			const database = join(directory, "synthetic.db");
			writeFileSync(
				join(directory, ".env"),
				`BETTER_CCFLARE_DB_PATH=${database}\n`,
			);
			const env = {
				HOME: directory,
				XDG_CONFIG_HOME: directory,
				TMPDIR: directory,
				PATH: process.env.PATH ?? "",
			};
			const ordinary = Bun.spawn([executable, "--list"], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(ordinary.stdout).text();
			const stderr = await new Response(ordinary.stderr).text();
			expect({ exit: await ordinary.exited, stdout, stderr }).toMatchObject({
				exit: 0,
			});
			expect(stdout).toContain("No accounts configured");
			expect(existsSync(database)).toBe(true);
			// The same fallback location is never searched in control mode.
			const control = Bun.spawn(
				[
					executable,
					"--quality-routing-status",
					"synthetic-session",
					"--origin",
					"http://127.0.0.1:1",
					"--credential-env",
					"BETTER_CCFLARE_DB_PATH",
				],
				{ cwd, env, stdout: "pipe", stderr: "pipe" },
			);
			const result = await new Response(control.stdout).text();
			expect(await control.exited).toBe(1);
			expect(result.trim()).toBe('{"status":"missing-credential"}');
		} finally {
			rmSync(directory, { recursive: true });
		}
	},
);

it("ordinary CLI finds dotenv beside its physical executable or source entrypoint, but controls never do", async () => {
	const directory = mkdtempSync(join(tmpdir(), "quality-cli-exec-fallback-"));
	try {
		const app = join(directory, "app");
		const cwd = join(directory, "work", "cwd");
		mkdirSync(app);
		mkdirSync(cwd, { recursive: true });
		const binary = process.env.BETTER_CCFLARE_TEST_COMPILED_CLI;
		let entrypoint: string[];
		if (binary) {
			const executable = join(app, "arbitrary-cli-name");
			copyFileSync(binary, executable);
			entrypoint = [executable];
		} else {
			const script = join(app, "source-entry.ts");
			writeFileSync(
				script,
				`const { startCli } = await import(${JSON.stringify(new URL("../main.ts", import.meta.url).pathname)}); startCli();`,
			);
			entrypoint = [process.execPath, "--no-env-file", script];
		}
		const database = join(directory, "physical-directory.db");
		writeFileSync(
			join(app, ".env"),
			`BETTER_CCFLARE_DB_PATH=${database}\nSYNTHETIC_INFERENCE_KEY=synthetic-file-secret\n`,
		);
		const env = {
			HOME: directory,
			XDG_CONFIG_HOME: directory,
			TMPDIR: directory,
			PATH: process.env.PATH ?? "",
		};
		for (const action of ["status", "retry-preferred"]) {
			const control = Bun.spawn(
				[
					...entrypoint,
					`--quality-routing-${action}`,
					"synthetic-session",
					"--origin",
					"http://127.0.0.1:1",
					"--credential-env",
					"SYNTHETIC_INFERENCE_KEY",
				],
				{ cwd, env, stdout: "pipe", stderr: "pipe" },
			);
			const stdout = await new Response(control.stdout).text();
			const stderr = await new Response(control.stderr).text();
			expect(await control.exited).toBe(1);
			expect(stdout.trim()).toBe('{"status":"missing-credential"}');
			expect(stdout + stderr).not.toContain("synthetic-file-secret");
			expect(existsSync(database)).toBe(false);
		}
		const ordinary = Bun.spawn([...entrypoint, "--list"], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(ordinary.stdout).text();
		const stderr = await new Response(ordinary.stderr).text();
		expect({ exit: await ordinary.exited, stdout, stderr }).toMatchObject({
			exit: 0,
		});
		expect(stdout).toContain("No accounts configured");
		expect(existsSync(database)).toBe(true);
	} finally {
		rmSync(directory, { recursive: true });
	}
}, 30000);

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
it("actual CLI redelivers the same retry after the API commits but loses its response, mutating once", async () => {
	const directory = mkdtempSync(join(tmpdir(), "quality-cli-redelivery-"));
	const calls: {
		method: string | undefined;
		url: string | undefined;
		authorization: string | undefined;
	}[] = [];
	const bodies: string[] = [];
	const receipts = new Map<string, { body: string; revision: number }>();
	let revision = 4;
	let mutations = 0;
	const server = createServer(async (req, res) => {
		calls.push({
			method: req.method,
			url: req.url,
			authorization: req.headers.authorization,
		});
		res.setHeader("content-type", "application/json");
		if (req.method === "GET") {
			res.end(
				JSON.stringify({
					status: "known",
					incarnation: "incarnation-a",
					intentRevision: revision,
				}),
			);
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		bodies.push(body);
		const intent = JSON.parse(body);
		const receipt = receipts.get(intent.idempotencyToken);
		if (receipt) {
			res.statusCode = receipt.body === body ? 200 : 409;
			res.end(
				JSON.stringify({
					status: receipt.body === body ? "ready" : "conflict",
					intentRevision: receipt.revision,
				}),
			);
			return;
		}
		if (
			intent.incarnation !== "incarnation-a" ||
			intent.expectedIntentRevision !== revision ||
			typeof intent.idempotencyToken !== "string" ||
			!intent.idempotencyToken
		) {
			res.statusCode = 409;
			res.end(JSON.stringify({ status: "stale" }));
			return;
		}
		mutations++;
		revision++;
		receipts.set(intent.idempotencyToken, { body, revision });
		// Commit first, then lose the response on the real loopback transport.
		res.destroy();
	});
	try {
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const child = Bun.spawn(
			[
				...cliEntrypoint(),
				"--quality-routing-retry-preferred",
				"session-a",
				"--origin",
				`http://127.0.0.1:${port}`,
				"--credential-env",
				"SYNTHETIC_INFERENCE_KEY",
			],
			{
				cwd: directory,
				env: {
					HOME: directory,
					XDG_CONFIG_HOME: directory,
					TMPDIR: directory,
					PATH: process.env.PATH ?? "",
					SYNTHETIC_INFERENCE_KEY: "synthetic-runtime-key",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		expect({ exit: await child.exited, stderr }).toMatchObject({ exit: 0 });
		expect(JSON.parse(stdout)).toEqual({ status: "ready", intentRevision: 5 });
		expect(calls).toEqual([
			{
				method: "GET",
				url: "/v1/quality-routing/sessions/session-a",
				authorization: "Bearer synthetic-runtime-key",
			},
			...Array.from({ length: 2 }, () => ({
				method: "POST",
				url: "/v1/quality-routing/sessions/session-a/retry-preferred",
				authorization: "Bearer synthetic-runtime-key",
			})),
		]);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toBe(bodies[1]);
		expect(JSON.parse(bodies[0] ?? "null")).toEqual({
			incarnation: "incarnation-a",
			expectedIntentRevision: 4,
			idempotencyToken: expect.any(String),
		});
		expect(mutations).toBe(1);
		expect(revision).toBe(5);
		expect(receipts.size).toBe(1);
		expect(stdout + stderr).not.toContain("synthetic-runtime-key");
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		rmSync(directory, { recursive: true });
	}
}, 30000);

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
