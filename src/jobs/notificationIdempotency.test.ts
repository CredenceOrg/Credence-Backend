/**
 * Tests for the notification idempotency guard.
 *
 * These exercise the claim state machine against a fake `Queryable` that models
 * Postgres' semantics for the claim statement exactly — including the
 * `ON CONFLICT ... DO UPDATE ... WHERE` guard, which pg-mem silently ignores
 * (it applies the update regardless of the WHERE), making pg-mem unusable here.
 * `notificationIdempotency.integration.test.ts` re-verifies the same behaviour
 * against a real Postgres when one is available.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import type { Queryable } from '../db/repositories/queryable.js'
import {
  DEFAULT_CLAIM_TIMEOUT_SECONDS,
  IdempotentNotificationJob,
  NotificationIdempotencyRepository,
  buildNotificationDeliveryJobKey,
  createIdempotentNotificationJob,
} from './notificationIdempotency.js'

interface Row {
  id: string
  job_key: string
  job_type: string
  status: 'pending' | 'completed' | 'failed'
  result: string | null
  attempted_at: Date
  completed_at: Date | null
  expires_at: Date
}

/**
 * In-memory stand-in for the `idempotent_job_attempts` table that reproduces
 * Postgres' evaluation of the statements in NotificationIdempotencyRepository.
 */
class FakeIdempotencyDb implements Queryable {
  readonly rows = new Map<string, Row>()
  readonly statements: string[] = []
  now = new Date('2026-07-29T12:00:00.000Z')

  advanceSeconds(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1000)
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<R>> {
    this.statements.push(text)
    const sql = text.trim()

    if (sql.startsWith('INSERT INTO idempotent_job_attempts')) {
      return this.claim(params) as QueryResult<R>
    }
    if (sql.startsWith('SELECT')) {
      return this.find(params) as QueryResult<R>
    }
    if (sql.startsWith('UPDATE idempotent_job_attempts')) {
      return this.markTerminal(sql, params) as QueryResult<R>
    }

    throw new Error(`Unexpected statement: ${sql}`)
  }

  private result(rows: Row[]): QueryResult<Row> {
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
  }

  /** Mirrors: INSERT ... ON CONFLICT (job_key) DO UPDATE ... WHERE ... RETURNING */
  private claim(params: readonly unknown[]): QueryResult<Row> {
    const [id, jobKey, jobType, expiresInSeconds, claimTimeoutSeconds] = params as [
      string,
      string,
      string,
      number,
      number,
    ]

    const nowMs = this.now.getTime()
    const claimed: Row = {
      id,
      job_key: jobKey,
      job_type: jobType,
      status: 'pending',
      result: null,
      attempted_at: new Date(nowMs),
      completed_at: null,
      expires_at: new Date(nowMs + expiresInSeconds * 1000),
    }

    const existing = this.rows.get(jobKey)
    if (!existing) {
      this.rows.set(jobKey, claimed)
      return this.result([{ ...claimed }])
    }

    const reclaimable =
      existing.status === 'failed' ||
      existing.expires_at.getTime() <= nowMs ||
      (existing.status === 'pending' &&
        existing.attempted_at.getTime() <= nowMs - claimTimeoutSeconds * 1000)

    if (!reclaimable) {
      // ON CONFLICT DO UPDATE WHERE ... did not match: zero rows returned.
      return this.result([])
    }

    this.rows.set(jobKey, claimed)
    return this.result([{ ...claimed }])
  }

  /** Mirrors: SELECT ... WHERE job_key = $1 AND expires_at > NOW() */
  private find(params: readonly unknown[]): QueryResult<Row> {
    const row = this.rows.get(params[0] as string)
    if (!row || row.expires_at.getTime() <= this.now.getTime()) {
      return this.result([])
    }
    return this.result([{ ...row }])
  }

  /** Mirrors: UPDATE ... WHERE id = $2 (no-op when the id no longer matches) */
  private markTerminal(sql: string, params: readonly unknown[]): QueryResult<Row> {
    const [value, attemptId] = params as [string, string]
    const row = [...this.rows.values()].find(candidate => candidate.id === attemptId)
    if (!row) {
      return this.result([])
    }

    row.status = sql.includes("status = 'completed'") ? 'completed' : 'failed'
    row.result = value
    row.completed_at = new Date(this.now.getTime())
    return this.result([row])
  }
}

const JOB_KEY = buildNotificationDeliveryJobKey('notif-1')
const JOB_TYPE = 'notification_delivery'

function makeJob(
  db: Queryable,
  send: () => Promise<string>,
  expiresInSeconds = 3600,
  claimTimeoutSeconds = 900
) {
  return new IdempotentNotificationJob(
    db,
    JOB_KEY,
    JOB_TYPE,
    { run: send },
    expiresInSeconds,
    claimTimeoutSeconds
  )
}

