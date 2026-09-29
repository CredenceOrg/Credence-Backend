/**
 * Integration tests for DataRetentionJob and RetentionRepository.
 *
 * Tests TTL calculation, org-level filtering, dry-run mode, and audit logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataRetentionJob } from '../../src/jobs/dataRetentionJob.js'
import { RetentionRepository } from '../../src/repositories/retentionRepository.js'
import { type RetentionConfig, loadRetentionConfig, getEffectiveEntityTtl } from '../../src/config/retention.js'
import type { Queryable } from '../../src/db/repositories/queryable.js'
import { InMemoryAuditLogsRepository } from '../../src/db/repositories/auditLogsRepository.js'
import { AuditLogService } from '../../src/services/audit/index.js'

function makeTestConfig(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    dryRun: false,
    batchLimit: 100,
    entities: {
      scoreHistory: { ttlDays: 90 },
      auditLogs: { ttlDays: 365 },
      slashEvents: { ttlDays: 30 },
      outboxEvents: { ttlDays: 30 },
      evidence: { ttlDays: 60 },
    },
    ...overrides,
  }
}

function makeMockDb(): { db: Queryable; queries: Array<{ sql: string; params?: unknown[] }> } {
  const queries: Array<{ sql: string; params?: unknown[] }> = []
  const db: Queryable = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ cnt: '15' }], rowCount: 1, command: '', oid: 0, fields: [] })
      }
      if (sql.includes('DELETE FROM') || sql.includes('UPDATE evidence')) {
        return Promise.resolve({ rows: [], rowCount: 15, command: '', oid: 0, fields: [] })
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })
    }),
  }
  return { db, queries }
}

describe('Data Retention Integration Test Suite', () => {
  let auditRepo: InMemoryAuditLogsRepository
  let auditLogService: AuditLogService
  let logs: string[]

  beforeEach(() => {
    logs = []
    auditRepo = new InMemoryAuditLogsRepository()
    auditLogService = new AuditLogService(auditRepo)
  })

  describe('Config & Org Overrides', () => {
    it('resolves effective entity TTL with global defaults and org overrides', () => {
      const config = makeTestConfig({
        orgOverrides: {
          'org-alpha': {
            scoreHistory: { ttlDays: 30 },
            evidence: { ttlDays: 14 },
          },
        },
      })

      expect(getEffectiveEntityTtl(config, 'scoreHistory')).toBe(90)
      expect(getEffectiveEntityTtl(config, 'scoreHistory', 'org-alpha')).toBe(30)
      expect(getEffectiveEntityTtl(config, 'evidence', 'org-alpha')).toBe(14)
      expect(getEffectiveEntityTtl(config, 'auditLogs', 'org-alpha')).toBe(365) // falls back to global default
    })

    it('loads retention config from env variables including org overrides JSON', () => {
      const env = {
        RETENTION_DRY_RUN: 'true',
        RETENTION_BATCH_LIMIT: '500',
        RETENTION_TTL_SCORE_HISTORY_DAYS: '60',
        RETENTION_ORG_OVERRIDES: JSON.stringify({
          'org-beta': { scoreHistory: { ttlDays: 15 } },
        }),
      }

      const loaded = loadRetentionConfig(env)
      expect(loaded.dryRun).toBe(true)
      expect(loaded.batchLimit).toBe(500)
      expect(loaded.entities.scoreHistory.ttlDays).toBe(60)
      expect(getEffectiveEntityTtl(loaded, 'scoreHistory', 'org-beta')).toBe(15)
    })
  })

  describe('RetentionRepository Org Scoping', () => {
    it('includes tenant_id parameter when orgId is provided', async () => {
      const { db, queries } = makeMockDb()
      const repo = new RetentionRepository(db, false)

      await repo.countExpiredScoreHistory(90, 'org-tenant-1')
      expect(queries[0].sql).toContain('tenant_id = $2')
      expect(queries[0].params).toEqual([90, 'org-tenant-1'])

      await repo.deleteExpiredScoreHistory(90, 50, 'org-tenant-1')
      expect(queries[1].sql).toContain('tenant_id = $3')
      expect(queries[1].params).toEqual([90, 50, 'org-tenant-1'])
    })

    it('omits tenant_id filter when orgId is omitted', async () => {
      const { db, queries } = makeMockDb()
      const repo = new RetentionRepository(db, false)

      await repo.countExpiredAuditLogs(365)
      expect(queries[0].sql).not.toContain('tenant_id')
      expect(queries[0].params).toEqual([365])
    })
  })

  describe('DataRetentionJob Execution & Dry-Run Mode', () => {
    it('executes org-level retention and returns detailed result audit', async () => {
      const { db } = makeMockDb()
      const config = makeTestConfig({
        orgOverrides: {
          'org-test-123': {
            slashEvents: { ttlDays: 7 },
          },
        },
      })

      const job = new DataRetentionJob(db, config, (msg) => logs.push(msg), undefined, auditLogService)
      const result = await job.runForOrg('org-test-123')

      expect(result.orgId).toBe('org-test-123')
      expect(result.totalExpired).toBeGreaterThan(0)
      expect(result.totalDeleted).toBeGreaterThan(0)
      expect(result.dryRun).toBe(false)

      const slashAudit = result.entities.find((e) => e.entity === 'slash_events')!
      expect(slashAudit.ttlDays).toBe(7)
      expect(slashAudit.orgId).toBe('org-test-123')

      // Verify audit log entry written to service
      const logsInRepo = await auditRepo.getAll()
      const matchingLogs = logsInRepo.filter((l) => l.action === 'DATA_RETENTION_ENFORCEMENT')
      expect(matchingLogs.length).toBe(1)
      expect(matchingLogs[0].resourceId).toBe('org-test-123')
      expect(matchingLogs[0].tenantId).toBe('org-test-123')
    })

    it('respects dry-run mode and refrains from issuing deletion SQL queries', async () => {
      const { db, queries } = makeMockDb()
      const config = makeTestConfig({ dryRun: true })

      const job = new DataRetentionJob(db, config, (msg) => logs.push(msg), undefined, auditLogService)
      const result = await job.run('org-dry-run')

      expect(result.dryRun).toBe(true)
      expect(result.totalDeleted).toBe(0)
      expect(result.totalExpired).toBe(75) // 5 entities * 15 mock count

      // Ensure no DELETE or UPDATE query was executed
      const writeQueries = queries.filter(
        (q) => q.sql.startsWith('WITH rows AS') || q.sql.startsWith('UPDATE evidence'),
      )
      expect(writeQueries.length).toBe(0)

      // Audit log should reflect dryRun = true
      const logsInRepo = await auditRepo.getAll()
      const matchingLogs = logsInRepo.filter((l) => l.action === 'DATA_RETENTION_ENFORCEMENT')
      expect(matchingLogs.length).toBe(1)
      expect(matchingLogs[0].details.dryRun).toBe(true)
    })
  })
})
