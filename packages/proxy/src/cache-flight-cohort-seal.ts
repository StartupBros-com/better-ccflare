import type { Config } from "@better-ccflare/config";
import {
	type CacheFlightCohortSealReceipt,
	type CacheFlightKeepalivePolicySnapshot,
	type CacheFlightNativeCacheState,
	type CacheFlightObservationPartition,
	type CacheFlightRecorderState,
	type CacheFlightSealCompleteness,
	type CacheFlightSealDimension,
	type CacheFlightServiceEpoch,
	normalizeDeploymentRevision,
	type ResolvedBuildProvenance,
	readBuildProvenance,
} from "@better-ccflare/core";
import {
	isCacheFlightRecorderEnabled,
	isOfficialXaiEndpoint,
	isXaiCacheNativeEnabled,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { readEffectiveXaiKeepalivePolicy } from "./cache-keepalive-policy";
import {
	type OpaqueRuntimeIdFactory,
	processOpaqueRuntimeIdFactory,
} from "./opaque-runtime-id";

export const COHORT_SEAL_CONTRACT_VERSION = 1 as const;

export const COHORT_SEAL_PROFILE_CONFIG_KEYS = Object.freeze([
	"cache_keepalive_ttl_minutes",
	"xai_cache_keepalive_ttl_minutes",
] as const);

export type CohortSealProfileConfigKey =
	(typeof COHORT_SEAL_PROFILE_CONFIG_KEYS)[number];

type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export type CohortSealFinalServingAccount = Pick<
	Account,
	"id" | "provider" | "custom_endpoint"
>;

export interface CohortSealCaptureInput {
	readonly finalServingAccount?: CohortSealFinalServingAccount | null;
	readonly attemptedTransportModel?: string | null;
	readonly routeCandidateId?: string | null;
}

export interface CohortSealServiceProfileV1 {
	readonly sealContractVersion: typeof COHORT_SEAL_CONTRACT_VERSION;
	readonly deploymentRevision: string | null;
	readonly serviceInstanceId: string;
	readonly processStartedAt: string;
	readonly nativeCacheState: CacheFlightNativeCacheState;
	readonly recorderState: CacheFlightRecorderState;
	readonly keepalivePolicy: CacheFlightKeepalivePolicySnapshot;
}

export interface CohortSealServiceOptions {
	readonly config: Config;
	readonly idFactory?: OpaqueRuntimeIdFactory;
	readonly env?: EnvSnapshot;
	readonly processStartedAt?: string | Date;
	readonly readBuildProvenance?: () => ResolvedBuildProvenance;
}

interface ServiceOccurrence {
	readonly profile: CohortSealServiceProfileV1;
	readonly profileKey: string;
	readonly occurrenceId: string;
	readonly serviceEpochId: string;
	readonly partitions: Map<string, CacheFlightObservationPartition>;
}

const PROFILE_CONFIG_KEY_SET: ReadonlySet<string> = new Set(
	COHORT_SEAL_PROFILE_CONFIG_KEYS,
);

const SERVICE_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	"seal_contract_version",
	"deployment_revision",
	"service_instance",
	"process_started_at",
	"native_cache_state",
	"recorder_state",
	"keepalive_policy",
	"service_epoch_occurrence",
];

const PARTITION_DIMENSION_ORDER: readonly CacheFlightSealDimension[] = [
	"serving_account_scope",
	"route_model_epoch",
];

function normalizeProcessStartedAt(value: string | Date | undefined): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string" && value.length > 0) return value;
	return new Date().toISOString();
}

function knownString(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	return value.trim().length > 0 ? value : null;
}

function canonicalProfileKey(profile: CohortSealServiceProfileV1): string {
	return JSON.stringify({
		sealContractVersion: profile.sealContractVersion,
		deploymentRevision: profile.deploymentRevision,
		serviceInstanceId: profile.serviceInstanceId,
		processStartedAt: profile.processStartedAt,
		nativeCacheState: profile.nativeCacheState,
		recorderState: profile.recorderState,
		keepalivePolicy: {
			globalTtlMinutes: profile.keepalivePolicy.globalTtlMinutes,
			xaiTtlMinutes: profile.keepalivePolicy.xaiTtlMinutes,
			effectiveXaiEnabled: profile.keepalivePolicy.effectiveXaiEnabled,
			effectiveXaiTtlMinutes: profile.keepalivePolicy.effectiveXaiTtlMinutes,
		},
	});
}

