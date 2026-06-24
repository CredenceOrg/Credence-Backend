import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  incrementOutboxDeadLetter,
  incrementOutboxPublished,
  incrementOutboxFailed,
  setOutboxPendingGauge,
  incrementOutboxLeaseRenew,
  incrementOutboxQuarantine,
  _resetOutboxMetricsCacheForTests,
} from './outboxMetrics.js'
import promClient from 'prom-client'

describe('Outbox Metrics (#329)', () => {
  beforeEach(() => {
    promClient.register.clear()
    _resetOutboxMetricsCacheForTests()
  })

  afterEach(() => {
    promClient.register.clear()
    _resetOutboxMetricsCacheForTests()
  })

  it('registers metrics exactly once (no double-register)', async () => {
    // Call multiple times
    incrementOutboxPublished('test_aggregate')
    incrementOutboxPublished('test_aggregate')
    
    // Check registry
    const metrics = await promClient.register.getMetricsAsJSON()
    const publishedMetric = metrics.find(m => m.name === 'outbox_published_total')
    expect(publishedMetric).toBeDefined()
    expect(publishedMetric?.values.length).toBe(1)
    expect(publishedMetric?.values[0].value).toBe(2)
  })

  it('updates outbox_published_total correctly', async () => {
    incrementOutboxPublished('user')
    const metrics = await promClient.register.getMetricsAsJSON()
    const metric = metrics.find(m => m.name === 'outbox_published_total')
    expect(metric?.values[0].value).toBe(1)
    expect(metric?.values[0].labels).toEqual({ aggregate_type: 'user' })
  })

  it('updates outbox_failed_total correctly', async () => {
    incrementOutboxFailed('user')
    const metrics = await promClient.register.getMetricsAsJSON()
    const metric = metrics.find(m => m.name === 'outbox_failed_total')
    expect(metric?.values[0].value).toBe(1)
    expect(metric?.values[0].labels).toEqual({ aggregate_type: 'user' })
  })

  it('updates outbox_pending_gauge correctly', async () => {
    setOutboxPendingGauge(42)
    const metrics = await promClient.register.getMetricsAsJSON()
    const metric = metrics.find(m => m.name === 'outbox_pending_gauge')
    expect(metric?.values[0].value).toBe(42)
    
    setOutboxPendingGauge(10)
    const metrics2 = await promClient.register.getMetricsAsJSON()
    const metric2 = metrics2.find(m => m.name === 'outbox_pending_gauge')
    expect(metric2?.values[0].value).toBe(10)
  })

  it('updates outbox_lease_renew_total correctly', async () => {
    incrementOutboxLeaseRenew(5)
    const metrics = await promClient.register.getMetricsAsJSON()
    const metric = metrics.find(m => m.name === 'outbox_lease_renew_total')
    expect(metric?.values[0].value).toBe(5)
  })

  it('updates outbox_quarantine_total correctly', async () => {
    incrementOutboxQuarantine('schema_invalid')
    const metrics = await promClient.register.getMetricsAsJSON()
    const metric = metrics.find(m => m.name === 'outbox_quarantine_total')
    expect(metric?.values[0].value).toBe(1)
    expect(metric?.values[0].labels).toEqual({ reason: 'schema_invalid' })
  })
})
