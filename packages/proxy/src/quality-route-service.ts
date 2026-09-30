import type {
	QualityConversation,
	QualityIngressTicket,
	QualityLease,
	QualityReplacementAuthority,
	QualityRetryInput,
	QualityRouteRepository,
	QualitySettlement,
	QualityTrustedChild,
} from "@better-ccflare/database";
import type {
	QualityPhysicalTarget,
	QualityRootPreference,
	QualityVerifiedSession,
	QualityWorkerRole,
} from "@better-ccflare/types";
import { sanitizeQualityDecision } from "@better-ccflare/types/request";

import {
	type QualityRecoveryOptions,
	QualitySettlementRecovery,
} from "./quality-settlement-recovery";

function safeDecisionSnapshot(
	snapshot: QualityConversation["decision"],
): QualityConversation["decision"] {
	const value = sanitizeQualityDecision(snapshot?.value);
	if (
		!snapshot ||
		!value ||
		!Number.isSafeInteger(snapshot.revision) ||
		snapshot.revision < 1 ||
		typeof snapshot.requestId !== "string" ||
		snapshot.requestId.length > 128 ||
		!/^[A-Za-z0-9._:-]+$/.test(snapshot.requestId)
	)
		return null;
	return { requestId: snapshot.requestId, revision: snapshot.revision, value };
}

export interface QualityRouteStatus {
	incarnation: string;
	intentRevision: number;
	preference: QualityRootPreference | null;
	expiresAt: number;
	conversations: QualityConversation[];
	/** Recovery identities and concrete candidates; never replay these requests. */
	unresolved: { identity: QualityLease; target: QualityPhysicalTarget }[];
}

/** Persistence/control boundary only. Callers must supply the verified inference
 * principal and trusted child identity. No provider, inference callback, catalog
 * election, credential verification or spend grant is available in this unit.
 */
export class QualityRouteService {
	private readonly recovery: QualitySettlementRecovery;
	constructor(
		private readonly repository: QualityRouteRepository,
		private readonly now: () => number = Date.now,
		recoveryOptions?: QualityRecoveryOptions,
	) {
		this.recovery = new QualitySettlementRecovery(
			(...args) => this.settleDispatch(...args),
			recoveryOptions,
		);
	}
	reserveObservedSettlement() {
		const reservation = this.recovery.reserve();
		if (!reservation) return null;
		return {
			...reservation,
			bind: async (identity: QualityLease) => {
				// Bind synchronously first: controls completing during the read below
				// now see this entry. The read covers controls committed before binding,
				// without an unbounded second store of invalidation watermarks.
				reservation.bind(identity);
				const { session, incarnation, conversation } =
					structuredClone(identity);
				const state = await this.repository.status(session, this.now());
				if (state?.incarnation !== incarnation) return;
				const revision =
					conversation === "$request-only"
						? state.root?.revision
						: state.conversations.find((item) => item.key === conversation)
								?.revision;
				if (revision !== undefined)
					this.recovery.retireBefore(
						session,
						incarnation,
						conversation,
						revision,
					);
			},
		};
	}
	private retireRoot(
		session: QualityVerifiedSession,
		incarnation: string,
		revision: number,
	) {
		this.recovery.retireBefore(session, incarnation, "$root", revision);
		this.recovery.retireBefore(session, incarnation, "$request-only", revision);
	}
	stop() {
		return this.recovery.stop();
	}
	reserveIngress(session: QualityVerifiedSession) {
		return this.repository.reserveIngress(session, this.now());
	}
	withdrawIngress(ticket: QualityIngressTicket) {
		return this.repository.withdrawIngress(ticket, this.now());
	}
	async acceptRoot(
		ticket: QualityIngressTicket,
		preference: QualityRootPreference | null,
	) {
		const state = await this.repository.acceptRoot(
			ticket,
			preference,
			this.now(),
		);
		if (state.root)
			this.retireRoot(ticket.session, state.incarnation, state.root.revision);
		return state;
	}
	async acceptChild(
		session: QualityVerifiedSession,
		incarnation: string,
		child: QualityTrustedChild | null,
		role: QualityWorkerRole,
		expectedRevision: number | null,
	) {
		const accepted = await this.repository.acceptChild(
			session,
			incarnation,
			child,
			role,
			expectedRevision,
			this.now(),
		);
		if (accepted)
			this.recovery.retireBefore(
				session,
				incarnation,
				accepted.key,
				accepted.revision,
			);
		return accepted;
	}
	async status(
		session: QualityVerifiedSession,
	): Promise<QualityRouteStatus | null> {
		const state = await this.repository.status(session, this.now());
		if (!state?.root) return null;
		return {
			incarnation: state.incarnation,
			intentRevision: state.root.revision,
			preference: state.root.preference,
			expiresAt: state.expiresAt,
			conversations: state.conversations.map((item) => ({
				...item,
				decision:
					item.decision?.revision === item.revision
						? safeDecisionSnapshot(item.decision)
						: null,
				lastSuccessfulDecision: safeDecisionSnapshot(
					item.lastSuccessfulDecision,
				),
			})),
			unresolved: state.leases.flatMap((lease) =>
				lease.dispatch
					? [{ identity: lease.identity, target: lease.dispatch.target }]
					: [],
			),
		};
	}
	async retryPreferred(input: QualityRetryInput) {
		const outcome = await this.repository.retryPreferred(input, this.now());
		this.retireRoot(input.session, outcome.incarnation, outcome.intentRevision);
		return outcome;
	}
	acquireLease(
		session: QualityVerifiedSession,
		incarnation: string,
		conversation: string | null,
		revision: number,
	) {
		return this.repository.acquireLease(
			session,
			incarnation,
			conversation,
			revision,
			this.now(),
		);
	}
	renewLease(identity: QualityLease) {
		return this.repository.renewLease(identity, this.now());
	}
	beginDispatch(
		identity: QualityLease,
		target: QualityPhysicalTarget,
		replacement: QualityReplacementAuthority,
	) {
		return this.repository.beginDispatch(
			identity,
			target,
			replacement,
			this.now(),
		);
	}
	settleDispatch(
		identity: QualityLease,
		outcome: QualitySettlement,
		diagnostics?: {
			requestId: string;
			decision: import("@better-ccflare/types").QualityDecisionRecord | null;
		},
	) {
		return this.repository.settleDispatch(
			identity,
			outcome,
			this.now(),
			diagnostics,
		);
	}
	recordRejectedDecision(
		session: QualityVerifiedSession,
		incarnation: string,
		key: string,
		revision: number,
		requestId: string,
		decision: unknown,
	) {
		return this.repository.recordRejectedDecision(
			session,
			incarnation,
			key,
			revision,
			requestId,
			decision,
			this.now(),
		);
	}
	cleanup(limit = 100) {
		return this.repository.cleanup(this.now(), limit);
	}
}
