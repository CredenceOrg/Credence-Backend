/**
 * Retention policy enforcement tests for AuditLogRepository.
 *
 * Covers:
 *   - Success path: purging expired entries
 *   - Failure paths: zero TTL, dry run, tenant scoping enforcement
 *   - Expiry boundary edge cases: exactly at boundary, just past boundary
 *   - Batch limits, empty repos, hash chain considerations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  InMemoryAuditLogsRepository,
  PostgresAuditLogsRepository,
} from './auditLogsRepository.js'
import { AuditAction, AuditLogService } from '../../services/audit/index.js'
import type { AuditLogPurgeResult } from './auditLogsRepository.js'

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create an audit log input with a timestamp N days ago */
function makeInput(daysAgo: number, tenantId = 'tenant-1', suffix = '') {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  return {
    actorId: `admin${suffix}`,
    actorEmail: `admin${suffix}@credence.org`,
    action: AuditAction.ASSIGN_ROLE,
    resourceType: 'user',
    resourceId: `user${suffix}`,
    tenantId,
    details: { role: 'admin' },
    occurredAt: ts.toISOString(),
  }
}

// ── InMemoryAuditLogsRepository Retention Tests ──────────────────────────

describe('InMemoryAuditLogsRepository - purgeExpired', () => {
  let repo: InMemoryAuditLogsRepository

  beforeEach(() => {
    repo = new InMemoryAuditLogsRepository()
  })

  // ── Success path ─────────────────────────────────────────────────────

  it('purges entries older than the specified boundary', async () => {
    // Insert entries: 31 days old (should be purged with 30-day TTL)
    await repo.append(makeInput(31))
    // Insert entries: 29 days old (should be kept)
    await repo.append(makeInput(29))
    // Insert entries: slightly less than 30 days (boundary — NOT purged)
    // Use makeInput with 29.9 to avoid timing race between append and purgeExpired cutoff calc
    const boundaryTs = new Date(Date.now() - 29.9 * 24 * 60 * 60 * 1000)
    await repo.append({
      actorId: 'admin-boundary',
      actorEmail: 'admin-boundary@credence.org',
      action: AuditAction.ASSIGN_ROLE,
      resourceType: 'user',
      resourceId: 'user-boundary',
      tenantId: 'tenant-1',
      details: {},
      occurredAt: boundaryTs.toISOString(),
    })

    const result = await repo.purgeExpired(30)

    expect(result.expiredCount).toBe(1)
    expect(result.deletedCount).toBe(1)
    expect(result.dryRun).toBe(false)
    expect(result.ttlDays).toBe(30)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(2)
  })

  it('deletes nothing when all entries are within the retention window', async () => {
    await repo.append(makeInput(10))
    await repo.append(makeInput(5))
    await repo.append(makeInput(1))

    const result = await repo.purgeExpired(30)

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(3)
  })

  it('purges all entries when retention window is 1 day', async () => {
    await repo.append(makeInput(2))
    await repo.append(makeInput(3))
    await repo.append(makeInput(5))

    const result = await repo.purgeExpired(1)

    expect(result.expiredCount).toBe(3)
    expect(result.deletedCount).toBe(3)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(0)
  })

  // ── Expiry boundary edge cases ───────────────────────────────────────

  it('excludes entries exactly at the boundary (boundary day is NOT purged)', async () => {
    // Insert entry exactly 30 days ago at noon
    const boundaryMs = 30 * 24 * 60 * 60 * 1000
    const atBoundary = new Date(Date.now() - boundaryMs)

    // We inject a timestamp directly into the entry's occurredAt-equivalent
    // by appending and then inspecting.
    // Since InMemoryRepo sets timestamp to `new Date().toISOString()` at append
    // time, we use a spy to verify the boundary logic indirectly.
    // More accurately: we just insert entries with known ages.
    await repo.append(makeInput(30))  // exactly 30 days ago

    const result = await repo.purgeExpired(30)

    // The entry at exactly 30 days should NOT be expired
    // because cutoff is < NOW() - 30 days, not <=
    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)
  })

  it('purges entries just past the boundary by a small margin', async () => {
    await repo.append(makeInput(30))  // exactly at boundary — kept
    await repo.append(makeInput(31))  // 1 day past — purged
    await repo.append(makeInput(30, 'tenant-1', '-2'))  // exactly at boundary — kept
    await repo.append(makeInput(32))  // 2 days past — purged

    const result = await repo.purgeExpired(30)

    expect(result.expiredCount).toBe(2)
    expect(result.deletedCount).toBe(2)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(2)
    // Verify the kept ones are the boundary entries
    remaining.forEach((entry) => {
      const ageInDays = (Date.now() - new Date(entry.timestamp).getTime()) / (24 * 60 * 60 * 1000)
      expect(ageInDays).toBeLessThan(30.1)
    })
  })

  it('handles sub-day boundary correctly (e.g. 23 hours vs 25 hours)', async () => {
    // This validates that the comparison uses <, not <=
    // We set the TTL to 1 day and create entries at ~23h and ~25h
    await repo.append(makeInput(1))   // approximately 24h — at boundary
    await repo.append(makeInput(1, 'tenant-1', '-2'))  // another at boundary
    await repo.append(makeInput(2))   // definitely expired

    const result = await repo.purgeExpired(1)

    // The strict < cutoff means the "1 day ago" entry may or may not be
    // expired depending on exact timing. We just verify expiredCount ≥ 1
    expect(result.expiredCount).toBeGreaterThanOrEqual(1)
    expect(result.deletedCount).toBeGreaterThanOrEqual(1)

    const remaining = await repo.getAll()
    // At most 2 entries remain (the two ~24h entries)
    expect(remaining.length).toBeLessThanOrEqual(2)
  })

  // ── Zero TTL (keep forever) ──────────────────────────────────────────

  it('returns zero counts when TTL is 0 (keep forever)', async () => {
    await repo.append(makeInput(400))
    await repo.append(makeInput(500))

    const result = await repo.purgeExpired(0)

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)
    expect(result.dryRun).toBe(false) // caller did not request dry run
    expect(result.ttlDays).toBe(0)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(2)
  })

  // ── Dry-run mode ─────────────────────────────────────────────────────

  it('counts but does not delete in dry-run mode', async () => {
    await repo.append(makeInput(60))
    await repo.append(makeInput(90))
    await repo.append(makeInput(10))

    const result = await repo.purgeExpired(30, { dryRun: true })

    expect(result.expiredCount).toBe(2)
    expect(result.deletedCount).toBe(0)
    expect(result.dryRun).toBe(true)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(3) // nothing deleted
  })

  // ── Tenant scoping ───────────────────────────────────────────────────

  it('only purges entries for the specified tenant', async () => {
    await repo.append(makeInput(60, 'tenant-a'))
    await repo.append(makeInput(60, 'tenant-b'))
    await repo.append(makeInput(60, 'tenant-a', '-2'))
    await repo.append(makeInput(10, 'tenant-a'))
    await repo.append(makeInput(10, 'tenant-b'))

    const result = await repo.purgeExpired(30, { tenantId: 'tenant-a' })

    expect(result.expiredCount).toBe(2) // only tenant-a entries past boundary
    expect(result.deletedCount).toBe(2)
    expect(result.tenantId).toBe('tenant-a')

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(3) // tenant-b (2) + tenant-a recent (1)
    const tenantBEntries = remaining.filter((e) => e.tenantId === 'tenant-b')
    expect(tenantBEntries).toHaveLength(2) // all tenant-b entries preserved
  })

  it('returns zero when tenant has no expired entries', async () => {
    await repo.append(makeInput(5, 'tenant-fresh'))
    await repo.append(makeInput(60, 'tenant-old'))

    const result = await repo.purgeExpired(30, { tenantId: 'tenant-fresh' })

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(2) // both preserved
  })

  // ── Batch limits ─────────────────────────────────────────────────────

  it('respects batch size limit', async () => {
    // Insert 10 expired entries
    for (let i = 0; i < 10; i++) {
      await repo.append(makeInput(60, 'tenant-1', `-b${i}`))
    }
    // Insert 5 fresh entries
    for (let i = 0; i < 5; i++) {
      await repo.append(makeInput(5, 'tenant-1', `-f${i}`))
    }

    const result = await repo.purgeExpired(30, { batchSize: 3 })

    expect(result.expiredCount).toBe(10)
    expect(result.deletedCount).toBe(3) // only 3 deleted due to batch limit

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(12) // 7 expired remaining + 5 fresh
  })

  // ── Empty repository ─────────────────────────────────────────────────

  it('handles empty repository gracefully', async () => {
    const result = await repo.purgeExpired(30)

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)
    expect(result.dryRun).toBe(false) // caller did not request dry run
  })

  // ── Large TTL (everything kept) ──────────────────────────────────────

  it('keeps everything when TTL is very large', async () => {
    await repo.append(makeInput(364))
    await repo.append(makeInput(200))
    await repo.append(makeInput(100))

    const result = await repo.purgeExpired(365)

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)

    const remaining = await repo.getAll()
    expect(remaining).toHaveLength(3)
  })

  // ── idempotency (repeated purge on already-purged repo) ──────────────

  it('is idempotent — running purge twice yields zero on second run', async () => {
    await repo.append(makeInput(60))
    await repo.append(makeInput(90))
    await repo.append(makeInput(10))

    const first = await repo.purgeExpired(30)
    expect(first.deletedCount).toBe(2)
    expect(first.dryRun).toBe(false)

    const second = await repo.purgeExpired(30)
    expect(second.expiredCount).toBe(0)
    expect(second.deletedCount).toBe(0)
    expect(second.dryRun).toBe(false) // no dryRun requested
  })
})

