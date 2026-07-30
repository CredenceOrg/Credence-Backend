import type { Pool, PoolClient } from 'pg'

/**
 * Lifecycle status for a durable backfill progress marker.
 */
export type BackfillProgressStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'

/**
 * Persisted progress marker for a long-running backfill job.
 */
export interface BackfillProgress {
  jobName: string
  cursorValue: string
  rowsProcessed: number
  totalRows: number | null
  status: BackfillProgressStatus
  lastError: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface UpsertBackfillProgressInput {
  jobName: string
  cursorValue: string
  rowsProcessed: number
  totalRows?: number | null
  status?: BackfillProgressStatus
  lastError?: string | null
  metadata?: Record<string, unknown>
}

export interface CheckpointBackfillInput {
  jobName: string
  cursorValue: string
  rowsProcessed: number
  totalRows?: number | null
  metadata?: Record<string, unknown>
}

/** Allowed job_name pattern: alphanumeric, underscore, hyphen, colon, slash (max 128). */
const JOB_NAME_PATTERN = /^[a-zA-Z0-9_.:/-]{1,128}$/

/** Cursor values must be printable and bounded to avoid abuse. */
const MAX_CURSOR_LENGTH = 1024

/**
 * Repository for the `backfill_progress` table.
 * Provides durable checkpoint storage so backfills resume after process restarts.
 */
export class BackfillProgressRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  private map(row: Record<string, unknown>): BackfillProgress {
    const metadata = row.metadata
    return {
      jobName: row.job_name as string,
      cursorValue: row.cursor_value as string,
      rowsProcessed: Number(row.rows_processed),
      totalRows: row.total_rows == null ? null : Number(row.total_rows),
      status: row.status as BackfillProgressStatus,
      lastError: (row.last_error as string | null) ?? null,
      metadata:
        metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)
          : {},
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }
  }

  /**
   * Returns the progress marker for a job, or null if none exists.
   */
  async findByJobName(jobName: string): Promise<BackfillProgress | null> {
    this.assertValidJobName(jobName)
    const { rows } = await this.db.query(
      `SELECT job_name, cursor_value, rows_processed, total_rows, status,
              last_error, metadata, created_at, updated_at
       FROM backfill_progress
       WHERE job_name = $1`,
      [jobName],
    )
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * Lists all progress markers, most recently updated first.
   */
  async findAll(): Promise<BackfillProgress[]> {
    const { rows } = await this.db.query(
      `SELECT job_name, cursor_value, rows_processed, total_rows, status,
              last_error, metadata, created_at, updated_at
       FROM backfill_progress
       ORDER BY updated_at DESC`,
    )
    return rows.map((row) => this.map(row))
  }

  /**
   * Creates or fully replaces a progress marker (used for start / reset).
   */
  async upsert(input: UpsertBackfillProgressInput): Promise<BackfillProgress> {
    this.assertValidJobName(input.jobName)
    this.assertValidCursor(input.cursorValue)
    this.assertNonNegative(input.rowsProcessed, 'rowsProcessed')
    if (input.totalRows != null) {
      this.assertNonNegative(input.totalRows, 'totalRows')
    }

    const status = input.status ?? 'pending'
    const metadata = input.metadata ?? {}

    const { rows } = await this.db.query(
      `INSERT INTO backfill_progress (
         job_name, cursor_value, rows_processed, total_rows, status,
         last_error, metadata, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (job_name)
       DO UPDATE SET
         cursor_value = EXCLUDED.cursor_value,
         rows_processed = EXCLUDED.rows_processed,
         total_rows = EXCLUDED.total_rows,
         status = EXCLUDED.status,
         last_error = EXCLUDED.last_error,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING job_name, cursor_value, rows_processed, total_rows, status,
                 last_error, metadata, created_at, updated_at`,
      [
        input.jobName,
        input.cursorValue,
        input.rowsProcessed,
        input.totalRows ?? null,
        status,
        input.lastError ?? null,
        JSON.stringify(metadata),
      ],
    )
    return this.map(rows[0])
  }

  /**
   * Marks a job as running, preserving any existing cursor so restarts resume correctly.
   */
  async markRunning(
    jobName: string,
    options: { totalRows?: number | null; metadata?: Record<string, unknown> } = {},
  ): Promise<BackfillProgress> {
    this.assertValidJobName(jobName)
    if (options.totalRows != null) {
      this.assertNonNegative(options.totalRows, 'totalRows')
    }

    const existing = await this.findByJobName(jobName)
    return this.upsert({
      jobName,
      cursorValue: existing?.cursorValue ?? '',
      rowsProcessed: existing?.rowsProcessed ?? 0,
      totalRows: options.totalRows ?? existing?.totalRows ?? null,
      status: 'running',
      lastError: null,
      metadata: options.metadata ?? existing?.metadata ?? {},
    })
  }

  /**
   * Persists a committed batch checkpoint. Call only after the batch work has committed.
   */
  async checkpoint(input: CheckpointBackfillInput): Promise<BackfillProgress> {
    this.assertValidJobName(input.jobName)
    this.assertValidCursor(input.cursorValue)
    this.assertNonNegative(input.rowsProcessed, 'rowsProcessed')
    if (input.totalRows != null) {
      this.assertNonNegative(input.totalRows, 'totalRows')
    }

    const { rows } = await this.db.query(
      `INSERT INTO backfill_progress (
         job_name, cursor_value, rows_processed, total_rows, status,
         last_error, metadata, updated_at
       )
       VALUES ($1, $2, $3, $4, 'running', NULL, COALESCE($5::jsonb, '{}'::jsonb), NOW())
       ON CONFLICT (job_name)
       DO UPDATE SET
         cursor_value = EXCLUDED.cursor_value,
         rows_processed = EXCLUDED.rows_processed,
         total_rows = COALESCE(EXCLUDED.total_rows, backfill_progress.total_rows),
         status = 'running',
         last_error = NULL,
         metadata = CASE
           WHEN $5::jsonb IS NULL THEN backfill_progress.metadata
           ELSE EXCLUDED.metadata
         END,
         updated_at = NOW()
       RETURNING job_name, cursor_value, rows_processed, total_rows, status,
                 last_error, metadata, created_at, updated_at`,
      [
        input.jobName,
        input.cursorValue,
        input.rowsProcessed,
        input.totalRows ?? null,
        input.metadata != null ? JSON.stringify(input.metadata) : null,
      ],
    )
    return this.map(rows[0])
  }

  /**
   * Marks a backfill as successfully completed.
   */
  async markCompleted(
    jobName: string,
    options: { cursorValue?: string; rowsProcessed?: number } = {},
  ): Promise<BackfillProgress> {
    this.assertValidJobName(jobName)
    const existing = await this.findByJobName(jobName)
    if (!existing) {
      throw new Error(`Cannot complete unknown backfill job: ${jobName}`)
    }

    const cursorValue = options.cursorValue ?? existing.cursorValue
    const rowsProcessed = options.rowsProcessed ?? existing.rowsProcessed
    this.assertValidCursor(cursorValue)
    this.assertNonNegative(rowsProcessed, 'rowsProcessed')

    return this.upsert({
      jobName,
      cursorValue,
      rowsProcessed,
      totalRows: existing.totalRows,
      status: 'completed',
      lastError: null,
      metadata: existing.metadata,
    })
  }

  /**
   * Marks a backfill as failed while retaining the last committed cursor for resume.
   */
  async markFailed(jobName: string, error: string): Promise<BackfillProgress> {
    this.assertValidJobName(jobName)
    const existing = await this.findByJobName(jobName)
    if (!existing) {
      throw new Error(`Cannot fail unknown backfill job: ${jobName}`)
    }

    const safeError = error.slice(0, 2000)
    return this.upsert({
      jobName,
      cursorValue: existing.cursorValue,
      rowsProcessed: existing.rowsProcessed,
      totalRows: existing.totalRows,
      status: 'failed',
      lastError: safeError,
      metadata: existing.metadata,
    })
  }

  /**
   * Deletes a progress marker. Returns true if a row was removed.
   */
  async delete(jobName: string): Promise<boolean> {
    this.assertValidJobName(jobName)
    const { rowCount } = await this.db.query(
      `DELETE FROM backfill_progress WHERE job_name = $1`,
      [jobName],
    )
    return (rowCount ?? 0) > 0
  }

  private assertValidJobName(jobName: string): void {
    if (!JOB_NAME_PATTERN.test(jobName)) {
      throw new Error(
        `Invalid backfill job_name: ${jobName}. ` +
          `Expected 1-128 chars matching [a-zA-Z0-9_.:/-].`,
      )
    }
  }

  private assertValidCursor(cursorValue: string): void {
    if (typeof cursorValue !== 'string') {
      throw new Error('cursor_value must be a string')
    }
    if (cursorValue.length > MAX_CURSOR_LENGTH) {
      throw new Error(
        `cursor_value exceeds maximum length of ${MAX_CURSOR_LENGTH}`,
      )
    }
    // Reject NUL / control chars that could confuse operators or logs
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(cursorValue)) {
      throw new Error('cursor_value contains invalid control characters')
    }
  }

  private assertNonNegative(value: number, field: string): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`${field} must be a non-negative integer`)
    }
  }
}

export default BackfillProgressRepository
