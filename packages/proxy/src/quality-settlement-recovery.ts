import type { QualityLease, QualitySettlement } from "@better-ccflare/database";
import type { QualityDecisionRecord } from "@better-ccflare/types";
import { sanitizeQualityDecision } from "@better-ccflare/types/request";

type Diagnostics = {
	requestId: string;
	decision: QualityDecisionRecord | null;
};
export interface QualityRecoveryOptions {
	/** Test seam; production capacity is fixed, not a routing/config surface. */
	capacity?: number;
	schedule?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => () => void;
}
interface Entry {
	identity?: QualityLease;
	key?: string;
	outcome?: QualitySettlement;
	diagnostics?: Diagnostics;
	flight?: Promise<boolean>;
	cancel?: () => void;
	delay: number;
	owners: number;
	acknowledged?: boolean;
	retired?: boolean;
}

/** Owns only bounded persistence metadata, never requests or provider callbacks. */
export class QualitySettlementRecovery {
	private readonly entries = new Set<Entry>();
	private readonly leases = new Map<string, Entry>();
	private readonly capacity: number;
	private readonly schedule: NonNullable<QualityRecoveryOptions["schedule"]>;
	private stopped = false;
	constructor(
		private readonly write: (
			identity: QualityLease,
			outcome: QualitySettlement,
			diagnostics?: Diagnostics,
		) => Promise<unknown>,
		options: QualityRecoveryOptions = {},
	) {
		this.capacity = options.capacity ?? 128;
		if (
			!Number.isSafeInteger(this.capacity) ||
			this.capacity < 1 ||
			this.capacity > 128
		)
			throw new TypeError("Invalid settlement capacity");
		this.schedule =
			options.schedule ??
			((callback, delay) => {
				const timer = setTimeout(callback, delay);
				timer.unref();
				return () => clearTimeout(timer);
			});
	}
	/** Only the service supplies committed repository authority. An old control
	 * response can retire older revisions, never equal/newer ones or another incarnation. */
	retireBefore(
		session: QualityLease["session"],
		incarnation: string,
		conversation: string,
		revision: number,
	) {
		for (const entry of this.entries) {
			const identity = entry.identity;
			if (
				identity?.session.principalId === session.principalId &&
				identity.session.sessionId === session.sessionId &&
				identity.incarnation === incarnation &&
				identity.conversation === conversation &&
				identity.revision < revision
			)
				this.remove(entry);
		}
	}
	/** Synchronous reservation must precede every dispatch-capable await. */
	reserve() {
		if (this.stopped || this.entries.size >= this.capacity) return null;
		let entry: Entry = { delay: 1000, owners: 1 };
		let released = false;
		this.entries.add(entry);
		return {
			bind: (identity: QualityLease) => {
				if (entry.identity || !this.entries.has(entry))
					throw new Error("Invalid settlement reservation");
				const fields = [
					identity.session.principalId,
					identity.session.sessionId,
					identity.incarnation,
					identity.conversation,
					identity.leaseId,
				];
				if (
					fields.some(
						(value) => typeof value !== "string" || value.length > 512,
					)
				)
					throw new TypeError("Invalid settlement identity");
				if (
					Object.keys(identity).some(
						(key) =>
							![
								"session",
								"incarnation",
								"conversation",
								"leaseId",
								"revision",
								"expectedHomeVersion",
							].includes(key),
					) ||
					Object.keys(identity.session).some(
						(key) => !["verified", "principalId", "sessionId"].includes(key),
					) ||
					identity.session.verified !== true ||
					!Number.isSafeInteger(identity.revision) ||
					!Number.isSafeInteger(identity.expectedHomeVersion)
				)
					throw new TypeError("Invalid settlement identity");
				// Repository CAS compares serialized identities, including property order.
				const copy = structuredClone(identity);
				const key = JSON.stringify(copy);
				const existing = this.leases.get(key);
				if (existing) {
					this.entries.delete(entry);
					entry = existing;
					entry.owners++;
				} else {
					entry.identity = copy;
					entry.key = key;
					this.leases.set(key, entry);
				}
			},
			settle: (
				outcome: QualitySettlement,
				diagnostics?: Diagnostics,
			): Promise<boolean> => {
				if (released || !entry.identity) return Promise.resolve(false);
				// Removing acknowledged ownership frees capacity, not its callback's
				// idempotent result. Superseded unacknowledged outcomes stay rejected.
				if (entry.retired && !entry.acknowledged) return Promise.resolve(false);
				if (entry.outcome) {
					if (entry.outcome.kind !== outcome.kind)
						return Promise.resolve(false);
					return entry.flight ?? Promise.resolve(entry.acknowledged === true);
				}
				entry.outcome = { kind: outcome.kind };
				if (
					diagnostics &&
					/^[A-Za-z0-9._:-]{1,128}$/.test(diagnostics.requestId)
				)
					entry.diagnostics = {
						requestId: diagnostics.requestId,
						decision: structuredClone(
							sanitizeQualityDecision(diagnostics.decision),
						),
					};
				return this.run(entry, 3);
			},
			/** Only releases memory for an unobserved attempt; never touches its DB fence. */
			release: () => {
				if (released) return;
				released = true;
				if (--entry.owners === 0 && !entry.outcome) this.remove(entry);
			},
		};
	}
	private remove(entry: Entry) {
		entry.retired = true;
		entry.cancel?.();
		entry.cancel = undefined;
		// A superseded hung write still consumes a slot until its promise settles.
		if (entry.flight) return;
		this.entries.delete(entry);
		if (entry.key && this.leases.get(entry.key) === entry)
			this.leases.delete(entry.key);
	}
	private run(entry: Entry, attempts: number): Promise<boolean> {
		if (entry.flight) return entry.flight;
		if (this.stopped || entry.retired) return Promise.resolve(false);
		const flight = this.persist(entry, attempts);
		entry.flight = flight;
		void flight.then(() => {
			entry.flight = undefined;
			if (entry.retired) this.remove(entry);
		});
		return flight;
	}
	private async persist(entry: Entry, attempts: number): Promise<boolean> {
		const { identity, outcome } = entry;
		if (!identity || !outcome) return false;
		for (
			let attempt = 0;
			attempt < attempts && !this.stopped && !entry.retired;
			attempt++
		) {
			try {
				// Copies keep even a write adapter from mutating the retained evidence.
				await this.write(
					structuredClone(identity),
					structuredClone(outcome),
					structuredClone(entry.diagnostics),
				);
				entry.acknowledged = true;
				this.remove(entry);
				return true;
			} catch (error) {
				if ((error as { code?: string })?.code === "stale") {
					this.remove(entry);
					return false;
				}
			}
		}
		if (!this.stopped && !entry.retired) {
			entry.cancel = this.schedule(async () => {
				entry.cancel = undefined;
				await this.run(entry, 1);
			}, entry.delay);
			entry.delay = Math.min(30_000, entry.delay * 2);
		}
		return false;
	}
	/** Stop before closing the shared DB. Unknown outcomes remain durably fenced. */
	async stop() {
		this.stopped = true;
		for (const entry of this.entries) {
			entry.cancel?.();
			entry.cancel = undefined;
		}
		await Promise.all([...this.entries].map((entry) => entry.flight));
	}
}
