import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createInterface } from "node:readline";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuard } from "../ccflare-guard.mjs";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tick = () => Bun.sleep(10);
async function until(check: () => boolean) {
	for (let n = 0; n < 200; n++) {
		if (check()) return;
		await tick();
	}
	throw new Error("fixture condition timed out");
}
const secret = Buffer.alloc(32, 1).toString("base64url");
const identity = { pid: process.pid, startTime: "1", sha256: "a".repeat(64) };
async function fixture(options: Record<string, unknown> = {}) {
	let hold: http.ServerResponse | undefined;
	const calls: string[] = [];
	const signatures: string[] = [];
	const upstream = http.createServer((req, res) => {
		calls.push(req.url!);
		signatures.push(
			String(req.headers["x-better-ccflare-guard-request-id"] || ""),
		);
		if (req.url?.includes("hold")) {
			hold = res;
			res.writeHead(200);
			res.write("first");
			return;
		}
		res.end("done");
	});
	await new Promise<void>((resolve) =>
		upstream.listen(0, "127.0.0.1", resolve),
	);
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				upstream.closeAllConnections();
				upstream.close(() => resolve());
			}),
	);
	const port = (upstream.address() as net.AddressInfo).port;
	const guard = createGuard({
		listenPort: 0,
		upstreamBase: `http://127.0.0.1:${port}`,
		maxActive: 2,
		maxQueue: 2,
		totalDeadlineMs: 700,
		retryAttemptHeadroomMs: 1,
		maxRecoverySleepMs: 20,
		shutdownGraceMs: 150,
		guardCorrelationSecret: secret,
		lifecycleEnabled: true,
		verifyReplacement: async () => identity,
		logger: () => {},
		...options,
	});
	const addr = await guard.listen();
	cleanups.push(() => guard.shutdown("fixture"));
	return {
		guard,
		base: `http://127.0.0.1:${addr.port}`,
		calls,
		signatures,
		release: () => hold!.end("last"),
	};
}

