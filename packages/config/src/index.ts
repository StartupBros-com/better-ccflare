import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { dirname, posix } from "node:path";
import {
	DEFAULT_AGENT_MODEL,
	DEFAULT_STRATEGY,
	isValidStrategy,
	NETWORK,
	type StrategyName,
	TIME_CONSTANTS,
	ValidationError,
	validateEndpointUrl,
	validateNumber,
	validateString,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { validatePathOrThrow } from "@better-ccflare/security";
import { resolveConfigPath } from "./paths";

const log = new Logger("Config");

/**
 * This credential is intentionally env-only: it is absent from ConfigData,
 * config files, health output, and every generic config enumeration surface.
 */
export const GUARD_CORRELATION_SECRET_ENV =
	"CCFLARE_GUARD_CORRELATION_SECRET" as const;

export const CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE =
	"CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE" as const;

const CANONICAL_32_BYTE_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const SAFE_REPLAY_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SERVER_TOOL_REPLAY_KEYS_BYTES = 64 * 1024;
const MAX_SERVER_TOOL_REPLAY_JSON_DEPTH = 64;
// Linux uapi asm-generic/fcntl.h. Node/Bun do not consistently expose O_PATH.
const LINUX_O_PATH = 0o10000000;

export type ServerToolReplayUsableKey = Readonly<{
	id: string;
	status: "active" | "retained";
	key: ReadonlyArray<number>;
}>;

export type ServerToolReplayRevokedKey = Readonly<{
	id: string;
	status: "revoked";
}>;

export type ServerToolReplayKey =
	| ServerToolReplayUsableKey
	| ServerToolReplayRevokedKey;

export type ServerToolReplayKeysState =
	| Readonly<{ status: "disabled" }>
	| Readonly<{
			status: "unavailable";
			code: "invalid_replay_key_config";
	  }>
	| Readonly<{
			status: "ready";
			activeKeyId: string;
			keys: ReadonlyArray<ServerToolReplayKey>;
	  }>;

const SERVER_TOOL_REPLAY_KEYS_DISABLED: ServerToolReplayKeysState =
	Object.freeze({ status: "disabled" });
const SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE: ServerToolReplayKeysState =
	Object.freeze({
		status: "unavailable",
		code: "invalid_replay_key_config",
	});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactProperties(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((property, index) => property === expected[index])
	);
}

class StrictJsonScanner {
	private offset = 0;

	constructor(private readonly source: string) {}

	scan(): boolean {
		if (!this.parseValue(0)) return false;
		this.skipWhitespace();
		return this.offset === this.source.length;
	}

	private parseValue(depth: number): boolean {
		this.skipWhitespace();
		const character = this.source[this.offset];
		if (character === "{") return this.parseObject(depth);
		if (character === "[") return this.parseArray(depth);
		if (character === '"') return this.scanStringLiteral() !== undefined;
		if (character === "t") return this.consumeLiteral("true");
		if (character === "f") return this.consumeLiteral("false");
		if (character === "n") return this.consumeLiteral("null");
		return this.consumeNumber();
	}

	private parseObject(depth: number): boolean {
		if (depth >= MAX_SERVER_TOOL_REPLAY_JSON_DEPTH) return false;
		this.offset += 1;
		this.skipWhitespace();
		if (this.source[this.offset] === "}") {
			this.offset += 1;
			return true;
		}

		const memberNames = new Set<string>();
		while (this.offset < this.source.length) {
			const literal = this.scanStringLiteral();
			if (literal === undefined) return false;
			let memberName: unknown;
			try {
				memberName = JSON.parse(literal) as unknown;
			} catch {
				return false;
			}
			if (typeof memberName !== "string" || memberNames.has(memberName)) {
				return false;
			}
			memberNames.add(memberName);

			this.skipWhitespace();
			if (this.source[this.offset] !== ":") return false;
			this.offset += 1;
			if (!this.parseValue(depth + 1)) return false;
			this.skipWhitespace();
			const delimiter = this.source[this.offset];
			if (delimiter === "}") {
				this.offset += 1;
				return true;
			}
			if (delimiter !== ",") return false;
			this.offset += 1;
			this.skipWhitespace();
		}
		return false;
	}

	private parseArray(depth: number): boolean {
		if (depth >= MAX_SERVER_TOOL_REPLAY_JSON_DEPTH) return false;
		this.offset += 1;
		this.skipWhitespace();
		if (this.source[this.offset] === "]") {
			this.offset += 1;
			return true;
		}

		while (this.offset < this.source.length) {
			if (!this.parseValue(depth + 1)) return false;
			this.skipWhitespace();
			const delimiter = this.source[this.offset];
			if (delimiter === "]") {
				this.offset += 1;
				return true;
			}
			if (delimiter !== ",") return false;
			this.offset += 1;
		}
		return false;
	}

	private scanStringLiteral(): string | undefined {
		if (this.source[this.offset] !== '"') return undefined;
		const start = this.offset;
		this.offset += 1;
		while (this.offset < this.source.length) {
			const codeUnit = this.source.charCodeAt(this.offset);
			if (codeUnit === 0x22) {
				this.offset += 1;
				return this.source.slice(start, this.offset);
			}
			if (codeUnit < 0x20) return undefined;
			if (codeUnit !== 0x5c) {
				this.offset += 1;
				continue;
			}

			this.offset += 1;
			const escapeSequence = this.source[this.offset];
			if (escapeSequence === undefined) return undefined;
			if ('"\\/bfnrt'.includes(escapeSequence)) {
				this.offset += 1;
				continue;
			}
			if (escapeSequence !== "u" || !this.hasFourHexDigits(this.offset + 1)) {
				return undefined;
			}
			this.offset += 5;
		}
		return undefined;
	}

	private hasFourHexDigits(start: number): boolean {
		if (start + 4 > this.source.length) return false;
		for (let index = start; index < start + 4; index += 1) {
			const codeUnit = this.source.charCodeAt(index);
			if (
				!(
					(codeUnit >= 0x30 && codeUnit <= 0x39) ||
					(codeUnit >= 0x41 && codeUnit <= 0x46) ||
					(codeUnit >= 0x61 && codeUnit <= 0x66)
				)
			) {
				return false;
			}
		}
		return true;
	}

	private consumeLiteral(literal: "true" | "false" | "null"): boolean {
		if (!this.source.startsWith(literal, this.offset)) return false;
		this.offset += literal.length;
		return true;
	}

	private consumeNumber(): boolean {
		const start = this.offset;
		if (this.source[this.offset] === "-") this.offset += 1;

		if (this.source[this.offset] === "0") {
			this.offset += 1;
			if (this.isDigitAt(this.offset)) {
				this.offset = start;
				return false;
			}
		} else if (this.isNonZeroDigitAt(this.offset)) {
			this.offset += 1;
			while (this.isDigitAt(this.offset)) this.offset += 1;
		} else {
			this.offset = start;
			return false;
		}

		if (this.source[this.offset] === ".") {
			this.offset += 1;
			if (!this.isDigitAt(this.offset)) {
				this.offset = start;
				return false;
			}
			while (this.isDigitAt(this.offset)) this.offset += 1;
		}

		const exponent = this.source[this.offset];
		if (exponent === "e" || exponent === "E") {
			this.offset += 1;
			const sign = this.source[this.offset];
			if (sign === "+" || sign === "-") this.offset += 1;
			if (!this.isDigitAt(this.offset)) {
				this.offset = start;
				return false;
			}
			while (this.isDigitAt(this.offset)) this.offset += 1;
		}

		return true;
	}

