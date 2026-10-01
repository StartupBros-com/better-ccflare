#!/usr/bin/env node
// One cold backend transaction. Ingress stays in its original process.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	chownSync,
	fchownSync,
	chmodSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export function fileHash(path) {
	const h = createHash("sha256"),
		fd = openSync(path, "r"),
		buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, null);
			if (!n) break;
			h.update(buffer.subarray(0, n));
		}
		return h.digest("hex");
	} finally {
		closeSync(fd);
	}
}
// Only ENOENT proves absence. Permission, malformed or I/O failures are
// ownership ambiguity and must never authorize a second database owner.
export function processExists(pid, start, read = readFileSync) {
	try {
		const text = read(`/proc/${pid}/stat`, "utf8");
		const marker = text.lastIndexOf(") ");
		const actual = text.slice(marker + 2).split(" ")[19];
		if (marker < 0 || !/^\d+$/.test(actual))
			throw new Error("ambiguous process identity");
		return actual === String(start);
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
export function durableWrite(path, value) {
	const staged = `${path}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
	const fd = openSync(staged, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(value));
		if (process.geteuid?.() === 0) {
			const owner = statSync(dirname(path));
			fchownSync(fd, owner.uid, owner.gid);
		}
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(staged, path);
	const dir = openSync(dirname(path), "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}
function readIntent(dir) {
	return JSON.parse(readFileSync(join(dir, "intent.json"), "utf8"));
}
function validManifest(m, r) {
	const digest = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
	return (
		m &&
		/^[0-9a-f-]{36}$/.test(m.transactionId) &&
		/^[0-9a-f]{40}$/.test(m.candidateSourceSha) &&
		/^[0-9a-f]{32}$/.test(m.candidateNonce) &&
		digest(m.candidateHash) &&
		digest(m.candidatePinHash) &&
		m.expectedGeneration === r.generation &&
		m.oldPid === r.oldPid &&
		String(m.oldStartTime) === String(r.oldStartTime) &&
		m.previousPinHash === r.pinHash &&
		m.schemaDigest === r.schemaDigest &&
		digest(m.schemaDigest) &&
		JSON.stringify(m.ingress) === JSON.stringify(r.ingress) &&
		fileHash(r.pinPath) === r.pinHash &&
		typeof m.candidateBinary === "string" &&
		realpathSync(m.candidateBinary) === m.candidateBinary &&
		statSync(m.candidateBinary).isFile() &&
		(statSync(m.candidateBinary).mode & 0o222) === 0 &&
		fileHash(m.candidateBinary) === m.candidateHash
	);
}
export function prepareTransaction(dir, m, r) {
	if (!validManifest(m, r))
		throw new Error("candidate manifest incompatible or identity mismatch");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (existsSync(join(dir, "intent.json"))) {
		const old = readIntent(dir);
		if (!["attached", "rolled_back"].includes(old.phase))
			throw new Error("existing transaction requires recovery");
	}
	const intent = {
		version: 1,
		phase: "prepared",
		manifest: m,
		previous: r,
		updatedAt: new Date().toISOString(),
	};
	durableWrite(join(dir, "intent.json"), intent);
	return intent;
}
const next = {
	prepared: ["draining", "held"],
	draining: ["old_reaped", "held"],
	old_reaped: ["candidate_started", "held"],
	candidate_started: ["candidate_verified", "rolled_back", "held"],
	candidate_verified: ["committed", "rolled_back", "held"],
	committed: ["attached", "held"],
};
export function advanceTransaction(
	dir,
	expected,
	phase,
	evidence = {},
	exists = processExists,
) {
	const transaction = readIntent(dir);
	if (transaction.phase !== expected || !next[expected]?.includes(phase))
		throw new Error("stale transaction phase");
	if (
		phase === "old_reaped" &&
		exists(transaction.previous.oldPid, transaction.previous.oldStartTime)
	)
		throw new Error("previous backend is not reaped");
	if (
		phase === "candidate_started" &&
		(!Number.isSafeInteger(evidence.candidatePid) ||
			evidence.candidatePid < 1 ||
			!/^\d+$/.test(String(evidence.candidateStartTime)))
	)
		throw new Error("candidate process evidence missing");
	if (
		phase === "candidate_verified" &&
		(!transaction.candidatePid ||
			!exists(transaction.candidatePid, transaction.candidateStartTime))
	)
		throw new Error("candidate identity unavailable");
	if (
		phase === "committed" &&
		fileHash(transaction.previous.pinPath) !==
			transaction.manifest.candidatePinHash
	)
		throw new Error("candidate pin not durably committed");
	if (
		phase === "rolled_back" &&
		(!transaction.candidatePid ||
			exists(transaction.candidatePid, transaction.candidateStartTime) ||
			fileHash(transaction.previous.pinPath) !==
				transaction.manifest.previousPinHash)
	)
		throw new Error("unsafe rollback");
	const out = {
		...transaction,
		...evidence,
		phase,
		updatedAt: new Date().toISOString(),
	};
	durableWrite(join(dir, "intent.json"), out);
	return out;
}
function matchesStartup(configured, binary, hash, source, schema) {
	if (!configured) return true;
	return (
		configured.binary === binary &&
		configured.sourceSha === source &&
		configured.schemaDigest === schema &&
		fileHash(binary) === hash
	);
}
export function prepareBootstrap(dir, receipt) {
	if (
		!/^[0-9a-f]{64}$/.test(receipt.pinHash) ||
		!/^[0-9a-f]{64}$/.test(receipt.binaryHash) ||
		!/^[0-9a-f]{40}$/.test(receipt.sourceSha) ||
		!/^[0-9a-f]{64}$/.test(receipt.schemaDigest) ||
		fileHash(receipt.binary) !== receipt.binaryHash
	)
		throw new Error("invalid bootstrap artifact");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (process.geteuid?.() === 0) {
		const owner = statSync(receipt.binary);
		chownSync(dir, owner.uid, owner.gid);
	}
	if (
		existsSync(join(dir, "intent.json")) &&
		!["attached", "rolled_back"].includes(readIntent(dir).phase)
	)
		throw new Error("unfinished transaction cannot bootstrap");
	durableWrite(join(dir, "bootstrap.json"), { version: 1, ...receipt });
}
export function recordBackendOwner(dir, phase, pid, start) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (
		phase !== "spawning" &&
		(phase !== "running" ||
			!Number.isSafeInteger(pid) ||
			pid < 1 ||
			!/^\d+$/.test(String(start)))
	)
		throw new Error("invalid backend ownership receipt");
	durableWrite(join(dir, "owner.json"), { phase, pid, start });
}
export function recoverTransaction(dir, exists = processExists, configured) {
	try {
		if (existsSync(join(dir, "owner.json"))) {
			const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
			if (owner.phase !== "running" || exists(owner.pid, owner.start))
				return { action: "hold", reason: "unreaped_or_ambiguous_owner" };
		}
		const bootstrapPath = join(dir, "bootstrap.json");
		const intentPath = join(dir, "intent.json");
		const transaction = existsSync(intentPath) ? readIntent(dir) : null;
		if (
			transaction &&
			(exists(transaction.previous.oldPid, transaction.previous.oldStartTime) ||
				(transaction.candidatePid &&
					exists(transaction.candidatePid, transaction.candidateStartTime)))
		)
			return { action: "hold", reason: "unreaped_backend" };
		if (configured && existsSync(bootstrapPath)) {
			const receipt = JSON.parse(readFileSync(bootstrapPath, "utf8"));
			if (
				(!transaction ||
					["attached", "rolled_back"].includes(transaction.phase)) &&
				fileHash(configured.pinPath) === receipt.pinHash &&
				matchesStartup(
					configured,
					receipt.binary,
					receipt.binaryHash,
					receipt.sourceSha,
					receipt.schemaDigest,
				)
			)
				return { action: "start_bootstrap" };
		}
		if (!transaction) return { action: "start" };
		const hash = fileHash(transaction.previous.pinPath);
		if (
			["prepared", "rolled_back"].includes(transaction.phase) &&
			hash === transaction.manifest.previousPinHash &&
			matchesStartup(
				configured,
				transaction.previous.binary,
				transaction.previous.binaryHash,
				transaction.previous.backendSourceSha,
				transaction.previous.schemaDigest,
			)
		)
			return { action: "start_previous" };
		if (
			["committed", "attached"].includes(transaction.phase) &&
			hash === transaction.manifest.candidatePinHash &&
			matchesStartup(
				configured,
				transaction.manifest.candidateBinary,
				transaction.manifest.candidateHash,
				transaction.manifest.candidateSourceSha,
				transaction.manifest.schemaDigest,
			)
		)
			return { action: "start_candidate" };
		return { action: "hold", reason: "transaction_ambiguous" };
	} catch {
		return { action: "hold", reason: "identity_unavailable" };
	}
}
async function client(dir, command) {
	const runtime = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
	const control = runtime.controlDir;
	const secret = readFileSync(join(control, "deploy-credential"), "utf8");
	return await new Promise((resolve, reject) => {
		const socket = net.createConnection(join(control, "deploy.sock"));
		let input = "";
		socket.setTimeout(3000, () =>
			socket.destroy(new Error("transaction command timeout")),
		);
		socket.on("error", reject);
		socket.on("connect", () =>
			socket.write(JSON.stringify({ ...command, secret }) + "\n"),
		);
		socket.on("data", (c) => {
			input += c;
			if (input.length > 4096) socket.destroy(new Error("response too large"));
		});
		socket.on("end", () => {
			try {
				resolve(JSON.parse(input));
			} catch (e) {
				reject(e);
			}
		});
	});
}
async function serve(dir, runtime) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const credential = randomBytes(32).toString("base64url");
	writeFileSync(join(runtime.controlDir, "deploy-credential"), credential, {
		mode: 0o600,
	});
	durableWrite(join(dir, "runtime.json"), {
		...runtime,
		deploymentPid: process.pid,
	});
	const socketPath = join(runtime.controlDir, "deploy.sock");
	try {
		unlinkSync(socketPath);
	} catch {}
	let accepted = false;
	const sockets = new Set();
	const server = net.createServer((socket) => {
		if (sockets.size >= 4) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		let input = "",
			handled = false;
		const timer = setTimeout(() => socket.destroy(), 2000);
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(timer);
			sockets.delete(socket);
		});
		socket.on("data", (chunk) => {
			if (handled) return;
			input += chunk;
			if (input.length > 8192) {
				socket.destroy();
				return;
			}
			if (!input.includes("\n")) return;
			handled = true;
			let result;
			try {
				const command = JSON.parse(input);
				const a = Buffer.from(String(command.secret || "")),
					b = Buffer.from(credential);
				if (a.length !== b.length || !timingSafeEqual(a, b))
					throw new Error("unauthorized");
				if (command.command !== "prepare" || accepted)
					throw new Error("invalid control phase");
				prepareTransaction(dir, command.manifest, runtime);
				accepted = true;
				result = { ok: true, phase: "prepared" };
			} catch {
				result = { ok: false, reason: "manifest_or_control_rejected" };
			}
			socket.end(JSON.stringify(result));
			if (accepted)
				socket.on("close", () => {
					server.close(() => process.exit(67));
					for (const other of sockets) if (other !== socket) other.destroy();
				});
		});
	});
	server.listen(socketPath, () => chmodSync(socketPath, 0o600));
	for (const sig of ["SIGTERM", "SIGINT"])
		process.on(sig, () => {
			server.close();
			for (const s of sockets) s.destroy();
			process.exit(0);
		});
}
if (
	process.argv[1] &&
	process.argv[1] !== "-" &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [command, dir, ...args] = process.argv.slice(2);
	try {
		if (command === "serve")
			await serve(dir, JSON.parse(readFileSync(args[0], "utf8")));
		else if (command === "client") {
			const result = await client(
				dir,
				JSON.parse(readFileSync(args[0], "utf8")),
			);
			console.log(JSON.stringify(result));
			if (!result.ok) process.exitCode = 1;
		} else if (command === "owner-spawning")
			recordBackendOwner(dir, "spawning");
		else if (command === "owner-started")
			recordBackendOwner(dir, "running", Number(args[0]), args[1]);
		else if (command === "advance")
			console.log(
				JSON.stringify(
					advanceTransaction(
						dir,
						args[0],
						args[1],
						args[2] ? JSON.parse(args[2]) : {},
					),
				),
			);
		else if (command === "recover") {
			const result = recoverTransaction(dir, processExists, {
				binary: process.env.CCFLARE_BIN,
				sourceSha: process.env.CCFLARE_SOURCE_SHA,
				schemaDigest: process.env.CCFLARE_SCHEMA_DIGEST,
				pinPath: process.env.CCFLARE_PIN_PATH,
			});
			console.log(JSON.stringify(result));
			if (result.action === "hold") process.exitCode = 70;
		} else throw new Error("unknown transaction command");
	} catch (error) {
		console.error(`backend transaction held: ${error.message}`);
		process.exitCode = 70;
	}
}
