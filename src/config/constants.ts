/** Maximum tolerated age of the oldest unpublished outbox event before readiness fails. */
export const OUTBOX_MAX_LAG_SECONDS = 60
export const OUTBOX_MAX_LAG_MS = OUTBOX_MAX_LAG_SECONDS * 1000

/** Default replay safety setting for handler side effects. */
export const DEFAULT_REPLAY_SAFE = false

