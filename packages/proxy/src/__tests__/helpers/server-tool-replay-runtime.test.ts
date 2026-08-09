import { describe, expect, it, mock } from "bun:test";

// Focused source-worktree tests must not require generated database workers.
mock.module("@better-ccflare/database", () => ({
	AsyncDbWriter: class AsyncDbWriter {},
	DatabaseFactory: class DatabaseFactory {},
	DatabaseOperations: class DatabaseOperations {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

const { createReadyServerToolReplayRuntimeForTest } = await import(
	"./server-tool-replay-runtime"
);
const { bindRequestPrivateServerToolReplay } = await import(
	"../../server-tool-replay-runtime"
);
const { opaqueRuntimeId } = await import("../../opaque-runtime-id");

describe("server-tool replay runtime test helper", () => {
	it("reserves two disjoint durable 512-slot ranges for concurrent binds", async () => {
		const reservations: Array<{
			counterIdentity: string;
			reservationSize: number;
			firstIssuanceCount: number;
			lastIssuanceCount: number;
		}> = [];
		const runtime = await createReadyServerToolReplayRuntimeForTest({
			onReserveReplayIssuanceRange: (reservation) =>
				reservations.push(reservation),
		});
		const credential = "Bearer durable-helper-test";
		const lineage = "durable-helper-session";
		const request = new Request("https://proxy.local/v1/messages", {
			headers: {
				authorization: credential,
				"x-claude-code-session-id": lineage,
			},
		});
		const audience = opaqueRuntimeId("model-route-caller", credential);

		await expect(
			Promise.all(
				[{}, {}].map((owner) =>
					bindRequestPrivateServerToolReplay(owner, runtime, {
						request,
						apiKeyId: null,
						audience,
						lineage,
					}),
				),
			),
		).resolves.toEqual([true, true]);
		expect(reservations).toHaveLength(2);
		expect(
			new Set(reservations.map(({ counterIdentity }) => counterIdentity)).size,
		).toBe(1);
		expect(
			reservations.map(
				({ reservationSize, firstIssuanceCount, lastIssuanceCount }) => ({
					reservationSize,
					firstIssuanceCount,
					lastIssuanceCount,
				}),
			),
		).toEqual([
			{
				reservationSize: 512,
				firstIssuanceCount: 1,
				lastIssuanceCount: 512,
			},
			{
				reservationSize: 512,
				firstIssuanceCount: 513,
				lastIssuanceCount: 1024,
			},
		]);
	});
});
