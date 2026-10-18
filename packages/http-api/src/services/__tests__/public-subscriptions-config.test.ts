import { describe, expect, it } from "bun:test";
import {
	isValidPublicId,
	isValidPublicLabel,
	parsePublicSubscriptionsConfig,
} from "../public-subscriptions-config";

const mapping = {
	accountId: "private",
	accountCreatedAt: 100,
	id: "weekly-value",
	label: "My subscription",
};
const parseMapping = (changes: Record<string, unknown>) =>
	parsePublicSubscriptionsConfig(JSON.stringify([{ ...mapping, ...changes }]));

describe("public subscription publication configuration", () => {
	it("is disabled unless explicitly configured", () => {
		expect(parsePublicSubscriptionsConfig(undefined)).toEqual({
			status: "disabled",
		});
		expect(parsePublicSubscriptionsConfig("")).toEqual({ status: "disabled" });
	});
	it("preserves valid ASCII IDs at both length boundaries", () => {
		for (const id of ["a", "0", "A-b_9", "a".repeat(64)]) {
			const entry = { ...mapping, accountId: "secret", id };
			expect(parsePublicSubscriptionsConfig(JSON.stringify([entry]))).toEqual({
				status: "enabled",
				mappings: [entry],
			});
		}
		for (const id of ["", "a".repeat(65), "_slug", "-slug", "slüg", "a b"]) {
			expect(parseMapping({ id })).toEqual({
				status: "invalid",
				reason: "bad_id",
				index: 0,
			});
		}
	});
	it("rejects public IDs ending in a line terminator", () => {
		for (const id of [
			"slug\n",
			"slug\r",
			"slug\r\n",
			"slug\u2028",
			"slug\u2029",
		]) {
			expect(parseMapping({ id })).toEqual({
				status: "invalid",
				reason: "bad_id",
				index: 0,
			});
		}
	});
	it("accepts only explicit bounded mappings", () => {
		expect(parsePublicSubscriptionsConfig(JSON.stringify([mapping]))).toEqual({
			status: "enabled",
			mappings: [mapping],
		});
		expect(parsePublicSubscriptionsConfig("[]")).toEqual({
			status: "enabled",
			mappings: [],
		});
		for (const [raw, reason, index] of [
			[" ".repeat(16385), "too_large", undefined],
			["bad", "not_json", undefined],
			["{}", "not_array", undefined],
			[JSON.stringify(Array(17).fill(mapping)), "too_many", undefined],
			[
				'[{"accountId":"private","accountCreatedAt":100,"id":"old","id":"public","label":"Label"}]',
				"duplicate_key",
				undefined,
			],
			[JSON.stringify([{ ...mapping, extra: true }]), "bad_keys", 0],
			[
				JSON.stringify([
					{ accountId: "private", id: "public", label: "Missing generation" },
				]),
				"bad_keys",
				0,
			],
			[JSON.stringify([null]), "bad_keys", 0],
			[
				JSON.stringify([mapping, { ...mapping, accountId: "other" }]),
				"duplicate_id",
				1,
			],
			[
				JSON.stringify([mapping, { ...mapping, id: "other" }]),
				"duplicate_account_id",
				1,
			],
			[JSON.stringify([mapping, mapping]), "duplicate_id", 1],
		] as const) {
			expect(parsePublicSubscriptionsConfig(raw)).toEqual({
				status: "invalid",
				reason,
				...(index === undefined ? {} : { index }),
			});
		}
	});
	it("rejects invalid private account identifiers", () => {
		for (const accountId of [
			null,
			"",
			" private",
			"private ",
			"private\n",
			"private\u007f",
			"private\u0085",
		]) {
			expect(parseMapping({ accountId })).toEqual({
				status: "invalid",
				reason: "bad_account_id",
				index: 0,
			});
		}
	});
	it("requires a nonnegative safe integer account generation", () => {
		for (const accountCreatedAt of [
			null,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			"100",
		]) {
			expect(parseMapping({ accountCreatedAt })).toEqual({
				status: "invalid",
				reason: "bad_account_created_at",
				index: 0,
			});
		}
		expect(parseMapping({ accountCreatedAt: 0 }).status).toBe("enabled");
	});
	it("rejects public identifiers overlapping private identifiers in either direction regardless of case", () => {
		for (const id of ["private", "PRIVATE", "RIV", "my-PRIVATE-plan"]) {
			expect(parseMapping({ id })).toEqual({
				status: "invalid",
				reason: "id_overlaps_account_id",
				index: 0,
			});
		}
	});
	it("rejects unsafe labels, including Unicode controls, formatting and line separators", () => {
		for (const label of [
			null,
			"",
			" label",
			"label ",
			"<script>",
			"label>",
			"\ncontrol",
			"label\u202e",
			"label\u200b",
			"label\u0085",
			"label\u2028",
			"label\u2029",
		]) {
			expect(parseMapping({ label })).toEqual({
				status: "invalid",
				reason: "bad_label",
				index: 0,
			});
		}
	});
	it("counts label length in Unicode code points", () => {
		const label = "😀".repeat(80);
		expect(parseMapping({ label })).toEqual({
			status: "enabled",
			mappings: [{ ...mapping, label }],
		});
		expect(parseMapping({ label: "😀".repeat(81) })).toEqual({
			status: "invalid",
			reason: "bad_label",
			index: 0,
		});
	});
	it("does not mistake colons in labels for duplicate object keys", () => {
		const label = 'Plan: "weekly": value';
		expect(parseMapping({ label })).toEqual({
			status: "enabled",
			mappings: [{ ...mapping, label }],
		});
	});
	it("selects the DB-backed roster only for the exact string accounts", () => {
		expect(parsePublicSubscriptionsConfig("accounts")).toEqual({
			status: "accounts",
		});
		for (const raw of ["Accounts", " accounts", "accounts ", "account"]) {
			expect(parsePublicSubscriptionsConfig(raw).status).toBe("invalid");
		}
	});
	it("exports the shared label and id validators used by both modes", () => {
		expect(isValidPublicLabel("Weekly plan")).toBe(true);
		expect(isValidPublicLabel("😀".repeat(80))).toBe(true);
		for (const bad of [
			"",
			" x",
			"x ",
			"a<b",
			"a>b",
			"a\tb",
			"a​b",
			"a b",
			"x".repeat(81),
			5,
			null,
		])
			expect(isValidPublicLabel(bad)).toBe(false);
		expect(isValidPublicId("sub-0123456789abcdef")).toBe(true);
		for (const bad of ["", "-x", "a b", "a".repeat(65), "a\n", 5, undefined])
			expect(isValidPublicId(bad)).toBe(false);
	});
});
