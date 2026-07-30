import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import {
	ANTHROPIC_DEGRADED_MODE_DEFAULTS,
	type AnthropicDegradedModeConfig,
	resolveAnthropicDegradedModeConfig,
} from "@better-ccflare/config";
import {
	AnthropicDegradedModeCoordinator,
	type AnthropicDegradedOutcome,
	buildAnthropicDegradedCohortKey,
	classifyAnthropicReplayRisk,
	sanitizeAnthropicRetryAfterSeconds,
} from "../anthropic-degraded-mode";

function createClock(start = 0): {
	now: () => number;
	advance: (milliseconds: number) => void;
	set: (milliseconds: number) => void;
} {
	let current = start;
	return {
		now: () => current,
		advance: (milliseconds) => {
			current += milliseconds;
		},
		set: (milliseconds) => {
			current = milliseconds;
		},
	};
}

function degradedConfig(
	overrides: Partial<AnthropicDegradedModeConfig> = {},
): AnthropicDegradedModeConfig {
	return {
		...ANTHROPIC_DEGRADED_MODE_DEFAULTS,
		mode: "enforce",
		...overrides,
	};
}

function cohortKey(
	overrides: Partial<
		Parameters<typeof buildAnthropicDegradedCohortKey>[0]
	> = {},
) {
	const key = buildAnthropicDegradedCohortKey({
		provider: "anthropic",
		endpoint: "https://api.anthropic.com",
		path: "/v1/messages",
		protocol: "messages",
		model: "claude-opus-4-6",
		betaSignature: "",
		...overrides,
	});
	expect(key).not.toBeNull();
	if (key === null) throw new Error("expected a valid cohort key");
	return key;
}

function largeRisk(config = degradedConfig()) {
	return classifyAnthropicReplayRisk({
		body: Buffer.from("{}"),
		estimateInputTokens: () => config.largeRequestTokenThreshold,
		config,
	});
}

function recordOverload(
	coordinator: AnthropicDegradedModeCoordinator,
	key: ReturnType<typeof cohortKey>,
	accountId: string,
	options: {
		forceRouted?: boolean;
		retryAfter?: unknown;
		outcome?: "http_529" | "semantic_overloaded";
	} = {},
) {
	return coordinator.recordOutcome({
		cohortKey: key,
		accountId,
		outcome: options.outcome ?? "http_529",
		phase: "pre_commit",
		forceRouted: options.forceRouted ?? false,
		retryAfter: options.retryAfter,
	});
}

class IterationCountingMap<K, V> extends Map<K, V> {
	iteratedEntries = 0;

	override *[Symbol.iterator](): MapIterator<[K, V]> {
		for (const entry of super[Symbol.iterator]()) {
			this.iteratedEntries += 1;
			yield entry;
		}
	}
}

