import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncDbWriter, DatabaseFactory } from "@better-ccflare/database";
import type { RequestMeta, RequestResponse } from "@better-ccflare/types";
import { RoutingAttemptLedger } from "../../../packages/proxy/src/handlers/routing-attempt-ledger";
import {
	getRequestLifecycleCoordinator,
	recordRoutingTerminalRequest,
} from "../../../packages/proxy/src/routing-terminal-recorder";
import { UsageCollector } from "../../../packages/proxy/src/usage-collector";
import {
	bootIdentity,
	createAcceptedTiming,
	monotonicNowNs,
	registerManagedTerminal,
	signManagedTiming,
} from "../../../scripts/ccflare-managed-timing.mjs";
import { createManagedIngress } from "./managed-ingress";

test.each([
	"accepted",
	"earlier_semantic",
])("real collector %s first terminal persists through later cancellation", async (mode) => {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-managed-attribution-"));
	DatabaseFactory.initialize(join(dir, "fixture.db"));
	const db = DatabaseFactory.getInstance(),
		writer = new AsyncDbWriter();
	const summaries: RequestResponse[] = [];
	const collector = new UsageCollector(
		db,
		writer,
		() => false,
		(s) => {
			summaries.push(s);
		},
	);
	try {
		const secret = randomBytes(32),
			nonce = "a".repeat(32),
			source = "b".repeat(40),
			id = "af4c1b62-5a6c-4c2f-8d3a-2f5e7c8d9a01";
		const binding = {
			bootId: bootIdentity(),
			ingressNonce: "1".repeat(32),
			candidateNonce: nonce,
			generation: 1,
			backendSourceSha: source,
			requestId: id,
			attemptOrdinal: 1,
			method: "POST",
			path: "/v1/messages",
		};
		const timing = createAcceptedTiming(monotonicNowNs(), "120");
		const req = new Request("http://localhost/v1/messages", {
			method: "POST",
			body: "{}",
			headers: {
				"x-better-ccflare-managed-timing": signManagedTiming(
					timing,
					binding,
					secret,
				),
			},
		});
		const ingress = createManagedIngress({
			secret,
			generation: 1,
			ingressNonce: "1".repeat(32),
			candidateNonce: nonce,
			sourceSha: source,
		});
		const meta = {
			id,
			timestamp: Date.now(),
			method: "POST",
			path: "/v1/messages",
			model: "fixture",
			originalModel: "fixture",
			appliedModel: "fixture",
		} as RequestMeta;
		const ledger = new RoutingAttemptLedger();
		ledger.recordPhysicalAttempt({
			accountId: "fixture",
			provider: "codex",
			logicalModel: "fixture",
			physicalModel: "fixture",
		});
		const coordinator = getRequestLifecycleCoordinator(meta);
		coordinator.bindRoutingObservation(ledger, () => 200);
		const response = await ingress(req, async (r) => {
			coordinator.start({
				collector,
				message: {
					type: "start",
					messageId: "fixture",
					requestId: id,
					accountId: null,
					method: "POST",
					path: "/v1/messages",
					timestamp: meta.timestamp,
					requestHeaders: {},
					requestBody: null,
					project: null,
					responseStatus: 200,
					responseHeaders: { "content-type": "text/event-stream" },
					isStream: true,
					providerName: "codex",
					accountBillingType: null,
					accountAutoPauseOnOverageEnabled: null,
					accountName: null,
					agentUsed: null,
					comboName: null,
					apiKeyId: null,
					apiKeyName: null,
					retryAttempt: 0,
					failoverAttempts: 0,
				},
			});
			if (mode === "earlier_semantic") {
				ledger.recordPhysicalOutcome("meaningful_progress_timeout");
				void recordRoutingTerminalRequest({
					collector,
					requestMeta: meta,
					requestHeaders: r.headers,
					response: new Response(null, { status: 503 }),
					providerName: "codex",
					terminalKind: "meaningful_progress_timeout",
					upstreamAttempts: 1,
				});
			}
			registerManagedTerminal(r, (cause) => {
				ledger.recordPhysicalOutcome(cause);
				void recordRoutingTerminalRequest({
					collector,
					requestMeta: meta,
					requestHeaders: r.headers,
					response: new Response(null, { status: 504 }),
					providerName: "codex",
					terminalKind: cause,
					upstreamAttempts: 1,
				});
			});
			r.signal.addEventListener("abort", () => {
				void coordinator.finalize({
					type: "end",
					requestId: id,
					success: false,
					error: "downstream_cancelled",
					streamTerminalState: "client_cancelled",
				});
			});
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode(": ping\n\n"));
					},
					cancel() {},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("accepted_request_deadline");
		await collector.drain();
		const summary = summaries[0];
		if (!summary?.routingAttemptSummary)
			throw new Error("missing managed terminal summary");
		expect(summary.routingAttemptSummary.terminalCause).toBe(
			mode === "accepted"
				? "accepted_request_deadline"
				: "meaningful_progress_timeout",
		);
		expect(summary.routingAttemptSummary.nativeStatus).toBe(200);
		expect(summary.routingAttemptSummary.wireStatus).toBe(200);
		expect(summary.routingAttemptSummary.cancellationOrigin).toBeNull();
		const readOnly = new Database(join(dir, "fixture.db"), { readonly: true });
		const row = readOnly
			.query("SELECT routing_attempt_summary FROM requests WHERE id=?")
			.get(id) as { routing_attempt_summary: string };
		readOnly.close();
		expect(JSON.parse(row.routing_attempt_summary).terminalCause).toBe(
			mode === "accepted"
				? "accepted_request_deadline"
				: "meaningful_progress_timeout",
		);
	} finally {
		collector.dispose();
		await collector.drain();
		await DatabaseFactory.reset();
		rmSync(dir, { recursive: true, force: true });
	}
});
