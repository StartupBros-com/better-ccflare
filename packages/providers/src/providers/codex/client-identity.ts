import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Compatibility constants remain stable even when the effective identity advances. */
export const CODEX_VERSION = "0.156.0";
export const CODEX_USER_AGENT = `codex-cli/${CODEX_VERSION} (Windows 10.0.26100; x64)`;
export const CODEX_CLIENT_VERSION_ENV = "CCFLARE_CODEX_CLIENT_VERSION";
export const CODEX_VERIFIED_VERSION_FILE_ENV =
	"CCFLARE_CODEX_VERIFIED_VERSION_FILE";

export interface CodexClientIdentity {
	readonly version: string;
	readonly userAgent: string;
	readonly catalogUserAgent: string;
	readonly source: "explicit" | "verified" | "default";
	/** True only when the current verified record is within its freshness window. */
	readonly fresh: boolean;
	readonly verifiedAt?: string;
	/** Safe machine-readable status; never includes the path or file contents. */
	readonly error?:
		| "invalid_explicit"
		| "invalid_path"
		| "invalid_record"
		| "unavailable_record"
		| "stale_record";
}

const VERSION_PATTERN =
	/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_RECORD_BYTES = 4096;
const MAX_SOURCE_PATH_LENGTH = 4096;
const MAX_CACHED_SOURCES = 8;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const READ_CACHE_MS = 1_000;
type VerifiedRecord = { version: string; verifiedAt: string };
const lastValidBySource = new Map<string, VerifiedRecord>();
const readCache = new Map<
	string,
	{ until: number; signature: string; result: VerifiedRecord }
>();

function recordStatus(
	record: VerifiedRecord,
	now: number,
): "fresh" | "stale" | "future" {
	const age = now - Date.parse(record.verifiedAt);
	if (age < -MAX_FUTURE_SKEW_MS) return "future";
	return age > MAX_RECORD_AGE_MS ? "stale" : "fresh";
}

/** Parse one already-open regular descriptor, never a separately stat'ed path. */
function readVerifiedRecord(
	fd: number,
	size: number,
	now: number,
): VerifiedRecord {
	const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
	let length = 0;
	while (length < buffer.length) {
		const bytes = readSync(fd, buffer, length, buffer.length - length, null);
		if (bytes === 0) break;
		length += bytes;
	}
	if (length > MAX_RECORD_BYTES || length !== size)
		throw new Error("record changed during read");
	const record: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(
			buffer.subarray(0, length),
		),
	);
	if (!record || typeof record !== "object" || Array.isArray(record))
		throw new Error("invalid record");
	const value = record as Record<string, unknown>;
	if (
		value.schemaVersion !== 1 ||
		value.packageName !== "@openai/codex" ||
		typeof value.version !== "string" ||
		!VERSION_PATTERN.test(value.version) ||
		typeof value.verifiedAt !== "string" ||
		!UTC_PATTERN.test(value.verifiedAt) ||
		!Number.isFinite(Date.parse(value.verifiedAt)) ||
		new Date(value.verifiedAt).toISOString() !==
			value.verifiedAt.replace(
				/(?:\.(\d{1,3}))?Z$/,
				(_, digits: string | undefined) => `.${(digits ?? "").padEnd(3, "0")}Z`,
			) ||
		recordStatus(
			{ version: value.version, verifiedAt: value.verifiedAt },
			now,
		) === "future"
	)
		throw new Error("invalid record fields");
	return { version: value.version, verifiedAt: value.verifiedAt };
}

function snapshot(
	version: string,
	source: CodexClientIdentity["source"],
	fresh: boolean,
	verifiedAt?: string,
	error?: CodexClientIdentity["error"],
): CodexClientIdentity {
	return Object.freeze({
		version,
		userAgent: `codex-cli/${version} (Windows 10.0.26100; x64)`,
		catalogUserAgent: `codex_cli_rs/${version}`,
		source,
		fresh,
		...(verifiedAt ? { verifiedAt } : {}),
		...(error ? { error } : {}),
	});
}

/** Explicit nonexecuting source; a broken replacement keeps only this path's last valid record. */
export function resolveCodexClientIdentity(
	now: () => number = Date.now,
): CodexClientIdentity {
	const explicit = process.env[CODEX_CLIENT_VERSION_ENV];
	if (explicit && VERSION_PATTERN.test(explicit)) {
		return snapshot(explicit, "explicit", true);
	}
	let error: CodexClientIdentity["error"] | undefined = explicit
		? "invalid_explicit"
		: undefined;
	const source = process.env[CODEX_VERIFIED_VERSION_FILE_ENV];
	if (source) {
		if (source.length > MAX_SOURCE_PATH_LENGTH || !source.startsWith("/")) {
			error = "invalid_path";
		} else {
			try {
				// NONBLOCK prevents FIFO hangs, NOFOLLOW rejects symlinks; fstat and
				// bounded reads use the same descriptor even during atomic replacement.
				const fd = openSync(
					source,
					constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
				);
				let record: VerifiedRecord;
				try {
					const stats = fstatSync(fd, { bigint: true });
					if (
						!stats.isFile() ||
						stats.size < 1n ||
						stats.size > BigInt(MAX_RECORD_BYTES)
					)
						throw new Error("invalid record size or type");
					const signature = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
					const cached = readCache.get(source);
					const time = now();
					if (
						cached &&
						time < cached.until &&
						time >= cached.until - READ_CACHE_MS &&
						time - Number(stats.mtimeMs) >= READ_CACHE_MS &&
						cached.signature === signature
					) {
						record = cached.result;
					} else {
						record = readVerifiedRecord(fd, Number(stats.size), time);
						readCache.delete(source);
						readCache.set(source, {
							until: time + READ_CACHE_MS,
							signature,
							result: record,
						});
					}
				} finally {
					closeSync(fd);
				}
				const status = recordStatus(record, now());
				if (status === "future")
					throw new Error("record time is in the future");
				if (
					!lastValidBySource.has(source) &&
					lastValidBySource.size >= MAX_CACHED_SOURCES
				) {
					const oldest = lastValidBySource.keys().next().value;
					if (oldest) {
						lastValidBySource.delete(oldest);
						readCache.delete(oldest);
					}
				}
				lastValidBySource.delete(source);
				lastValidBySource.set(source, record);
				while (readCache.size > MAX_CACHED_SOURCES) {
					const oldest = readCache.keys().next().value;
					if (oldest) readCache.delete(oldest);
				}
				return snapshot(
					record.version,
					"verified",
					status === "fresh",
					record.verifiedAt,
					status === "stale" ? "stale_record" : error,
				);
			} catch (cause) {
				readCache.delete(source);
				error =
					cause instanceof Error && "code" in cause && cause.code === "ENOENT"
						? "unavailable_record"
						: "invalid_record";
				const last = lastValidBySource.get(source);
				if (last)
					return snapshot(
						last.version,
						"verified",
						false,
						last.verifiedAt,
						error,
					);
			}
		}
	}
	return snapshot(CODEX_VERSION, "default", false, undefined, error);
}