describe("classifyAnthropicReplayRisk", () => {
	it("uses exact buffer bytes and inclusive token/byte thresholds", () => {
		const config = degradedConfig();
		const belowBytes = Buffer.alloc(config.largeRequestByteThreshold - 1);
		const atBytes = Buffer.alloc(config.largeRequestByteThreshold);

		expect(
			classifyAnthropicReplayRisk({
				body: belowBytes,
				estimateInputTokens: () => config.largeRequestTokenThreshold - 1,
				config,
			}),
		).toMatchObject({
			kind: "small",
			bodyBytes: config.largeRequestByteThreshold - 1,
			estimatedInputTokens: config.largeRequestTokenThreshold - 1,
			reasons: [],
		});
		expect(
			classifyAnthropicReplayRisk({
				body: Buffer.from("{}"),
				estimateInputTokens: () => config.largeRequestTokenThreshold,
				config,
			}),
		).toMatchObject({
			kind: "large",
			reasons: ["tokens"],
		});
		expect(
			classifyAnthropicReplayRisk({
				body: atBytes,
				estimateInputTokens: () => config.largeRequestTokenThreshold - 1,
				config,
			}),
		).toMatchObject({
			kind: "large",
			bodyBytes: config.largeRequestByteThreshold,
			reasons: ["bytes"],
		});
	});

	it("measures multibyte UTF-8 without using JavaScript string length", () => {
		const config = degradedConfig({
			largeRequestByteThreshold: 4,
			largeRequestTokenThreshold: 100,
		});
		const body = Buffer.from("😀", "utf8");

		expect(body.length).toBe(4);
		expect(
			classifyAnthropicReplayRisk({
				body,
				estimateInputTokens: () => 1,
				config,
			}),
		).toEqual({
			kind: "large",
			bodyBytes: 4,
			estimatedInputTokens: 1,
			reasons: ["bytes"],
		});
	});

	it("is nonthrowing for malformed JSON, estimator failures, and numeric overflow", () => {
		const config = degradedConfig();
		const malformed = Buffer.from('{"messages":[');

		expect(() =>
			classifyAnthropicReplayRisk({
				body: malformed,
				estimateInputTokens: () => {
					JSON.parse(malformed.toString("utf8"));
					return 1;
				},
				config,
			}),
		).not.toThrow();
		expect(
			classifyAnthropicReplayRisk({
				body: malformed,
				estimateInputTokens: () => {
					throw new Error("estimator failed");
				},
				config,
			}),
		).toMatchObject({
			kind: "small",
			estimatedInputTokens: null,
		});
		expect(
			classifyAnthropicReplayRisk({
				body: Buffer.from("{}"),
				estimateInputTokens: () => Number.POSITIVE_INFINITY,
				config,
			}),
		).toMatchObject({
			kind: "large",
			estimatedInputTokens: Number.MAX_SAFE_INTEGER,
			reasons: ["tokens"],
		});
		expect(
			classifyAnthropicReplayRisk({
				body: Buffer.from("{}"),
				estimateInputTokens: () => ({ tokens: Number.MAX_VALUE }),
				config,
			}),
		).toMatchObject({
			kind: "large",
			estimatedInputTokens: Number.MAX_SAFE_INTEGER,
		});
	});
});

describe("buildAnthropicDegradedCohortKey", () => {
	it("normalizes endpoint authority, concrete family, path class, and beta order", () => {
		const first = cohortKey({
			endpoint: "HTTPS://API.ANTHROPIC.COM:443/",
			path: "/v1/messages?ignored=true",
			model: " CLAUDE-OPUS-4-6 ",
			betaSignature: "oauth-2025-04-20, context-1m,oauth-2025-04-20",
		});
		const second = cohortKey({
			endpoint: "https://api.anthropic.com",
			path: "/messages",
			model: "claude-opus-5",
			betaSignature: "CONTEXT-1M,oauth-2025-04-20",
		});

		expect(first).toBe(second);
	});

	it("isolates authority, model family, protocol/path class, and canonical beta signature", () => {
		const keys = [
			cohortKey(),
			cohortKey({ endpoint: "https://regional.anthropic.invalid" }),
			cohortKey({ model: "claude-sonnet-4-6" }),
			cohortKey({
				path: "/v1/responses",
				protocol: "responses",
			}),
			cohortKey({ betaSignature: "context-1m" }),
		];

		expect(new Set(keys).size).toBe(keys.length);
	});

	it("rejects non-Anthropic providers and unknown model, beta, endpoint, path, or protocol facts", () => {
		expect(
			buildAnthropicDegradedCohortKey({
				provider: "openai-compatible",
				endpoint: "https://api.anthropic.com",
				path: "/v1/messages",
				protocol: "messages",
				model: "claude-opus-4-6",
			}),
		).toBeNull();
		expect(
			buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "https://api.anthropic.com",
				path: "/v1/messages",
				protocol: "messages",
				model: "claude-mystery-99",
			}),
		).toBeNull();
		expect(
			buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "https://api.anthropic.com",
				path: "/v1/messages",
				protocol: "messages",
				model: "claude-opus-4-6",
				betaSignature: "attacker-controlled-beta",
			}),
		).toBeNull();
		expect(
			buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "not a url",
				path: "/v1/messages",
				protocol: "messages",
				model: "claude-opus-4-6",
			}),
		).toBeNull();
		expect(
			buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "https://api.anthropic.com",
				path: "/v1/unknown",
				protocol: "messages",
				model: "claude-opus-4-6",
			}),
		).toBeNull();
		expect(
			buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "https://api.anthropic.com",
				path: "/v1/messages",
				protocol: "unknown" as "messages",
				model: "claude-opus-4-6",
			}),
		).toBeNull();
	});
});

