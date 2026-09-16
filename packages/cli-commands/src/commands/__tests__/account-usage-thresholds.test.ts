import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";

// Keep this name-based command contract independent of the worker-backed DB.
mock.module("@better-ccflare/database", () => ({
	DatabaseOperations: class DatabaseOperations {},
	DatabaseFactory: class DatabaseFactory {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));
const { setUsagePauseThresholds } = await import("../account");

const account = {
	id: "account-id",
	provider: "anthropic",
	custom_endpoint: null as string | null,
	usage_pause_five_hour_threshold: 70,
	usage_pause_weekly_threshold: 90,
};

function setup(row: Partial<typeof account> | null = {}) {
	const get = mock(async (_sql: string, _params: unknown[]) =>
		row === null ? undefined : { ...account, ...row },
	);
	const write = mock(async () => {});
	const db = {
		getAdapter: () => ({ get }),
		setUsagePauseThresholds: write,
	} as unknown as DatabaseOperations;
	return { db, get, write };
}

describe("setUsagePauseThresholds", () => {
	it("looks up the exact account name and reports an absent account without writing", async () => {
		const { db, get, write } = setup(null);
		expect(await setUsagePauseThresholds(db, "my account", 80, 90)).toEqual({
			success: false,
			message: "Account 'my account' not found",
		});
		expect(get).toHaveBeenCalledTimes(1);
		expect(get.mock.calls[0]?.[1]).toEqual(["my account"]);
		expect(write).not.toHaveBeenCalled();
	});

	it.each([
		{ provider: "openai-compatible" },
		{ provider: "xai" },
		{
			provider: "codex",
			custom_endpoint: "https://api.openai.com/v1/responses",
		},
	])("rejects accounts without compatible usage windows: %j", async (row) => {
		const { db, write } = setup(row);
		const result = await setUsagePauseThresholds(db, "my account", 80, 90);
		expect(result.success).toBe(false);
		expect(result.message).toContain("not supported");
		expect(write).not.toHaveBeenCalled();
	});

	it.each([
		"80.5",
		"80junk",
		"0",
		"101",
	])("rejects malformed percentages in either window: %s", async (value) => {
		for (const [fiveHour, weekly] of [
			[value, "90"],
			["80", value],
		]) {
			const { db, write } = setup();
			const result = await setUsagePauseThresholds(
				db,
				"my account",
				fiveHour,
				weekly,
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain("whole number between 1 and 100");
			expect(write).not.toHaveBeenCalled();
		}
	});

	it.each([
		{ provider: "anthropic" },
		{ provider: "codex" },
		{
			provider: "codex",
			custom_endpoint: "https://chatgpt.com/backend-api/codex/responses",
		},
	])("writes independent validated windows for supported accounts: %j", async (row) => {
		const { db, write } = setup(row);
		const result = await setUsagePauseThresholds(db, "my account", "81", 93);
		expect(result.success).toBe(true);
		expect(write).toHaveBeenCalledWith(
			"account-id",
			{ enabled: true, percent: 81 },
			{ enabled: true, percent: 93 },
		);
		expect(result.message).toContain("5h=81%, weekly=93%");
	});

	it.each([
		[null, 85, { enabled: false, percent: 70 }, { enabled: true, percent: 85 }],
		[85, null, { enabled: true, percent: 85 }, { enabled: false, percent: 90 }],
		[
			null,
			null,
			{ enabled: false, percent: 70 },
			{ enabled: false, percent: 90 },
		],
	] as const)("switches windows off without erasing their remembered percentages (%s, %s)", async (five, week, expectedFive, expectedWeek) => {
		const { db, write } = setup();
		const result = await setUsagePauseThresholds(db, "my account", five, week);
		expect(result.success).toBe(true);
		expect(write).toHaveBeenCalledWith(
			"account-id",
			expectedFive,
			expectedWeek,
		);
		expect(result.message).toContain("remembered");
	});
});
