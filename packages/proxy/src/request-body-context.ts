import { deriveServerToolRequirement } from "@better-ccflare/providers/server-tool-capabilities";
import type { ServerToolRequirements } from "@better-ccflare/types";

export type RequestJsonBody = Record<string, unknown>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function encodeJson(body: RequestJsonBody): ArrayBuffer {
	const encoded = encoder.encode(JSON.stringify(body));
	// .buffer may be shared/oversized in some runtimes; slice to exact range
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Freeze only the layers whose identity or top-level fields are inspected by
 * server-tool requirement derivation. Opaque schemas and provider payloads
 * nested below those blocks deliberately remain outside this boundary.
 */
function freezeServerToolSemanticLayers(body: RequestJsonBody): void {
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (!isRecord(tool)) continue;
			if (Array.isArray(tool.allowed_domains)) {
				Object.freeze(tool.allowed_domains);
			}
			if (Array.isArray(tool.blocked_domains)) {
				Object.freeze(tool.blocked_domains);
			}
			if (isRecord(tool.user_location)) {
				Object.freeze(tool.user_location);
			}
			Object.freeze(tool);
		}
		Object.freeze(body.tools);
	}

	if (isRecord(body.tool_choice)) {
		Object.freeze(body.tool_choice);
	}

	if (Array.isArray(body.messages)) {
		for (const message of body.messages) {
			if (!isRecord(message)) continue;
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (isRecord(block)) Object.freeze(block);
				}
				Object.freeze(message.content);
			}
			Object.freeze(message);
		}
		Object.freeze(body.messages);
	}

	Object.freeze(body);
}

export class RequestBodyContext {
	readonly originalBuffer: ArrayBuffer | null;

	private currentBuffer: ArrayBuffer | null;
	private parsedBody: RequestJsonBody | null = null;
	private parseAttempted = false;
	private parseFailed = false;
	private dirty = false;
	private serverToolRequirementsFinalized = false;
	private serverToolRequirements: ServerToolRequirements | undefined;

	private assertServerToolRequirementsMutable(): void {
		if (this.serverToolRequirementsFinalized) {
			throw new Error(
				"RequestBodyContext server-tool requirements are finalized",
			);
		}
	}

	constructor(buffer: ArrayBuffer | null) {
		this.originalBuffer = buffer;
		this.currentBuffer = buffer;
	}

	static fromParsed(
		originalBuffer: ArrayBuffer | null,
		body: RequestJsonBody,
	): RequestBodyContext {
		const context = new RequestBodyContext(originalBuffer);
		context.parsedBody = body;
		context.parseAttempted = true;
		context.parseFailed = false;
		context.markDirty();
		return context;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	get hasParseFailed(): boolean {
		this.getParsedJson();
		return this.parseFailed;
	}

	getParsedJson(): Readonly<RequestJsonBody> | null {
		if (this.parseAttempted) {
			return this.parsedBody;
		}

		this.parseAttempted = true;
		if (!this.currentBuffer) {
			return null;
		}

		try {
			const parsed = JSON.parse(decoder.decode(this.currentBuffer));
			if (typeof parsed !== "object" || parsed === null) {
				this.parseFailed = true;
				return null;
			}
			this.parsedBody = parsed as RequestJsonBody;
			return this.parsedBody;
		} catch {
			this.parseFailed = true;
			return null;
		}
	}

	/** Best-effort client/session id from metadata.user_id. Telemetry/routing only. */
	getClientId(): string | null {
		const body = this.getParsedJson();
		const meta = body?.metadata;
		if (meta && typeof meta === "object") {
			const uid = (meta as Record<string, unknown>).user_id;
			if (typeof uid === "string" && uid.length > 0) return uid;
		}
		return null;
	}

	getModel(): string | null {
		const body = this.getParsedJson();
		const model = body?.model;
		return typeof model === "string" ? model : null;
	}

	/**
	 * Derive capability metadata once from this context's already-cached final
	 * parsed body. Callers must invoke this only after all interception is done.
	 */
	finalizeServerToolRequirements(): ServerToolRequirements | undefined {
		if (this.serverToolRequirementsFinalized) {
			return this.serverToolRequirements;
		}
		const parsedBody = this.getParsedJson();
		if (parsedBody) {
			freezeServerToolSemanticLayers(parsedBody as RequestJsonBody);
		}
		this.serverToolRequirements = deriveServerToolRequirement(parsedBody);
		this.serverToolRequirementsFinalized = true;
		return this.serverToolRequirements;
	}

	setModel(model: string): boolean {
		this.assertServerToolRequirementsMutable();
		if (!this.parsedBody) {
			this.getParsedJson();
		}
		if (!this.parsedBody) return false;

		this.parsedBody.model = model;
		this.markDirty();
		return true;
	}

	/** Mutate the parsed body in-place via callback and mark dirty. */
	mutateParsedJson(fn: (body: RequestJsonBody) => void): boolean {
		this.assertServerToolRequirementsMutable();
		const body =
			this.parsedBody ?? (this.getParsedJson() as RequestJsonBody | null);
		if (!body) return false;
		fn(body);
		this.markDirty();
		return true;
	}

	markDirty(): void {
		this.assertServerToolRequirementsMutable();
		this.dirty = true;
	}

	getBuffer(): ArrayBuffer | null {
		if (!this.dirty) {
			return this.currentBuffer;
		}

		if (!this.parsedBody) {
			return this.currentBuffer;
		}

		this.currentBuffer = encodeJson(this.parsedBody);
		this.dirty = false;
		return this.currentBuffer;
	}

	// NOTE: shallow spread — nested objects (e.g. messages, system) are shared
	// references between parent and child contexts. Mutations to nested content
	// on the returned context will alias back into this context's parsedBody.
	// Safe as long as callers treat the child as write-once and discard the parent.
	withPatchedModel(model: string): RequestBodyContext | null {
		const body = this.getParsedJson();
		if (!body) return null;

		return RequestBodyContext.fromParsed(this.getBuffer(), {
			...body,
			model,
		});
	}
}
