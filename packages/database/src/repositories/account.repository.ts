import {
	type Account,
	type AccountRow,
	type RateLimitReason,
	toAccount,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export class AccountRepository extends BaseRepository<Account> {
	async findAll(): Promise<Account[]> {
		const rows = await this.query<AccountRow>(`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, rate_limited_reason, rate_limited_at, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				COALESCE(requires_reauth, 0) as requires_reauth,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
				COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
				custom_endpoint,
				model_mappings,
				cross_region_mode,
				model_fallbacks,
				billing_type,
				pause_reason,
				refresh_token_issued_at,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			ORDER BY priority DESC
		`);
		return rows.map(toAccount);
	}

	async findById(accountId: string): Promise<Account | null> {
		const row = await this.get<AccountRow>(
			`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, rate_limited_reason, rate_limited_at, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				COALESCE(requires_reauth, 0) as requires_reauth,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
				COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
				custom_endpoint,
				model_mappings,
				cross_region_mode,
				model_fallbacks,
				billing_type,
				pause_reason,
				refresh_token_issued_at,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			WHERE id = ?
		`,
			[accountId],
		);

		return row ? toAccount(row) : null;
	}

	async updateTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): Promise<void> {
		const now = Date.now();
		if (refreshToken) {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ?, requires_reauth = 0 WHERE id = ?`,
				[accessToken, expiresAt, refreshToken, now, accountId],
			);
		} else {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, requires_reauth = 0 WHERE id = ?`,
				[accessToken, expiresAt, accountId],
			);
		}
	}

	async incrementUsage(
		accountId: string,
		sessionDurationMs: number,
	): Promise<void> {
		const now = Date.now();
		await this.run(
			`
			UPDATE accounts
			SET
				last_used = ?,
				request_count = COALESCE(request_count, 0) + 1,
				total_requests = COALESCE(total_requests, 0) + 1,
				session_start = CASE
					WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN ?
					ELSE session_start
				END,
				session_request_count = CASE
					WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN 1
					ELSE COALESCE(session_request_count, 0) + 1
				END
			WHERE id = ?
		`,
			[now, now, sessionDurationMs, now, now, sessionDurationMs, accountId],
		);
	}

	async setRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET rate_limited_until = ?, rate_limited_reason = ?, rate_limited_at = ? WHERE id = ?`,
			[until, reason, Date.now(), accountId],
		);
	}

	/**
	 * Atomically records a rate-limit observation. `consecutive_rate_limits`
	 * always increments (audit trail of every observed 429/402), but
	 * `rate_limited_until` / `rate_limited_reason` only advance when the new
	 * `until` is strictly later than whatever is already persisted (a
	 * portable MAX-style clamp, expressed as CASE so it works identically on
	 * SQLite and PostgreSQL). This guards against a stale/delayed concurrent
	 * writer (e.g. a slow retry of an earlier observation) landing after a
	 * fresher, longer cooldown and shortening it back down. The reason stays
	 * paired with whichever `until` value wins the clamp, never overwritten
	 * by a discarded write's reason. `rate_limited_at` always updates to the
	 * current observation time regardless of clamp outcome, since it is an
	 * audit timestamp ("last observed"), not a leading-edge value.
	 */
	async markAccountRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<number> {
		await this.run(
			`UPDATE accounts
           SET consecutive_rate_limits = COALESCE(consecutive_rate_limits, 0) + 1,
               rate_limited_until      = CASE
                   WHEN rate_limited_until IS NULL OR ? > rate_limited_until THEN ?
                   ELSE rate_limited_until
               END,
               rate_limited_reason     = CASE
                   WHEN rate_limited_until IS NULL OR ? > rate_limited_until THEN ?
                   ELSE rate_limited_reason
               END,
               rate_limited_at         = ?
         WHERE id = ?`,
			[until, until, until, reason, Date.now(), accountId],
		);
		const row = await this.get<{ consecutive_rate_limits: number }>(
			`SELECT consecutive_rate_limits FROM accounts WHERE id = ?`,
			[accountId],
		);
		return row?.consecutive_rate_limits ?? 0;
	}

	async resetConsecutiveRateLimits(accountId: string): Promise<void> {
		await this.run(
			`UPDATE accounts SET consecutive_rate_limits = 0, rate_limited_at = NULL WHERE id = ?`,
			[accountId],
		);
	}

	async updateRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET rate_limit_status = ?, rate_limit_reset = ?, rate_limit_remaining = ? WHERE id = ?`,
			[status, reset, remaining ?? null, accountId],
		);
	}

	async clearRateLimitState(accountId: string): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts
			 SET
			 	rate_limited_until = NULL,
			 	rate_limited_reason = NULL,
			 	rate_limited_at = NULL,
			 	rate_limit_reset = NULL,
			 	rate_limit_status = NULL,
				rate_limit_remaining = NULL,
				consecutive_rate_limits = 0
			 WHERE id = ?`,
			[accountId],
		);
	}

	async pause(accountId: string, reason = "manual"): Promise<void> {
		await this.run(
			`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ?`,
			[reason, accountId],
		);
	}

	async resume(accountId: string): Promise<void> {
		await this.run(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?`,
			[accountId],
		);
	}

	/**
	 * Pause only if currently active. Guarded on the account not already being
	 * paused (e.g. by a manual pause, or a more specific auto-pause reason) so
	 * it never overwrites the reason on an account the user (or another guard)
	 * already paused. Returns true when the account was actually paused by
	 * this call.
	 *
	 * When `expectedRefreshToken` is provided the pause is additionally gated on
	 * the account still holding that exact refresh token. This guards the
	 * OAuth-invalid-grant pause against a stale/in-flight refresh (using an old
	 * token) re-pausing an account that was just re-authenticated, after reauth
	 * the stored refresh token differs, so the guarded UPDATE no-ops.
	 */
	async pauseIfActive(
		accountId: string,
		reason: string,
		expectedRefreshToken?: string | null,
	): Promise<boolean> {
		if (expectedRefreshToken != null) {
			const changes = await this.runWithChanges(
				`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ? AND COALESCE(paused, 0) = 0 AND refresh_token = ?`,
				[reason, accountId, expectedRefreshToken],
			);
			return changes > 0;
		}
		const changes = await this.runWithChanges(
			`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ? AND COALESCE(paused, 0) = 0`,
			[reason, accountId],
		);
		return changes > 0;
	}

	/**
	 * Resume an account only if it is currently paused for the exact given
	 * reason. Used to auto-resume a specific auto-pause (e.g. needs-reauth)
	 * after the underlying condition clears, without lifting a manual or
	 * unrelated auto-pause. Returns true when this call resumed it.
	 */
	async resumeIfPausedWithReason(
		accountId: string,
		reason: string,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND paused = 1 AND pause_reason = ?`,
			[accountId, reason],
		);
		return changes > 0;
	}

	/**
	 * Resume an account unless it is currently paused specifically for
	 * `blockedReason` (e.g. `oauth_invalid_grant`). This is the shared
	 * chokepoint for generic Resume (public API/CLI) and the usage poller's
	 * temporary resume, so neither caller can silently clear a terminal
	 * credential pause that only successful reauthentication
	 * (resumeIfPausedWithReason, above) is allowed to clear.
	 *
	 * `IS DISTINCT FROM` (rather than `!=`) is required so a legacy row that
	 * is paused with a NULL reason is still treated as resumable instead of
	 * being NULL-swallowed by a plain inequality comparison. `IS DISTINCT
	 * FROM` is NULL-safe on both backends: SQLite >= 3.39 and PostgreSQL.
	 * Plain `IS NOT` is SQLite-only syntax (a unary null-check operator
	 * there) and is a hard syntax error against PostgreSQL, so it cannot be
	 * used here now that this guard also runs against the PG adapter.
	 *
	 * Returns `resumed: true` when this call cleared the pause, or
	 * `resumed: false` with the account's current `pause_reason` (null when
	 * it wasn't paused at all) when the guard blocked it or there was
	 * nothing to resume.
	 */
	async resumeUnlessPausedForReason(
		accountId: string,
		blockedReason: string,
	): Promise<{ resumed: boolean; pauseReason: string | null }> {
		const changes = await this.runWithChanges(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND COALESCE(paused, 0) = 1 AND pause_reason IS DISTINCT FROM ?`,
			[accountId, blockedReason],
		);
		if (changes > 0) {
			return { resumed: true, pauseReason: null };
		}
		const row = await this.get<{ pause_reason: string | null }>(
			`SELECT pause_reason FROM accounts WHERE id = ?`,
			[accountId],
		);
		return { resumed: false, pauseReason: row?.pause_reason ?? null };
	}

	async resetSession(accountId: string, timestamp: number): Promise<void> {
		await this.run(
			`UPDATE accounts SET session_start = ?, session_request_count = 0 WHERE id = ?`,
			[timestamp, accountId],
		);
	}

	async updateRequestCount(accountId: string, count: number): Promise<void> {
		await this.run(
			`UPDATE accounts SET session_request_count = ? WHERE id = ?`,
			[count, accountId],
		);
	}

	async rename(accountId: string, newName: string): Promise<void> {
		await this.run(`UPDATE accounts SET name = ? WHERE id = ?`, [
			newName,
			accountId,
		]);
	}

	async updatePriority(accountId: string, priority: number): Promise<void> {
		await this.run(`UPDATE accounts SET priority = ? WHERE id = ?`, [
			priority,
			accountId,
		]);
	}

	async setAutoFallbackEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET auto_fallback_enabled = ? WHERE id = ?`,
			[enabled ? 1 : 0, accountId],
		);
	}

	async setAutoPauseOnOverageEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET auto_pause_on_overage_enabled = ? WHERE id = ?`,
			[enabled ? 1 : 0, accountId],
		);
	}

	async setBillingType(
		accountId: string,
		billingType: string | null,
	): Promise<void> {
		await this.run(`UPDATE accounts SET billing_type = ? WHERE id = ?`, [
			billingType,
			accountId,
		]);
	}

	/**
	 * Clear expired rate_limited_until values from all accounts
	 * @param now The current timestamp to compare against
	 * @returns Number of accounts that had their rate_limited_until cleared
	 */
	async clearExpiredRateLimits(now: number): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts SET rate_limited_until = NULL WHERE rate_limited_until <= ?`,
			[now],
		);
	}

	/**
	 * Check if there are any accounts for a specific provider
	 */
	async hasAccountsForProvider(provider: string): Promise<boolean> {
		const result = await this.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM accounts WHERE provider = ?`,
			[provider],
		);
		return result ? result.count > 0 : false;
	}
}