describe("AnthropicDegradedModeCoordinator evidence", () => {
	it("opens after two distinct accounts inside the evidence window and elects one probe", () => {
		const clock = createClock();
		const config = degradedConfig();
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const key = cohortKey();

		expect(recordOverload(coordinator, key, "account-a")).toMatchObject({
			kind: "recorded",
			accepted: true,
			cohortKey: key,
			distinctAccounts: 1,
			opened: false,
		});
		expect(recordOverload(coordinator, key, "account-a")).toMatchObject({
			kind: "recorded",
			distinctAccounts: 1,
			opened: false,
		});
		clock.advance(config.evidenceWindowMs - 1);
		expect(recordOverload(coordinator, key, "account-b")).toMatchObject({
			kind: "recorded",
			distinctAccounts: 2,
			opened: true,
			retryAfterSeconds: 10,
		});
		expect(coordinator.getCohortState(key)).toMatchObject({
			state: "open",
			nextProbeAt: clock.now() + config.retryFallbackMs,
		});

		const tooEarly = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
				ownerAccountId: "account-a",
			})
			.reserve("account-a");
		expect(tooEarly).toMatchObject({
			action: "suppress",
			wouldAction: "suppress",
			reason: "probe_not_ready",
		});

		clock.advance(config.retryFallbackMs);
		const winner = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
				ownerAccountId: "account-a",
			})
			.reserve("account-a");
		const follower = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
				ownerAccountId: "account-a",
			})
			.reserve("account-a");

		expect(winner).toMatchObject({
			action: "send",
			wouldAction: "probe",
			reason: "probe_reserved",
		});
		expect(follower).toMatchObject({
			action: "suppress",
			wouldAction: "suppress",
			reason: "probe_in_flight",
		});
	});

	it("expires pre-quorum evidence at the exact window boundary but never expires an open cohort on time alone", () => {
		const clock = createClock();
		const config = degradedConfig();
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const key = cohortKey();

		recordOverload(coordinator, key, "account-a");
		clock.advance(config.evidenceWindowMs);
		expect(recordOverload(coordinator, key, "account-b")).toMatchObject({
			kind: "recorded",
			distinctAccounts: 1,
			opened: false,
		});
		expect(coordinator.getCohortState(key).state).toBe("collecting");
		clock.advance(1);
		recordOverload(coordinator, key, "account-a");
		expect(coordinator.getCohortState(key).state).toBe("open");

		clock.advance(24 * 60 * 60 * 1000);
		expect(coordinator.getCohortState(key).state).toBe("open");
	});

	it("does not let aliases, force routes, post-commit overloads, or non-overload outcomes establish quorum", () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: degradedConfig(),
			now: () => 100,
		});
		const key = cohortKey();
		const excluded: AnthropicDegradedOutcome[] = [
			"authentication",
			"authorization",
			"quota",
			"rate_limited_429",
			"transport",
			"cancelled",
			"success",
		];

		for (const outcome of excluded) {
			expect(
				coordinator.recordOutcome({
					cohortKey: key,
					accountId: `account-${outcome}`,
					outcome,
					phase: "pre_commit",
					forceRouted: false,
				}),
			).toMatchObject({ kind: "ignored", reason: "non_overload" });
		}
		expect(
			coordinator.recordOutcome({
				cohortKey: key,
				accountId: "account-post-commit",
				outcome: "http_529",
				phase: "post_commit",
				forceRouted: false,
			}),
		).toMatchObject({ kind: "ignored", reason: "post_commit" });
		expect(
			recordOverload(coordinator, key, "account-a", { forceRouted: true }),
		).toMatchObject({
			kind: "ignored",
			accepted: false,
			cohortKey: key,
			opened: false,
			reason: "force_routed",
		});
		expect(
			recordOverload(coordinator, key, "account-b", {
				forceRouted: true,
				outcome: "semantic_overloaded",
			}),
		).toMatchObject({ kind: "ignored", reason: "force_routed" });
		expect(coordinator.getCohortState(key).state).toBe("inactive");

		recordOverload(coordinator, key, "underlying-a");
		recordOverload(coordinator, key, "underlying-a");
		expect(coordinator.getCohortState(key)).toMatchObject({
			state: "collecting",
			distinctAccounts: 1,
		});
	});

	it("keeps cohorts isolated and makes a force-routed request obey an already-open matching cohort", () => {
		const clock = createClock();
		const config = degradedConfig();
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const opus = cohortKey();
		const sonnet = cohortKey({ model: "claude-sonnet-4-6" });

		recordOverload(coordinator, opus, "account-a");
		recordOverload(coordinator, sonnet, "account-b");
		expect(coordinator.getCohortState(opus).state).toBe("collecting");
		expect(coordinator.getCohortState(sonnet).state).toBe("collecting");
		recordOverload(coordinator, opus, "account-c");
		expect(coordinator.getCohortState(opus).state).toBe("open");
		expect(coordinator.getCohortState(sonnet).state).toBe("collecting");

		const forced = coordinator
			.createRequestAdmission({
				cohortKey: opus,
				risk: largeRisk(config),
				forceRouted: true,
			})
			.reserve("forced-account");
		expect(forced).toMatchObject({
			action: "suppress",
			reservation: "denied",
			reason: "probe_not_ready",
		});
	});

	it("derives an opaque route handle and reads protection without reserving or mutating state", () => {
		const clock = createClock();
		const config = degradedConfig();
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const facts = {
			provider: "anthropic",
			endpoint: "https://api.anthropic.com",
			path: "/v1/messages",
			protocol: "messages" as const,
			model: "claude-opus-4-6",
			betaSignature: "",
		};
		const key = cohortKey(facts);
		recordOverload(coordinator, key, "account-a");
		recordOverload(coordinator, key, "account-b");
		clock.advance(config.retryFallbackMs);

		const first = coordinator.inspectRoute(facts);
		const second = coordinator.inspectRoute(facts);
		expect(first).toMatchObject({
			cohortKey: key,
			state: "open",
			detail: { state: "open" },
		});
		expect(second).toEqual(first);
		expect(coordinator.snapshot()).toMatchObject({
			openCohorts: 1,
			probingCohorts: 0,
			activeProbes: 0,
		});
	});
});

