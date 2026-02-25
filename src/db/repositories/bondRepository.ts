import type { Pool, PoolClient } from 'pg'
import type { Bond, CreateBondInput, UpdateBondInput } from '../../types/index.ts'


export class BondRepository {
     constructor(private readonly db: Pool | PoolClient) { }

     // -------------------------------------------------------------------------
     // Helpers
     // -------------------------------------------------------------------------

     private map(row: Record<string, unknown>): Bond {
          return {
               id: row.id as string,
               identityId: row.identity_id as string,
               bondedAmount: row.bonded_amount as string,
               bondStart: row.bond_start as Date,
               bondDuration: row.bond_duration as string,
               bondEnd: row.bond_end as Date,
               slashedAmount: row.slashed_amount as string,
               active: row.active as boolean,
               createdAt: row.created_at as Date,
               updatedAt: row.updated_at as Date,
          }
     }

     // -------------------------------------------------------------------------
     // Queries
     // -------------------------------------------------------------------------

     /** Returns all bonds for a given identity, newest first. */
     async findByIdentityId(identityId: string): Promise<Bond[]> {
          const { rows } = await this.db.query(
               `SELECT id, identity_id, bonded_amount, bond_start, bond_duration,
              bond_end, slashed_amount, active, created_at, updated_at
         FROM bonds
        WHERE identity_id = $1
        ORDER BY created_at DESC`,
               [identityId],
          )
          return rows.map(this.map)
     }

     /** Returns the single active bond for an identity, or `null`. */
     async findActiveBond(identityId: string): Promise<Bond | null> {
          const { rows } = await this.db.query(
               `SELECT id, identity_id, bonded_amount, bond_start, bond_duration,
              bond_end, slashed_amount, active, created_at, updated_at
         FROM bonds
        WHERE identity_id = $1
          AND active = TRUE
        LIMIT 1`,
               [identityId],
          )
          return rows.length ? this.map(rows[0]) : null
     }

     /** Returns a bond by its UUID, or `null`. */
     async findById(id: string): Promise<Bond | null> {
          const { rows } = await this.db.query(
               `SELECT id, identity_id, bonded_amount, bond_start, bond_duration,
              bond_end, slashed_amount, active, created_at, updated_at
         FROM bonds
        WHERE id = $1`,
               [id],
          )
          return rows.length ? this.map(rows[0]) : null
     }

     /**
      * Returns all bonds that have passed their `bond_end` but are still
      * marked active – useful for a scheduled expiry job.
      */
     async findExpired(): Promise<Bond[]> {
          const { rows } = await this.db.query(
               `SELECT id, identity_id, bonded_amount, bond_start, bond_duration,
              bond_end, slashed_amount, active, created_at, updated_at
         FROM bonds
        WHERE active = TRUE
          AND bond_end < NOW()`,
          )
          return rows.map(this.map)
     }

     // -------------------------------------------------------------------------
     // Mutations
     // -------------------------------------------------------------------------

     /**
      * Creates a new bond for an identity.
      * `bondStart` defaults to NOW() when omitted.
      */
     async create(input: CreateBondInput): Promise<Bond> {
          const bondStart = input.bondStart ?? new Date()
          const { rows } = await this.db.query(
               `INSERT INTO bonds
              (identity_id, bonded_amount, bond_start, bond_duration)
           VALUES ($1, $2, $3, $4::INTERVAL)
        RETURNING id, identity_id, bonded_amount, bond_start, bond_duration,
                  bond_end, slashed_amount, active, created_at, updated_at`,
               [input.identityId, input.bondedAmount, bondStart, input.bondDuration],
          )
          return this.map(rows[0])
     }

     /**
      * Partially updates a bond – only `slashedAmount` and/or `active`.
      * Returns the updated record, or `null` if the bond was not found.
      */
     async update(id: string, input: UpdateBondInput): Promise<Bond | null> {
          // Build a dynamic SET clause from only the provided fields
          const setClauses: string[] = []
          const values: unknown[] = []
          let idx = 1

          if (input.slashedAmount !== undefined) {
               setClauses.push(`slashed_amount = $${idx++}`)
               values.push(input.slashedAmount)
          }
          if (input.active !== undefined) {
               setClauses.push(`active = $${idx++}`)
               values.push(input.active)
          }

          if (setClauses.length === 0) return this.findById(id)

          values.push(id)
          const { rows } = await this.db.query(
               `UPDATE bonds
          SET ${setClauses.join(', ')}
        WHERE id = $${idx}
    RETURNING id, identity_id, bonded_amount, bond_start, bond_duration,
              bond_end, slashed_amount, active, created_at, updated_at`,
               values,
          )
          return rows.length ? this.map(rows[0]) : null
     }

     /**
      * Deactivates a bond (sets `active = FALSE`).
      * Returns `true` if the bond existed and was updated.
      */
     async deactivate(id: string): Promise<boolean> {
          const { rowCount } = await this.db.query(
               `UPDATE bonds SET active = FALSE WHERE id = $1 AND active = TRUE`,
               [id],
          )
          return (rowCount ?? 0) > 0
     }

     /**
      * Hard-deletes a bond row.
      * Returns `true` if a row was deleted.
      */
     async delete(id: string): Promise<boolean> {
          const { rowCount } = await this.db.query(
               `DELETE FROM bonds WHERE id = $1`,
               [id],
          )
          return (rowCount ?? 0) > 0
     }
}