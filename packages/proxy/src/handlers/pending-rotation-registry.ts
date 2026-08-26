import { Logger } from "@better-ccflare/logger";

const log = new Logger("PendingRotationRegistry");

/**
 * A refresh-token rotation that a provider call completed successfully but
 * whose DB persist failed (or hasn't been attempted yet). Kept in-process so
 * later touchpoints — the next refresh attempt, a request handler, a
 * background flush — can retry the persist, serve the rotated credentials in
 * the meantime, and avoid falsely flagging the account for re-auth.
 */
export type PendingRotation = {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
	/** The refresh token the successful provider call consumed ("" when none). */
	attemptedRefreshToken: string;
	/** Durable identity of the account row that initiated the provider exchange. */
	createdAt?: number;
	recordedAt: number;
};

/**
 * Narrow structural view of the DatabaseOperations CAS methods this registry
 * needs to flush a pending rotation. Declared here (not imported from the
 * class) so this module has no runtime dependency on @better-ccflare/database.
 */
export type PendingRotationDbOps = {
	updateAccountTokensIfRefreshTokenMatches(
		accountId: string,
		expectedRefreshToken: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
		expectedCreatedAt?: number,
	): Promise<boolean>;
	updateAccountTokensIfRefreshTokenAbsent(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
		expectedCreatedAt?: number,
	): Promise<boolean>;
};

// Safety valve against unbounded growth if persisting rotations stays broken
// for a long time — not a limit expected to matter in practice. Entries are
// small (~200 bytes each), so the cap can afford to be generous, and it
// should be: eviction here durably loses a provider-committed rotation (see
// the log.error below), so hitting this cap means 1000 accounts are
// simultaneously mid-rotation during a DB outage, which should be
// effectively unreachable.
const MAX_PENDING_ROTATIONS = 1000;
const pending = new Map<string, PendingRotation>();

export type PendingRotationPersistence = {
	save(accountId: string, rotation: PendingRotation): Promise<void>;
	load(): Promise<Array<{ accountId: string; rotation: PendingRotation }>>;
	remove(accountId: string): Promise<void>;
};

let persistence: PendingRotationPersistence | null = null;
const persistenceWrites = new Map<string, Promise<void>>();

async function enqueuePersistenceWrite(
	accountId: string,
	operation: (store: PendingRotationPersistence) => Promise<void>,
): Promise<void> {
	const store = persistence;
	if (!store) return;
	const previous = persistenceWrites.get(accountId) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(() => operation(store));
	persistenceWrites.set(accountId, current);
	try {
		await current;
	} finally {
		if (persistenceWrites.get(accountId) === current) {
			persistenceWrites.delete(accountId);
		}
	}
}

/** Install the durable outbox used by production startup and refresh paths. */
export function configurePendingRotationPersistence(
	value: PendingRotationPersistence | null,
): void {
	persistence = value;
}

export type PendingRotationGenerationResolver = (
	accountId: string,
) => Promise<{ created_at: number } | null>;

/**
 * Restore encrypted outbox rows before any provider refresh can run.
 *
 * Pre-generation WAL records are upgraded against the current durable account
 * row before becoming visible to generation-bound callers. A missing row is an
 * orphan, so its WAL entry is removed. Without a resolver, retain the legacy
 * ID-only restore contract for maintenance callers and older tests.
 */
export async function restorePendingRotations(
	resolveCurrentGeneration?: PendingRotationGenerationResolver,
): Promise<number> {
	if (!persistence) return 0;
	const rows = await persistence.load();
	let restored = 0;
	for (const { accountId, rotation } of rows) {
		if (pending.has(accountId)) continue;
		if (rotation.createdAt === undefined && resolveCurrentGeneration) {
			const current = await resolveCurrentGeneration(accountId);
			if (!current) {
				await enqueuePersistenceWrite(accountId, (store) =>
					store.remove(accountId),
				);
				continue;
			}
			const upgraded = { ...rotation, createdAt: current.created_at };
			// Save before publishing in-memory: a crash after a successful legacy
			// restore must not regress this entry to wildcard ownership.
			await enqueuePersistenceWrite(accountId, (store) =>
				store.save(accountId, upgraded),
			);
			pending.set(accountId, upgraded);
			restored += 1;
			continue;
		}
		pending.set(accountId, rotation);
		restored += 1;
	}
	return restored;
}

/** Remove a rotation only after the account row itself was deleted. */
export function clearPendingRotationForDeletedAccount(accountId: string): void {
	clearPendingRotation(accountId);
}

