/**
 * Feature-flag service constants.
 *
 * All magic values for the feature-flag subsystem live here so they can be
 * imported by the service, routes, tests, and OpenAPI generation without
 * duplication.
 */

// ── Cache keys ──────────────────────────────────────────────────────────────
export const FLAG_CACHE_PREFIX = 'feature_flag:'
export const FLAG_LIST_CACHE_KEY = 'feature_flags:all'
export const OVERRIDE_CACHE_PREFIX = 'feature_flag_override:'

// ── Cache TTL ────────────────────────────────────────────────────────────────
/** In-process cache TTL in milliseconds (30 seconds). */
export const FLAG_CACHE_TTL_MS = 30_000

// ── Rollout bucket ───────────────────────────────────────────────────────────
/** Maximum percent value (inclusive) accepted by the service. */
export const ROLLOUT_PERCENT_MAX = 100
/** Minimum percent value (inclusive) accepted by the service. */
export const ROLLOUT_PERCENT_MIN = 0
/**
 * Number of hex characters taken from the SHA-256 digest when computing the
 * rollout bucket.  8 hex chars = 32 bits, giving a [0, 2^32) range that is
 * modulo-reduced to [0, 100).
 */
export const ROLLOUT_HASH_HEX_CHARS = 8

// ── Outbox aggregate type ─────────────────────────────────────────────────────
export const OUTBOX_AGGREGATE_TYPE = 'feature_flag'

// ── Outbox event type strings ─────────────────────────────────────────────────
export const OUTBOX_EVENT_CREATED = 'feature_flag_created'
export const OUTBOX_EVENT_UPDATED = 'feature_flag_updated'
export const OUTBOX_EVENT_OVERRIDE_UPDATED = 'feature_flag_override_updated'
export const OUTBOX_EVENT_OVERRIDE_REMOVED = 'feature_flag_override_removed'
export const OUTBOX_EVENT_TENANT_ROLLOUT_SET = 'feature_flag_tenant_rollout_set'
export const OUTBOX_EVENT_TENANT_ROLLOUT_REMOVED = 'feature_flag_tenant_rollout_removed'
