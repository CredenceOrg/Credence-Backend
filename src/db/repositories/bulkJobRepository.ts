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

  async create(orgId: string, size: number, payload: Record<string, unknown>): Promise<BulkJobRow> {
    const { rows } = await this.db.query(
      `INSERT INTO bulk_jobs (org_id, size, payload, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [orgId, size, JSON.stringify(payload), 'pending']
    )
    return this.map(rows[0])
  }

  /**
   * Atomically claim the next queued job using WFQ ordering.
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

  async updateStatus(id: string, status: string, metadata?: Record<string, unknown>): Promise<BulkJobRow | null> {
    const { rows } = await this.db.query(
      `UPDATE bulk_jobs
       SET status = $2, payload = COALESCE($3::jsonb, payload), updated_at = NOW()
       WHERE id = $1
       RETURNING id, org_id, size, payload, status, created_at, updated_at`,
      [id, status, metadata ? JSON.stringify(metadata) : null]
    )

    return rows.length ? this.map(rows[0]) : null
  }

  async findById(id: string): Promise<BulkJobRow | null> {
    const { rows } = await this.db.query(
      `SELECT id, org_id, size, payload, status, created_at, updated_at FROM bulk_jobs WHERE id = $1`,
      [id]
    )
    return rows.length ? this.map(rows[0]) : null
  }
}

export default BulkJobRepository