/**
 * Records a rotation that a provider call completed but that has not (yet)
 * been durably persisted. Replaces any existing entry for the account.
 *
 * Anchor compression (round-3 final review, C1): if an entry already exists
 * for this account, the new rotation's `attemptedRefreshToken` is discarded
 * in favor of the existing entry's, and `recordedAt` is likewise carried
 * over instead of reset. An entry can only still be present here because
 * every flush attempt since it was recorded has failed — the DB never moved,
 * so its `attemptedRefreshToken` is still the token the DB actually holds.
 * A chain of rotations recorded while the DB is down (RT1→RT2, then RT2→RT3,
 * …) must keep CASing against RT1: RT2 was only ever consumed in-memory by
 * the provider call that produced the second (also-unpersisted) rotation,
 * and a flush keyed on RT2 would match 0 rows, get misread as "superseded",
 * and abandon the still-live RT1 anchor. (If the DB truly moved — a manual
 * re-auth — the anchored CAS simply returns 0 rows on the next flush and is
 * correctly classified "superseded" then.) Preserving `recordedAt` keeps
 * this replace's FIFO-eviction position consistent with a plain replace
 * instead of jumping the entry to the back of the eviction queue.
 *
 * Bounded to MAX_PENDING_ROTATIONS entries: if recording this rotation would
 * exceed the cap, the oldest entry (by insertion order) is evicted first. An
 * eviction means a rotation is durably lost — the account will lose its
 * refresh token entirely once the in-memory copy also ages out — so it is
 * logged as an error rather than silently dropped.
 */
export async function recordPendingRotation(
	accountId: string,
	rotation: Omit<PendingRotation, "recordedAt">,
): Promise<void> {
	if (!pending.has(accountId) && pending.size >= MAX_PENDING_ROTATIONS) {
		const oldestId = pending.keys().next().value;
		if (oldestId !== undefined) {
			pending.delete(oldestId);
			log.error(
				`Evicted pending rotation for account ${oldestId}: registry exceeded ${MAX_PENDING_ROTATIONS} entries — that rotation is now durably lost`,
			);
		}
	}
	const existing = pending.get(accountId);
	// Never compress anchors across account generations. A same-ID replacement
	// must own its own outbox entry; otherwise an old entry could either fence a
	// new account's rotation or, if it lacked a legacy generation, replay into it.
	const sameGeneration = existing?.createdAt === rotation.createdAt;
	const next = {
		...rotation,
		attemptedRefreshToken:
			existing && sameGeneration
				? existing.attemptedRefreshToken
				: rotation.attemptedRefreshToken,
		createdAt:
			existing && sameGeneration ? existing.createdAt : rotation.createdAt,
		recordedAt: existing && sameGeneration ? existing.recordedAt : Date.now(),
	};
	pending.set(accountId, next);
	await persistPendingRotation(accountId, next);
}

async function persistPendingRotation(
	accountId: string,
	rotation: PendingRotation,
): Promise<void> {
	try {
		await enqueuePersistenceWrite(accountId, (store) =>
			store.save(accountId, rotation),
		);
	} catch (error) {
		log.error(
			`Failed to persist pending rotation outbox for account ${accountId}`,
			error,
		);
		throw error;
	}
}

/**
 * Returns the pending rotation for the account, if any.
 *
 * Supplying `expectedCreatedAt` fences a modern caller to its durable account
 * generation. Omitting it preserves the legacy ID-only contract for old outbox
 * entries and maintenance callers.
 */
export function getPendingRotation(
	accountId: string,
	expectedCreatedAt?: number,
): PendingRotation | undefined {
	const entry = pending.get(accountId);
	return expectedCreatedAt === undefined ||
		entry?.createdAt === expectedCreatedAt
		? entry
		: undefined;
}

/**
 * Removes a pending rotation only when it belongs to `expectedCreatedAt`, when
 * supplied. ID-only callers retain the legacy unconditional behavior.
 */
export function clearPendingRotation(
	accountId: string,
	expectedCreatedAt?: number,
): void {
	const entry = getPendingRotation(accountId, expectedCreatedAt);
	if (!entry) return;
	pending.delete(accountId);
	void enqueuePersistenceWrite(accountId, (store) =>
		store.remove(accountId),
	).catch((error) =>
		log.error(
			`Failed to remove pending rotation outbox for account ${accountId}`,
			error,
		),
	);
}

/** Test-only: clears the entire registry so tests don't leak state between runs. */
export function clearAllPendingRotationsForTests(): void {
	pending.clear();
}

