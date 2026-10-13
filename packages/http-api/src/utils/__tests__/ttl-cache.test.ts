import { describe, expect, it } from "bun:test";
import { createTtlCache } from "../ttl-cache";

describe("bounded TTL cache", () => {
	it("caches values and expires exactly at the TTL boundary", async () => {
		let now = 0;
		let calls = 0;
		const cache = createTtlCache<number>(1000, () => now);
		const load = async () => ++calls;
		expect(await cache.get("a", load)).toBe(1);
		now = 999;
		expect(await cache.get("a", load)).toBe(1);
		now = 1000;
		expect(await cache.get("a", load)).toBe(2);
	});
	it("keeps keys separate and caps completed keys without evicting active loads", async () => {
		const cache = createTtlCache<number>(1000, () => 0);
		let release: (value: number) => void = () => {};
		const running = cache.get(
			"active",
			() =>
				new Promise<number>((resolve) => {
					release = resolve;
				}),
		);
		for (let index = 0; index < 40; index++)
			await cache.get(String(index), async () => index);
		expect(cache.get("active", async () => -1)).toBe(running);
		release(99);
		expect(await running).toBe(99);
		expect(await cache.get("39", async () => -1)).toBe(39);
		expect(await cache.get("0", async () => -1)).toBe(-1);
	});
	it("does not cache rejections or synchronous throws", async () => {
		const cache = createTtlCache<number>(1000);
		await expect(
			cache.get("a", () => {
				throw new Error("sync");
			}),
		).rejects.toThrow("sync");
		await expect(
			cache.get("a", async () => {
				throw new Error("async");
			}),
		).rejects.toThrow("async");
		expect(await cache.get("a", async () => 3)).toBe(3);
	});
	for (const reject of [false, true]) {
		it(`does not let a cleared load ${reject ? "rejection" : "result"} replace a newer generation`, async () => {
			const cache = createTtlCache<number>(1000);
			let settle: () => void = () => {};
			const old = cache.get(
				"a",
				() =>
					new Promise<number>((resolve, fail) => {
						settle = () => (reject ? fail(new Error("old")) : resolve(1));
					}),
			);
			const observed = old.catch(() => -1);
			cache.clear();
			expect(await cache.get("a", async () => 2)).toBe(2);
			settle();
			await observed;
			expect(await cache.get("a", async () => 3)).toBe(2);
		});
	}
});
