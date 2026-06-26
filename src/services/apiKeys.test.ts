import { describe, it, expect, beforeEach } from 'vitest'
import {
  generateApiKey,
  validateApiKey,
  revokeApiKey,
  rotateApiKey,
  listApiKeys,
  _resetStore,
  _setUseInMemory,
  ApiKeyScope,
} from './apiKeys.js'

beforeEach(() => {
  _resetStore()
  _setUseInMemory(true)
})

describe('generateApiKey', () => {
  it('returns a key matching the cr_<64 hex> format', async () => {
    const result = await generateApiKey('owner1')
    expect(result.key).toMatch(/^cr_[0-9a-f]{64}$/)
  })

  it('defaults scopes to empty array (least privilege) and tier to free', async () => {
    const result = await generateApiKey('owner1')
    expect(result.scopes).toEqual([])
    expect(result.tier).toBe('free')
  })

  it('respects custom scopes and tier', async () => {
    const result = await generateApiKey('owner1', [ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ], 'pro')
    expect(result.scopes).toEqual([ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ])
    expect(result.tier).toBe('pro')
  })

  it('generates unique keys and IDs on each call', async () => {
    const a = await generateApiKey('owner1')
    const b = await generateApiKey('owner1')
    expect(a.key).not.toBe(b.key)
    expect(a.id).not.toBe(b.id)
  })

  it('sets createdAt to approximately now', async () => {
    const before = Date.now()
    const result = await generateApiKey('owner1')
    expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

describe('validateApiKey', () => {
  it('validates a freshly generated key', async () => {
    const { key } = await generateApiKey('owner1')
    const result = await validateApiKey(key)
    expect(result).not.toBeNull()
    expect(result?.active).toBe(true)
  })

  it('returns null for keys with invalid format', async () => {
    expect(await validateApiKey('')).toBeNull()
    expect(await validateApiKey('invalid')).toBeNull()
    expect(await validateApiKey('sk_badprefix')).toBeNull()
    expect(await validateApiKey('cr_tooshort')).toBeNull()
    // Correct length but wrong prefix
    expect(await validateApiKey('xx_' + 'a'.repeat(64))).toBeNull()
    // Correct prefix but non-hex content
    expect(await validateApiKey('cr_' + 'z'.repeat(64))).toBeNull()
  })

  it('returns null for an unknown key with valid format', async () => {
    expect(await validateApiKey('cr_' + 'a'.repeat(64))).toBeNull()
  })

  it('updates lastUsedAt on successful validation', async () => {
    const { key } = await generateApiKey('owner1')
    const before = Date.now()
    const result = await validateApiKey(key)
    expect(result?.lastUsedAt).not.toBeNull()
    expect(result?.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('returns null for a revoked key', async () => {
    const { id, key } = await generateApiKey('owner1')
    await revokeApiKey(id)
    expect(await validateApiKey(key)).toBeNull()
  })
})

describe('revokeApiKey', () => {
  it('deactivates an active key', async () => {
    const { id, key } = await generateApiKey('owner1')
    expect(await revokeApiKey(id)).toBe(true)
    expect(await validateApiKey(key)).toBeNull()
  })

  it('returns false for an unknown ID', async () => {
    expect(await revokeApiKey('nonexistent')).toBe(false)
  })

  it('can revoke the same key twice without error', async () => {
    const { id } = await generateApiKey('owner1')
    expect(await revokeApiKey(id)).toBe(true)
    // Second call still returns true — key exists, just already inactive
    expect(await revokeApiKey(id)).toBe(true)
  })
})

describe('rotateApiKey', () => {
  it('returns a new key with the same scopes and tier', async () => {
    const { id } = await generateApiKey('owner1', [ApiKeyScope.BOND_WRITE], 'pro')
    const result = await rotateApiKey(id)
    expect(result).not.toBeNull()
    expect(result?.scopes).toEqual([ApiKeyScope.BOND_WRITE])
    expect(result?.tier).toBe('pro')
  })

  it('invalidates the old key after rotation', async () => {
    const { id, key: oldKey } = await generateApiKey('owner1')
    await rotateApiKey(id)
    expect(await validateApiKey(oldKey)).toBeNull()
  })

  it('new key is immediately valid', async () => {
    const { id } = await generateApiKey('owner1')
    const { key: newKey } = (await rotateApiKey(id))!
    expect(await validateApiKey(newKey)).not.toBeNull()
  })

  it('new key differs from the old key', async () => {
    const { id, key: oldKey } = await generateApiKey('owner1')
    const result = await rotateApiKey(id)
    expect(result?.key).not.toBe(oldKey)
  })

  it('returns null for an unknown ID', async () => {
    expect(await rotateApiKey('nonexistent')).toBeNull()
  })

  it('returns null when the key is already revoked', async () => {
    const { id } = await generateApiKey('owner1')
    await revokeApiKey(id)
    expect(await rotateApiKey(id)).toBeNull()
  })
})

describe('listApiKeys', () => {
  it('returns only keys belonging to the requested owner', async () => {
    await generateApiKey('owner1')
    await generateApiKey('owner1', [ApiKeyScope.BOND_WRITE])
    await generateApiKey('owner2')

    const keys = await listApiKeys('owner1')
    expect(keys).toHaveLength(2)
    keys.forEach((k: any) => expect(k.ownerId).toBe('owner1'))
  })

  it('never exposes the hashedKey field', async () => {
    await generateApiKey('owner1')
    const keys = await listApiKeys('owner1')
    keys.forEach((k: any) => {
      expect(k).not.toHaveProperty('hashedKey')
    })
  })

  it('includes both active and revoked keys', async () => {
    const { id } = await generateApiKey('owner1')
    await generateApiKey('owner1')
    await revokeApiKey(id)

    const keys = await listApiKeys('owner1')
    expect(keys).toHaveLength(2)
    expect(keys.some((k: any) => !k.active)).toBe(true)
    expect(keys.some((k: any) => k.active)).toBe(true)
  })

  it('returns an empty array for an unknown owner', async () => {
    expect(await listApiKeys('nobody')).toHaveLength(0)
  })
})
