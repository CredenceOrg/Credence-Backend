/**
 * Tests for timeout configuration and enforcement.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_TIMEOUT_BUDGETS,
  TIMEOUT_HARD_CAPS,
  createTimeoutConfig,
  resolveTimeout,
  isValidTimeoutReasonCode,
  type ServiceType,
  type TimeoutReasonCode,
} from '../timeouts.js'

describe('Timeout Configuration', () => {
  describe('DEFAULT_TIMEOUT_BUDGETS', () => {
    it('should have sensible defaults for all service types', () => {
      const serviceTypes: ServiceType[] = ['database', 'cache', 'queue', 'http', 'soroban', 'webhook']
      
      serviceTypes.forEach(serviceType => {
        const budget = DEFAULT_TIMEOUT_BUDGETS[serviceType]
        
        expect(budget).toBeDefined()
        expect(budget.defaultMs).toBeGreaterThan(0)
        expect(budget.minMs).toBeGreaterThan(0)
        expect(budget.maxMs).toBeGreaterThan(budget.minMs)
        expect(budget.targetMs).toBeGreaterThan(0)
        expect(budget.targetMs).toBeLessThanOrEqual(budget.maxMs)
      })
    })

    it('should have cache timeouts faster than database', () => {
      expect(DEFAULT_TIMEOUT_BUDGETS.cache.defaultMs).toBeLessThan(DEFAULT_TIMEOUT_BUDGETS.database.defaultMs)
      expect(DEFAULT_TIMEOUT_BUDGETS.cache.targetMs).toBeLessThan(DEFAULT_TIMEOUT_BUDGETS.database.targetMs)
    })

    it('should have webhook timeouts more generous than cache', () => {
      expect(DEFAULT_TIMEOUT_BUDGETS.webhook.defaultMs).toBeGreaterThan(DEFAULT_TIMEOUT_BUDGETS.cache.defaultMs)
      expect(DEFAULT_TIMEOUT_BUDGETS.webhook.maxMs).toBeGreaterThan(DEFAULT_TIMEOUT_BUDGETS.cache.maxMs)
    })
  })

  describe('TIMEOUT_HARD_CAPS', () => {
    it('should have caps for all service types', () => {
      const serviceTypes: ServiceType[] = ['database', 'cache', 'queue', 'http', 'soroban', 'webhook']
      
      serviceTypes.forEach(serviceType => {
        expect(TIMEOUT_HARD_CAPS[serviceType]).toBeDefined()
        expect(TIMEOUT_HARD_CAPS[serviceType].maxMs).toBeGreaterThan(0)
      })
    })

    it('should have hard caps higher than budget maxes', () => {
      const serviceTypes: ServiceType[] = ['database', 'cache', 'queue', 'http', 'soroban', 'webhook']
      
      serviceTypes.forEach(serviceType => {
        const hardCap = TIMEOUT_HARD_CAPS[serviceType].maxMs
        const budgetMax = DEFAULT_TIMEOUT_BUDGETS[serviceType].maxMs
        
        expect(hardCap).toBeGreaterThanOrEqual(budgetMax)
      })
    })
  })

  describe('createTimeoutConfig', () => {
    it('should create config without override', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT')
      
      expect(config.budget).toBe(DEFAULT_TIMEOUT_BUDGETS.cache)
      expect(config.reasonCode).toBe('CACHE_GET_TIMEOUT')
      expect(config.overrideMs).toBeUndefined()
    })

    it('should create config with override', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT', 1000)
      
      expect(config.budget).toBe(DEFAULT_TIMEOUT_BUDGETS.cache)
      expect(config.reasonCode).toBe('CACHE_GET_TIMEOUT')
      expect(config.overrideMs).toBe(1000)
    })
  })

  describe('resolveTimeout', () => {
    it('should use default when no override provided', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT')
      const resolved = resolveTimeout('cache', config)
      
      expect(resolved).toBe(DEFAULT_TIMEOUT_BUDGETS.cache.defaultMs)
    })

    it('should use override when provided', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT', 1500)
      const resolved = resolveTimeout('cache', config)
      
      expect(resolved).toBe(1500)
    })

    it('should clamp override to budget min', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT', 10) // Below min
      const resolved = resolveTimeout('cache', config)
      
      expect(resolved).toBe(DEFAULT_TIMEOUT_BUDGETS.cache.minMs)
    })

    it('should clamp override to budget max', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT', 10000) // Above max
      const resolved = resolveTimeout('cache', config)
      
      expect(resolved).toBe(DEFAULT_TIMEOUT_BUDGETS.cache.maxMs)
    })

    it('should clamp to hard cap when budget max exceeds hard cap', () => {
      // This test assumes we might have a budget max that exceeds hard cap
      const serviceType: ServiceType = 'http'
      const hardCap = TIMEOUT_HARD_CAPS[serviceType].maxMs
      
      // Create a config with override exceeding hard cap
      const config = createTimeoutConfig(serviceType, 'HTTP_REQUEST_TIMEOUT', hardCap + 10000)
      const resolved = resolveTimeout(serviceType, config)
      
      expect(resolved).toBeLessThanOrEqual(hardCap)
    })

    it('should handle edge case values', () => {
      const config = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT', NaN)
      const resolved = resolveTimeout('cache', config)
      
      // NaN should be treated as invalid and fall back to default
      expect(resolved).toBe(DEFAULT_TIMEOUT_BUDGETS.cache.defaultMs)
    })
  })

  describe('isValidTimeoutReasonCode', () => {
    it('should validate correct reason codes', () => {
      const validCodes: TimeoutReasonCode[] = [
        'DB_QUERY_TIMEOUT',
        'DB_TRANSACTION_TIMEOUT',
        'CACHE_GET_TIMEOUT',
        'CACHE_SET_TIMEOUT',
        'QUEUE_PUBLISH_TIMEOUT',
        'QUEUE_PROCESS_TIMEOUT',
        'HTTP_REQUEST_TIMEOUT',
        'SOROBAN_RPC_TIMEOUT',
        'WEBHOOK_DELIVERY_TIMEOUT',
        'CUSTOM_TIMEOUT',
      ]

      validCodes.forEach(code => {
        expect(isValidTimeoutReasonCode(code)).toBe(true)
      })
    })

    it('should reject invalid reason codes', () => {
      const invalidCodes = ['INVALID_CODE', '', 'TIMEOUT', 'DB_TIMEOUT', null, undefined]

      invalidCodes.forEach(code => {
        expect(isValidTimeoutReasonCode(code as string)).toBe(false)
      })
    })
  })
})

describe('Timeout Precedence', () => {
  it('should follow precedence: override > budget default > hard caps', () => {
    const serviceType: ServiceType = 'database'
    const budget = DEFAULT_TIMEOUT_BUDGETS[serviceType]
    
    // Test 1: No override - should use budget default
    const config1 = createTimeoutConfig(serviceType, 'DB_QUERY_TIMEOUT')
    expect(resolveTimeout(serviceType, config1)).toBe(budget.defaultMs)
    
    // Test 2: Valid override - should use override
    const overrideMs = 1500
    const config2 = createTimeoutConfig(serviceType, 'DB_QUERY_TIMEOUT', overrideMs)
    expect(resolveTimeout(serviceType, config2)).toBe(overrideMs)
    
    // Test 3: Override below min - should clamp to min
    const config3 = createTimeoutConfig(serviceType, 'DB_QUERY_TIMEOUT', budget.minMs - 10)
    expect(resolveTimeout(serviceType, config3)).toBe(budget.minMs)
    
    // Test 4: Override above max - should clamp to max (or hard cap if lower)
    const config4 = createTimeoutConfig(serviceType, 'DB_QUERY_TIMEOUT', budget.maxMs + 1000)
    const resolved4 = resolveTimeout(serviceType, config4)
    expect(resolved4).toBeLessThanOrEqual(budget.maxMs)
    expect(resolved4).toBeLessThanOrEqual(TIMEOUT_HARD_CAPS[serviceType].maxMs)
  })

  it('should handle critical flows with custom timeouts', () => {
    // Simulate a critical flow that needs a longer timeout
    const criticalFlowTimeout = 8000
    const config = createTimeoutConfig('soroban', 'SOROBAN_RPC_TIMEOUT', criticalFlowTimeout)
    
    const resolved = resolveTimeout('soroban', config)
    
    // Should use the critical flow timeout if within bounds
    expect(resolved).toBeGreaterThanOrEqual(DEFAULT_TIMEOUT_BUDGETS.soroban.defaultMs)
    expect(resolved).toBeLessThanOrEqual(TIMEOUT_HARD_CAPS.soroban.maxMs)
  })
})

describe('Service-Specific Behavior', () => {
  it('should enforce database transaction timeouts separately', () => {
    const queryConfig = createTimeoutConfig('database', 'DB_QUERY_TIMEOUT')
    const transactionConfig = createTimeoutConfig('database', 'DB_TRANSACTION_TIMEOUT')
    
    const queryTimeout = resolveTimeout('database', queryConfig)
    const transactionTimeout = resolveTimeout('database', transactionConfig)
    
    // Both should use the same budget since they're the same service type
    expect(queryTimeout).toBe(transactionTimeout)
  })

  it('should handle cache get vs set operations', () => {
    const getConfig = createTimeoutConfig('cache', 'CACHE_GET_TIMEOUT')
    const setConfig = createTimeoutConfig('cache', 'CACHE_SET_TIMEOUT')
    
    const getTimeout = resolveTimeout('cache', getConfig)
    const setTimeout = resolveTimeout('cache', setConfig)
    
    // Both should use the same budget since they're the same service type
    expect(getTimeout).toBe(setTimeout)
    // But they have different reason codes for observability
    expect(getConfig.reasonCode).toBe('CACHE_GET_TIMEOUT')
    expect(setConfig.reasonCode).toBe('CACHE_SET_TIMEOUT')
  })

  it('should provide appropriate timeouts for external services', () => {
    const sorobanConfig = createTimeoutConfig('soroban', 'SOROBAN_RPC_TIMEOUT')
    const webhookConfig = createTimeoutConfig('webhook', 'WEBHOOK_DELIVERY_TIMEOUT')
    
    const sorobanTimeout = resolveTimeout('soroban', sorobanConfig)
    const webhookTimeout = resolveTimeout('webhook', webhookConfig)
    
    // Webhook should generally have more generous timeout than blockchain RPC
    expect(webhookTimeout).toBeGreaterThanOrEqual(sorobanTimeout)
  })
})
