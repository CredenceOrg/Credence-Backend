import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { DataRetentionJob } from './dataRetentionJob.js'
import type { Queryable } from '../db/repositories/queryable.js'
import type { RetentionConfig } from '../config/retention.js'
import { EvidenceStorageService, evidenceDB } from '../services/evidence/storage.js'
import { kekManager, keyManager } from '../services/keyManager/index.js'
import { InMemoryAuditLogsRepository } from '../db/repositories/auditLogsRepository.js'
import { AuditLogService } from '../services/audit/index.js'

function makeMockDb(): Queryable {
  // Count for evidence query, 0 for all others
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM evidence')) {
      return Promise.resolve({ rows: [{ cnt: '5' }], rowCount: 1, command: '', oid: 0, fields: [] })
    }
    if (sql.includes('COUNT(*)')) {
      return Promise.resolve({ rows: [{ cnt: '0' }], rowCount: 1, command: '', oid: 0, fields: [] })
    }
    if (sql.includes('UPDATE evidence')) {
      return Promise.resolve({ rows: [], rowCount: 3, command: '', oid: 0, fields: [] })
    }
    if (sql.includes('WITH rows AS')) {
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })
    }
    return Promise.resolve({ rows: [{ cnt: '0' }], rowCount: 0, command: '', oid: 0, fields: [] })
  })
  return { query }
}

describe('DataRetentionJob', () => {
  let auditRepo: InMemoryAuditLogsRepository
  let auditLogService: AuditLogService
  let evidenceService: EvidenceStorageService

  const baseConfig: RetentionConfig = {
    dryRun: false,
    batchLimit: 1000,
    entities: {
      scoreHistory: { ttlDays: 90 },
      auditLogs: { ttlDays: 365 },
      slashEvents: { ttlDays: 0 },
      outboxEvents: { ttlDays: 30 },
      evidence: { ttlDays: 0 },
    },
  }

  beforeAll(async () => {
    process.env.EVIDENCE_ENCRYPTION_KEY = '12345678901234567890123456789012'
    await keyManager.initialize()
  })

  beforeEach(() => {
    evidenceDB.clear()
    kekManager._resetStore()
    auditRepo = new InMemoryAuditLogsRepository()
    auditLogService = new AuditLogService(auditRepo)
    evidenceService = new EvidenceStorageService(auditLogService)
  })

  it('should skip evidence when ttlDays = 0', async () => {
    const job = new DataRetentionJob(makeMockDb(), baseConfig, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.ttlDays).toBe(0)
    expect(evidenceAudit.expiredCount).toBe(0)
    expect(evidenceAudit.deletedCount).toBe(0)
  })

  it('should crypto-shred expired evidence and generate proof', async () => {
    // Upload evidence with old timestamp
    await evidenceService.uploadEvidence('old-evidence', 'sensitive data', 'user-1', 'tenant-1')
    const record = evidenceDB.get('old-evidence')!
    record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

    const config: RetentionConfig = {
      ...baseConfig,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.expiredCount).toBe(5) // from SQL mock
    expect(evidenceAudit.deletedCount).toBe(1)

    // Verify the evidence was crypto-shredded
    expect(evidenceService.isShredded('old-evidence')).toBe(true)
    const shredded = evidenceDB.get('old-evidence')!
    expect(shredded.wrappedDek).toBe('')

    // Verify audit log entry
    const allLogs = await auditLogService.getAllLogs()
    const shredLogs = allLogs.filter((l) => l.resourceId === 'old-evidence')
    expect(shredLogs.length).toBeGreaterThanOrEqual(1)
  })

  it('should not shred evidence on legal hold', async () => {
    await evidenceService.uploadEvidence('held-evidence', 'data', 'user-1', 'tenant-1')
    const record = evidenceDB.get('held-evidence')!
    record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    evidenceService.setLegalHold('held-evidence', true)

    const config: RetentionConfig = {
      ...baseConfig,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.expiredCount).toBe(5) // from SQL mock
    expect(evidenceAudit.deletedCount).toBe(0) // only held evidence exists in memory

    // Evidence should still be intact
    expect(evidenceService.isOnLegalHold('held-evidence')).toBe(true)
    expect(evidenceService.isShredded('held-evidence')).toBe(false)
  })

  it('should handle already-shredded evidence idempotently', async () => {
    await evidenceService.uploadEvidence('already-shredded', 'data', 'user-1', 'tenant-1')
    const record = evidenceDB.get('already-shredded')!
    record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    await evidenceService.cryptoShredEvidence('already-shredded', 'pre-shred')

    const config: RetentionConfig = {
      ...baseConfig,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.expiredCount).toBe(5)
    expect(evidenceAudit.deletedCount).toBe(0) // already shredded, excluded
  })

  it('should not shred in dry-run mode', async () => {
    await evidenceService.uploadEvidence('dry-run-ev', 'data', 'user-1', 'tenant-1')
    const record = evidenceDB.get('dry-run-ev')!
    record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)

    const config: RetentionConfig = {
      ...baseConfig,
      dryRun: true,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.dryRun).toBe(true)
    expect(evidenceAudit.deletedCount).toBe(0)
    expect(evidenceService.isShredded('dry-run-ev')).toBe(false)
  })

  it('should continue processing other entities even if evidence service is missing', async () => {
    const config: RetentionConfig = {
      ...baseConfig,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.deletedCount).toBe(0)
    expect(result.entities.length).toBe(5)
  })

  it('should handle partial shred failure gracefully', async () => {
    for (let i = 0; i < 3; i++) {
      await evidenceService.uploadEvidence(`batch-${i}`, `data-${i}`, 'user-1', 'tenant-1')
      const rec = evidenceDB.get(`batch-${i}`)!
      rec.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    }

    evidenceService.setLegalHold('batch-1', true)

    const config: RetentionConfig = {
      ...baseConfig,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.expiredCount).toBe(5)
    // batch-0 and batch-2 should be shredded (batch-1 on hold, excluded from getExpiredEvidenceIds)
    expect(evidenceAudit.deletedCount).toBe(2)
  })

  it('should respect batch limit for evidence shred', async () => {
    for (let i = 0; i < 5; i++) {
      await evidenceService.uploadEvidence(`batch-limit-${i}`, `data-${i}`, 'user-1', 'tenant-1')
      const rec = evidenceDB.get(`batch-limit-${i}`)!
      rec.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    }

    const config: RetentionConfig = {
      ...baseConfig,
      batchLimit: 3,
      entities: { ...baseConfig.entities, evidence: { ttlDays: 30 } },
    }

    const job = new DataRetentionJob(makeMockDb(), config, undefined, evidenceService)
    const result = await job.run()

    const evidenceAudit = result.entities.find((e) => e.entity === 'evidence')!
    expect(evidenceAudit.deletedCount).toBe(3)
  })
})
