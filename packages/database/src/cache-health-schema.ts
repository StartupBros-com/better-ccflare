/** BIGINT has INTEGER affinity on SQLite and preserves epoch milliseconds on PG. */
export const CACHE_HEALTH_STATE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS cache_health_state (
		scope_key TEXT PRIMARY KEY,
		account_id TEXT,
		account_generation BIGINT,
		revision BIGINT NOT NULL CHECK (revision > 0),
		last_bucket_end BIGINT NOT NULL,
		active INTEGER NOT NULL CHECK (active IN (0, 1)),
		snapshot TEXT NOT NULL CHECK (length(snapshot) <= 65536)
	)
`;
