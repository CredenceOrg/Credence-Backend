import type Database from 'better-sqlite3'

/** Row shape for the attestations table. */
export interface Attestation {
  id: number
  verifier: string
  identity_id: number
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
   *
   * @param input - The attestation data to insert.
   * @returns The newly created attestation record.
   */
  create(input: CreateAttestationInput): Attestation {
    const weight = input.weight ?? 1.0
    const stmt = this.db.prepare(
      'INSERT INTO attestations (verifier, identity_id, weight) VALUES (@verifier, @identity_id, @weight)'
    )
    const result = stmt.run({
      verifier: input.verifier,
      identity_id: input.identity_id,
      weight,
    })
    return this.findById(result.lastInsertRowid as number)!
  }

  /**
   * Find an attestation by its ID.
   *
   * @param id - The attestation ID.
   * @returns The attestation record, or undefined if not found.
   */
  findById(id: number): Attestation | undefined {
    const stmt = this.db.prepare('SELECT * FROM attestations WHERE id = ?')
    return stmt.get(id) as Attestation | undefined
  }

  /**
   * Find all attestations for a given identity.
   *
   * @param identityId - The identity ID to look up.
   * @returns An array of attestation records for the identity.
   */
  findByIdentityId(identityId: number): Attestation[] {
    const stmt = this.db.prepare(
      'SELECT * FROM attestations WHERE identity_id = ? ORDER BY id ASC'
    )
    return stmt.all(identityId) as Attestation[]
  }

  /**
   * Revoke an attestation by setting its `revoked` flag to 1.
   *
   * @param id - The attestation ID to revoke.
   * @returns True if the attestation was found and updated, false otherwise.
   */
  revoke(id: number): boolean {
    const stmt = this.db.prepare(
      'UPDATE attestations SET revoked = 1 WHERE id = ?'
    )
    const result = stmt.run(id)
    return result.changes > 0
  }

  /**
   * List all attestations.
   *
   * @returns An array of all attestation records.
   */
  findAll(): Attestation[] {
    const stmt = this.db.prepare('SELECT * FROM attestations ORDER BY id ASC')
    return stmt.all() as Attestation[]
  }
}
