import type { RedisClient } from '../cache/redis.js'
import { WORKER_LOCKS, WORKER_LOCK_SCAN_PATTERN } from '../jobs/constants.js'

/**
 * Parsed lock-token information.
 *
 * The token format from `DistributedLock.acquire()` is:
 *   `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
 */
export interface LockTokenInfo {
  pid: number | null
  acquiredAt: string | null
}

export interface WorkerHealthEntry {
  /** Friendly worker name (e.g. "score-snapshot"). */
  name: string
  /** Redis lock key (e.g. "cron:score-snapshot"). */
  lockKey: string
  /** Whether a worker currently holds the lock. */
  held: boolean
  /** ISO 8601 timestamp when the lock was acquired (extracted from token). */
  acquiredAt: string | null
  /** Process ID that acquired the lock (extracted from token). */
  pid: number | null
  /** Remaining TTL in milliseconds. -1 if no expiry, -2 if key gone. */
  ttlMs: number
}

export interface WorkerHealthResult {
  workers: WorkerHealthEntry[]
}

/**
 * Parse a lock token into its components.
 *
 * Token format: `${pid}-${timestamp}-${random}`
 */
function parseToken(token: string): LockTokenInfo {
  const parts = token.split('-')
  if (parts.length < 2) {
    return { pid: null, acquiredAt: null }
  }

  const pid = parseInt(parts[0], 10)
  const timestamp = parseInt(parts[1], 10)
  const acquiredAtDate = isNaN(timestamp) ? null : new Date(timestamp).toISOString()

  return { pid: isNaN(pid) ? null : pid, acquiredAt: acquiredAtDate }
}

/**
 * Service that queries Redis for the current state of all known worker
 * distributed-lock keys and returns a structured health report.
 *
 * Used by the `GET /api/health/workers` endpoint as an on-call debugging aid.
 */
export class WorkerHealthService {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Return the current lease + heartbeat state of every known worker lock.
   *
   * Uses Redis SCAN (non-blocking) to discover active lock keys, then
   * GET+TTL on each to extract ownership and remaining lease time.
   */
  async getWorkerStatuses(): Promise<WorkerHealthResult> {
    const foundKeys = await this.scanLockKeys()

    const workers: WorkerHealthEntry[] = []

    if (foundKeys.length > 0) {
      const values = await this.redis.mGet(foundKeys).catch(() => foundKeys.map(() => null))

      const pipeline = this.redis.multi()
      for (const key of foundKeys) {
        pipeline.ttl(key)
      }
      const ttlResults: (number | null)[] = await pipeline.exec().catch(() =>
        foundKeys.map(() => -2),
      ) ?? foundKeys.map(() => -2)

      for (let i = 0; i < foundKeys.length; i++) {
        const key = foundKeys[i]
        const value = values[i]
        const ttl = typeof ttlResults[i] === 'number' ? (ttlResults[i] as number) : -2
        const tokenInfo = value ? parseToken(value) : { pid: null, acquiredAt: null }

        workers.push({
          name: WORKER_LOCKS[key] ?? key,
          lockKey: key,
          held: value !== null && ttl !== -2 && ttl !== 0,
          acquiredAt: tokenInfo.acquiredAt,
          pid: tokenInfo.pid,
          ttlMs: ttl >= 0 ? ttl * 1000 : ttl,
        })
      }
    }

    // Also report known workers whose keys were not found in Redis
    for (const [lockKey, name] of Object.entries(WORKER_LOCKS)) {
      if (!workers.some((w) => w.lockKey === lockKey)) {
        workers.push({
          name,
          lockKey,
          held: false,
          acquiredAt: null,
          pid: null,
          ttlMs: -2,
        })
      }
    }

    return { workers }
  }

  /**
   * Use SCAN to find all lock keys matching the known pattern.
   */
  private async scanLockKeys(): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | number = 0

    try {
      do {
        const reply = await this.redis.scan(String(cursor), {
          MATCH: WORKER_LOCK_SCAN_PATTERN,
          COUNT: 100,
        })
        cursor = reply.cursor
        keys.push(...reply.keys)
        // Convert to number for comparison — redis may return string cursor
      } while (Number(cursor) !== 0)
    } catch {
      // If SCAN fails (e.g. Redis is down), return empty — the caller
      // will still report known workers as not-held.
    }

    return keys
  }
}
