import type { Queryable } from './queryable.js'
import type { StoredApiKey } from '../../services/apiKeys.js'
import type { KeyScope } from '../../services/apiKeys.js'

/**
 * Repository for API key persistence operations.
 *
 * Security-relevant invariants enforced (or relied upon) by this module:
 *
 * 1. A key can only resolve for authentication while it is `active` **and**
 *    carries at least one granted scope — see `findByHashAndPrefix`. Revoking
 *    a key, or stripping its scopes, therefore takes effect on the very next
 *    lookup.
 * 2. Mutations performed on behalf of an authenticated owner are scoped by
 *    `owner_id`, so a caller can never update or revoke a key it does not own.
 * 3. `listByOwner` never selects `hashed_key`; the hash only ever travels with
 *    a full `StoredApiKey` returned by an explicit lookup.
 * 4. Database failures are propagated, never swallowed. Callers must see a
 *    rejected promise rather than a silent no-op, so an outage can never be
 *    mistaken for "key not found" or "no keys".
 */
export class ApiKeysRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Create a new API key in the database.
   *
   * `keyData.scopes` is expected to carry at least one scope: a key with no
   * scopes can never authenticate (see `findByHashAndPrefix`), so creating one
   * only wastes a row.
   *
   * @returns The persisted key, including the database-assigned `id`.
   * @throws  When the insert is rejected (e.g. a duplicate `hashed_key`) or the
   *          database yields no `RETURNING` row — callers never receive a
   *          partially-populated record.
   */
  async createApiKey(keyData: Omit<StoredApiKey, 'id'>): Promise<StoredApiKey> {
    const result = await this.db.query(
      `INSERT INTO api_keys (hashed_key, prefix, scopes, tier, owner_id, created_at, last_used_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, hashed_key, prefix, scopes, tier, owner_id, created_at, last_used_at, active`,
      [
        keyData.hashedKey,
        keyData.prefix,
        keyData.scopes,
        keyData.tier,
        keyData.ownerId,
        keyData.createdAt,
        keyData.lastUsedAt,
        keyData.active,
      ]
    )

    const row = result.rows[0]
    if (!row) {
      throw new Error('api_keys insert returned no row')
    }

    return {
      id: row.id.toString(),
      hashedKey: row.hashed_key,
      prefix: row.prefix,
      scope: row.scopes[0] as KeyScope,
      scopes: row.scopes as KeyScope[],
      tier: row.tier,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      active: row.active,
    }
  }

  /**
   * Find an API key by its hashed value and prefix.
   *
   * Only returns keys that are active and have at least one scope assigned, so
   * a revoked or scope-less key can never be resolved here. A failure is
   * propagated (the lookup fails closed) — it must never be reported as a
   * successful authentication result.
   */
  async findByHashAndPrefix(hashedKey: string, prefix: string): Promise<StoredApiKey | null> {
    const result = await this.db.query(
      `SELECT id, hashed_key, prefix, scopes, tier, owner_id, created_at, last_used_at, active
       FROM api_keys
       WHERE hashed_key = $1 AND prefix = $2 AND active = true AND cardinality(scopes) > 0`,
      [hashedKey, prefix]
    )

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]
    return {
      id: row.id.toString(),
      hashedKey: row.hashed_key,
      prefix: row.prefix,
      scope: row.scopes[0] as KeyScope,
      scopes: row.scopes as KeyScope[],
      tier: row.tier,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      active: row.active,
    }
  }

  /**
   * Update the last_used_at timestamp for a key.
   *
   * The ownerId is required to ensure the key belongs to the authenticated
   * owner: the UPDATE is always scoped by `owner_id`, so a caller can never
   * touch another owner's usage record. A failure is propagated rather than
   * swallowed; recording usage is best-effort bookkeeping, but a caller must
   * still be able to observe that it failed.
   */
  async updateLastUsedAt(id: string, ownerId: string): Promise<void> {
    await this.db.query(
      `UPDATE api_keys SET last_used_at = current_timestamp WHERE id = $1 AND owner_id = $2`,
      [id, ownerId]
    )
  }

  /**
   * Revoke an API key by setting active to false.
   *
   * When `ownerId` is supplied the UPDATE is additionally scoped to that owner,
   * so an authenticated caller can never revoke a key belonging to somebody
   * else. Callers that have already resolved and authorised the key's owner
   * upstream (admin tooling, the rotation service) may omit it and revoke by ID
   * alone — that is the legacy behaviour and is kept for compatibility.
   *
   * @returns `true` only when a row was actually deactivated. `false` means the
   *          key does not exist or is not owned by `ownerId`; in either case no
   *          state changed. Repeating a revoke is idempotent and stays `true`
   *          for the owner: the key simply remains inactive.
   * @throws  When the update fails, so a database error can never be mistaken
   *          for a successful revocation.
   */
  async revokeApiKey(id: string, ownerId?: string): Promise<boolean> {
    const result =
      ownerId === undefined
        ? await this.db.query(
            `UPDATE api_keys SET active = false WHERE id = $1 RETURNING id`,
            [id]
          )
        : await this.db.query(
            `UPDATE api_keys SET active = false WHERE id = $1 AND owner_id = $2 RETURNING id`,
            [id, ownerId]
          )
    return result.rows.length > 0
  }

  /**
   * List all API keys for an owner.
   *
   * The `hashed_key` column is intentionally not selected: key hashes must
   * never leave the process in a listing payload. Results are ordered by
   * creation time, newest first.
   */
  async listByOwner(ownerId: string): Promise<Omit<StoredApiKey, 'hashedKey'>[]> {
    const result = await this.db.query(
      `SELECT id, prefix, scopes, tier, owner_id, created_at, last_used_at, active
       FROM api_keys
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
      [ownerId]
    )

    return result.rows.map((row: any) => ({
      id: row.id.toString(),
      prefix: row.prefix,
      scope: row.scopes[0] as KeyScope,
      scopes: row.scopes as KeyScope[],
      tier: row.tier,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      active: row.active,
    }))
  }

  /**
   * Delete all API keys.
   *
   * Destructive: intended for tests and local tooling only. A failure is
   * propagated so callers are never told the table was cleared when it wasn't.
   */
  async deleteAll(): Promise<void> {
    await this.db.query('DELETE FROM api_keys')
  }
}
