/** Maximum tolerated age of the oldest unpublished outbox event before readiness fails. */
export const OUTBOX_MAX_LAG_SECONDS = 60
export const OUTBOX_MAX_LAG_MS = OUTBOX_MAX_LAG_SECONDS * 1000

/** Default replay safety setting for handler side effects. */
export const DEFAULT_REPLAY_SAFE = false

/**
 * Duration in milliseconds after a notification provider's cooldown expires
 * during which the provider is treated as "recovering" rather than fully healthy.
 *
 * While recovering, the provider is placed behind fully-healthy providers in
 * the ordering, spreading the re-introduction of traffic and avoiding a
 * thundering herd against a just-recovered provider.
 */
export const PROVIDER_RECOVERY_BUFFER_MS = 5_000
