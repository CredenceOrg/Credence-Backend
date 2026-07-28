/** Response header carrying the server-side processing time in milliseconds. */
export const HEADER_RESPONSE_TIME_MS = 'x-response-time-ms'

/** Header echoed from request to response to help clients debug retry loops. */
export const HEADER_REQUEST_ATTEMPT = 'x-request-attempt'

/** Maximum tolerated age of the oldest unpublished outbox event before readiness fails. */
export const OUTBOX_MAX_LAG_SECONDS = 60
export const OUTBOX_MAX_LAG_MS = OUTBOX_MAX_LAG_SECONDS * 1000

/** Default number of top talker tenants to return in top talkers reports. */
export const DEFAULT_TOP_TALKERS_LIMIT = 10
export const MAX_TOP_TALKERS_LIMIT = 100

/** Default time window in minutes for top talkers request aggregation (1 hour). */
export const DEFAULT_TOP_TALKERS_WINDOW_MINUTES = 60

/**
 * Hard cap on rows included in a single authenticated data export.
 * Oversized exports are rejected before streaming begins.
 * Override via EXPORT_MAX_ROWS.
 */
export const DEFAULT_EXPORT_MAX_ROWS = 100_000

/** Header name used to trigger graceful degradation / read-only mode */
export const READ_ONLY_HEADER = 'x-read-only'

/** Default replay safety setting for handler side effects. */
export const DEFAULT_REPLAY_SAFE = false

/** Header used by clients to advertise their version, echoed back for debugging */
export const HEADER_CLIENT_VERSION = 'X-Client-Version'

/** Periodic pg_stat_activity snapshot cadence used for postmortem capture. */
export const PG_STAT_ACTIVITY_SNAPSHOT_INTERVAL_MS = 60_000

/** Retention window for persisted pg_stat_activity snapshots. */
export const PG_STAT_ACTIVITY_SNAPSHOT_RETENTION_HOURS = 24

/** Default session TTL in seconds (24 hours). Override via SESSION_TTL_SECONDS. */
export const SESSION_TTL_SECONDS = 86_400

/** Default interval (ms) between expired-sessions sweeper runs (1 hour). Override via SESSION_SWEEP_INTERVAL_MS. */
export const SESSION_SWEEP_INTERVAL_MS = 3_600_000

/**
 * Duration in milliseconds after a notification provider's cooldown expires
 * during which the provider is treated as "recovering" rather than fully healthy.
 *
 * While recovering, the provider is placed behind fully-healthy providers in
 * the ordering, spreading the re-introduction of traffic and avoiding a
 * thundering herd against a just-recovered provider.
 */
export const PROVIDER_RECOVERY_BUFFER_MS = 5_000
