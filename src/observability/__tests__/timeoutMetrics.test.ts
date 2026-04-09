/**
 * Tests for timeout metrics collection and observability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ConsoleTimeoutMetrics,
  ProductionTimeoutMetrics,
  createDefaultMetricsCollector,
  createTimeoutEvent,
  createSlowOperationEvent,
  createSuccessEvent,
  type TimeoutEvent,
  type SlowOperationEvent,
  type SuccessEvent,
} from '../timeoutMetrics.js'

describe('Timeout Metrics', () => {
  let consoleSpy: {
    error: ReturnType<typeof vi.spyOn>
    warn: ReturnType<typeof vi.spyOn>
    info: ReturnType<typeof vi.spyOn>
    debug: ReturnType<typeof vi.spyOn>
  }

  beforeEach(() => {
    consoleSpy = {
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('ConsoleTimeoutMetrics', () => {
    let metrics: ConsoleTimeoutMetrics

    beforeEach(() => {
      metrics = new ConsoleTimeoutMetrics()
    })

    describe('onTimeout', () => {
      it('should log timeout events to console.error', () => {
        const event: TimeoutEvent = createTimeoutEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'cache.get.user.123',
          timeoutMs: 500,
          actualDurationMs: 500,
        })

        metrics.onTimeout(event)

        expect(consoleSpy.error).toHaveBeenCalledWith(
          '🔴 TIMEOUT [cache] cache.get.user.123'
        )
        expect(consoleSpy.error).toHaveBeenCalledWith('   Reason: CACHE_GET_TIMEOUT')
        expect(consoleSpy.error).toHaveBeenCalledWith('   Duration: 500ms / 500ms')
        expect(consoleSpy.error).toHaveBeenCalledWith(
          expect.stringContaining('Timestamp:')
        )
      })

      it('should include context in timeout logs', () => {
        const event: TimeoutEvent = createTimeoutEvent({
          serviceType: 'soroban',
          reasonCode: 'SOROBAN_RPC_TIMEOUT',
          operation: 'SOROBAN_getContractData',
          timeoutMs: 5000,
          actualDurationMs: 5000,
          context: { contractId: 'abc123', address: '0x123...' },
        })

        metrics.onTimeout(event)

        expect(consoleSpy.error).toHaveBeenCalledWith('   Context:', {
          contractId: 'abc123',
          address: '0x123...',
        })
      })
    })

    describe('onSlowOperation', () => {
      it('should log slow operations to console.warn', () => {
        const event: SlowOperationEvent = createSlowOperationEvent({
          serviceType: 'database',
          reasonCode: 'DB_QUERY_TIMEOUT',
          operation: 'SELECT * FROM users',
          timeoutMs: 2000,
          actualDurationMs: 1800,
        })

        metrics.onSlowOperation(event)

        expect(consoleSpy.warn).toHaveBeenCalledWith(
          '🟡 SLOW [database] SELECT * FROM users'
        )
        expect(consoleSpy.warn).toHaveBeenCalledWith('   Reason: DB_QUERY_TIMEOUT')
        expect(consoleSpy.warn).toHaveBeenCalledWith('   Duration: 1800ms / 2000ms (90.0%)')
        expect(consoleSpy.warn).toHaveBeenCalledWith(
          expect.stringContaining('Timestamp:')
        )
      })

      it('should calculate percentage correctly', () => {
        const event: SlowOperationEvent = createSlowOperationEvent({
          serviceType: 'http',
          reasonCode: 'HTTP_REQUEST_TIMEOUT',
          operation: 'HTTP https://api.example.com',
          timeoutMs: 10000,
          actualDurationMs: 8500,
        })

        metrics.onSlowOperation(event)

        expect(consoleSpy.warn).toHaveBeenCalledWith(
          '   Duration: 8500ms / 10000ms (85.0%)'
        )
      })
    })

    describe('onSuccess', () => {
      it('should log operations close to timeout', () => {
        const event: SuccessEvent = createSuccessEvent({
          serviceType: 'webhook',
          reasonCode: 'WEBHOOK_DELIVERY_TIMEOUT',
          operation: 'WEBHOOK https://webhook.example.com',
          timeoutMs: 10000,
          actualDurationMs: 7500, // 75% of timeout
        })

        metrics.onSuccess(event)

        expect(consoleSpy.info).toHaveBeenCalledWith(
          '🟠 NEAR_TIMEOUT [webhook] WEBHOOK https://webhook.example.com'
        )
        expect(consoleSpy.info).toHaveBeenCalledWith('   Reason: WEBHOOK_DELIVERY_TIMEOUT')
        expect(consoleSpy.info).toHaveBeenCalledWith('   Duration: 7500ms / 10000ms')
      })

      it('should not log fast operations', () => {
        const event: SuccessEvent = createSuccessEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'cache.get.config',
          timeoutMs: 500,
          actualDurationMs: 100, // Only 20% of timeout
        })

        metrics.onSuccess(event)

        expect(consoleSpy.info).not.toHaveBeenCalled()
      })
    })

    describe('getSummary', () => {
      beforeEach(() => {
        metrics.clear()
      })

      it('should provide comprehensive summary', () => {
        // Add some test events
        metrics.onTimeout(createTimeoutEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'cache.get.test1',
          timeoutMs: 500,
          actualDurationMs: 500,
        }))

        metrics.onSlowOperation(createSlowOperationEvent({
          serviceType: 'database',
          reasonCode: 'DB_QUERY_TIMEOUT',
          operation: 'SELECT * FROM test',
          timeoutMs: 2000,
          actualDurationMs: 1800,
        }))

        metrics.onSuccess(createSuccessEvent({
          serviceType: 'http',
          reasonCode: 'HTTP_REQUEST_TIMEOUT',
          operation: 'HTTP https://api.test.com',
          timeoutMs: 5000,
          actualDurationMs: 1000,
        }))

        const summary = metrics.getSummary()

        expect(summary.totalOperations).toBe(3)
        expect(summary.timeouts.count).toBe(1)
        expect(summary.slowOperations.count).toBe(1)
        expect(summary.successOperations.count).toBe(1)
        expect(summary.timeouts.byServiceType.cache).toBe(1)
        expect(summary.slowOperations.byServiceType.database).toBe(1)
        expect(summary.successOperations.byServiceType.http.count).toBe(1)
      })

      it('should filter by period when provided', () => {
        const now = new Date()
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

        // Add event outside period
        metrics.onSuccess(createSuccessEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'old_operation',
          timeoutMs: 500,
          actualDurationMs: 100,
        }))

        // Mock timestamp to be outside period
        vi.spyOn(Date, 'now').mockReturnValue(oneHourAgo.getTime())

        metrics.onSuccess(createSuccessEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'new_operation',
          timeoutMs: 500,
          actualDurationMs: 100,
        }))

        vi.restoreAllMocks()

        const summary = metrics.getSummary({
          start: now,
          end: new Date(now.getTime() + 60000),
        })

        // Should only include events within the period
        expect(summary.totalOperations).toBe(1)
      })
    })

    describe('clear', () => {
      it('should clear all collected events', () => {
        // Add events
        metrics.onTimeout(createTimeoutEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'test',
          timeoutMs: 500,
          actualDurationMs: 500,
        }))

        expect(metrics.getSummary().totalOperations).toBe(1)

        metrics.clear()

        expect(metrics.getSummary().totalOperations).toBe(0)
      })
    })
  })

  describe('ProductionTimeoutMetrics', () => {
    let metrics: ProductionTimeoutMetrics

    beforeEach(() => {
      metrics = new ProductionTimeoutMetrics('test_prefix')
    })

    it('should log timeout events to debug', () => {
      const event: TimeoutEvent = createTimeoutEvent({
        serviceType: 'cache',
        reasonCode: 'CACHE_GET_TIMEOUT',
        operation: 'cache.get.test',
        timeoutMs: 500,
        actualDurationMs: 500,
      })

      metrics.onTimeout(event)

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        '[test_prefix] timeout: cache cache.get.test (CACHE_GET_TIMEOUT)'
      )
    })

    it('should log slow operations to debug', () => {
      const event: SlowOperationEvent = createSlowOperationEvent({
        serviceType: 'database',
        reasonCode: 'DB_QUERY_TIMEOUT',
        operation: 'SELECT * FROM test',
        timeoutMs: 2000,
        actualDurationMs: 1800,
      })

      metrics.onSlowOperation(event)

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        '[test_prefix] slow: database SELECT * FROM test (DB_QUERY_TIMEOUT)'
      )
    })

    it('should log success events to debug', () => {
      const event: SuccessEvent = createSuccessEvent({
        serviceType: 'http',
        reasonCode: 'HTTP_REQUEST_TIMEOUT',
        operation: 'HTTP https://api.test.com',
        timeoutMs: 5000,
        actualDurationMs: 1000,
      })

      metrics.onSuccess(event)

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        '[test_prefix] success: http HTTP https://api.test.com (HTTP_REQUEST_TIMEOUT)'
      )
    })
  })

  describe('createDefaultMetricsCollector', () => {
    it('should return console metrics in development', () => {
      const originalEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'development'

      const collector = createDefaultMetricsCollector()

      expect(collector).toBeInstanceOf(ConsoleTimeoutMetrics)

      process.env.NODE_ENV = originalEnv
    })

    it('should return console metrics in test', () => {
      const originalEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'test'

      const collector = createDefaultMetricsCollector()

      expect(collector).toBeInstanceOf(ConsoleTimeoutMetrics)

      process.env.NODE_ENV = originalEnv
    })

    it('should return production metrics in production', () => {
      const originalEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'

      const collector = createDefaultMetricsCollector()

      expect(collector).toBeInstanceOf(ProductionTimeoutMetrics)

      process.env.NODE_ENV = originalEnv
    })
  })

  describe('Event Creation Utilities', () => {
    describe('createTimeoutEvent', () => {
      it('should create timeout event with timestamp', () => {
        const before = new Date()
        const event = createTimeoutEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'cache.get.test',
          timeoutMs: 500,
          actualDurationMs: 500,
        })
        const after = new Date()

        expect(event.timestamp).toBeInstanceOf(Date)
        expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
        expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
        expect(event.serviceType).toBe('cache')
        expect(event.reasonCode).toBe('CACHE_GET_TIMEOUT')
        expect(event.operation).toBe('cache.get.test')
        expect(event.timeoutMs).toBe(500)
        expect(event.actualDurationMs).toBe(500)
      })

      it('should include error when provided', () => {
        const error = new Error('Test error')
        const event = createTimeoutEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'cache.get.test',
          timeoutMs: 500,
          actualDurationMs: 500,
          error,
        })

        expect(event.error).toBe(error)
      })
    })

    describe('createSlowOperationEvent', () => {
      it('should calculate percentage of timeout', () => {
        const event = createSlowOperationEvent({
          serviceType: 'database',
          reasonCode: 'DB_QUERY_TIMEOUT',
          operation: 'SELECT * FROM test',
          timeoutMs: 2000,
          actualDurationMs: 1500,
        })

        expect(event.percentageOfTimeout).toBe(75)
      })

      it('should handle edge case percentages', () => {
        const event1 = createSlowOperationEvent({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'cache.get.test',
          timeoutMs: 500,
          actualDurationMs: 0,
        })

        expect(event1.percentageOfTimeout).toBe(0)

        const event2 = createSlowOperationEvent({
          serviceType: 'http',
          reasonCode: 'HTTP_REQUEST_TIMEOUT',
          operation: 'HTTP https://api.test.com',
          timeoutMs: 1000,
          actualDurationMs: 1000,
        })

        expect(event2.percentageOfTimeout).toBe(100)
      })
    })

    describe('createSuccessEvent', () => {
      it('should create success event with timestamp', () => {
        const before = new Date()
        const event = createSuccessEvent({
          serviceType: 'webhook',
          reasonCode: 'WEBHOOK_DELIVERY_TIMEOUT',
          operation: 'WEBHOOK https://webhook.test.com',
          timeoutMs: 10000,
          actualDurationMs: 2000,
        })
        const after = new Date()

        expect(event.timestamp).toBeInstanceOf(Date)
        expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
        expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
        expect(event.serviceType).toBe('webhook')
        expect(event.reasonCode).toBe('WEBHOOK_DELIVERY_TIMEOUT')
        expect(event.operation).toBe('WEBHOOK https://webhook.test.com')
        expect(event.timeoutMs).toBe(10000)
        expect(event.actualDurationMs).toBe(2000)
      })
    })
  })
})
