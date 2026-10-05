/**
 * Per-account usage-window soft caps: `{ "<accountId>": { "<windowKey>": 1..99 } }`.
 * A window key is `five_hour`, `seven_day` (account-wide) or `seven_day_<family>`
 * (one model family). The value is the utilization percent at or above which the
 * proxy stops selecting that account for that window's scope.
 */
export type AccountWindowCaps = Record<string, Record<string, number>>;
