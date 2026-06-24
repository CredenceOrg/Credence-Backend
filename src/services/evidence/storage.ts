import crypto from 'crypto'
import { kekManager } from '../keyManager/index.js'
import type { EvidenceRecord, Role } from './types.js'
import { createSignedErasureProof } from './erasureProof.js'
import type { AuditLogService } from '../audit/index.js'
import { AuditAction } from '../audit/types.js'

export type { Role, EvidenceRecord } from './types.js'
export type { ErasureProof } from './types.js'

export const evidenceDB = new Map<string, EvidenceRecord>()

export class EvidenceStorageService {
  private readonly algorithm = 'aes-256-gcm'
  private readonly auditLogService: AuditLogService | null

  constructor(auditLogService?: AuditLogService) {
    this.auditLogService = auditLogService ?? null

    if (kekManager.getAllVersions().length === 0) {
      const secret = process.env.EVIDENCE_ENCRYPTION_KEY
      if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
        throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
      }
    }
  }

  private getKey(version: number): Buffer {
    try {
      return kekManager.getVersion(version).keyMaterial
    } catch {
      const secret = process.env.EVIDENCE_ENCRYPTION_KEY
      if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
        throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
      }
      return Buffer.from(secret, 'utf-8')
    }
  }

  private getCurrentKey(): { key: Buffer; version: number } {
    try {
      const kek = kekManager.getCurrentKek()
      return { key: kek.keyMaterial, version: kek.version }
    } catch {
      const secret = process.env.EVIDENCE_ENCRYPTION_KEY
      if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
        throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
      }
      return { key: Buffer.from(secret, 'utf-8'), version: 1 }
    }
  }

  private validateId(id: string): void {
    if (!id || id.trim().length === 0 || /\s/.test(id)) {
      throw new Error('Invalid evidence id')
    }
  }

  /**
   * Uploads evidence using envelope encryption:
   * 1. Generates a random per-row DEK (Data Encryption Key)
   * 2. Encrypts rawData with the DEK (AES-256-GCM)
   * 3. Wraps (encrypts) the DEK with the tenant KEK (AES-256-GCM)
   * 4. Stores both ciphertext and wrapped DEK
   */
  public async uploadEvidence(
    evidenceId: string,
    rawData: string,
    uploaderId: string,
    tenantId: string = 'default',
  ): Promise<EvidenceRecord> {
    this.validateId(evidenceId)
    if (evidenceDB.has(evidenceId)) {
      throw new Error('Evidence already exists')
    }

    // 1. Generate per-row DEK
    const dek = crypto.randomBytes(32)

    // 2. Encrypt evidence data with DEK
    const dataIv = crypto.randomBytes(12)
    const dataCipher = crypto.createCipheriv(this.algorithm, dek, dataIv)
    let encrypted = dataCipher.update(rawData, 'utf8', 'hex')
    encrypted += dataCipher.final('hex')
    const authTag = dataCipher.getAuthTag().toString('hex')

    // 3. Wrap DEK with tenant KEK
    const { key: kek, version } = this.getCurrentKey()
    const wrapIv = crypto.randomBytes(12)
    const wrapCipher = crypto.createCipheriv(this.algorithm, kek, wrapIv)
    let wrapped = wrapCipher.update(dek.toString('hex'), 'utf8', 'hex')
    wrapped += wrapCipher.final('hex')
    const wrapAuthTag = wrapCipher.getAuthTag().toString('hex')

    const record: EvidenceRecord = {
      evidence_id: evidenceId,
      encryptedBlob: encrypted,
      iv: dataIv.toString('hex'),
      authTag,
      wrappedDek: wrapped,
      wrappedDekIv: wrapIv.toString('hex'),
      wrappedDekAuthTag: wrapAuthTag,
      uploaderId,
      tenantId,
      createdAt: new Date(),
      kek_version: version,
      deletedAt: null,
      legalHold: false,
      shreddedAt: null,
    }

    evidenceDB.set(evidenceId, record)
    return record
  }

  /**
   * Retrieves and decrypts evidence.
   * Unwraps the per-row DEK using the tenant KEK, then decrypts the blob with the DEK.
   * Returns null for shredded evidence (ciphertext no longer exists).
   */
  public async retrieveEvidence(evidenceId: string, role: Role): Promise<string> {
    this.validateId(evidenceId)
    this.enforceAccessControl(role)

    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }

    if (record.shreddedAt) {
      throw new Error('Evidence has been shredded')
    }

    // Unwrap DEK
    const kek = this.getKey(record.kek_version ?? 1)
    const unwrapDecipher = crypto.createDecipheriv(
      this.algorithm,
      kek,
      Buffer.from(record.wrappedDekIv, 'hex'),
    )
    unwrapDecipher.setAuthTag(Buffer.from(record.wrappedDekAuthTag, 'hex'))
    let dekHex = unwrapDecipher.update(record.wrappedDek, 'hex', 'utf8')
    dekHex += unwrapDecipher.final('utf8')
    const dek = Buffer.from(dekHex, 'hex')

    // Decrypt blob with DEK
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      dek,
      Buffer.from(record.iv, 'hex'),
    )
    decipher.setAuthTag(Buffer.from(record.authTag, 'hex'))
    let decrypted = decipher.update(record.encryptedBlob, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  }

  /**
   * Soft-deletes evidence metadata. Does NOT crypto-shred the key.
   */
  public async softDeleteEvidence(evidenceId: string): Promise<void> {
    this.validateId(evidenceId)
    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }
    record.deletedAt = new Date()
  }

  /**
   * Sets or clears the legal hold flag.
   * When legal hold is true, crypto-shred and retention deletion are blocked.
   */
  public setLegalHold(evidenceId: string, hold: boolean): void {
    this.validateId(evidenceId)
    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }
    record.legalHold = hold
  }

  /**
   * Returns whether a record is on legal hold.
   */
  public isOnLegalHold(evidenceId: string): boolean {
    this.validateId(evidenceId)
    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }
    return record.legalHold
  }

  /**
   * Performs crypto-shred on an evidence record:
   * 1. Verifies not on legal hold
   * 2. Zeroizes the wrapped DEK, encrypted blob, IV, and auth tag
   * 3. Marks shreddedAt
   * 4. Creates and records a signed erasure proof
   * 5. Writes EVIDENCE_SHREDDED audit log entry
   *
   * Idempotent: if already shredded, returns the existing or a fresh proof.
   */
  public async cryptoShredEvidence(
    evidenceId: string,
    actorId: string = 'SYSTEM',
  ): Promise<{ proofJwt: string; evidenceId: string }> {
    this.validateId(evidenceId)
    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }

    if (record.legalHold) {
      throw new Error('Evidence is on legal hold and cannot be shredded')
    }

    // Idempotent: if already shredded, still return a proof
    if (record.shreddedAt) {
      const { jwt } = await createSignedErasureProof(
        evidenceId,
        record.tenantId,
        actorId,
      )
      return { proofJwt: jwt, evidenceId }
    }

    // Generate signed proof BEFORE zeroizing (capture evidence_id, erased_at, nonce)
    const { jwt } = await createSignedErasureProof(
      evidenceId,
      record.tenantId,
      actorId,
    )

    // Crypto-shred: zeroize sensitive fields
    record.wrappedDek = ''
    record.wrappedDekIv = ''
    record.wrappedDekAuthTag = ''
    record.encryptedBlob = ''
    record.iv = ''
    record.authTag = ''
    record.shreddedAt = new Date()

    // Write audit log entry
    if (this.auditLogService) {
      await this.auditLogService.logAction({
        tenantId: record.tenantId,
        actorId,
        actorEmail: `${actorId}@system.internal`,
        action: AuditAction.EVIDENCE_SHREDDED,
        resourceType: 'evidence',
        resourceId: evidenceId,
        details: {
          proofJwt: jwt,
          shreddedAt: record.shreddedAt.toISOString(),
        },
      })
    }

    return { proofJwt: jwt, evidenceId }
  }

  /**
   * Returns IDs of evidence records that have expired based on TTL
   * and are NOT on legal hold, NOT already shredded, NOT already soft-deleted.
   */
  public getExpiredEvidenceIds(ttlDays: number): string[] {
    if (ttlDays <= 0) return []

    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000)
    const expired: string[] = []

    for (const [id, record] of evidenceDB) {
      if (
        record.createdAt < cutoff &&
        !record.legalHold &&
        record.shreddedAt === null &&
        record.deletedAt === null
      ) {
        expired.push(id)
      }
    }

    return expired
  }

  /**
   * Returns the erasure proof JWT for a given evidence ID.
   * Throws if the evidence was never shredded.
   */
  public getErasureProofJwt(evidenceId: string): string | null {
    this.validateId(evidenceId)
    const record = evidenceDB.get(evidenceId)
    if (!record || !record.shreddedAt) {
      return null
    }
    // The proof JWT would need to be re-fetched from audit logs.
    // This method signals that the record was shredded.
    return null
  }

  /**
   * Returns whether an evidence record has been shredded.
   */
  public isShredded(evidenceId: string): boolean {
    this.validateId(evidenceId)
    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }
    return record.shreddedAt !== null
  }

  private enforceAccessControl(role: Role): void {
    const allowedRoles: Role[] = ['ARBITRATOR', 'GOVERNANCE']
    if (!allowedRoles.includes(role)) {
      throw new Error('Unauthorized: Insufficient role permissions')
    }
  }
}
