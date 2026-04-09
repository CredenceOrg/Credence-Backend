/**
 * @file src/repositories/member.repository.ts
 *
 * All SQL for the `org_members` table lives here.  The rest of the
 * application never queries org_members directly, ensuring:
 *
 *  1. The soft-delete filter (`deleted_at IS NULL`) is applied consistently —
 *     it cannot be accidentally omitted in a new query.
 *  2. The restore / audit helpers that intentionally query deleted rows are
 *     clearly labelled and centralised.
 */

import type { Pool } from 'pg'
import type { Member, MemberRole } from '../services/members/types.js'

// ---------------------------------------------------------------------------
// Row-level mapper
// ---------------------------------------------------------------------------

/** Maps a raw DB row (snake_case) to the Member domain type (camelCase). */
function rowToMember(row: Record<string, unknown>): Member {
  return {
    id:        row.id as string,
    orgId:     row.org_id as string,
    userId:    row.user_id as string,
    email:     row.email as string,
    role:      row.role as MemberRole,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    deletedBy: (row.deleted_by as string | null) ?? null,
  }
}

/** Strips soft-delete columns for the public API view. */
export function toMemberView(m: Member) {
  const { deletedAt: _da, deletedBy: _db, ...view } = m
  return view
}

export type MemberView = ReturnType<typeof toMemberView>

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class MemberRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Find an **active** member by primary key.
   * Returns null if the member does not exist or has been soft-deleted.
   */
  async findActiveById(id: string): Promise<Member | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM org_members
        WHERE id = $1
          AND deleted_at IS NULL`,
      [id],
    )
    return rows.length ? rowToMember(rows[0]) : null
  }

  /**
   * Find a member by primary key regardless of deletion status.
   * Used by restore and audit endpoints.
   */
  async findById(id: string): Promise<Member | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM org_members WHERE id = $1`,
      [id],
    )
    return rows.length ? rowToMember(rows[0]) : null
  }

  /**
   * Find an **active** member by (org_id, user_id).
   * Relies on the partial unique index: UNIQUE (org_id, user_id) WHERE deleted_at IS NULL.
   */
  async findActiveByOrgAndUser(orgId: string, userId: string): Promise<Member | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM org_members
        WHERE org_id = $1
          AND user_id = $2
          AND deleted_at IS NULL`,
      [orgId, userId],
    )
    return rows.length ? rowToMember(rows[0]) : null
  }

  /**
   * List members for an organisation.
   *
   * @param orgId          - Filter to this organisation.
   * @param includeDeleted - When true, includes soft-deleted rows. Default: false.
   * @param limit          - Page size.
   * @param offset         - Row offset.
   */
  async listByOrg(
    orgId: string,
    includeDeleted: boolean = false,
    limit: number = 50,
    offset: number = 0,
  ): Promise<{ members: Member[]; total: number }> {
    const deleteFilter = includeDeleted ? '' : 'AND deleted_at IS NULL'

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM org_members
        WHERE org_id = $1 ${deleteFilter}`,
      [orgId],
    )
    const total = parseInt(countResult.rows[0].count, 10)

    const { rows } = await this.pool.query(
      `SELECT * FROM org_members
        WHERE org_id = $1 ${deleteFilter}
        ORDER BY created_at ASC
        LIMIT $2 OFFSET $3`,
      [orgId, limit, offset],
    )

    return { members: rows.map(rowToMember), total }
  }

  /**
   * Insert a new active member row.
   * The partial unique index on (org_id, user_id) WHERE deleted_at IS NULL
   * prevents duplicate active memberships at the database level.
   */
  async insert(
    orgId: string,
    userId: string,
    email: string,
    role: MemberRole = 'member',
  ): Promise<Member> {
    const { rows } = await this.pool.query(
      `INSERT INTO org_members (org_id, user_id, email, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [orgId, userId, email, role],
    )
    return rowToMember(rows[0])
  }

  /**
   * Update the role of an active member.
   */
  async updateRole(id: string, role: MemberRole): Promise<Member | null> {
    const { rows } = await this.pool.query(
      `UPDATE org_members
          SET role = $2
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING *`,
      [id, role],
    )
    return rows.length ? rowToMember(rows[0]) : null
  }

  /**
   * Soft-delete a member by setting `deleted_at` and `deleted_by`.
   *
   * After this call the partial unique index no longer covers the row,
   * so the same user can be re-invited to the same org.
   *
   * @returns The updated row, or null if the member was already deleted / not found.
   */
  async softDelete(id: string, deletedBy: string): Promise<Member | null> {
    const { rows } = await this.pool.query(
      `UPDATE org_members
          SET deleted_at = now(),
              deleted_by = $2
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING *`,
      [id, deletedBy],
    )
    return rows.length ? rowToMember(rows[0]) : null
  }

  /**
   * Restore a soft-deleted member by clearing `deleted_at` and `deleted_by`.
   *
   * @returns The updated row, or null if the member was not deleted / not found.
   */
  async restore(id: string): Promise<Member | null> {
    const { rows } = await this.pool.query(
      `UPDATE org_members
          SET deleted_at = NULL,
              deleted_by = NULL
        WHERE id = $1
          AND deleted_at IS NOT NULL
        RETURNING *`,
      [id],
    )
    return rows.length ? rowToMember(rows[0]) : null
  }
}