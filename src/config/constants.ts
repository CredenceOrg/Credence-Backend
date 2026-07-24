/** Maximum tolerated age of the oldest unpublished outbox event before readiness fails. */
export const OUTBOX_MAX_LAG_SECONDS = 60;
export const OUTBOX_MAX_LAG_MS = OUTBOX_MAX_LAG_SECONDS * 1000;

/** Periodic pg_stat_activity snapshot cadence used for postmortem capture. */
export const PG_STAT_ACTIVITY_SNAPSHOT_INTERVAL_MS = 60_000;

/** Retention window for persisted pg_stat_activity snapshots. */
export const PG_STAT_ACTIVITY_SNAPSHOT_RETENTION_HOURS = 24;
