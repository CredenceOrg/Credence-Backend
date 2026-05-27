import type Database from 'better-sqlite3'

/** Row shape for the attestations table. */
export interface Attestation {
  id: number
  verifier: string
  identity_id: number
  claim: string | null
  timestamp: string
  weight: number
  revoked: number
  created_at: string
}

/** Input for creating a new attestation. */
export interface CreateAttestationInput {
  verifier: string
  identity_id: number
  weight?: number
  claim?: string | null
}

export interface ListBySubjectAddressOptions {
  includeRevoked?: boolean
  offset?: number
  limit?: number
}

/**
 * Repository for the `attestations` table.
 * Provides create, read, and revoke operations for attestation records.
 */
export class AttestationsRepository {
  private db: Database.Database

  /**
   * @param db - A better-sqlite3 Database instance with migrations already applied.
   */
  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * Create a new attestation.
   */
  create(input: CreateAttestationInput): Attestation {
    const weight = input.weight ?? 1.0
    const stmt = this.db.prepare(
      'INSERT INTO attestations (verifier, identity_id, weight, claim) VALUES (@verifier, @identity_id, @weight, @claim)'
    )
    const result = stmt.run({
      verifier: input.verifier,
      identity_id: input.identity_id,
      weight,
      claim: input.claim ?? null,
    })
    return this.findById(result.lastInsertRowid as number)!
  }

  findById(id: number): Attestation | undefined {
    const stmt = this.db.prepare('SELECT * FROM attestations WHERE id = ?')
    return stmt.get(id) as Attestation | undefined
  }

  findByIdentityId(identityId: number): Attestation[] {
    const stmt = this.db.prepare(
      'SELECT * FROM attestations WHERE identity_id = ? ORDER BY id ASC'
    )
    return stmt.all(identityId) as Attestation[]
  }

  /**
   * List attestations for an identity address with pagination and accurate totals.
   */
  findBySubjectAddress(
    address: string,
    options: ListBySubjectAddressOptions = {},
  ): { attestations: Attestation[]; total: number } {
    const includeRevoked = options.includeRevoked ?? false
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(100, options.limit ?? 20))

    const identity = this.db
      .prepare('SELECT id FROM identities WHERE address = ?')
      .get(address) as { id: number } | undefined

    if (!identity) {
      return { attestations: [], total: 0 }
    }

    const revokedClause = includeRevoked ? '' : 'AND revoked = 0'

    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attestations WHERE identity_id = ? ${revokedClause}`,
      )
      .get(identity.id) as { count: number }
    const total = countRow?.count ?? 0

    const rows = this.db
      .prepare(
        `SELECT * FROM attestations
         WHERE identity_id = ? ${revokedClause}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(identity.id, limit, offset) as Attestation[]

    return { attestations: rows, total }
  }

  /**
   * Count attestations for an identity address.
   */
  countBySubjectAddress(address: string, includeRevoked = false): number {
    const identity = this.db
      .prepare('SELECT id FROM identities WHERE address = ?')
      .get(address) as { id: number } | undefined

    if (!identity) {
      return 0
    }

    const revokedClause = includeRevoked ? '' : 'AND revoked = 0'
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attestations WHERE identity_id = ? ${revokedClause}`,
      )
      .get(identity.id) as { count: number }

    return countRow?.count ?? 0
  }

  revoke(id: number): boolean {
    const stmt = this.db.prepare(
      'UPDATE attestations SET revoked = 1 WHERE id = ?'
    )
    const result = stmt.run(id)
    return result.changes > 0
  }

  findAll(): Attestation[] {
    const stmt = this.db.prepare('SELECT * FROM attestations ORDER BY id ASC')
    return stmt.all() as Attestation[]
  }
}