function completenessFor(
	unavailableDimensions: readonly CacheFlightSealDimension[],
): CacheFlightSealCompleteness {
	return unavailableDimensions.length === 0 ? "complete" : "incomplete";
}

function unavailableServiceDimensions(
	profile: CohortSealServiceProfileV1,
): CacheFlightSealDimension[] {
	const unavailable: CacheFlightSealDimension[] = [];
	for (const dimension of SERVICE_DIMENSION_ORDER) {
		if (
			(dimension === "deployment_revision" &&
				profile.deploymentRevision === null) ||
			(dimension === "service_instance" &&
				knownString(profile.serviceInstanceId) === null) ||
			(dimension === "process_started_at" &&
				knownString(profile.processStartedAt) === null)
		) {
			unavailable.push(dimension);
		}
	}
	return unavailable;
}

function unavailablePartitionDimensions(input: {
	readonly servingAccountScope: string | null;
	readonly routeModelEpoch: string | null;
}): CacheFlightSealDimension[] {
	const unavailable: CacheFlightSealDimension[] = [];
	for (const dimension of PARTITION_DIMENSION_ORDER) {
		if (
			(dimension === "serving_account_scope" &&
				input.servingAccountScope === null) ||
			(dimension === "route_model_epoch" && input.routeModelEpoch === null)
		) {
			unavailable.push(dimension);
		}
	}
	return unavailable;
}

function uniqueUnavailableDimensions(
	...groups: readonly CacheFlightSealDimension[][]
): readonly CacheFlightSealDimension[] {
	const seen = new Set<CacheFlightSealDimension>();
	const dimensions: CacheFlightSealDimension[] = [];
	for (const group of groups) {
		for (const dimension of group) {
			if (seen.has(dimension)) continue;
			seen.add(dimension);
			dimensions.push(dimension);
		}
	}
	return Object.freeze(dimensions);
}

function freezeServiceProfile(
	profile: CohortSealServiceProfileV1,
): CohortSealServiceProfileV1 {
	return Object.freeze({
		...profile,
		keepalivePolicy: Object.freeze({ ...profile.keepalivePolicy }),
	});
}

export class CohortSealService {
	private readonly config: Config;
	private readonly idFactory: OpaqueRuntimeIdFactory;
	private readonly env: EnvSnapshot;
	private readonly processStartedAt: string;
	private readonly readBuildProvenanceFn: () => ResolvedBuildProvenance;
	private readonly boundConfigChangeHandler: (event: { key: string }) => void;
	private nextOccurrenceSequence = 1;
	private current: ServiceOccurrence;
	private disposed = false;

	constructor(options: CohortSealServiceOptions) {
		this.config = options.config;
		this.idFactory = options.idFactory ?? processOpaqueRuntimeIdFactory;
		this.env = options.env ?? process.env;
		this.processStartedAt = normalizeProcessStartedAt(options.processStartedAt);
		this.readBuildProvenanceFn =
			options.readBuildProvenance ?? (() => readBuildProvenance());
		this.current = this.createOccurrence(this.buildProfile());
		this.boundConfigChangeHandler = ({ key }) => {
			if (!PROFILE_CONFIG_KEY_SET.has(key)) return;
			this.rotateIfProfileChanged(this.buildProfile());
		};
		this.config.on("change", this.boundConfigChangeHandler);
	}

