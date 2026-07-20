import { Buffer } from "node:buffer";
import { createHmac, type Hmac, randomBytes } from "node:crypto";

/**
 * Process-local secret for operational identifiers. A keyed digest prevents
 * low-entropy session IDs from being recovered with an offline dictionary.
 * The secret and resulting IDs intentionally rotate on every process start.
 */
const PROCESS_ID_SECRET = randomBytes(32);
const FRAME_DOMAIN = "better-ccflare/opaque-runtime-id/v1";

function updateLength(digest: Hmac, length: number): void {
	const frame = Buffer.allocUnsafe(4);
	frame.writeUInt32BE(length);
	digest.update(frame);
}

function updateString(digest: Hmac, value: string): void {
	const bytes = Buffer.from(value, "utf8");
	updateLength(digest, bytes.byteLength);
	digest.update(bytes);
}

/** Build a stable-within-process identifier without retaining its raw parts. */
export function opaqueRuntimeId(
	namespace: string,
	...parts: Array<string | null | undefined>
): string {
	const digest = createHmac("sha256", PROCESS_ID_SECRET);
	digest.update(FRAME_DOMAIN);
	updateString(digest, namespace);
	updateLength(digest, parts.length);
	for (const part of parts) {
		if (part === null) {
			digest.update(Uint8Array.of(0));
			continue;
		}
		if (part === undefined) {
			digest.update(Uint8Array.of(1));
			continue;
		}
		digest.update(Uint8Array.of(2));
		updateString(digest, part);
	}
	return `${namespace}_${digest.digest("hex")}`;
}
