/** Maximum tolerated age of the oldest unpublished outbox event before readiness fails. */
export const OUTBOX_MAX_LAG_SECONDS = 60
export const OUTBOX_MAX_LAG_MS = OUTBOX_MAX_LAG_SECONDS * 1000

/** Default number of top talker tenants to return in top talkers reports. */
export const DEFAULT_TOP_TALKERS_LIMIT = 10
export const MAX_TOP_TALKERS_LIMIT = 100

/** Default time window in minutes for top talkers request aggregation (1 hour). */
export const DEFAULT_TOP_TALKERS_WINDOW_MINUTES = 60

