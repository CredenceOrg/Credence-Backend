import type { HealthProbe } from './types.js'

/** Default timeout (ms) for each dependency check to avoid hanging. */
const CHECK_TIMEOUT_MS = 5000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms)
    ),
  ])
}

/**
 * Options for createDbProbe (for testing: inject a custom check).
 */
export interface DbProbeOptions {
  /** When set (e.g. in tests), used instead of real DB; throw to simulate down. */
  runQuery?: () => Promise<unknown>
}

/**
 * Creates a DB health probe when DATABASE_URL is set.
 * Uses pg Pool; runs a simple query. Does not expose errors.
 */
export function createDbProbe(options: DbProbeOptions = {}): HealthProbe | undefined {
  const url = process.env.DATABASE_URL
  if (!url && !options.runQuery) return undefined

  let pool: import('pg').Pool | null = null

  return async () => {
    try {
      if (options.runQuery) {
        await withTimeout(options.runQuery(), CHECK_TIMEOUT_MS)
        return { status: 'up' }
      }
      if (!pool) {
        const pg = (await import('pg')).default
        pool = new pg.Pool({ connectionString: url })
      }
      await withTimeout(pool.query('SELECT 1'), CHECK_TIMEOUT_MS)
      return { status: 'up' }
    } catch {
      return { status: 'down' }
    }
  }
}

/**
 * Options for createRedisProbe (for testing: inject a custom check).
 */
export interface RedisProbeOptions {
  /** When set (e.g. in tests), used instead of real Redis; throw to simulate down. */
  ping?: () => Promise<unknown>
}

/**
 * Creates a Redis health probe when REDIS_URL is set.
 * Uses ioredis PING. Does not expose errors.
 */
export function createRedisProbe(options: RedisProbeOptions = {}): HealthProbe | undefined {
  const url = process.env.REDIS_URL
  if (!url && !options.ping) return undefined

  let client: import('ioredis').default | null = null

  return async () => {
    try {
      if (options.ping) {
        await withTimeout(options.ping(), CHECK_TIMEOUT_MS)
        return { status: 'up' }
      }
      if (!client) {
        const Redis = (await import('ioredis')).default
        client = new Redis(url!, { maxRetriesPerRequest: 1 })
      }
      await withTimeout(client.ping(), CHECK_TIMEOUT_MS)
      return { status: 'up' }
    } catch {
      return { status: 'down' }
    }
  }
}

/**
 * Optional external (e.g. Horizon/contract) probe.
 * When provided, failure is reported as degraded, not unhealthy.
 */
export function createExternalProbe(
  check: () => Promise<boolean>
): HealthProbe {
  return async () => {
    try {
      const ok = await withTimeout(check(), CHECK_TIMEOUT_MS)
      return { status: ok ? 'up' : 'down' }
    } catch {
      return { status: 'down' }
    }
  }
}

/**
 * Builds default probes from environment (DATABASE_URL, REDIS_URL).
 * When pg/ioredis are not installed, skips that probe (reported as not_configured).
 */
export function createDefaultProbes(): {
  db?: HealthProbe
  redis?: HealthProbe
  external?: HealthProbe
} {
  const out: { db?: HealthProbe; redis?: HealthProbe; external?: HealthProbe } = {}
  if (process.env.DATABASE_URL) out.db = createDbProbe()
  if (process.env.REDIS_URL) out.redis = createRedisProbe()
  return out
}
