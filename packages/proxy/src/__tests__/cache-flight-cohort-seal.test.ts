import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { Account } from "@better-ccflare/types";
import {
	COHORT_SEAL_PROFILE_CONFIG_KEYS,
	CohortSealService,
} from "../cache-flight-cohort-seal";
import {
	resolveEffectiveXaiKeepalivePolicy,
	resolveKeepaliveTtlMinutes as resolveKeepaliveTtlMinutesFromPolicy,
} from "../cache-keepalive-policy";
import { createOpaqueRuntimeIdFactory } from "../opaque-runtime-id";

type ConfigChangeListener = (event: { key: string; newValue: unknown }) => void;

const enabledEnv = Object.freeze({
	CCFLARE_XAI_CACHE_NATIVE: "1",
	CCFLARE_CACHE_FLIGHT_RECORDER: "1",
});

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "raw-account-id",
		name: "xai account",
		provider: "xai",
		custom_endpoint: null,
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 0,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 50,
		auto_fallback_enabled: true,
		auto_refresh_enabled: true,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

function makeConfig(
	initialGlobalTtl = 20,
	initialXaiTtl = 0,
): {
	config: Config;
	setGlobalTtl: (value: number) => void;
	setXaiTtl: (value: number) => void;
	setGlobalTtlSilently: (value: number) => void;
	emitShadowedGlobalTtl: (value: number) => void;
	listenerCount: () => number;
} {
	let globalTtl = initialGlobalTtl;
	let xaiTtl = initialXaiTtl;
	const listeners = new Set<ConfigChangeListener>();
	const emit = (key: string, newValue: number) => {
		for (const listener of listeners) listener({ key, newValue });
	};
	const config = {
		getCacheKeepaliveTtlMinutes: () => globalTtl,
		getXaiCacheKeepaliveTtlMinutes: () => xaiTtl,
		on: (event: string, listener: ConfigChangeListener) => {
			if (event === "change") listeners.add(listener);
		},
		off: (event: string, listener: ConfigChangeListener) => {
			if (event === "change") listeners.delete(listener);
		},
	} as unknown as Config;

	return {
		config,
		setGlobalTtl: (value) => {
			globalTtl = value;
			emit("cache_keepalive_ttl_minutes", value);
		},
		setXaiTtl: (value) => {
			xaiTtl = value;
			emit("xai_cache_keepalive_ttl_minutes", value);
		},
		setGlobalTtlSilently: (value) => {
			globalTtl = value;
		},
		emitShadowedGlobalTtl: (value) => {
			emit("cache_keepalive_ttl_minutes", value);
		},
		listenerCount: () => listeners.size,
	};
}

function makeService(
	config: Config,
	options: {
		secretFill?: number;
		bootNonceFill?: number;
		gitSha?: string | null;
		env?: Record<string, string | undefined>;
	} = {},
): CohortSealService {
	return new CohortSealService({
		config,
		env: options.env ?? { ...enabledEnv },
		idFactory: createOpaqueRuntimeIdFactory({
			secret: new Uint8Array(32).fill(options.secretFill ?? 3),
			bootNonce: new Uint8Array(32).fill(options.bootNonceFill ?? 5),
		}),
		processStartedAt: "2026-08-08T10:00:00.000Z",
		readBuildProvenance: () => ({
			version: "2.1.226",
			git_sha: options.gitSha === undefined ? "deploy-sha-a" : options.gitSha,
			git_ref: "refs/heads/main",
			build_date: "2026-08-08T09:59:00.000Z",
		}),
	});
}

function capture(service: CohortSealService, overrides = {}) {
	return service.captureReceipt({
		finalServingAccount: makeAccount(),
		attemptedTransportModel: "grok-4.5-route-model",
		routeCandidateId: "candidate:primary-xai",
		...overrides,
	});
}

