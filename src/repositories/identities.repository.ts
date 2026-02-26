import type Database from 'better-sqlite3'

/** Row shape for the identities table. */
export interface Identity {
  id: number
  address: string
  created_at: string
}

/** Input for creating a new identity. */
export interface CreateIdentityInput {
  address: string
}

/**
 * Repository for the `identities` table.
 * Provides basic CRUD operations for identity records.
 */
export class IdentitiesRepository {
  private db: Database.Database

  /**
   * @param db - A better-sqlite3 Database instance with migrations already applied.
   */
  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * Create a new identity.
   *
   * @param input - The identity data to insert.
   * @returns The newly created identity record.
   */
  create(input: CreateIdentityInput): Identity {
    const stmt = this.db.prepare(
      'INSERT INTO identities (address) VALUES (@address)'
    )
    const result = stmt.run({ address: input.address })
    return this.findById(result.lastInsertRowid as number)!
  }

  /**
   * Find an identity by its ID.
   *
   * @param id - The identity ID.
   * @returns The identity record, or undefined if not found.
   */
  findById(id: number): Identity | undefined {
    const stmt = this.db.prepare('SELECT * FROM identities WHERE id = ?')
    return stmt.get(id) as Identity | undefined
  }

  /**
   * Find an identity by its on-chain address.
   *
   * @param address - The on-chain address.
   * @returns The identity record, or undefined if not found.
   */
  findByAddress(address: string): Identity | undefined {
    const stmt = this.db.prepare('SELECT * FROM identities WHERE address = ?')
    return stmt.get(address) as Identity | undefined
  }

  /**
   * List all identities.
   *
   * @returns An array of all identity records.
   */
  findAll(): Identity[] {
    const stmt = this.db.prepare('SELECT * FROM identities ORDER BY id ASC')
    return stmt.all() as Identity[]
  }
}
