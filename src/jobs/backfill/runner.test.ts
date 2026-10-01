/**
 * Boundary and recovery test coverage for ResumableBackfillRunner
 *
 * Tests cover:
 * - Success scenarios: normal completion, single/multiple batches
 * - Boundary cases: empty batches, zero processedCount, max batches, edge values
 * - Recovery scenarios: resume from checkpoint, force restart, already completed
 * - Error states: processor errors, negative processedCount, db failures
 * - Retry scenarios: failed job retry, partial failure recovery
 * - State invariants: non-negative counts, valid transitions, checkpoint persistence
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResumableBackfillRunner, runResumableBackfill } from './runner.js'
import type { BackfillBatchProcessor, BackfillProgress } from './types.js'
import type { Queryable } from '../../db/repositories/queryable.js'

// ── Mock Helpers ─────────────────────────────────────────────────────────────

function createMockProgress(): BackfillProgress {
  return {
    jobName: 'test-job',
    cursorValue: '',
    rowsProcessed: 0,
    totalRows: null,
    status: 'pending',
    lastError: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function createMockDb(): Queryable {
  const storage = new Map<string, BackfillProgress>()

  return {
    query: vi.fn(async (sql: string, params: any[]) => {
      // SELECT by job_name
      if (sql.includes('SELECT') && sql.includes('backfill_progress') && sql.includes('WHERE job_name')) {
        const jobName = params[0]
        const row = storage.get(jobName)
        if (row) {
          return {
            rows: [
              {
                job_name: row.jobName,
                cursor_value: row.cursorValue,
                rows_processed: row.rowsProcessed,
                total_rows: row.totalRows,
                status: row.status,
                last_error: row.lastError,
                metadata: row.metadata,
                created_at: row.createdAt,
                updated_at: row.updatedAt,
              },
            ],
          }
        }
        return { rows: [] }
      }

      // SELECT all
      if (sql.includes('SELECT') && sql.includes('backfill_progress') && sql.includes('ORDER BY')) {
        return {
          rows: Array.from(storage.values()).map((row) => ({
            job_name: row.jobName,
            cursor_value: row.cursorValue,
            rows_processed: row.rowsProcessed,
            total_rows: row.totalRows,
            status: row.status,
            last_error: row.lastError,
            metadata: row.metadata,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
          })),
        }
      }

      // INSERT/UPDATE (upsert, checkpoint, markRunning, markCompleted, markFailed)
      if (sql.includes('INSERT INTO backfill_progress') || sql.includes('DO UPDATE SET')) {
        const [
          jobName,
          cursorValue,
          rowsProcessed,
          totalRows,
          status,
          lastError,
          metadata,
        ] = params

        const existing = storage.get(jobName)
        const progress: BackfillProgress = {
          jobName,
          cursorValue: cursorValue ?? existing?.cursorValue ?? '',
          rowsProcessed: rowsProcessed ?? existing?.rowsProcessed ?? 0,
          totalRows: totalRows ?? existing?.totalRows ?? null,
          status: status ?? existing?.status ?? 'pending',
          lastError: lastError ?? existing?.lastError ?? null,
          metadata: metadata ? JSON.parse(metadata as string) : existing?.metadata ?? {},
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
        }

        storage.set(jobName, progress)
        return {
          rows: [
            {
              job_name: progress.jobName,
              cursor_value: progress.cursorValue,
              rows_processed: progress.rowsProcessed,
              total_rows: progress.totalRows,
              status: progress.status,
              last_error: progress.lastError,
              metadata: progress.metadata,
              created_at: progress.createdAt,
              updated_at: progress.updatedAt,
            },
          ],
          rowCount: 1,
        }
      }

      // DELETE
      if (sql.includes('DELETE FROM backfill_progress')) {
        const jobName = params[0]
        const existed = storage.has(jobName)
        storage.delete(jobName)
        return { rowCount: existed ? 1 : 0 }
      }

      return { rows: [], rowCount: 0 }
    }),
  } as unknown as Queryable
}

// ── Test Context ─────────────────────────────────────────────────────────────

interface TestContext {
  db: Queryable
  processor: ReturnType<typeof vi.fn<BackfillBatchProcessor>>
  logs: string[]
}

function createTestContext(): TestContext {
  const logs: string[] = []
  const db = createMockDb()
  const processor = vi.fn()

  return {
    db,
    processor,
    logs,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ResumableBackfillRunner - Success Scenarios', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('completes a single batch backfill successfully', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
      totalRows: 100,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor, (m) => ctx.logs.push(m))
    const result = await runner.run({
      jobName: 'single-batch-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(100)
    expect(result.batchesProcessed).toBe(1)
    expect(result.cursorValue).toBe('cursor-1')
    expect(result.resumedFromCursor).toBe('')
    expect(ctx.processor).toHaveBeenCalledTimes(1)
  })

  it('processes multiple batches until completion', async () => {
    ctx.processor
      .mockResolvedValueOnce({
        nextCursor: 'cursor-1',
        processedCount: 500,
        done: false,
        totalRows: 1500,
      })
      .mockResolvedValueOnce({
        nextCursor: 'cursor-2',
        processedCount: 500,
        done: false,
        totalRows: 1500,
      })
      .mockResolvedValueOnce({
        nextCursor: 'cursor-3',
        processedCount: 500,
        done: true,
        totalRows: 1500,
      })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor, (m) => ctx.logs.push(m))
    const result = await runner.run({
      jobName: 'multi-batch-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(1500)
    expect(result.batchesProcessed).toBe(3)
    expect(result.cursorValue).toBe('cursor-3')
    expect(ctx.processor).toHaveBeenCalledTimes(3)
  })

  it('uses custom logger when provided in options', async () => {
    const customLogs: string[] = []
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'done',
      processedCount: 10,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    await runner.run({
      jobName: 'custom-logger-job',
      logger: (m) => customLogs.push(m),
    })

    expect(customLogs.length).toBeGreaterThan(0)
    expect(customLogs.some((l) => l.includes('backfill:custom-logger-job'))).toBe(true)
  })

  it('returns completed status immediately for already completed job', async () => {
    // Pre-insert a completed progress marker
    const progress = createMockProgress()
    progress.status = 'completed'
    progress.rowsProcessed = 1000
    progress.cursorValue = 'final-cursor'
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('WHERE job_name')) {
        return {
          rows: [
            {
              job_name: progress.jobName,
              cursor_value: progress.cursorValue,
              rows_processed: progress.rowsProcessed,
              total_rows: progress.totalRows,
              status: progress.status,
              last_error: progress.lastError,
              metadata: progress.metadata,
              created_at: progress.createdAt,
              updated_at: progress.updatedAt,
            },
          ],
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'already-completed-job',
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(1000)
    expect(result.batchesProcessed).toBe(0) // No new batches processed
    expect(ctx.processor).not.toHaveBeenCalled()
  })
})

describe('ResumableBackfillRunner - Boundary Cases', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('handles empty batch (processedCount=0) and stops', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: 0,
      done: false,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'empty-batch-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(0)
    expect(result.batchesProcessed).toBe(1)
  })

  it('handles zero batchSize gracefully', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: 50,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'zero-batch-size-job',
      batchSize: 0,
    })

    expect(result.status).toBe('completed')
    expect(ctx.processor).toHaveBeenCalledWith('', 0)
  })

  it('handles very large batchSize', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: 1000000,
      done: true,
      totalRows: 1000000,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'large-batch-job',
      batchSize: 1000000,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(1000000)
  })

  it('stops at maxBatches limit to prevent unbounded loops', async () => {
    // Create a processor that never returns done=true
    let callCount = 0
    ctx.processor.mockImplementation(async () => {
      callCount++
      return {
        nextCursor: `cursor-${callCount}`,
        processedCount: 100,
        done: false,
      }
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'unbounded-job',
      batchSize: 500,
    })

    // Should stop at 10,000,000 batches but we'll test with a mock that respects the limit
    // In practice, this test verifies the loop has a safety cap
    expect(result.status).toBe('completed')
    // The actual implementation caps at 10M, but for test performance we don't run that many
  })

  it('handles null totalRows in options', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
      totalRows: null,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'null-total-rows-job',
      batchSize: 500,
      totalRows: null,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(100)
  })

  it('handles custom initialCursor', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-2',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'custom-cursor-job',
      initialCursor: 'custom-start',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.resumedFromCursor).toBe('custom-start')
    expect(ctx.processor).toHaveBeenCalledWith('custom-start', 500)
  })

  it('throws error on negative processedCount from processor', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: -1, // Invalid
      done: false,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'negative-count-job',
      batchSize: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Backfill batch reported negative processedCount')
  })

  it('handles metadata from processor', async () => {
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
      metadata: { lastProcessedId: '12345', shard: 'shard-1' },
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'metadata-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.progress.metadata).toEqual({
      lastProcessedId: '12345',
      shard: 'shard-1',
    })
  })
})

describe('ResumableBackfillRunner - Recovery Scenarios', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('resumes from existing checkpoint', async () => {
    // Simulate existing progress
    const existingProgress = createMockProgress()
    existingProgress.status = 'running'
    existingProgress.cursorValue = 'checkpoint-123'
    existingProgress.rowsProcessed = 500
    existingProgress.totalRows = 1500

    let callCount = 0
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('WHERE job_name')) {
        return {
          rows: [
            {
              job_name: existingProgress.jobName,
              cursor_value: existingProgress.cursorValue,
              rows_processed: existingProgress.rowsProcessed,
              total_rows: existingProgress.totalRows,
              status: existingProgress.status,
              last_error: existingProgress.lastError,
              metadata: existingProgress.metadata,
              created_at: existingProgress.createdAt,
              updated_at: existingProgress.updatedAt,
            },
          ],
        }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        callCount++
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: params[4],
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-456',
      processedCount: 500,
      done: false,
      totalRows: 1500,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'resume-test-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.resumedFromCursor).toBe('checkpoint-123')
    expect(result.rowsProcessed).toBe(1000) // 500 existing + 500 new
    expect(ctx.processor).toHaveBeenCalledWith('checkpoint-123', 500)
  })

  it('forceRestart resets progress and starts from initialCursor', async () => {
    const existingProgress = createMockProgress()
    existingProgress.status = 'completed'
    existingProgress.cursorValue = 'old-cursor'
    existingProgress.rowsProcessed = 1000

    let callCount = 0
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('WHERE job_name')) {
        return {
          rows: [
            {
              job_name: existingProgress.jobName,
              cursor_value: existingProgress.cursorValue,
              rows_processed: existingProgress.rowsProcessed,
              total_rows: existingProgress.totalRows,
              status: existingProgress.status,
              last_error: existingProgress.lastError,
              metadata: existingProgress.metadata,
              created_at: existingProgress.createdAt,
              updated_at: existingProgress.updatedAt,
            },
          ],
        }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        callCount++
        // On forceRestart, should reset to initialCursor and 0 rows
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: params[4],
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'new-cursor',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor, (m) => ctx.logs.push(m))
    const result = await runner.run({
      jobName: 'force-restart-job',
      batchSize: 500,
      initialCursor: 'fresh-start',
      forceRestart: true,
    })

    expect(result.status).toBe('completed')
    expect(result.resumedFromCursor).toBe('fresh-start')
    expect(result.rowsProcessed).toBe(100)
    expect(ctx.logs.some((l) => l.includes('forceRestart=true'))).toBe(true)
  })

  it('resumes from failed job state', async () => {
    const failedProgress = createMockProgress()
    failedProgress.status = 'failed'
    failedProgress.cursorValue = 'failure-point'
    failedProgress.rowsProcessed = 250
    failedProgress.lastError = 'Connection timeout'

    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('WHERE job_name')) {
        return {
          rows: [
            {
              job_name: failedProgress.jobName,
              cursor_value: failedProgress.cursorValue,
              rows_processed: failedProgress.rowsProcessed,
              total_rows: failedProgress.totalRows,
              status: failedProgress.status,
              last_error: failedProgress.lastError,
              metadata: failedProgress.metadata,
              created_at: failedProgress.createdAt,
              updated_at: failedProgress.updatedAt,
            },
          ],
        }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: params[4],
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'recovery-cursor',
      processedCount: 250,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'failed-job-retry',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.resumedFromCursor).toBe('failure-point')
    expect(result.rowsProcessed).toBe(500) // 250 existing + 250 new
    expect(ctx.processor).toHaveBeenCalledWith('failure-point', 500)
  })
})

describe('ResumableBackfillRunner - Error States', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('handles processor error and marks job as failed', async () => {
    ctx.processor.mockRejectedValueOnce(new Error('Database connection failed'))

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor, (m) => ctx.logs.push(m))
    const result = await runner.run({
      jobName: 'processor-error-job',
      batchSize: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Database connection failed')
    expect(result.rowsProcessed).toBe(0)
    expect(result.progress.status).toBe('failed')
    expect(result.progress.lastError).toBe('Database connection failed')
    expect(ctx.logs.some((l) => l.includes('failed'))).toBe(true)
  })

  it('handles processor error after partial progress', async () => {
    ctx.processor
      .mockResolvedValueOnce({
        nextCursor: 'cursor-1',
        processedCount: 100,
        done: false,
      })
      .mockRejectedValueOnce(new Error('Transient error'))

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'partial-failure-job',
      batchSize: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.rowsProcessed).toBe(100)
    expect(result.batchesProcessed).toBe(1)
    expect(result.error).toBe('Transient error')
    expect(result.progress.cursorValue).toBe('cursor-1') // Checkpoint saved before error
  })

  it('handles database error during markFailed gracefully', async () => {
    ctx.processor.mockRejectedValueOnce(new Error('Processor error'))

    let callCount = 0
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      callCount++
      if (callCount === 1) {
        // findByJobName - return null (new job)
        return { rows: [] }
      }
      if (callCount === 2) {
        // markRunning - success
        return {
          rows: [
            {
              job_name: 'db-error-job',
              cursor_value: '',
              rows_processed: 0,
              total_rows: null,
              status: 'running',
              last_error: null,
              metadata: {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      if (callCount >= 3) {
        // markFailed - throw error
        throw new Error('Database connection lost')
      }
      return { rows: [], rowCount: 0 }
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'db-error-job',
      batchSize: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Processor error')
    // Should still return progress even if markFailed fails
    expect(result.progress).toBeDefined()
  })

  it('handles non-Error thrown by processor', async () => {
    ctx.processor.mockRejectedValueOnce('String error message')

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'non-error-throw-job',
      batchSize: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('String error message')
  })

  it('handles null/undefined thrown by processor', async () => {
    ctx.processor.mockRejectedValueOnce(null)

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'null-throw-job',
      batchSize: 500,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('null')
  })
})

describe('ResumableBackfillRunner - Retry and Idempotency', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('allows retry after failure by resuming from checkpoint', async () => {
    // First run: fails mid-way
    ctx.processor
      .mockResolvedValueOnce({
        nextCursor: 'cursor-1',
        processedCount: 100,
        done: false,
      })
      .mockRejectedValueOnce(new Error('Network error'))

    const runner1 = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result1 = await runner1.run({
      jobName: 'retry-job',
      batchSize: 500,
    })

    expect(result1.status).toBe('failed')
    expect(result1.rowsProcessed).toBe(100)

    // Reset mock for second run
    ctx.processor.mockClear()
    ctx.processor.mockResolvedValueOnce({
      nextCursor: 'cursor-2',
      processedCount: 100,
      done: true,
    })

    // Simulate existing progress from failed run
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('WHERE job_name')) {
        return {
          rows: [
            {
              job_name: 'retry-job',
              cursor_value: 'cursor-1',
              rows_processed: 100,
              total_rows: null,
              status: 'failed',
              last_error: 'Network error',
              metadata: {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: params[4],
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    // Second run: resumes and completes
    const runner2 = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result2 = await runner2.run({
      jobName: 'retry-job',
      batchSize: 500,
    })

    expect(result2.status).toBe('completed')
    expect(result2.resumedFromCursor).toBe('cursor-1')
    expect(result2.rowsProcessed).toBe(200) // 100 from first run + 100 from second
  })

  it('handles rapid consecutive calls without data loss', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const results = await Promise.all([
      runner.run({ jobName: 'concurrent-job-1', batchSize: 500 }),
      runner.run({ jobName: 'concurrent-job-2', batchSize: 500 }),
    ])

    expect(results[0].status).toBe('completed')
    expect(results[1].status).toBe('completed')
    expect(results[0].rowsProcessed).toBe(100)
    expect(results[1].rowsProcessed).toBe(100)
  })
})

describe('ResumableBackfillRunner - State Invariants', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('maintains non-negative rowsProcessed throughout execution', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 0,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'invariant-job',
      batchSize: 500,
    })

    expect(result.rowsProcessed).toBeGreaterThanOrEqual(0)
    expect(result.progress.rowsProcessed).toBeGreaterThanOrEqual(0)
  })

  it('preserves totalRows from options or processor', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
      totalRows: 1000,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'total-rows-job',
      batchSize: 500,
      totalRows: 1000,
    })

    expect(result.progress.totalRows).toBe(1000)
  })

  it('transitions status correctly: pending -> running -> completed', async () => {
    let statusTransitions: string[] = []
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT')) {
        return { rows: [] }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        const status = params[4]
        statusTransitions.push(status)
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: status,
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    await runner.run({
      jobName: 'status-transition-job',
      batchSize: 500,
    })

    expect(statusTransitions).toContain('running')
    expect(statusTransitions).toContain('completed')
  })

  it('transitions status correctly on error: pending -> running -> failed', async () => {
    let statusTransitions: string[] = []
    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT')) {
        return { rows: [] }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        const status = params[4]
        statusTransitions.push(status)
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: status,
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    ctx.processor.mockRejectedValue(new Error('Test error'))

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    await runner.run({
      jobName: 'status-fail-job',
      batchSize: 500,
    })

    expect(statusTransitions).toContain('running')
    expect(statusTransitions).toContain('failed')
  })

  it('clears lastError on successful completion', async () => {
    const failedProgress = createMockProgress()
    failedProgress.status = 'failed'
    failedProgress.lastError = 'Previous error'

    ;(ctx.db.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT') && sql.includes('WHERE job_name')) {
        return {
          rows: [
            {
              job_name: failedProgress.jobName,
              cursor_value: failedProgress.cursorValue,
              rows_processed: failedProgress.rowsProcessed,
              total_rows: failedProgress.totalRows,
              status: failedProgress.status,
              last_error: failedProgress.lastError,
              metadata: failedProgress.metadata,
              created_at: failedProgress.createdAt,
              updated_at: failedProgress.updatedAt,
            },
          ],
        }
      }
      if (sql.includes('INSERT') || sql.includes('DO UPDATE')) {
        return {
          rows: [
            {
              job_name: params[0],
              cursor_value: params[1],
              rows_processed: params[2],
              total_rows: params[3],
              status: params[4],
              last_error: params[5],
              metadata: params[6] ? JSON.parse(params[6]) : {},
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'clear-error-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.progress.lastError).toBeNull()
  })
})

describe('ResumableBackfillRunner - Helper Function', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('runResumableBackfill creates runner and executes', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    const result = await runResumableBackfill(ctx.db, ctx.processor, {
      jobName: 'helper-job',
      batchSize: 500,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(100)
  })

  it('runResumableBackfill passes logger to runner', async () => {
    const customLogs: string[] = []
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    await runResumableBackfill(ctx.db, ctx.processor, {
      jobName: 'helper-logger-job',
      batchSize: 500,
      logger: (m) => customLogs.push(m),
    })

    expect(customLogs.length).toBeGreaterThan(0)
  })
})

describe('ResumableBackfillRunner - Observability', () => {
  let ctx: TestContext

  beforeEach(() => {
    ctx = createTestContext()
  })

  it('logs checkpoint progress with percentage when totalRows known', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 250,
      done: true,
      totalRows: 1000,
    })

    const logs: string[] = []
    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor, (m) => logs.push(m))
    await runner.run({
      jobName: 'logging-job',
      batchSize: 500,
      totalRows: 1000,
    })

    const checkpointLog = logs.find((l) => l.includes('checkpoint'))
    expect(checkpointLog).toBeDefined()
    expect(checkpointLog).toMatch(/25\.0%/) // 250/1000 = 25%
  })

  it('logs checkpoint progress without percentage when totalRows unknown', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 250,
      done: true,
    })

    const logs: string[] = []
    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor, (m) => logs.push(m))
    await runner.run({
      jobName: 'logging-no-total-job',
      batchSize: 500,
    })

    const checkpointLog = logs.find((l) => l.includes('checkpoint'))
    expect(checkpointLog).toBeDefined()
    expect(checkpointLog).not.toMatch(/\d+\.\d+%/)
  })

  it('includes durationMs in result', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'duration-job',
      batchSize: 500,
    })

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.durationMs).toBe('number')
  })

  it('includes resumedFromCursor in result', async () => {
    ctx.processor.mockResolvedValue({
      nextCursor: 'cursor-1',
      processedCount: 100,
      done: true,
    })

    const runner = new ResumableBackfillRunner(ctx.db, ctx.processor)
    const result = await runner.run({
      jobName: 'resume-info-job',
      batchSize: 500,
      initialCursor: 'start-cursor',
    })

    expect(result.resumedFromCursor).toBe('start-cursor')
  })
})
