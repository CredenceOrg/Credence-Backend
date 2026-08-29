import type { Queryable } from './queryable.js'
import type { StoredApiKey } from '../../services/apiKeys.js'
import type { KeyScope } from '../../services/apiKeys.js'

/**
 * Repository for API key persistence operations
 */
export class ApiKeysRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Create a new API key in the database
   */
  async createApiKey(keyData: Omit<StoredApiKey, 'id'>): Promise<StoredApiKey> {
    const result = await this.db.query(
      `IINSERT INTO api_keys (hashed_key, prefix, scopes, tier, owner_id, created_at, last_used_at, active)
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
   * Only returns keys that are active and have at least one scope assigned.
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
   * The ownerId is required to ensure the key belongs to the authenticated owner.
   */
  async updateLastUsedAt(id: string, ownerId: string): Promise<void> {
    await this.db.query(
      `UPDATE api_keys SET last_used_at = current_timestamp WHERE id = $1 AND owner_id = $2`,
      [id, ownerId]
    )
  }

  /**
   * Revoke an API key by setting active to false.
   * The ownerId is required to ensure the key belongs to the authenticated owner.
   */
  async revokeApiKey(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE api_keys SET active = false WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [id, ownerId]
    )
    return result.rows.length > 0
  }

  /**
   * List all API keys for an owner
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
   * Delete all API keys (for testing)
   */
  async deleteAll(): Promise<void> {
    await this.db.query('DELETE FROM api_keys')
  }
}
