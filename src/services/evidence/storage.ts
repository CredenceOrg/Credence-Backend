import crypto from 'crypto'

export type Role = 'USER' | 'ARBITRATOR' | 'GOVERNANCE'

export interface EvidenceRecord {
  evidence_id: string
  encryptedBlob: string
  iv: string
  authTag: string
  uploaderId: string
  createdAt: Date
}

// Using an in-memory map to simulate the DB for this service layer
const evidenceDB = new Map<string, EvidenceRecord>()

/**
 * Service for securely storing and retrieving dispute/slash evidence.
 * Implements AES-256-GCM encryption at rest and Role-Based Access Control.
 */
export class EvidenceStorageService {
  private readonly algorithm = 'aes-256-gcm'
  private readonly key: Buffer

  constructor() {
    const secret = process.env.EVIDENCE_ENCRYPTION_KEY
    if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
      throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
    }
    this.key = Buffer.from(secret, 'utf-8')
  }

  /**
   * Encrypts and stores evidence.
   * @param evidenceId - Unique identifier for the evidence
   * @param rawData - The raw evidence string or JSON payload
   * @param uploaderId - ID of the user uploading the evidence
   * @returns The stored EvidenceRecord metadata
   */
  public async uploadEvidence(
    evidenceId: string,
    rawData: string,
    uploaderId: string
  ): Promise<EvidenceRecord> {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv)

    let encrypted = cipher.update(rawData, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')

    const record: EvidenceRecord = {
      evidence_id: evidenceId,
      encryptedBlob: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag,
      uploaderId,
      createdAt: new Date(),
    }

    // Store in DB simulation
    evidenceDB.set(evidenceId, record)

    return record
  }

  /**
   * Retrieves and decrypts evidence if the requesting role is authorized.
   * @param evidenceId - Unique identifier for the evidence
   * @param role - Role of the user requesting the evidence
   * @returns The decrypted raw data
   * @throws Error if unauthorized or evidence not found
   */
  public async retrieveEvidence(
    evidenceId: string,
    role: Role
  ): Promise<string> {
    this.enforceAccessControl(role)

    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }

    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.key,
      Buffer.from(record.iv, 'hex')
    )

    decipher.setAuthTag(Buffer.from(record.authTag, 'hex'))

    let decrypted = decipher.update(record.encryptedBlob, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  }

  /**
   * Enforces RBAC - Only ARBITRATOR and GOVERNANCE can view evidence.
   */
  private enforceAccessControl(role: Role): void {
    const allowedRoles: Role[] = ['ARBITRATOR', 'GOVERNANCE']
    if (!allowedRoles.includes(role)) {
      throw new Error('Unauthorized: Insufficient role permissions')
    }
  }
}
