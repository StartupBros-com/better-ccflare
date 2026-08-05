import { AsyncLocalStorage } from "node:async_hooks";
import {
	deriveServerToolRequirement,
	type WebSearchServerToolDeclaration,
} from "../packages/providers/src/server-tool-capabilities";
import {
	createServerToolCharacterizationContext,
	type ServerToolCharacterizationKind,
	type ServerToolCharacterizationObserver,
} from "../packages/providers/src/providers/codex/server-tool-characterization";

const MARKER_TOOL_NAME =
	"__better_ccflare_characterization_marker_web_search_20250305__";
const SOURCE_INCLUDE = "web_search_call.action.sources" as const;

type UnknownRecord = Record<string, unknown>;

interface TransformingProvider {
	transformRequestBody(request: Request, account?: unknown): Promise<Request>;
}

export type CharacterizationCodexProviderConstructor<T extends object = object> =
	new (options: {
		characterizationObserver: ServerToolCharacterizationObserver;
		characterizationObservationGate?: (
			kind: ServerToolCharacterizationKind,
		) => boolean;
	}) => T;

interface CharacterizationCandidate {
	readonly body: UnknownRecord;
	readonly declaration: WebSearchServerToolDeclaration;
	readonly serverToolIndex: number;
	readonly tools: readonly UnknownRecord[];
}

export class CharacterizationRequestRejectedError extends Error {
	constructor() {
		super("Codex server-tool characterization request rejected");
		this.name = "CharacterizationRequestRejectedError";
	}
}