	private isDigitAt(offset: number): boolean {
		const codeUnit = this.source.charCodeAt(offset);
		return codeUnit >= 0x30 && codeUnit <= 0x39;
	}

	private isNonZeroDigitAt(offset: number): boolean {
		const codeUnit = this.source.charCodeAt(offset);
		return codeUnit >= 0x31 && codeUnit <= 0x39;
	}

	private skipWhitespace(): void {
		while (this.offset < this.source.length) {
			const codeUnit = this.source.charCodeAt(this.offset);
			if (
				codeUnit !== 0x20 &&
				codeUnit !== 0x09 &&
				codeUnit !== 0x0a &&
				codeUnit !== 0x0d
			) {
				return;
			}
			this.offset += 1;
		}
	}
}

function isStrictJsonDocument(source: string): boolean {
	return new StrictJsonScanner(source).scan();
}

function decodeReplayKey(value: unknown): ReadonlyArray<number> | undefined {
	if (typeof value !== "string" || !CANONICAL_32_BYTE_BASE64URL.test(value)) {
		return undefined;
	}
	const decoded = Buffer.from(value, "base64url");
	try {
		if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
			return undefined;
		}
		return Object.freeze([...decoded]);
	} finally {
		decoded.fill(0);
	}
}

function parseServerToolReplayKeys(
	value: unknown,
): ServerToolReplayKeysState | undefined {
	if (
		!isRecord(value) ||
		!hasExactProperties(value, ["activeKeyId", "keys", "version"]) ||
		value.version !== 1 ||
		typeof value.activeKeyId !== "string" ||
		!SAFE_REPLAY_KEY_ID.test(value.activeKeyId) ||
		!Array.isArray(value.keys)
	) {
		return undefined;
	}

	const seenIds = new Set<string>();
	const seenUsableKeyMaterial = new Set<string>();
	const keys: ServerToolReplayKey[] = [];
	let activeRecords = 0;
	for (const candidate of value.keys) {
		if (
			!isRecord(candidate) ||
			typeof candidate.id !== "string" ||
			!SAFE_REPLAY_KEY_ID.test(candidate.id) ||
			seenIds.has(candidate.id) ||
			(candidate.status !== "active" &&
				candidate.status !== "retained" &&
				candidate.status !== "revoked")
		) {
			return undefined;
		}
		seenIds.add(candidate.id);

		if (candidate.status === "revoked") {
			if (!hasExactProperties(candidate, ["id", "status"])) return undefined;
			keys.push(Object.freeze({ id: candidate.id, status: "revoked" }));
			continue;
		}

		if (!hasExactProperties(candidate, ["id", "key", "status"])) {
			return undefined;
		}
		const encodedKey = candidate.key;
		const key = decodeReplayKey(encodedKey);
		if (
			!key ||
			typeof encodedKey !== "string" ||
			seenUsableKeyMaterial.has(encodedKey)
		) {
			return undefined;
		}
		seenUsableKeyMaterial.add(encodedKey);
		if (candidate.status === "active") activeRecords += 1;
		keys.push(
			Object.freeze({ id: candidate.id, status: candidate.status, key }),
		);
	}

	if (
		activeRecords !== 1 ||
		!keys.some((key) => key.id === value.activeKeyId && key.status === "active")
	) {
		return undefined;
	}

	keys.sort((left, right) =>
		left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
	);
	return Object.freeze({
		status: "ready",
		activeKeyId: value.activeKeyId,
		keys: Object.freeze(keys),
	});
}

function replayKeyPathComponents(
	configuredPath: string,
): ReadonlyArray<string> | undefined {
	if (
		configuredPath.length === 0 ||
		configuredPath.includes("\0") ||
		!posix.isAbsolute(configuredPath) ||
		posix.normalize(configuredPath) !== configuredPath
	) {
		return undefined;
	}

	const components = configuredPath.slice(1).split("/");
	if (
		components.length === 0 ||
		components.some(
			(component) =>
				component.length === 0 || component === "." || component === "..",
		)
	) {
		return undefined;
	}
	return components;
}

type ReplayKeyFileSnapshot = Readonly<{
	dev: bigint;
	ino: bigint;
	fileType: bigint;
	mode: bigint;
	uid: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
	isFile: boolean;
}>;

function replayKeyFileSnapshot(descriptor: number): ReplayKeyFileSnapshot {
	const stats = fstatSync(descriptor, { bigint: true });
	return {
		dev: stats.dev,
		ino: stats.ino,
		fileType: stats.mode & BigInt(fsConstants.S_IFMT),
		mode: stats.mode,
		uid: stats.uid,
		nlink: stats.nlink,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
		isFile: stats.isFile(),
	};
}

function sameReplayKeyFileSnapshot(
	left: ReplayKeyFileSnapshot,
	right: ReplayKeyFileSnapshot,
): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.fileType === right.fileType &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.isFile === right.isFile
	);
}

function isProtectedReplayKeyFile(
	snapshot: ReplayKeyFileSnapshot,
	effectiveUid: number,
): boolean {
	const permissions = Number(snapshot.mode & 0o7777n);
	return (
		snapshot.isFile &&
		snapshot.nlink === 1n &&
		(permissions === 0o400 || permissions === 0o600) &&
		snapshot.uid === BigInt(effectiveUid) &&
		snapshot.size >= 0n &&
		snapshot.size <= BigInt(MAX_SERVER_TOOL_REPLAY_KEYS_BYTES)
	);
}

function openReplayKeyFileFromRoot(
	components: ReadonlyArray<string>,
	descriptors: number[],
): number | undefined {
	const directoryFlags =
		fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
	let parentDescriptor = openSync("/", directoryFlags);
	descriptors.push(parentDescriptor);
	if (!fstatSync(parentDescriptor).isDirectory()) return undefined;

	for (const component of components.slice(0, -1)) {
		const descriptor = openSync(
			`/proc/self/fd/${parentDescriptor}/${component}`,
			directoryFlags,
		);
		descriptors.push(descriptor);
		if (!fstatSync(descriptor).isDirectory()) return undefined;
		parentDescriptor = descriptor;
	}

	const finalComponent = components.at(-1);
	if (finalComponent === undefined) return undefined;
	const fileDescriptor = openSync(
		`/proc/self/fd/${parentDescriptor}/${finalComponent}`,
		LINUX_O_PATH | fsConstants.O_NOFOLLOW,
	);
	descriptors.push(fileDescriptor);
	return fileDescriptor;
}

function readBoundedReplayKeyFile(
	descriptor: number,
	size: number,
): string | undefined {
	const content = Buffer.alloc(size);
	const overflowProbe = Buffer.alloc(1);
	try {
		let offset = 0;
		while (offset < size) {
			const bytesRead = readSync(
				descriptor,
				content,
				offset,
				size - offset,
				offset,
			);
			if (bytesRead === 0) return undefined;
			offset += bytesRead;
		}

		if (readSync(descriptor, overflowProbe, 0, 1, size) !== 0) {
			return undefined;
		}
		return content.toString("utf8");
	} finally {
		content.fill(0);
		overflowProbe.fill(0);
	}
}

