import type { Pool, PoolClient } from 'pg'
import { getBulkWorkerPollQuery } from '../../jobs/scheduler.js'

export type BulkJobRow = {
  id: string
  org_id: string
  size: number
  payload: string
  status: string
  created_at: Date
  updated_at: Date
}

export type BulkJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export const BULK_JOB_STATUS_TRANSITIONS: Record<BulkJobStatus, readonly BulkJobStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'pending'],
  completed: [],
  failed: ['pending'],
  cancelled: [],
}

export const BULK_JOB_STATUSES: readonly BulkJobStatus[] = Object.keys(BULK_JOB_STATUS_TRANSITIONS) as BulkJobStatus[]

export function isBulkJobStatus(value: unknown): value is BulkJobStatus {
  return typeof value === 'string' && (BULK_JOB_STATUSES as readonly string[]).includes(value)
}

export function canTransition(from: BulkJobStatus, to: BulkJobStatus): boolean {
  if (from === to) return true
  return (BULK_JOB_STATUS_TRANSITIONS[from] as readonly BulkJobStatus[]).includes(to)
}

export class BulkJobRepositoryError extends Error {
  constructor(message: string, readonly code: string, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'BulkJobRepositoryError'
  }
}

export class BulkJobRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  private map(row: any): BulkJobRow {
    return {
      id: row.id,
      org_id: row.org_id,
      size: Number(row.size),
      payload: row.payload,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  /**
   * Create a new bulk job.
   *
   * Invariants:
   * - `orgId` must be a non-empty string.
   * - `size` must be a positive integer.
   * - `payload` must be a JSON-serializable object.
   * - The job is always created in the `pending` state.
   */
  async create(orgId: string, size: number, payload: Record<string, unknown>): Promise<BulkJobRow> {
    if (typeof orgId !== 'string' || orgId.trim().length === 0) {
      throw new BulkJobRepositoryError('orgId must be a non-empty string', 'INVALID_ORG_ID')
    }
    if (!Number.isInteger(size) || size <= 0) {
      throw new BulkJobRepositoryError('size must be a positive integer', 'INVALID_SIZE')
    }
    if (size > Number.MAX_SAFE_INTEGER) {
      throw new BulkJobRepositoryError('size exceeds maximum safe integer', 'INVALID_SIZE')
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BulkJobRepositoryError('payload must be a JSON object', 'INVALID_PAYLOAD')
    }

    let serialized: string
    try {
      serialized = JSON.stringify(payload)
    } catch {
      throw new BulkJobRepositoryError('payload is not JSON-serializable', 'INVALID_PAYLOAD')
    }
    if (serialized === undefined) {
      throw new BulkJobRepositoryError('payload is not JSON-serializable', 'INVALID_PAYLOAD')
    }

    const { rows } = await this.db.query(
      `INSERT INTO bulk_jobs (org_id, size, payload, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [orgId, size, serialized, 'pending']
    )
    return this.map(rows[0])
  }

  /**
   * Atomically claim the next queued job using WFQ ordering.
   *
   * Invariants:
   * - Only `pandig` jobs are eligible for claiming.
   * - The claim is atomic; concurrent callers cannot claim the same row.
   * - Returns null when no eligible job exists.
   */
  async claimNextQueuedWfq(): Promise<BulkJobRow | null> {
    // Build the selection CTE using helper SQL, then atomically update
    const pollSql = getBulkWorkerPollQuery('bulk_jobs', 'org_usage_daily')
    const sql = `WITH candidate AS (${pollSql})
      UPDATE bulk_jobs
      SET status = 'running', updated_at = NOW()
      WHERE id IN (SELECT id FROM candidate)
      RETURNING id, org_id, size, payload, status, created_at, updated_at`

    const { rows } = await this.db.query(sql)
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * Update the status of a bulk job, enforcing the state transition graph.
   *
   * Invariants:
   * - Status must be a recognized bulk job status.
   * - Transitions must be allowed by BULK_JOB_STATUS_TRANSITIONS.
   * - Terminal states (completed, cancelled) cannot be left.
   * - The update is guarded by the current status in SQL to avoid races.
   * - Returns null when the job does not exist or the transition is rejected.
   */
  async updateStatus(id: string, status: string, metadata?: Record<string, unknown>): Promise<BulkJobRow | null> {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new BulkJobRepositoryError('id must be a non-empty string', 'INVALID_ID')
    }
    if (!isBulkJobStatus(status)) {
      throw new BulkJobRepositoryError(`unknown bulk job status: ${status}`, 'INVALID_STATUS')
    }

    let metadataJson: string | null = null
    if (metadata !== undefined && metadata !== null) {
      if (typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new BulkJobRepositoryError('metadata must be a JSON object', 'INVALID_METADATA_TYPE')
      }
      try {
        metadataJson = JSON.stringify(metadata)
      } catch {
        throw new BulkJobRepositoryError('metadata is not JSON-serializable', 'INVALID_METADATA_TYPE')
      }
    }

    // Attempt the transition guarded by the current status. This avoids a read-to-update race
    // where two concurrent callers both observe the same source state and both write.
    const allowedFrom = BULK_JOB_STATUSESS.filter((candidate) => canTransition(candidate, status))
    if (allowedFrom.length === 0) {
      // Only self-transitions remain (e.g. completed -> completed); no change is possible.
      return null
    }

    const { rows } = await this.db.query(
      `UPDATE bulk_jobs
       SET status = $2, payload = COALESCE($3::jsonb, payload), updated_at = NOW()
       WHERE id = $1 AND status = ANY($4::text[])
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [id, status, metadataJson, allowedFrom]
    )

    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * Recover jobs that have been stuck in `running` past the stale timeout.
   *
   * Invariants:
   * - Only `running` jobs older than the threshold are reset to `pending`.
   * - The attempt count is incremented in the payload so operators can diagnose repeated failures.
   * - Jobs that have exhausted their attempts are marked `failed` instead of retrying forever.
   * - The operation is atomic and returns the affected rows.
   */
  async recoverStaleJobs(staleMs = 15 * 60 * 1000, maxAttempts = 5): Promise<BulkJobRow> {
    if (!Number.isFinite(staleMs) || staleMs <= 0) {
      throw new BulkJobRepositoryError('staleMs must be a positive number', 'INVALID_STALE_MS')
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new BulkJobRepositoryError('maxAttempts must be a positive integer', 'INVALID_MAX_ATTEMPTS')
    }

    const { rows } = await this.db.query(
      `UPDATE bulk_jobs
       SET status = CASE WHEN COALESCE((payload ->> 'attempts')::int, 0) + 1 >= $3 THEN 'failed' ELSE 'pending' END,
           payload = json_b_set(payload, '{attempts,error}', to_jsonb(ARRAY
[COALESCE((payload ->> 'attempts')::int, 0) + 1,
            'recovered after stale timeout'])),
           updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - make_interval(1 =: :int, 'milliseconds') * $2
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [staleMs, maxAttempts]
    )

    return rows.map((row) => this.map(row))
  }

  async findById(id: string): Promise<BulkJobRow | null> {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new BulkJobRepositoryError('id must be a non-empty string', 'INVALID_ID')
    }
    const { rows } = await this.db.query(
      `SELECT id, org_id, size, payload, status, created_at, updated_at FROM bulk_jobs WHERE id = $1`,
      [id]
    )
    return rows.length ? this.map(rows[0]) : null
  }
}

export default BulkJobRepository
