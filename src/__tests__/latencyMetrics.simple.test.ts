import { describe, it, expect, beforeEach } from 'vitest'
import { 
  normalizeRoute, 
  httpRequestDurationHistogram, 
  httpRequestStatusTotal 
} from '../observability/latencyMetrics.js'

describe('latencyMetrics - route normalization', () => {
  beforeEach(() => {
    httpRequestDurationHistogram.reset()
    httpRequestStatusTotal.reset()
  })

  describe('normalizeRoute', () => {
    it('uses Express route path when available', () => {
      const result = normalizeRoute('/api/trust/0x123abc', '/api/trust/:address')
      expect(result).toBe('/api/trust/:address')
    })

    it('normalizes hex addresses in path', () => {
      const result = normalizeRoute('/api/trust/0x123abc')
      expect(result).toBe('/api/trust/:address')
    })

    it('normalizes Stellar G-addresses in path', () => {
      const result = normalizeRoute('/api/bond/GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ')
      expect(result).toBe('/api/bond/:address')
    })

    it('normalizes UUIDs in path', () => {
      const result = normalizeRoute('/api/jobs/550e8400-e29b-41d4-a716-446655440000')
      expect(result).toBe('/api/jobs/:id')
    })

    it('normalizes numeric IDs in path', () => {
      const result = normalizeRoute('/api/users/12345')
      expect(result).toBe('/api/users/:id')
    })

    it('handles multiple dynamic segments', () => {
      const result = normalizeRoute('/api/attestations/0xabc/verify/123')
      expect(result).toBe('/api/attestations/:address/verify/:id')
    })

    it('preserves static routes', () => {
      const result = normalizeRoute('/api/health')
      expect(result).toBe('/api/health')
    })

    it('handles mixed case hex addresses', () => {
      const result = normalizeRoute('/api/bond/0xAbC123')
      expect(result).toBe('/api/bond/:address')
    })
  })

  describe('cardinality bounds', () => {
    it('limits unique route templates', () => {
      const routes = [
        '/api/trust/0x111',
        '/api/trust/0x222',
        '/api/trust/0x333',
        '/api/bond/0xaaa',
        '/api/bond/0xbbb',
      ]

      const normalized = routes.map(r => normalizeRoute(r))
      const unique = new Set(normalized)
      
      expect(unique.size).toBe(2) // Only /api/trust/:address and /api/bond/:address
    })

    it('prevents explosion from dynamic segments', () => {
      const dynamicRoutes = Array.from({ length: 1000 }, (_, i) => 
        `/api/trust/0x${i.toString(16).padStart(6, '0')}`
      )

      const normalized = dynamicRoutes.map(r => normalizeRoute(r))
      const unique = new Set(normalized)
      
      expect(unique.size).toBe(1) // All normalize to /api/trust/:address
    })
  })

  describe('SLA Metrics - Histograms and Counters', () => {
    it('records latency in the correct buckets', async () => {
      httpRequestDurationHistogram.observe({
        method: 'GET',
        route: '/api/trust/:address',
        status_class: '2xx'
      }, 0.200)

      const result = await httpRequestDurationHistogram.get()
      const bucket025 = result.values.find(v => v.labels.le === 0.25 && v.labels.route === '/api/trust/:address')
      const bucket015 = result.values.find(v => v.labels.le === 0.15 && v.labels.route === '/api/trust/:address')

      expect(bucket025?.value).toBe(1)
      expect(bucket015?.value).toBe(0)
    })

    it('tracks status class counts', async () => {
      httpRequestStatusTotal.inc({ method: 'GET', route: '/api/test', status_class: '2xx' })
      httpRequestStatusTotal.inc({ method: 'GET', route: '/api/test', status_class: '4xx' })
      
      const result = await httpRequestStatusTotal.get()
      const count2xx = result.values.find(v => v.labels.status_class === '2xx' && v.labels.route === '/api/test')
      const count4xx = result.values.find(v => v.labels.status_class === '4xx' && v.labels.route === '/api/test')

      expect(count2xx?.value).toBe(1)
      expect(count4xx?.value).toBe(1)
    })
  })
})