describe("retry timing", () => {
	it("uses the fallback for absent or malformed values and clamps negative or huge guidance", () => {
		const config = degradedConfig();
		const now = Date.UTC(2026, 6, 29, 12, 0, 0);

		expect(sanitizeAnthropicRetryAfterSeconds(undefined, now, config)).toBe(10);
		expect(sanitizeAnthropicRetryAfterSeconds("garbage", now, config)).toBe(10);
		expect(sanitizeAnthropicRetryAfterSeconds(-50, now, config)).toBe(5);
		expect(sanitizeAnthropicRetryAfterSeconds("0", now, config)).toBe(5);
		expect(sanitizeAnthropicRetryAfterSeconds("7.1", now, config)).toBe(8);
		expect(sanitizeAnthropicRetryAfterSeconds("9999999999", now, config)).toBe(
			60,
		);
		expect(
			sanitizeAnthropicRetryAfterSeconds(
				new Date(now + 12_500).toUTCString(),
				now,
				config,
			),
		).toBe(12);
	});
});

describe("fenced permits and recovery", () => {
	function openCoordinator() {
		const clock = createClock();
		const config = degradedConfig();
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const key = cohortKey();
		recordOverload(coordinator, key, "account-a");
		recordOverload(coordinator, key, "account-b");
		clock.advance(config.retryFallbackMs);
		return { clock, config, coordinator, key };
	}

	it("commits once, fences duplicate completion, and enters then leaves recovery hold-down only on success", () => {
		const { clock, config, coordinator, key } = openCoordinator();
		const decision = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
				ownerAccountId: "account-a",
			})
			.reserve("account-a");
		expect(decision.action).toBe("send");
		if (decision.action !== "send") throw new Error("expected permit");

		expect(decision.permit.commit()).toBe(true);
		expect(decision.permit.commit()).toBe(false);
		expect(decision.permit.complete("success")).toBe(true);
		expect(decision.permit.complete("overloaded")).toBe(false);
		expect(coordinator.getCohortState(key)).toMatchObject({
			state: "recovering",
			recoveringUntil: clock.now() + config.recoveryWindowMs,
		});

		clock.advance(config.recoveryWindowMs - 1);
		expect(coordinator.getCohortState(key).state).toBe("recovering");
		clock.advance(1);
		expect(coordinator.getCohortState(key).state).toBe("inactive");
	});

	it("cancels an abandoned reservation once and applies bounded next-probe delay", () => {
		const { clock, config, coordinator, key } = openCoordinator();
		const decision = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-a");
		if (decision.action !== "send") throw new Error("expected permit");

		expect(decision.permit.cancel("1")).toBe(true);
		expect(decision.permit.cancel("1")).toBe(false);
		expect(decision.permit.commit()).toBe(false);
		expect(coordinator.getCohortState(key)).toMatchObject({
			state: "open",
			nextProbeAt: clock.now() + config.retryMinMs,
		});
	});

	it("keeps an elapsed committed probe fenced until its watchdog owner explicitly expires it", () => {
		const { clock, config, coordinator, key } = openCoordinator();
		const first = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-a");
		if (first.action !== "send") throw new Error("expected first permit");
		expect(first.permit.commit()).toBe(true);

		clock.advance(config.probeLeaseMs + config.retryMinMs);
		const follower = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-b");
		expect(follower).toMatchObject({
			action: "suppress",
			reason: "probe_in_flight",
		});
		expect(coordinator.getCohortState(key)).toMatchObject({
			state: "probing",
			leaseCommitted: true,
		});

		expect(first.permit.expire()).toBe(true);
		expect(coordinator.getCohortState(key).state).toBe("open");
		clock.advance(config.retryMinMs);
		const successor = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-b");
		expect(successor.action).toBe("send");
	});

	it("fences a timed-out probe so its late success cannot mutate a successor", () => {
		const { clock, config, coordinator, key } = openCoordinator();
		const first = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-a");
		if (first.action !== "send") throw new Error("expected first permit");
		expect(first.permit.commit()).toBe(true);

		clock.advance(config.probeLeaseMs - 1);
		expect(first.permit.expire()).toBe(false);
		expect(coordinator.getCohortState(key).state).toBe("probing");
		clock.advance(1);
		expect(first.permit.expire()).toBe(true);
		expect(coordinator.getCohortState(key).state).toBe("open");
		clock.advance(config.retryMinMs);

		const second = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-b");
		expect(second.action).toBe("send");
		expect(first.permit.complete("success")).toBe(false);
		expect(coordinator.getCohortState(key).state).toBe("probing");
	});

	it("fences every stale recovery permit across cohort deletion and recreation", () => {
		const { clock, config, coordinator, key } = openCoordinator();
		const firstProbe = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-a");
		if (firstProbe.action !== "send") throw new Error("expected first probe");
		expect(firstProbe.permit.commit()).toBe(true);
		expect(firstProbe.permit.complete("success")).toBe(true);

		const staleCommit = coordinator
			.createRequestAdmission({ cohortKey: key, risk: largeRisk(config) })
			.reserve("account-a");
		const staleCancel = coordinator
			.createRequestAdmission({ cohortKey: key, risk: largeRisk(config) })
			.reserve("account-a");
		const staleExpire = coordinator
			.createRequestAdmission({ cohortKey: key, risk: largeRisk(config) })
			.reserve("account-a");
		const staleComplete = coordinator
			.createRequestAdmission({ cohortKey: key, risk: largeRisk(config) })
			.reserve("account-a");
		if (
			staleCommit.action !== "send" ||
			staleCancel.action !== "send" ||
			staleExpire.action !== "send" ||
			staleComplete.action !== "send"
		) {
			throw new Error("expected recovery permits");
		}
		expect(staleComplete.permit.commit()).toBe(true);

		clock.advance(config.recoveryWindowMs);
		expect(coordinator.getCohortState(key).state).toBe("inactive");
		recordOverload(coordinator, key, "account-a");
		recordOverload(coordinator, key, "account-b");
		clock.advance(config.retryFallbackMs);
		const secondProbe = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
			})
			.reserve("account-b");
		if (secondProbe.action !== "send") throw new Error("expected second probe");
		expect(secondProbe.permit.commit()).toBe(true);
		expect(secondProbe.permit.complete("success")).toBe(true);
		expect(coordinator.getCohortState(key).state).toBe("recovering");

		expect(staleCommit.permit.commit()).toBe(false);
		expect(staleCancel.permit.cancel()).toBe(false);
		expect(staleExpire.permit.expire()).toBe(false);
		expect(staleComplete.permit.complete("overloaded")).toBe(false);
		expect(coordinator.getCohortState(key).state).toBe("recovering");
	});

	it("allows only the owner to probe and limits each recovering request to one send", () => {
		const { clock, config, coordinator, key } = openCoordinator();
		const wrongOwner = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
				ownerAccountId: "account-a",
			})
			.reserve("account-b");
		expect(wrongOwner).toMatchObject({
			action: "suppress",
			reason: "owner_mismatch",
			requiredAccountId: "account-a",
		});

		const probe = coordinator
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(config),
				ownerAccountId: "account-a",
			})
			.reserve("account-a");
		if (probe.action !== "send") throw new Error("expected owner probe");
		expect(probe.permit.commit()).toBe(true);
		expect(probe.permit.complete("success")).toBe(true);

		const recoveringRequest = coordinator.createRequestAdmission({
			cohortKey: key,
			risk: largeRisk(config),
		});
		const firstSend = recoveringRequest.reserve("account-a");
		const secondSend = recoveringRequest.reserve("account-b");
		expect(firstSend).toMatchObject({
			action: "send",
			wouldAction: "recovery_send",
		});
		expect(secondSend).toMatchObject({
			action: "suppress",
			reason: "request_budget_spent",
		});
		if (firstSend.action !== "send")
			throw new Error("expected recovery permit");
		expect(firstSend.permit.commit()).toBe(true);
		expect(firstSend.permit.complete("overloaded", "20")).toBe(true);
		expect(coordinator.getCohortState(key)).toMatchObject({
			state: "open",
			nextProbeAt: clock.now() + 20_000,
		});
	});
});