test("handoff preserves listener and old stream, queues new work before body reads, then rotates identity", async () => {
	const f = await fixture();
	const old = await fetch(`${f.base}/hold`);
	const oldBody = old.text().catch(() => "aborted");
	const drain = f.guard.recycle.begin(1);
	expect(
		(await (await fetch(`${f.base}/_guard/health`)).json()).lifecycle.state,
	).toBe("draining");
	const queued = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	expect(f.guard.state.bodyReaders.active).toBe(1);
	expect(f.calls).toEqual(["/hold"]);
	f.release();
	expect(await oldBody).toBe("firstlast");
	expect((await drain).outcome).toBe("natural");
	expect(f.guard.state.lifecycle.state).toBe("absent");
	expect(
		(
			await f.guard.recycle.attach({
				generation: 2,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(true);
	expect(await (await queued).text()).toBe("done");
	expect(f.guard.state.lifecycle.generation).toBe(2);
	expect(
		(await (await fetch(`${f.base}/_guard/health`)).json()).runtime.process
			.upstreamPid,
	).toBe(process.pid);
});

test("handoff waiters are bounded, cancel without dispatch and retain the original deadline", async () => {
	const f = await fixture({ maxQueue: 1, totalDeadlineMs: 120 });
	await f.guard.recycle.begin(1);
	const abort = new AbortController();
	const waiting = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
		signal: abort.signal,
	}).catch(() => null);
	await until(() => f.guard.state.lifecycle.waiting === 1);
	expect(
		(await fetch(`${f.base}/v1/messages`, { method: "POST", body: "fixture" }))
			.status,
	).toBe(503);
	abort.abort();
	await waiting;
	await until(() => f.guard.state.lifecycle.waiting === 0);
	const expired = await fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	expect(expired.status).toBe(504);
	expect((await expired.json()).error.type).toBe("guard_deadline_exceeded");
	expect(f.calls).toHaveLength(0);
	expect(f.guard.state.lifecycle.waiting).toBe(0);
});

test("forced drain aborts only dispatched streams and never replays them", async () => {
	const f = await fixture({ shutdownGraceMs: 40 });
	const stream = await fetch(`${f.base}/hold`);
	const body = stream.text().catch(() => "aborted");
	const drain = await f.guard.recycle.begin(1);
	expect(drain.outcome).toBe("forced");
	expect(await body).toBe("aborted");
	expect(
		(
			await f.guard.recycle.attach({
				generation: 2,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(true);
	expect(f.calls).toEqual(["/hold"]);
});

test("stale generation and failed verification cannot resume admission", async () => {
	const f = await fixture({
		verifyReplacement: async () => {
			throw new Error("mismatch");
		},
	});
	expect((await f.guard.recycle.begin(0)).ok).toBe(false);
	await f.guard.recycle.begin(1);
	expect(
		(
			await f.guard.recycle.attach({
				generation: 1,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(false);
	expect(
		(
			await f.guard.recycle.attach({
				generation: 2,
				...identity,
				correlationSecret: secret,
			})
		).ok,
	).toBe(false);
	expect(f.guard.state.lifecycle.state).toBe("absent");
	expect(f.calls).toHaveLength(0);
});

test("terminal shutdown fences an in-flight replacement verification", async () => {
	let verified: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		verified = resolve;
	});
	const f = await fixture({
		verifyReplacement: async () => {
			await gate;
			return identity;
		},
	});
	await f.guard.recycle.begin(1);
	const attach = f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: secret,
	});
	await f.guard.shutdown("SIGTERM");
	verified!();
	expect((await attach).ok).toBe(false);
	expect(f.guard.state.lifecycle.state).toBe("shutdown");
});

test("private control authenticates commands and generation without exposing credentials", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-control-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "control.sock");
	const f = await fixture({ controlSocketPath: path, controlSecret: secret });
	async function control(value: unknown) {
		return new Promise<any>((resolve, reject) => {
			const s = net.createConnection(path);
			let out = "";
			s.on("error", reject);
			s.on("connect", () => s.write(JSON.stringify(value) + "\n"));
			s.on("data", (c) => (out += c));
			s.on("end", () => resolve(JSON.parse(out)));
		});
	}
	expect((await control(null)).ok).toBe(false);
	expect((await control([])).ok).toBe(false);
	expect(
		(await control({ command: "begin", generation: 1, secret: "bad" })).ok,
	).toBe(false);
	expect(f.guard.state.lifecycle.state).toBe("serving");
	expect((await control({ command: "begin", generation: 0, secret })).ok).toBe(
		false,
	);
	expect((await control({ command: "begin", generation: 1, secret })).ok).toBe(
		true,
	);
	expect(
		JSON.stringify(await (await fetch(`${f.base}/_guard/health`)).json()),
	).not.toContain(secret);
});

test("preexisting concurrency queue stays fenced until replacement without reading its body", async () => {
	const f = await fixture({ maxActive: 1 });
	const old = await fetch(`${f.base}/v1/messages?hold`, {
		method: "POST",
		body: "old",
	});
	const oldBody = old.text();
	const queued = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "next",
	});
	await until(() => f.guard.state.queued === 1);
	const drain = f.guard.recycle.begin(1);
	expect((await fetch(`${f.base}/health`)).status).toBe(503);
	f.release();
	await oldBody;
	await drain;
	expect(f.calls).toHaveLength(1);
	expect(f.guard.state.bodyReaders.active).toBe(0);
	await f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: secret,
	});
	expect((await queued).status).toBe(200);
	expect(f.calls).toHaveLength(2);
});