describe("CohortSealService", () => {
	it("reuses occurrence and partition for a stable profile and stable account/model facts", () => {
		const { config } = makeConfig(20, 0);
		const service = makeService(config);

		const first = capture(service);
		const second = capture(service);

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(second?.serviceEpoch.id).toBe(first?.serviceEpoch.id);
		expect(second?.serviceEpoch.occurrenceId).toBe(
			first?.serviceEpoch.occurrenceId,
		);
		expect(second?.observationPartition.id).toBe(
			first?.observationPartition.id,
		);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first?.serviceEpoch)).toBe(true);
		expect(Object.isFrozen(first?.observationPartition)).toBe(true);
	});

	it("uses restart-scoped process identity so identical settings produce different epochs", () => {
		const first = makeService(makeConfig(20, 0).config, {
			secretFill: 3,
			bootNonceFill: 5,
		});
		const second = makeService(makeConfig(20, 0).config, {
			secretFill: 4,
			bootNonceFill: 6,
		});

		const firstReceipt = capture(first);
		const secondReceipt = capture(second);

		expect(firstReceipt?.serviceEpoch.id).not.toBe(
			secondReceipt?.serviceEpoch.id,
		);
		expect(firstReceipt?.serviceEpoch.occurrenceId).not.toBe(
			secondReceipt?.serviceEpoch.occurrenceId,
		);
		expect(firstReceipt?.observationPartition.id).not.toBe(
			secondReceipt?.observationPartition.id,
		);
	});

	it("rotates the occurrence for every effective allowlisted profile change", () => {
		for (const key of COHORT_SEAL_PROFILE_CONFIG_KEYS) {
			const harness = makeConfig(20, 0);
			const service = makeService(harness.config);
			const first = capture(service);

			if (key === "cache_keepalive_ttl_minutes") harness.setGlobalTtl(30);
			else if (key === "xai_cache_keepalive_ttl_minutes") harness.setXaiTtl(5);
			else throw new Error(`unhandled profile key ${key}`);

			const second = capture(service);
			expect(second?.serviceEpoch.occurrenceId).not.toBe(
				first?.serviceEpoch.occurrenceId,
			);
		}
	});

	it("keeps A to B to A as a new occurrence even without an observation during B", () => {
		const harness = makeConfig(20, 0);
		const service = makeService(harness.config);
		const firstA = capture(service);

		harness.setXaiTtl(5);
		harness.setXaiTtl(0);
		const secondA = capture(service);

		expect(secondA?.serviceEpoch.occurrenceId).not.toBe(
			firstA?.serviceEpoch.occurrenceId,
		);
		expect(secondA?.serviceEpoch.keepalivePolicy).toEqual(
			firstA?.serviceEpoch.keepalivePolicy,
		);
	});

	it("does not rotate for no-op or env-shadowed Config writes", () => {
		const harness = makeConfig(20, 0);
		const service = makeService(harness.config);
		const first = capture(service);

		harness.setGlobalTtl(20);
		expect(capture(service)?.serviceEpoch.occurrenceId).toBe(
			first?.serviceEpoch.occurrenceId,
		);

		harness.emitShadowedGlobalTtl(7);
		expect(capture(service)?.serviceEpoch.occurrenceId).toBe(
			first?.serviceEpoch.occurrenceId,
		);
	});

	it("rotates on the next capture when a profile change event was missed", () => {
		const harness = makeConfig(20, 0);
		const service = makeService(harness.config);
		const first = capture(service);

		harness.setGlobalTtlSilently(30);
		const second = capture(service);

		expect(second?.serviceEpoch.occurrenceId).not.toBe(
			first?.serviceEpoch.occurrenceId,
		);
		expect(second?.serviceEpoch.keepalivePolicy?.globalTtlMinutes).toBe(30);
	});

	it("creates concurrent account/model partitions without rotating the epoch", () => {
		const service = makeService(makeConfig(20, 0).config);
		const first = capture(service, {
			finalServingAccount: makeAccount({ id: "account-a" }),
			attemptedTransportModel: "grok-4.5-a",
			routeCandidateId: "candidate-a",
		});
		const second = capture(service, {
			finalServingAccount: makeAccount({ id: "account-b" }),
			attemptedTransportModel: "grok-4.5-a",
			routeCandidateId: "candidate-a",
		});
		const third = capture(service, {
			finalServingAccount: makeAccount({ id: "account-a" }),
			attemptedTransportModel: "grok-4.5-b",
			routeCandidateId: "candidate-b",
		});
		const fourth = capture(service, {
			finalServingAccount: makeAccount({ id: "account-a" }),
			attemptedTransportModel: "grok-4.5-a",
			routeCandidateId: "candidate-a",
		});

		expect(
			new Set([
				first?.serviceEpoch.occurrenceId,
				second?.serviceEpoch.occurrenceId,
				third?.serviceEpoch.occurrenceId,
				fourth?.serviceEpoch.occurrenceId,
			]).size,
		).toBe(1);
		expect(second?.observationPartition.id).not.toBe(
			first?.observationPartition.id,
		);
		expect(third?.observationPartition.id).not.toBe(
			first?.observationPartition.id,
		);
		expect(fourth?.observationPartition.id).toBe(
			first?.observationPartition.id,
		);
	});

	it("captures the same xAI override/global fallback policy that the scheduler uses", () => {
		for (const [globalTtl, xaiTtl] of [
			[0, 0],
			[0, 2],
			[5, 0],
			[5, 2],
		] as const) {
			const service = makeService(makeConfig(globalTtl, xaiTtl).config);
			const receipt = capture(service);
			const expectedTtl = resolveKeepaliveTtlMinutesFromPolicy(
				"xai",
				globalTtl,
				xaiTtl,
			);
			expect(receipt?.serviceEpoch.keepalivePolicy).toEqual(
				resolveEffectiveXaiKeepalivePolicy(globalTtl, xaiTtl),
			);
			expect(receipt?.serviceEpoch.keepalivePolicy?.effectiveXaiEnabled).toBe(
				expectedTtl > 0,
			);
			expect(
				receipt?.serviceEpoch.keepalivePolicy?.effectiveXaiTtlMinutes,
			).toBe(expectedTtl > 0 ? expectedTtl : null);
		}
	});

	it("keeps missing build revision and final route/model facts unknown and incomplete", () => {
		const service = makeService(makeConfig(20, 0).config, { gitSha: null });
		const receipt = capture(service, {
			attemptedTransportModel: null,
			routeCandidateId: null,
		});

		expect(receipt).not.toBeNull();
		expect(receipt?.serviceEpoch.deploymentRevision).toBeNull();
		expect(receipt?.serviceEpoch.completeness).toBe("incomplete");
		expect(receipt?.serviceEpoch.unavailableDimensions).toContain(
			"deployment_revision",
		);
		expect(receipt?.observationPartition.routeModelEpoch).toBeNull();
		expect(receipt?.observationPartition.completeness).toBe("incomplete");
		expect(receipt?.observationPartition.unavailableDimensions).toContain(
			"route_model_epoch",
		);
		expect(receipt?.completeness).toBe("incomplete");
		expect(receipt?.unavailableDimensions).toEqual([
			"deployment_revision",
			"route_model_epoch",
		]);
	});

	it("does not include raw account, route, model, host, credential, cache key, or request content", () => {
		const service = makeService(makeConfig(20, 0).config);
		const receipt = capture(service, {
			finalServingAccount: makeAccount({
				id: "RAW_ACCOUNT_SENTINEL",
				custom_endpoint: "https://api.x.ai/v1?credential=RAW_CREDENTIAL",
			}),
			attemptedTransportModel: "RAW_MODEL_SENTINEL",
			routeCandidateId: "RAW_CANDIDATE_SENTINEL",
		});

		const serialized = JSON.stringify(receipt);
		for (const forbidden of [
			"RAW_ACCOUNT_SENTINEL",
			"RAW_CANDIDATE_SENTINEL",
			"RAW_MODEL_SENTINEL",
			"api.x.ai",
			"RAW_CREDENTIAL",
			"RAW_CACHE_KEY_SENTINEL",
			"RAW_REQUEST_CONTENT_SENTINEL",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
		expect(serialized).toContain("or1_cohort_");
	});

	it("returns no receipt when recorder/native cache are disabled or the route is not official xAI", () => {
		expect(
			capture(
				makeService(makeConfig(20, 0).config, {
					env: { CCFLARE_XAI_CACHE_NATIVE: "1" },
				}),
			),
		).toBeNull();
		expect(
			capture(
				makeService(makeConfig(20, 0).config, {
					env: { CCFLARE_CACHE_FLIGHT_RECORDER: "1" },
				}),
			),
		).toBeNull();
		expect(
			capture(makeService(makeConfig(20, 0).config), {
				finalServingAccount: makeAccount({
					custom_endpoint: "https://proxy.example.com/v1",
				}),
			}),
		).toBeNull();
		expect(
			capture(makeService(makeConfig(20, 0).config), {
				finalServingAccount: makeAccount({ provider: "anthropic" }),
			}),
		).toBeNull();
		expect(
			capture(makeService(makeConfig(20, 0).config), {
				finalServingAccount: null,
			}),
		).toBeNull();
	});

	it("attaches one config listener and removes it on dispose for shutdown ownership", () => {
		const harness = makeConfig(20, 0);

		const service = makeService(harness.config);
		expect(harness.listenerCount()).toBe(1);
		capture(service);
		expect(harness.listenerCount()).toBe(1);

		service.dispose();
		expect(harness.listenerCount()).toBe(0);
		service.dispose();
		expect(harness.listenerCount()).toBe(0);
	});
});