function rejected(): CharacterizationRequestRejectedError {
	return new CharacterizationRequestRejectedError();
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonMediaType(contentType: string | null): boolean {
	return (
		contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
	);
}

function hasTypedTool(tools: readonly unknown[]): boolean {
	return tools.some((tool) => isRecord(tool) && hasOwn(tool, "type"));
}

function isClientFunction(tool: UnknownRecord): boolean {
	return (
		!hasOwn(tool, "type") &&
		typeof tool.name === "string" &&
		tool.name.length > 0 &&
		isRecord(tool.input_schema)
	);
}

function inspectCandidate(body: unknown): CharacterizationCandidate | undefined {
	if (!isRecord(body)) return undefined;
	if (!Array.isArray(body.tools)) {
		if (isRecord(body.tools) && hasOwn(body.tools, "type")) throw rejected();
		return undefined;
	}
	if (!hasTypedTool(body.tools)) return undefined;

	const requirement = deriveServerToolRequirement(body);
	if (
		!requirement ||
		requirement.invalid !== undefined ||
		requirement.unsupported !== undefined ||
		requirement.declarations?.length !== 1 ||
		requirement.replay.input.length > 0 ||
		requirement.replay.output.length > 0
	) {
		throw rejected();
	}

	const tools: UnknownRecord[] = [];
	let serverToolIndex = -1;
	for (let index = 0; index < body.tools.length; index += 1) {
		const tool = body.tools[index];
		if (!isRecord(tool)) throw rejected();
		tools.push(tool);
		if (hasOwn(tool, "type")) {
			if (tool.type !== "web_search_20250305" || serverToolIndex !== -1) {
				throw rejected();
			}
			serverToolIndex = index;
			continue;
		}
		if (!isClientFunction(tool) || tool.name === MARKER_TOOL_NAME) {
			throw rejected();
		}
	}
	if (serverToolIndex === -1) throw rejected();
	if (
		hasOwn(body, "include") ||
		hasOwn(body, "max_tool_calls") ||
		hasOwn(body, "parallel_tool_calls")
	) {
		throw rejected();
	}

	return {
		body,
		declaration: requirement.declarations[0]!,
		serverToolIndex,
		tools,
	};
}

function markerTool(): UnknownRecord {
	return {
		name: MARKER_TOOL_NAME,
		description: "Characterization-only native WebSearch marker",
		input_schema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	};
}

function requestWithBody(request: Request, body: UnknownRecord): Request {
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.set("content-type", "application/json");
	return new Request(request.url, {
		method: request.method,
		headers,
		body: JSON.stringify(body),
	});
}

function markerRequest(
	request: Request,
	candidate: CharacterizationCandidate,
): Request {
	const tools = candidate.tools.map((tool, index) =>
		index === candidate.serverToolIndex ? markerTool() : tool,
	);
	return requestWithBody(request, { ...candidate.body, tools });
}

function nativeTool(
	declaration: WebSearchServerToolDeclaration,
): UnknownRecord {
	const tool: UnknownRecord = { type: "web_search" };
	if (declaration.allowedDomains) {
		tool.filters = { allowed_domains: [...declaration.allowedDomains] };
	} else if (declaration.blockedDomains) {
		tool.filters = { blocked_domains: [...declaration.blockedDomains] };
	}
	if (declaration.userLocation) {
		tool.user_location = { ...declaration.userLocation };
	}
	return tool;
}

function finalizeCandidateBody(
	transformedBody: unknown,
	declaration: WebSearchServerToolDeclaration,
): UnknownRecord {
	if (
		!isRecord(transformedBody) ||
		transformedBody.stream !== true ||
		transformedBody.store !== false ||
		!Array.isArray(transformedBody.input) ||
		!Array.isArray(transformedBody.tools) ||
		hasOwn(transformedBody, "include") ||
		hasOwn(transformedBody, "max_tool_calls")
	) {
		throw rejected();
	}

	let markerCount = 0;
	const tools = transformedBody.tools.map((tool) => {
		if (!isRecord(tool)) throw rejected();
		if (tool.name !== MARKER_TOOL_NAME) {
			if (tool.type !== "function" || typeof tool.name !== "string") {
				throw rejected();
			}
			return tool;
		}
		if (tool.type !== "function") throw rejected();
		markerCount += 1;
		return nativeTool(declaration);
	});
	if (markerCount !== 1) throw rejected();

	const finalBody: UnknownRecord = {
		...transformedBody,
		tools,
		include: [SOURCE_INCLUDE],
	};
	if (declaration.maxUses !== undefined) {
		finalBody.max_tool_calls = declaration.maxUses;
	}
	return finalBody;
}

/**
 * Build the exact-ACK preload's private characterization provider. This module
 * is intentionally script-local and is not exported by the providers package.
 */
export function createCodexCharacterizationProvider<T extends object>(
	Provider: CharacterizationCodexProviderConstructor<T>,
	observer: ServerToolCharacterizationObserver,
): T {
	const outboundSuppression = new AsyncLocalStorage<boolean>();
	const finalObservation = createServerToolCharacterizationContext();
	const ProviderBase = Provider as unknown as CharacterizationCodexProviderConstructor<TransformingProvider>;

	class CharacterizationCodexProvider extends ProviderBase {
		constructor() {
			super({
				characterizationObserver: observer,
				characterizationObservationGate: (kind) =>
					!(
						kind === "outbound_request" &&
						outboundSuppression.getStore() === true
					),
			});
		}

		override async transformRequestBody(
			request: Request,
			account?: unknown,
		): Promise<Request> {
			if (!isJsonMediaType(request.headers.get("content-type"))) {
				return super.transformRequestBody(request, account);
			}
			let sourceBody: unknown;
			try {
				sourceBody = await request.clone().json();
			} catch {
				if (request.method === "POST") throw rejected();
				return super.transformRequestBody(request, account);
			}
			const candidate = inspectCandidate(sourceBody);
			if (!candidate) return super.transformRequestBody(request, account);
			if (request.method !== "POST") throw rejected();

			let transformed: Request;
			try {
				transformed = await outboundSuppression.run(true, () =>
					super.transformRequestBody(markerRequest(request, candidate), account),
				);
			} catch {
				throw rejected();
			}

			let transformedBody: unknown;
			try {
				transformedBody = await transformed.clone().json();
			} catch {
				throw rejected();
			}
			const finalBody = finalizeCandidateBody(
				transformedBody,
				candidate.declaration,
			);
			const finalRequest = requestWithBody(transformed, finalBody);
			finalObservation.emit(observer, "outbound_request", finalBody);
			return finalRequest;
		}
	}

	return new CharacterizationCodexProvider() as T;
}
