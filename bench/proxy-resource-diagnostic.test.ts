import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ResourcePhaseRecorder,
	runSlowReaderAbortControl,
} from "./proxy-resource-diagnostic";

describe("bounded resource phase receipts", () => {
	test("persists complete aggregate phases without claiming successful workload exit", () => {
		const dir = mkdtempSync(join(tmpdir(), "resource-receipt-"));
		try {
			const path = join(dir, "phases.jsonl"),
				r = new ResourcePhaseRecorder(path);
			r.record("idle", { bodyBytes: 2, source: "private" } as never);
			const line = JSON.parse(readFileSync(path, "utf8").trim());
			expect(line).toMatchObject({
				schema: "ccflare.resource_phase.v1",
				phase: "idle",
				complete: true,
				workload: { bodyBytes: 2 },
				owners: {},
			});
			expect(line.workloadComplete).toBeUndefined();
			expect(JSON.stringify(line)).not.toContain("private");
			expect(() => new ResourcePhaseRecorder(path)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("bounds record count and bytes before publication", () => {
		const dir = mkdtempSync(join(tmpdir(), "resource-cap-"));
		try {
			const r = new ResourcePhaseRecorder(join(dir, "phases.jsonl"));
			for (let i = 0; i < 32; i++) r.record("idle", {});
			expect(() => r.record("idle", {})).toThrow("record budget");
			expect(
				readFileSync(join(dir, "phases.jsonl"), "utf8").length,
			).toBeLessThan(256 * 1024);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

test("a killed diagnostic preserves its last fsynced phase without a successful-exit receipt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "resource-kill-"));
	let child: Bun.Subprocess | undefined;
	try {
		const path = join(dir, "last.jsonl");
		const code = `import {ResourcePhaseRecorder,runSlowReaderAbortControl} from ${JSON.stringify(join(import.meta.dir, "proxy-resource-diagnostic.ts"))}; const r=new ResourcePhaseRecorder(${JSON.stringify(path)}); r.record("idle",{bodyBytes:2}); console.log("ready");setInterval(()=>{},1000);`;
		child = Bun.spawn([process.execPath, "-e", code], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (typeof child.stdout === "number" || !child.stdout)
			throw new Error("fixture stdout missing");
		const reader = child.stdout.getReader();
		const deadline = AbortSignal.timeout(2000);
		let ready = "";
		while (!ready.includes("ready")) {
			deadline.throwIfAborted();
			const { done, value } = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					deadline.addEventListener(
						"abort",
						() => reject(new Error("fixture ready timeout")),
						{ once: true },
					),
				),
			]);
			if (done) throw new Error("child exited before receipt");
			ready += new TextDecoder().decode(value);
		}
		reader.releaseLock();
		child.kill("SIGKILL");
		const codeResult = await child.exited;
		expect(codeResult).not.toBe(0);
		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ phase: "idle", complete: true });
		expect(lines[0].workloadComplete).toBeUndefined();
	} finally {
		if (child && child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a paused response reader releases admission and upstream ownership on abort", async () => {
	const result = await runSlowReaderAbortControl();
	expect(result.activeLeases).toBe(0);
	expect(result.reservedBytes).toBe(0);
	expect(result.aborted).toBeGreaterThan(0);
	expect(result.completed).toBe(0);
});