/**
 * Load the restart-scoped replay keyring without exposing file, parser, or key
 * details through its failure DTO.
 */
export function loadServerToolReplayKeys(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
): ServerToolReplayKeysState {
	let configuredPath: string | undefined;
	try {
		configuredPath = env[CCFLARE_SERVER_TOOL_REPLAY_KEYS_FILE];
	} catch {
		return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
	}
	if (configuredPath === undefined) return SERVER_TOOL_REPLAY_KEYS_DISABLED;
	if (platform !== "linux" || process.platform !== "linux") {
		return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
	}

	const descriptors: number[] = [];
	try {
		const components = replayKeyPathComponents(configuredPath);
		if (components === undefined) return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		if (typeof process.geteuid !== "function") {
			return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		}
		const effectiveUid = process.geteuid();
		const pinnedDescriptor = openReplayKeyFileFromRoot(components, descriptors);
		if (pinnedDescriptor === undefined) {
			return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		}
		const pinnedBefore = replayKeyFileSnapshot(pinnedDescriptor);
		// Ancestors may legitimately be root-owned or shared. The O_NOFOLLOW
		// descriptor walk prevents path substitution; ownership, restrictive mode,
		// single-link state, and fd pinning are therefore enforced on the secret
		// file itself instead of imposing a brittle all-ancestors-owner policy.
		if (!isProtectedReplayKeyFile(pinnedBefore, effectiveUid)) {
			return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		}

		// This proc link refers only to the already validated O_PATH descriptor.
		// Non-regular payloads never reach this read-capable open.
		const readDescriptor = openSync(
			`/proc/self/fd/${pinnedDescriptor}`,
			fsConstants.O_RDONLY,
		);
		descriptors.push(readDescriptor);
		const readBefore = replayKeyFileSnapshot(readDescriptor);
		if (!sameReplayKeyFileSnapshot(pinnedBefore, readBefore)) {
			return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		}

		const contents = readBoundedReplayKeyFile(
			readDescriptor,
			Number(pinnedBefore.size),
		);
		if (contents === undefined) return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		const readAfter = replayKeyFileSnapshot(readDescriptor);
		const pinnedAfter = replayKeyFileSnapshot(pinnedDescriptor);
		if (
			!sameReplayKeyFileSnapshot(pinnedBefore, readAfter) ||
			!sameReplayKeyFileSnapshot(pinnedBefore, pinnedAfter) ||
			!isStrictJsonDocument(contents)
		) {
			return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
		}
		const parsed = JSON.parse(contents) as unknown;
		return (
			parseServerToolReplayKeys(parsed) ?? SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE
		);
	} catch {
		return SERVER_TOOL_REPLAY_KEYS_UNAVAILABLE;
	} finally {
		for (let index = descriptors.length - 1; index >= 0; index -= 1) {
			try {
				closeSync(descriptors[index] as number);
			} catch {
				// The public loader remains detail-free even if descriptor cleanup fails.
			}
		}
	}
}

export function readGuardCorrelationSecret(
	env: Record<string, string | undefined> = process.env,
): Uint8Array | undefined {
	const encoded = env[GUARD_CORRELATION_SECRET_ENV];
	if (!encoded || !CANONICAL_32_BYTE_BASE64URL.test(encoded)) return undefined;
	const decoded = Buffer.from(encoded, "base64url");
	if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
		return undefined;
	}
	return Uint8Array.from(decoded);
}

function parseEnabledEnvFlag(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value === "true" || value === "1";
}

function parseStrictBooleanFlag(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;
	return null;
}

export type AnthropicDegradedMode = "off" | "observe" | "enforce";

/**
 * Restart-scoped policy settings for Anthropic degraded mode. The coordinator
 * owns only process-local state; none of these settings imply persistence.
 */
export interface AnthropicDegradedModeConfig {
	mode: AnthropicDegradedMode;
	largeRequestTokenThreshold: number;
	largeRequestByteThreshold: number;
	evidenceWindowMs: number;
	quorum: number;
	retryMinMs: number;
	retryFallbackMs: number;
	retryMaxMs: number;
	recoveryWindowMs: number;
	probeLeaseMs: number;
	maxCohorts: number;
}

export const ANTHROPIC_DEGRADED_MODE_DEFAULTS: Readonly<AnthropicDegradedModeConfig> =
	Object.freeze({
		mode: "off",
		largeRequestTokenThreshold: 100_000,
		largeRequestByteThreshold: 256 * 1024,
		evidenceWindowMs: 30_000,
		quorum: 2,
		retryMinMs: 5_000,
		retryFallbackMs: 10_000,
		retryMaxMs: 60_000,
		recoveryWindowMs: 30_000,
		probeLeaseMs: 10 * 60_000,
		maxCohorts: 1_024,
	});

export interface AnthropicDegradedModeConfigInput {
	mode?: unknown;
	largeRequestTokenThreshold?: unknown;
	largeRequestByteThreshold?: unknown;
	evidenceWindowMs?: unknown;
	quorum?: unknown;
	retryMinMs?: unknown;
	retryFallbackMs?: unknown;
	retryMaxMs?: unknown;
	recoveryWindowMs?: unknown;
	probeLeaseMs?: unknown;
	maxCohorts?: unknown;
}

const ANTHROPIC_DEGRADED_NUMERIC_BOUNDS = {
	largeRequestTokenThreshold: [10_000, 2_000_000],
	largeRequestByteThreshold: [64 * 1024, 16 * 1024 * 1024],
	evidenceWindowMs: [5_000, 5 * 60_000],
	quorum: [2, 8],
	retryMinMs: [1_000, 60_000],
	retryFallbackMs: [1_000, 5 * 60_000],
	retryMaxMs: [5_000, 5 * 60_000],
	recoveryWindowMs: [5_000, 5 * 60_000],
	probeLeaseMs: [60_000, 15 * 60_000],
	maxCohorts: [1, 10_000],
} as const satisfies Record<
	Exclude<keyof AnthropicDegradedModeConfig, "mode">,
	readonly [number, number]
>;

function parseBoundedInteger(
	value: unknown,
	fallback: number,
	bounds: readonly [number, number],
): number | null {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" &&
		(typeof value !== "string" || value.trim() === "")
	) {
		return null;
	}
	const parsed = typeof value === "number" ? value : Number(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < bounds[0] ||
		parsed > bounds[1]
	) {
		return null;
	}
	return parsed;
}

/**
 * Resolve the entire policy atomically. Any invalid supplied value disables
 * enforcement instead of leaving a partially valid policy active.
 */