test("native Node body receipt timeout cannot preempt the finite paused-upload deadline", async () => {
	const source = new URL("../ccflare-guard.mjs", import.meta.url).href;
	const script = `
 import http from 'node:http';
 const original = http.createServer;
 http.createServer = (options, handler) => typeof options === 'function'
  ? original({requestTimeout:80,headersTimeout:80,connectionsCheckingInterval:5},options)
  : original({requestTimeout:80,headersTimeout:80,connectionsCheckingInterval:5,...options},handler);
 const {createGuard}=await import(${JSON.stringify(source)});
 const guard=createGuard({listenPort:0,lifecycleEnabled:true,totalDeadlineMs:350,retryAttemptHeadroomMs:1,maxRecoverySleepMs:20,requestDrainTimeoutMs:1000,shutdownGraceMs:30,logger:()=>{}});
 const address=await guard.listen(); await guard.recycle.begin(1);
 console.log(JSON.stringify({port:address.port,headerTimeout:guard.server.headersTimeout}));
 process.on('SIGTERM',()=>guard.shutdown('SIGTERM',{exitProcess:true}));
 `;
	const child = spawn(
		process.env.GUARD_NODE_BIN || "/home/will/.local/share/mise/shims/node",
		["--input-type=module", "--eval", script],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const ended = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	cleanups.push(async () => {
		child.kill("SIGTERM");
		await ended;
	});
	const ready = await new Promise<{ port: number; headerTimeout: number }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.stderr.on("data", (d) => reject(new Error(String(d))));
			createInterface({ input: child.stdout }).once("line", (line) =>
				resolve(JSON.parse(line)),
			);
		},
	);
	expect(ready.headerTimeout).toBeGreaterThan(0);
	const started = Date.now();
	const response = await new Promise<string>((resolve, reject) => {
		const socket = net.createConnection({
			host: "127.0.0.1",
			port: ready.port,
		});
		let output = "";
		socket.on("error", reject);
		socket.on("data", (chunk) => (output += chunk));
		socket.on("end", () => resolve(output));
		socket.on("connect", () =>
			socket.write(
				"POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nContent-Length: 32768\r\nConnection: close\r\n\r\nx",
			),
		);
	});
	expect(response).toContain("HTTP/1.1 504");
	expect(response).toContain("guard_deadline_exceeded");
	expect(Date.now() - started).toBeGreaterThanOrEqual(300);
	expect(Date.now() - started).toBeLessThan(1000);
	const healthStarted = Date.now();
	const health = await new Promise<string>((resolve, reject) => {
		const socket = net.createConnection({
			host: "127.0.0.1",
			port: ready.port,
		});
		let output = "";
		socket.on("error", reject);
		socket.on("data", (chunk) => (output += chunk));
		socket.on("close", () => resolve(output));
		socket.on("connect", () =>
			socket.write(
				"POST /_guard/health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 32768\r\nConnection: keep-alive\r\n\r\nx",
			),
		);
	});
	expect(health).toContain("HTTP/1.1 200");
	expect(Date.now() - healthStarted).toBeGreaterThanOrEqual(900);
	expect(Date.now() - healthStarted).toBeLessThan(1800);
}, 5000);

test("terminal shutdown never releases a preexisting queue onto an unverified replacement", async () => {
	const f = await fixture({ maxActive: 1 });
	const old = await fetch(`${f.base}/v1/messages?hold`, {
		method: "POST",
		body: "old",
	});
	const oldBody = old.text();
	const pending = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "pending",
	});
	await until(() => f.guard.state.queued === 1);
	const drain = f.guard.recycle.begin(1);
	f.release();
	await oldBody;
	await drain;
	// The mock remains reachable on the same port, just like a candidate which
	// has started listening but has not passed attach identity verification.
	await f.guard.shutdown("SIGTERM");
	expect((await pending).status).toBe(503);
	expect(f.calls).toHaveLength(1);
	expect(f.guard.state.lifecycle.generation).toBe(1);
});

test("replacement signer uses the new backend credential before releasing waiters", async () => {
	const f = await fixture();
	await f.guard.recycle.begin(1);
	const pending = fetch(`${f.base}/v1/messages`, {
		method: "POST",
		body: "fixture",
	});
	await until(() => f.guard.state.lifecycle.waiting === 1);
	const nextSecret = Buffer.alloc(32, 2).toString("base64url");
	await f.guard.recycle.attach({
		generation: 2,
		...identity,
		correlationSecret: nextSecret,
	});
	expect((await pending).status).toBe(200);
	const [version, id, ordinal, signature] = f.signatures[0].split(".");
	expect(version).toBe("v1");
	const expected = createHmac("sha256", Buffer.from(nextSecret, "base64url"))
		.update(`better-ccflare/guard-correlation/v1\n${id}\n${ordinal}`)
		.digest("base64url");
	expect(signature).toBe(expected);
});

test("trickled unauthenticated control input cannot pin all command slots", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-control-deadline-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "control.sock");
	const f = await fixture({ controlSocketPath: path, controlSecret: secret });
	const sockets = Array.from({ length: 4 }, () => net.createConnection(path));
	let closed = 0;
	for (const socket of sockets) {
		socket.on("error", () => {});
		socket.on("close", () => closed++);
	}
	const trickle = setInterval(() => {
		for (const socket of sockets) if (!socket.destroyed) socket.write(" ");
	}, 100);
	try {
		await Bun.sleep(2250);
		expect(closed).toBe(4);
		const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
			const socket = net.createConnection(path);
			let out = "";
			socket.on("error", reject);
			socket.on("data", (c) => (out += c));
			socket.on("end", () => resolve(JSON.parse(out)));
			socket.on("connect", () =>
				socket.write(
					JSON.stringify({ command: "begin", generation: 1, secret }) + "\n",
				),
			);
		});
		expect(result.ok).toBe(true);
		expect(f.guard.state.lifecycle.state).toBe("absent");
	} finally {
		clearInterval(trickle);
		for (const socket of sockets) socket.destroy();
	}
}, 5000);
