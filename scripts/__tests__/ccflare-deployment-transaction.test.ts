import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	prepareTransaction,
	advanceTransaction,
	recoverTransaction,
	fileHash,
	processExists,
	durableWrite,
	prepareBootstrap,
	recordBackendOwner,
} from "../ccflare-deployment-transaction.mjs";
import { resolveNodeExecutable } from "./node-runtime";
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-transaction-")),
		binary = join(dir, "candidate"),
		pin = join(dir, "pin");
	writeFileSync(binary, "candidate", { mode: 0o555 });
	writeFileSync(pin, "old-pin");
	const runtime = {
		generation: 1,
		oldPid: 999999,
		oldStartTime: "1",
		binary,
		binaryHash: fileHash(binary),
		backendSourceSha: "a".repeat(40),
		schemaDigest: "b".repeat(64),
		ingress: {
			runner: "c".repeat(64),
			guard: "d".repeat(64),
			policy: "e".repeat(64),
			timing: "f".repeat(64),
			transaction: "0".repeat(64),
		},
		pinPath: pin,
		pinHash: fileHash(pin),
	};
	const manifest = {
		transactionId: "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a01",
		expectedGeneration: 1,
		oldPid: 999999,
		oldStartTime: "1",
		previousPinHash: runtime.pinHash,
		candidatePinHash: "9".repeat(64),
		candidateBinary: binary,
		candidateHash: fileHash(binary),
		candidateSourceSha: "1".repeat(40),
		candidateNonce: "2".repeat(32),
		schemaDigest: runtime.schemaDigest,
		ingress: runtime.ingress,
	};
	return { dir, pin, runtime, manifest };
}
function started(f: ReturnType<typeof fixture>) {
	prepareTransaction(f.dir, f.manifest, f.runtime);
	advanceTransaction(f.dir, "prepared", "draining");
	advanceTransaction(f.dir, "draining", "old_reaped", {}, () => false);
	advanceTransaction(f.dir, "old_reaped", "candidate_started", {
		candidatePid: 999998,
		candidateStartTime: "2",
	});
}
test("durable preparation verifies immutable manifest and CAS phase", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		expect(() => prepareTransaction(f.dir, f.manifest, f.runtime)).toThrow();
		expect(() => advanceTransaction(f.dir, "prepared", "old_reaped")).toThrow();
		expect(advanceTransaction(f.dir, "prepared", "draining").phase).toBe(
			"draining",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test.each([
	"candidateHash",
	"schemaDigest",
	"previousPinHash",
	"candidateSourceSha",
	"candidateNonce",
	"expectedGeneration",
])("reject invalid or wrong candidate identity %s before draining", (key) => {
	const f = fixture();
	try {
		expect(() =>
			prepareTransaction(f.dir, { ...f.manifest, [key]: "invalid" }, f.runtime),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("stale ingress artifacts reject compatible-looking candidate", () => {
	const f = fixture();
	try {
		expect(() =>
			prepareTransaction(
				f.dir,
				{
					...f.manifest,
					ingress: { ...f.manifest.ingress, timing: "1".repeat(64) },
				},
				f.runtime,
			),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("old unreaped or ambiguous identity prevents candidate ownership", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		advanceTransaction(f.dir, "prepared", "draining");
		expect(() =>
			advanceTransaction(f.dir, "draining", "old_reaped", {}, () => true),
		).toThrow();
		expect(() =>
			advanceTransaction(f.dir, "draining", "old_reaped", {}, () => {
				throw new Error("EACCES");
			}),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("only ENOENT proves process absence; read failures hold recovery", () => {
	expect(
		processExists(42, "1", () => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		}),
	).toBe(false);
	for (const code of ["EACCES", "EIO"])
		expect(() =>
			processExists(42, "1", () => {
				throw Object.assign(new Error(code), { code });
			}),
		).toThrow();
	expect(() => processExists(42, "1", () => "malformed")).toThrow();
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		expect(
			recoverTransaction(f.dir, () => {
				throw new Error("unknown");
			}).action,
		).toBe("hold");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("rollback needs durable candidate identity plus positively reaped candidate and old pin", () => {
	const f = fixture();
	try {
		started(f);
		expect(() =>
			advanceTransaction(
				f.dir,
				"candidate_started",
				"rolled_back",
				{},
				() => true,
			),
		).toThrow();
		expect(
			advanceTransaction(
				f.dir,
				"candidate_started",
				"rolled_back",
				{},
				() => false,
			).phase,
		).toBe("rolled_back");
		expect(recoverTransaction(f.dir, () => false).action).toBe(
			"start_previous",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("candidate cannot attach before exact pin commit", () => {
	const f = fixture();
	try {
		started(f);
		advanceTransaction(
			f.dir,
			"candidate_started",
			"candidate_verified",
			{},
			() => true,
		);
		expect(() =>
			advanceTransaction(f.dir, "candidate_verified", "committed"),
		).toThrow();
		expect(() =>
			advanceTransaction(f.dir, "candidate_verified", "attached"),
		).toThrow();
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test.each([
	"prepared",
	"draining",
	"old_reaped",
	"candidate_started",
	"candidate_verified",
	"committed",
	"attached",
])("real child SIGKILL after fsync phase %s leaves one durable authority", (phase) => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		const module = new URL(
			"../ccflare-deployment-transaction.mjs",
			import.meta.url,
		).href;
		const child = spawnSync(
			resolveNodeExecutable(),
			[
				"--input-type=module",
				"-e",
				`import {readFileSync} from "node:fs";import {durableWrite} from ${JSON.stringify(module)};const path=process.argv[1];const intent=JSON.parse(readFileSync(path));intent.phase=process.argv[2];intent.candidatePid=999998;intent.candidateStartTime="2";durableWrite(path,intent);process.kill(process.pid,"SIGKILL");`,
				join(f.dir, "intent.json"),
				phase,
			],
			{ timeout: 2000 },
		);
		expect(child.signal).toBe("SIGKILL");
		expect(
			JSON.parse(readFileSync(join(f.dir, "intent.json"), "utf8")).phase,
		).toBe(phase);
		expect(recoverTransaction(f.dir, () => true).action).toBe("hold");
		if (!["prepared"].includes(phase))
			expect(recoverTransaction(f.dir, () => false).action).toBe("hold");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("a future bootstrap requires exact new immutable artifact, source, schema and pin", () => {
	const f = fixture();
	try {
		prepareTransaction(f.dir, f.manifest, f.runtime);
		const intent = JSON.parse(readFileSync(join(f.dir, "intent.json"), "utf8"));
		intent.phase = "attached";
		durableWrite(join(f.dir, "intent.json"), intent);
		const receipt = {
			binary: f.runtime.binary,
			binaryHash: f.runtime.binaryHash,
			sourceSha: "3".repeat(40),
			schemaDigest: "4".repeat(64),
			pinHash: fileHash(f.pin),
		};
		prepareBootstrap(f.dir, receipt);
		const configured = {
			binary: receipt.binary,
			sourceSha: receipt.sourceSha,
			schemaDigest: receipt.schemaDigest,
			pinPath: f.pin,
		};
		expect(recoverTransaction(f.dir, () => false, configured).action).toBe(
			"start_bootstrap",
		);
		expect(recoverTransaction(f.dir, () => true, configured).action).toBe(
			"hold",
		);
		expect(
			recoverTransaction(f.dir, () => false, {
				...configured,
				sourceSha: "5".repeat(40),
			}).action,
		).toBe("hold");
		writeFileSync(f.pin, "other-pin");
		expect(recoverTransaction(f.dir, () => false, configured).action).toBe(
			"hold",
		);
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});
test("crash before child PID receipt remains held even when prior child is gone", () => {
	const f = fixture();
	try {
		recordBackendOwner(f.dir, "spawning");
		expect(recoverTransaction(f.dir, () => false).action).toBe("hold");
		recordBackendOwner(f.dir, "running", 999998, "2");
		expect(recoverTransaction(f.dir, () => false).action).toBe("start");
		expect(recoverTransaction(f.dir, () => true).action).toBe("hold");
	} finally {
		rmSync(f.dir, { recursive: true, force: true });
	}
});

test("official inline Node bootstrap import does not execute CLI entrypoint", () => {
	const module = new URL(
		"../ccflare-deployment-transaction.mjs",
		import.meta.url,
	).href;
	const child = spawnSync(
		resolveNodeExecutable(),
		["--input-type=module", "-", module],
		{
			input:
				"const mod=await import(process.argv[2]);console.log(typeof mod.prepareBootstrap);",
			encoding: "utf8",
			timeout: 2000,
		},
	);
	expect(child.status).toBe(0);
	expect(child.stdout.trim()).toBe("function");
});