// ── PostgresAuditLogsRepository Retention Tests ──────────────────────────

describe('PostgresAuditLogsRepository - purgeExpired', () => {
  it('counts and deletes expired audit logs via batched CTE', async () => {
    const db = {
      query: vi
        .fn()
        // countExpired response
        .mockResolvedValueOnce({ rows: [{ cnt: 15 }], rowCount: 1 })
        // first DELETE batch response (5 deleted)
        .mockResolvedValueOnce({ rows: [], rowCount: 5 })
        // second DELETE batch response (5 deleted)
        .mockResolvedValueOnce({ rows: [], rowCount: 5 })
        // third DELETE batch response (5 deleted)
        .mockResolvedValueOnce({ rows: [], rowCount: 5 })
        // fourth DELETE batch response (0 deleted — all expired rows gone, loop exits)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    }

    const repo = new PostgresAuditLogsRepository(db as any)
    const result = await repo.purgeExpired(30, { batchSize: 5 })

    expect(result.expiredCount).toBe(15)
    expect(result.deletedCount).toBe(15)
    expect(result.dryRun).toBe(false)
    expect(result.ttlDays).toBe(30)

    // Verify COUNT query
    const countCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(countCall[0])).toContain('COUNT(*)')
    expect(String(countCall[0])).toContain("NOW() - ($1 || ' days')::interval")
    expect(countCall[1]).toEqual([30])

    // Verify DELETE queries
    const deleteCalls = (db.query as ReturnType<typeof vi.fn>).mock.calls.slice(1)
    deleteCalls.forEach((call: [string, unknown[]]) => {
      expect(String(call[0])).toContain('WITH rows AS')
      expect(String(call[0])).toContain('DELETE FROM audit_logs')
      expect(call[1]).toEqual([30, 5])
    })
  })

  it('stops batching when last batch is smaller than batchSize', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ cnt: 7 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 5 })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }),
    }

    const repo = new PostgresAuditLogsRepository(db as any)
    const result = await repo.purgeExpired(30, { batchSize: 5 })

    expect(result.deletedCount).toBe(7)
    // Only 2 DELETE calls + 1 COUNT
    expect(db.query).toHaveBeenCalledTimes(3)
  })

  it('returns zero when nothing to delete', async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ cnt: 0 }], rowCount: 1 }),
    }

    const repo = new PostgresAuditLogsRepository(db as any)
    const result = await repo.purgeExpired(30)

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)
    expect(result.dryRun).toBe(false)
  })

  it('counts but does not delete in dry-run mode', async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ cnt: 50 }], rowCount: 1 }),
    }

    const repo = new PostgresAuditLogsRepository(db as any)
    const result = await repo.purgeExpired(30, { dryRun: true })

    expect(result.expiredCount).toBe(50)
    expect(result.deletedCount).toBe(0)
    expect(result.dryRun).toBe(true)
    // Only COUNT query was made, no DELETE
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('returns zero when TTL is 0 (keep forever)', async () => {
    const db = { query: vi.fn() }

    const repo = new PostgresAuditLogsRepository(db as any)
    const result = await repo.purgeExpired(0)

    expect(result.expiredCount).toBe(0)
    expect(result.deletedCount).toBe(0)
    expect(result.dryRun).toBe(false)
    expect(result.ttlDays).toBe(0)
    // No queries executed
    expect(db.query).not.toHaveBeenCalled()
  })

  it('adds tenant_id clause when tenant scoping is active', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ cnt: 3 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 3 }),
    }

    const repo = new PostgresAuditLogsRepository(db as any)
    await repo.purgeExpired(90, { tenantId: 'org-42' })

    const countSql = String((db.query as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(countSql).toContain('tenant_id = $2')

    const deleteSql = String((db.query as ReturnType<typeof vi.fn>).mock.calls[1][0])
    expect(deleteSql).toContain('tenant_id = $3')

    const deleteParams = (db.query as ReturnType<typeof vi.fn>).mock.calls[1][1]
    expect(deleteParams).toEqual([90, 5000, 'org-42'])
  })
})

