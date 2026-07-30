export type Role = 'USER' | 'ARBITRATOR' | 'GOVERNANCE'

export interface EvidenceRecord {
  evidence_id: string
  encryptedBlob: string
  iv: string
  authTag: string
  /** Per-row data-encryption key, wrapped (AES-256-GCM encrypted) with tenant KEK */
  wrappedDek: string
  wrappedDekIv: string
  wrappedDekAuthTag: string
  uploaderId: string
  tenantId: string
  createdAt: Date
  kek_version: number
  /** Soft-delete timestamp; null = active */
  deletedAt: Date | null
  /** When true, retention/crypto-shred is blocked */
  legalHold: boolean
  /** When set, crypto-shred has been performed */
  shreddedAt: Date | null
}

export interface ErasureProofPayload {
  evidence_id: string
  erased_at: string
  nonce: string
  tenant_id: string
  actor_id: string
}

export interface ErasureProof {
  evidence_id: string
  signedProofJwt: string
  payload: ErasureProofPayload
  createdAt: Date
}
