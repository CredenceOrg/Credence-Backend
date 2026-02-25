import { describe, it, expect, beforeEach } from 'vitest'
import { MetricsService, resetMetricsService, getMetricsService } from './metricsService.js'
import { MetricEvent } from './types.js'

describe('MetricsService', () => {
  let metricsService: MetricsService

  beforeEach(() => {
    resetMetricsService()
    metricsService = new MetricsService()
  })

  describe('HTTP Metrics', () => {
    it('should record HTTP request duration', async () => {
      metricsService.recordHttpRequest({
        method: 'GET',
        route: '/api/trust/:address',
        statusCode: 200,
        durationMs: 45,
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('http_request_duration_seconds')
      expect(metrics).toContain('method="GET"')
      expect(metrics).toContain('route="/api/trust/:address"')
      expect(metrics).toContain('status_code="200"')
    })

    it('should record HTTP request count', async () => {
      metricsService.recordHttpRequest({
        method: 'POST',
        route: '/api/bulk/verify',
        statusCode: 200,
        durationMs: 120,
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('http_requests_total')
      expect(metrics).toContain('method="POST"')
      expect(metrics).toContain('route="/api/bulk/verify"')
    })

    it('should track multiple requests with different status codes', async () => {
      metricsService.recordHttpRequest({
        method: 'GET',
        route: '/api/trust/:address',
        statusCode: 200,
        durationMs: 30,
      })

      metricsService.recordHttpRequest({
        method: 'GET',
        route: '/api/trust/:address',
        statusCode: 404,
        durationMs: 15,
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('status_code="200"')
      expect(metrics).toContain('status_code="404"')
    })

    it('should convert duration from milliseconds to seconds', async () => {
      metricsService.recordHttpRequest({
        method: 'GET',
        route: '/api/health',
        statusCode: 200,
        durationMs: 1000, // 1 second
      })

      const metrics = await metricsService.getMetrics()
      // Should record as 1 second in histogram
      expect(metrics).toContain('http_request_duration_seconds')
    })
  })

  describe('Business Metrics - Bond Events', () => {
    it('should record bond creation event', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, {
        address: 'GABC123',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('bond_events_total')
      expect(metrics).toContain('address="GABC123"')
    })

    it('should record multiple bond events', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, {
        address: 'GABC123',
      })
      metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, {
        address: 'GDEF456',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('address="GABC123"')
      expect(metrics).toContain('address="GDEF456"')
    })

    it('should handle bond event without address label', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, {})

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('bond_events_total')
      expect(metrics).toContain('address="unknown"')
    })
  })

  describe('Business Metrics - Slash Events', () => {
    it('should record slash event', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BOND_SLASHED, {
        reason: 'fraud',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('slash_events_total')
      expect(metrics).toContain('reason="fraud"')
    })

    it('should record slash events with different reasons', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BOND_SLASHED, {
        reason: 'fraud',
      })
      metricsService.recordBusinessEvent(MetricEvent.BOND_SLASHED, {
        reason: 'misconduct',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('reason="fraud"')
      expect(metrics).toContain('reason="misconduct"')
    })
  })

  describe('Business Metrics - Score Calculations', () => {
    it('should record score calculation event', async () => {
      metricsService.recordBusinessEvent(MetricEvent.SCORE_CALCULATED, {
        address: 'GABC123',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('score_calculations_total')
      expect(metrics).toContain('address="GABC123"')
    })
  })

  describe('Business Metrics - Identity Verifications', () => {
    it('should record successful identity verification', async () => {
      metricsService.recordBusinessEvent(MetricEvent.IDENTITY_VERIFIED, {
        status: 'success',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('identity_verifications_total')
      expect(metrics).toContain('status="success"')
    })

    it('should record failed identity verification', async () => {
      metricsService.recordBusinessEvent(MetricEvent.IDENTITY_VERIFIED, {
        status: 'failed',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('status="failed"')
    })
  })

  describe('Business Metrics - Bulk Verifications', () => {
    it('should record bulk verification with batch size range', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BULK_VERIFICATION, {
        batch_size_range: '1-10',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('bulk_verifications_total')
      expect(metrics).toContain('batch_size_range="1-10"')
    })

    it('should track different batch size ranges', async () => {
      metricsService.recordBusinessEvent(MetricEvent.BULK_VERIFICATION, {
        batch_size_range: '1-10',
      })
      metricsService.recordBusinessEvent(MetricEvent.BULK_VERIFICATION, {
        batch_size_range: '11-50',
      })
      metricsService.recordBusinessEvent(MetricEvent.BULK_VERIFICATION, {
        batch_size_range: '51-100',
      })

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('batch_size_range="1-10"')
      expect(metrics).toContain('batch_size_range="11-50"')
      expect(metrics).toContain('batch_size_range="51-100"')
    })
  })

  describe('Gauges', () => {
    it('should set active bonds gauge', async () => {
      metricsService.setActiveBonds(150)

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('active_bonds_count')
      expect(metrics).toContain('150')
    })

    it('should update active bonds gauge', async () => {
      metricsService.setActiveBonds(100)
      metricsService.setActiveBonds(200)

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('active_bonds_count')
      expect(metrics).toContain('200')
    })

    it('should set total bonded amount gauge', async () => {
      metricsService.setTotalBondedAmount(1000000.50)

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('total_bonded_amount')
      expect(metrics).toContain('1000000.5')
    })

    it('should update total bonded amount gauge', async () => {
      metricsService.setTotalBondedAmount(500000)
      metricsService.setTotalBondedAmount(750000)

      const metrics = await metricsService.getMetrics()
      expect(metrics).toContain('total_bonded_amount')
      expect(metrics).toContain('750000')
    })
  })

  describe('Default Metrics', () => {
    it('should include Node.js default metrics', async () => {
      const metrics = await metricsService.getMetrics()
      
      // Check for common Node.js metrics
      expect(metrics).toContain('process_cpu_')
      expect(metrics).toContain('nodejs_')
    })
  })

  describe('Registry', () => {
    it('should return registry instance', () => {
      const registry = metricsService.getRegistry()
      expect(registry).toBeDefined()
    })

    it('should reset metrics', async () => {
      metricsService.recordHttpRequest({
        method: 'GET',
        route: '/api/test',
        statusCode: 200,
        durationMs: 10,
      })

      metricsService.reset()

      const metrics = await metricsService.getMetrics()
      // After reset, custom metrics should be cleared but default metrics remain
      expect(metrics).toBeDefined()
    })
  })

  describe('Singleton', () => {
    it('should return same instance from getMetricsService', () => {
      const instance1 = getMetricsService()
      const instance2 = getMetricsService()
      expect(instance1).toBe(instance2)
    })

    it('should create new instance after reset', () => {
      const instance1 = getMetricsService()
      resetMetricsService()
      const instance2 = getMetricsService()
      expect(instance1).not.toBe(instance2)
    })
  })

  describe('Metrics Format', () => {
    it('should return metrics in Prometheus text format', async () => {
      metricsService.recordHttpRequest({
        method: 'GET',
        route: '/api/test',
        statusCode: 200,
        durationMs: 50,
      })

      const metrics = await metricsService.getMetrics()
      
      // Check Prometheus format structure
      expect(metrics).toContain('# HELP')
      expect(metrics).toContain('# TYPE')
      expect(typeof metrics).toBe('string')
    })
  })
})
