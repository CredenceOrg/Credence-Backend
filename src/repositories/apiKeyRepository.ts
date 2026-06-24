import {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  rotateApiKey,
  listApiKeys,
  findApiKeyById,
} from '../services/apiKeys.js'
import type {
  StoredApiKey,
  CreateApiKeyResult,
  KeyScope,
  SubscriptionTier,
} from '../services/apiKeys.js'

/**
 * Persistence contract for integration API keys.
 *
 * Both an in-memory implementation (used in tests and default runtime) and a
 * future PostgreSQL-backed implementation satisfy this interface.
 */
export interface ApiKeyRepository {
  /**
   * Create and persist a new key; returns metadata including the raw key (shown once).
   *
   * @param ownerId  Owner identifier
   * @param scope    Primary scope (legacy; prefer `scopes`)
   * @param tier     Subscription tier
   * @param scopes   Explicit list of granted scopes. When provided, overrides `scope`.
   */
  create(ownerId: string, scope?: KeyScope, tier?: SubscriptionTier, scopes?: string[]): CreateApiKeyResult

  /** Look up a key record by its opaque ID, excluding the hash. Returns null when not found. */
  findById(id: string): Omit<StoredApiKey, 'hashedKey'> | null

  /** Return all keys (active and revoked) for the given owner, without the hash. */
  listByOwner(ownerId: string): Omit<StoredApiKey, 'hashedKey'>[]

  /**
   * Atomically revoke the key identified by `id` and issue a replacement with
   * identical owner, scope(s), and tier.
   *
   * @returns New key metadata (raw key included — shown once), or null if the
   *          key was not found or is already revoked.
   */
  rotate(id: string): CreateApiKeyResult | null

  /**
   * Mark the key as inactive (permanently revoked).
   *
   * @returns true when the key was found and deactivated; false otherwise.
   */
  revoke(id: string): boolean

  /** Validate a raw key string and record the access timestamp. */
  validate(rawKey: string): StoredApiKey | null
}

/**
 * In-memory implementation backed by the singleton store in `apiKeys.ts`.
 * Suitable for local development, unit tests, and the default runtime until a
 * database-backed adapter is wired in.
 */
export class InMemoryApiKeyRepository implements ApiKeyRepository {
  create(ownerId: string, scope: KeyScope = 'read', tier: SubscriptionTier = 'free', scopes?: string[]): CreateApiKeyResult {
    return generateApiKey(ownerId, scope, tier, scopes)
  }

  findById(id: string): Omit<StoredApiKey, 'hashedKey'> | null {
    return findApiKeyById(id)
  }

  listByOwner(ownerId: string): Omit<StoredApiKey, 'hashedKey'>[] {
    return listApiKeys(ownerId)
  }

  rotate(id: string): CreateApiKeyResult | null {
    return rotateApiKey(id)
  }

  revoke(id: string): boolean {
    return revokeApiKey(id)
  }

  validate(rawKey: string): StoredApiKey | null {
    return validateApiKey(rawKey)
  }
}
