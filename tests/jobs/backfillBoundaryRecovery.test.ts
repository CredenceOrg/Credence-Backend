/**
 * Boundary and recovery coverage for the resumable backfill module
 * (src/jobs/backfill/index.ts and the progress repository it depends on).
 *
 * The companion file `backfillProgress.test.ts` covers the happy path
 * (multi-batch completion, crash/resume, forceRestart, basic validation).
 * This file focuses on the edges that protect user data under adverse
 * conditions:
 *
 *  - empty / single-row / zero-total backfills
 *  - invalid batch results (negative counts, oversized or unsafe cursors)
 *  - recovery from stale, failed and mid-flight crash markers
 *  - durability of the progress marker when the *store* fails
 *   (checkpoint failure, markFailed failure) rather than the processor
 *  - concurrent execution of the same job
 *  - diagnosability: job name and failure reason must reach the logs
 *
 * Invariants asserted here (see src/jobs/backfill/runner.ts):
 *  I1. The durable cursor never runs ahead of the last committed batch.
 *  I2. A failure never rewinds the durable marker; the last committed
 *      checkpoint is always retained so the job can resume.
 *  I3. `rows_processed` is never negative.
 *  I4. A completed job is a no-op unless `forceRestart` is set.
 *  I5. Every terminal state (completed/failed) is diagnosable from the log.
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

/** Builds a string containing control characters without literal escapes. */
const ctrl = (code: number): string => `a${String.fromCharCode(code)}b`

async function createPool(): Promise<{ db: IMemoryDb; pool: Pool }> {
  const db = newDb()
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  })
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

/**
 * Walks a fixed list of ids, one page per call, and reports
 * `processedCount: 0` once the list is exhausted.
 */
function listProcessor(items: string[]): BackfillBatchProcessor {
  return async (cursor, batchSize) => {
    const startIndex = cursor === '' ? 0 : items.indexOf(cursor) + 1
    const slice = items.slice(startIndex, startIndex + Math.max(batchSize, 1))
    if (slice.length === 0) {
      return {
        nextCursor: cursor,
        processedCount: 0,
        done: true,
        totalRows: items.length,
      }
    }
    return {
      nextCursor: slice[slice.length - 1],
      processedCount: slice.length,
      done: startIndex + slice.length >= items.length,
      totalRows: items.length,
    }
  }
}

