import { describe, expect, it } from "bun:test";
import { DeepseekProvider } from "./index";

describe("provider package root exports", () => {
	it("exports DeepseekProvider", () => {
		expect(new DeepseekProvider().name).toBe("deepseek");
	});
});
