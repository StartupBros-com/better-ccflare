import { describe, expect, it } from "bun:test";
import { parsePublicSubscriptionsConfig } from "../public-subscriptions-config";

const mapping = {
	accountId: "private",
	accountCreatedAt: 100,
	id: "weekly-value",
	label: "My subscription",
};

describe("public subscription publication configuration", () => {
	it("is disabled unless explicitly configured", () => {
		expect(parsePublicSubscriptionsConfig(undefined)).toEqual({
			status: "disabled",
		});
		expect(parsePublicSubscriptionsConfig("")).toEqual({ status: "disabled" });
	});
	it("preserves valid ASCII IDs at both length boundaries", () => {
		for (const id of ["a", "0", "A-b_9", "a".repeat(64)]) {
			expect(
				parsePublicSubscriptionsConfig(JSON.stringify([{ ...mapping, id }])),
			).toEqual({ status: "enabled", mappings: [{ ...mapping, id }] });
		}
		for (const id of ["", "a".repeat(65), "_slug", "-slug", "slüg"]) {
			expect(
				parsePublicSubscriptionsConfig(JSON.stringify([{ ...mapping, id }])),
			).toEqual({ status: "invalid" });
		}
	});
	it("rejects public IDs ending in a line terminator", () => {
		for (const id of ["slug\n", "slug\r", "slug\r\n", "slug ", "slug "]) {
			expect(
				parsePublicSubscriptionsConfig(JSON.stringify([{ ...mapping, id }])),
			).toEqual({ status: "invalid" });
		}
	});
	it("accepts only explicit bounded mappings", () => {
		expect(parsePublicSubscriptionsConfig(JSON.stringify([mapping]))).toEqual({
			status: "enabled",
			mappings: [mapping],
		});
		for (const value of [
			"bad",
			"{}",
			JSON.stringify([{ ...mapping, extra: true }]),
			JSON.stringify([{ ...mapping, accountCreatedAt: null }]),
			JSON.stringify([
				{ accountId: "private", id: "public", label: "Missing generation" },
			]),
			JSON.stringify([
				{ ...mapping, accountCreatedAt: Number.MAX_SAFE_INTEGER + 1 },
			]),
			JSON.stringify([{ ...mapping, label: "\ncontrol" }]),
			JSON.stringify([mapping, { ...mapping, accountId: "other" }]),
			JSON.stringify([mapping, { ...mapping, id: "other" }]),
			'[{"accountId":"private","accountCreatedAt":100,"id":"old","id":"public","label":"Label"}]',
			JSON.stringify([{ ...mapping, label: "<script>" }]),
			JSON.stringify([{ ...mapping, id: "a b" }]),
			JSON.stringify([mapping, mapping]),
			JSON.stringify(Array(17).fill(mapping)),
			" ".repeat(16385),
		]) {
			expect(parsePublicSubscriptionsConfig(value)).toEqual({
				status: "invalid",
			});
		}
	});
});
