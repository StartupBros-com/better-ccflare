import { describe, expect, it } from "bun:test";
import {
	MODEL_ROUTE_PROFILE_MODEL_PREFIX,
	ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "../model-route-profiles";

const PROFILE_JSON = JSON.stringify([
	{
		id: "pro-primary-sol",
		displayName: "GPT-5.6 Sol · pro-primary",
		description: "Pinned high-reasoning route",
		accountId: "df44bdf6-d646-45aa-b3d1-1b2b2cdbf774",
		logicalModel: "claude-opus-5",
		defaultEffort: "xhigh",
		expectedProvider: "codex",
		expectedPhysicalModel: "gpt-5.6-sol",
	},
]);

function profile() {
	const [configured] = parseModelRouteProfiles(PROFILE_JSON);
	if (!configured) throw new Error("Expected the test route profile to parse");
	return configured;
}

function alternateProfile() {
	const [configured] = parseModelRouteProfiles(
		JSON.stringify([
			{
				id: "alternate-sol",
				displayName: "Alternate Sol route",
				accountId: "alternate-account",
				logicalModel: "claude-opus-5",
				defaultEffort: "max",
			},
		]),
	);
	if (!configured) throw new Error("Expected the alternate route to parse");
	return configured;
}

function makeClock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function resolveAndCommit(
	registry: ModelRouteSessionRegistry,
	input: Parameters<ModelRouteSessionRegistry["resolve"]>[0],
) {
	const resolution = resolveRequest(registry, input);
	registry.commitExplicit(input, resolution);
	return resolution;
}

function resolveRequest(
	registry: ModelRouteSessionRegistry,
	input: Parameters<ModelRouteSessionRegistry["resolve"]>[0],
	rootIntentGeneration: number | null = registry.beginRootIntent(input),
) {
	return registry.resolve(input, rootIntentGeneration);
}

describe("parseModelRouteProfiles", () => {
	it("returns no profiles for absent or blank configuration", () => {
		expect(parseModelRouteProfiles()).toEqual([]);
		expect(parseModelRouteProfiles("   ")).toEqual([]);
	});

	it("preserves existing profile shapes when optional bounded fields are absent", () => {
		expect(profile()).toEqual({
			id: "pro-primary-sol",
			publicModelId: `${MODEL_ROUTE_PROFILE_MODEL_PREFIX}pro-primary-sol`,
			displayName: "GPT-5.6 Sol · pro-primary",
			description: "Pinned high-reasoning route",
			accountId: "df44bdf6-d646-45aa-b3d1-1b2b2cdbf774",
			logicalModel: "claude-opus-5",
			defaultEffort: "xhigh",
			expectedProvider: "codex",
			expectedPhysicalModel: "gpt-5.6-sol",
		});
	});

	it("parses bounded exclusive settings on an exact-account profile", () => {
		const [configured] = parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "glm-5-2-bounded-v1",
					displayName: "GLM-5.2 Local (bounded v1)",
					accountId: "mac-studio",
					logicalModel: "claude-fable-5",
					exclusiveAccount: true,
					contextWindow: 24_000,
					maxOutputTokens: 4_000,
				},
			]),
		);

		expect(configured).toMatchObject({
			exclusiveAccount: true,
			contextWindow: 24_000,
			maxOutputTokens: 4_000,
		});
	});

	it("rejects malformed bounded exclusive settings", () => {
		const exactProfile = {
			id: "bounded-route",
			displayName: "Bounded route",
			accountId: "account",
			logicalModel: "claude-fable-5",
		};
		const malformed = [
			{ ...exactProfile, exclusiveAccount: "true" },
			{ ...exactProfile, exclusiveAccount: 1 },
			{ ...exactProfile, exclusiveAccount: null },
			{ ...exactProfile, contextWindow: 24_000 },
			{ ...exactProfile, maxOutputTokens: 4_000 },
			{ ...exactProfile, contextWindow: "24000", maxOutputTokens: 4_000 },
			{ ...exactProfile, contextWindow: 24_000, maxOutputTokens: "4000" },
			{ ...exactProfile, contextWindow: 24_000.5, maxOutputTokens: 4_000 },
			{ ...exactProfile, contextWindow: 24_000, maxOutputTokens: 4_000.5 },
			{ ...exactProfile, contextWindow: 0, maxOutputTokens: 4_000 },
			{ ...exactProfile, contextWindow: 24_000, maxOutputTokens: 0 },
			{ ...exactProfile, contextWindow: -1, maxOutputTokens: 4_000 },
			{ ...exactProfile, contextWindow: 24_000, maxOutputTokens: -1 },
			{ ...exactProfile, contextWindow: 4_000, maxOutputTokens: 4_000 },
			{ ...exactProfile, contextWindow: 3_999, maxOutputTokens: 4_000 },
		];

		for (const candidate of malformed) {
			expect(() =>
				parseModelRouteProfiles(JSON.stringify([candidate])),
			).toThrow("CCFLARE_MODEL_ROUTE_PROFILES_JSON");
		}
	});

	it("rejects exclusive accounts on capability profiles", () => {
		expect(() =>
			parseModelRouteProfiles(
				JSON.stringify([
					{
						id: "capability-route",
						displayName: "Capability route",
						selection: "capability",
						logicalModel: "claude-fable-5",
						expectedProvider: "codex",
						expectedPhysicalModel: "gpt-5.6-sol",
						exclusiveAccount: true,
					},
				]),
			),
		).toThrow("CCFLARE_MODEL_ROUTE_PROFILES_JSON");
	});

	it("parses a capability profile without pinning an account", () => {
		const [configured] = parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "sol-capability",
					displayName: "GPT-5.6 Sol · available account",
					selection: "capability",
					logicalModel: "claude-opus-5",
					expectedProvider: "CODEX",
					expectedPhysicalModel: "gpt-5.6-sol",
				},
			]),
		);
		expect(configured).toMatchObject({
			selection: "capability",
			expectedProvider: "codex",
			expectedPhysicalModel: "gpt-5.6-sol",
		});
		expect(configured?.accountId).toBeUndefined();
	});

	it("accepts every supported effort and omits optional fields", () => {
		for (const defaultEffort of [
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]) {
			const parsed = parseModelRouteProfiles(
				JSON.stringify([
					{
						id: `effort-${defaultEffort}`,
						displayName: "Effort route",
						accountId: "account",
						logicalModel: "claude-opus-5",
						defaultEffort,
					},
				]),
			);
			expect(parsed[0]?.defaultEffort).toBe(defaultEffort);
			expect(parsed[0]?.description).toBeUndefined();
			expect(parsed[0]?.expectedProvider).toBeUndefined();
			expect(parsed[0]?.expectedPhysicalModel).toBeUndefined();
		}
	});

	it("rejects malformed nonempty configuration instead of silently disabling routes", () => {
		for (const input of [
			"not-json",
			JSON.stringify({}),
			JSON.stringify([null]),
			JSON.stringify([
				{
					id: "Uppercase",
					displayName: "Route",
					accountId: "account",
					logicalModel: "claude-opus-5",
				},
			]),
			JSON.stringify([
				{
					id: "route",
					displayName: "",
					accountId: "account",
					logicalModel: "claude-opus-5",
				},
			]),
			JSON.stringify([
				{
					id: "route",
					displayName: "Route",
					accountId: "account",
					logicalModel: "claude-opus-5",
					defaultEffort: "ultra",
				},
			]),
			JSON.stringify([
				{
					id: "route",
					displayName: "Route",
					accountId: "account",
					logicalModel: "claude-opus-5",
					unexpected: true,
				},
			]),
			JSON.stringify([
				{
					id: "route",
					displayName: "Route",
					selection: "capability",
					logicalModel: "claude-opus-5",
					expectedProvider: "codex",
				},
			]),
			JSON.stringify([
				{
					id: "route",
					displayName: "Route",
					selection: "capability",
					accountId: "account",
					logicalModel: "claude-opus-5",
					expectedProvider: "codex",
					expectedPhysicalModel: "gpt-5.6-sol",
				},
			]),
			JSON.stringify([
				{
					id: "route",
					displayName: "Route",
					selection: "other",
					logicalModel: "claude-opus-5",
					accountId: "account",
				},
			]),
		]) {
			expect(() => parseModelRouteProfiles(input)).toThrow(
				"CCFLARE_MODEL_ROUTE_PROFILES_JSON",
			);
		}
	});

	it("rejects more than 32 profiles and duplicate route identities", () => {
		const makeEntry = (id: string) => ({
			id,
			displayName: id,
			accountId: `account-${id}`,
			logicalModel: "claude-opus-5",
		});
		expect(() =>
			parseModelRouteProfiles(
				JSON.stringify(
					Array.from({ length: 33 }, (_, i) => makeEntry(`r-${i}`)),
				),
			),
		).toThrow("at most 32");
		expect(() =>
			parseModelRouteProfiles(
				JSON.stringify([makeEntry("same"), makeEntry("same")]),
			),
		).toThrow("duplicate");
	});
});

