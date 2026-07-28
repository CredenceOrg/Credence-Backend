/**
 * Tests for tenant cache invalidation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invalidateTenantCache, isValidTenantId } from '../invalidation.js'
import { cache } from '../redis.js'
import { ValidationError, ServiceUnavailableError } from '../../lib/errors.js'

vi.mock('../redis.js', () => ({
  cache: {
    clearNamespace: vi.fn(),
    healthCheck: vi.fn()
  }
}))

const VALID_TENANT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe('invalidateTenantCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(cache.healthCheck).mockResolvedValue({ healthy: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('invalidates all cache keys for a tenant', async () => {
    vi.mocked(cache.clearNamespace).mockResolvedValue(7)

    const result = await invalidateTenantCache(VALID_TENANT_ID)

    expect(cache.clearNamespace).toHaveBeenCalledWith(VALID_TENANT_ID)
    expect(result).toEqual({ tenantId: VALID_TENANT_ID, keysCleared: 7 })
  })

  it('rejects an invalid tenant identifier without touching the cache', async () => {
    await expect(invalidateTenantCache('not-a-uuid')).rejects.toThrow(ValidationError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })

  it('rejects an empty tenant identifier', async () => {
    await expect(invalidateTenantCache('')).rejects.toThrow(ValidationError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })

  it('rejects a tenant identifier containing glob characters', async () => {
    await expect(invalidateTenantCache('*')).rejects.toThrow(ValidationError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })

  it('rejects a non-string tenant identifier', async () => {
    await expect(invalidateTenantCache(undefined)).rejects.toThrow(ValidationError)
    await expect(invalidateTenantCache(123 as unknown)).rejects.toThrow(ValidationError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })

  it('succeeds with zero keys cleared when the tenant has no cache entries', async () => {
    vi.mocked(cache.clearNamespace).mockResolvedValue(0)

    const result = await invalidateTenantCache(VALID_TENANT_ID)

    expect(result).toEqual({ tenantId: VALID_TENANT_ID, keysCleared: 0 })
  })

  it('throws ServiceUnavailableError when the cache backend is unreachable', async () => {
    vi.mocked(cache.healthCheck).mockResolvedValue({ healthy: false, error: 'ECONNREFUSED' })

    await expect(invalidateTenantCache(VALID_TENANT_ID)).rejects.toThrow(ServiceUnavailableError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })
})

describe('isValidTenantId', () => {
  it('accepts a valid UUID', () => {
    expect(isValidTenantId(VALID_TENANT_ID)).toBe(true)
    expect(isValidTenantId(VALID_TENANT_ID.toUpperCase())).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isValidTenantId('not-a-uuid')).toBe(false)
    expect(isValidTenantId('')).toBe(false)
    expect(isValidTenantId('*')).toBe(false)
    expect(isValidTenantId(null)).toBe(false)
    expect(isValidTenantId(undefined)).toBe(false)
    expect(isValidTenantId(42)).toBe(false)
  })
})
