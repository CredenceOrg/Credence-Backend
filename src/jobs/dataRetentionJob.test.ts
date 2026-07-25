/**
 * Unit tests for DataRetentionJob + RetentionRepository
 *
 * Uses vitest with mock Queryable implementations — no live database needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataRetentionJob } from './dataRetentionJob.js'
import type { RetentionConfig } from '../config/retention.js'
import type { Queryable } from '../db/repositories/queryable.js'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    dryRun: false,
    batchLimit: 100,
    entities: {
      scoreHistory: { ttlDays: 90 },
      auditLogs: { ttlDays: 365 },
      slashEvents: { ttlDays: 30 },
      outboxEvents: { ttlDays: 30 },
      evidence: { ttlDays: 0 },
    },
    ...overrides,
  }
}

function makeDb(countResponse = 0, deleteResponse = 0): Queryable {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ cnt: String(countResponse) }], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: deleteResponse })
    }),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DataRetentionJob', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
  })

  it('returns zero totals when nothing is expired', async () => {
    const db = makeDb(0, 0)
    const job = new DataRetentionJob(db, makeConfig(), (m) => logs.push(m))

    const result = await job.run()

    expect(result.totalExpired).toBe(0)
    expect(result.totalDeleted).toBe(0)
    expect(result.dryRun).toBe(false)
    expect(result.entities).toHaveLength(5)
  })

  it('deletes expired rows and sums counts correctly', async () => {
    const db = makeDb(10, 10)
    const job = new DataRetentionJob(db, makeConfig(), (m) => logs.push(m))

    const result = await job.run()

    expect(result.totalExpired).toBe(40) // 4 non-evidence entities × 10
    expect(result.totalDeleted).toBe(40)
    // evidence has ttlDays=0, so it's skipped with deletedCount=0
    const activeEntities = result.entities.filter((e) => e.ttlDays > 0)
    expect(activeEntities.every((e) => e.deletedCount === 10)).toBe(true)
    const skippedEntity = result.entities.find((e) => e.ttlDays === 0)!
    expect(skippedEntity.deletedCount).toBe(0)
  })

  it('records startTime as valid ISO string and non-negative duration', async () => {
    const job = new DataRetentionJob(makeDb(), makeConfig())
    const result = await job.run()

    expect(typeof result.startTime).toBe('string')
    expect(new Date(result.startTime).getTime()).toBeGreaterThan(0)
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })

  it('does not issue DELETE queries in dry-run mode', async () => {
    const db = makeDb(5, 5)
    const job = new DataRetentionJob(db, makeConfig({ dryRun: true }), (m) => logs.push(m))

    const result = await job.run()

    expect(result.dryRun).toBe(true)
    expect(result.totalDeleted).toBe(0)
    expect(result.totalExpired).toBe(20) // 4 × 5, COUNT still runs

    const queryCalls = (db.query as ReturnType<typeof vi.fn>).mock.calls as [string][]
    const deleteCalls = queryCalls.filter(([sql]) => sql.trim().startsWith('WITH rows AS'))
    expect(deleteCalls).toHaveLength(0)
  })

  it('marks all entity audits dryRun=true when in dry-run mode', async () => {
    const job = new DataRetentionJob(makeDb(3, 3), makeConfig({ dryRun: true }))
    const result = await job.run()

    expect(result.entities.every((e) => e.dryRun === true)).toBe(true)
  })

  it('skips all queries when all entities have ttlDays=0', async () => {
    const config = makeConfig({
      entities: {
        scoreHistory: { ttlDays: 0 },
        auditLogs: { ttlDays: 0 },
        slashEvents: { ttlDays: 0 },
        outboxEvents: { ttlDays: 0 },
        evidence: { ttlDays: 0 },
      },
    })
    const db = makeDb(99, 99)
    const job = new DataRetentionJob(db, config, (m) => logs.push(m))

    const result = await job.run()

    expect(result.totalExpired).toBe(0)
    expect(result.totalDeleted).toBe(0)
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it('only skips the entity with ttlDays=0, processes others', async () => {
    const config = makeConfig({
      entities: {
        scoreHistory: { ttlDays: 0 },
        auditLogs: { ttlDays: 365 },
        slashEvents: { ttlDays: 30 },
        outboxEvents: { ttlDays: 30 },
        evidence: { ttlDays: 0 },
      },
    })
    const db = makeDb(4, 4)
    const job = new DataRetentionJob(db, config)
    const result = await job.run()

    const scoreEntity = result.entities.find((e) => e.entity === 'score_history')!
    expect(scoreEntity.expiredCount).toBe(0)
    expect(scoreEntity.deletedCount).toBe(0)
    expect(result.totalExpired).toBe(12) // 3 active entities × 4
    expect(result.totalDeleted).toBe(12)
  })

  it('includes all 5 entity types in result', async () => {
    const job = new DataRetentionJob(makeDb(), makeConfig())
    const result = await job.run()

    const names = result.entities.map((e) => e.entity).sort()
    expect(names).toEqual(
      ['audit_logs', 'evidence', 'outbox_events', 'score_history', 'slash_events'].sort(),
    )
  })

  it('logs start and completion messages', async () => {
    const job = new DataRetentionJob(makeDb(), makeConfig(), (m) => logs.push(m))
    await job.run()

    expect(logs.some((l) => l.includes('Starting run'))).toBe(true)
    expect(logs.some((l) => l.includes('Run complete'))).toBe(true)
  })

  it('passes batchLimit to DELETE queries', async () => {
    const db = makeDb(10, 5)
    const job = new DataRetentionJob(db, makeConfig({ batchLimit: 5 }))
    await job.run()

    const calls = (db.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][]
    const deleteCalls = calls.filter(([sql]) => sql.trim().startsWith('WITH rows AS'))
    deleteCalls.forEach(([, params]) => {
      expect(params?.[1]).toBe(5)
    })
  })
})
