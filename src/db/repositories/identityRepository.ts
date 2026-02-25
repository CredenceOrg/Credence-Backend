import type { Pool, PoolClient } from 'pg'
import type { CreateIdentityInput, Identity } from '../../types/index.ts'


export class IdentityRepository {
     constructor(private readonly db: Pool | PoolClient) { }

     // -------------------------------------------------------------------------
     // Helpers
     // -------------------------------------------------------------------------

     /** Maps a raw postgres row (snake_case) to the Identity domain type. */
     private map(row: Record<string, unknown>): Identity {
          return {
               id: row.id as string,
               address: row.address as string,
               createdAt: row.created_at as Date,
               updatedAt: row.updated_at as Date,
          }
     }

     // -------------------------------------------------------------------------
     // Queries
     // -------------------------------------------------------------------------

     /**
      * Returns all identities ordered by creation date (newest first).
      * @param limit  Maximum rows to return (default 100).
      * @param offset Pagination offset (default 0).
      */
     async findAll(limit = 100, offset = 0): Promise<Identity[]> {
          const { rows } = await this.db.query(
               `SELECT id, address, created_at, updated_at
         FROM identities
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
               [limit, offset],
          )
          return rows.map(this.map)
     }

     /**
      * Returns the identity with the given surrogate UUID, or `null` if not found.
      */
     async findById(id: string): Promise<Identity | null> {
          const { rows } = await this.db.query(
               `SELECT id, address, created_at, updated_at
         FROM identities
        WHERE id = $1`,
               [id],
          )
          return rows.length ? this.map(rows[0]) : null
     }

     /**
      * Returns the identity for the given blockchain address, or `null`.
      */
     async findByAddress(address: string): Promise<Identity | null> {
          const { rows } = await this.db.query(
               `SELECT id, address, created_at, updated_at
         FROM identities
        WHERE address = $1`,
               [address],
          )
          return rows.length ? this.map(rows[0]) : null
     }

     // -------------------------------------------------------------------------
     // Mutations
     // -------------------------------------------------------------------------

     /**
      * Inserts a new identity row and returns the created record.
      * Throws if `address` is already registered (unique constraint).
      */
     async create(input: CreateIdentityInput): Promise<Identity> {
          const { rows } = await this.db.query(
               `INSERT INTO identities (address)
            VALUES ($1)
         RETURNING id, address, created_at, updated_at`,
               [input.address],
          )
          return this.map(rows[0])
     }

     /**
      * Upserts an identity by address.
      * - If the address already exists, `updated_at` is refreshed and the
      *   existing row is returned.
      * - If it does not exist, a new row is inserted.
      */
     async upsert(input: CreateIdentityInput): Promise<Identity> {
          const { rows } = await this.db.query(
               `INSERT INTO identities (address)
            VALUES ($1)
       ON CONFLICT (address)
       DO UPDATE SET updated_at = NOW()
         RETURNING id, address, created_at, updated_at`,
               [input.address],
          )
          return this.map(rows[0])
     }

     /**
      * Hard-deletes the identity with the given UUID.
      * Cascades to all associated bonds (ON DELETE CASCADE).
      * Returns `true` if a row was deleted, `false` if not found.
      */
     async delete(id: string): Promise<boolean> {
          const { rowCount } = await this.db.query(
               `DELETE FROM identities WHERE id = $1`,
               [id],
          )
          return (rowCount ?? 0) > 0
     }
}