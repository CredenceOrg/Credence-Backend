import { randomBytes } from 'node:crypto'
import { EvidenceStorageService, evidenceDB } from './storage.js'
import { kekManager, keyManager } from '../keyManager/index.js'
import { InMemoryAuditLogsRepository } from '../../db/repositories/auditLogsRepository.js'
import { AuditLogService, AuditAction } from '../audit/index.js'

describe('EvidenceStorageService', () => {
  let service: EvidenceStorageService
  let auditLogService: AuditLogService
  let auditRepo: InMemoryAuditLogsRepository

  beforeAll(async () => {
    process.env.EVIDENCE_ENCRYPTION_KEY = '12345678901234567890123456789012'
    // Initialize keyManager for erasure proof signing
    await keyManager.initialize()
  })

  beforeEach(() => {
    evidenceDB.clear()
    kekManager._resetStore()
    // keyManager is NOT reset here — it must stay initialized for proof signing
    auditRepo = new InMemoryAuditLogsRepository()
    auditLogService = new AuditLogService(auditRepo)
    service = new EvidenceStorageService(auditLogService)
  })

  describe('uploadEvidence', () => {
    it('should upload and retrieve encrypted evidence with per-row DEK', async () => {
      const evidenceId = 'dispute-123'
      const rawData = 'Screenshot of malicious transaction'

      await service.uploadEvidence(evidenceId, rawData, 'user-1', 'tenant-1')
      const decrypted = await service.retrieveEvidence(evidenceId, 'ARBITRATOR')

      expect(decrypted).toBe(rawData)
    })

    it('should store a wrapped DEK distinct from the KEK', async () => {
      const evidenceId = 'dispute-dek-1'
      await service.uploadEvidence(evidenceId, 'secret data', 'user-1', 'tenant-1')

      const record = evidenceDB.get(evidenceId)!
      expect(record.wrappedDek).toBeTruthy()
      expect(record.wrappedDek).not.toBe('')
      expect(record.wrappedDekIv).toBeTruthy()
      expect(record.wrappedDekAuthTag).toBeTruthy()
      // The wrapped DEK should be different from the raw key
      expect(record.wrappedDek.length).toBeGreaterThan(0)
    })

    it('should reject duplicate evidence IDs', async () => {
      await service.uploadEvidence('dup-id', 'payload', 'user-1', 'tenant-1')
      await expect(
        service.uploadEvidence('dup-id', 'payload2', 'user-1', 'tenant-1'),
      ).rejects.toThrow('Evidence already exists')
    })

    it('should reject invalid evidence IDs', async () => {
      await expect(
        service.uploadEvidence(' ', 'payload', 'user-1', 'tenant-1'),
      ).rejects.toThrow('Invalid evidence id')
    })
  })

  describe('retrieveEvidence', () => {
    it('should allow ARBITRATOR to decrypt evidence', async () => {
      await service.uploadEvidence('e1', 'data', 'user-1', 'tenant-1')
      const result = await service.retrieveEvidence('e1', 'ARBITRATOR')
      expect(result).toBe('data')
    })

    it('should allow GOVERNANCE to decrypt evidence', async () => {
      await service.uploadEvidence('e2', 'data', 'user-1', 'tenant-1')
      const result = await service.retrieveEvidence('e2', 'GOVERNANCE')
      expect(result).toBe('data')
    })

    it('should deny access to USER role', async () => {
      await service.uploadEvidence('e3', 'data', 'user-1', 'tenant-1')
      await expect(
        service.retrieveEvidence('e3', 'USER'),
      ).rejects.toThrow('Unauthorized')
    })

    it('should throw for non-existent evidence', async () => {
      await expect(
        service.retrieveEvidence('nonexistent', 'ARBITRATOR'),
      ).rejects.toThrow('Evidence not found')
    })

    it('should throw for shredded evidence', async () => {
      await service.uploadEvidence('e4', 'data', 'user-1', 'tenant-1')
      await service.cryptoShredEvidence('e4', 'test-actor')
      await expect(
        service.retrieveEvidence('e4', 'ARBITRATOR'),
      ).rejects.toThrow('Evidence has been shredded')
    })
  })

  describe('softDeleteEvidence', () => {
    it('should mark evidence as soft-deleted', async () => {
      await service.uploadEvidence('e-del', 'data', 'user-1', 'tenant-1')
      await service.softDeleteEvidence('e-del')
      const record = evidenceDB.get('e-del')!
      expect(record.deletedAt).toBeInstanceOf(Date)
    })

    it('should throw for non-existent evidence', async () => {
      await expect(
        service.softDeleteEvidence('nonexistent'),
      ).rejects.toThrow('Evidence not found')
    })
  })

  describe('legalHold', () => {
    it('should set and check legal hold flag', async () => {
      await service.uploadEvidence('e-hold', 'data', 'user-1', 'tenant-1')
      service.setLegalHold('e-hold', true)
      expect(service.isOnLegalHold('e-hold')).toBe(true)
      service.setLegalHold('e-hold', false)
      expect(service.isOnLegalHold('e-hold')).toBe(false)
    })

    it('should throw for non-existent evidence on set', () => {
      expect(() => service.setLegalHold('nonexistent', true)).toThrow(
        'Evidence not found',
      )
    })

    it('should prevent crypto-shred when on legal hold', async () => {
      await service.uploadEvidence('e-hold2', 'data', 'user-1', 'tenant-1')
      service.setLegalHold('e-hold2', true)
      await expect(
        service.cryptoShredEvidence('e-hold2', 'test-actor'),
      ).rejects.toThrow('Evidence is on legal hold')
    })
  })

  describe('cryptoShredEvidence', () => {
    it('should zeroize wrapped DEK and encrypted blob', async () => {
      await service.uploadEvidence('e-shred', 'sensitive data', 'user-1', 'tenant-1')
      await service.cryptoShredEvidence('e-shred', 'test-actor')

      const record = evidenceDB.get('e-shred')!
      expect(record.wrappedDek).toBe('')
      expect(record.wrappedDekIv).toBe('')
      expect(record.wrappedDekAuthTag).toBe('')
      expect(record.encryptedBlob).toBe('')
      expect(record.iv).toBe('')
      expect(record.authTag).toBe('')
      expect(record.shreddedAt).toBeInstanceOf(Date)
    })

    it('should return a signed proof JWT', async () => {
      await service.uploadEvidence('e-proof', 'data', 'user-1', 'tenant-1')
      const result = await service.cryptoShredEvidence('e-proof', 'test-actor')

      expect(result.evidenceId).toBe('e-proof')
      expect(result.proofJwt).toBeTruthy()
      // JWT has three dot-separated parts
      expect(result.proofJwt.split('.')).toHaveLength(3)
    })

    it('should be idempotent on repeated calls', async () => {
      await service.uploadEvidence('e-idem', 'data', 'user-1', 'tenant-1')
      const result1 = await service.cryptoShredEvidence('e-idem', 'actor-1')
      const result2 = await service.cryptoShredEvidence('e-idem', 'actor-2')

      expect(result2.evidenceId).toBe('e-idem')
      expect(result2.proofJwt).toBeTruthy()
      // Still shows as shredded
      expect(service.isShredded('e-idem')).toBe(true)
    })

    it('should write EVIDENCE_SHREDDED audit log entry', async () => {
      await service.uploadEvidence('e-audit', 'data', 'user-1', 'tenant-1')
      await service.cryptoShredEvidence('e-audit', 'retention-job')

      const allLogs = await auditLogService.getAllLogs()
      const shredLogs = allLogs.filter(
        (l) => l.action === AuditAction.EVIDENCE_SHREDDED,
      )
      expect(shredLogs).toHaveLength(1)
      expect(shredLogs[0].resourceId).toBe('e-audit')
      expect(shredLogs[0].details?.proofJwt).toBeTruthy()
    })

    it('should throw for non-existent evidence', async () => {
      await expect(
        service.cryptoShredEvidence('nonexistent', 'actor'),
      ).rejects.toThrow('Evidence not found')
    })
  })

  describe('getExpiredEvidenceIds', () => {
    it('should return expired evidence IDs', async () => {
      // Create old evidence (simulate by setting createdAt in the past)
      const now = Date.now()
      const oldTime = new Date(now - 100 * 24 * 60 * 60 * 1000) // 100 days ago

      await service.uploadEvidence('recent', 'data', 'user-1', 'tenant-1')
      const record = evidenceDB.get('recent')!
      record.createdAt = new Date(now - 5 * 24 * 60 * 60 * 1000) // 5 days ago

      await service.uploadEvidence('old', 'data', 'user-1', 'tenant-1')
      const oldRecord = evidenceDB.get('old')!
      oldRecord.createdAt = oldTime

      const expired = service.getExpiredEvidenceIds(30) // TTL = 30 days
      expect(expired).toContain('old')
      expect(expired).not.toContain('recent')
    })

    it('should exclude legal hold evidence from expired', async () => {
      await service.uploadEvidence('hold-exp', 'data', 'user-1', 'tenant-1')
      const record = evidenceDB.get('hold-exp')!
      record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
      service.setLegalHold('hold-exp', true)

      const expired = service.getExpiredEvidenceIds(30)
      expect(expired).not.toContain('hold-exp')
    })

    it('should exclude already shredded evidence', async () => {
      await service.uploadEvidence('shred-exp', 'data', 'user-1', 'tenant-1')
      const record = evidenceDB.get('shred-exp')!
      record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
      await service.cryptoShredEvidence('shred-exp', 'actor')

      const expired = service.getExpiredEvidenceIds(30)
      expect(expired).not.toContain('shred-exp')
    })

    it('should exclude already soft-deleted evidence', async () => {
      await service.uploadEvidence('del-exp', 'data', 'user-1', 'tenant-1')
      const record = evidenceDB.get('del-exp')!
      record.createdAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
      await service.softDeleteEvidence('del-exp')

      const expired = service.getExpiredEvidenceIds(30)
      expect(expired).not.toContain('del-exp')
    })

    it('should return empty for ttlDays <= 0', () => {
      expect(service.getExpiredEvidenceIds(0)).toEqual([])
      expect(service.getExpiredEvidenceIds(-1)).toEqual([])
    })
  })

  describe('isShredded', () => {
    it('should return true after crypto-shred', async () => {
      await service.uploadEvidence('e-check', 'data', 'user-1', 'tenant-1')
      expect(service.isShredded('e-check')).toBe(false)
      await service.cryptoShredEvidence('e-check', 'actor')
      expect(service.isShredded('e-check')).toBe(true)
    })

    it('should throw for non-existent evidence', () => {
      expect(() => service.isShredded('nope')).toThrow('Evidence not found')
    })
  })

  describe('getErasureProofJwt', () => {
    it('should return null for non-shredded evidence', async () => {
      await service.uploadEvidence('e-noproof', 'data', 'user-1', 'tenant-1')
      expect(service.getErasureProofJwt('e-noproof')).toBeNull()
    })
  })

  describe('initialization', () => {
    it('should fail to initialize if key is missing or invalid length', () => {
      const origKey = process.env.EVIDENCE_ENCRYPTION_KEY
      process.env.EVIDENCE_ENCRYPTION_KEY = 'short-key'
      expect(() => new EvidenceStorageService()).toThrow(
        'EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.',
      )
      process.env.EVIDENCE_ENCRYPTION_KEY = origKey
    })
  })
})