describe("bounded state", () => {
	it("keeps repeated targeted admissions independent of retained cohort cardinality", () => {
		const config = degradedConfig({ maxCohorts: 1_000 });
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: () => 0,
		});
		const retainedCohorts = 512;
		const keys = Array.from({ length: retainedCohorts }, (_, index) =>
			cohortKey({
				endpoint: `https://cohort-${index}.example.com`,
			}),
		);

		for (const key of keys) {
			recordOverload(coordinator, key, "account-a");
		}
		recordOverload(coordinator, keys[0], "account-b");

		const internals = coordinator as unknown as {
			cohorts: Map<ReturnType<typeof cohortKey>, unknown>;
		};
		const tracked = new IterationCountingMap(internals.cohorts);
		internals.cohorts = tracked;

		const repeatedAdmissions = 32;
		for (let index = 0; index < repeatedAdmissions; index += 1) {
			expect(
				coordinator
					.createRequestAdmission({
						cohortKey: keys[0],
						risk: largeRisk(config),
					})
					.reserve("account-a"),
			).toMatchObject({
				action: "suppress",
				reason: "probe_not_ready",
			});
		}

		expect(tracked.iteratedEntries).toBeLessThanOrEqual(repeatedAdmissions);
	});

	it("ranks collecting eviction by oldest live evidence after refresh", () => {
		const clock = createClock();
		const config = degradedConfig({ maxCohorts: 2 });
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const refreshed = cohortKey({ model: "claude-opus-4-6" });
		const oldestLive = cohortKey({ model: "claude-sonnet-4-6" });
		const newcomer = cohortKey({ model: "claude-haiku-4-5-20251001" });

		recordOverload(coordinator, refreshed, "account-a");
		clock.advance(1);
		recordOverload(coordinator, oldestLive, "account-b");
		clock.advance(1);
		recordOverload(coordinator, refreshed, "account-a");
		clock.advance(1);
		recordOverload(coordinator, newcomer, "account-c");

		expect(coordinator.getCohortState(refreshed).state).toBe("collecting");
		expect(coordinator.getCohortState(oldestLive).state).toBe("inactive");
		expect(coordinator.getCohortState(newcomer).state).toBe("collecting");
	});

	it("evicts same-account single-evidence churn before unrelated pending evidence", () => {
		const clock = createClock();
		const config = degradedConfig({ maxCohorts: 2 });
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const legitimatePending = cohortKey({ model: "claude-opus-4-6" });
		const churnOne = cohortKey({ model: "claude-sonnet-4-6" });
		const churnTwo = cohortKey({ model: "claude-haiku-4-5-20251001" });

		recordOverload(coordinator, legitimatePending, "account-b");
		clock.advance(1);
		recordOverload(coordinator, churnOne, "account-a");
		clock.advance(1);
		recordOverload(coordinator, churnTwo, "account-a");

		expect(coordinator.getCohortState(legitimatePending).state).toBe(
			"collecting",
		);
		expect(coordinator.getCohortState(churnOne).state).toBe("inactive");
		expect(coordinator.getCohortState(churnTwo).state).toBe("collecting");
	});

	it("evicts the oldest live pre-quorum entry before another collecting cohort", () => {
		const clock = createClock();
		const config = degradedConfig({ maxCohorts: 2 });
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const first = cohortKey({ model: "claude-opus-4-6" });
		const second = cohortKey({ model: "claude-sonnet-4-6" });
		const third = cohortKey({ model: "claude-haiku-4-5-20251001" });

		recordOverload(coordinator, first, "account-a");
		clock.advance(1);
		recordOverload(coordinator, second, "account-a");
		clock.advance(1);
		recordOverload(coordinator, third, "account-a");

		expect(coordinator.getCohortState(first).state).toBe("inactive");
		expect(coordinator.getCohortState(second).state).toBe("collecting");
		expect(coordinator.getCohortState(third).state).toBe("collecting");
		recordOverload(coordinator, second, "account-b");
		expect(coordinator.getCohortState(second).state).toBe("open");
	});

	it("never evicts protected entries and saturating-counts dropped evidence when they fill the cap", () => {
		const clock = createClock();
		const config = degradedConfig({ maxCohorts: 2 });
		const coordinator = new AnthropicDegradedModeCoordinator({
			config,
			now: clock.now,
		});
		const first = cohortKey({ model: "claude-opus-4-6" });
		const second = cohortKey({ model: "claude-sonnet-4-6" });
		const third = cohortKey({ model: "claude-haiku-4-5-20251001" });

		recordOverload(coordinator, first, "account-a");
		recordOverload(coordinator, first, "account-b");
		recordOverload(coordinator, second, "account-a");
		recordOverload(coordinator, second, "account-b");
		expect(recordOverload(coordinator, third, "account-a")).toMatchObject({
			kind: "dropped",
			reason: "protected_capacity",
		});
		expect(coordinator.snapshot()).toMatchObject({
			retainedCohorts: 2,
			openCohorts: 2,
			droppedEvidence: 1,
		});
		expect(coordinator.getCohortState(first).state).toBe("open");
		expect(coordinator.getCohortState(second).state).toBe("open");
	});

	it("does not retain high-cardinality unknown model or beta values", () => {
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: degradedConfig({ maxCohorts: 2 }),
			now: () => 0,
		});

		for (let index = 0; index < 2_000; index += 1) {
			const key = buildAnthropicDegradedCohortKey({
				provider: "anthropic",
				endpoint: "https://api.anthropic.com",
				path: "/v1/messages",
				protocol: "messages",
				model: `caller-model-${index}`,
				betaSignature: `caller-beta-${index}`,
			});
			expect(key).toBeNull();
		}
		expect(coordinator.snapshot()).toMatchObject({
			retainedCohorts: 0,
			droppedEvidence: 0,
		});
	});
});

