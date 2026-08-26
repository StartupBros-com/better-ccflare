import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { RequestEvt } from "@better-ccflare/core";
import type { RequestResponse } from "@better-ccflare/types";
import { createModelProvenanceHandler } from "../model-provenance";

function summary(
	agentUsed: string,
	model: string,
	overrides: Partial<RequestResponse> = {},
): RequestEvt {
	return {
		type: "summary",
		payload: {
			id: `req-${agentUsed}-${model}`,
			timestamp: "2026-08-26T12:00:00.000Z",
			method: "POST",
			path: "/v1/messages",
			accountUsed: "account-a",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTimeMs: 10,
			failoverAttempts: 0,
			agentUsed,
			model,
			originalModel: "claude-opus-5",
			appliedModel: "claude-opus-5",
			...overrides,
		},
	};
}

async function bodyOf(response: Response) {
	return response.json() as Promise<Record<string, unknown> | null>;
}

describe("model provenance handler", () => {
	it("returns the exact session's route, not the globally latest route", async () => {
		const events = new EventEmitter();
		const provenance = createModelProvenanceHandler({ events });
		try {
			events.emit("event", summary("agent-a", "gpt-5.6-terra"));
			events.emit("event", summary("agent-b", "claude-opus-5"));

			const response = provenance.handle("agent-a");
			expect(response.status).toBe(200);
			expect(await bodyOf(response)).toEqual({
				agentId: "agent-a",
				requestedModel: "claude-opus-5",
				appliedModel: "claude-opus-5",
				upstreamModel: "gpt-5.6-terra",
				account: "account-a",
				timestamp: "2026-08-26T12:00:00.000Z",
			});
		} finally {
			provenance.dispose();
		}
	});

	it("replaces a session with its newest summary and ignores start events", async () => {
		const events = new EventEmitter();
		const provenance = createModelProvenanceHandler({ events });
		try {
			events.emit("event", summary("agent-a", "gpt-5.6-terra"));
			events.emit("event", {
				type: "start",
				id: "later-start",
				timestamp: Date.now(),
				method: "POST",
				path: "/v1/messages",
				accountId: "different-account",
				statusCode: 0,
				agentUsed: "agent-a",
			});
			events.emit(
				"event",
				summary("agent-a", "gpt-5.6-sol", {
					accountUsed: "account-b",
					timestamp: "2026-08-26T12:01:00.000Z",
				}),
			);

			expect(await bodyOf(provenance.handle("agent-a"))).toMatchObject({
				upstreamModel: "gpt-5.6-sol",
				account: "account-b",
				timestamp: "2026-08-26T12:01:00.000Z",
			});
		} finally {
			provenance.dispose();
		}
	});

	it("evicts the oldest session when the bounded store is full", async () => {
		const events = new EventEmitter();
		const provenance = createModelProvenanceHandler({ events, maxEntries: 2 });
		try {
			events.emit("event", summary("agent-a", "gpt-5.6-terra"));
			events.emit("event", summary("agent-b", "gpt-5.6-terra"));
			events.emit("event", summary("agent-c", "gpt-5.6-terra"));

			expect(await bodyOf(provenance.handle("agent-a"))).toBeNull();
			expect(await bodyOf(provenance.handle("agent-b"))).not.toBeNull();
			expect(await bodyOf(provenance.handle("agent-c"))).not.toBeNull();
		} finally {
			provenance.dispose();
		}
	});

	it("rejects missing or malformed ids without exposing another session", async () => {
		const events = new EventEmitter();
		const provenance = createModelProvenanceHandler({ events });
		try {
			events.emit("event", summary("agent-a", "gpt-5.6-terra"));

			expect(provenance.handle(null).status).toBe(400);
			expect(provenance.handle("").status).toBe(400);
			expect(provenance.handle("agent a").status).toBe(400);
			expect(provenance.handle("x".repeat(129)).status).toBe(400);
			expect(await bodyOf(provenance.handle("unknown-agent"))).toBeNull();
		} finally {
			provenance.dispose();
		}
	});

	it("stops observing events after disposal", async () => {
		const events = new EventEmitter();
		const provenance = createModelProvenanceHandler({ events });
		provenance.dispose();
		events.emit("event", summary("agent-a", "gpt-5.6-terra"));
		expect(await bodyOf(provenance.handle("agent-a"))).toBeNull();
	});
});
