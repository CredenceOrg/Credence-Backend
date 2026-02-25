import { describe, it, expect, beforeEach } from 'vitest'
import {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  rotateApiKey,
  listApiKeys,
  _resetStore,
} from './apiKeys.js'

beforeEach(() => {
  _resetStore()
})

describe('generateApiKey', () => {
  it('returns a key matching the cr_<64 hex> format', () => {
    const result = generateApiKey('owner1')
    expect(result.key).toMatch(/^cr_[0-9a-f]{64}$/)
  })

  it('defaults scope to read and tier to free', () => {
    const result = generateApiKey('owner1')
    expect(result.scope).toBe('read')
    expect(result.tier).toBe('free')
  })

  it('respects custom scope and tier', () => {
    const result = generateApiKey('owner1', 'full', 'pro')
    expect(result.scope).toBe('full')
    expect(result.tier).toBe('pro')
  })

  it('generates unique keys and IDs on each call', () => {
    const a = generateApiKey('owner1')
    const b = generateApiKey('owner1')
    expect(a.key).not.toBe(b.key)
    expect(a.id).not.toBe(b.id)
  })

  it('sets createdAt to approximately now', () => {
    const before = Date.now()
    const result = generateApiKey('owner1')
    expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

describe('validateApiKey', () => {
  it('validates a freshly generated key', () => {
    const { key } = generateApiKey('owner1')
    const result = validateApiKey(key)
    expect(result).not.toBeNull()
    expect(result?.active).toBe(true)
  })

  it('returns null for keys with invalid format', () => {
    expect(validateApiKey('')).toBeNull()
    expect(validateApiKey('invalid')).toBeNull()
    expect(validateApiKey('sk_badprefix')).toBeNull()
    expect(validateApiKey('cr_tooshort')).toBeNull()
    // Correct length but wrong prefix
    expect(validateApiKey('xx_' + 'a'.repeat(64))).toBeNull()
    // Correct prefix but non-hex content
    expect(validateApiKey('cr_' + 'z'.repeat(64))).toBeNull()
  })

  it('returns null for an unknown key with valid format', () => {
    expect(validateApiKey('cr_' + 'a'.repeat(64))).toBeNull()
  })

  it('updates lastUsedAt on successful validation', () => {
    const { key } = generateApiKey('owner1')
    const before = Date.now()
    const result = validateApiKey(key)
    expect(result?.lastUsedAt).not.toBeNull()
    expect(result?.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('returns null for a revoked key', () => {
    const { id, key } = generateApiKey('owner1')
    revokeApiKey(id)
    expect(validateApiKey(key)).toBeNull()
  })
})

describe('revokeApiKey', () => {
  it('deactivates an active key', () => {
    const { id, key } = generateApiKey('owner1')
    expect(revokeApiKey(id)).toBe(true)
    expect(validateApiKey(key)).toBeNull()
  })

  it('returns false for an unknown ID', () => {
    expect(revokeApiKey('nonexistent')).toBe(false)
  })

  it('can revoke the same key twice without error', () => {
    const { id } = generateApiKey('owner1')
    expect(revokeApiKey(id)).toBe(true)
    // Second call still returns true — key exists, just already inactive
    expect(revokeApiKey(id)).toBe(true)
  })
})

describe('rotateApiKey', () => {
  it('returns a new key with the same scope and tier', () => {
    const { id } = generateApiKey('owner1', 'full', 'pro')
    const result = rotateApiKey(id)
    expect(result).not.toBeNull()
    expect(result?.scope).toBe('full')
    expect(result?.tier).toBe('pro')
  })

  it('invalidates the old key after rotation', () => {
    const { id, key: oldKey } = generateApiKey('owner1')
    rotateApiKey(id)
    expect(validateApiKey(oldKey)).toBeNull()
  })

  it('new key is immediately valid', () => {
    const { id } = generateApiKey('owner1')
    const { key: newKey } = rotateApiKey(id)!
    expect(validateApiKey(newKey)).not.toBeNull()
  })

  it('new key differs from the old key', () => {
    const { id, key: oldKey } = generateApiKey('owner1')
    const result = rotateApiKey(id)
    expect(result?.key).not.toBe(oldKey)
  })

  it('returns null for an unknown ID', () => {
    expect(rotateApiKey('nonexistent')).toBeNull()
  })

  it('returns null when the key is already revoked', () => {
    const { id } = generateApiKey('owner1')
    revokeApiKey(id)
    expect(rotateApiKey(id)).toBeNull()
  })
})

describe('listApiKeys', () => {
  it('returns only keys belonging to the requested owner', () => {
    generateApiKey('owner1')
    generateApiKey('owner1', 'full')
    generateApiKey('owner2')

    const keys = listApiKeys('owner1')
    expect(keys).toHaveLength(2)
    keys.forEach((k) => expect(k.ownerId).toBe('owner1'))
  })

  it('never exposes the hashedKey field', () => {
    generateApiKey('owner1')
    listApiKeys('owner1').forEach((k) => {
      expect(k).not.toHaveProperty('hashedKey')
    })
  })

  it('includes both active and revoked keys', () => {
    const { id } = generateApiKey('owner1')
    generateApiKey('owner1')
    revokeApiKey(id)

    const keys = listApiKeys('owner1')
    expect(keys).toHaveLength(2)
    expect(keys.some((k) => !k.active)).toBe(true)
    expect(keys.some((k) => k.active)).toBe(true)
  })

  it('returns an empty array for an unknown owner', () => {
    expect(listApiKeys('nobody')).toHaveLength(0)
  })
})
