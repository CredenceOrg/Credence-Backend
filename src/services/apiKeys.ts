import { randomBytes, createHash } from 'crypto'

export type KeyScope = 'read' | 'full' | string   // extended to accept granular scope strings
export type SubscriptionTier = 'free' | 'pro' | 'enterprise'

export interface StoredApiKey {
  id: string
  /** SHA-256 hash of the raw key */
  hashedKey: string
  /** First 8 chars after the "cr_" prefix — used for fast lookup */
  prefix: string
  /**
   * Granted scopes for this key.
   *
   * Legacy keys carry a single-element array with 'read' or 'full'.
   * Granular keys carry one or more scope strings from ApiScope.
   *
   * The `scope` field (singular) is kept for backward compatibility and
   * reflects the primary / most-privileged scope in the array.
   */
  scopes: string[]
  /** @deprecated Use `scopes` instead. Kept for backward compatibility. */
  scope: KeyScope
  tier: SubscriptionTier
  ownerId: string
  createdAt: Date
  lastUsedAt: Date | null
  active: boolean
}

export interface CreateApiKeyResult {
  id: string
  /** Raw key — only returned once at creation/rotation. Store securely. */
  key: string
  prefix: string
  /** @deprecated Use `scopes` instead. */
  scope: KeyScope
  scopes: string[]
  tier: SubscriptionTier
  createdAt: Date
}

// In-memory store — replace with a DB adapter in production
const store = new Map<string, StoredApiKey>()

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

/** Returns the 8-char lookup prefix (chars 3–11 of the raw key, after "cr_") */
function extractPrefix(rawKey: string): string {
  return rawKey.slice(3, 11)
}

/**
 * Generate and store a new API key.
 *
 * @param ownerId  Identifier of the key owner (user/org ID)
 * @param scope    Primary access scope: 'read' (default) or 'full', or a granular scope string
 * @param tier     Subscription tier controlling rate limits (default: 'free')
 * @param scopes   Optional explicit list of granted scopes. When provided, overrides `scope`.
 * @returns        Key metadata including the raw key (shown once only)
 */
export function generateApiKey(
  ownerId: string,
  scope: KeyScope = 'read',
  tier: SubscriptionTier = 'free',
  scopes?: string[],
): CreateApiKeyResult {
  const random = randomBytes(32).toString('hex') // 64 hex chars
  const rawKey = `cr_${random}` // 67 chars total
  const prefix = extractPrefix(rawKey)
  const id = randomBytes(8).toString('hex')

  const grantedScopes = scopes ?? [scope]
  const primaryScope = grantedScopes[0] as KeyScope

  const stored: StoredApiKey = {
    id,
    hashedKey: hashKey(rawKey),
    prefix,
    scope: primaryScope,
    scopes: grantedScopes,
    tier,
    ownerId,
    createdAt: new Date(),
    lastUsedAt: null,
    active: true,
  }

  store.set(id, stored)
  return {
    id,
    key: rawKey,
    prefix,
    scope: primaryScope,
    scopes: grantedScopes,
    tier,
    createdAt: stored.createdAt,
  }
}

/**
 * Validate a raw API key.
 *
 * @param rawKey  The key supplied by the caller
 * @returns       The stored key record (with lastUsedAt updated) or null if invalid/revoked
 */
export function validateApiKey(rawKey: string): StoredApiKey | null {
  if (!/^cr_[0-9a-f]{64}$/.test(rawKey)) return null

  const prefix = extractPrefix(rawKey)
  const hashed = hashKey(rawKey)

  for (const key of store.values()) {
    if (key.prefix === prefix && key.hashedKey === hashed) {
      if (!key.active) return null
      key.lastUsedAt = new Date()
      return key
    }
  }
  return null
}

/**
 * Revoke an API key by ID.
 *
 * @returns true if the key was found and deactivated, false if not found
 */
export function revokeApiKey(id: string): boolean {
  const key = store.get(id)
  if (!key) return false
  key.active = false
  return true
}

/**
 * Rotate an API key: revokes the existing key and issues a new one with the same
 * scope, tier, and owner. Returns null if the key doesn't exist or is already revoked.
 */
export function rotateApiKey(id: string): CreateApiKeyResult | null {
  const existing = store.get(id)
  if (!existing || !existing.active) return null

  existing.active = false
  return generateApiKey(existing.ownerId, existing.scope, existing.tier, existing.scopes)
}

/**
 * Retrieve a single key record by its ID without exposing the hash.
 *
 * @returns Key metadata (minus `hashedKey`), or null if not found.
 */
export function findApiKeyById(id: string): Omit<StoredApiKey, 'hashedKey'> | null {
  const key = store.get(id)
  if (!key) return null
  const { hashedKey: _h, ...rest } = key
  return rest
}

/**
 * List all keys for an owner. The `hashedKey` field is omitted.
 */
export function listApiKeys(ownerId: string): Omit<StoredApiKey, 'hashedKey'>[] {
  return [...store.values()]
    .filter((k) => k.ownerId === ownerId)
    .map(({ hashedKey: _h, ...rest }) => rest)
}

/** Reset the in-memory store. Intended for use in tests only. */
export function _resetStore(): void {
  store.clear()
}
