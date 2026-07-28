/**
 * Tests for durable backfill progress markers and resumable runner.
 * Covers repository persistence, resume-after-crash, and input validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import type { Pool } from 'pg'
import crypto from 'crypto'
import { BackfillProgressRepository } from '../../src/db/repositories/backfillProgressRepository.js'
import {
  ResumableBackfillRunner,
  runResumableBackfill,
} from '../../src/jobs/backfill/index.js'
import type { BackfillBatchProcessor } from '../../src/jobs/backfill/types.js'

async function createPool(): Promise<{ db: IMemoryDb; pool: Pool }> {
  const db = newDb()
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  })
  // pg-mem lacks jsonb cast convenience in some paths; register identity json helpers if needed
  const pgMock = db.adapters.createPg()
  const pool = new pgMock.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE backfill_progress (
      job_name        TEXT        PRIMARY KEY,
      cursor_value    TEXT        NOT NULL DEFAULT '',
      rows_processed  BIGINT      NOT NULL DEFAULT 0
                                CHECK (rows_processed >= 0),
      total_rows      BIGINT      CHECK (total_rows IS NULL OR total_rows >= 0),
      status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      last_error      TEXT,
      metadata        JSONB       NOT NULL DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)

  return { db, pool }
}

describe('BackfillProgressRepository', () => {
  let pool: Pool
  let repo: BackfillProgressRepository

  beforeEach(async () => {
    ;({ pool } = await createPool())
    repo = new BackfillProgressRepository(pool)
  })

  afterEach(async () => {
    await pool.end()
    vi.restoreAllMocks()
  })

  it('upserts and finds a progress marker', async () => {
    const saved = await repo.upsert({
      jobName: 'tenant_id_backfill',
      cursorValue: '100',
      rowsProcessed: 100,
      totalRows: 1000,
      status: 'running',
      metadata: { table: 'identities' },
    })

    expect(saved.jobName).toBe('tenant_id_backfill')
    expect(saved.cursorValue).toBe('100')
    expect(saved.rowsProcessed).toBe(100)
    expect(saved.totalRows).toBe(1000)
    expect(saved.status).toBe('running')
    expect(saved.metadata).toEqual({ table: 'identities' })

    const found = await repo.findByJobName('tenant_id_backfill')
    expect(found?.cursorValue).toBe('100')
    expect(found?.rowsProcessed).toBe(100)
  })

  it('checkpoints advance cursor and rows without losing total_rows', async () => {
    await repo.markRunning('score_history_backfill', { totalRows: 500 })
    const checkpointed = await repo.checkpoint({
      jobName: 'score_history_backfill',
      cursorValue: 'uuid-50',
      rowsProcessed: 50,
    })

    expect(checkpointed.status).toBe('running')
    expect(checkpointed.cursorValue).toBe('uuid-50')
    expect(checkpointed.rowsProcessed).toBe(50)
    expect(checkpointed.totalRows).toBe(500)
  })

  it('markCompleted and markFailed preserve last committed cursor', async () => {
    await repo.checkpoint({
      jobName: 'audit_hash_backfill',
      cursorValue: 'cursor-A',
      rowsProcessed: 25,
      totalRows: 100,
    })

    const failed = await repo.markFailed('audit_hash_backfill', 'connection reset')
    expect(failed.status).toBe('failed')
    expect(failed.cursorValue).toBe('cursor-A')
    expect(failed.rowsProcessed).toBe(25)
    expect(failed.lastError).toBe('connection reset')

    // Resume path: mark running again keeps cursor
    const resumed = await repo.markRunning('audit_hash_backfill')
    expect(resumed.cursorValue).toBe('cursor-A')
    expect(resumed.rowsProcessed).toBe(25)
    expect(resumed.status).toBe('running')
    expect(resumed.lastError).toBeNull()

    const completed = await repo.markCompleted('audit_hash_backfill', {
      cursorValue: 'cursor-Z',
      rowsProcessed: 100,
    })
    expect(completed.status).toBe('completed')
    expect(completed.cursorValue).toBe('cursor-Z')
  })

  it('rejects invalid job names (security)', async () => {
    await expect(
      repo.findByJobName("evil'; DROP TABLE backfill_progress; --"),
    ).rejects.toThrow(/Invalid backfill job_name/)

    await expect(
      repo.upsert({
        jobName: 'bad name with spaces',
        cursorValue: '1',
        rowsProcessed: 0,
      }),
    ).rejects.toThrow(/Invalid backfill job_name/)
  })

  it('rejects invalid cursor values and negative counts', async () => {
    await expect(
      repo.checkpoint({
        jobName: 'ok_job',
        cursorValue: 'a\u0000b',
        rowsProcessed: 1,
      }),
    ).rejects.toThrow(/control characters/)

    await expect(
      repo.upsert({
        jobName: 'ok_job',
        cursorValue: '1',
        rowsProcessed: -5,
      }),
    ).rejects.toThrow(/non-negative integer/)
  })

  it('deletes progress markers', async () => {
    await repo.upsert({
      jobName: 'temp_job',
      cursorValue: '',
      rowsProcessed: 0,
    })
    expect(await repo.delete('temp_job')).toBe(true)
    expect(await repo.findByJobName('temp_job')).toBeNull()
    expect(await repo.delete('temp_job')).toBe(false)
  })

  it('lists markers ordered by updated_at', async () => {
    await repo.upsert({ jobName: 'job_a', cursorValue: '1', rowsProcessed: 1 })
    await repo.upsert({ jobName: 'job_b', cursorValue: '2', rowsProcessed: 2 })
    const all = await repo.findAll()
    expect(all.map((m) => m.jobName)).toEqual(
      expect.arrayContaining(['job_a', 'job_b']),
    )
    expect(all[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
      all[all.length - 1].updatedAt.getTime(),
    )
  })
})

describe('ResumableBackfillRunner', () => {
  let pool: Pool

  beforeEach(async () => {
    ;({ pool } = await createPool())
  })

  afterEach(async () => {
    await pool.end()
    vi.restoreAllMocks()
  })

  function sequentialProcessor(
    items: string[],
  ): BackfillBatchProcessor {
    return async (cursor, batchSize) => {
      const startIndex = cursor === '' ? 0 : items.indexOf(cursor) + 1
      const slice = items.slice(startIndex, startIndex + batchSize)
      if (slice.length === 0) {
        return { nextCursor: cursor, processedCount: 0, done: true, totalRows: items.length }
      }
      const nextCursor = slice[slice.length - 1]
      const done = startIndex + slice.length >= items.length
      return {
        nextCursor,
        processedCount: slice.length,
        done,
        totalRows: items.length,
      }
    }
  }

  it('persists checkpoints and completes a multi-batch backfill', async () => {
    const items = Array.from({ length: 25 }, (_, i) => `id-${i}`)
    const logger = vi.fn()
    const result = await runResumableBackfill(
      pool,
      sequentialProcessor(items),
      { jobName: 'multi_batch', batchSize: 10, logger },
    )

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(25)
    expect(result.batchesProcessed).toBe(3)
    expect(result.progress.status).toBe('completed')
    expect(result.cursorValue).toBe('id-24')

    const repo = new BackfillProgressRepository(pool)
    const marker = await repo.findByJobName('multi_batch')
    expect(marker?.status).toBe('completed')
    expect(marker?.rowsProcessed).toBe(25)
  })

  it('resumes from last committed checkpoint after a crash', async () => {
    const items = Array.from({ length: 30 }, (_, i) => `row-${i}`)
    let failAfterBatches = 1
    let calls = 0

    const flaky: BackfillBatchProcessor = async (cursor, batchSize) => {
      calls += 1
      const startIndex = cursor === '' ? 0 : items.indexOf(cursor) + 1
      const slice = items.slice(startIndex, startIndex + batchSize)
      const nextCursor = slice[slice.length - 1] ?? cursor
      const done = startIndex + slice.length >= items.length

      // Simulate crash after first successful batch has been returned
      // (runner checkpoints after processor returns; we fail on 2nd call)
      if (calls > failAfterBatches) {
        throw new Error('simulated process crash')
      }

      return {
        nextCursor,
        processedCount: slice.length,
        done,
        totalRows: items.length,
      }
    }

    const first = await runResumableBackfill(pool, flaky, {
      jobName: 'crashy_job',
      batchSize: 10,
    })
    expect(first.status).toBe('failed')
    expect(first.rowsProcessed).toBe(10)
    expect(first.progress.cursorValue).toBe('row-9')

    // Second run: no more failures — should resume from row-9
    failAfterBatches = Number.POSITIVE_INFINITY
    calls = 0
    const second = await runResumableBackfill(pool, flaky, {
      jobName: 'crashy_job',
      batchSize: 10,
    })

    expect(second.status).toBe('completed')
    expect(second.resumedFromCursor).toBe('row-9')
    expect(second.rowsProcessed).toBe(30)
    // Remaining 20 rows in 2 batches of 10
    expect(second.batchesProcessed).toBe(2)
  })

  it('is a no-op when the job is already completed', async () => {
    const processor = vi.fn(async () => ({
      nextCursor: 'x',
      processedCount: 1,
      done: true,
    }))

    const repo = new BackfillProgressRepository(pool)
    await repo.upsert({
      jobName: 'done_job',
      cursorValue: 'final',
      rowsProcessed: 42,
      status: 'completed',
    })

    const result = await new ResumableBackfillRunner(pool, processor).run({
      jobName: 'done_job',
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(42)
    expect(result.batchesProcessed).toBe(0)
    expect(processor).not.toHaveBeenCalled()
  })

  it('forceRestart resets progress and reprocesses from initial cursor', async () => {
    const items = ['a', 'b', 'c', 'd']
    const repo = new BackfillProgressRepository(pool)
    await repo.upsert({
      jobName: 'restart_job',
      cursorValue: 'c',
      rowsProcessed: 3,
      status: 'completed',
    })

    const result = await runResumableBackfill(
      pool,
      sequentialProcessor(items),
      { jobName: 'restart_job', batchSize: 2, forceRestart: true },
    )

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(4)
    expect(result.resumedFromCursor).toBe('')
  })
})
