/**
 * Tests for IdempotencyGuard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IdempotencyGuard } from './idempotencyGuard.js'
import type { CacheService } from '../cache/redis.js'

describe('IdempotencyGuard', () => {
  let mockCache: CacheService
  let guard: IdempotencyGuard

  beforeEach(() => {
    // Mock CacheService
    mockCache = {
      exists: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      clearNamespace: vi.fn(),
      expire: vi.fn(),
      ttl: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as CacheService

    guard = new IdempotencyGuard(mockCache, {
      ttlSeconds: 3600,
      logger: vi.fn(),
    })
  })

  describe('process', () => {
    it('should execute handler for new message', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const handler = vi.fn().mockResolvedValue('result')

      const result = await guard.process('test-handler', 'msg-123', handler)

      expect(result.executed).toBe(true)
      expect(result.isDuplicate).toBe(false)
      expect(result.value).toBe('result')
      expect(handler).toHaveBeenCalledOnce()
      expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'test-handler:msg-123')
      expect(mockCache.set).toHaveBeenCalledWith(
        'idempotency',
        'test-handler:msg-123',
        expect.objectContaining({ processedAt: expect.any(String) }),
        3600
      )
    })

    it('should skip handler for duplicate message', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(true)

      const handler = vi.fn().mockResolvedValue('result')

      const result = await guard.process('test-handler', 'msg-123', handler)

      expect(result.executed).toBe(false)
      expect(result.isDuplicate).toBe(true)
      expect(result.value).toBeUndefined()
      expect(handler).not.toHaveBeenCalled()
      expect(mockCache.set).not.toHaveBeenCalled()
    })

    it('should write marker before executing handler', async () => {
      const callOrder: string[] = []

      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockImplementation(async () => {
        callOrder.push('marker-written')
        return true
      })

      const handler = vi.fn().mockImplementation(async () => {
        callOrder.push('handler-executed')
        return 'result'
      })

      await guard.process('test-handler', 'msg-123', handler)

      expect(callOrder).toEqual(['marker-written', 'handler-executed'])
    })

    it('should proceed even if marker write fails', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(false)

      const handler = vi.fn().mockResolvedValue('result')

      const result = await guard.process('test-handler', 'msg-123', handler)

      expect(result.executed).toBe(true)
      expect(result.value).toBe('result')
      expect(handler).toHaveBeenCalledOnce()
    })

    it('should propagate handler errors', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const error = new Error('Handler failed')
      const handler = vi.fn().mockRejectedValue(error)

      await expect(guard.process('test-handler', 'msg-123', handler)).rejects.toThrow(
        'Handler failed'
      )
    })

    it('should use different keys for different handler types', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const handler1 = vi.fn().mockResolvedValue('result1')
      const handler2 = vi.fn().mockResolvedValue('result2')

      await guard.process('handler-a', 'msg-123', handler1)
      await guard.process('handler-b', 'msg-123', handler2)

      expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'handler-a:msg-123')
      expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'handler-b:msg-123')
      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
    })

    it('should update metrics correctly', async () => {
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const handler = vi.fn().mockResolvedValue('result')

      await guard.process('test-handler', 'msg-1', handler)
      await guard.process('test-handler', 'msg-2', handler)

      const metrics = guard.getMetrics()
      expect(metrics.processed).toBe(2)
      expect(metrics.executed).toBe(1)
      expect(metrics.duplicates).toBe(1)
      expect(metrics.errors).toBe(0)
    })
  })

  describe('isProcessed', () => {
    it('should return true for processed message', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(true)

      const result = await guard.isProcessed('test-handler', 'msg-123')

      expect(result).toBe(true)
      expect(mockCache.exists).toHaveBeenCalledWith('idempotency', 'test-handler:msg-123')
    })

    it('should return false for new message', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(false)

      const result = await guard.isProcessed('test-handler', 'msg-123')

      expect(result).toBe(false)
    })

    it('should return false on cache error (fail open)', async () => {
      vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis error'))

      const result = await guard.isProcessed('test-handler', 'msg-123')

      expect(result).toBe(false)
    })
  })

  describe('markAsProcessed', () => {
    it('should mark message as processed', async () => {
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const result = await guard.markAsProcessed('test-handler', 'msg-123')

      expect(result).toBe(true)
      expect(mockCache.set).toHaveBeenCalledWith(
        'idempotency',
        'test-handler:msg-123',
        expect.objectContaining({ processedAt: expect.any(String) }),
        3600
      )
    })

    it('should return false on cache error', async () => {
      vi.mocked(mockCache.set).mockRejectedValue(new Error('Redis error'))

      const result = await guard.markAsProcessed('test-handler', 'msg-123')

      expect(result).toBe(false)
    })
  })

  describe('redelivery scenario', () => {
    it('should handle message redelivery correctly', async () => {
      const handler = vi.fn().mockResolvedValue('result')

      // First delivery
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const result1 = await guard.process('attestation', 'event-456', handler)
      expect(result1.executed).toBe(true)
      expect(result1.isDuplicate).toBe(false)
      expect(handler).toHaveBeenCalledTimes(1)

      // Second delivery (redelivery)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)

      const result2 = await guard.process('attestation', 'event-456', handler)
      expect(result2.executed).toBe(false)
      expect(result2.isDuplicate).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1) // Still only called once

      // Third delivery (another redelivery)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)

      const result3 = await guard.process('attestation', 'event-456', handler)
      expect(result3.executed).toBe(false)
      expect(result3.isDuplicate).toBe(true)
      expect(handler).toHaveBeenCalledTimes(1) // Still only called once
    })
  })

  describe('marker expiration behavior', () => {
    it('should allow reprocessing after marker expires', async () => {
      const handler = vi.fn().mockResolvedValue('result')

      // First processing
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const result1 = await guard.process('attestation', 'event-789', handler)
      expect(result1.executed).toBe(true)

      // Marker still exists (within TTL)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(true)

      const result2 = await guard.process('attestation', 'event-789', handler)
      expect(result2.executed).toBe(false)
      expect(result2.isDuplicate).toBe(true)

      // Marker expired (after TTL)
      vi.mocked(mockCache.exists).mockResolvedValueOnce(false)

      const result3 = await guard.process('attestation', 'event-789', handler)
      expect(result3.executed).toBe(true)
      expect(result3.isDuplicate).toBe(false)

      expect(handler).toHaveBeenCalledTimes(2) // Called twice: initial + after expiration
    })

    it('should use custom TTL when provided', async () => {
      const customGuard = new IdempotencyGuard(mockCache, { ttlSeconds: 7200 })

      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const handler = vi.fn().mockResolvedValue('result')

      await customGuard.process('test-handler', 'msg-123', handler)

      expect(mockCache.set).toHaveBeenCalledWith(
        'idempotency',
        'test-handler:msg-123',
        expect.any(Object),
        7200
      )
    })
  })

  describe('metrics', () => {
    it('should track all operations', async () => {
      vi.mocked(mockCache.exists)
        .mockResolvedValueOnce(false) // new
        .mockResolvedValueOnce(true) // duplicate
        .mockResolvedValueOnce(false) // new
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const handler = vi.fn().mockResolvedValue('result')

      await guard.process('handler', 'msg-1', handler)
      await guard.process('handler', 'msg-2', handler)
      await guard.process('handler', 'msg-3', handler)

      const metrics = guard.getMetrics()
      expect(metrics.processed).toBe(3)
      expect(metrics.executed).toBe(2)
      expect(metrics.duplicates).toBe(1)
    })

    it('should track errors', async () => {
      vi.mocked(mockCache.exists).mockRejectedValue(new Error('Redis error'))

      await expect(guard.isProcessed('handler', 'msg-1')).resolves.toBe(false)

      const metrics = guard.getMetrics()
      expect(metrics.errors).toBe(1)
    })

    it('should reset metrics', async () => {
      vi.mocked(mockCache.exists).mockResolvedValue(false)
      vi.mocked(mockCache.set).mockResolvedValue(true)

      const handler = vi.fn().mockResolvedValue('result')
      await guard.process('handler', 'msg-1', handler)

      expect(guard.getMetrics().processed).toBe(1)

      guard.resetMetrics()

      expect(guard.getMetrics().processed).toBe(0)
      expect(guard.getMetrics().executed).toBe(0)
      expect(guard.getMetrics().duplicates).toBe(0)
      expect(guard.getMetrics().errors).toBe(0)
    })
  })
})
