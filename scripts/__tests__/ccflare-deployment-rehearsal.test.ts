import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	openSync,
	fsyncSync,
	closeSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import {
	durableWrite,
	fileHash,
	prepareTransaction,
	processExists,
	recoverTransaction,
} from "../ccflare-deployment-transaction.mjs";
import { resolveNodeExecutable } from "./node-runtime";
const root = join(import.meta.dir, "..", "..");
async function port() {
	const s = net.createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const p = (s.address() as net.AddressInfo).port;
	await new Promise<void>((r) => s.close(() => r()));
	return p;
}
async function until<T>(f: () => T | Promise<T>) {
	for (let i = 0; i < 300; i++) {
		try {
			const value = await f();
			if (value) return value;
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error("rehearsal condition timeout");
}
test.each([
	"commit",
	"bad_nonce",
	"bad_source",
	"early_exit",
	"rss_then_commit",
	"rss_prepared",
	"runner_crash",
])("disposable compiled Bun/SQLite %s retains ingress and proves cold owner handoff", async (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-handoff-rehearsal-")),
		control = join(dir, "transaction"),
		pin = join(dir, "pin"),
		node = resolveNodeExecutable(),
		guardPort = await port(),
		upstreamPort = await port();
	const oldSource = "a".repeat(40),
		newSource = "b".repeat(40),
		schema = "c".repeat(64);
	let runner: ReturnType<typeof spawn> | undefined,
		logs = "";
	const orphanOwners: Array<{ pid: number; start: string }> = [];
	const processStart = (pid: number) => {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
	};
	let runnerEnvironment: NodeJS.ProcessEnv;
	const rssMode = mode === "rss_then_commit" || mode === "rss_prepared";
	const procRoot = join(dir, "fixture-proc");
	const headerRelease = join(dir, "release-headers");
	const streamRelease = join(dir, "release-stream");
	const armRss = (pid: number) => {
		const status = join(procRoot, String(pid), "status");
		writeFileSync(status + ".next", "Name:\tfixture\nVmRSS:\t1 kB\nVmSwap:\t0 kB\n");
		renameSync(status + ".next", status);
	};
	try {
		for (const [name, sha, delay] of [
			["old", oldSource, 0],
			["candidate", newSource, 400],
		] as const) {
			const source = join(dir, `${name}.ts`),
				binary = join(dir, name);
			writeFileSync(
				source,
				`import {Database} from "bun:sqlite";import {openSync,closeSync,unlinkSync,appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";import {createManagedIngress} from ${JSON.stringify(join(root, "apps/server/src/managed-ingress.ts"))};
 ${name === "candidate" && mode === "early_exit" ? "process.exit(42);" : ""}const lock=process.env.FIXTURE_DB+".owner";const owner=openSync(lock,"wx");if(process.env.FIXTURE_PROC_ROOT){const proc=process.env.FIXTURE_PROC_ROOT+"/"+process.pid;mkdirSync(proc,{recursive:true});writeFileSync(proc+"/stat",readFileSync("/proc/"+process.pid+"/stat"));writeFileSync(proc+"/status",${JSON.stringify("Name:\tfixture\nVmRSS:\t0 kB\nVmSwap:\t0 kB\n")});}const db=new Database(process.env.FIXTURE_DB);db.exec("CREATE TABLE IF NOT EXISTS calls(generation INTEGER,path TEXT)");appendFileSync(process.env.FIXTURE_EVENTS,"open:"+process.pid+"\\n");
 await Bun.sleep(${delay});const ingress=createManagedIngress({enabled:true,secret:Buffer.from(process.env.CCFLARE_GUARD_CORRELATION_SECRET,"base64url"),generation:Number(process.env.CCFLARE_MANAGED_GENERATION),ingressNonce:process.env.CCFLARE_MANAGED_INGRESS_NONCE,candidateNonce:${JSON.stringify(name === "candidate" && mode === "bad_nonce" ? "e".repeat(32) : null)} ?? process.env.CCFLARE_MANAGED_CANDIDATE_NONCE,sourceSha:process.env.CCFLARE_SOURCE_SHA});
 const server=Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:r=>ingress(r,async req=>{const url=new URL(req.url);if(url.pathname==="/health")return Response.json({status:"ok",git_sha:${JSON.stringify(name === "candidate" && mode === "bad_source" ? oldSource : sha)}});db.query("INSERT INTO calls VALUES(?,?)").run(Number(process.env.CCFLARE_MANAGED_GENERATION),url.pathname);if(url.pathname==="/v1/slow"){const waitForFile=path=>new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(path)){clearInterval(timer);resolve();}},10);});if(process.env.FIXTURE_HEADER_RELEASE)await waitForFile(process.env.FIXTURE_HEADER_RELEASE);return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("first"));const finish=()=>{try{c.enqueue(new TextEncoder().encode("last"));c.close();}catch{}};if(process.env.FIXTURE_STREAM_RELEASE)waitForFile(process.env.FIXTURE_STREAM_RELEASE).then(finish);else setTimeout(finish,350);}}));}return new Response(${JSON.stringify(sha)});})});
 process.on("SIGTERM",()=>{server.stop(true);db.close();closeSync(owner);unlinkSync(lock);appendFileSync(process.env.FIXTURE_EVENTS,"close:"+process.pid+"\\n");process.exit(0);});`,
			);
			const result = spawnSync(
				process.execPath,
				["build", "--compile", source, "--outfile", binary],
				{ cwd: root, encoding: "utf8", timeout: 15000 },
			);
			if (result.status !== 0) throw new Error(result.stderr);
			chmodSync(binary, 0o555);
		}
		writeFileSync(pin, "previous-pin");
		const nextPin = join(dir, "next-pin");
		writeFileSync(nextPin, "candidate-pin");
		runner = spawn("bash", [join(root, "scripts/run-ccflare-stack.sh")], {
			cwd: root,
			env: (runnerEnvironment = {
				...process.env,
				HOME: dir,
				USER: "fixture",
				NODE_BIN: node,
				CCFLARE_BIN: join(dir, "old"),
				GUARD_SCRIPT: join(root, "scripts/ccflare-guard.mjs"),
				GUARD_SOURCE_ID: oldSource,
				CCFLARE_SOURCE_SHA: oldSource,
				CCFLARE_GIT_SHA: oldSource,
				CCFLARE_SCHEMA_DIGEST: schema,
				CCFLARE_PIN_PATH: pin,
				CCFLARE_TRANSACTION_DIR: control,
				CCFLARE_MANAGED_TIMING: "1",
				...(rssMode
					? {
							RUNNER_RSS_THRESHOLD_BYTES: "1",
							RUNNER_RSS_POLL_INTERVAL_MS: "20",
							RUNNER_RSS_MIN_UPTIME_MS: "0",
							RUNNER_PROC_ROOT: procRoot,
							FIXTURE_PROC_ROOT: procRoot,
							FIXTURE_HEADER_RELEASE: headerRelease,
							FIXTURE_STREAM_RELEASE: streamRelease,
							RUNNER_RSS_CONSECUTIVE_SAMPLES: "1",
							RUNNER_RSS_RECYCLE_COOLDOWN_MS: "0",
							RUNNER_RSS_MAX_RECYCLES: "1",
							RUNNER_RSS_RECYCLE_WINDOW_MS: "60000",
						}
					: {}),
				CCFLARE_UPSTREAM_PORT: String(upstreamPort),
				GUARD_PORT: String(guardPort),
				GUARD_TOTAL_DEADLINE_MS: "10000",
				GUARD_RETRY_ATTEMPT_HEADROOM_MS: "1",
				GUARD_MAX_RECOVERY_SLEEP_MS: "100",
				GUARD_SHUTDOWN_GRACE_MS: "10000",
				GUARD_SHUTDOWN_CUSHION_MS: "100",
				RUNNER_HEALTH_POLL_INTERVAL_MS: "10",
				RUNNER_HEALTH_STABILITY_DELAY_MS: "0",
				AI_GATEWAY_TUNNEL_ENABLED: "0",
				AI_GATEWAY_TUNNEL_REQUIRED: "0",
				FIXTURE_DB: join(dir, "fixture.db"),
				FIXTURE_EVENTS: join(dir, "events"),
			}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		runner.stdout!.on("data", (c) => {
			logs += c;
		});
		runner.stderr!.on("data", (c) => {
			logs += c;
		});
		const base = `http://127.0.0.1:${guardPort}`;
		const health = await until(async () => {
			const h = await (await fetch(base + "/_guard/health")).json();
			return existsSync(join(control, "runtime.json")) && h;
		});
		const guardPid = health.runtime.process.guardPid;
		// Capture the original epoch before waiting for response headers. RSS is
		// disarmed until this owner and its physical request admission are proven.
		const initialRuntime = JSON.parse(
			readFileSync(join(control, "runtime.json"), "utf8"),
		);
		expect(initialRuntime.generation).toBe(1);
		const responsePending = fetch(base + "/v1/slow", {
			method: "POST",
			body: "{}",
		});
		if (rssMode) {
			// Deterministically delay headers until the original owner has admitted
			// the request, instead of betting on a 150ms watchdog/startup race.
			const admission = new Database(join(dir, "fixture.db"), { readonly: true });
			try {
				const row = await until(() =>
					admission.query("SELECT generation FROM calls WHERE path='/v1/slow'").get(),
				);
				expect(row).toEqual({ generation: initialRuntime.generation });
			} finally {
				admission.close();
			}
			const admitted = await (await fetch(base + "/_guard/health")).json();
			expect(admitted.lifecycle.generation).toBe(initialRuntime.generation);
			expect(admitted.lifecycle.dispatched).toBe(1);
			expect(logs).not.toContain("RSS recycle trigger");
			writeFileSync(headerRelease, "release\n");
		}
		const response = await responsePending;
		const oldBody = response.text();
		if (mode === "rss_then_commit") {
			armRss(initialRuntime.oldPid);
			await until(async () => {
				const h = await (await fetch(base + "/_guard/health")).json();
				return h.lifecycle.state === "draining" && h;
			});
			expect(existsSync(`/proc/${initialRuntime.oldPid}`)).toBe(true);
			writeFileSync(streamRelease, "release\n");
			expect(await oldBody).toBe("firstlast");
			const recycled = await until(() => {
				const r = JSON.parse(
					readFileSync(join(control, "runtime.json"), "utf8"),
				);
				return r.generation === initialRuntime.generation + 1 && r;
			});
			expect(existsSync(`/proc/${initialRuntime.oldPid}`)).toBe(false);
			expect(existsSync(`/proc/${initialRuntime.deploymentPid}`)).toBe(false);
			expect(recycled.deploymentPid).not.toBe(initialRuntime.deploymentPid);
			expect(
				(await (await fetch(base + "/_guard/health")).json()).runtime.process
					.guardPid,
			).toBe(guardPid);
		}

		const runtime = JSON.parse(
			readFileSync(join(control, "runtime.json"), "utf8"),
		);
		const manifest = {
			transactionId: crypto.randomUUID(),
			expectedGeneration: runtime.generation,
			oldPid: runtime.oldPid,
			oldStartTime: runtime.oldStartTime,
			previousPinHash: runtime.pinHash,
			candidatePinHash: fileHash(nextPin),
			candidateBinary: join(dir, "candidate"),
			candidateHash: fileHash(join(dir, "candidate")),
			candidateSourceSha: newSource,
			candidateNonce: "d".repeat(32),
			schemaDigest: schema,
			ingress: runtime.ingress,
		};
		const command = join(dir, "command.json");
		writeFileSync(command, JSON.stringify({ command: "prepare", manifest }));
		if (mode === "rss_prepared") {
			// Model a durable preparation whose acknowledgement/daemon exit was lost.
			// The actual RSS supervisor must retire the daemon and adopt that receipt.
			prepareTransaction(control, manifest, runtime);
			armRss(runtime.oldPid);
		} else {
			const client = spawnSync(
				node,
				[
					join(root, "scripts/ccflare-deployment-transaction.mjs"),
					"client",
					control,
					command,
				],
				{ encoding: "utf8", timeout: 3000 },
			);
			expect(client.status).toBe(0);
		}
		await until(async () => {
			const h = await (await fetch(base + "/_guard/health")).json();
			return ["draining", "absent"].includes(h.lifecycle.state);
		});
		const dispatchPausedAt = performance.now();
		const expired = fetch(base + "/v1/expired", {
			method: "POST",
			body: "{}",
			headers: { "x-better-ccflare-timeout-ms": "200" },
		});
		const waitingAbort = new AbortController();
		const waiting = fetch(base + "/v1/waiting", {
			method: "POST",
			body: "{}",
			signal: waitingAbort.signal,
		});
		if (mode === "rss_prepared") {
			expect(existsSync(`/proc/${initialRuntime.oldPid}`)).toBe(true);
			writeFileSync(streamRelease, "release\n");
		}
		expect(await oldBody).toBe("firstlast");
		expect((await expired).status).toBe(504);
		if (mode === "early_exit") {
			const outcome = await until(() => {
				const t = JSON.parse(
					readFileSync(join(control, "intent.json"), "utf8"),
				);
				return ["held", "rolled_back"].includes(t.phase) && t;
			});
			if (outcome.phase === "held") {
				expect(outcome.reason).toBe("candidate_start_identity_unavailable");
				expect(
					(await (await fetch(base + "/_guard/health")).json()).lifecycle.state,
				).toBe("absent");
				waitingAbort.abort();
				await waiting.catch(() => undefined);
				return;
			}
		}
		if (
			!["commit", "rss_then_commit", "rss_prepared", "runner_crash"].includes(
				mode,
			)
		) {
			await until(
				() =>
					JSON.parse(readFileSync(join(control, "intent.json"), "utf8"))
						.phase === "rolled_back",
			);
			expect(await (await waiting).text()).toBe(oldSource);
			const rolled = JSON.parse(
				readFileSync(join(control, "intent.json"), "utf8"),
			);
			expect(existsSync(`/proc/${rolled.candidatePid}`)).toBe(false);
			expect(fileHash(pin)).toBe(runtime.pinHash);
			expect(
				(await (await fetch(base + "/_guard/health")).json()).runtime.process
					.guardPid,
			).toBe(guardPid);
			if (mode !== "early_exit")
				expect(readFileSync(join(dir, "events"), "utf8")).toContain(
					`close:${rolled.candidatePid}`,
				);
			return;
		}
		const verified = await until(() => {
			const t = JSON.parse(readFileSync(join(control, "intent.json"), "utf8"));
			return t.phase === "candidate_verified" && t;
		});
		expect(existsSync(`/proc/${runtime.oldPid}`)).toBe(false);
		expect(verified.candidatePid).not.toBe(runtime.oldPid);
		if (mode === "runner_crash") {
			orphanOwners.push(
				{ pid: guardPid, start: processStart(guardPid) },
				{ pid: verified.candidatePid, start: verified.candidateStartTime },
			);
			waitingAbort.abort();
			await waiting.catch(() => undefined);
			const exited = new Promise<void>((resolve) =>
				runner!.once("exit", () => resolve()),
			);
			runner!.kill("SIGKILL");
			await exited;
			const restarted = spawnSync(
				"bash",
				[join(root, "scripts/run-ccflare-stack.sh")],
				{ cwd: root, env: runnerEnvironment!, encoding: "utf8", timeout: 3000 },
			);
			expect(restarted.status).toBe(70);
			expect(restarted.stderr).toContain(
				"unfinished backend transaction requires operator recovery",
			);
			expect(recoverTransaction(control)).toEqual({
				action: "hold",
				reason: "unreaped_or_ambiguous_owner",
			});
			expect(
				JSON.parse(readFileSync(join(control, "intent.json"), "utf8")).phase,
			).toBe("candidate_verified");
			expect(
				readFileSync(join(dir, "events"), "utf8")
					.split("\n")
					.filter((line) => line.startsWith("open:")).length,
			).toBe(2);
			expect(fileHash(pin)).toBe(runtime.pinHash);
			console.info(
				JSON.stringify({
					fixture: "actual-runner-crash",
					phase: "candidate_verified",
					restartExit: 70,
					newDbOwners: 0,
					reason: "unreaped_or_ambiguous_owner",
				}),
			);
			return;
		}

		expect(
			(await (await fetch(base + "/_guard/health")).json()).runtime.process
				.guardPid,
		).toBe(guardPid);
		renameSync(nextPin, pin);
		const fd = openSync(dir, "r");
		fsyncSync(fd);
		closeSync(fd);
		durableWrite(join(control, "commit.json"), {
			transactionId: manifest.transactionId,
			pinHash: manifest.candidatePinHash,
		});
		await until(
			() =>
				JSON.parse(readFileSync(join(control, "intent.json"), "utf8")).phase ===
				"attached",
		);
		expect(await (await waiting).text()).toBe(newSource);
		const completedAt = performance.now();
		const inspection = new Database(join(dir, "fixture.db"), {
			readonly: true,
		});
		expect(
			inspection
				.query("SELECT count(*) AS n FROM calls WHERE path='/v1/expired'")
				.get(),
		).toEqual({ n: 0 });
		expect(
			inspection
				.query(
					"SELECT count(*) AS n FROM calls WHERE path='/v1/waiting' AND generation=?",
				)
				.get(runtime.generation + 1),
		).toEqual({ n: 1 });
		inspection.close();
		console.info(
			JSON.stringify({
				fixture: "compiled-cold-handoff",
				case: mode,
				measuredQueuedDispatchPauseMs: Math.round(
					completedAt - dispatchPausedAt,
				),
				ingressPidRetained: true,
				expiredDispatches: 0,
			}),
		);
		if (mode === "rss_prepared") {
			expect(logs).toContain(
				"prepared deployment superseded RSS recycle after listener retirement",
			);
			expect(existsSync(`/proc/${runtime.deploymentPid}`)).toBe(false);
		}
		const final = await (await fetch(base + "/_guard/health")).json();
		expect(final.runtime.process.guardPid).toBe(guardPid);
		expect(final.backendSourceSha).toBe(newSource);
		expect(final.sourceId).toBe(oldSource);
		expect(readFileSync(join(dir, "events"), "utf8")).toContain(
			`close:${runtime.oldPid}`,
		);
	} catch (error) {
		throw new Error(`${error}\n${logs.slice(-6000)}`);
	} finally {
		if (runner && !runner.killed) {
			runner.kill("SIGTERM");
			await Promise.race([
				new Promise((r) => runner!.once("exit", r)),
				Bun.sleep(3000),
			]);
			if (runner.exitCode === null) runner.kill("SIGKILL");
		}

		for (const owner of orphanOwners)
			if (processExists(owner.pid, owner.start)) {
				try {
					process.kill(owner.pid, "SIGTERM");
				} catch {}
			}
		for (
			let n = 0;
			n < 100 &&
			orphanOwners.some((owner) => processExists(owner.pid, owner.start));
			n++
		)
			await Bun.sleep(20);
		for (const owner of orphanOwners)
			if (processExists(owner.pid, owner.start)) {
				try {
					process.kill(owner.pid, "SIGKILL");
				} catch {}
			}
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);
