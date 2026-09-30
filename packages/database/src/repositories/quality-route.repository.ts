import { createHash, randomUUID } from "node:crypto";
import type {
	QualityControlOutcome,
	QualityPhysicalTarget,
	QualityRootPreference,
	QualityVerifiedSession,
	QualityWorkerRole,
} from "@better-ccflare/types";
import {
	type QualityDecisionRecord,
	sanitizeQualityDecision,
} from "@better-ccflare/types/request";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { BaseRepository } from "./base.repository";

export class QualityRouteError extends Error {
	constructor(
		public readonly code:
			| "stale"
			| "unavailable"
			| "capacity"
			| "provisional-capacity"
			| "unresolved"
			| "conflict",
	) {
		super(`Quality routing ${code}`);
	}
}
export interface QualityRouteLimits {
	idleTtlMs: number;
	leaseMs: number;
	maxLeaseLifetimeMs: number;
	maxSessions: number;
	maxProvisionalSessions: number;
	maxIngress: number;
	ingressTtlMs: number;
	maxCommands: number;
	maxConversations: number;
	maxLeases: number;
}
const DEFAULT_LIMITS: QualityRouteLimits = {
	idleTtlMs: 86_400_000,
	leaseMs: 120_000,
	maxLeaseLifetimeMs: 1_800_000,
	maxSessions: 10_000,
	maxProvisionalSessions: 10_000,
	maxIngress: 128,
	ingressTtlMs: 120_000,
	maxCommands: 256,
	maxConversations: 128,
	maxLeases: 64,
};
export interface QualityIngressTicket {
	session: QualityVerifiedSession;
	incarnation: string;
	order: number;
}
export interface QualityHome {
	version: number;
	intentRevision: number;
	target: QualityPhysicalTarget;
}
export interface QualityDecisionSnapshot {
	requestId: string;
	revision: number;
	value: QualityDecisionRecord;
}
export interface QualityConversation {
	decision?: QualityDecisionSnapshot | null;
	lastSuccessfulDecision?: QualityDecisionSnapshot | null;
	key: string;
	role: "main" | QualityWorkerRole;
	revision: number;
	homeVersion: number;
	home: QualityHome | null;
	pending: boolean;
	lastSettlement: {
		leaseId: string;
		outcome: QualitySettlement;
		home: QualityHome | null;
	} | null;
}
export interface QualityLease {
	session: QualityVerifiedSession;
	incarnation: string;
	conversation: string;
	revision: number;
	expectedHomeVersion: number;
	leaseId: string;
}
/** Internal dispatch namespace, never a child identity or home-bearing conversation. */
const REQUEST_ONLY = "$request-only";
interface StoredLease {
	identity: QualityLease;
	expiresAt: number;
	deadline: number;
	dispatch: { target: QualityPhysicalTarget; installHome: boolean } | null;
}
export type QualitySettlement =
	| { kind: "validated-success" }
	| { kind: "failed" | "cancelled" | "truncated" | "losing" };
