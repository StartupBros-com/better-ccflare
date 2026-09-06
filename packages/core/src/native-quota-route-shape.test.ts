import { describe, expect, it } from "bun:test";
import type { Account, EffectiveComboMember } from "@better-ccflare/types";
import { validateNativeQuotaRouteShape } from "./native-quota-route-shape";

const account = (id: string, overrides: Partial<Account> = {}) =>
	({
		id,
		provider: "anthropic",
		refresh_token: "offline",
		access_token: "offline",
		api_key: null,
		billing_type: "plan",
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		paused: false,
		...overrides,
	}) as Account;
const member = (account_id: string, logical_model: string, tier = 0) =>
	({
		id: `${account_id}:${logical_model}`,
		account_id,
		logical_model,
		tier,
	}) as EffectiveComboMember;

describe("native quota route shape", () => {
	it("accepts same-pool Fable then Opus without deleting paused members", () => {
		expect(
			validateNativeQuotaRouteShape({
				family: "fable",
				accounts: [account("a", { paused: true })],
				members: [
					member("a", "claude-fable-5"),
					member("a", "claude-opus-5", 10),
				],
			}),
		).toEqual({ valid: true, primaryAccountIds: ["a"] });
	});
	it.each([
		["empty", [], [account("a")]],
		[
			"outside backup",
			[member("a", "claude-fable-5"), member("b", "claude-opus-5", 10)],
			[account("a"), account("b")],
		],
		[
			"backup first",
			[member("a", "claude-fable-5", 10), member("a", "claude-opus-5", 0)],
			[account("a")],
		],
		[
			"backup same tier",
			[member("a", "claude-fable-5"), member("a", "claude-opus-5")],
			[account("a")],
		],
		[
			"exact non-Claude mapping",
			[member("a", "claude-fable-5")],
			[account("a", { model_mappings: '{"claude-fable-5":"vendor/other"}' })],
		],
		[
			"exact cross-family mapping",
			[member("a", "claude-fable-5")],
			[account("a", { model_mappings: '{"claude-fable-5":"claude-opus-5"}' })],
		],
		["foreign family", [member("a", "claude-sonnet-5")], [account("a")]],
		[
			"foreign provider",
			[member("a", "claude-fable-5")],
			[account("a", { provider: "openrouter" })],
		],
		[
			"foreign destination",
			[member("a", "claude-fable-5")],
			[account("a", { custom_endpoint: "https://example.test" })],
		],
		[
			"mapping escape",
			[member("a", "claude-fable-5")],
			[
				account("a", {
					model_mappings: '{"fable":["claude-fable-5","claude-opus-5"]}',
				}),
			],
		],
		[
			"malformed mappings",
			[member("a", "claude-fable-5")],
			[account("a", { model_mappings: "{broken" })],
		],
		[
			"malformed embedded mappings",
			[member("a", "claude-fable-5")],
			[account("a", { custom_endpoint: '{"modelMappings":{"fable":[]}}' })],
		],
		[
			"api billing",
			[member("a", "claude-fable-5")],
			[account("a", { billing_type: "api" })],
		],
		["missing account", [member("b", "claude-fable-5")], [account("a")]],
	] as const)("rejects %s", (_name, members, accounts) => {
		expect(
			validateNativeQuotaRouteShape({ family: "fable", members, accounts })
				.valid,
		).toBe(false);
	});
	it.each([
		"model_mappings",
		"custom_endpoint",
	] as const)("matches the physical parser's 16-candidate limit for %s", (field) => {
		for (const [length, expectedValid] of [
			[16, true],
			[17, false],
		] as const) {
			const mappings = {
				fable: Array.from(
					{ length },
					(_, index) => `claude-fable-5-${index + 1}`,
				),
			};
			const value =
				field === "custom_endpoint"
					? { endpoint: "https://api.anthropic.com", modelMappings: mappings }
					: mappings;
			expect(
				validateNativeQuotaRouteShape({
					family: "fable",
					accounts: [account("a", { [field]: JSON.stringify(value) })],
					members: [member("a", "claude-fable-5")],
				}).valid,
			).toBe(expectedValid);
		}
	});
	it("rejects legacy fallback arrays that the physical parser ignores", () => {
		expect(
			validateNativeQuotaRouteShape({
				family: "fable",
				accounts: [
					account("a", {
						model_fallbacks: JSON.stringify({ fable: ["claude-fable-5-1"] }),
					}),
				],
				members: [member("a", "claude-fable-5")],
			}).valid,
		).toBe(false);
	});
	it("other supported families cannot use cross-family backups", () => {
		expect(
			validateNativeQuotaRouteShape({
				family: "opus",
				accounts: [account("a")],
				members: [member("a", "claude-opus-5")],
			}).valid,
		).toBe(true);
		expect(
			validateNativeQuotaRouteShape({
				family: "sonnet",
				accounts: [account("a")],
				members: [
					member("a", "claude-sonnet-5"),
					member("a", "claude-opus-5", 10),
				],
			}).valid,
		).toBe(false);
	});
});
