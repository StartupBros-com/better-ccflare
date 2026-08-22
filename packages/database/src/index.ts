// Re-export the DatabaseOperations class
import { DatabaseOperations } from "./database-operations";

export type { RuntimeConfig } from "@better-ccflare/config";
export { BunSqlAdapter } from "./adapters/bun-sql-adapter";
// Re-export other utilities
export { AsyncDbWriter } from "./async-writer";
export type {
	DatabaseConfig,
	DatabaseRetryConfig,
} from "./database-operations";
export { DatabaseFactory } from "./factory";
export type { IntegrityCheckKind } from "./integrity-check-runner";
export { runIntegrityCheckInWorker } from "./integrity-check-runner";
export { migrateFromCcflare } from "./migrate-from-ccflare";
export { ensureSchema, runMigrations } from "./migrations";
export type {
	HeartbeatRecord,
	MultiInstanceMode,
	MultiInstanceScanResult,
} from "./multi-instance-guard";
// Multi-instance guard — see tombii/better-ccflare#351. Operators may use
// these symbols directly (e.g. for custom integration tests) but most
// callers should rely on DatabaseOperations lifecycle integration.
export {
	clearHeartbeat,
	formatGuardMessage,
	getInstanceId,
	HEARTBEAT_EXPIRY_MS,
	HEARTBEAT_INTERVAL_MS,
	MultiInstanceRefusedError,
	purgeStaleHeartbeats,
	readMultiInstanceMode,
	runStartupGuard,
	scanHeartbeats,
	startHeartbeatLoop,
	writeHeartbeat,
} from "./multi-instance-guard";
export { getLegacyDbPath, resolveDbPath } from "./paths";
// Public encryption API — only init/status helpers are exported.
// `encryptPayload`/`decryptPayload` are internal to the database package.
export {
	initPayloadEncryption,
	isEncryptionEnabled,
} from "./payload-encryption";
export { analyzeIndexUsage } from "./performance-indexes";
export type { MarkAccountRateLimitedResult } from "./repositories/account.repository";
export {
	type CacheFlightRecorderCounts,
	type CacheFlightRecorderLookup,
	CacheFlightRecorderRepository,
	type CacheFlightRecorderTimeline,
	type MarkIncompleteOptions,
} from "./repositories/cache-flight-recorder.repository";
export {
	type CreateDeviceSetupJobInput,
	type CreateDeviceSetupJobResult,
	DEVICE_SETUP_JOB_STATUSES,
	DEVICE_SETUP_SAFE_ERROR_MESSAGES,
	DeviceSetupDataIntegrityError,
	DeviceSetupIdempotencyConflictError,
	type DeviceSetupJob,
	DeviceSetupJobRepository,
	type DeviceSetupJobStatus,
	type DeviceSetupJobView,
	type DeviceSetupProvider,
	type DeviceSetupRoutingOutcome,
	type DeviceSetupRoutingOutcomeReason,
	type DeviceSetupRoutingOutcomeStatus,
	type DeviceSetupRoutingSelection,
	type DeviceSetupSafeErrorCode,
	type DeviceSetupTerminalStatus,
} from "./repositories/device-setup-job.repository";
export type {
	ModelTranslation,
	SimilarModel,
} from "./repositories/model-translation.repository";
// Re-export repository classes
export { ModelTranslationRepository } from "./repositories/model-translation.repository";
export {
	type ReserveReplayIssuanceRangeInput,
	SERVER_TOOL_REPLAY_ISSUANCE_MAX,
	SERVER_TOOL_REPLAY_ISSUANCE_RESERVATION_MAX,
	type ServerToolReplayIssuance,
	ServerToolReplayIssuanceDataIntegrityError,
	ServerToolReplayIssuanceLimitError,
	type ServerToolReplayIssuanceRange,
	ServerToolReplayIssuanceRepository,
} from "./repositories/server-tool-replay-issuance.repository";
// Re-export repository types
export type { StatsRepository } from "./repositories/stats.repository";
export type {
	UsageWindow,
	UsageWindowGrantType,
} from "./repositories/usage-windows.repository";
// Re-export retry utilities for external use (from your improvements)
export { withDatabaseRetry, withDatabaseRetrySync } from "./retry";
export { DatabaseOperations };
