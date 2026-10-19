import { expect, test } from "bun:test";
import { startExternalCodexScheduler } from "./external-codex-scheduler";

test("external scanner scheduler is disabled without configured sources", async () => {
	let runs = 0;
	const stop = startExternalCodexScheduler(
		false,
		async () => {
			runs++;
		},
		{ initialDelayMs: 1, intervalMs: 2 },
	);
	await Bun.sleep(10);
	stop();
	expect(runs).toBe(0);
});
test("scheduler prevents overlapping scans and stops cleanly", async () => {
	let runs = 0;
	let active = 0;
	let peak = 0;
	const stop = startExternalCodexScheduler(
		true,
		async () => {
			runs++;
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep(10);
			active--;
		},
		{ initialDelayMs: 1, intervalMs: 2 },
	);
	await Bun.sleep(25);
	stop();
	const saved = runs;
	await Bun.sleep(20);
	expect(runs).toBe(saved);
	expect(runs).toBeGreaterThan(0);
	expect(peak).toBe(1);
});

test("function-enabled scheduler notices sources enabled after boot", async () => {
	let enabled = false;
	let runs = 0;
	const stop = startExternalCodexScheduler(
		() => enabled,
		async () => {
			runs++;
		},
		{ initialDelayMs: 1, intervalMs: 2 },
	);
	await Bun.sleep(10);
	expect(runs).toBe(0);
	enabled = true;
	await Bun.sleep(15);
	stop();
	expect(runs).toBeGreaterThan(0);
});