export function resolveAnthropicDegradedModeConfig(
	input: AnthropicDegradedModeConfigInput,
	onInvalid?: (field: keyof AnthropicDegradedModeConfig) => void,
): AnthropicDegradedModeConfig {
	const rawMode = input.mode ?? ANTHROPIC_DEGRADED_MODE_DEFAULTS.mode;
	const normalizedMode =
		typeof rawMode === "string" ? rawMode.trim().toLowerCase() : "";
	const mode =
		normalizedMode === "off" ||
		normalizedMode === "observe" ||
		normalizedMode === "enforce"
			? normalizedMode
			: null;
	if (mode === null) {
		onInvalid?.("mode");
		return { ...ANTHROPIC_DEGRADED_MODE_DEFAULTS };
	}

	const resolved = {
		mode,
	} as AnthropicDegradedModeConfig;
	for (const field of Object.keys(ANTHROPIC_DEGRADED_NUMERIC_BOUNDS) as Array<
		Exclude<keyof AnthropicDegradedModeConfig, "mode">
	>) {
		const value = parseBoundedInteger(
			input[field],
			ANTHROPIC_DEGRADED_MODE_DEFAULTS[field],
			ANTHROPIC_DEGRADED_NUMERIC_BOUNDS[field],
		);
		if (value === null) {
			onInvalid?.(field);
			return { ...ANTHROPIC_DEGRADED_MODE_DEFAULTS };
		}
		resolved[field] = value;
	}

	if (
		resolved.retryMinMs > resolved.retryFallbackMs ||
		resolved.retryFallbackMs > resolved.retryMaxMs
	) {
		onInvalid?.("retryFallbackMs");
		return { ...ANTHROPIC_DEGRADED_MODE_DEFAULTS };
	}
	return resolved;
}

export interface RuntimeConfig {
	clientId: string;
	retry: { attempts: number; delayMs: number; backoff: number };
	sessionDurationMs: number;
	port: number;
	database?: {
		walMode?: boolean;
		busyTimeoutMs?: number;
		cacheSize?: number;
		synchronous?: "OFF" | "NORMAL" | "FULL";
		mmapSize?: number;
		pageSize?: number;
		retry?: {
			attempts?: number;
			delayMs?: number;
			backoff?: number;
			maxDelayMs?: number;
		};
	};
}

export interface ConfigData {
	lb_strategy?: StrategyName;
	client_id?: string;
	retry_attempts?: number;
	retry_delay_ms?: number;
	retry_backoff?: number;
	session_duration_ms?: number;
	port?: number;
	default_agent_model?: string;
	data_retention_days?: number;
	request_retention_days?: number;
	usage_history_retention_days?: number;
	cache_flight_recorder_retention_hours?: number;
	store_payloads?: boolean;
	usage_poll_interval_ms?: number;
	cache_keepalive_ttl_minutes?: number;
	xai_cache_keepalive_ttl_minutes?: number;
	system_prompt_cache_ttl_1h?: boolean;
	usage_throttling_five_hour_enabled?: boolean;
	usage_throttling_weekly_enabled?: boolean;
	agent_frontmatter_model_fallback?: boolean;
	model_catalog_oauth_refresh_enabled?: boolean;
	health_detail_enabled?: boolean;
	anthropic_degraded_mode?: AnthropicDegradedMode;
	anthropic_degraded_large_request_tokens?: number;
	anthropic_degraded_large_request_bytes?: number;
	anthropic_degraded_evidence_window_ms?: number;
	anthropic_degraded_quorum?: number;
	anthropic_degraded_retry_min_ms?: number;
	anthropic_degraded_retry_fallback_ms?: number;
	anthropic_degraded_retry_max_ms?: number;
	anthropic_degraded_recovery_window_ms?: number;
	anthropic_degraded_probe_lease_ms?: number;
	anthropic_degraded_max_cohorts?: number;
	anthropic_degraded_diagnostics_enabled?: boolean;
	alert_daily_spend_usd?: number;
	alert_tokens_per_hour?: number;
	alert_request_tokens?: number;
	alert_usage_window_threshold_percent?: number;
	alert_anomaly_enabled?: boolean;
	alert_anomaly_interval_minutes?: number;
	alert_anomaly_loop_min_requests?: number;
	alert_cooldown_minutes?: number;
	alert_webhook_url?: string;
	outbound_proxy?: string;
	// Local-control secret: shared between the CLI and the server process it
	// controls, used to authorize a small set of idempotent CLI->server
	// notify calls (token reload, force-reset-rate-limit) when API-key auth
	// is enabled. See AuthService#isLocalControlRequest. Generated once on
	// first access and persisted — unlike ProxyContext.internalProbeSecret,
	// which is intentionally re-minted every server process start.
	local_control_secret?: string;
	// Database configuration
	db_wal_mode?: boolean;
	db_busy_timeout_ms?: number;
	db_cache_size?: number;
	db_synchronous?: "OFF" | "NORMAL" | "FULL";
	db_mmap_size?: number;
	db_page_size?: number;
	db_retry_attempts?: number;
	db_retry_delay_ms?: number;
	db_retry_backoff?: number;
	db_retry_max_delay_ms?: number;
	[key: string]: string | number | boolean | undefined;
}

/**
 * Validates database configuration parameters
 */
function validateDatabaseConfig(
	config: Partial<RuntimeConfig["database"]>,
): void {
	if (!config) return;

	// Validate synchronous mode
	if (config.synchronous !== undefined) {
		validateString(config.synchronous, "db_synchronous", {
			allowedValues: ["OFF", "NORMAL", "FULL"],
		});
	}

	// Validate numeric parameters with reasonable bounds
	if (config.busyTimeoutMs !== undefined) {
		validateNumber(config.busyTimeoutMs, "db_busy_timeout_ms", {
			min: 0,
			max: 300000, // 5 minutes max
			integer: true,
		});
	}

	if (config.cacheSize !== undefined) {
		validateNumber(config.cacheSize, "db_cache_size", {
			min: -2000000, // -2GB max negative (KB)
			max: 1000000, // 1M pages max positive
			integer: true,
		});
	}

	if (config.mmapSize !== undefined) {
		validateNumber(config.mmapSize, "db_mmap_size", {
			min: 0,
			max: 1073741824, // 1GB max
			integer: true,
		});
	}

	// Validate retry configuration consistency
	if (config.retry) {
		const retry = config.retry;

		if (retry.attempts !== undefined) {
			validateNumber(retry.attempts, "db_retry_attempts", {
				min: 1,
				max: 10,
				integer: true,
			});
		}

		if (retry.delayMs !== undefined) {
			validateNumber(retry.delayMs, "db_retry_delay_ms", {
				min: 1,
				max: 60000, // 1 minute max
				integer: true,
			});
		}

		if (retry.backoff !== undefined) {
			validateNumber(retry.backoff, "db_retry_backoff", {
				min: 1,
				max: 10,
			});
		}

		if (retry.maxDelayMs !== undefined) {
			validateNumber(retry.maxDelayMs, "db_retry_max_delay_ms", {
				min: 1,
				max: 300000, // 5 minutes max
				integer: true,
			});
		}

		// Ensure maxDelayMs is greater than delayMs if both are specified
		if (retry.delayMs !== undefined && retry.maxDelayMs !== undefined) {
			if (retry.maxDelayMs < retry.delayMs) {
				throw new ValidationError(
					"db_retry_max_delay_ms must be greater than or equal to db_retry_delay_ms",
					"db_retry_max_delay_ms",
				);
			}
		}
	}
}

export function getCodexReasoningRetention(): boolean {
	const fromEnv = process.env.CCFLARE_CODEX_REASONING_RETENTION;
	if (fromEnv) {
		return fromEnv !== "false" && fromEnv !== "0";
	}
	return true;
}

export class Config extends EventEmitter {
	private configPath: string;
	private data: ConfigData = {};

	constructor(configPath?: string) {
		super();
		const rawPath = configPath ?? resolveConfigPath();
		// Validate config path for security
		this.configPath = validatePathOrThrow(rawPath, {
			description: "config file",
		});
		this.loadConfig();
	}

