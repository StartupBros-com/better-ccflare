import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Config,
	IMPLICIT_FALLBACK_POLICY_DEFAULTS,
	resolveImplicitFallbackPolicyConfig,
} from "./index";

const ENV_NAMES = [
	"CCFLARE_IMPLICIT_FALLBACK_MODE",
	"CCFLARE_IMPLICIT_FALLBACK_ALLOWED_CLASSES",
	"CCFLARE_IMPLICIT_FALLBACK_DENIED_CLASSES",
] as const;

function makeConfig(raw?: Record<string, unknown>): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-implicit-fallback-"));
	const configPath = join(dir, "config.json");
	if (raw) writeFileSync(configPath, JSON.stringify(raw), "utf8");
	return {
		config: new Config(configPath),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("implicit fallback policy configuration", () => {
	const originalEnv = Object.fromEntries(
		ENV_NAMES.map((name) => [name, process.env[name]]),
	) as Record<(typeof ENV_NAMES)[number], string | undefined>;

	beforeEach(() => {
		for (const name of ENV_NAMES) delete process.env[name];
	});

	afterEach(() => {
		for (const name of ENV_NAMES) {
			const value = originalEnv[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("is default-off with no implicit class denials", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getImplicitFallbackPolicyConfig()).toEqual(
				IMPLICIT_FALLBACK_POLICY_DEFAULTS,
			);
		} finally {
			cleanup();
		}
	});

	it("uses conservative paid/cloud denials when mode is explicitly enabled", () => {
		process.env.CCFLARE_IMPLICIT_FALLBACK_MODE = "enforce";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getImplicitFallbackPolicyConfig()).toEqual({
				mode: "enforce",
				allowedClasses: [],
				deniedClasses: ["api-key", "cloud-credential"],
			});
		} finally {
			cleanup();
		}
	});

	it("normalizes, deduplicates, and applies allowed classes as deny exceptions", () => {
		process.env.CCFLARE_IMPLICIT_FALLBACK_MODE = " OBSERVE ";
		process.env.CCFLARE_IMPLICIT_FALLBACK_ALLOWED_CLASSES =
			" api-key, local,api-key ";
		process.env.CCFLARE_IMPLICIT_FALLBACK_DENIED_CLASSES =
			"api-key, cloud-credential, oauth-subscription, cloud-credential";
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getImplicitFallbackPolicyConfig()).toEqual({
				mode: "observe",
				allowedClasses: ["api-key", "local"],
				deniedClasses: ["cloud-credential", "oauth-subscription"],
			});
		} finally {
			cleanup();
		}
	});

	it("gives each valid environment field precedence over the config file", () => {
		process.env.CCFLARE_IMPLICIT_FALLBACK_MODE = "enforce";
		const { config, cleanup } = makeConfig({
			implicit_fallback_mode: "observe",
			implicit_fallback_allowed_classes: "oauth-subscription",
			implicit_fallback_denied_classes: "api-key",
		});
		try {
			expect(config.getImplicitFallbackPolicyConfig()).toEqual({
				mode: "enforce",
				allowedClasses: ["oauth-subscription"],
				deniedClasses: ["api-key", "cloud-credential"],
			});
		} finally {
			cleanup();
		}
	});

	it("fails closed to the default-off policy when any supplied class is unknown", () => {
		const invalid = resolveImplicitFallbackPolicyConfig({
			mode: "enforce",
			deniedClasses: "api-key,not-a-route-class",
		});
		expect(invalid).toEqual(IMPLICIT_FALLBACK_POLICY_DEFAULTS);
	});

	it.each([
		["invalid mode", { mode: "maybe" }, "mode"],
		["non-string mode", { mode: 42 }, "mode"],
		["non-string class list", { deniedClasses: 42 }, "deniedClasses"],
		[
			"non-string list member",
			{ deniedClasses: ["api-key", 42] },
			"deniedClasses",
		],
		[
			"oversized list",
			{ deniedClasses: Array.from({ length: 17 }, () => "api-key") },
			"deniedClasses",
		],
	] as const)("fails closed for %s", (_label, input, field) => {
		const invalidFields: string[] = [];
		const resolved = resolveImplicitFallbackPolicyConfig(input, (invalid) =>
			invalidFields.push(invalid),
		);
		expect(resolved).toEqual(IMPLICIT_FALLBACK_POLICY_DEFAULTS);
		expect(invalidFields).toEqual([field]);
	});

	it("accepts a config-file CSV policy without persisting an expanded shape", () => {
		const { config, cleanup } = makeConfig({
			implicit_fallback_mode: "enforce",
			implicit_fallback_allowed_classes: "local",
			implicit_fallback_denied_classes: "api-key,cloud-credential",
		});
		try {
			expect(config.getImplicitFallbackPolicyConfig()).toEqual({
				mode: "enforce",
				allowedClasses: ["local"],
				deniedClasses: ["api-key", "cloud-credential"],
			});
		} finally {
			cleanup();
		}
	});
});
