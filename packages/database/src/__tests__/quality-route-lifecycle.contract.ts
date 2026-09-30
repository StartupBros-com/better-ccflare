import { expect, it } from "bun:test";
import type { QualityVerifiedSession } from "@better-ccflare/types";
import type {
	QualityRouteLimits,
	QualityRouteRepository,
} from "../repositories/quality-route.repository";

/** Run unchanged against independent SQLite and PostgreSQL connections. */
export function qualityIngressContract(
	repositories: (
		limits: Partial<QualityRouteLimits>,
	) => [QualityRouteRepository, QualityRouteRepository],
) {
	const scope: QualityVerifiedSession = {
		verified: true,
		principalId: "lifecycle",
		sessionId: "root",
	};
	it("withdrawal preserves another active reservation and prevents withdrawn-token resurrection", async () => {
		const [first, second] = repositories({ maxSessions: 1 });
		const older = await first.reserveIngress(scope, 100);
		const newer = await second.reserveIngress(scope, 101);
		await Promise.all([
			first.withdrawIngress(older, 102),
			second.withdrawIngress(older, 102),
		]);
		const accepted = await second.acceptRoot(newer, "auto", 103);
		expect(accepted.root?.preference).toBe("auto");
		await expect(first.acceptRoot(older, "opus", 104)).rejects.toThrow();
		expect((await first.status(scope, 105))?.root).toEqual(accepted.root);
	});
	it("rejected provisional principal does not consume accepted admission and old incarnation cannot return", async () => {
		const [first, second] = repositories({ maxSessions: 1 });
		const rejected = await first.reserveIngress(scope, 100);
		await first.withdrawIngress(rejected, 101);
		const other = { ...scope, principalId: "other" };
		const accepted = await second.acceptRoot(
			await second.reserveIngress(other, 102),
			"auto",
			103,
		);
		expect(accepted.root?.preference).toBe("auto");
		const recreated = await first.reserveIngress(scope, 104);
		expect(recreated.incarnation).not.toBe(rejected.incarnation);
		await expect(first.acceptRoot(rejected, "opus", 105)).rejects.toThrow();
		await first.acceptRoot(recreated, null, 106);
		expect((await second.status(other, 107))?.root).toEqual(accepted.root);
	});
	it("provisional count, per-session reservations and age are finite without evicting accepted homes", async () => {
		const [first, second] = repositories({
			maxSessions: 1,
			maxProvisionalSessions: 1,
			maxIngress: 2,
			ingressTtlMs: 10,
		});
		const a = await first.reserveIngress(scope, 100);
		const b = await second.reserveIngress(scope, 101);
		await expect(first.reserveIngress(scope, 102)).rejects.toThrow();
		await expect(
			second.reserveIngress({ ...scope, sessionId: "other" }, 102),
		).rejects.toThrow();
		await first.withdrawIngress(a, 103);
		await second.acceptRoot(b, "auto", 104);
		const abandoned = await first.reserveIngress(
			{ ...scope, sessionId: "other" },
			105,
		);
		await second.cleanup(116);
		await expect(first.acceptRoot(abandoned, "opus", 117)).rejects.toThrow();
		expect((await second.status(scope, 117))?.root?.preference).toBe("auto");
	});
	it("newer invalid withdrawal preserves older valid intent but legitimate native acceptance fences it", async () => {
		const [first, second] = repositories({ maxSessions: 1 });
		const old = await first.reserveIngress(scope, 100);
		const invalid = await second.reserveIngress(scope, 101);
		await second.withdrawIngress(invalid, 102);
		await first.acceptRoot(old, "auto", 103);
		const pending = await first.reserveIngress(scope, 104);
		const native = await second.reserveIngress(scope, 105);
		await second.acceptRoot(native, null, 106);
		await expect(first.acceptRoot(pending, "auto", 107)).rejects.toThrow();
		expect((await second.status(scope, 108))?.root?.preference).toBeNull();
	});
	it("child standard to lightweight fences older success and diagnostics without touching root or sibling", async () => {
		const [first, second] = repositories({});
		const ticket = await first.reserveIngress(scope, 100);
		await first.acceptRoot(ticket, "auto", 101);
		const standard = {
			accountId: "a",
			provider: "anthropic",
			lane: "standard",
			line: "claude-sonnet",
			physicalModel: "claude-sonnet-5-5",
			catalogRevision: "catalog",
			evidenceRef: "evidence",
		} as const;
		const light = {
			...standard,
			lane: "lightweight",
			line: "claude-haiku",
			physicalModel: "claude-haiku-4-5",
		} as const;
		for (const id of ["worker", "sibling"])
			await first.acceptChild(
				scope,
				ticket.incarnation,
				{ trusted: true, conversationId: id },
				"standard",
				null,
				102,
			);
		const before = await first.status(scope, 103);
		const old = await first.acquireLease(
			scope,
			ticket.incarnation,
			"child:worker",
			1,
			104,
		);
		await first.beginDispatch(old, standard, null, 105);
		await second.acceptChild(
			scope,
			ticket.incarnation,
			{ trusted: true, conversationId: "worker" },
			"lightweight",
			1,
			106,
		);
		const current = await second.acquireLease(
			scope,
			ticket.incarnation,
			"child:worker",
			2,
			107,
		);
		await second.beginDispatch(current, light, null, 108);
		const decision = {
			version: 1,
			policyRevision: "quality-policy-v1:test",
			requested: { kind: "worker", role: "lightweight" },
			selected: light,
			skippedLanes: [],
		} as const;
		await second.settleDispatch(current, { kind: "validated-success" }, 109, {
			requestId: "new-child",
			decision,
		});
		await expect(
			first.settleDispatch(old, { kind: "validated-success" }, 110, {
				requestId: "old-child",
				decision: {
					...decision,
					selected: standard,
					requested: { kind: "worker", role: "standard" },
				},
			}),
		).rejects.toMatchObject({ code: "stale" });
		const after = await first.status(scope, 111);
		expect(
			after?.conversations.filter((c) => c.key !== "child:worker"),
		).toEqual(before?.conversations.filter((c) => c.key !== "child:worker"));
		expect(
			after?.conversations.find((c) => c.key === "child:worker"),
		).toMatchObject({
			revision: 2,
			home: { target: light },
			decision: { requestId: "new-child" },
		});
	});
}
