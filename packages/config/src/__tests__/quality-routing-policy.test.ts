import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, parseQualityRoutingPolicy } from "../index";

const ENV = "CCFLARE_QUALITY_ROUTING_POLICY_JSON";
const ROUTE_ENV = "CCFLARE_MODEL_ROUTE_PROFILES_JSON";
const savedEnv = process.env[ENV];
const savedRoutes = process.env[ROUTE_ENV];
const directories: string[] = [];

function approvedInput(accountId = "test-native") {
	return {
		version: 1,
		assignments: [
			{
				line: "claude-fable",
				lane: "fable",
				priority: 0,
				upgrade: "same-line-supported",
			},
		],
		accounts: [
			{
				accountId,
				provider: "anthropic",
				lines: ["claude-fable"],
				priority: 0,
			},
		],
		fallbacks: [
			{ from: "fable", to: "astra" },
			{ from: "astra", to: "opus" },
		],
		spendGrants: [],
	};
}

function configPath(data: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-quality-policy-"));
	directories.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return path;
}

beforeEach(() => {
	delete process.env[ENV];
	delete process.env[ROUTE_ENV];
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV];
	else process.env[ENV] = savedEnv;
	if (savedRoutes === undefined) delete process.env[ROUTE_ENV];
	else process.env[ROUTE_ENV] = savedRoutes;
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("quality routing config", () => {
	it("disables absence and empty configuration without adding defaults", () => {
		for (const value of [undefined, "", "   ", {}, "{}"] as const) {
			const path = configPath(
				value === undefined ? {} : { quality_routing_policy: value },
			);
			const before = readFileSync(path, "utf8");
			expect(new Config(path).getQualityRoutingPolicy()).toBeNull();
			expect(readFileSync(path, "utf8")).toBe(before);
		}
	});

	it("accepts a strict object or JSON string in the file", () => {
		for (const value of [approvedInput(), JSON.stringify(approvedInput())]) {
			const config = new Config(configPath({ quality_routing_policy: value }));
			expect(config.getQualityRoutingPolicy()?.accounts[0].accountId).toBe(
				"test-native",
			);
		}
	});

	it.each([
		true,
		false,
	])("parses worker flagship fallback %j from file objects, file JSON and environment JSON", (workerFlagshipFallback) => {
		const input = { ...approvedInput(), workerFlagshipFallback };
		const expected = workerFlagshipFallback
			? ["standard", "fable", "astra", "opus"]
			: ["standard"];
		for (const value of [input, JSON.stringify(input)]) {
			const config = new Config(configPath({ quality_routing_policy: value }));
			expect(config.getQualityRoutingPolicy()?.workerLanes.standard).toEqual(
				expected,
			);
		}
		process.env[ENV] = JSON.stringify(input);
		const config = new Config(
			configPath({
				quality_routing_policy: {
					...approvedInput(),
					workerFlagshipFallback: !workerFlagshipFallback,
				},
			}),
		);
		expect(config.getQualityRoutingPolicy()?.workerLanes.standard).toEqual(
			expected,
		);
	});

	it("omitted and false JSON opt-in compile to the same legacy policy", () => {
		const legacy = parseQualityRoutingPolicy(JSON.stringify(approvedInput()));
		const disabled = parseQualityRoutingPolicy(
			JSON.stringify({ ...approvedInput(), workerFlagshipFallback: false }),
		);
		expect(JSON.stringify(disabled)).toBe(JSON.stringify(legacy));
		expect(disabled).not.toHaveProperty("workerFlagshipFallback");
	});

	it.each(
		[null, 0, 1, "true", "false", {}, []].map((value) => [value]),
	)("rejects malformed worker flagship fallback %j in file and environment policies", (workerFlagshipFallback) => {
		const input = { ...approvedInput(), workerFlagshipFallback };
		for (const value of [input, JSON.stringify(input)]) {
			expect(
				() => new Config(configPath({ quality_routing_policy: value })),
			).toThrow("workerFlagshipFallback: must be a boolean");
		}
		process.env[ENV] = JSON.stringify(input);
		expect(
			() => new Config(configPath({ quality_routing_policy: approvedInput() })),
		).toThrow("workerFlagshipFallback: must be a boolean");
	});

	it("gives even empty environment JSON precedence over the file", () => {
		const path = configPath({
			quality_routing_policy: approvedInput("from-file"),
		});
		process.env[ENV] = JSON.stringify(approvedInput("from-env"));
		expect(
			new Config(path).getQualityRoutingPolicy()?.accounts[0].accountId,
		).toBe("from-env");
		for (const blank of ["", " ", "{}"]) {
			process.env[ENV] = blank;
			expect(new Config(path).getQualityRoutingPolicy()).toBeNull();
		}
		delete process.env[ENV];
		expect(
			new Config(path).getQualityRoutingPolicy()?.accounts[0].accountId,
		).toBe("from-file");
	});

	it("fails startup for malformed nonempty environment JSON instead of falling back", () => {
		const path = configPath({ quality_routing_policy: approvedInput() });
		for (const raw of [
			"{",
			"null",
			"false",
			"1",
			"[]",
			'""',
			'{"paid":true}',
			JSON.stringify({ ...approvedInput(), providerScope: "all" }),
		]) {
			process.env[ENV] = raw;
			expect(() => new Config(path)).toThrow("quality_routing_policy");
		}
	});

	it("fails startup for malformed file policy but honors an explicit overriding environment", () => {
		for (const value of [
			null,
			false,
			1,
			[],
			"false",
			{
				...approvedInput(),
				spendGrants: [
					{ accountId: "*", line: "claude-fable", authorization: true },
				],
			},
		]) {
			expect(
				() => new Config(configPath({ quality_routing_policy: value })),
			).toThrow("quality_routing_policy");
		}
		process.env[ENV] = JSON.stringify(approvedInput());
		expect(
			new Config(
				configPath({ quality_routing_policy: false }),
			).getQualityRoutingPolicy()?.accounts[0].accountId,
		).toBe("test-native");
	});

	it("rejects duplicate JSON keys, excessive depth and oversized JSON", () => {
		expect(() =>
			parseQualityRoutingPolicy('{"version":1,"version":1}'),
		).toThrow("quality_routing_policy");
		expect(() =>
			parseQualityRoutingPolicy('{"version":1,"\\u0076ersion":1}'),
		).toThrow("quality_routing_policy");
		expect(() =>
			parseQualityRoutingPolicy(
				`${JSON.stringify(approvedInput()).slice(0, -1)},"workerFlagshipFallback":true,"workerFlagshipFallback":false}`,
			),
		).toThrow("strict JSON");
		expect(() =>
			parseQualityRoutingPolicy("[".repeat(70) + "]".repeat(70)),
		).toThrow("quality_routing_policy");
		expect(() => parseQualityRoutingPolicy(`${" ".repeat(262_145)}{}`)).toThrow(
			"quality_routing_policy",
		);
	});

	it("keeps legacy route configuration and manual overrides independent", () => {
		process.env[ROUTE_ENV] = JSON.stringify([
			{
				id: "manual",
				accountId: "manual-account",
				logicalModel: "claude-opus-5",
				displayName: "Manual",
			},
		]);
		const path = configPath({
			quality_routing_policy: approvedInput(),
			force_account_model: false,
			provider_model_default_overrides: {
				codex: { sonnet: "unclassified-manual-model" },
			},
		});
		const config = new Config(path);
		expect(config.getForceAccountModel()).toBe(false);
		expect(config.getProviderModelDefaultOverrides()).toEqual({
			codex: { sonnet: "unclassified-manual-model" },
		});
		expect(config.getQualityRoutingPolicy()?.lanes.standard).toEqual([]);
		expect(process.env[ROUTE_ENV]).toContain("manual-account");
	});

	it("reading a priority update emits no retry/change event and preserves earlier policy values", () => {
		const path = configPath({ quality_routing_policy: approvedInput() });
		const config = new Config(path);
		const first = config.getQualityRoutingPolicy();
		const events: unknown[] = [];
		config.on("change", (value) => events.push(value));
		const next = approvedInput();
		next.accounts[0].priority = 4;
		process.env[ENV] = JSON.stringify(next);
		const second = config.getQualityRoutingPolicy();
		expect(second?.revision).not.toBe(first?.revision);
		expect(first?.accounts[0].priority).toBe(0);
		expect(second?.accounts[0].priority).toBe(4);
		expect(events).toEqual([]);
		expect(
			JSON.parse(readFileSync(path, "utf8")).quality_routing_policy.accounts[0]
				.priority,
		).toBe(0);
	});

	it("rejects invalid generic writes before persistence or change notification", () => {
		const path = configPath({ quality_routing_policy: approvedInput() });
		const config = new Config(path);
		const before = readFileSync(path, "utf8");
		const events: unknown[] = [];
		config.on("change", (value) => events.push(value));
		expect(() => config.set("quality_routing_policy", '{"paid":true}')).toThrow(
			"quality_routing_policy",
		);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(events).toEqual([]);
		config.set(
			"quality_routing_policy",
			JSON.stringify(approvedInput("updated")),
		);
		expect(config.getQualityRoutingPolicy()?.accounts[0].accountId).toBe(
			"updated",
		);
	});
});
