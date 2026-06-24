import { describe, it, expect, vi } from 'vitest'

// Mock prom-client BEFORE importing modules that use it
vi.mock('prom-client', () => {
  class MockMetric {
    constructor(public config: any) {}
    observe() {}
    inc() {}
    dec() {}
    set() {}
    reset() {}
    get() { return { values: [] } }
  }

  const mock = {
    Summary: MockMetric,
    Histogram: MockMetric,
    Counter: MockMetric,
    Gauge: MockMetric,
    Registry: class MockRegistry {
      registerMetric(metric: any) {}
    },
    register: {
      registerMetric(metric: any) {}
    }
  }

  return {
    ...mock,
    default: mock
  }
})

import * as observability from '../observability/index'

describe('observability module exports', () => {
  it('exports latency metrics utilities', () => {
    expect(observability.normalizeRoute).toBeDefined()
    expect(observability.httpRequestDurationHistogram).toBeDefined()
    expect(observability.registerLatencyMetrics).toBeDefined()
  })

  it('exports timeout metrics utilities', () => {
    expect(observability.ConsoleTimeoutMetrics).toBeDefined()
    expect(observability.ProductionTimeoutMetrics).toBeDefined()
    expect(observability.createDefaultMetricsCollector).toBeDefined()
    expect(observability.createTimeoutEvent).toBeDefined()
    expect(observability.createSlowOperationEvent).toBeDefined()
    expect(observability.createSuccessEvent).toBeDefined()
  })

  it('normalizeRoute function works', () => {
    const result = observability.normalizeRoute('/api/trust/0x123', '/api/trust/:address')
    expect(result).toBe('/api/trust/:address')
  })

  it('creates timeout metrics collector', () => {
    const collector = observability.createDefaultMetricsCollector()
    expect(collector).toBeDefined()
    expect(collector.onTimeout).toBeDefined()
    expect(collector.onSlowOperation).toBeDefined()
    expect(collector.onSuccess).toBeDefined()
  })
})