export interface QualityRouteState {
	enrolled: boolean;
	ingress: { order: number; expiresAt: number }[];
	incarnation: string;
	nextOrder: number;
	acceptedOrder: number;
	expiresAt: number;
	root: { preference: QualityRootPreference | null; revision: number } | null;
	conversations: QualityConversation[];
	leases: StoredLease[];
	/** Bounded acknowledgement recovery only; no conversation identity or model home. */
	requestOnlySettlements?: {
		identity: QualityLease;
		outcome: QualitySettlement;
	}[];
	commands: {
		tokenDigest: string;
		payloadDigest: string;
		outcome: QualityControlOutcome;
	}[];
}
export interface QualityTrustedChild {
	trusted: true;
	conversationId: string;
}
export interface QualityRetryInput {
	session: QualityVerifiedSession;
	incarnation: string;
	expectedIntentRevision: number;
	idempotencyToken: string;
}
/** Request replay safety is deliberately NOT replacement authority. */
export type QualityReplacementAuthority = {
	kind: "genuinely-unavailable";
	homeVersion: number;
} | null;
interface StateRow {
	enrolled: number;
	incarnation: string;
	version: number | string;
	state_json: string;
}
function bounded(value: string, max = 256): void {
	if (typeof value !== "string" || !value || value.length > max)
		throw new TypeError("Bounded nonempty identity required");
}
function checkScope(scope: QualityVerifiedSession): void {
	if (scope.verified !== true)
		throw new TypeError("Verified session scope required");
	bounded(scope.principalId);
	bounded(scope.sessionId);
}
function checkNow(now: number): void {
	if (
		!Number.isSafeInteger(now) ||
		now < 0 ||
		now > Number.MAX_SAFE_INTEGER - 86_400_000
	)
		throw new TypeError("Invalid timestamp");
}
function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function live(state: QualityRouteState, now: number): boolean {
	return (
		state.expiresAt > now ||
		state.leases.some(
			(lease) => lease.dispatch !== null || lease.expiresAt > now,
		)
	);
}
function current(
	state: QualityRouteState,
	incarnation: string,
	now: number,
): void {
	if (state.incarnation !== incarnation) throw new QualityRouteError("stale");
	if (!state.root || !live(state, now))
		throw new QualityRouteError("unavailable");
}
function conversation(
	state: QualityRouteState,
	key: string,
): QualityConversation {
	const found = state.conversations.find((item) => item.key === key);
	if (!found) throw new QualityRouteError("unavailable");
	return found;
}
function supersedeRoot(
	state: QualityRouteState,
	preference: QualityRootPreference | null,
): void {
	const revision = (state.root?.revision ?? 0) + 1;
	state.root = { preference, revision };
	let root = state.conversations.find((item) => item.key === "$root");
	if (!root) {
		root = {
			key: "$root",
			role: "main",
			revision,
			homeVersion: 0,
			home: null,
			pending: true,
			lastSettlement: null,
		};
		state.conversations.push(root);
	}
	root.revision = revision;
	root.pending = true;
	root.lastSettlement = null;
	root.decision = null;
	state.requestOnlySettlements = [];
	state.leases = state.leases.filter(
		(lease) =>
			lease.identity.conversation !== "$root" &&
			lease.identity.conversation !== REQUEST_ONLY,
	);
}

/** A bounded session aggregate is the transaction boundary. Intent, homes,
 * controls and unresolved settlements remain separate logical records, but a
 * single database row CAS commits them together on both adapters. The generic
 * async adapter.transaction is NOT used (it is non-atomic on SQLite).
 * Digests alone are stored for controls; no credential, prompt or request body.
 */
