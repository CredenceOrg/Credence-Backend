import type { Pool } from 'pg'
import client from 'prom-client'

export interface AdvisoryLockAge {
  lockId: string
  pid: number
  query: string
  database: string
  ageSeconds: number
}

interface AdvisoryLockRow {
  lock_id: string
  pid: number
  query: string | null
  database: string
  age_seconds: string | number
}

let advisoryLockAgeGauge: client.Gauge<string> | undefined

function createAdvisoryLockAgeGauge(register?: client.Registry): client.Gauge<string> {
  return new client.Gauge({
    name: 'pg_advisory_lock_age_seconds',
    help: 'Age of PostgreSQL advisory locks held by backend sessions',
    labelNames: ['lock_id', 'pid', 'database', 'query'] as const,
    registers: register ? [register] : undefined,
  })
}

export function registerAdvisoryLockMetrics(register: client.Registry): client.Gauge<string> {
  if (!advisoryLockAgeGauge) {
    advisoryLockAgeGauge = createAdvisoryLockAgeGauge(register)
  }
  return advisoryLockAgeGauge
}

export function resetAdvisoryLockMetrics(): void {
  advisoryLockAgeGauge = undefined
}

function parseAdvisoryLockRow(row: AdvisoryLockRow): AdvisoryLockAge {
  return {
    lockId: String(row.lock_id),
    pid: Number(row.pid),
    query: row.query ?? '<unknown>',
    database: String(row.database),
    ageSeconds:
      typeof row.age_seconds === 'string'
        ? Number(row.age_seconds)
        : row.age_seconds,
  }
}

export async function getStaleAdvisoryLocks(
  pool: Pick<Pool, 'query'>,
  thresholdSeconds = 300
): Promise<AdvisoryLockAge[]> {
  const result = await pool.query(
    `
      SELECT
        (pg_locks.objid::text || ':' || pg_locks.objsubid::text) AS lock_id,
        pg_locks.pid,
        pg_stat_activity.query,
        pg_stat_activity.datname AS database,
        EXTRACT(
          EPOCH FROM (
            NOW() - COALESCE(pg_stat_activity.query_start, pg_stat_activity.state_change)
          )
        ) AS age_seconds
      FROM pg_locks
      JOIN pg_stat_activity ON pg_stat_activity.pid = pg_locks.pid
      WHERE pg_locks.locktype = 'advisory'
        AND pg_locks.granted = true
        AND COALESCE(pg_stat_activity.query_start, pg_stat_activity.state_change)
          < NOW() - ($1 || ' seconds')::interval
      ORDER BY age_seconds DESC
    `,
    [thresholdSeconds]
  )

  return result.rows.map(parseAdvisoryLockRow)
}

export async function collectStaleAdvisoryLocks(
  pool: Pick<Pool, 'query'>,
  thresholdSeconds = 300
): Promise<AdvisoryLockAge[]> {
  const staleLocks = await getStaleAdvisoryLocks(pool, thresholdSeconds)
  if (!advisoryLockAgeGauge) {
    advisoryLockAgeGauge = createAdvisoryLockAgeGauge()
  }
  advisoryLockAgeGauge.reset()

  staleLocks.forEach((staleLock) => {
    advisoryLockAgeGauge!.set(
      {
        lock_id: staleLock.lockId,
        pid: String(staleLock.pid),
        database: staleLock.database,
        query: staleLock.query,
      },
      staleLock.ageSeconds
    )
  })

  return staleLocks
}
