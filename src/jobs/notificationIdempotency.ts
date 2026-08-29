/**
 * @module jobs/notificationIdempotency
 * @description Idempotency guard for retryable notification jobs.
 *
 * A notification job may be retried or re-queued at any time (worker crash,
 * visibility-timeout expiry, manual replay).  Without a durable guard each
 * redelivery re-invokes the email provider and the recipient gets a duplicate.
 *
 * The guard is a single row in `idempotent_job_attempts` keyed by `job_key`,
 * claimed with one atomic statement:
 *
 *   INSERT ... ON CONFLICT (job_key) DO UPDATE ... WHERE <reclaimable> RETURNING
 *
 * Because the conditional upsert and the claim check are the *same* statement,
 * two workers racing on the same `job_key` cannot both win: Postgres serialises
 * them on the unique index, and only the winner gets a RETURNING row. A row is
 * reclaimable only when the previous attempt failed, its TTL lapsed, or its
 * claim went stale (see `claimTimeoutSeconds`) — a `completed` row within TTL is
 * never reclaimed, so a replayed job returns the recorded result instead of
 * sending again.
 */

import type { Queryable } from '../db/repositories/queryable.js'
import { randomUUID } from 'crypto'

export interface IdempotentJobAttempt {
  id: string
  jobKey: string
  jobType: string
  status: 'pending' | 'completed' | 'failed'
  result: string | null
  attemptedAt: Date
  completedAt: Date | null
  expiresAt: Date
}

export interface CreateIdempotentJobInput {
  jobKey: string
  jobType: string
  expiresInSeconds: number
  /**
   * How long a `pending` claim stays valid. Once this elapses the claim is
   * considered abandoned (the worker holding it crashed) and another worker may
   * reclaim it. Without this a crashed worker would block the notification for
   * the full `expiresInSeconds` TTL.
   */
  claimTimeoutSeconds: number
}

export interface IdempotentJobResult<T> {
  alreadyProcessed: boolean
  result: T | null
  attempt: IdempotentJobAttempt | null
}

const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60
/**
 * Default lease on a `pending` claim. Must comfortably exceed the worst-case
 * delivery duration (provider timeouts × failover attempts × backoff) so a
 * still-running send is never reclaimed underneath itself.
 */
export const DEFAULT_CLAIM_TIMEOUT_SECONDS = 15 * 60
export const NOTIFICATION_DELIVERY_JOB_TYPE = 'notification_delivery'

export function buildNotificationDeliveryJobKey(notificationId: string): string {
  return `${NOTIFICATION_DELIVERY_JOB_TYPE}:${notificationId}`
}

type AttemptRow = {
  id: string
  job_key: string
  job_type: string
  status: IdempotentJobAttempt['status']
  result: string | null
  attempted_at: string | Date
  completed_at: string | Date | null
  expires_at: string | Date
}

const ATTEMPT_COLUMNS = `id, job_key, job_type, status, result, attempted_at, completed_at, expires_at`