	private loadConfig(): void {
		if (existsSync(this.configPath)) {
			try {
				const content = readFileSync(this.configPath, "utf8");
				this.data = JSON.parse(content) as ConfigData;
			} catch (error) {
				log.error(`Failed to parse config file: ${error}`);
				this.data = {};
			}
		} else {
			// Create config directory if it doesn't exist
			const dir = dirname(this.configPath);
			mkdirSync(dir, { recursive: true });

			// Initialize with default config
			this.data = {
				lb_strategy: DEFAULT_STRATEGY,
			};
			this.saveConfig();
		}
	}

	private saveConfig(): void {
		try {
			const content = JSON.stringify(this.data, null, 2);
			writeFileSync(this.configPath, content, "utf8");
		} catch (error) {
			log.error(`Failed to save config file: ${error}`);
		}
	}

	get(
		key: string,
		defaultValue?: string | number | boolean,
	): string | number | boolean | undefined {
		if (key in this.data) {
			return this.data[key];
		}

		if (defaultValue !== undefined) {
			this.set(key, defaultValue);
			return defaultValue;
		}

		return undefined;
	}

	set(key: string, value: string | number | boolean): void {
		const oldValue = this.data[key];
		this.data[key] = value;
		this.saveConfig();

		// Emit change event
		this.emit("change", { key, oldValue, newValue: value });
	}

	getStrategy(): StrategyName {
		return this.resolveStrategy().value;
	}

	/**
	 * Report where the effective load-balancing strategy comes from, mirroring
	 * the precedence in getStrategy(): a valid LB_STRATEGY env value wins
	 * ("env"), else a valid config-file field ("file"), else the built-in
	 * default ("default"). The dashboard uses "env" to lock the strategy
	 * control, because a POST that writes the file field is ineffective while
	 * the env var overrides it.
	 */
	getStrategySource(): "env" | "file" | "default" {
		return this.resolveStrategy().source;
	}

	setStrategy(strategy: StrategyName): void {
		if (!isValidStrategy(strategy)) {
			throw new Error(`Invalid strategy: ${strategy}`);
		}
		this.set("lb_strategy", strategy);
	}

	getDefaultAgentModel(): string {
		// First check environment variable
		const envModel = process.env.DEFAULT_AGENT_MODEL;
		if (envModel) {
			return envModel;
		}

		// Then check config file
		const configModel = this.data.default_agent_model;
		if (configModel) {
			return configModel;
		}

		// Default to the centralized default agent model
		return DEFAULT_AGENT_MODEL;
	}

	setDefaultAgentModel(model: string): void {
		this.set("default_agent_model", model);
	}

	getOutboundProxy(): string | undefined {
		const candidate =
			process.env.BETTER_CCFLARE_OUTBOUND_PROXY ?? this.data.outbound_proxy;
		if (!candidate) {
			return undefined;
		}
		try {
			return validateEndpointUrl(candidate, "outbound_proxy");
		} catch (error) {
			log.warn("Invalid outbound proxy URL. Ignoring.", error);
			return undefined;
		}
	}