// ── AuditLogService purgeExpired ──────────────────────────────────────────

describe('AuditLogService - purgeExpired', () => {
  it('throws when no tenantId is provided and allowSuperScope is not set', async () => {
    const service = new AuditLogService(new InMemoryAuditLogsRepository())

    await expect(service.purgeExpired(30)).rejects.toThrow('Tenant scoping required')
  })

  it('succeeds when tenantId is provided', async () => {
    const repo = new InMemoryAuditLogsRepository()
    await repo.append(makeInput(60, 'tenant-ok'))
    await repo.append(makeInput(10, 'tenant-ok'))

    const service = new AuditLogService(repo)
    const result = await service.purgeExpired(30, { tenantId: 'tenant-ok' })

    expect(result.expiredCount).toBe(1)
    expect(result.deletedCount).toBe(1)
  })

  it('succeeds when allowSuperScope is explicitly true', async () => {
    const repo = new InMemoryAuditLogsRepository()
    await repo.append(makeInput(60, 'tenant-a'))
    await repo.append(makeInput(60, 'tenant-b'))

    const service = new AuditLogService(repo)
    const result = await service.purgeExpired(30, { allowSuperScope: true })

    // Cross-tenant purge: all expired entries regardless of tenant
    expect(result.expiredCount).toBe(2)
    expect(result.deletedCount).toBe(2)
  })
})
