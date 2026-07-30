import type { Queryable } from './queryable.js'
import type { TrustIdentityRepository, Identity } from '../../services/reputationService.js'

type IdentityRow = {
  address: string
  bonded_amount: string
  bond_start: Date | string | null
  attestation_count: string | number
}

/**
 * Postgres-backed implementation of TrustIdentityRepository — the durable data
 * source for trust scoring, replacing the former in-memory seeded store.
 *
 * Reads bonded_amount and bond_start from the identities table and counts the
 * attestations naming the address as subject. Attestations have no revocation
 * column, so every recorded attestation counts.
 *
 * Lookups are case-insensitive on the caller's address; the stored form is
 * returned so responses echo the canonical (checksummed) address.
 */
export class PgTrustIdentityRepository implements TrustIdentityRepository {
  constructor(private readonly db: Queryable) {}

  async getIdentityForScoring(address: string): Promise<Identity | null> {
    const normalised = address.toLowerCase()
    const result = await this.db.query<IdentityRow>(
      `
      SELECT i.address,
             i.bonded_amount,
             i.bond_start,
             COUNT(a.id) AS attestation_count
      FROM   identities i
      LEFT JOIN attestations a
             ON a.subject_address = i.address
      WHERE  LOWER(i.address) = $1
      GROUP  BY i.address, i.bonded_amount, i.bond_start
      `,
      [normalised]
    )

    const row = result.rows[0]
    if (!row || !row.address) return null

    return {
      address: row.address,
      bondedAmount: row.bonded_amount ?? '0',
      bondStart: row.bond_start
        ? new Date(row.bond_start).toISOString()
        : null,
      attestationCount: Number(row.attestation_count),
    }
  }
}
