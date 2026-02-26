import { randomBytes, createHash } from 'crypto'

export type KeyScope = 'read' | 'full'
export type SubscriptionTier = 'free' | 'pro' | 'enterprise'

export interface StoredApiKey {
  id: string
  /** SHA-256 hash of the raw key */
  hashedKey: string
  /** First 8 chars after the "cr_" prefix — used for fast lookup */
  prefix: string
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
  scope: KeyScope
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
 * @param scope    Access scope: 'read' (default) or 'full'
 * @param tier     Subscription tier controlling rate limits (default: 'free')
 * @returns        Key metadata including the raw key (shown once only)
 */
export function generateApiKey(
  ownerId: string,
  scope: KeyScope = 'read',
  tier: SubscriptionTier = 'free',
): CreateApiKeyResult {
  const random = randomBytes(32).toString('hex') // 64 hex chars
  const rawKey = `cr_${random}` // 67 chars total
  const prefix = extractPrefix(rawKey)
  const id = randomBytes(8).toString('hex')

  const stored: StoredApiKey = {
    id,
    hashedKey: hashKey(rawKey),
    prefix,
    scope,
    tier,
    ownerId,
    createdAt: new Date(),
    lastUsedAt: null,
    active: true,
  }

  store.set(id, stored)
  return { id, key: rawKey, prefix, scope, tier, createdAt: stored.createdAt }
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
  return generateApiKey(existing.ownerId, existing.scope, existing.tier)
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
