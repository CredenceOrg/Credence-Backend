/**
 * Integration tests for the notification idempotency guard against real Postgres.
 *
 * The guard's correctness rests on Postgres semantics that no in-memory fake
 * reproduces faithfully:
 *   - ON CONFLICT (job_key) inference requires a UNIQUE constraint on job_key
 *     alone, otherwise every execution raises 42P10.
 *   - The WHERE clause on DO UPDATE decides whether a concurrent claim is
 *     overwritten. pg-mem ignores it entirely.
 *
 * These therefore run only against a genuine Postgres. Set TEST_DATABASE_URL to
 * enable them; they are skipped otherwise (rather than falling back to pg-mem,
 * which would pass while proving nothing).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import {
  IdempotentNotificationJob,
  buildNotificationDeliveryJobKey,
} from '../../src/jobs/notificationIdempotency.js'

const connectionString = process.env.TEST_DATABASE_URL
const JOB_TYPE = 'notification_delivery'

describe.skipIf(!connectionString)('notification idempotency (real Postgres)', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString })
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idempotent_job_attempts (
        id TEXT PRIMARY KEY,
        job_key TEXT NOT NULL UNIQUE,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result TEXT,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  })

  afterAll(async () => {
    await pool.end()
  })

  afterEach(async () => {
    await pool.query('DELETE FROM idempotent_job_attempts')
  })

  const makeJob = (
    jobKey: string,
    send: () => Promise<string>,
    expiresInSeconds = 3600,
    claimTimeoutSeconds = 900
  ) =>
    new IdempotentNotificationJob(
      pool,
      jobKey,
      JOB_TYPE,
      { run: send },
      expiresInSeconds,
      claimTimeoutSeconds
    )

  it('claims without raising ON CONFLICT inference errors', async () => {
    const jobKey = buildNotificationDeliveryJobKey(randomUUID())
    const send = vi.fn().mockResolvedValue('sent')

    // A composite UNIQUE (job_key, expires_at) would fail here with 42P10.
    await expect(makeJob(jobKey, send).execute()).resolves.toMatchObject({
      alreadyProcessed: false,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends exactly once when many workers race on the same job', async () => {
    const jobKey = buildNotificationDeliveryJobKey(randomUUID())
    const send = vi.fn().mockImplementation(
      () => new Promise<string>(resolve => setTimeout(() => resolve('sent'), 25))
    )

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => makeJob(jobKey, send).execute())
    )

    expect(send).toHaveBeenCalledTimes(1)
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)

    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM idempotent_job_attempts WHERE job_key = $1',
      [jobKey]
    )
    expect(rows[0].count).toBe(1)
  })

  it('returns the recorded result on replay instead of re-sending', async () => {
    const jobKey = buildNotificationDeliveryJobKey(randomUUID())
    const send = vi.fn().mockResolvedValue('sent')

    await makeJob(jobKey, send).execute()
    const replay = await makeJob(jobKey, send).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(replay.alreadyProcessed).toBe(true)
    expect(replay.result).toBe('sent')
  })

  it('reclaims a claim abandoned by a crashed worker', async () => {
    const jobKey = buildNotificationDeliveryJobKey(randomUUID())

    // Simulate a worker that claimed the job 20 minutes ago and then died.
    await pool.query(
      `
      INSERT INTO idempotent_job_attempts (id, job_key, job_type, status, attempted_at, expires_at)
      VALUES ($1, $2, $3, 'pending', NOW() - INTERVAL '20 minutes', NOW() + INTERVAL '24 hours')
      `,
      [randomUUID(), jobKey, JOB_TYPE]
    )

    const send = vi.fn().mockResolvedValue('sent-after-crash')
    const result = await makeJob(jobKey, send, 86_400, 900).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent-after-crash')
  })

  it('rejects a duplicate while a fresh claim is in flight', async () => {
    const jobKey = buildNotificationDeliveryJobKey(randomUUID())

    await pool.query(
      `
      INSERT INTO idempotent_job_attempts (id, job_key, job_type, status, attempted_at, expires_at)
      VALUES ($1, $2, $3, 'pending', NOW(), NOW() + INTERVAL '24 hours')
      `,
      [randomUUID(), jobKey, JOB_TYPE]
    )

    const send = vi.fn().mockResolvedValue('sent')
    await expect(makeJob(jobKey, send, 86_400, 900).execute()).rejects.toThrow(
      'already pending'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('allows a retry after a failed attempt', async () => {
    const jobKey = buildNotificationDeliveryJobKey(randomUUID())

    const failing = vi.fn().mockRejectedValue(new Error('provider 503'))
    await expect(makeJob(jobKey, failing).execute()).rejects.toThrow('provider 503')

    const send = vi.fn().mockResolvedValue('sent-on-retry')
    const result = await makeJob(jobKey, send).execute()

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.result).toBe('sent-on-retry')
  })
})
