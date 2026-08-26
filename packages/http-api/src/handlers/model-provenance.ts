import type { EventEmitter } from "node:events";
import { type RequestEvt, requestEvents } from "@better-ccflare/core";
import { jsonResponse } from "@better-ccflare/http-common";
import type {
	ModelProvenanceResponse,
	RequestResponse,
} from "@better-ccflare/types";

const DEFAULT_MAX_ENTRIES = 512;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type RequestEventSource = Pick<EventEmitter, "on" | "off">;

export interface ModelProvenanceHandler {
	handle(agentId: string | null): Response;
	dispose(): void;
}

export interface ModelProvenanceHandlerOptions {
	events?: RequestEventSource;
	maxEntries?: number;
}

function toProvenance(
	payload: RequestResponse,
): ModelProvenanceResponse | null {
	const agentId = payload.agentUsed?.trim();
	const upstreamModel = payload.model?.trim();
	if (!agentId || !upstreamModel) return null;

	return {
		agentId,
		requestedModel: payload.originalModel ?? null,
		appliedModel: payload.appliedModel ?? null,
		upstreamModel,
		account: payload.accountUsed,
		timestamp: payload.timestamp,
	};
}

export function createModelProvenanceHandler(
	options: ModelProvenanceHandlerOptions = {},
): ModelProvenanceHandler {
	const events = options.events ?? requestEvents;
	const maxEntries = Math.max(
		1,
		Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES),
	);
	const latestByAgent = new Map<string, ModelProvenanceResponse>();

	const observe = (event: RequestEvt): void => {
		if (event.type !== "summary") return;
		const provenance = toProvenance(event.payload);
		if (!provenance) return;

		// Refresh insertion order when a live session emits another summary so the
		// Map doubles as a bounded LRU without another timer or data structure.
		latestByAgent.delete(provenance.agentId);
		latestByAgent.set(provenance.agentId, provenance);
		while (latestByAgent.size > maxEntries) {
			const oldest = latestByAgent.keys().next().value;
			if (oldest === undefined) break;
			latestByAgent.delete(oldest);
		}
	};

	events.on("event", observe);

	return {
		handle(agentId) {
			if (!agentId || !AGENT_ID_PATTERN.test(agentId)) {
				return jsonResponse(
					{ error: "agentId must be 1-128 safe identifier characters" },
					400,
				);
			}
			return jsonResponse(latestByAgent.get(agentId) ?? null);
		},
		dispose() {
			events.off("event", observe);
		},
	};
}

let sharedHandler: ModelProvenanceHandler | null = null;

/** One listener/store for the process-lifetime API router. */
export function getSharedModelProvenanceHandler(): ModelProvenanceHandler {
	sharedHandler ??= createModelProvenanceHandler();
	return sharedHandler;
}
