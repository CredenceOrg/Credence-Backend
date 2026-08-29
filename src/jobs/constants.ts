/**
 * Known worker lock-key patterns.
 *
 * Every key listed here is a Redis key that a `DistributedLock` instance uses
 * to coordinate exclusive access to a recurring job across replicas.
 * The `/api/health/workers` endpoint scans for keys matching {@link WORKER_LOCK_SCAN_PATTERN}
 * and reports their lease state.
 *
 * Add new entries here when a new locked worker is introduced so the endpoint
 * can associate a friendly name with the lock key.
 */
export const WORKER_LOCKS: Record<string, string> = {
  'cron:score-snapshot': 'score-snapshot',
} as const

/**
 * Redis SCAN pattern used by the worker-health endpoint to discover
 * active lock keys.
 *
 * All distributed-lock keys for cron-like jobs should live under this
 * namespace so they are discoverable.
 */
export const WORKER_LOCK_SCAN_PATTERN = 'cron:*'