function mapAttempt(row: AttemptRow): IdempotentJobAttempt {
  return {
    id: row.id,
    jobKey: row.job_key,
    jobType: row.job_type,
    status: row.status,
    result: row.result,
    attemptedAt: new Date(row.attempted_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    expiresAt: new Date(row.expires_at),
  }
}

export class NotificationIdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Atomically claim `jobKey` for execution.
   *
   * @returns the claimed attempt when this caller won the claim, or `null` when
   * a live claim is already held (in-flight elsewhere, or completed within TTL).
   * Callers must treat `null` as "do not run the job".
   */
  async claimAttempt(input: CreateIdempotentJobInput): Promise<IdempotentJobAttempt | null> {
    const id = randomUUID()
    const result = await this.db.query<AttemptRow>(
      `
      INSERT INTO idempotent_job_attempts (
        id, job_key, job_type, status, result, attempted_at, completed_at, expires_at
      )
      VALUES ($1, $2, $3, 'pending', NULL, NOW(), NULL, NOW() + ($4 * INTERVAL '1 second'))
      ON CONFLICT (job_key) DO UPDATE SET
        -- Rotate the id so a zombie worker's markCompleted/markFailed (which
        -- targets the id it claimed) can no longer mutate the reclaimed row.
        id           = EXCLUDED.id,
        job_type     = EXCLUDED.job_type,
        status       = 'pending',
        result       = NULL,
        attempted_at = NOW(),
        completed_at = NULL,
        expires_at   = EXCLUDED.expires_at
      WHERE idempotent_job_attempts.status = 'failed'
         OR idempotent_job_attempts.expires_at <= NOW()
         OR (
              idempotent_job_attempts.status = 'pending'
              AND idempotent_job_attempts.attempted_at
                  <= NOW() - ($5 * INTERVAL '1 second')
            )
      RETURNING ${ATTEMPT_COLUMNS}
      `,
      [
        id,
        input.jobKey,
        input.jobType,
        input.expiresInSeconds,
        input.claimTimeoutSeconds,
      ]
    )

    const row = result.rows[0]
    return row ? mapAttempt(row) : null
  }

  /**
   * Read the current non-expired attempt for `jobKey`.
   * Expired rows are treated as absent — they are reclaimable.
   */
  async findAttempt(jobKey: string): Promise<IdempotentJobAttempt | null> {
    const result = await this.db.query<AttemptRow>(
      `
      SELECT ${ATTEMPT_COLUMNS}
      FROM idempotent_job_attempts
      WHERE job_key = $1 AND expires_at > NOW()
      `,
      [jobKey]
    )

    const row = result.rows[0]
    return row ? mapAttempt(row) : null
  }

  async markCompleted(attemptId: string, result: string): Promise<void> {
    await this.db.query(
      `
      UPDATE idempotent_job_attempts
      SET status = 'completed', result = $1, completed_at = NOW()
      WHERE id = $2
      `,
      [result, attemptId]
    )
  }

  /**
   * Release a claim after a failed run so the next retry can reclaim it
   * immediately rather than waiting out the stale-claim lease.
   */
  async markFailed(attemptId: string, error: string): Promise<void> {
    await this.db.query(
      `
      UPDATE idempotent_job_attempts
      SET status = 'failed', result = $1, completed_at = NOW()
      WHERE id = $2
      `,
      [error, attemptId]
    )
  }
}

export interface AsyncJob<T> {
  run(): Promise<T>
}

export class IdempotentNotificationJob<T> {
  private readonly repo: NotificationIdempotencyRepository

  constructor(
    private readonly db: Queryable,
    private readonly jobKey: string,
    private readonly jobType: string,
    private readonly job: AsyncJob<T>,
    private readonly expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
    private readonly claimTimeoutSeconds: number = DEFAULT_CLAIM_TIMEOUT_SECONDS
  ) {
    this.repo = new NotificationIdempotencyRepository(db)
  }

  async execute(): Promise<IdempotentJobResult<T>> {
    const attempt = await this.repo.claimAttempt({
      jobKey: this.jobKey,
      jobType: this.jobType,
      expiresInSeconds: this.expiresInSeconds,
      claimTimeoutSeconds: this.claimTimeoutSeconds,
    })

    if (!attempt) {
      // Lost the claim: either the work is already done, or another worker
      // holds a live claim. Never run the job in this branch.
      const current = await this.repo.findAttempt(this.jobKey)

      if (current?.status === 'completed') {
        return {
          alreadyProcessed: true,
          result: current.result ? (JSON.parse(current.result) as T) : null,
          attempt: current,
        }
      }

      throw new Error(
        `Duplicate job execution detected: job ${this.jobKey} is already pending`
      )
    }

    try {
      const result = await this.job.run()
      await this.repo.markCompleted(attempt.id, JSON.stringify(result))

      return {
        alreadyProcessed: false,
        result,
        attempt,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await this.repo.markFailed(attempt.id, errorMessage)
      throw error
    }
  }
}

export function createIdempotentNotificationJob<T>(
  db: Queryable,
  jobKey: string,
  jobType: string,
  job: AsyncJob<T>,
  expiresInSeconds?: number,
  claimTimeoutSeconds?: number
): IdempotentNotificationJob<T> {
  return new IdempotentNotificationJob(
    db,
    jobKey,
    jobType,
    job,
    expiresInSeconds,
    claimTimeoutSeconds
  )
}