describe('backfill boundaries — progress marker input validation', () => {
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

  it('accepts a job name at the 128-char limit and rejects 129', async () => {
    const atLimit = 'j'.repeat(128)
    await expect(
      repo.upsert({ jobName: atLimit, cursorValue: '', rowsProcessed: 0 }),
    ).resolves.toMatchObject({ jobName: atLimit })

    await expect(
      repo.upsert({ jobName: 'j'.repeat(129), cursorValue: '', rowsProcessed: 0 }),
    ).rejects.toThrow(/Invalid backfill job_name/)
  })

  it('rejects an empty job name', async () => {
    await expect(repo.findByJobName('')).rejects.toThrow(
      /Invalid backfill job_name/,
    )
  })

  it('rejects job names with whitespace, quotes or SQL metacharacters', async () => {
    const hostile = [
      'job name',
      "job'; DROP TABLE backfill_progress; --",
      'job\nsecond-line',
      'job\tname',
      'job(name)',
      'job name with spaces and $1',
    ]
    for (const jobName of hostile) {
      await expect(repo.findByJobName(jobName)).rejects.toThrow(
        /Invalid backfill job_name/,
      )
    }

    // Validation happens before any query, so the table is still intact.
    await expect(
      repo.upsert({ jobName: 'sanity_job', cursorValue: '', rowsProcessed: 0 }),
    ).resolves.toMatchObject({ jobName: 'sanity_job' })
  })

  it('accepts a cursor at the 1024-char limit and rejects 1025', async () => {
    const atLimit = 'c'.repeat(1024)
    await expect(
      repo.checkpoint({
        jobName: 'cursor_job',
        cursorValue: atLimit,
        rowsProcessed: 1,
      }),
    ).resolves.toMatchObject({ cursorValue: atLimit })

    await expect(
      repo.checkpoint({
        jobName: 'cursor_job',
        cursorValue: 'c'.repeat(1025),
        rowsProcessed: 1,
      }),
    ).rejects.toThrow(/exceeds maximum length of 1024/)
  })

  it('rejects cursor control characters but round-trips printable unicode', async () => {
    // Mirrors the guard in the repository: NUL and C0 controls (except
    // tab / LF / CR) are refused so cursors stay safe in logs and URLs.
    for (const code of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f]) {
      await expect(
        repo.checkpoint({
          jobName: 'ctrl_job',
          cursorValue: ctrl(code),
          rowsProcessed: 1,
        }),
      ).rejects.toThrow(/control characters/)
    }

    const unicode = 'категория-42-✅'
    await expect(
      repo.checkpoint({
        jobName: 'ctrl_job',
        cursorValue: unicode,
        rowsProcessed: 1,
      }),
    ).resolves.toMatchObject({ cursorValue: unicode })
  })

  it('rejects negative, fractional and non-finite row counts', async () => {
    for (const rowsProcessed of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        repo.upsert({ jobName: 'count_job', cursorValue: '', rowsProcessed }),
      ).rejects.toThrow(/non-negative integer/)
    }

    await expect(
      repo.checkpoint({
        jobName: 'count_job',
        cursorValue: '1',
        rowsProcessed: 0,
        totalRows: -3,
      }),
    ).rejects.toThrow(/non-negative integer/)
  })

  it('treats totalRows of 0 as a known zero, not as unknown', async () => {
    const marked = await repo.markRunning('empty_total', { totalRows: 0 })
    expect(marked.totalRows).toBe(0)

    // A checkpoint that omits totalRows must preserve the 0, not fall
    // back to null.
    const checkpointed = await repo.checkpoint({
      jobName: 'empty_total',
      cursorValue: 'c1',
      rowsProcessed: 0,
    })
    expect(checkpointed.totalRows).toBe(0)
  })

  it('preserves totalRows and metadata when a checkpoint omits them', async () => {
    await repo.checkpoint({
      jobName: 'preserve_job',
      cursorValue: 'c1',
      rowsProcessed: 10,
      totalRows: 100,
      metadata: { table: 'identities' },
    })

    const next = await repo.checkpoint({
      jobName: 'preserve_job',
      cursorValue: 'c2',
      rowsProcessed: 20,
    })
    expect(next.totalRows).toBe(100)
    expect(next.metadata).toEqual({ table: 'identities' })

    const replaced = await repo.checkpoint({
      jobName: 'preserve_job',
      cursorValue: 'c3',
      rowsProcessed: 30,
      metadata: { table: 'scores' },
    })
    expect(replaced.metadata).toEqual({ table: 'scores' })
  })

  it('refuses to complete or fail a job that has no marker', async () => {
    await expect(repo.markCompleted('ghost_job')).rejects.toThrow(
      /Cannot complete unknown backfill job: ghost_job/,
    )
    await expect(repo.markFailed('ghost_job', 'boom')).rejects.toThrow(
      /Cannot fail unknown backfill job: ghost_job/,
    )
  })

  it('truncates a persisted error message to 2000 characters', async () => {
    await repo.checkpoint({
      jobName: 'long_error',
      cursorValue: 'c1',
      rowsProcessed: 1,
    })
    const failed = await repo.markFailed('long_error', 'e'.repeat(5000))
    expect(failed.status).toBe('failed')
    expect(failed.lastError).toHaveLength(2000)
  })

  it('returns null / false / empty list for unknown jobs instead of throwing', async () => {
    expect(await repo.findByJobName('never_seen')).toBeNull()
    expect(await repo.delete('never_seen')).toBe(false)
    expect(await repo.findAll()).toEqual([])
  })

  it('normalises a non-object metadata column to an empty object', async () => {
    await pool.query(
      `INSERT INTO backfill_progress (job_name, cursor_value, rows_processed, status, metadata)
       VALUES ('odd_meta', 'c1', 1, 'running', '[]'::jsonb)`,
    )
    const marker = await repo.findByJobName('odd_meta')
    expect(marker?.metadata).toEqual({})
  })
})

