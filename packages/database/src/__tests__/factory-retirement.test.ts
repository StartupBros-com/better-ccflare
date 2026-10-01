import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory } from "../factory";

afterEach(async () => {
	await DatabaseFactory.closeAll();
});
describe("database factory retirement", () => {
	it("holds the singleton registration until asynchronous retirement completes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ccflare-factory-retirement-"));
		DatabaseFactory.initialize(join(dir, "test.db"));
		const db = DatabaseFactory.getInstance();
		const realClose = db.close.bind(db);
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		db.close = async () => {
			calls++;
			await released;
			await realClose();
		};
		try {
			const closing = DatabaseFactory.closeAll();
			let blocked = false;
			try {
				DatabaseFactory.getInstance();
			} catch (error) {
				blocked = String(error).includes("retiring");
			}
			expect(blocked).toBe(true);
			expect(DatabaseFactory.closeAll()).toBe(closing);
			release();
			await closing;
			expect(calls).toBe(1);
			DatabaseFactory.initialize(join(dir, "next.db"));
			expect(DatabaseFactory.getInstance()).not.toBe(db);
		} finally {
			release();
			await DatabaseFactory.closeAll();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