describe('IdempotentNotificationJob', () => {
  let db: FakeIdempotencyDb

  beforeEach(() => {
    db = new FakeIdempotencyDb()
  })

  it('runs the job on first claim and records the result', async () => {
    const send = vi.fn().mockResolvedValue('sent-1')

    const result = await makeJob(db, send).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.alreadyProcessed).toBe(false)
    expect(result.result).toBe('sent-1')
    expect(db.rows.get(JOB_KEY)?.status).toBe('completed')
  })

  it('does not re-send when a completed attempt is replayed', async () => {
    const send = vi.fn().mockResolvedValue('sent-1')

    await makeJob(db, send).execute()
    const replay = await makeJob(db, send).execute()

    // The core guarantee of #988: the provider is invoked exactly once.
    expect(send).toHaveBeenCalledTimes(1)
    expect(replay.alreadyProcessed).toBe(true)
    expect(replay.result).toBe('sent-1')
  })

  it('lets only one of two concurrent workers send', async () => {
    const send = vi.fn().mockImplementation(
      () => new Promise<string>(resolve => setTimeout(() => resolve('sent-1'), 10))
    )

    const outcomes = await Promise.allSettled([
      makeJob(db, send).execute(),
      makeJob(db, send).execute(),
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)

    const rejected = outcomes.find(outcome => outcome.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason.message).toContain('already pending')
  })

  it('refuses to send while another worker holds a fresh claim', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['held', JOB_KEY, JOB_TYPE, 3600, 900]
    )

    const send = vi.fn().mockResolvedValue('sent-1')
    await expect(makeJob(db, send).execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })

  it('reclaims a stale pending claim left by a crashed worker', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['crashed', JOB_KEY, JOB_TYPE, 86_400, 900]
    )

    // Crashed mid-send: the claim is never released. Before this fix the row
    // stayed 'pending' for the full 24h TTL and every retry was rejected.
    db.advanceSeconds(901)

    const send = vi.fn().mockResolvedValue('sent-late')
    const result = await makeJob(db, send, 86_400, 900).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent-late')
  })

  it('does not reclaim a pending claim that is still within its lease', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['inflight', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(899)

    const send = vi.fn().mockResolvedValue('sent')
    await expect(makeJob(db, send, 86_400, 900).execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })

  it('releases the claim on failure so the next retry can send', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('provider 503'))
    await expect(makeJob(db, failing).execute()).rejects.toThrow('provider 503')
    expect(db.rows.get(JOB_KEY)?.status).toBe('failed')

    const send = vi.fn().mockResolvedValue('sent-retry')
    const result = await makeJob(db, send).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent-retry')
  })

  it('re-sends once the recorded attempt has expired', async () => {
    const send = vi.fn().mockResolvedValue('sent-1')
    await makeJob(db, send, 60).execute()

    db.advanceSeconds(61)
    await makeJob(db, send, 60).execute()

    expect(send).toHaveBeenCalledTimes(2)
  })

  it('ignores a zombie worker completing an attempt it no longer owns', async () => {
    await db.query(
      'INSERT INTO idempotent_job_attempts',
      ['zombie', JOB_KEY, JOB_TYPE, 86_400, 900]
    )
    db.advanceSeconds(901)

    const send = vi.fn().mockResolvedValue('sent-by-owner')
    await makeJob(db, send, 86_400, 900).execute()

    // The crashed worker finally reports success against its rotated-away id.
    const repo = new NotificationIdempotencyRepository(db)
    await repo.markCompleted('zombie', JSON.stringify('sent-by-zombie'))

    expect(db.rows.get(JOB_KEY)?.result).toBe(JSON.stringify('sent-by-owner'))
  })

  it('surfaces a null result for a completed attempt with no recorded payload', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    await makeJob(db, send).execute()

    const replay = await makeJob(db, send).execute()
    expect(replay.alreadyProcessed).toBe(true)
    expect(replay.result).toBeNull()
  })

  it('reports a non-Error throw as Unknown error', async () => {
    const failing = vi.fn().mockRejectedValue('string failure')
    await expect(makeJob(db, failing).execute()).rejects.toBe('string failure')
    expect(db.rows.get(JOB_KEY)?.result).toBe('Unknown error')
  })

  it('applies default TTL and claim lease via the factory', async () => {
    const send = vi.fn().mockResolvedValue('sent')
    await createIdempotentNotificationJob(db, JOB_KEY, JOB_TYPE, { run: send }).execute()

    const row = db.rows.get(JOB_KEY)
    const ttlSeconds = (row!.expires_at.getTime() - row!.attempted_at.getTime()) / 1000
    expect(ttlSeconds).toBe(24 * 60 * 60)
    expect(DEFAULT_CLAIM_TIMEOUT_SECONDS).toBe(15 * 60)
  })
})

describe('lost claim with no readable row', () => {
  it('reports a duplicate rather than sending', async () => {
    // Claim lost, then the row is swept before it can be read back. Sending here
    // would risk a duplicate, so the job must refuse.
    const emptyDb: Queryable = {
      query: async () =>
        ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) as never,
    }

    const send = vi.fn().mockResolvedValue('sent')
    const job = new IdempotentNotificationJob(emptyDb, JOB_KEY, JOB_TYPE, { run: send })

    await expect(job.execute()).rejects.toThrow('already pending')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('claim statement contract', () => {
  it('infers the conflict target from job_key alone', async () => {
    const db = new FakeIdempotencyDb()
    const repo = new NotificationIdempotencyRepository(db)

    await repo.claimAttempt({
      jobKey: JOB_KEY,
      jobType: JOB_TYPE,
      expiresInSeconds: 3600,
      claimTimeoutSeconds: 900,
    })

    const claimSql = db.statements[0]
    // A composite conflict target cannot be inferred against UNIQUE (job_key)
    // and raises Postgres 42P10 on every execution.
    expect(claimSql).toContain('ON CONFLICT (job_key) DO UPDATE')
    expect(claimSql).not.toMatch(/ON CONFLICT \([^)]*,/)
    // The guard is what prevents a concurrent claim from being overwritten.
    expect(claimSql).toContain('WHERE idempotent_job_attempts.status = \'failed\'')
    expect(claimSql).toContain('RETURNING')
  })
})
