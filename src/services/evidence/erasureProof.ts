import { randomUUID } from 'node:crypto'
import { keyManager } from '../keyManager/index.js'
import type { ErasureProof, ErasureProofPayload } from './types.js'

const PROOF_EXPIRY = '100y'

export interface SignedErasureProofResult {
  proof: ErasureProof
  jwt: string
}

/**
 * Create a JWT-signed erasure proof for a given evidence record.
 * The proof is signed with the active keyManager RSA key (PS256) and
 * includes a random nonce for replay protection.
 */
export async function createSignedErasureProof(
  evidenceId: string,
  tenantId: string,
  actorId: string,
): Promise<SignedErasureProofResult> {
  const nonce = randomUUID()
  const erasedAt = new Date().toISOString()

  const payload: ErasureProofPayload = {
    evidence_id: evidenceId,
    erased_at: erasedAt,
    nonce,
    tenant_id: tenantId,
    actor_id: actorId,
  }

  const jwt = await keyManager.signToken(
    { ...payload },
    PROOF_EXPIRY,
  )

  const proof: ErasureProof = {
    evidence_id: evidenceId,
    signedProofJwt: jwt,
    payload,
    createdAt: new Date(),
  }

  return { proof, jwt }
}
