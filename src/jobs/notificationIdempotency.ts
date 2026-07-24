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
}

export interface IdempotentJobResult<T> {
  alreadyProcessed: boolean
  result: T | null
  attempt: IdempotentJobAttempt | null
}

const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60
export const NOTIFICATION_DELIVERY_JOB_TYPE = 'notification_delivery'

export function buildNotificationDeliveryJobKey(notificationId: string): string {
  return `${NOTIFICATION_DELIVERY_JOB_TYPE}:${notificationId}`
}

export class NotificationIdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  async findPendingAttempt(jobKey: string): Promise<IdempotentJobAttempt | null> {
    const result = await this.db.query<any>(
      `
      SELECT id, job_key, job_type, status, result, attempted_at, completed_at, expires_at
      FROM idempotent_job_attempts
      WHERE job_key = $1 AND expires_at > NOW()
      ORDER BY attempted_at DESC
      LIMIT 1
      `,
      [jobKey]
    )

    const row = result.rows[0]
    if (!row) return null

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

  async createAttempt(input: CreateIdempotentJobInput): Promise<IdempotentJobAttempt> {
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000)

    await this.db.query(
      `
      INSERT INTO idempotent_job_attempts (id, job_key, job_type, status, attempted_at, expires_at)
      VALUES ($1, $2, $3, 'pending', NOW(), $4)
      ON CONFLICT (job_key) DO UPDATE SET
        job_type   = EXCLUDED.job_type,
        status    = 'pending',
        result    = NULL,
        attempted_at = NOW(),
        expires_at = EXCLUDED.expires_at
      `,
      [id, input.jobKey, input.jobType, expiresAt]
    )

    return {
      id,
      jobKey: input.jobKey,
      jobType: input.jobType,
      status: 'pending',
      result: null,
      attemptedAt: new Date(),
      completedAt: null,
      expiresAt,
    }
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
    private readonly expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS
  ) {
    this.repo = new NotificationIdempotencyRepository(db)
  }

  async execute(): Promise<IdempotentJobResult<T>> {
    const existing = await this.repo.findPendingAttempt(this.jobKey)

    if (existing) {
      if (existing.status === 'completed') {
        return {
          alreadyProcessed: true,
          result: existing.result ? JSON.parse(existing.result) : null,
          attempt: existing,
        }
      }

      if (existing.status === 'pending') {
        throw new Error(
          `Duplicate job execution detected: job ${this.jobKey} is already pending`
        )
      }
    }

    const attempt = await this.repo.createAttempt({
      jobKey: this.jobKey,
      jobType: this.jobType,
      expiresInSeconds: this.expiresInSeconds,
    })

    try {
      const result = await this.job.run()
      const resultJson = JSON.stringify(result)

      await this.repo.markCompleted(attempt.id, resultJson)

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
  expiresInSeconds?: number
): IdempotentNotificationJob<T> {
  return new IdempotentNotificationJob(
    db,
    jobKey,
    jobType,
    job,
    expiresInSeconds
  )
}
