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
	constructor(
		private readonly repository: QualityRouteRepository,
		private readonly now: () => number = Date.now,
	) {}
	reserveIngress(session: QualityVerifiedSession) {
		return this.repository.reserveIngress(session, this.now());
	}
	acceptRoot(
		ticket: QualityIngressTicket,
		preference: QualityRootPreference | null,
	) {
		return this.repository.acceptRoot(ticket, preference, this.now());
	}
	acceptChild(
		session: QualityVerifiedSession,
		incarnation: string,
		child: QualityTrustedChild | null,
		role: QualityWorkerRole,
		expectedRevision: number | null,
	) {
		return this.repository.acceptChild(
			session,
			incarnation,
			child,
			role,
			expectedRevision,
			this.now(),
		);
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
			conversations: state.conversations,
			unresolved: state.leases.flatMap((lease) =>
				lease.dispatch
					? [{ identity: lease.identity, target: lease.dispatch.target }]
					: [],
			),
		};
	}
	retryPreferred(input: QualityRetryInput) {
		return this.repository.retryPreferred(input, this.now());
	}
	acquireLease(
		session: QualityVerifiedSession,
		incarnation: string,
		conversation: string,
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
	settleDispatch(identity: QualityLease, outcome: QualitySettlement) {
		return this.repository.settleDispatch(identity, outcome, this.now());
	}
	cleanup(limit = 100) {
		return this.repository.cleanup(this.now(), limit);
	}
}
