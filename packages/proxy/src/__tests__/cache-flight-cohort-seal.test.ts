import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	type CacheFlightCohortSealReceipt,
	type CacheFlightKeepalivePolicySnapshot,
	PARTITION_DIMENSION_ORDER as CORE_PARTITION_DIMENSION_ORDER,
	SERVICE_DIMENSION_ORDER as CORE_SERVICE_DIMENSION_ORDER,
	type TurnEvidence,
} from "@better-ccflare/core";
import {
	BunSqlAdapter,
	CacheFlightRecorderRepository,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { Account } from "@better-ccflare/types";
import {
	COHORT_SEAL_CONTRACT_VERSION,
	COHORT_SEAL_PROFILE_CONFIG_KEYS,
	CohortSealService,
} from "../cache-flight-cohort-seal";
import {
	resolveEffectiveXaiKeepalivePolicy,
	resolveKeepaliveTtlMinutes as resolveKeepaliveTtlMinutesFromPolicy,
} from "../cache-keepalive-policy";
import {
	createOpaqueRuntimeIdFactory,
	type OpaqueRuntimeIdFactory,
} from "../opaque-runtime-id";

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
		idFactory?: OpaqueRuntimeIdFactory;
	} = {},
): CohortSealService {
	return new CohortSealService({
		config,
		env: options.env ?? { ...enabledEnv },
		idFactory:
			options.idFactory ??
			createOpaqueRuntimeIdFactory({
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

/**
 * An idFactory whose bootId is the empty string, so
 * `unavailableServiceDimensions()`'s `service_instance` check (which treats a
 * blank string as unknown, same as `knownString`) can be forced from the
 * public `captureReceipt()` API without any production change.
 */
function makeEmptyBootIdFactory(): OpaqueRuntimeIdFactory {
	const base = createOpaqueRuntimeIdFactory({
		secret: new Uint8Array(32).fill(9),
		bootNonce: new Uint8Array(32).fill(11),
	});
	return {
		bootId: "" as OpaqueRuntimeIdFactory["bootId"],
		id: base.id.bind(base),
	};
}

/** Fresh in-memory recorder repository, same wiring as the database package's
 * own test suite (`packages/database/src/repositories/__tests__/cache-flight-recorder.repository.test.ts`). */
function freshRepo(): CacheFlightRecorderRepository {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON");
	ensureSchema(db);
	runMigrations(db);
	return new CacheFlightRecorderRepository(new BunSqlAdapter(db));
}

function baseTurn(overrides: Partial<TurnEvidence> = {}): TurnEvidence {
	return {
		sequence: 1,
		timestamp: "2026-08-08T10:00:01.000Z",
		identityFingerprint: "identity-fingerprint",
		servingAccountId: "account-safe-id",
		prefixFingerprint: "prefix-fingerprint",
		cacheOutcome: "hit",
		inputTokens: 100,
		cachedTokens: 80,
		completeness: "complete",
		unavailableDimensions: [],
		...overrides,
	};
}

/** A fully-populated, complete receipt built by hand (not via CohortSealService)
 * so the keepalive-derivation agreement test below is isolated to the
 * keepalive policy field alone. */
function minimalCompleteReceipt(
	keepalive: CacheFlightKeepalivePolicySnapshot,
): CacheFlightCohortSealReceipt {
	return {
		serviceEpoch: {
			id: "epoch-safe-id",
			occurrenceId: "occurrence-safe-id",
			sealContractVersion: COHORT_SEAL_CONTRACT_VERSION,
			deploymentRevision: "deploy-safe-id",
			serviceInstanceId: "service-safe-id",
			processStartedAt: "2026-08-08T10:00:00.000Z",
			nativeCacheState: "enabled",
			recorderState: "enabled",
			keepalivePolicy: keepalive,
			completeness: "complete",
			unavailableDimensions: [],
		},
		observationPartition: {
			id: "partition-safe-id",
			serviceEpochId: "epoch-safe-id",
			servingAccountScope: "serving-scope-safe-id",
			routeModelEpoch: "route-model-safe-id",
			completeness: "complete",
			unavailableDimensions: [],
		},
		completeness: "complete",
		unavailableDimensions: [],
	};
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

// --- Drift guards -----------------------------------------------------
//
// Two independent reviewers found the same seal-dimension rule implemented
// separately in packages/core, packages/proxy, and packages/database. Each
// implementation is intentionally kept independent (see
// packages/database/src/repositories/cache-flight-recorder.repository.ts,
// assertPrivacySafeSealReceipt: the database validator must not trust the
// receipt it is checking, so it may not import the predicate the proxy used
// to build that receipt). These tests do not consolidate that duplication;
// they exist to catch the two implementations silently drifting apart.

describe("dimension order matches @better-ccflare/core's canonical order", () => {
	it("declares partition-unavailable dimensions in core's canonical PARTITION_DIMENSION_ORDER", () => {
		// If this package's private PARTITION_DIMENSION_ORDER (in
		// ../cache-flight-cohort-seal.ts) is ever reordered independently of
		// core's canonical order, unavailablePartitionDimensions() pushes in the
		// new (wrong) order and this assertion goes red.
		const service = makeService(makeConfig(20, 0).config);
		const receipt = capture(service, {
			finalServingAccount: makeAccount({ id: "" }),
			attemptedTransportModel: null,
			routeCandidateId: null,
		});

		expect(receipt?.observationPartition.unavailableDimensions).toEqual(
			CORE_PARTITION_DIMENSION_ORDER,
		);
	});

	it("declares the publicly-reachable service-unavailable dimensions in core's canonical SERVICE_DIMENSION_ORDER order", () => {
		// Only deployment_revision and service_instance can legitimately be
		// forced null through the public captureReceipt() API today: the other
		// six dimensions in SERVICE_DIMENSION_ORDER (seal_contract_version,
		// process_started_at, native_cache_state, recorder_state,
		// keepalive_policy, service_epoch_occurrence) are structurally
		// guaranteed non-null by buildProfile()/normalizeProcessStartedAt().
		// That structural guarantee is exactly the P1 invariant this drift
		// guard exists to police: unavailableServiceDimensions() still has an
		// explicit disjunct per dimension, and if a future change lets one of
		// the other six legitimately become null without adding its disjunct,
		// nothing here (or in production) will catch it until a real seal
		// silently fails to declare that dimension unavailable.
		const service = makeService(makeConfig(20, 0).config, {
			gitSha: null,
			idFactory: makeEmptyBootIdFactory(),
		});
		const receipt = capture(service);

		const reachable = CORE_SERVICE_DIMENSION_ORDER.filter(
			(dimension) =>
				dimension === "deployment_revision" || dimension === "service_instance",
		);
		expect(receipt?.serviceEpoch.unavailableDimensions).toEqual(reachable);
	});
});

describe("capture-to-validate agreement with the database seal validator", () => {
	// Pipes a REAL CohortSealService.captureReceipt() output through the
	// database's assertPrivacySafeSealReceipt (via
	// CacheFlightRecorderRepository.appendTurn). The database independently
	// recomputes expectedServiceUnavailable/expectedPartitionUnavailable from
	// the receipt's own field values and rejects any receipt whose declared
	// unavailableDimensions disagree - so if this package's
	// unavailableServiceDimensions()/unavailablePartitionDimensions() ever
	// fails to declare a dimension that is actually null (the P1 risk), the
	// resulting receipt is rejected here with
	// "unknown seal dimensions must be explicit", and this test goes red.

	it("accepts a fully-populated, complete receipt", async () => {
		const repo = freshRepo();
		const service = makeService(makeConfig(20, 5).config);
		const receipt = capture(service);
		expect(receipt?.completeness).toBe("complete");

		await expect(
			repo.appendTurn(
				"proxy-capture-complete",
				baseTurn(),
				1_000,
				receipt ?? undefined,
			),
		).resolves.toBeUndefined();

		const timeline = await repo.loadTimeline("proxy-capture-complete");
		expect(timeline?.turns[0]?.seal).toEqual(receipt);
	});

	it("accepts a receipt with a missing deployment revision", async () => {
		const repo = freshRepo();
		const service = makeService(makeConfig(20, 5).config, { gitSha: null });
		const receipt = capture(service);
		expect(receipt?.serviceEpoch.unavailableDimensions).toContain(
			"deployment_revision",
		);

		await expect(
			repo.appendTurn(
				"proxy-capture-missing-revision",
				baseTurn(),
				1_000,
				receipt ?? undefined,
			),
		).resolves.toBeUndefined();
	});

	it("accepts a receipt with a missing serving-account scope", async () => {
		const repo = freshRepo();
		const service = makeService(makeConfig(20, 5).config);
		const receipt = capture(service, {
			finalServingAccount: makeAccount({ id: "" }),
		});
		expect(receipt?.observationPartition.unavailableDimensions).toContain(
			"serving_account_scope",
		);

		await expect(
			repo.appendTurn(
				"proxy-capture-missing-scope",
				baseTurn(),
				1_000,
				receipt ?? undefined,
			),
		).resolves.toBeUndefined();
	});

	it("accepts a receipt with missing route/model evidence", async () => {
		const repo = freshRepo();
		const service = makeService(makeConfig(20, 5).config);
		const receipt = capture(service, {
			attemptedTransportModel: null,
			routeCandidateId: null,
		});
		expect(receipt?.observationPartition.unavailableDimensions).toContain(
			"route_model_epoch",
		);

		await expect(
			repo.appendTurn(
				"proxy-capture-missing-route-model",
				baseTurn(),
				1_000,
				receipt ?? undefined,
			),
		).resolves.toBeUndefined();
	});

	it("accepts every xAI/global keepalive TTL combination the scheduler can produce", async () => {
		for (const [globalTtl, xaiTtl] of [
			[20, 5],
			[20, 0],
			[0, 0],
			[0, 5],
		] as const) {
			const repo = freshRepo();
			const service = makeService(makeConfig(globalTtl, xaiTtl).config);
			const receipt = capture(service);

			await expect(
				repo.appendTurn(
					`proxy-capture-keepalive-${globalTtl}-${xaiTtl}`,
					baseTurn(),
					1_000,
					receipt ?? undefined,
				),
			).resolves.toBeUndefined();
		}
	});
});

describe("keepalive derivation agreement with the database seal validator", () => {
	it("pins the database's canonical v1 xAI derivation against the proxy's resolver over the precedence matrix", async () => {
		// The database's (private) keepalivePolicyMatchesCanonicalV1XaiDerivation
		// recomputes the expected snapshot from the receipt's own
		// globalTtlMinutes/xaiTtlMinutes and rejects any mismatch. Feeding it a
		// snapshot built by this package's resolveEffectiveXaiKeepalivePolicy
		// therefore pins the two independent derivations together: if either
		// side's precedence rule changes without the other, appendTurn starts
		// throwing "cache flight keepalive policy must match canonical v1 xAI
		// derivation" and this test goes red.
		for (const [globalTtl, xaiTtl, expectedTtl, expectedEnabled] of [
			[20, 5, 5, true], // positive xAI TTL wins
			[20, 0, 20, true], // else positive global TTL wins
			[0, 0, 0, false], // else disabled
			[0, 5, 5, true], // positive xAI TTL wins even with global disabled/zero
		] as const) {
			const resolvedTtl = resolveKeepaliveTtlMinutesFromPolicy(
				"xai",
				globalTtl,
				xaiTtl,
			);
			expect(resolvedTtl).toBe(expectedTtl);

			const policy = resolveEffectiveXaiKeepalivePolicy(globalTtl, xaiTtl);
			expect(policy.effectiveXaiEnabled).toBe(expectedEnabled);
			expect(policy.effectiveXaiTtlMinutes).toBe(
				expectedEnabled ? expectedTtl : null,
			);

			const repo = freshRepo();
			await expect(
				repo.appendTurn(
					`keepalive-agreement-${globalTtl}-${xaiTtl}`,
					baseTurn(),
					1_000,
					minimalCompleteReceipt(policy),
				),
			).resolves.toBeUndefined();
		}
	});
});
