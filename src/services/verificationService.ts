import * as crypto from 'crypto'
import type { IdentityVerification, VerificationError } from './identityService.js'

import type {
  AttestationSummary,
  BondSnapshot,
  SignedVerificationProof,
  VerificationProof,
} from '../types/verification.js'

/**
 * Service for building and signing verification proof packages
 */
export class VerificationService {

  /**
   * Build a canonical JSON string for hashing
   */
  private buildCanonical(data: Record<string, unknown>): string {
    return JSON.stringify(data, Object.keys(data).sort())
  }

  /**
   * Hash data using SHA-256
   */
  private hashData(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex')
  }

  /**
   * Create a verification proof package
   */
  createProof(
    address: string,
    score: number,
    bondSnapshot: BondSnapshot,
    attestationCount: number,
    expiryMinutes?: number
  ): VerificationProof {
    const timestamp = Date.now()
    const attestationHash = this.hashData(attestationCount.toString())

    const attestationSummary: AttestationSummary = {
      count: attestationCount,
      hash: attestationHash,
    }

    const proofData = {
      address,
      score,
      bondSnapshot,
      attestationSummary,
      timestamp,
    }

    const canonical = this.buildCanonical(proofData)
    const hash = this.hashData(canonical)

    const proof: VerificationProof = {
      ...proofData,
      canonical,
      hash,
    }

    if (expiryMinutes) {
      proof.expiresAt = timestamp + expiryMinutes * 60 * 1000
    }

    return proof
  }

  /**
   * Sign a verification proof with a private key
   */
  signProof(proof: VerificationProof, privateKey: string): SignedVerificationProof {
    const signature = crypto
      .createSign('sha256')
      .update(proof.canonical)
      .sign(privateKey, 'hex')

    return {
      ...proof,
      signature,
    }
  }

  /**
   * Verify a proof hash consistency
   */
  verifyProofHash(proof: VerificationProof): boolean {
    const proofData = {
      address: proof.address,
      score: proof.score,
      bondSnapshot: proof.bondSnapshot,
      attestationSummary: proof.attestationSummary,
      timestamp: proof.timestamp,
    }

    const canonical = this.buildCanonical(proofData)
    const expectedHash = this.hashData(canonical)

    return expectedHash === proof.hash
  }

  /**
   * Verify a signed proof
   */
  verifySignedProof(proof: SignedVerificationProof, publicKey: string): boolean {
    try {
      return crypto
        .createVerify('sha256')
        .update(proof.canonical)
        .verify(publicKey, proof.signature, 'hex')
    } catch {
      return false
    }
  }

  /**
   * Check if proof is expired
   */
  isExpired(proof: VerificationProof): boolean {
    if (!proof.expiresAt) return false
    return Date.now() > proof.expiresAt
  }

  /**
   * Enqueue a bulk verification job.
   * This method centralizes server-side metadata (orgId, size) so clients
   * cannot influence the scheduler via crafted payload fields.
   */
  async enqueueBulkVerification(addresses: string[], opts?: { orgId?: string; size?: number }): Promise<string> {
    const size = opts?.size ?? addresses.length
    const orgId = opts?.orgId ?? 'unknown'

    // Lazy-import to avoid circular deps in tests
    const { BulkJobRepository } = await import('../db/repositories/bulkJobRepository.js')
    const { workerPool } = await import('../db/pool.js')
    const repo = new BulkJobRepository(workerPool)

    const job = await repo.create(orgId, size, { addresses })
    return job.id
  }

  /**
   * Verify addresses in chunks by delegating to IdentityService.verifyBulk.
   */
  async verifyBulkChunked(
    addresses: string[],
    chunkSize = 50,
  ): Promise<{ results: IdentityVerification[]; errors: VerificationError[] }> {
    const { IdentityService } = await import('./identityService.js')
    const identitySvc = new IdentityService()
    const results: IdentityVerification[] = []
    const errors: VerificationError[] = []

    for (let i = 0; i < addresses.length; i += chunkSize) {
      const chunk = addresses.slice(i, i + chunkSize)
      // delegate to IdentityService which returns { results, errors }
      const res = await identitySvc.verifyBulk(chunk)
      results.push(...res.results)
      errors.push(...res.errors)
    }

    return { results, errors }
  }
}

export const verificationService = new VerificationService()