export class QualityRouteRepository extends BaseRepository<never> {
	readonly limits: Readonly<QualityRouteLimits>;
	private static reservations = new Map<string, Promise<unknown>>();
	constructor(
		adapter: BunSqlAdapter,
		limits: Partial<QualityRouteLimits> = {},
	) {
		super(adapter);
		this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
		for (const [key, value] of Object.entries(this.limits)) {
			if (
				!Number.isSafeInteger(value) ||
				value < 1 ||
				value > DEFAULT_LIMITS[key as keyof QualityRouteLimits]
			)
				throw new TypeError(`Invalid quality route limit ${key}`);
		}
	}
	private async load(scope: QualityVerifiedSession): Promise<StateRow | null> {
		checkScope(scope);
		return this.get<StateRow>(
			"SELECT incarnation, version, state_json, enrolled FROM quality_route_sessions WHERE principal_id = ? AND session_id = ?",
			[scope.principalId, scope.sessionId],
		);
	}
	private refreshActivity(state: QualityRouteState, now: number): void {
		state.expiresAt = Math.max(state.expiresAt, now + this.limits.idleTtlMs);
	}
	async status(
		scope: QualityVerifiedSession,
		now: number,
	): Promise<QualityRouteState | null> {
		checkNow(now);
		const row = await this.load(scope);
		if (!row) return null;
		const state = JSON.parse(row.state_json) as QualityRouteState;
		return state.root && live(state, now) ? state : null;
	}
	private async mutate<T>(
		scope: QualityVerifiedSession,
		apply: (state: QualityRouteState) => T,
		admit = false,
	): Promise<T> {
		for (let attempt = 0; attempt < 32; attempt++) {
			const row = await this.load(scope);
			if (!row) throw new QualityRouteError("unavailable");
			const state = JSON.parse(row.state_json) as QualityRouteState;
			state.enrolled = Boolean(row.enrolled);
			state.ingress ??= [];
			const result = apply(state);
			const json = JSON.stringify(state);
			if (json.length > 1_048_576) throw new QualityRouteError("capacity");
			const unresolved = state.leases.some((lease) => lease.dispatch !== null)
				? 1
				: 0;
			const leaseUntil = Math.max(
				0,
				...state.leases.map((lease) => lease.expiresAt),
			);
			const statement = {
				sql: `UPDATE quality_route_sessions SET state_json = ?, version = version + 1, expires_at = ?, lease_until = ?, unresolved = ?, enrolled = ?, ingress_until = ? WHERE principal_id = ? AND session_id = ? AND incarnation = ? AND version = ?${admit ? " AND (enrolled = 1 OR (SELECT COUNT(*) FROM quality_route_sessions WHERE enrolled = 1) < ?)" : ""}`,
				params: [
					json,
					state.expiresAt,
					leaseUntil,
					unresolved,
					state.enrolled ? 1 : 0,
					Math.max(0, ...state.ingress.map((item) => item.expiresAt)),
					scope.principalId,
					scope.sessionId,
					row.incarnation,
					Number(row.version),
					...(admit ? [this.limits.maxSessions] : []),
				],
			};
			const changed = admit
				? (
						await this.adapter.runBatchWithChanges([
							{
								sql: "UPDATE quality_route_admission SET revision = revision + 1 WHERE id = 1",
								expectedChanges: 1,
							},
							statement,
						])
					)[1]
				: await this.runWithChanges(statement.sql, statement.params);
			if (changed === 0 && admit) {
				const latest = await this.load(scope);
				if (
					latest?.incarnation === row.incarnation &&
					Number(latest.version) === Number(row.version)
				)
					throw new QualityRouteError("capacity");
			}
			if (changed === 1) return result;
		}
		throw new QualityRouteError("conflict");
	}
	/** Serialize submission order within this process; CAS is the cross-instance authority. */
	reserveIngress(
		session: QualityVerifiedSession,
		now: number,
	): Promise<QualityIngressTicket> {
		checkScope(session);
		checkNow(now);
		const key = JSON.stringify([session.principalId, session.sessionId]);
		const previous =
			QualityRouteRepository.reservations.get(key) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(() => this.reserveOrdered(session, now));
		QualityRouteRepository.reservations.set(key, next);
		void next
			.finally(() => {
				if (QualityRouteRepository.reservations.get(key) === next)
					QualityRouteRepository.reservations.delete(key);
			})
			.catch(() => undefined);
		return next;
	}
	private async reserveOrdered(
		session: QualityVerifiedSession,
		now: number,
	): Promise<QualityIngressTicket> {
		await this.cleanup(now);
		if (!(await this.load(session))) {
			const state: QualityRouteState = {
				enrolled: false,
				ingress: [],
				incarnation: randomUUID(),
				nextOrder: 0,
				acceptedOrder: 0,
				expiresAt: now + this.limits.ingressTtlMs,
				root: null,
				conversations: [],
				leases: [],
				commands: [],
			};
			// The singleton write lock serializes admissions before the COUNT, including
			// PostgreSQL READ COMMITTED transactions in other processes. Never evict live state.
			await this.adapter.runBatchWithChanges([
				{
					sql: "UPDATE quality_route_admission SET revision = revision + 1 WHERE id = 1",
					expectedChanges: 1,
				},
				{
					sql: `INSERT INTO quality_route_sessions (principal_id, session_id, incarnation, version, state_json, expires_at, enrolled) SELECT ?, ?, ?, 0, ?, ?, 0 WHERE (SELECT COUNT(*) FROM quality_route_sessions WHERE enrolled = 0) < ? ON CONFLICT (principal_id, session_id) DO NOTHING`,
					params: [
						session.principalId,
						session.sessionId,
						state.incarnation,
						JSON.stringify(state),
						state.expiresAt,
						this.limits.maxProvisionalSessions,
					],
				},
			]);
			if (!(await this.load(session)))
				throw new QualityRouteError("provisional-capacity");
		}
		return this.mutate(session, (state) => {
			state.ingress = state.ingress.filter((item) => item.expiresAt > now);
			if (state.ingress.length >= this.limits.maxIngress)
				throw new QualityRouteError("capacity");
			const order = ++state.nextOrder;
			state.ingress.push({ order, expiresAt: now + this.limits.ingressTtlMs });
			if (!state.enrolled) state.expiresAt = now + this.limits.ingressTtlMs;
			return { session, incarnation: state.incarnation, order };
		});
	}
	async acceptRoot(
		ticket: QualityIngressTicket,
		preference: QualityRootPreference | null,
		now: number,
	): Promise<QualityRouteState> {
		checkNow(now);
		if (
			preference !== null &&
			!["auto", "fable", "astra", "opus"].includes(preference)
		)
			throw new TypeError("Invalid preference");
		return this.mutate(
			ticket.session,
			(state) => {
				if (
					state.incarnation !== ticket.incarnation ||
					!Number.isSafeInteger(ticket.order) ||
					ticket.order <= state.acceptedOrder ||
					ticket.order > state.nextOrder ||
					!state.ingress.some(
						(item) => item.order === ticket.order && item.expiresAt > now,
					)
				)
					throw new QualityRouteError("stale");
				state.acceptedOrder = ticket.order;
				if (!state.root || state.root.preference !== preference)
					supersedeRoot(state, preference);
				state.ingress = state.ingress.filter(
					(item) => item.order !== ticket.order && item.expiresAt > now,
				);
				if (preference !== null && !state.enrolled) {
					state.enrolled = true;
					state.expiresAt = now + this.limits.idleTtlMs;
				}
				if (state.enrolled) this.refreshActivity(state, now);
				return state;
			},
			preference !== null,
		);
	}
	/** Idempotent, exact-ticket removal. CAS protects reservations added concurrently;
	 * incarnation + membership prevent old tickets restoring state after cleanup. */
	async withdrawIngress(
		ticket: QualityIngressTicket,
		now: number,
	): Promise<void> {
		checkNow(now);
		try {
			await this.mutate(ticket.session, (state) => {
				if (state.incarnation !== ticket.incarnation)
					throw new QualityRouteError("stale");
				state.ingress = state.ingress.filter(
					(item) => item.order !== ticket.order && item.expiresAt > now,
				);
			});
			// A native-only watermark is needed only while another ingress can use it.
			// Exact JSON + incarnation protect reservations and state added concurrently.
			await this.runWithChanges(
				`DELETE FROM quality_route_sessions WHERE principal_id = ? AND session_id = ? AND incarnation = ? AND enrolled = 0 AND ingress_until = 0 AND unresolved = 0 AND state_json = ?`,
				[
					ticket.session.principalId,
					ticket.session.sessionId,
					ticket.incarnation,
					await this.reclaimableProvisionalJson(ticket.session),
				],
			);
		} catch (error) {
			if (
				!(error instanceof QualityRouteError) ||
				!["stale", "unavailable"].includes(error.code)
			)
				throw error;
		}
	}
	private async reclaimableProvisionalJson(
		session: QualityVerifiedSession,
	): Promise<string | null> {
		const row = await this.load(session);
		if (!row) return null;
		const state = JSON.parse(row.state_json) as QualityRouteState;
		return !row.enrolled &&
			!state.ingress?.length &&
			(!state.root || state.root.preference === null) &&
			state.conversations.every(
				(item) => item.key === "$root" && item.home === null,
			) &&
			!state.leases.length &&
			!state.commands.length &&
			!state.requestOnlySettlements?.length
			? row.state_json
			: null;
	}
	async retryPreferred(
		input: QualityRetryInput,
		now: number,
	): Promise<QualityControlOutcome> {
		checkNow(now);
		bounded(input.idempotencyToken, 512);
		const tokenDigest = digest(input.idempotencyToken);
		const payloadDigest = digest(
			JSON.stringify([
				input.incarnation,
				input.expectedIntentRevision,
				"retry",
			]),
		);
		return this.mutate(input.session, (state) => {
			current(state, input.incarnation, now);
			const previous = state.commands.find(
				(command) => command.tokenDigest === tokenDigest,
			);
			if (previous) {
				if (previous.payloadDigest !== payloadDigest)
					throw new QualityRouteError("conflict");
				return previous.outcome;
			}
			if (
				!state.root ||
				state.root.preference === null ||
				state.root.revision !== input.expectedIntentRevision
			)
				throw new QualityRouteError("conflict");
			if (state.commands.length >= this.limits.maxCommands)
				throw new QualityRouteError("capacity");
			supersedeRoot(state, state.root.preference);
			state.acceptedOrder = ++state.nextOrder;
			this.refreshActivity(state, now);
			const outcome: QualityControlOutcome = {
				status: "ready",
				incarnation: state.incarnation,
				intentRevision: state.root.revision,
				decision: null,
			};
			state.commands.push({ tokenDigest, payloadDigest, outcome });
			return outcome;
		});
	}
	/** Null identity is request-only: never guess a shared child key. Child input
	 * cannot reach root intent; existing children survive root leaving quality routing.
	 */
	async acceptChild(
		session: QualityVerifiedSession,
		incarnation: string,
		child: QualityTrustedChild | null,
		role: QualityWorkerRole,
		expectedRevision: number | null,
		now: number,
	): Promise<QualityConversation | null> {
		checkScope(session);
		checkNow(now);
		if (!child) return null;
		if (child.trusted !== true)
			throw new TypeError("Trusted child identity required");
		bounded(child.conversationId);
		if (!["standard", "lightweight", "fable", "astra", "opus"].includes(role))
			throw new TypeError("Invalid worker role");
		return this.mutate(session, (state) => {
			current(state, incarnation, now);
			const key = `child:${child.conversationId}`;
			let item = state.conversations.find((entry) => entry.key === key);
			if (!item) {
				if (state.root?.preference === null)
					throw new QualityRouteError("unavailable");
				if (expectedRevision !== null) throw new QualityRouteError("stale");
				if (state.conversations.length >= this.limits.maxConversations)
					throw new QualityRouteError("capacity");
				item = {
					key,
					role,
					revision: 1,
					homeVersion: 0,
					home: null,
					pending: true,
					lastSettlement: null,
				};
				state.conversations.push(item);
			} else {
				if (expectedRevision !== item.revision)
					throw new QualityRouteError("stale");
				if (item.role !== role) {
					item.role = role;
					item.revision++;
					item.pending = true;
					item.lastSettlement = null;
					state.leases = state.leases.filter(
						(lease) => lease.identity.conversation !== key,
					);
				}
			}
			this.refreshActivity(state, now);
			return item;
		});
	}
	async acquireLease(
		session: QualityVerifiedSession,
		incarnation: string,
		key: string | null,
		revision: number,
		now: number,
	): Promise<QualityLease> {
		checkNow(now);
		const dispatchKey = key ?? REQUEST_ONLY;
		return this.mutate(session, (state) => {
			current(state, incarnation, now);
			const item = key === null ? null : conversation(state, key);
			if (
				(item ? item.revision : state.root?.revision) !== revision ||
				((key === "$root" || key === null) && state.root?.preference === null)
			)
				throw new QualityRouteError("stale");
			if (
				state.leases.some(
					(lease) =>
						lease.identity.conversation === dispatchKey && lease.dispatch,
				)
			)
				throw new QualityRouteError("unresolved");
			state.leases = state.leases.filter(
				(lease) => lease.dispatch || lease.expiresAt > now,
			);
			if (state.leases.length >= this.limits.maxLeases)
				throw new QualityRouteError("capacity");
			const identity: QualityLease = {
				session,
				incarnation,
				conversation: dispatchKey,
				revision,
				expectedHomeVersion: item?.homeVersion ?? 0,
				leaseId: randomUUID(),
			};
			state.leases.push({
				identity,
				expiresAt:
					now + Math.min(this.limits.leaseMs, this.limits.maxLeaseLifetimeMs),
				deadline: now + this.limits.maxLeaseLifetimeMs,
				dispatch: null,
			});
			this.refreshActivity(state, now);
			return identity;
		});
	}
	private findLease(
		state: QualityRouteState,
		identity: QualityLease,
		now: number,
	): { lease: StoredLease; item: QualityConversation | null } {
		current(state, identity.incarnation, now);
		const item =
			identity.conversation === REQUEST_ONLY
				? null
				: conversation(state, identity.conversation);
		const lease = state.leases.find(
			(entry) => entry.identity.leaseId === identity.leaseId,
		);
		if (
			!lease ||
			(item ? item.revision : state.root?.revision) !== identity.revision ||
			(!item && state.root?.preference === null) ||
			(item?.homeVersion ?? 0) !== identity.expectedHomeVersion ||
			JSON.stringify(lease.identity) !== JSON.stringify(identity)
		)
			throw new QualityRouteError("stale");
		return { lease, item };
	}
	async renewLease(identity: QualityLease, now: number): Promise<number> {
		checkNow(now);
		return this.mutate(identity.session, (state) => {
			const { lease } = this.findLease(state, identity, now);
			if (lease.expiresAt <= now || lease.deadline <= now)
				throw new QualityRouteError("stale");
			// Renewal protects activity through the bounded lease, not an unbounded idle extension.
			lease.expiresAt = Math.min(
				Math.max(lease.expiresAt, now + this.limits.leaseMs),
				lease.deadline,
			);
			return lease.expiresAt;
		});
	}
	async beginDispatch(
		identity: QualityLease,
		target: QualityPhysicalTarget,
		replacement: QualityReplacementAuthority,
		now: number,
	): Promise<void> {
		checkNow(now);
		for (const value of Object.values(target)) bounded(value, 512);
		return this.mutate(identity.session, (state) => {
			const { lease, item } = this.findLease(state, identity, now);
			if (lease.expiresAt <= now) throw new QualityRouteError("stale");
			if (
				state.leases.some(
					(entry) =>
						entry.identity.conversation === identity.conversation &&
						entry.dispatch,
				)
			)
				throw new QualityRouteError("unresolved");
			if (!item) {
				lease.dispatch = { target: { ...target }, installHome: false };
				this.refreshActivity(state, now);
				return;
			}
			const sameHome =
				item.home?.target.accountId === target.accountId &&
				item.home.target.physicalModel === target.physicalModel &&
				item.home.target.line === target.line;
			const installHome =
				!item.home ||
				item.home.intentRevision !== item.revision ||
				sameHome ||
				(replacement?.kind === "genuinely-unavailable" &&
					replacement.homeVersion === item.homeVersion);
			lease.dispatch = { target: { ...target }, installHome };
			this.refreshActivity(state, now);
		});
	}
	/** Persistence-only recovery: the candidate comes from the pre-dispatch fence.
	 * An ambiguous database error MUST lead to retrying this method, never inference.
	 */
	async settleDispatch(
		identity: QualityLease,
		outcome: QualitySettlement,
		now: number,
		diagnostics?: { requestId: string; decision: QualityDecisionRecord | null },
	): Promise<QualityHome | null> {
		checkNow(now);
		return this.mutate(identity.session, (state) => {
			current(state, identity.incarnation, now);
			if (identity.conversation === REQUEST_ONLY) {
				if (
					state.root?.revision !== identity.revision ||
					state.root.preference === null
				)
					throw new QualityRouteError("stale");
				const history = state.requestOnlySettlements ?? [];
				const previous = history.find(
					(entry) => entry.identity.leaseId === identity.leaseId,
				);
				if (previous) {
					if (JSON.stringify(previous.identity) !== JSON.stringify(identity))
						throw new QualityRouteError("stale");
					if (previous.outcome.kind !== outcome.kind)
						throw new QualityRouteError("conflict");
					return null;
				}
				const { lease } = this.findLease(state, identity, now);
				if (!lease.dispatch) throw new QualityRouteError("stale");
				state.leases = state.leases.filter(
					(entry) => entry.identity.leaseId !== identity.leaseId,
				);
				state.requestOnlySettlements = [
					...history,
					{ identity, outcome },
				].slice(-this.limits.maxCommands);
				this.refreshActivity(state, now);
				return null;
			}
			const item = conversation(state, identity.conversation);
			if (item.revision !== identity.revision)
				throw new QualityRouteError("stale");
			if (item.lastSettlement?.leaseId === identity.leaseId) {
				if (item.lastSettlement.outcome.kind !== outcome.kind)
					throw new QualityRouteError("conflict");
				return item.lastSettlement.home;
			}
			const { lease } = this.findLease(state, identity, now);
			if (!lease.dispatch) throw new QualityRouteError("stale");
			if (outcome.kind === "validated-success" && lease.dispatch.installHome) {
				item.home = {
					version: ++item.homeVersion,
					intentRevision: item.revision,
					target: lease.dispatch.target,
				};
				item.pending = false;
			}
			state.leases = state.leases.filter(
				(entry) => entry.identity.leaseId !== identity.leaseId,
			);
			item.lastSettlement = {
				leaseId: identity.leaseId,
				outcome,
				home: item.home,
			};
			const decision = sanitizeQualityDecision(diagnostics?.decision);
			if (decision && diagnostics && diagnostics.requestId.length <= 128) {
				const target = lease.dispatch.target;
				const selected = decision.selected;
				// Never attach another candidate's explanation to this settled attempt.
				if (
					selected?.accountId === target.accountId &&
					selected.physicalModel === target.physicalModel &&
					selected.provider === target.provider &&
					selected.line === target.line &&
					selected.lane === target.lane
				) {
					item.decision = {
						requestId: diagnostics.requestId,
						revision: item.revision,
						value:
							outcome.kind === "validated-success"
								? decision
								: { ...decision, selected: null },
					};
					if (outcome.kind === "validated-success")
						item.lastSuccessfulDecision = item.decision;
				}
			}
			this.refreshActivity(state, now);
			return item.home;
		});
	}
	/** Diagnostics are not activity or authority: no home/intent/lease/expiry changes. */
	async recordRejectedDecision(
		session: QualityVerifiedSession,
		incarnation: string,
		key: string,
		revision: number,
		requestId: string,
		raw: unknown,
		now: number,
	): Promise<void> {
		const decision = sanitizeQualityDecision(raw);
		if (!decision || decision.selected !== null) return;
		bounded(requestId, 128);
		checkNow(now);
		await this.mutate(session, (state) => {
			current(state, incarnation, now);
			const item = conversation(state, key);
			if (item.revision !== revision) throw new QualityRouteError("stale");
			item.decision = { requestId, revision, value: decision };
		});
	}
	/** Bounded lifecycle cleanup, never a timer; unresolved output fences survive forever
	 * until settlement or authorized superseding intent. Active leases protect idle sessions.
	 */
	async cleanup(now: number, limit = 100): Promise<number> {
		checkNow(now);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new TypeError("Invalid cleanup bound");
		return this.runWithChanges(
			`DELETE FROM quality_route_sessions WHERE (principal_id, session_id) IN (SELECT principal_id, session_id FROM quality_route_sessions WHERE expires_at <= ? AND lease_until <= ? AND ingress_until <= ? AND unresolved = 0 ORDER BY expires_at LIMIT ?) AND expires_at <= ? AND lease_until <= ? AND ingress_until <= ? AND unresolved = 0`,
			[now, now, now, limit, now, now, now],
		);
	}
}
