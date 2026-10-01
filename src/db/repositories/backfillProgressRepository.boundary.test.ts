/**
 * Boundary + recovery coverage for src/db/outbox/repository.ts.
 *
 * Maps to issue #1364 acceptance criteria:
 * - deterministic for valid/invalid/duplicate/boundary inputs
 * - validation + state-transition invariants enforced
 * - retries/partial failure/concurrent execution cannot corrupt state
 * - success/rejection/boundary/regression scenarios
 * - callers remain compatible (public method shapes unchanged)
 * - failures diagnosable without exposing sensitive data
 *
 * States covered: loading (find), error (invalid input / unknown job),
 * retry (transient DB failure then success), stale (read-after-write,
 * checkpoint preserves totals/metadata), permission (injection rejected).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb, type IMemoryDb } from 'pg-mem'
import type { Pool } from 'pg'
import crypto from 'crypto'
import { BackfillProgressRepository } from './repository.js'

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
    CREATE TABLE outbox (
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

describe('OutboxRepository boundary + recovery', () => {
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

  describe('jobName boundaries (valid / invalid / duplicate)', () => {
    it('accepts 1-char and 128-char names, rejects 129-char and empty', async () => {
      const max128 = 'a'.repeat(128)
      await expect(
        repo.upsert({ jobName: 'x', cursorValue: '', rowsProcessed: 0 }),
      ).resolves.toMatchObject({ jobName: 'x' })
      await expect(
        repo.upsert({ jobName: max128, cursorValue: '', rowsProcessed: 0 }),
      ).resolves.toMatchObject({ jobName: max128 })
      await expect(
        repo.upsert({ jobName: '', cursorValue: '', rowsProcessed: 0 }),
      ).rejects.toThrow(/Invalid backfill job_name/)
      await expect(
        repo.upsert({ jobName: 'a'.repeat(129), cursorValue: '', rowsProcessed: 0 }),
      ).rejects.toThrow(/Invalid backfill job_name/)
    })

    it('accepts all allowed charset chars', async () => {
      const name = 'aZ09_.:/-x'
      const saved = await repo.upsert({ jobName: name, cursorValue: '', rowsProcessed: 0 })
      expect(saved.jobName).toBe(name)
    })

    it.each([
      'bad name',
      'has space',
      "evil'; DROP TABLE backfill_progress; --",
      'semi;colon?',
      'quote"',
      "quote'",
      'back\\slash',
      'unicode-é',
      'emoji-🚀',
    ])('rejects unsafe jobName %p without touching the table', async (jobName) => {
      await expect(repo.findByJobName(jobName)).rejects.toThrow(/Invalid backfill job_name/)
      await expect(
        repo.upsert({ jobName, cursorValue: '', rowsProcessed: 0 }),
      ).rejects.toThrow(/Invalid backfill job_name/)
      // Table still usable after rejection (no partial state).
      await expect(
        repo.upsert({ jobName: 'still_ok', cursorValue: '', rowsProcessed: 0 }),
      ).resolves.toMatchObject({ jobName: 'still_ok' })
    })

    it.each([null, undefined, 123, {}, [], true])(
      'rejects non-string jobName %p (no RegExp coercion)',
      async (jobName) => {
        await expect(
          repo.upsert({
            jobName: jobName as unknown as string,
            cursorValue: '',
            rowsProcessed: 0,
          }),
        ).rejects.toThrow(/Invalid backfill job_name/)
      },
    )

    it('duplicate upserts replace deterministically with a single row', async () => {
      await repo.upsert({ jobName: 'dup', cursorValue: '1', rowsProcessed: 1 })
      const second = await repo.upsert({ jobName: 'dup', cursorValue: '2', rowsProcessed: 2 })
      expect(second.cursorValue).toBe('2')
      expect(second.rowsProcessed).toBe(2)
      const all = await repo.findAll()
      expect(all.filter((m) => m.jobName === 'dup')).toHaveLength(1)
      expect(await repo.findByJobName('dup')).toMatchObject({
        cursorValue: '2',
        rowsProcessed: 2,
      })
    })
  })

  describe('cursor boundaries', () => {
    it('accepts empty (initial watermark), 1024 chars; rejects 1025', async () => {
      await expect(
        repo.upsert({ jobName: 'c_empty', cursorValue: '', rowsProcessed: 0 }),
      ).resolves.toMatchObject({ cursorValue: '' })
      const max = 'c'.repeat(1024)
      await expect(
        repo.upsert({ jobName: 'c_max', cursorValue: max, rowsProcessed: 0 }),
      ).resolves.toMatchObject({ cursorValue: max })
      await expect(
        repo.upsert({ jobName: 'c_over', cursorValue: 'c'.repeat(1025), rowsProcessed: 0 }),
      ).rejects.toThrow(/maximum length/)
    })

    it.each(['\u0000', '\u0007', '\u000B', '\u000C', '\u001F', 'a\u0000b'])(
      'rejects control char cursor %p',
      async (cursorValue) => {
        await expect(
          repo.checkpoint({ jobName: 'c_ctrl', cursorValue, rowsProcessed: 0 }),
        ).rejects.toThrow(/control characters/)
      },
    )

    it('allows tab/newline/CR as opaque cursor bytes, plus unicode', async () => {
      for (const [name, cursor] of [
        ['tab', 'a\tb'],
        ['newline', 'a\nb'],
        ['cr', 'a\rb'],
        ['unicode', 'cursor-🚀-é-✓'],
      ] as const) {
        const saved = await repo.upsert({ jobName: `c_${name}`, cursorValue: cursor, rowsProcessed: 0 })
        expect(saved.cursorValue).toBe(cursor)
      }
    })

    it('rejects non-string cursors', async () => {
      for (const bad of [null, 123, {}, []] as unknown[]) {
        await expect(
          repo.upsert({
            jobName: 'c_type',
            cursorValue: bad as unknown as string,
            rowsProcessed: 0,
          }),
        ).rejects.toThrow(/cursor_value must be a string/)
      }
    })
  })

  describe('numeric boundaries', () => {
    it('accepts 0, rejects negatives/floats/NaN/Infinity/non-integers', async () => {
      await expect(
        repo.upsert({ jobName: 'n_zero', cursorValue: '', rowsProcessed: 0, totalRows: 0 }),
      ).resolves.toMatchObject({ rowsProcessed: 0, totalRows: 0 })

      for (const bad of [-1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        await expect(
          repo.upsert({ jobName: 'n_bad', cursorValue: '', rowsProcessed: bad }),
        ).rejects.toThrow(/non-negative integer/)
        await expect(
          repo.upsert({ jobName: 'n_bad', cursorValue: '', rowsProcessed: 0, totalRows: bad }),
        ).rejects.toThrow(/non-negative integer/)
      }
      await expect(
        repo.upsert({ jobName: 'n_str', cursorValue: '', rowsProcessed: '10' as unknown as number }),
      ).rejects.toThrow(/non-negative integer/)
    })

    it('accepts large safe integers deterministically', async () => {
      const big = Number.MAX_SAFE_INTEGER
      const saved = await repo.upsert({ jobName: 'n_big', cursorValue: 'x', rowsProcessed: big })
      expect(saved.rowsProcessed).toBe(big)
      expect(await repo.findByJobName('n_big')).toMatchObject({ rowsProcessed: big })
    })

    it('totalRows null/undefined means unknown (preserved as null)', async () => {
      const a = await repo.upsert({ jobName: 't_null', cursorValue: '', rowsProcessed: 0, totalRows: null })
      expect(a.totalRows).toBeNull()
      const b = await repo.upsert({ jobName: 't_undef', cursorValue: '', rowsProcessed: 0 })
      expect(b.totalRows).toBeNull()
    })
  })

  describe('status + metadata validation (no silent loss)', () => {
    it.each(['pending', 'running', 'completed', 'failed'] as const)(
      'accepts valid status %p',
      async (status) => {
        const saved = await repo.upsert({ jobName: `s_${status}`, cursorValue: '', rowsProcessed: 0, status })
        expect(saved.status).toBe(status)
      },
    )

    it.each(['evil', '', 'RUNNING', 'Pending', 'done', 'null'])(
      'rejects invalid status %p before SQL',
      async (status) => {
        await expect(
          repo.upsert({
            jobName: 's_bad',
            cursorValue: '',
            rowsProcessed: 0,
            status: status as unknown as 'pending',
          }),
        ).rejects.toThrow(/Invalid backfill status/)
      },
    )

    it.each([[1, 2], 'str', 42, true])(
      'rejects non-object metadata %p (would read back as {})',
      async (metadata) => {
        await expect(
          repo.upsert({
            jobName: 'm_bad',
            cursorValue: '',
            rowsProcessed: 0,
            metadata: metadata as unknown as Record<string, unknown>,
          }),
        ).rejects.toThrow(/plain JSON object/)
        await expect(
          repo.checkpoint({
            jobName: 'm_bad',
            cursorValue: '',
            rowsProcessed: 0,
            metadata: metadata as unknown as Record<string, unknown>,
          }),
        ).rejects.toThrow(/plain JSON object/)
      },
    )

    it('accepts nested plain objects and round-trips them', async () => {
      const metadata = { table: 't', nested: { a: [1, 2], b: 'x' } }
      const saved = await repo.upsert({ jobName: 'm_ok', cursorValue: '', rowsProcessed: 0, metadata })
      expect(saved.metadata).toEqual(metadata)
    })
  })

  describe('lastError truncation boundary (recovery signal)', () => {
    it('preserves exactly 2000 chars, truncates longer errors', async () => {
      await repo.upsert({ jobName: 'e_job', cursorValue: 'cur', rowsProcessed: 5 })
      const exact = 'e'.repeat(2000)
      expect((await repo.markFailed('e_job', exact)).lastError).toHaveLength(2000)
      const over = 'f'.repeat(2001)
      const truncated = await repo.markFailed('e_job', over)
      expect(truncated.lastError).toHaveLength(2000)
      expect(truncated.lastError).toBe('f'.repeat(2000))
      const huge = 'g'.repeat(10000)
      expect((await repo.markFailed('e_job', huge)).lastError).toHaveLength(2000)
    })

    it('preserves cursor/rows when marking failed (no data loss)', async () => {
      await repo.checkpoint({ jobName: 'e_keep', cursorValue: 'cursor-A', rowsProcessed: 25, totalRows: 100 })
      const failed = await repo.markFailed('e_keep', 'boom')
      expect(failed).toMatchObject({ status: 'failed', cursorValue: 'cursor-A', rowsProcessed: 25, totalRows: 100 })
    })

    it('coerces non-string throwables without secondary TypeError', async () => {
      await repo.upsert({ jobName: 'e_coerce', cursorValue: '', rowsProcessed: 0 })
      const res = await repo.markFailed('e_coerce', undefined as unknown as string)
      expect(typeof res.lastError).toBe('string')
    })
  })

  describe('rejection + recovery (unknown jobs, delete idempotency)', () => {
    it('findByJobName returns null for unknown (loading state)', async () => {
      expect(await repo.findByJobName('no_such_job')).toBeNull()
    })

    it('markCompleted/markFailed on unknown jobs throw diagnosably', async () => {
      await expect(repo.markCompleted('ghost')).rejects.toThrow(/unknown backfill job/)
      await expect(repo.markFailed('ghost', 'x')).rejects.toThrow(/unknown backfill job/)
    })

    it('delete is idempotent: true then false, then find is null (stale read safe)', async () => {
      await repo.upsert({ jobName: 'del', cursorValue: '', rowsProcessed: 0 })
      expect(await repo.delete('del')).toBe(true)
      expect(await repo.findByJobName('del')).toBeNull()
      expect(await repo.delete('del')).toBe(false)
    })

    it('delete rejects invalid job names (permission/validation)', async () => {
      await expect(repo.delete("x'; DROP TABLE--")).rejects.toThrow(/Invalid backfill job_name/)
    })

    it('markCompleted validates overrides before writing', async () => {
      await repo.upsert({ jobName: 'comp', cursorValue: 'a', rowsProcessed: 1 })
      await expect(
        repo.markCompleted('comp', { rowsProcessed: -1 }),
      ).rejects.toThrow(/non-negative integer/)
      await expect(
        repo.markCompleted('comp', { cursorValue: 'x'.repeat(2000) }),
      ).rejects.toThrow(/maximum length/)
      // Original marker untouched after rejected transition.
      expect(await repo.findByJobName('comp')).toMatchObject({ cursorValue: 'a', rowsProcessed: 1 })
    })
  })

  describe('stale + partial-failure safety (checkpoint preserves)', () => {
    it('checkpoint without totalRows/metadata preserves prior values', async () => {
      await repo.upsert({
        jobName: 'stale',
        cursorValue: 'c0',
        rowsProcessed: 10,
        totalRows: 100,
        metadata: { v: 1 },
      })
      const next = await repo.checkpoint({ jobName: 'stale', cursorValue: 'c1', rowsProcessed: 20 })
      expect(next.totalRows).toBe(100)
      expect(next.metadata).toEqual({ v: 1 })
      expect(next.status).toBe('running')
      expect(next.lastError).toBeNull()
    })

    it('checkpoint with explicit totalRows/metadata overwrites', async () => {
      await repo.upsert({ jobName: 'overwrite', cursorValue: 'c0', rowsProcessed: 0, totalRows: 10, metadata: { a: 1 } })
      const next = await repo.checkpoint({
        jobName: 'overwrite',
        cursorValue: 'c1',
        rowsProcessed: 5,
        totalRows: 50,
        metadata: { b: 2 },
      })
      expect(next.totalRows).toBe(50)
      expect(next.metadata).toEqual({ b: 2 })
    })

    it('markRunning preserves cursor/rows and clears lastError (resume)', async () => {
      await repo.checkpoint({ jobName: 'resume', cursorValue: 'cur-9', rowsProcessed: 9, totalRows: 30 })
      await repo.markFailed('resume', 'crash')
      expect((await repo.findByJobName('resume'))?.status).toBe('failed')
      const resumed = await repo.markRunning('resume')
      expect(resumed).toMatchObject({ status: 'running', cursorValue: 'cur-9', rowsProcessed: 9, lastError: null })
    })

    it('full failure→resume→complete lifecycle never loses committed work', async () => {
      await repo.checkpoint({ jobName: 'life', cursorValue: 'c1', rowsProcessed: 10, totalRows: 20 })
      await repo.markFailed('life', 'err')
      await repo.markRunning('life')
      await repo.checkpoint({ jobName: 'life', cursorValue: 'c2', rowsProcessed: 20 })
      const done = await repo.markCompleted('life')
      expect(done).toMatchObject({ status: 'completed', cursorValue: 'c2', rowsProcessed: 20, totalRows: 20 })
    })
  })

  describe('retry + concurrency (no unsafe/inconsistent result)', () => {
    it('retries safely after a transient DB failure', async () => {
      const realQuery = pool.query.bind(pool)
      const spy = vi.spyOn(pool, 'query')
      spy.mockRejectedValueOnce(new Error('connection reset'))
      // First attempt fails transiently; the operation itself is retry-safe.
      await expect(
        repo.upsert({ jobName: 'retry', cursorValue: 'a', rowsProcessed: 1 }),
      ).rejects.toThrow(/connection reset/)
      spy.mockImplementation(realQuery as unknown as typeof pool.query)
      const saved = await repo.upsert({ jobName: 'retry', cursorValue: 'a', rowsProcessed: 1 })
      expect(saved.cursorValue).toBe('a')
      expect(await repo.findByJobName('retry')).toMatchObject({ cursorValue: 'a' })
    })

    it('concurrent upserts converge to a single row (no duplicates)', async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        repo.upsert({ jobName: 'conc', cursorValue: `c${i}`, rowsProcessed: i }),
      )
      const results = await Promise.all(writes)
      expect(results).toHaveLength(10)
      const all = await repo.findAll()
      expect(all.filter((m) => m.jobName === 'conc')).toHaveLength(1)
      const found = await repo.findByJobName('conc')
      expect(found).not.toBeNull()
    })

    it('concurrent checkpoints do not corrupt the marker', async () => {
      await repo.upsert({ jobName: 'conc_ck', cursorValue: '', rowsProcessed: 0, totalRows: 100 })
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          repo.checkpoint({ jobName: 'conc_ck', cursorValue: `c${i}`, rowsProcessed: i + 1 }),
        ),
      )
      const found = await repo.findByJobName('conc_ck')
      expect(found?.status).toBe('running')
      expect(found?.totalRows).toBe(100)
      expect(found?.rowsProcessed).toBeGreaterThanOrEqual(1)
    })

    it('failed checkpoint does not clobber last committed state', async () => {
      await repo.checkpoint({ jobName: 'no_clobber', cursorValue: 'good', rowsProcessed: 7, totalRows: 50 })
      await expect(
        repo.checkpoint({ jobName: 'no_clobber', cursorValue: 'x'.repeat(5000), rowsProcessed: 8 }),
      ).rejects.toThrow()
      expect(await repo.findByJobName('no_clobber')).toMatchObject({
        cursorValue: 'good',
        rowsProcessed: 7,
      })
    })
  })

  describe('observability (diagnosable without sensitive leak)', () => {
    it('validation errors name the field and reason', async () => {
      await expect(
        repo.upsert({ jobName: 'obs', cursorValue: '', rowsProcessed: -1 }),
      ).rejects.toThrow(/rowsProcessed must be/)
      await expect(
        repo.upsert({ jobName: 'x'.repeat(200), cursorValue: '', rowsProcessed: 0 }),
      ).rejects.toThrow(/Invalid backfill job_name/)
    })

    it('error messages do not echo metadata contents', async () => {
      const secretMeta = { secret: 'TOP-SECRET-123' }
      // Valid write succeeds; a later validation error must not include metadata.
      await repo.upsert({ jobName: 'obs2', cursorValue: '', rowsProcessed: 0, metadata: secretMeta })
      let msg = ''
      try {
        await repo.upsert({
          jobName: 'obs2',
          cursorValue: '',
          rowsProcessed: -5,
          metadata: secretMeta,
        })
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).not.toContain('TOP-SECRET-123')
    })
  })
});