describe("ModelRouteSessionRegistry", () => {
	it("routes an exact virtual model without requiring a session", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured]);
		expect(
			resolveRequest(registry, {
				callerIdentity: null,
				requestModel: configured.publicModelId,
				sessionId: null,
				isSubagent: false,
			}),
		).toEqual({
			kind: "route",
			source: "explicit",
			profile: configured,
			generation: null,
		});
		expect(registry.size).toBe(0);
	});

	it("binds an explicit route and inherits it for child-agent model overrides", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured]);
		const input = {
			callerIdentity: "api-key:one",
			requestModel: configured.publicModelId,
			sessionId: "session-a",
			isSubagent: false,
		};
		const explicit = resolveRequest(registry, input);
		expect(registry.size).toBe(0);
		registry.commitExplicit(input, explicit);
		expect(explicit).toEqual({
			kind: "route",
			source: "explicit",
			profile: configured,
			generation: 1,
		});

		for (const requestModel of ["claude-sonnet-4-5", "claude-haiku-4-5"]) {
			expect(
				resolveRequest(registry, {
					callerIdentity: "api-key:one",
					requestModel,
					sessionId: "session-a",
					isSubagent: true,
				}),
			).toEqual({
				kind: "route",
				source: "inherited",
				profile: configured,
			});
		}
	});

	it("gives child inheritance precedence over configured profile ids", () => {
		const configured = profile();
		const [other] = parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "other-route",
					displayName: "Other route",
					accountId: "other-account",
					logicalModel: "claude-fable-5",
					defaultEffort: "max",
				},
			]),
		);
		if (!other) throw new Error("Expected the second route profile to parse");
		const registry = new ModelRouteSessionRegistry([configured, other]);
		resolveAndCommit(registry, {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "session",
			isSubagent: false,
		});

		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: other.publicModelId,
				sessionId: "session",
				isSubagent: true,
			}),
		).toEqual({ kind: "route", source: "inherited", profile: configured });
		expect(registry.size).toBe(1);
	});

	it("fails a configured child profile locally when no parent binding exists", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured]);
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: configured.publicModelId,
				sessionId: "session",
				isSubagent: true,
			}),
		).toEqual({ kind: "unavailable", reason: "unbound_child_profile" });
		expect(registry.size).toBe(0);
	});

	it("clears the binding when the same caller/session makes a native root request", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured]);
		resolveAndCommit(registry, {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "session",
			isSubagent: false,
		});
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: "claude-opus-5",
				sessionId: "session",
				isSubagent: false,
			}),
		).toEqual({ kind: "native" });
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: "claude-sonnet-4-5",
				sessionId: "session",
				isSubagent: true,
			}),
		).toEqual({ kind: "native" });
	});

	it("prevents an older explicit resolve from overwriting a newer explicit intent", () => {
		const configured = profile();
		const alternate = alternateProfile();
		const registry = new ModelRouteSessionRegistry([configured, alternate]);
		const baseInput = {
			callerIdentity: "caller",
			sessionId: "session",
			isSubagent: false,
		};
		const older = resolveRequest(registry, {
			...baseInput,
			requestModel: configured.publicModelId,
		});
		const newer = resolveRequest(registry, {
			...baseInput,
			requestModel: alternate.publicModelId,
		});

		expect(older).toMatchObject({ generation: 1 });
		expect(newer).toMatchObject({ generation: 2 });
		registry.commitExplicit(
			{ ...baseInput, requestModel: alternate.publicModelId },
			newer,
		);
		registry.commitExplicit(
			{ ...baseInput, requestModel: configured.publicModelId },
			older,
		);

		expect(
			resolveRequest(registry, {
				...baseInput,
				requestModel: "claude-sonnet-4-5",
				isSubagent: true,
			}),
		).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: alternate,
		});
	});

	it("prevents an older explicit resolve from resurrecting after a newer native clear", () => {
		const configured = profile();
		const alternate = alternateProfile();
		const registry = new ModelRouteSessionRegistry([configured, alternate]);
		const baseInput = {
			callerIdentity: "caller",
			sessionId: "session",
			isSubagent: false,
		};
		resolveAndCommit(registry, {
			...baseInput,
			requestModel: configured.publicModelId,
		});
		const pending = resolveRequest(registry, {
			...baseInput,
			requestModel: alternate.publicModelId,
		});
		expect(pending).toMatchObject({ generation: 2 });
		expect(
			resolveRequest(registry, {
				...baseInput,
				requestModel: "claude-opus-5",
			}),
		).toEqual({ kind: "native" });

		registry.commitExplicit(
			{ ...baseInput, requestModel: alternate.publicModelId },
			pending,
		);
		expect(
			resolveRequest(registry, {
				...baseInput,
				requestModel: "claude-sonnet-4-5",
				isSubagent: true,
			}),
		).toEqual({ kind: "native" });
	});

	it("orders root intent by reservation when a newer native resolve finishes first", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured]);
		const baseInput = {
			callerIdentity: "caller",
			sessionId: "inverted-native-session",
			isSubagent: false,
		};
		const explicitInput = {
			...baseInput,
			requestModel: configured.publicModelId,
		};
		const nativeInput = {
			...baseInput,
			requestModel: "claude-opus-5",
		};
		const olderExplicit = registry.beginRootIntent(explicitInput);
		const newerNative = registry.beginRootIntent(nativeInput);

		expect(resolveRequest(registry, nativeInput, newerNative)).toEqual({
			kind: "native",
		});
		const staleExplicit = resolveRequest(
			registry,
			explicitInput,
			olderExplicit,
		);
		registry.commitExplicit(explicitInput, staleExplicit);

		expect(
			resolveRequest(
				registry,
				{
					...baseInput,
					requestModel: "claude-sonnet-4-5",
					isSubagent: true,
				},
				null,
			),
		).toEqual({ kind: "native" });
	});

	it("does not let an older native resolve clear a newer explicit intent", () => {
		const configured = profile();
		const alternate = alternateProfile();
		const registry = new ModelRouteSessionRegistry([configured, alternate]);
		const baseInput = {
			callerIdentity: "caller",
			sessionId: "inverted-explicit-session",
			isSubagent: false,
		};
		const nativeInput = {
			...baseInput,
			requestModel: "claude-opus-5",
		};
		const explicitInput = {
			...baseInput,
			requestModel: alternate.publicModelId,
		};
		const olderNative = registry.beginRootIntent(nativeInput);
		const newerExplicit = registry.beginRootIntent(explicitInput);

		const explicit = resolveRequest(registry, explicitInput, newerExplicit);
		registry.commitExplicit(explicitInput, explicit);
		expect(resolveRequest(registry, nativeInput, olderNative)).toEqual({
			kind: "native",
		});

		expect(
			resolveRequest(
				registry,
				{
					...baseInput,
					requestModel: "claude-sonnet-4-5",
					isSubagent: true,
				},
				null,
			),
		).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: alternate,
		});
	});

	it("fails a pending commit closed when its intent watermark is evicted", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			maxEntries: 1,
		});
		const pendingInput = {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "evicted-pending-session",
			isSubagent: false,
		};
		const pendingIntent = registry.beginRootIntent(pendingInput);
		const pending = resolveRequest(registry, pendingInput, pendingIntent);

		const pressureInput = {
			callerIdentity: "caller",
			requestModel: "claude-opus-5",
			sessionId: "unrelated-native-session",
			isSubagent: false,
		};
		const pressureIntent = registry.beginRootIntent(pressureInput);
		expect(resolveRequest(registry, pressureInput, pressureIntent)).toEqual({
			kind: "native",
		});
		registry.commitExplicit(pendingInput, pending);

		expect(
			resolveRequest(
				registry,
				{
					...pendingInput,
					requestModel: "claude-sonnet-4-5",
					isSubagent: true,
				},
				null,
			),
		).toEqual({ kind: "native" });
	});

	it("fails a pending commit closed when its intent watermark expires", () => {
		const configured = profile();
		const clock = makeClock();
		const registry = new ModelRouteSessionRegistry([configured], {
			ttlMs: 1_000,
			now: clock.now,
		});
		const input = {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "expired-watermark-session",
			isSubagent: false,
		};
		const intent = registry.beginRootIntent(input);
		const pending = resolveRequest(registry, input, intent);
		clock.advance(1_000);
		registry.commitExplicit(input, pending);

		expect(
			resolveRequest(
				registry,
				{
					...input,
					requestModel: "claude-sonnet-4-5",
					isSubagent: true,
				},
				null,
			),
		).toEqual({ kind: "native" });
	});

	it("does not evict a live binding for an uncommitted explicit selection", () => {
		const configured = profile();
		const alternate = alternateProfile();
		const registry = new ModelRouteSessionRegistry([configured, alternate], {
			maxEntries: 1,
		});
		resolveAndCommit(registry, {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "admitted-session",
			isSubagent: false,
		});

		const failedInput = {
			callerIdentity: "caller",
			requestModel: alternate.publicModelId,
			sessionId: "failed-session",
			isSubagent: false,
		};
		const failedIntent = registry.beginRootIntent(failedInput);
		expect(resolveRequest(registry, failedInput, failedIntent)).toMatchObject({
			kind: "route",
			source: "explicit",
			profile: alternate,
		});

		expect(registry.size).toBe(1);
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: "claude-sonnet-4-5",
				sessionId: "admitted-session",
				isSubagent: true,
			}),
		).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: configured,
		});
	});

	it("does not let children advance, commit, replace, or clear root intent", () => {
		const configured = profile();
		const alternate = alternateProfile();
		const registry = new ModelRouteSessionRegistry([configured, alternate]);
		const rootInput = {
			callerIdentity: "caller",
			sessionId: "session",
			isSubagent: false,
		};
		resolveAndCommit(registry, {
			...rootInput,
			requestModel: configured.publicModelId,
		});
		const pendingRoot = resolveRequest(registry, {
			...rootInput,
			requestModel: alternate.publicModelId,
		});

		const childExplicit = resolveRequest(registry, {
			...rootInput,
			requestModel: alternate.publicModelId,
			isSubagent: true,
		});
		expect(childExplicit).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: configured,
		});
		registry.commitExplicit(
			{
				...rootInput,
				requestModel: alternate.publicModelId,
				isSubagent: true,
			},
			pendingRoot,
		);
		expect(
			resolveRequest(registry, {
				...rootInput,
				requestModel: "claude-opus-5",
				isSubagent: true,
			}),
		).toMatchObject({ profile: configured, source: "inherited" });

		registry.commitExplicit(
			{ ...rootInput, requestModel: alternate.publicModelId },
			pendingRoot,
		);
		expect(
			resolveRequest(registry, {
				...rootInput,
				requestModel: "claude-haiku-4-5",
				isSubagent: true,
			}),
		).toMatchObject({ profile: alternate, source: "inherited" });
	});

	it("expires root intent before a delayed commit", () => {
		const configured = profile();
		const clock = makeClock();
		const registry = new ModelRouteSessionRegistry([configured], {
			ttlMs: 1_000,
			now: clock.now,
		});
		const input = {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "session",
			isSubagent: false,
		};
		const pending = resolveRequest(registry, input);
		clock.advance(1_000);
		registry.commitExplicit(input, pending);

		expect(
			resolveRequest(registry, {
				...input,
				requestModel: "claude-sonnet-4-5",
				isSubagent: true,
			}),
		).toEqual({ kind: "native" });
	});

	it("does not let unrelated native roots evict a live intent watermark", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			maxEntries: 2,
		});
		const pendingInput = {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "older-session",
			isSubagent: false,
		};
		const pending = resolveRequest(registry, pendingInput);
		resolveRequest(registry, {
			callerIdentity: "caller",
			requestModel: "claude-opus-5",
			sessionId: "newer-session",
			isSubagent: false,
		});
		registry.commitExplicit(pendingInput, pending);

		expect(
			resolveRequest(registry, {
				...pendingInput,
				requestModel: "claude-sonnet-4-5",
				isSubagent: true,
			}),
		).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: configured,
		});
	});

	it("does not let unrelated native roots consume capacity or evict a live binding", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured], {
			maxEntries: 1,
		});
		resolveAndCommit(registry, {
			callerIdentity: "pinned-caller",
			requestModel: configured.publicModelId,
			sessionId: "pinned-session",
			isSubagent: false,
		});

		for (const sessionId of ["native-one", "native-two", "native-three"]) {
			expect(
				resolveRequest(registry, {
					callerIdentity: "ordinary-caller",
					requestModel: "claude-opus-5",
					sessionId,
					isSubagent: false,
				}),
			).toEqual({ kind: "native" });
		}

		expect(registry.size).toBe(1);
		expect(
			resolveRequest(registry, {
				callerIdentity: "pinned-caller",
				requestModel: "claude-sonnet-4-5",
				sessionId: "pinned-session",
				isSubagent: true,
			}),
		).toMatchObject({
			kind: "route",
			source: "inherited",
			profile: configured,
		});
	});

	it("orders unseen and expired native roots without creating bindings", () => {
		const configured = profile();
		const clock = makeClock();
		const registry = new ModelRouteSessionRegistry([configured], {
			ttlMs: 1_000,
			now: clock.now,
		});
		const expired = resolveRequest(registry, {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "expired-session",
			isSubagent: false,
		});
		expect(expired).toMatchObject({ generation: 1 });
		clock.advance(1_000);

		for (const sessionId of ["unseen-session", "expired-session"]) {
			expect(
				resolveRequest(registry, {
					callerIdentity: "caller",
					requestModel: "claude-opus-5",
					sessionId,
					isSubagent: false,
				}),
			).toEqual({ kind: "native" });
		}

		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: configured.publicModelId,
				sessionId: "new-session",
				isSubagent: false,
			}),
		).toMatchObject({ generation: 4 });
	});

	it("isolates bindings by authenticated caller identity", () => {
		const configured = profile();
		const registry = new ModelRouteSessionRegistry([configured]);
		resolveAndCommit(registry, {
			callerIdentity: "caller-a",
			requestModel: configured.publicModelId,
			sessionId: "shared-session",
			isSubagent: false,
		});
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller-b",
				requestModel: "claude-sonnet-4-5",
				sessionId: "shared-session",
				isSubagent: true,
			}),
		).toEqual({ kind: "native" });
	});

	it("expires bindings at the TTL boundary", () => {
		const configured = profile();
		const clock = makeClock();
		const registry = new ModelRouteSessionRegistry([configured], {
			ttlMs: 1_000,
			now: clock.now,
		});
		resolveAndCommit(registry, {
			callerIdentity: "caller",
			requestModel: configured.publicModelId,
			sessionId: "session",
			isSubagent: false,
		});
		clock.advance(1_000);
		expect(
			resolveAndCommit(registry, {
				callerIdentity: "caller",
				requestModel: "claude-sonnet-4-5",
				sessionId: "session",
				isSubagent: true,
			}),
		).toEqual({ kind: "native" });
		expect(registry.size).toBe(0);
	});

	it("evicts the oldest binding when the entry cap is reached", () => {
		const configured = profile();
		const clock = makeClock();
		const registry = new ModelRouteSessionRegistry([configured], {
			maxEntries: 2,
			now: clock.now,
		});
		for (const sessionId of ["one", "two", "three"]) {
			resolveAndCommit(registry, {
				callerIdentity: "caller",
				requestModel: configured.publicModelId,
				sessionId,
				isSubagent: false,
			});
			clock.advance(1);
		}
		expect(registry.size).toBe(2);
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: "claude-sonnet-4-5",
				sessionId: "one",
				isSubagent: true,
			}),
		).toEqual({ kind: "native" });
		expect(
			resolveRequest(registry, {
				callerIdentity: "caller",
				requestModel: "claude-sonnet-4-5",
				sessionId: "two",
				isSubagent: true,
			}),
		).toMatchObject({ kind: "route", source: "inherited" });
	});

	it("tracks exclusive accounts as profile-only across versioned exact profiles", () => {
		const [boundedV1, boundedV2, ordinary] = parseModelRouteProfiles(
			JSON.stringify([
				{
					id: "bounded-v1",
					displayName: "Bounded v1",
					accountId: "mac-studio",
					logicalModel: "claude-fable-5",
					exclusiveAccount: true,
				},
				{
					id: "bounded-v2",
					displayName: "Bounded v2",
					accountId: "mac-studio",
					logicalModel: "claude-fable-5",
					exclusiveAccount: true,
				},
				{
					id: "ordinary-route",
					displayName: "Ordinary route",
					accountId: "ordinary-account",
					logicalModel: "claude-fable-5",
				},
			]),
		);
		if (!boundedV1 || !boundedV2 || !ordinary) {
			throw new Error("Expected registry profiles to parse");
		}
		const registry = new ModelRouteSessionRegistry([
			boundedV1,
			boundedV2,
			ordinary,
		]);

		expect(registry.isProfileOnlyAccount("mac-studio")).toBe(true);
		expect(registry.isProfileOnlyAccount("ordinary-account")).toBe(false);
		expect(registry.isProfileOnlyAccount("unknown-account")).toBe(false);
		expect(registry.isExactProfileAccount(boundedV1, "mac-studio")).toBe(true);
		expect(registry.isExactProfileAccount(boundedV2, "mac-studio")).toBe(true);
		expect(registry.isExactProfileAccount(ordinary, "mac-studio")).toBe(false);
	});
});
