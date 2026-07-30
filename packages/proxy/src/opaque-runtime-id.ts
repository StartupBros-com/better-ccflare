import { Buffer } from "node:buffer";
import { createHmac, type Hmac, randomBytes } from "node:crypto";

export const OPAQUE_RUNTIME_ID_DOMAINS = Object.freeze([
	"boot",
	"logical_request",
	"physical_attempt",
	"account",
	"candidate",
	"lane",
	"cohort",
	"owner",
] as const);

export type OpaqueRuntimeIdDomain = (typeof OPAQUE_RUNTIME_ID_DOMAINS)[number];
const OPAQUE_RUNTIME_ID_DOMAIN_SET: ReadonlySet<string> = new Set(
	OPAQUE_RUNTIME_ID_DOMAINS,
);

declare const opaqueRuntimeIdBrand: unique symbol;
export type OpaqueRuntimeId<
	Domain extends OpaqueRuntimeIdDomain = OpaqueRuntimeIdDomain,
> = string & {
	readonly [opaqueRuntimeIdBrand]: Domain;
};

export interface OpaqueRuntimeIdFactory {
	readonly bootId: OpaqueRuntimeId<"boot">;
	id<Domain extends OpaqueRuntimeIdDomain>(
		domain: Domain,
		...parts: Array<string | null | undefined>
	): OpaqueRuntimeId<Domain>;
}

export interface OpaqueRuntimeIdFactoryOptions {
	/** At least 256 bits of restart-scoped secret key material. */
	secret?: Uint8Array;
	/** At least 128 bits of independently generated restart-scoped nonce. */
	bootNonce?: Uint8Array;
}

/**
 * Process-local secret for operational identifiers. A keyed digest prevents
 * low-entropy session IDs from being recovered with an offline dictionary.
 * The secret and resulting IDs intentionally rotate on every process start.
 */
const PROCESS_ID_SECRET = randomBytes(32);
const PROCESS_BOOT_NONCE = randomBytes(32);
const FRAME_DOMAIN = "better-ccflare/opaque-runtime-id/v1";
const EXPLICIT_FRAME_DOMAIN = "better-ccflare/opaque-runtime-id/v2";

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

class RestartScopedOpaqueRuntimeIdFactory implements OpaqueRuntimeIdFactory {
	private readonly secret: Buffer;
	private readonly bootNonce: Buffer;
	readonly bootId: OpaqueRuntimeId<"boot">;

	constructor(options: OpaqueRuntimeIdFactoryOptions = {}) {
		const secret = options.secret ?? randomBytes(32);
		const bootNonce = options.bootNonce ?? randomBytes(32);
		if (secret.byteLength < 32) {
			throw new RangeError(
				"opaque runtime ID secret must be at least 32 bytes",
			);
		}
		if (bootNonce.byteLength < 16) {
			throw new RangeError(
				"opaque runtime boot nonce must be at least 16 bytes",
			);
		}
		this.secret = Buffer.from(secret);
		this.bootNonce = Buffer.from(bootNonce);
		this.bootId = this.id("boot", "runtime");
	}

	id<Domain extends OpaqueRuntimeIdDomain>(
		domain: Domain,
		...parts: Array<string | null | undefined>
	): OpaqueRuntimeId<Domain> {
		if (!OPAQUE_RUNTIME_ID_DOMAIN_SET.has(domain)) {
			throw new RangeError("unknown opaque runtime ID domain");
		}
		const digest = createHmac("sha256", this.secret);
		digest.update(EXPLICIT_FRAME_DOMAIN);
		updateLength(digest, this.bootNonce.byteLength);
		digest.update(this.bootNonce);
		updateString(digest, domain);
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
		return `or1_${domain}_${digest.digest("base64url")}` as OpaqueRuntimeId<Domain>;
	}
}

/** Create one restart-scoped, domain-separated pseudonym factory. */
export function createOpaqueRuntimeIdFactory(
	options: OpaqueRuntimeIdFactoryOptions = {},
): OpaqueRuntimeIdFactory {
	return new RestartScopedOpaqueRuntimeIdFactory(options);
}

/** Default process-local factory for callers that do not inject a runtime. */
export const processOpaqueRuntimeIdFactory = createOpaqueRuntimeIdFactory({
	secret: PROCESS_ID_SECRET,
	bootNonce: PROCESS_BOOT_NONCE,
});

/** Build a stable-within-process identifier without retaining its raw parts. */
export function opaqueRuntimeId(
	namespace: string,
	...parts: Array<string | null | undefined>
): string {
	const digest = createHmac("sha256", PROCESS_ID_SECRET);
	digest.update(FRAME_DOMAIN);
	updateLength(digest, PROCESS_BOOT_NONCE.byteLength);
	digest.update(PROCESS_BOOT_NONCE);
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