describe("restart-scoped modes and configuration", () => {
	it("reports only fixed aggregate cohort age bands from the injected clock", () => {
		const clock = createClock();
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: degradedConfig(),
			now: clock.now,
		});
		const old = cohortKey({ model: "claude-opus-4-6" });
		const middle = cohortKey({ model: "claude-sonnet-4-6" });
		const recent = cohortKey({ model: "claude-haiku-4-5-20251001" });
		const open = (key: ReturnType<typeof cohortKey>) => {
			recordOverload(coordinator, key, "account-a");
			recordOverload(coordinator, key, "account-b");
		};

		open(old);
		clock.set(100_000);
		open(middle);
		clock.set(290_001);
		open(recent);
		clock.set(310_000);

		expect(coordinator.snapshot()).toMatchObject({
			retainedCohorts: 3,
			cohortAgeBands: {
				under30Seconds: 1,
				from30SecondsTo5Minutes: 1,
				atLeast5Minutes: 1,
			},
		});
		expect(Object.keys(coordinator.snapshot().cohortAgeBands)).toEqual([
			"under30Seconds",
			"from30SecondsTo5Minutes",
			"atLeast5Minutes",
		]);
	});

	it("clones and freezes effective config so external mutation cannot change semantics", () => {
		const supplied = degradedConfig({ mode: "enforce", quorum: 2 });
		const coordinator = new AnthropicDegradedModeCoordinator({
			config: supplied,
			now: () => 0,
		});
		const key = cohortKey();

		supplied.mode = "off";
		supplied.quorum = 8;
		expect(coordinator.config).toMatchObject({
			mode: "enforce",
			quorum: 2,
		});
		expect(Object.isFrozen(coordinator.config)).toBe(true);
		expect(Reflect.set(coordinator.config, "mode", "off")).toBe(false);

		recordOverload(coordinator, key, "account-a");
		recordOverload(coordinator, key, "account-b");
		expect(coordinator.getCohortState(key).state).toBe("open");
	});

	it("resolves invalid mode or out-of-range values to safe off", () => {
		expect(resolveAnthropicDegradedModeConfig({})).toEqual(
			ANTHROPIC_DEGRADED_MODE_DEFAULTS,
		);
		expect(
			resolveAnthropicDegradedModeConfig({
				mode: "surprise",
			}),
		).toMatchObject({ mode: "off" });
		expect(
			resolveAnthropicDegradedModeConfig({
				mode: "enforce",
				largeRequestTokenThreshold: -1,
			}),
		).toMatchObject({ mode: "off" });
		expect(
			resolveAnthropicDegradedModeConfig({
				mode: "observe",
				largeRequestTokenThreshold: 100_000,
				largeRequestByteThreshold: 262_144,
			}),
		).toMatchObject({
			mode: "observe",
			largeRequestTokenThreshold: 100_000,
			largeRequestByteThreshold: 262_144,
		});
	});

	it("keeps off inert, observe non-enforcing, and a fresh enforce instance free of shadow evidence", () => {
		const clock = createClock();
		const key = cohortKey();
		const off = new AnthropicDegradedModeCoordinator({
			config: degradedConfig({ mode: "off" }),
			now: clock.now,
		});
		recordOverload(off, key, "account-a");
		recordOverload(off, key, "account-b");
		expect(off.snapshot()).toMatchObject({
			mode: "off",
			retainedCohorts: 0,
		});

		const observeConfig = degradedConfig({ mode: "observe" });
		const observe = new AnthropicDegradedModeCoordinator({
			config: observeConfig,
			now: clock.now,
		});
		recordOverload(observe, key, "account-a");
		recordOverload(observe, key, "account-b");
		clock.advance(observeConfig.retryFallbackMs);
		const observedProbe = observe
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(observeConfig),
			})
			.reserve("account-a");
		const observedFollower = observe
			.createRequestAdmission({
				cohortKey: key,
				risk: largeRisk(observeConfig),
			})
			.reserve("account-b");
		expect(observedProbe).toMatchObject({
			action: "allow",
			wouldAction: "probe",
			enforced: false,
		});
		expect(observedFollower).toMatchObject({
			action: "allow",
			wouldAction: "suppress",
			enforced: false,
		});

		const enforce = new AnthropicDegradedModeCoordinator({
			config: degradedConfig({ mode: "enforce" }),
			now: clock.now,
		});
		expect(enforce.snapshot()).toMatchObject({
			mode: "enforce",
			retainedCohorts: 0,
			openCohorts: 0,
		});
		expect(enforce.getCohortState(key).state).toBe("inactive");
	});
});