/**
 * Attempts to persist a pending rotation for the account.
 * - "none": no entry for this account.
 * - "persisted": CAS landed; entry cleared — unless a newer rotation was
 *   recorded for this account while the CAS write was in flight, in which
 *   case that survivor is kept and its anchor is rebased onto the refresh
 *   token this flush just persisted (see below).
 * - "superseded": CAS matched 0 rows — the DB moved past the consumed token
 *   (manual re-auth or a newer rotation persisted); entry cleared, the DB is
 *   the source of truth now.
 * - "failed": the write threw; entry kept for the next flush attempt.
 *
 * Identity-guarded delete (round-3 final review, I2): both the "persisted"
 * and "superseded" branches only delete the entry that was actually flushed
 * — captured up front as `entry` — not whatever `pending.get(accountId)`
 * happens to return by the time the awaited CAS settles. A caller can
 * `recordPendingRotation` a newer rotation for this account while this
 * flush's CAS write is still in flight (a flapping DB, or a concurrent
 * request-triggered refresh); an unguarded delete would silently discard
 * that newer entry even though it was never flushed.
 *
 * Anchor rebase on a surviving entry (round-3, Codex concurrent
 * flush/re-record race): when the CAS lands but a newer entry survived the
 * identity guard above, that survivor's `attemptedRefreshToken` anchor was
 * compressed against the *pre-flush* DB state and no longer matches what the
 * DB now holds. Left alone, the survivor's own next flush would CAS against
 * a stale anchor, match 0 rows, get misread as "superseded", and be
 * discarded — even though it's the only in-memory copy of its refresh token.
 * Rebasing the anchor onto `entry.refreshToken` (what this CAS just wrote)
 * keeps the survivor's next flush aligned with reality.
 */
export async function flushPendingRotation(
	accountId: string,
	dbOps: PendingRotationDbOps,
	expectedCreatedAt?: number,
): Promise<"none" | "persisted" | "superseded" | "failed"> {
	const entry = getPendingRotation(accountId, expectedCreatedAt);
	if (!entry) return "none";

	try {
		const persisted = entry.attemptedRefreshToken
			? entry.createdAt === undefined
				? await dbOps.updateAccountTokensIfRefreshTokenMatches(
						accountId,
						entry.attemptedRefreshToken,
						entry.accessToken,
						entry.expiresAt,
						entry.refreshToken,
					)
				: await dbOps.updateAccountTokensIfRefreshTokenMatches(
						accountId,
						entry.attemptedRefreshToken,
						entry.accessToken,
						entry.expiresAt,
						entry.refreshToken,
						entry.createdAt,
					)
			: entry.createdAt === undefined
				? await dbOps.updateAccountTokensIfRefreshTokenAbsent(
						accountId,
						entry.accessToken,
						entry.expiresAt,
						entry.refreshToken,
					)
				: await dbOps.updateAccountTokensIfRefreshTokenAbsent(
						accountId,
						entry.accessToken,
						entry.expiresAt,
						entry.refreshToken,
						entry.createdAt,
					);

		if (persisted) {
			const current = pending.get(accountId);
			if (current === entry) {
				pending.delete(accountId);
				await enqueuePersistenceWrite(accountId, (store) =>
					store.remove(accountId),
				);
			} else if (current && current.createdAt === entry.createdAt) {
				// A newer rotation was recorded while this flush's CAS write was
				// still in flight. The CAS we just landed moved the DB's refresh
				// token to entry.refreshToken (or left it at the anchor when the
				// rotation carried no new one) — rebase the survivor's anchor
				// onto that, so its own flush matches the DB instead of reading
				// 0 rows, getting misclassified "superseded", and discarding the
				// newest credentials.
				current.attemptedRefreshToken =
					entry.refreshToken ?? entry.attemptedRefreshToken;
				await enqueuePersistenceWrite(accountId, (store) =>
					store.save(accountId, current),
				);
			}
			return "persisted";
		}
		if (pending.get(accountId) === entry) {
			pending.delete(accountId);
			await enqueuePersistenceWrite(accountId, (store) =>
				store.remove(accountId),
			);
		}
		log.warn(
			`Pending rotation for account ${accountId} was superseded — the DB moved past the consumed token (manual re-auth or a newer rotation)`,
		);
		return "superseded";
	} catch (error) {
		log.error(
			`Failed to flush pending rotation for account ${accountId} — keeping it for the next attempt`,
			error,
		);
		return "failed";
	}
}
