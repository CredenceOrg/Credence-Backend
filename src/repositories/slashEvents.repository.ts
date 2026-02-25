import type Database from 'better-sqlite3'

/** Row shape for the slash_events table. */
export interface SlashEvent {
  id: number
  identity_id: number
  amount: string
  reason: string
  evidence_ref: string | null
  timestamp: string
  created_at: string
}

/** Input for creating a new slash event. */
export interface CreateSlashEventInput {
  identity_id: number
  amount: string
  reason: string
  evidence_ref?: string | null
}

/**
 * Repository for the `slash_events` table.
 * Provides create and read operations for slash event records.
 */
export class SlashEventsRepository {
  private db: Database.Database

  /**
   * @param db - A better-sqlite3 Database instance with migrations already applied.
   */
  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * Create a new slash event.
   *
   * @param input - The slash event data to insert.
   * @returns The newly created slash event record.
   */
  create(input: CreateSlashEventInput): SlashEvent {
    const stmt = this.db.prepare(
      'INSERT INTO slash_events (identity_id, amount, reason, evidence_ref) VALUES (@identity_id, @amount, @reason, @evidence_ref)'
    )
    const result = stmt.run({
      identity_id: input.identity_id,
      amount: input.amount,
      reason: input.reason,
      evidence_ref: input.evidence_ref ?? null,
    })
    return this.findById(result.lastInsertRowid as number)!
  }

  /**
   * Find a slash event by its ID.
   *
   * @param id - The slash event ID.
   * @returns The slash event record, or undefined if not found.
   */
  findById(id: number): SlashEvent | undefined {
    const stmt = this.db.prepare('SELECT * FROM slash_events WHERE id = ?')
    return stmt.get(id) as SlashEvent | undefined
  }

  /**
   * Find all slash events for a given identity.
   *
   * @param identityId - The identity ID to look up.
   * @returns An array of slash event records for the identity.
   */
  findByIdentityId(identityId: number): SlashEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM slash_events WHERE identity_id = ? ORDER BY id ASC'
    )
    return stmt.all(identityId) as SlashEvent[]
  }

  /**
   * List all slash events.
   *
   * @returns An array of all slash event records.
   */
  findAll(): SlashEvent[] {
    const stmt = this.db.prepare('SELECT * FROM slash_events ORDER BY id ASC')
    return stmt.all() as SlashEvent[]
  }
}