	private clamp(n: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, n));
	}

	getDataRetentionDays(): number {
		const fromEnv = process.env.DATA_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 365);
		}
		const fromFile = this.data.data_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 365);
		// Default payload retention reduced to 1 day to bound request_payloads
		// growth: each request stores up to ~4 MiB of conversation history, so
		// high-volume proxies otherwise reach tens of GB. Override via the
		// DATA_RETENTION_DAYS env var or the data_retention_days config key.
		return 1;
	}

	setDataRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 365);
		this.set("data_retention_days", clamped);
	}

	getRequestRetentionDays(): number {
		const fromEnv = process.env.REQUEST_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.request_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default metadata retention (90 days for analytics and troubleshooting)
	}

	setRequestRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("request_retention_days", clamped);
	}

	getUsageHistoryRetentionDays(): number {
		const fromEnv = process.env.USAGE_HISTORY_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.usage_history_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default: keep 90 days of usage-window history
	}

	setUsageHistoryRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("usage_history_retention_days", clamped);
	}

	getCacheFlightRecorderRetentionHours(): number {
		const fromEnv = process.env.CACHE_FLIGHT_RECORDER_RETENTION_HOURS;
		if (fromEnv) {
			const hours = Number(fromEnv);
			if (Number.isFinite(hours)) return this.clamp(hours, 1, 14 * 24);
		}
		const fromFile = this.data.cache_flight_recorder_retention_hours;
		if (typeof fromFile === "number" && Number.isFinite(fromFile)) {
			return this.clamp(fromFile, 1, 14 * 24);
		}
		return 72;
	}

	setCacheFlightRecorderRetentionHours(hours: number): void {
		this.set(
			"cache_flight_recorder_retention_hours",
			this.clamp(hours, 1, 14 * 24),
		);
	}

	getStorePayloads(): boolean {
		const fromEnv = process.env.STORE_PAYLOADS;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.store_payloads;
		if (typeof fromFile === "boolean") return fromFile;
		return true; // default: store payloads
	}

	setStorePayloads(value: boolean): void {
		this.set("store_payloads", value);
	}

	getUsagePollIntervalMs(): number {
		const fromEnv = process.env.USAGE_POLL_INTERVAL_MS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 10000, 3600000);
		}
		const fromFile = this.data.usage_poll_interval_ms;
		if (typeof fromFile === "number")
			return this.clamp(fromFile, 10000, 3600000);
		return 90000; // default: 90 seconds
	}

	setUsagePollIntervalMs(ms: number): void {
		const clamped = this.clamp(ms, 10000, 3600000);
		this.set("usage_poll_interval_ms", clamped);
	}

	getCacheKeepaliveTtlMinutes(): number {
		const fromEnv = process.env.CACHE_KEEPALIVE_TTL_MINUTES;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 60);
		}
		const fromFile = this.data.cache_keepalive_ttl_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 60);
		return 0; // default: disabled
	}

	setCacheKeepaliveTtlMinutes(minutes: number): void {
		const clamped = this.clamp(minutes, 0, 60);
		this.set("cache_keepalive_ttl_minutes", clamped);
	}

	/**
	 * Official-xAI-only keepalive TTL. Independent of the global Anthropic-oriented
	 * CACHE_KEEPALIVE_TTL_MINUTES so Grok can be canaried without replaying every
	 * Anthropic account. Env: CCFLARE_XAI_CACHE_KEEPALIVE_TTL_MINUTES.
	 */
	getXaiCacheKeepaliveTtlMinutes(): number {
		const fromEnv = process.env.CCFLARE_XAI_CACHE_KEEPALIVE_TTL_MINUTES;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 60);
		}
		const fromFile = this.data.xai_cache_keepalive_ttl_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 60);
		return 0; // default: disabled
	}

	setXaiCacheKeepaliveTtlMinutes(minutes: number): void {
		const clamped = this.clamp(minutes, 0, 60);
		this.set("xai_cache_keepalive_ttl_minutes", clamped);
	}

	/**
	 * Returns the persisted local-control secret, generating and persisting
	 * one on first access. Both the server (via AuthService) and the CLI
	 * (via this same Config, backed by the same on-disk config file) resolve
	 * to the identical value, so the CLI can authorize its own notify calls
	 * to its own locally-running server without ever handling a real API
	 * key (issue #216).
	 */
	getLocalControlSecret(): string {
		const existing = this.data.local_control_secret;
		if (typeof existing === "string" && existing.length > 0) {
			return existing;
		}

		// Re-check the on-disk file before generating a new secret: another
		// process (e.g. a CLI invocation racing the server's first-ever boot)
		// may have already generated and persisted one after this instance's
		// `this.data` was loaded into memory. Adopting that value instead of
		// overwriting it avoids the two processes permanently disagreeing on
		// the secret for the lifetime of this server process (see comment on
		// the local_control_secret field above).
		const fromDisk = this.readLocalControlSecretFromDisk();
		if (typeof fromDisk === "string" && fromDisk.length > 0) {
			this.data.local_control_secret = fromDisk;
			return fromDisk;
		}

		const secret = randomUUID();
		this.set("local_control_secret", secret);
		return secret;
	}

	/**
	 * Best-effort fresh read of just the local_control_secret field from the
	 * on-disk config file, bypassing the in-memory `this.data` snapshot.
	 * Mirrors the existsSync/readFileSync/JSON.parse pattern used by
	 * loadConfig(), but never mutates `this.data` or writes to disk itself —
	 * callers decide what to do with the result. Returns undefined on any
	 * read/parse failure (matching loadConfig()'s log-and-continue behavior).
	 */
	private readLocalControlSecretFromDisk(): string | undefined {
		if (!existsSync(this.configPath)) {
			return undefined;
		}
		try {
			const content = readFileSync(this.configPath, "utf8");
			const parsed = JSON.parse(content) as ConfigData;
			const value = parsed.local_control_secret;
			return typeof value === "string" && value.length > 0 ? value : undefined;
		} catch (error) {
			log.error(
				`Failed to re-read config file for local_control_secret: ${error}`,
			);
			return undefined;
		}
	}

	getSystemPromptCacheTtl1h(): boolean {
		const fromEnv = process.env.SYSTEM_PROMPT_CACHE_TTL_1H;
		if (fromEnv) {
			return fromEnv !== "false" && fromEnv !== "0";
		}
		const fromFile = this.data.system_prompt_cache_ttl_1h;
		if (typeof fromFile === "boolean") return fromFile;
		return false; // default: disabled
	}

	setSystemPromptCacheTtl1h(value: boolean): void {
		this.set("system_prompt_cache_ttl_1h", value);
	}

	getUsageThrottlingFiveHourEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.USAGE_THROTTLING_FIVE_HOUR_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.usage_throttling_five_hour_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	getUsageThrottlingWeeklyEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.USAGE_THROTTLING_WEEKLY_ENABLED,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.usage_throttling_weekly_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	/**
	 * Whether an agent's frontmatter `model` field should be used as a
	 * substitution fallback when no explicit DB preference is configured for
	 * that agent. Defaults to false: Claude Code already resolves frontmatter
	 * model aliases client-side, so the registry's copy of `agent.model` can
	 * go stale relative to what the client actually resolved and sent. With
	 * the flag off, only an explicit DB preference (set via the dashboard/CLI)
	 * triggers a rewrite; the frontmatter value is opt-in.
	 */
	getAgentFrontmatterModelFallback(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.AGENT_FRONTMATTER_MODEL_FALLBACK,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.agent_frontmatter_model_fallback;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	/**
	 * Whether the automatic (non-manual) model catalog refresh is allowed to
	 * fall back to an OAuth account when no eligible API-key account exists.
	 * Defaults to false: recurring background traffic — and the proactive
	 * OAuth token refreshes it can trigger — on a consumer OAuth account is an
	 * atypical automation pattern that risks an account flag/ban, whereas
	 * API-key accounts are the sanctioned programmatic surface. A manual,
	 * human-triggered refresh always allows the OAuth fallback regardless of
	 * this flag.
	 */
	getModelCatalogOAuthRefreshEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(
			process.env.BETTER_CCFLARE_MODELS_OAUTH_REFRESH,
		);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.model_catalog_oauth_refresh_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setUsageThrottlingFiveHourEnabled(value: boolean): void {
		this.set("usage_throttling_five_hour_enabled", value);
	}

	setUsageThrottlingWeeklyEnabled(value: boolean): void {
		this.set("usage_throttling_weekly_enabled", value);
	}

	/**
	 * Shared env > file > default precedence resolver: a valid environment
	 * value wins ("env"), else a valid config-file value ("file"), else
	 * `defaultValue` ("default"). Used by resolveStrategy() so getStrategy()
	 * and getStrategySource() can never drift, and is reusable for other
	 * env+file-backed string settings.
	 */
	private resolveEnvFileSetting<T extends string>(
		envValue: string | undefined,
		fileValue: T | undefined,
		isValid: (value: string) => value is T,
		defaultValue: T,
	): { value: T; source: "env" | "file" | "default" } {
		if (envValue !== undefined && isValid(envValue)) {
			return { value: envValue, source: "env" };
		}
		if (fileValue !== undefined && isValid(fileValue)) {
			return { value: fileValue, source: "file" };
		}
		return { value: defaultValue, source: "default" };
	}

	/**
	 * Resolve the effective load-balancing strategy plus its source, using the
	 * same env > file > default precedence getStrategy() has always used.
	 * Backs both getStrategy() and getStrategySource() so they cannot drift.
	 */
	private resolveStrategy(): {
		value: StrategyName;
		source: "env" | "file" | "default";
	} {
		return this.resolveEnvFileSetting(
			process.env.LB_STRATEGY,
			this.data.lb_strategy,
			isValidStrategy,
			DEFAULT_STRATEGY,
		);
	}

	getHealthDetailEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.HEALTH_DETAIL_ENABLED);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.health_detail_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	getAnthropicDegradedModeConfig(): AnthropicDegradedModeConfig {
		let invalidField: keyof AnthropicDegradedModeConfig | null = null;
		const resolved = resolveAnthropicDegradedModeConfig(
			{
				mode:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_MODE ??
					this.data.anthropic_degraded_mode,
				largeRequestTokenThreshold:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_LARGE_REQUEST_TOKENS ??
					this.data.anthropic_degraded_large_request_tokens,
				largeRequestByteThreshold:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_LARGE_REQUEST_BYTES ??
					this.data.anthropic_degraded_large_request_bytes,
				evidenceWindowMs:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_EVIDENCE_WINDOW_MS ??
					this.data.anthropic_degraded_evidence_window_ms,
				quorum:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_QUORUM ??
					this.data.anthropic_degraded_quorum,
				retryMinMs:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_RETRY_MIN_MS ??
					this.data.anthropic_degraded_retry_min_ms,
				retryFallbackMs:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_RETRY_FALLBACK_MS ??
					this.data.anthropic_degraded_retry_fallback_ms,
				retryMaxMs:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_RETRY_MAX_MS ??
					this.data.anthropic_degraded_retry_max_ms,
				recoveryWindowMs:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_RECOVERY_WINDOW_MS ??
					this.data.anthropic_degraded_recovery_window_ms,
				probeLeaseMs:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_PROBE_LEASE_MS ??
					this.data.anthropic_degraded_probe_lease_ms,
				maxCohorts:
					process.env.CCFLARE_ANTHROPIC_DEGRADED_MAX_COHORTS ??
					this.data.anthropic_degraded_max_cohorts,
			},
			(field) => {
				invalidField ??= field;
			},
		);
		if (invalidField !== null) {
			log.warn(
				`Invalid Anthropic degraded-mode setting "${invalidField}"; degraded mode is off until configuration is corrected and the process restarts`,
			);
		}
		return resolved;
	}

	/**
	 * Restart-scoped, host-log-only diagnostic detail. Malformed values fail
	 * closed so an operator typo cannot silently start emitting joinable events.
	 */
	getAnthropicDegradedDiagnosticsEnabled(): boolean {
		const fromEnv = process.env.CCFLARE_ANTHROPIC_DEGRADED_DIAGNOSTICS;
		const raw =
			fromEnv === undefined
				? this.data.anthropic_degraded_diagnostics_enabled
				: fromEnv;
		if (raw === undefined) return false;
		const resolved =
			fromEnv === undefined && typeof raw !== "boolean"
				? null
				: parseStrictBooleanFlag(raw);
		if (resolved !== null) return resolved;
		log.warn(
			"Invalid Anthropic degraded-mode diagnostics setting; detailed events remain off until configuration is corrected and the process restarts",
		);
		return false;
	}

	getAlertDailySpendUsd(): number {
		const fromEnv = process.env.ALERT_DAILY_SPEND_USD;
		if (fromEnv) {
			const n = Number.parseFloat(fromEnv);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000);
		}
		const fromFile = this.data.alert_daily_spend_usd;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 1_000_000);
		return 0;
	}

	setAlertDailySpendUsd(value: number): void {
		this.set("alert_daily_spend_usd", this.clamp(value, 0, 1_000_000));
	}

	getAlertTokensPerHour(): number {
		const fromEnv = process.env.ALERT_TOKENS_PER_HOUR;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000_000);
		}
		const fromFile = this.data.alert_tokens_per_hour;
		if (typeof fromFile === "number") {
			return this.clamp(fromFile, 0, 1_000_000_000);
		}
		return 0;
	}

	setAlertTokensPerHour(value: number): void {
		this.set("alert_tokens_per_hour", this.clamp(value, 0, 1_000_000_000));
	}

	getAlertRequestTokens(): number {
		const fromEnv = process.env.ALERT_REQUEST_TOKENS;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 1_000_000_000);
		}
		const fromFile = this.data.alert_request_tokens;
		if (typeof fromFile === "number") {
			return this.clamp(fromFile, 0, 1_000_000_000);
		}
		return 0;
	}

	setAlertRequestTokens(value: number): void {
		this.set("alert_request_tokens", this.clamp(value, 0, 1_000_000_000));
	}

	getAlertUsageWindowThresholdPercent(): number {
		const fromEnv = process.env.ALERT_USAGE_WINDOW_THRESHOLD_PERCENT;
		if (fromEnv) {
			const n = Number.parseFloat(fromEnv);
			if (!Number.isNaN(n)) return this.clamp(n, 0, 100);
		}
		const fromFile = this.data.alert_usage_window_threshold_percent;
		if (typeof fromFile === "number") return this.clamp(fromFile, 0, 100);
		return 90;
	}

	setAlertUsageWindowThresholdPercent(value: number): void {
		this.set("alert_usage_window_threshold_percent", this.clamp(value, 0, 100));
	}

	getAlertAnomalyEnabled(): boolean {
		const fromEnv = parseEnabledEnvFlag(process.env.ALERT_ANOMALY_ENABLED);
		if (fromEnv !== undefined) {
			return fromEnv;
		}
		const fromFile = this.data.alert_anomaly_enabled;
		if (typeof fromFile === "boolean") return fromFile;
		return false;
	}

	setAlertAnomalyEnabled(value: boolean): void {
		this.set("alert_anomaly_enabled", value);
	}

	getAlertAnomalyIntervalMinutes(): number {
		const fromEnv = process.env.ALERT_ANOMALY_INTERVAL_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 5, 1440);
		}
		const fromFile = this.data.alert_anomaly_interval_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 5, 1440);
		return 15;
	}

	setAlertAnomalyIntervalMinutes(value: number): void {
		this.set("alert_anomaly_interval_minutes", this.clamp(value, 5, 1440));
	}

	getAlertAnomalyLoopMinRequests(): number {
		const fromEnv = process.env.ALERT_ANOMALY_LOOP_MIN_REQUESTS;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 5, 1000);
		}
		const fromFile = this.data.alert_anomaly_loop_min_requests;
		if (typeof fromFile === "number") return this.clamp(fromFile, 5, 1000);
		// Default 25 — above the per-agent request rate we expect from any
		// single legitimate worker in a 5-minute window, while still well
		// below the rate a true runaway loop reaches (50+ req/min).
		return 25;
	}

	setAlertAnomalyLoopMinRequests(value: number): void {
		this.set("alert_anomaly_loop_min_requests", this.clamp(value, 5, 1000));
	}

	getAlertCooldownMinutes(): number {
		const fromEnv = process.env.ALERT_COOLDOWN_MINUTES;
		if (fromEnv) {
			const n = Number.parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 1440);
		}
		const fromFile = this.data.alert_cooldown_minutes;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 1440);
		return 60;
	}

	setAlertCooldownMinutes(value: number): void {
		this.set("alert_cooldown_minutes", this.clamp(value, 1, 1440));
	}

	getAlertWebhookUrl(): string {
		const fromEnv = process.env.ALERT_WEBHOOK_URL;
		if (fromEnv !== undefined) return fromEnv;
		const fromFile = this.data.alert_webhook_url;
		if (typeof fromFile === "string") return fromFile;
		return "";
	}

	setAlertWebhookUrl(value: string): void {
		if (value !== "") {
			let parsed: URL;
			try {
				parsed = new URL(value);
			} catch (_error) {
				throw new ValidationError(
					"Invalid alert webhook URL",
					"alert_webhook_url",
				);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				throw new ValidationError(
					"Invalid alert webhook URL",
					"alert_webhook_url",
				);
			}
		}
		this.set("alert_webhook_url", value);
	}

	getAllSettings(): Record<string, string | number | boolean | undefined> {
		const anthropicDegradedMode = this.getAnthropicDegradedModeConfig();
		// Include current strategy (which might come from env)
		return {
			...this.data,
			lb_strategy: this.getStrategy(),
			default_agent_model: this.getDefaultAgentModel(),
			data_retention_days: this.getDataRetentionDays(),
			request_retention_days: this.getRequestRetentionDays(),
			usage_history_retention_days: this.getUsageHistoryRetentionDays(),
			cache_flight_recorder_retention_hours:
				this.getCacheFlightRecorderRetentionHours(),
			store_payloads: this.getStorePayloads(),
			usage_poll_interval_ms: this.getUsagePollIntervalMs(),
			cache_keepalive_ttl_minutes: this.getCacheKeepaliveTtlMinutes(),
			xai_cache_keepalive_ttl_minutes: this.getXaiCacheKeepaliveTtlMinutes(),
			system_prompt_cache_ttl_1h: this.getSystemPromptCacheTtl1h(),
			usage_throttling_five_hour_enabled:
				this.getUsageThrottlingFiveHourEnabled(),
			usage_throttling_weekly_enabled: this.getUsageThrottlingWeeklyEnabled(),
			agent_frontmatter_model_fallback: this.getAgentFrontmatterModelFallback(),
			model_catalog_oauth_refresh_enabled:
				this.getModelCatalogOAuthRefreshEnabled(),
			health_detail_enabled: this.getHealthDetailEnabled(),
			anthropic_degraded_mode: anthropicDegradedMode.mode,
			anthropic_degraded_large_request_tokens:
				anthropicDegradedMode.largeRequestTokenThreshold,
			anthropic_degraded_large_request_bytes:
				anthropicDegradedMode.largeRequestByteThreshold,
			anthropic_degraded_evidence_window_ms:
				anthropicDegradedMode.evidenceWindowMs,
			anthropic_degraded_quorum: anthropicDegradedMode.quorum,
			anthropic_degraded_retry_min_ms: anthropicDegradedMode.retryMinMs,
			anthropic_degraded_retry_fallback_ms:
				anthropicDegradedMode.retryFallbackMs,
			anthropic_degraded_retry_max_ms: anthropicDegradedMode.retryMaxMs,
			anthropic_degraded_recovery_window_ms:
				anthropicDegradedMode.recoveryWindowMs,
			anthropic_degraded_probe_lease_ms: anthropicDegradedMode.probeLeaseMs,
			anthropic_degraded_max_cohorts: anthropicDegradedMode.maxCohorts,
			anthropic_degraded_diagnostics_enabled:
				this.getAnthropicDegradedDiagnosticsEnabled(),
			alert_daily_spend_usd: this.getAlertDailySpendUsd(),
			alert_tokens_per_hour: this.getAlertTokensPerHour(),
			alert_request_tokens: this.getAlertRequestTokens(),
			alert_usage_window_threshold_percent:
				this.getAlertUsageWindowThresholdPercent(),
			alert_anomaly_enabled: this.getAlertAnomalyEnabled(),
			alert_anomaly_interval_minutes: this.getAlertAnomalyIntervalMinutes(),
			alert_anomaly_loop_min_requests: this.getAlertAnomalyLoopMinRequests(),
			alert_cooldown_minutes: this.getAlertCooldownMinutes(),
			alert_webhook_url: this.getAlertWebhookUrl(),
		};
	}

	getRuntime(): RuntimeConfig {
		// Default values
		const defaults: RuntimeConfig = {
			clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			retry: {
				attempts: 3,
				delayMs: TIME_CONSTANTS.RETRY_DELAY_DEFAULT,
				backoff: 2,
			},
			sessionDurationMs: TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
			port: NETWORK.DEFAULT_PORT,
			database: {
				walMode: true,
				busyTimeoutMs: 5000,
				// 256 MiB (negative = KiB). Big enough to keep the hot B-tree
				// interior/overflow pages of large request tables resident. At 20
				// MiB, a random-UUID INSERT into a large table misses cache on
				// nearly every page -> synchronous disk reads, which the
				// AsyncDbWriter can't subdivide (one atomic db.run) -> event-loop
				// blips during write bursts. (Source: d4rken/clankermux@763ffa72)
				cacheSize: -262144, // 256MB cache
				synchronous: "NORMAL",
				mmapSize: 268435456, // 256MB
				retry: {
					attempts: 3,
					delayMs: 100,
					backoff: 2,
					maxDelayMs: 5000,
				},
			},
		};

		// Override with environment variables if present
		if (process.env.CLIENT_ID) {
			defaults.clientId = process.env.CLIENT_ID;
		}
		if (process.env.RETRY_ATTEMPTS) {
			defaults.retry.attempts = parseInt(process.env.RETRY_ATTEMPTS, 10);
		}
		if (process.env.RETRY_DELAY_MS) {
			defaults.retry.delayMs = parseInt(process.env.RETRY_DELAY_MS, 10);
		}
		if (process.env.RETRY_BACKOFF) {
			defaults.retry.backoff = parseFloat(process.env.RETRY_BACKOFF);
		}
		if (process.env.SESSION_DURATION_MS) {
			defaults.sessionDurationMs = parseInt(
				process.env.SESSION_DURATION_MS,
				10,
			);
		}
		if (process.env.PORT) {
			defaults.port = parseInt(process.env.PORT, 10);
		}

		// Override with config file settings if present
		if (this.data.client_id) {
			defaults.clientId = this.data.client_id;
		}
		if (typeof this.data.retry_attempts === "number") {
			defaults.retry.attempts = this.data.retry_attempts;
		}
		if (typeof this.data.retry_delay_ms === "number") {
			defaults.retry.delayMs = this.data.retry_delay_ms;
		}
		if (typeof this.data.retry_backoff === "number") {
			defaults.retry.backoff = this.data.retry_backoff;
		}
		if (typeof this.data.session_duration_ms === "number") {
			defaults.sessionDurationMs = this.data.session_duration_ms;
		}
		if (typeof this.data.port === "number") {
			defaults.port = this.data.port;
		}

		// Database configuration overrides
		// Ensure database configuration object exists
		if (!defaults.database) {
			defaults.database = {
				walMode: true,
				busyTimeoutMs: 5000,
				cacheSize: -262144, // 256MB cache -- see the getRuntime default above
				synchronous: "NORMAL",
				mmapSize: 268435456,
				retry: {
					attempts: 3,
					delayMs: 100,
					backoff: 2,
					maxDelayMs: 5000,
				},
			};
		}

		// Ensure retry configuration object exists
		if (!defaults.database.retry) {
			defaults.database.retry = {
				attempts: 3,
				delayMs: 100,
				backoff: 2,
				maxDelayMs: 5000,
			};
		}

		if (typeof this.data.db_wal_mode === "boolean") {
			defaults.database.walMode = this.data.db_wal_mode;
		}
		if (typeof this.data.db_busy_timeout_ms === "number") {
			defaults.database.busyTimeoutMs = this.data.db_busy_timeout_ms;
		}
		if (typeof this.data.db_cache_size === "number") {
			defaults.database.cacheSize = this.data.db_cache_size;
		}
		if (typeof this.data.db_synchronous === "string") {
			defaults.database.synchronous = this.data.db_synchronous as
				| "OFF"
				| "NORMAL"
				| "FULL";
		}
		if (typeof this.data.db_mmap_size === "number") {
			defaults.database.mmapSize = this.data.db_mmap_size;
		}
		// Page size: default 2048 (2KB) for better memory efficiency, recommend 4096 (4KB)
		if (typeof this.data.db_page_size === "number") {
			defaults.database.pageSize = this.data.db_page_size;
		} else {
			defaults.database.pageSize = 2048;
		}
		if (typeof this.data.db_retry_attempts === "number") {
			defaults.database.retry.attempts = this.data.db_retry_attempts;
		}
		if (typeof this.data.db_retry_delay_ms === "number") {
			defaults.database.retry.delayMs = this.data.db_retry_delay_ms;
		}
		if (typeof this.data.db_retry_backoff === "number") {
			defaults.database.retry.backoff = this.data.db_retry_backoff;
		}
		if (typeof this.data.db_retry_max_delay_ms === "number") {
			defaults.database.retry.maxDelayMs = this.data.db_retry_max_delay_ms;
		}

		// Validate the final database configuration
		try {
			validateDatabaseConfig(defaults.database);
		} catch (error) {
			if (error instanceof ValidationError) {
				log.error(`Database configuration validation failed: ${error.message}`);
				throw error;
			}
			throw error;
		}

		return defaults;
	}
}

// Re-export types
export type { StrategyName } from "@better-ccflare/core";
export { resolveConfigPath } from "./paths";
export { getLegacyConfigDir, getPlatformConfigDir } from "./paths-common";
