import { describe, expect, it } from "bun:test";
import { minimumRoutableTier } from "./strategy";

describe("minimumRoutableTier", () => {
	it("returns the lowest (best) numeric tier among candidates", () => {
		expect(minimumRoutableTier([2, 0, 1])).toBe(0);
	});

	it("is order-independent", () => {
		expect(minimumRoutableTier([5, 5, 1, 9])).toBe(1);
		expect(minimumRoutableTier([1, 5, 5, 9])).toBe(1);
	});

	it("handles a single-element input", () => {
		expect(minimumRoutableTier([3])).toBe(3);
	});

	it("returns null for an empty input", () => {
		expect(minimumRoutableTier([])).toBeNull();
	});

	it("treats negative tiers as lower (better) than zero", () => {
		expect(minimumRoutableTier([0, -1, 2])).toBe(-1);
	});
});
