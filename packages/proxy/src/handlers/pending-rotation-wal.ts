import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	PendingRotation,
	PendingRotationPersistence,
} from "./pending-rotation-registry";

const WAL_VERSION = 1;
const IV_BYTES = 12;
const WAL_PREFIX = "pending-rotation-";
const WAL_SUFFIX = ".wal";
const HEX_SHA256 = /^[0-9a-f]{64}$/;

interface PendingRotationWalEnvelope {
	version: 1;
	iv: string;
	ciphertext: string;
}

export interface PendingRotationWalOptions {
	directory: string;
	secret: string;
}

function accountDigest(accountId: string): string {
	return createHash("sha256").update(accountId).digest("hex");
}

function fileNameForAccount(accountId: string): string {
	return `${WAL_PREFIX}${accountDigest(accountId)}${WAL_SUFFIX}`;
}

function parseFileDigest(fileName: string): string | null {
	if (!fileName.startsWith(WAL_PREFIX) || !fileName.endsWith(WAL_SUFFIX)) {
		return null;
	}
	const digest = fileName.slice(WAL_PREFIX.length, -WAL_SUFFIX.length);
	return HEX_SHA256.test(digest) ? digest : null;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("pending rotation WAL secret is empty");
	const raw = new Uint8Array(
		createHash("sha256")
			.update("better-ccflare/pending-rotation-wal/v1\0")
			.update(secret)
			.digest(),
	);
	const buffer = new ArrayBuffer(raw.byteLength);
	new Uint8Array(buffer).set(raw);
	return crypto.subtle.importKey("raw", buffer, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

async function encryptEntry(
	key: CryptoKey,
	accountId: string,
	rotation: PendingRotation,
): Promise<PendingRotationWalEnvelope> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const plaintext = new TextEncoder().encode(
		JSON.stringify({ accountId, rotation }),
	);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		plaintext,
	);
	return {
		version: WAL_VERSION,
		iv: Buffer.from(iv).toString("base64"),
		ciphertext: Buffer.from(ciphertext).toString("base64"),
	};
}

function assertPendingRotation(value: unknown): PendingRotation {
	if (!value || typeof value !== "object") {
		throw new Error("invalid pending rotation WAL payload");
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.accessToken !== "string" ||
		typeof candidate.expiresAt !== "number" ||
		(candidate.refreshToken !== undefined &&
			typeof candidate.refreshToken !== "string") ||
		typeof candidate.attemptedRefreshToken !== "string" ||
		typeof candidate.recordedAt !== "number"
	) {
		throw new Error("invalid pending rotation WAL payload");
	}
	return candidate as unknown as PendingRotation;
}

async function decryptEntry(
	key: CryptoKey,
	fileName: string,
	stored: string,
): Promise<{ accountId: string; rotation: PendingRotation }> {
	const envelope = JSON.parse(stored) as Partial<PendingRotationWalEnvelope>;
	if (
		envelope.version !== WAL_VERSION ||
		typeof envelope.iv !== "string" ||
		typeof envelope.ciphertext !== "string"
	) {
		throw new Error("invalid pending rotation WAL envelope");
	}
	const iv = new Uint8Array(Buffer.from(envelope.iv, "base64"));
	if (iv.byteLength !== IV_BYTES) {
		throw new Error("invalid pending rotation WAL IV");
	}
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		new Uint8Array(Buffer.from(envelope.ciphertext, "base64")),
	);
	const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as {
		accountId?: unknown;
		rotation?: unknown;
	};
	if (typeof parsed.accountId !== "string") {
		throw new Error("invalid pending rotation WAL account id");
	}
	const digest = parseFileDigest(fileName);
	if (digest !== accountDigest(parsed.accountId)) {
		throw new Error("pending rotation WAL filename does not match account id");
	}
	return {
		accountId: parsed.accountId,
		rotation: assertPendingRotation(parsed.rotation),
	};
}

export function createPendingRotationWal(
	options: PendingRotationWalOptions,
): PendingRotationPersistence {
	mkdirSync(options.directory, { recursive: true, mode: 0o700 });
	chmodSync(options.directory, 0o700);
	const keyPromise = deriveKey(options.secret);

	return {
		async save(accountId, rotation): Promise<void> {
			const fileName = fileNameForAccount(accountId);
			const path = join(options.directory, fileName);
			const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
			const envelope = await encryptEntry(
				await keyPromise,
				accountId,
				rotation,
			);
			try {
				writeFileSync(tempPath, JSON.stringify(envelope), { mode: 0o600 });
				chmodSync(tempPath, 0o600);
				const tempFd = openSync(tempPath, "r");
				try {
					fsyncSync(tempFd);
				} finally {
					closeSync(tempFd);
				}
				renameSync(tempPath, path);
				chmodSync(path, 0o600);
				const directoryFd = openSync(options.directory, "r");
				try {
					fsyncSync(directoryFd);
				} finally {
					closeSync(directoryFd);
				}
			} finally {
				rmSync(tempPath, { force: true });
			}
		},

		async load(): Promise<
			Array<{ accountId: string; rotation: PendingRotation }>
		> {
			const key = await keyPromise;
			const entries = [];
			for (const fileName of readdirSync(options.directory).sort()) {
				if (parseFileDigest(fileName) === null) continue;
				entries.push(
					await decryptEntry(
						key,
						fileName,
						readFileSync(join(options.directory, fileName), "utf8"),
					),
				);
			}
			return entries;
		},

		async remove(accountId): Promise<void> {
			rmSync(join(options.directory, fileNameForAccount(accountId)), {
				force: true,
			});
			const directoryFd = openSync(options.directory, "r");
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
		},
	};
}
