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

/**
 * Validate that all worker lock keys follow the expected naming convention and that their
 * corresponding friendly names are non‑empty strings. This function is intended to be
 * called during application start‑up or within tests to guarantee invariants.
 */
export function validateWorkerLocks(): void {
  for (const [key, name] of Object.entries(WORKER_LOCKS)) {
    if (!key.startsWith('cron:')) {
      throw new Error(`Worker lock key "${key}" must start with "cron:"`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Worker name for key "${key}" must be a non‑empty string`);
    }
  }
}

/**
 * Resolve a lock key to its friendly worker name. If the key is unknown, the raw key is returned.
 * This mirrors the behaviour used in the health service while providing a deterministic API.
 */
export function resolveWorkerName(lockKey: string): string {
  if (Object.prototype.hasOwnProperty.call(WORKER_LOCKS, lockKey)) {
    const name = WORKER_LOCKS[lockKey as keyof typeof WORKER_LOCKS];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`Invalid worker name mapping for lock key ${lockKey}`);
    }
    return name;
  }
  return lockKey;
}

/**
 * Exported type representing the known lock keys. Useful for compile‑time safety.
 */
export type WorkerLockKey = keyof typeof WORKER_LOCKS;
