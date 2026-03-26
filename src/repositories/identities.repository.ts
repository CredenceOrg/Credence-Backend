import Database from 'better-sqlite3'

/** Row shape for the identities table. */
export interface Identity {
  id: number
  address: string
  version: number 
  api_key: string | null // Added for Issue #130
  created_at: string
}

/** Input for creating a new identity. */
export interface CreateIdentityInput {
  address: string
}

export class IdentitiesRepository {
  private db: Database.Database

  /**
   * @param db - A better-sqlite3 Database instance.
   */
  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * Create a new identity with a default version of 1.
   */
  create(input: CreateIdentityInput): Identity {
    const stmt = this.db.prepare(
      'INSERT INTO identities (address, version) VALUES (@address, 1)'
    )
    const result = stmt.run({ address: input.address })
    const lastId = result.lastInsertRowid as number
    
    const record = this.findById(lastId)
    if (!record) throw new Error('Failed to retrieve record after creation')
    return record
  }

  /**
   * Update an identity using optimistic locking.
   * Returns the updated Identity or null if the version mismatched (Conflict).
   */
  updateWithLock(id: number, expectedVersion: number, address: string): Identity | null {
    const stmt = this.db.prepare(`
      UPDATE identities 
      SET address = @address, version = version + 1 
      WHERE id = @id AND version = @expectedVersion
    `)

    const result = stmt.run({ 
      address, 
      id, 
      expectedVersion 
    })

    if (result.changes === 0) {
      return null
    }

    return this.findById(id) || null
  }

  /**
   * ISSUE #130: Update the API Key for a specific identity.
   * Returns true if the update was successful.
   */
  updateApiKey(id: number, newKey: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE identities 
      SET api_key = @newKey, version = version + 1 
      WHERE id = @id
    `)
    
    const result = stmt.run({ id, newKey })
    return result.changes > 0
  }

  /**
   * Find an identity by its ID.
   */
  findById(id: number): Identity | undefined {
    const stmt = this.db.prepare('SELECT * FROM identities WHERE id = ?')
    return stmt.get(id) as Identity | undefined
  }

  /**
   * Find an identity by its on-chain address.
   */
  findByAddress(address: string): Identity | undefined {
    const stmt = this.db.prepare('SELECT * FROM identities WHERE address = ?')
    return stmt.get(address) as Identity | undefined
  }

  /**
   * List all identities (ordered by ID).
   */
  findAll(): Identity[] {
    const stmt = this.db.prepare('SELECT * FROM identities ORDER BY id ASC')
    return stmt.all() as Identity[]
  }
}