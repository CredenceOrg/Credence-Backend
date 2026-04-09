import * as crypto from 'crypto'

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
}

export const verificationService = new VerificationService()