describe('backfill boundaries and recovery — runner', () => {
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

  it('completes an empty backfill without processing a single row', async () => {
    const processor = vi.fn(listProcessor([]))
    const result = await runResumableBackfill(pool, processor, {
      jobName: 'empty_job',
      batchSize: 10,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(0)
    expect(result.cursorValue).toBe('')
    // One call is still made: the runner must learn that there is no work.
    expect(processor).toHaveBeenCalledTimes(1)
    expect(result.progress.status).toBe('completed')
    expect(result.progress.totalRows).toBe(0)
  })

  it('stops on a zero-length batch even when done is false', async () => {
    // A buggy processor reporting no progress must not spin forever.
    const processor = vi.fn(async (cursor: string) => ({
      nextCursor: `${cursor}x`,
      processedCount: 0,
      done: false,
      totalRows: 10,
    }))

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'zero_progress',
    })

    expect(processor).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(0)
  })

  it('completes a single-row backfill in exactly one batch', async () => {
    const result = await runResumableBackfill(pool, listProcessor(['only']), {
      jobName: 'single_row',
      batchSize: 500,
    })
    expect(result.status).toBe('completed')
    expect(result.batchesProcessed).toBe(1)
    expect(result.rowsProcessed).toBe(1)
  })

  it('defaults batchSize to 500 and forwards the resume cursor to the processor', async () => {
    const seen: Array<{ cursor: string; batchSize: number }> = []
    const processor: BackfillBatchProcessor = async (cursor, batchSize) => {
      seen.push({ cursor, batchSize })
      return seen.length === 1
        ? { nextCursor: 'c1', processedCount: 5, done: false, totalRows: 10 }
        : { nextCursor: 'c2', processedCount: 5, done: true, totalRows: 10 }
    }

    await runResumableBackfill(pool, processor, { jobName: 'default_batch' })

    expect(seen).toEqual([
      { cursor: '', batchSize: 500 },
      { cursor: 'c1', batchSize: 500 },
    ])
  })

  it('passes the caller-supplied initialCursor on a fresh job', async () => {
    const processor = vi.fn(async () => ({
      nextCursor: 'c9',
      processedCount: 1,
      done: true,
    }))
    const result = await runResumableBackfill(pool, processor, {
      jobName: 'seeded_cursor',
      initialCursor: 'seed',
    })
    expect(processor).toHaveBeenCalledWith('seed', 500)
    expect(result.resumedFromCursor).toBe('seed')
  })

  it('rejects a batch that reports a negative processedCount', async () => {
    const processor = vi.fn(async () => ({
      nextCursor: 'c1',
      processedCount: -1,
      done: true,
    }))

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'negative_batch',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/negative processedCount/)
    // I3: the negative count is never accumulated into the durable marker.
    expect(result.rowsProcessed).toBe(0)
    const marker = await repo.findByJobName('negative_batch')
    expect(marker?.rowsProcessed).toBe(0)
    expect(marker?.status).toBe('failed')
  })

  it('fails the job when a batch tries to persist an oversized cursor', async () => {
    const processor = vi.fn(async () => ({
      nextCursor: 'z'.repeat(1025),
      processedCount: 1,
      done: true,
    }))

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'huge_cursor',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/exceeds maximum length of 1024/)
    const marker = await repo.findByJobName('huge_cursor')
    expect(marker?.cursorValue).toBe('')
    expect(marker?.rowsProcessed).toBe(0)
  })

  it('fails the job when the processor throws on the very first batch', async () => {
    const logger = vi.fn()
    const processor = vi.fn(async () => {
      throw new Error('connection reset by peer')
    })

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'fail_first',
      logger,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('connection reset by peer')
    expect(result.batchesProcessed).toBe(0)
    expect(result.cursorValue).toBe('')

    const marker = await repo.findByJobName('fail_first')
    expect(marker?.status).toBe('failed')
    expect(marker?.lastError).toBe('connection reset by peer')
    // I5: the failure is diagnosable from the log alone.
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('failed — connection reset by peer'),
    )
  })

  it('stringifies a non-Error rejection so the reason is still recorded', async () => {
    const processor = vi.fn(async () => {
      throw 'plain string failure'
    })

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'string_throw',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('plain string failure')
    const marker = await repo.findByJobName('string_throw')
    expect(marker?.lastError).toBe('plain string failure')
  })

  it('resumes a stale running marker left behind by a crashed process', async () => {
    // The previous process died mid-run: status is still "running" and the
    // cursor points at the last committed batch.
    await repo.upsert({
      jobName: 'stale_running',
      cursorValue: 'id-4',
      rowsProcessed: 5,
      totalRows: 12,
      status: 'running',
      lastError: null,
    })

    const items = Array.from({ length: 12 }, (_, i) => `id-${i}`)
    const result = await runResumableBackfill(pool, listProcessor(items), {
      jobName: 'stale_running',
      batchSize: 4,
    })

    expect(result.status).toBe('completed')
    expect(result.resumedFromCursor).toBe('id-4')
    // Rows are cumulative across the crash, not re-counted from zero.
    expect(result.rowsProcessed).toBe(12)
    expect(result.progress.status).toBe('completed')
  })

  it('resumes a failed marker and clears the stale error', async () => {
    await repo.upsert({
      jobName: 'resume_failed',
      cursorValue: 'id-1',
      rowsProcessed: 2,
      status: 'failed',
      lastError: 'previous outage',
    })

    const items = ['id-0', 'id-1', 'id-2']
    const result = await runResumableBackfill(pool, listProcessor(items), {
      jobName: 'resume_failed',
      batchSize: 2,
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(3)
    expect(result.progress.lastError).toBeNull()
  })

  it('keeps the last committed cursor when the store rejects a checkpoint', async () => {
    // Recovery case: the processor succeeds but the checkpoint write fails.
    // I1/I2: the durable marker must stay at the previous checkpoint so the
    // batch is replayed (at-least-once) rather than silently skipped.
    const original = repo.checkpoint.bind(repo)
    let checkpoints = 0
    vi.spyOn(BackfillProgressRepository.prototype, 'checkpoint').mockImplementation(
      async (input) => {
        checkpoints += 1
        if (checkpoints === 2) {
          throw new Error('deadlock detected')
        }
        return original(input)
      },
    )

    const items = Array.from({ length: 6 }, (_, i) => `row-${i}`)
    const result = await runResumableBackfill(pool, listProcessor(items), {
      jobName: 'checkpoint_fail',
      batchSize: 2,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('deadlock detected')

    const marker = await repo.findByJobName('checkpoint_fail')
    expect(marker?.status).toBe('failed')
    expect(marker?.lastError).toBe('deadlock detected')
    // Durable cursor is the last *committed* batch, never ahead of it.
    expect(marker?.cursorValue).toBe('row-1')
    expect(marker?.rowsProcessed).toBe(2)
  })

  it('still reports failure when markFailed itself fails', async () => {
    // Recovery case: both the batch and error persistence fail. The runner
    // must not throw; it falls back to the last in-memory snapshot so the
    // caller still learns the job failed.
    vi.spyOn(BackfillProgressRepository.prototype, 'markFailed').mockRejectedValue(
      new Error('db unavailable'),
    )

    const items = Array.from({ length: 4 }, (_, i) => `row-${i}`)
    const walk = listProcessor(items)
    const processor: BackfillBatchProcessor = async (cursor, batchSize) => {
      if (cursor === 'row-1') {
        throw new Error('processor blew up')
      }
      return walk(cursor, batchSize)
    }

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'mark_failed_broken',
      batchSize: 2,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('processor blew up')
    expect(result.rowsProcessed).toBe(2)
    // Falls back to the last in-memory snapshot it holds.
    expect(result.progress.status).toBe('running')
    expect(result.progress.cursorValue).toBe('row-1')
    expect(result.progress.rowsProcessed).toBe(2)
  })

  it('propagates a setup failure before any work is processed', async () => {
    vi.spyOn(BackfillProgressRepository.prototype, 'markRunning').mockRejectedValue(
      new Error('cannot acquire marker'),
    )
    const processor = vi.fn(listProcessor(['a']))

    await expect(
      runResumableBackfill(pool, processor, { jobName: 'setup_fail' }),
    ).rejects.toThrow(/cannot acquire marker/)
    expect(processor).not.toHaveBeenCalled()
  })

  it('rejects an invalid job name before touching the store', async () => {
    const processor = vi.fn(listProcessor(['a']))
    await expect(
      runResumableBackfill(pool, processor, { jobName: 'bad job name' }),
    ).rejects.toThrow(/Invalid backfill job_name/)
    expect(processor).not.toHaveBeenCalled()
  })

  it('does not reprocess a completed job even when a processor is supplied', async () => {
    await repo.upsert({
      jobName: 'already_done',
      cursorValue: 'final',
      rowsProcessed: 7,
      status: 'completed',
    })
    const processor = vi.fn(listProcessor(['a', 'b']))

    const result = await runResumableBackfill(pool, processor, {
      jobName: 'already_done',
    })

    expect(result.status).toBe('completed')
    expect(result.rowsProcessed).toBe(7)
    expect(result.batchesProcessed).toBe(0)
    expect(processor).not.toHaveBeenCalled()
  })

  it('restarts a failed job from scratch when forceRestart is set', async () => {
    await repo.upsert({
      jobName: 'restart_after_failure',
      cursorValue: 'row-9',
      rowsProcessed: 10,
      status: 'failed',
      lastError: 'boom',
    })

    const items = Array.from({ length: 4 }, (_, i) => `row-${i}`)
    const result = await runResumableBackfill(pool, listProcessor(items), {
      jobName: 'restart_after_failure',
      batchSize: 2,
      forceRestart: true,
    })

    expect(result.status).toBe('completed')
    expect(result.resumedFromCursor).toBe('')
    expect(result.rowsProcessed).toBe(4)
    expect(result.progress.lastError).toBeNull()
  })

  it('keeps concurrent runs of the same job from corrupting the marker', async () => {
    // Two schedulers pick up the same job. Both must finish cleanly and the
    // durable marker must end in a valid state.
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const processor = vi.fn(async (cursor: string) => {
      arrived += 1
      if (arrived === 2) release()
      await gate
      return {
        nextCursor: `${cursor}c`,
        processedCount: 1,
        done: true,
        totalRows: 1,
      }
    })

    const [a, b] = await Promise.all([
      runResumableBackfill(pool, processor, { jobName: 'concurrent_job' }),
      runResumableBackfill(pool, processor, { jobName: 'concurrent_job' }),
    ])

    expect(processor).toHaveBeenCalledTimes(2)
    for (const result of [a, b]) {
      expect(result.status).toBe('completed')
      expect(result.rowsProcessed).toBe(1)
    }

    const marker = await repo.findByJobName('concurrent_job')
    expect(marker?.status).toBe('completed')
    expect(marker?.rowsProcessed).toBeGreaterThanOrEqual(0)
  })

  it('logs a progress percentage only when a positive total is known', async () => {
    const logger = vi.fn()
    await runResumableBackfill(
      pool,
      async () => ({
        nextCursor: 'c1',
        processedCount: 5,
        done: true,
        totalRows: 10,
      }),
      { jobName: 'pct_job', logger },
    )
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('(50.0%)'))

    const zeroTotalLogger = vi.fn()
    await runResumableBackfill(
      pool,
      async () => ({
        nextCursor: 'c1',
        processedCount: 0,
        done: true,
        totalRows: 0,
      }),
      { jobName: 'pct_zero', logger: zeroTotalLogger },
    )
    expect(zeroTotalLogger.mock.calls.join('\n')).not.toContain('%)')

    const unknownTotalLogger = vi.fn()
    await runResumableBackfill(
      pool,
      async () => ({
        nextCursor: 'c1',
        processedCount: 1,
        done: true,
        totalRows: null,
      }),
      { jobName: 'pct_null', logger: unknownTotalLogger },
    )
    expect(unknownTotalLogger.mock.calls.join('\n')).not.toContain('%)')
  })

  it('records a completion log line and the batch metadata', async () => {
    const logger = vi.fn()
    const runner = new ResumableBackfillRunner(
      pool,
      async () => ({
        nextCursor: 'c1',
        processedCount: 3,
        done: true,
        totalRows: 3,
        metadata: { table: 'identities' },
      }),
    )

    const result = await runner.run({ jobName: 'logger_job', logger })

    expect(result.status).toBe('completed')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('[backfill:logger_job] completed'),
    )
    expect((await repo.findByJobName('logger_job'))?.metadata).toEqual({
      table: 'identities',
    })
  })

  it('uses the constructor logger when no per-run logger is supplied', async () => {
    const logger = vi.fn()
    const runner = new ResumableBackfillRunner(
      pool,
      async () => ({ nextCursor: 'c1', processedCount: 1, done: true }),
      logger,
    )
    await runner.run({ jobName: 'ctor_logger' })
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('[backfill:ctor_logger]'),
    )
  })
})
