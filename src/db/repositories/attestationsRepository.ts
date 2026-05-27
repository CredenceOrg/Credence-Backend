import type { Queryable } from './queryable.js'

export interface Attestation {
  id: number
  bondId: number
  attesterAddress: string
  subjectAddress: string
  score: number
  note: string | null
  createdAt: Date
}

export interface CreateAttestationInput {
  bondId: number
  attesterAddress: string
  subjectAddress: string
  score: number
  note?: string | null
}

export interface ListBySubjectOptions {
  offset?: number
  limit?: number
}

type AttestationRow = {
  id: string | number
  bond_id: string | number
  attester_address: string
  subject_address: string
  score: number
  note: string | null
  created_at: Date | string
}

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value)

const mapAttestation = (row: AttestationRow): Attestation => ({
  id: Number(row.id),
  bondId: Number(row.bond_id),
  attesterAddress: row.attester_address,
  subjectAddress: row.subject_address,
  score: row.score,
  note: row.note,
  createdAt: toDate(row.created_at),
})

export class AttestationsRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateAttestationInput, db: Queryable = this.db): Promise<Attestation> {
    const result = await db.query<AttestationRow>(
      `
      INSERT INTO attestations (bond_id, attester_address, subject_address, score, note)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, bond_id, attester_address, subject_address, score, note, created_at
      `,
      [
        input.bondId,
        input.attesterAddress,
        input.subjectAddress,
        input.score,
        input.note ?? null,
      ]
    )

    return mapAttestation(result.rows[0])
  }

  async findById(id: number): Promise<Attestation | null> {
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE id = $1
      `,
      [id]
    )

    return result.rows[0] ? mapAttestation(result.rows[0]) : null
  }

  async listBySubject(subjectAddress: string): Promise<Attestation[]> {
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE subject_address = $1
      ORDER BY created_at DESC, id DESC
      `,
      [subjectAddress]
    )

    return result.rows.map(mapAttestation)
  }

  /**
   * Count attestations for a subject address.
   */
  async countBySubject(subjectAddress: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM attestations
      WHERE subject_address = $1
      `,
      [subjectAddress]
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  /**
   * List attestations for a subject with offset/limit pagination and total count.
   */
  async listBySubjectPaginated(
    subjectAddress: string,
    options: ListBySubjectOptions = {},
  ): Promise<{ rows: Attestation[]; total: number }> {
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(100, options.limit ?? 20))

    const countResult = await this.db.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM attestations
      WHERE subject_address = $1
      `,
      [subjectAddress]
    )
    const total = Number(countResult.rows[0]?.count ?? 0)

    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE subject_address = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
      `,
      [subjectAddress, limit, offset]
    )

    return {
      rows: result.rows.map(mapAttestation),
      total,
    }
  }

  async listByBond(bondId: number): Promise<Attestation[]> {
    const result = await this.db.query<AttestationRow>(
      `
      SELECT id, bond_id, attester_address, subject_address, score, note, created_at
      FROM attestations
      WHERE bond_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [bondId]
    )

    return result.rows.map(mapAttestation)
  }

  async updateScore(id: number, score: number): Promise<Attestation | null> {
    const result = await this.db.query<AttestationRow>(
      `
      UPDATE attestations
      SET score = $2
      WHERE id = $1
      RETURNING id, bond_id, attester_address, subject_address, score, note, created_at
      `,
      [id, score]
    )

    return result.rows[0] ? mapAttestation(result.rows[0]) : null
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db.query(
      `
      DELETE FROM attestations
      WHERE id = $1
      `,
      [id]
    )

    return (result.rowCount ?? 0) > 0
  }
}
