import { getDbPool } from '../db.js'
import type { TrustScore, IdentityRecord } from './types.js'

/**
 * Calculate trust score from identity data.
 * Score breakdown:
 * - Bond amount: up to 50 pts (maxes at ≥ 1 ETH = 10^18 wei)
 * - Bond duration: up to 20 pts (maxes at ≥ 365 days)
 * - Attestations: up to 30 pts (maxes at ≥ 5 attestations)
 */
function calculateTrustScore(record: IdentityRecord): number {
  let score = 0

  // Bond amount: 50 pts max
  const bondedAmount = BigInt(record.bonded_amount)
  const oneEth = BigInt('1000000000000000000') // 10^18 wei
  if (bondedAmount >= oneEth) {
    score += 50
  } else if (bondedAmount > 0) {
    score += Math.floor(Number(bondedAmount * BigInt(50) / oneEth))
  }

  // Bond duration: 20 pts max
  if (record.bond_start && record.bond_duration) {
    const bondDurationDays = record.bond_duration / (24 * 60 * 60) // seconds to days
    if (bondDurationDays >= 365) {
      score += 20
    } else if (bondDurationDays > 0) {
      score += Math.floor((bondDurationDays / 365) * 20)
    }
  }

  // Attestations: 30 pts max
  if (record.attestation_count >= 5) {
    score += 30
  } else if (record.attestation_count > 0) {
    score += Math.floor((record.attestation_count / 5) * 30)
  }

  return Math.min(score, 100) // Cap at 100
}

export class TrustService {
  async getTrustScore(address: string): Promise<TrustScore | null> {
    const pool = getDbPool()
    const result = await pool.query(
      'SELECT address, bonded_amount, bond_start, bond_duration, active, attestation_count, agreed_fields FROM identities WHERE address = $1',
      [address.toLowerCase()]
    )

    if (result.rows.length === 0) {
      return null
    }

    const record: IdentityRecord = result.rows[0]
    const score = calculateTrustScore(record)

    return {
      address: record.address,
      score,
      bondedAmount: record.bonded_amount,
      bondStart: record.bond_start ? new Date(record.bond_start * 1000).toISOString() : null,
      attestationCount: record.attestation_count,
      agreedFields: record.agreed_fields || undefined,
    }
  }
}