	captureReceipt(
		input: CohortSealCaptureInput,
	): CacheFlightCohortSealReceipt | null {
		this.rotateIfProfileChanged(this.buildProfile());
		const occurrence = this.current;
		const finalServingAccount = input.finalServingAccount ?? null;
		if (!this.isEligible(occurrence.profile, finalServingAccount)) {
			return null;
		}

		const finalServingAccountId = knownString(finalServingAccount?.id);
		const servingAccountScope = finalServingAccountId
			? this.idFactory.id(
					"cohort",
					"serving_account_scope",
					finalServingAccountId,
				)
			: null;
		const attemptedTransportModel = knownString(input.attemptedTransportModel);
		const routeCandidateId = knownString(input.routeCandidateId);
		const routeModelEpoch =
			attemptedTransportModel && routeCandidateId
				? this.idFactory.id(
						"cohort",
						"route_model_epoch",
						routeCandidateId,
						attemptedTransportModel,
					)
				: null;

		const serviceUnavailable = unavailableServiceDimensions(occurrence.profile);
		const partitionUnavailable = unavailablePartitionDimensions({
			servingAccountScope,
			routeModelEpoch,
		});
		const serviceEpoch: CacheFlightServiceEpoch = Object.freeze({
			id: occurrence.serviceEpochId,
			occurrenceId: occurrence.occurrenceId,
			sealContractVersion: occurrence.profile.sealContractVersion,
			deploymentRevision: occurrence.profile.deploymentRevision,
			serviceInstanceId: occurrence.profile.serviceInstanceId,
			processStartedAt: occurrence.profile.processStartedAt,
			nativeCacheState: occurrence.profile.nativeCacheState,
			recorderState: occurrence.profile.recorderState,
			keepalivePolicy: occurrence.profile.keepalivePolicy,
			completeness: completenessFor(serviceUnavailable),
			unavailableDimensions: Object.freeze(serviceUnavailable),
		});
		const partition = this.partitionFor(
			occurrence,
			servingAccountScope,
			routeModelEpoch,
			partitionUnavailable,
		);
		const unavailableDimensions = uniqueUnavailableDimensions(
			serviceUnavailable,
			partitionUnavailable,
		);
		return Object.freeze({
			serviceEpoch,
			observationPartition: partition,
			completeness: completenessFor(unavailableDimensions),
			unavailableDimensions,
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.config.off("change", this.boundConfigChangeHandler);
		this.disposed = true;
	}

	private buildProfile(): CohortSealServiceProfileV1 {
		const provenance = this.readBuildProvenanceFn();
		return freezeServiceProfile({
			sealContractVersion: COHORT_SEAL_CONTRACT_VERSION,
			deploymentRevision: normalizeDeploymentRevision(provenance.git_sha),
			serviceInstanceId: this.idFactory.bootId,
			processStartedAt: this.processStartedAt,
			nativeCacheState: isXaiCacheNativeEnabled(this.env as NodeJS.ProcessEnv)
				? "enabled"
				: "disabled",
			recorderState: isCacheFlightRecorderEnabled(this.env as NodeJS.ProcessEnv)
				? "enabled"
				: "disabled",
			keepalivePolicy: readEffectiveXaiKeepalivePolicy(this.config),
		});
	}

	private rotateIfProfileChanged(
		nextProfile: CohortSealServiceProfileV1,
	): void {
		const nextKey = canonicalProfileKey(nextProfile);
		if (nextKey === this.current.profileKey) return;
		this.current = this.createOccurrence(nextProfile, nextKey);
	}

	private createOccurrence(
		profile: CohortSealServiceProfileV1,
		profileKey = canonicalProfileKey(profile),
	): ServiceOccurrence {
		const sequence = this.nextOccurrenceSequence;
		this.nextOccurrenceSequence += 1;
		const occurrenceId = this.idFactory.id(
			"cohort",
			"service_epoch_occurrence",
			String(sequence),
			profileKey,
		);
		return {
			profile,
			profileKey,
			occurrenceId,
			serviceEpochId: this.idFactory.id(
				"cohort",
				"service_epoch",
				occurrenceId,
			),
			partitions: new Map(),
		};
	}

	private isEligible(
		profile: CohortSealServiceProfileV1,
		account: CohortSealFinalServingAccount | null,
	): boolean {
		if (!account || account.provider !== "xai") return false;
		return (
			profile.nativeCacheState === "enabled" &&
			profile.recorderState === "enabled" &&
			isOfficialXaiEndpoint(account as Account | null)
		);
	}

	private partitionFor(
		occurrence: ServiceOccurrence,
		servingAccountScope: string | null,
		routeModelEpoch: string | null,
		unavailableDimensions: readonly CacheFlightSealDimension[],
	): CacheFlightObservationPartition {
		const key = JSON.stringify({ servingAccountScope, routeModelEpoch });
		const existing = occurrence.partitions.get(key);
		if (existing) return existing;

		const partition = Object.freeze({
			id: this.idFactory.id(
				"cohort",
				"observation_partition",
				occurrence.occurrenceId,
				servingAccountScope,
				routeModelEpoch,
			),
			serviceEpochId: occurrence.serviceEpochId,
			servingAccountScope,
			routeModelEpoch,
			completeness: completenessFor(unavailableDimensions),
			unavailableDimensions: Object.freeze([...unavailableDimensions]),
		});
		occurrence.partitions.set(key, partition);
		return partition;
	}
}
