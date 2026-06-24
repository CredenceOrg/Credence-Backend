import { Router, type Request, type Response } from 'express'
import { Counter } from 'prom-client'
import type { AnalyticsService } from '../services/analytics/service.js'
import { ServiceUnavailableError } from '../lib/errors.js'
import { cache } from '../cache/redis.js'
import { register } from '../middleware/metrics.js'
import { getAnalyticsCacheGeneration } from '../services/analytics/cacheGeneration.js'

const CACHE_NS = 'analytics'
const CACHE_TTL = 300 // seconds — matches the default staleness threshold

export const analyticsCacheHits = new Counter({
  name: 'analytics_cache_hits_total',
  help: 'Total analytics summary cache hits',
  registers: [register],
})

export const analyticsCacheMisses = new Counter({
  name: 'analytics_cache_misses_total',
  help: 'Total analytics summary cache misses',
  registers: [register],
})

export function normalizeQueryParams(query: Record<string, any>): string {
  if (!query || typeof query !== 'object') {
    return ''
  }
  const keys = Object.keys(query).sort()
  const parts: string[] = []
  for (const key of keys) {
    const val = query[key]
    if (val === undefined) {
      continue
    }
    if (Array.isArray(val)) {
      const sortedVals = [...val].map(String).sort()
      for (const v of sortedVals) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`)
      }
    } else if (typeof val === 'object' && val !== null) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(val))}`)
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`)
    }
  }
  return parts.join('&')
}

function summaryKey(tenantId: string, query: Record<string, any>): string {
  const normalized = normalizeQueryParams(query)
  const queryPart = normalized ? `:${normalized}` : ''
  return `${tenantId}:gen${getAnalyticsCacheGeneration()}${queryPart}`
}

const pendingRequests = new Map<string, Promise<any>>()

export function createAnalyticsRouter(analyticsService?: AnalyticsService): Router {
  const router = Router()

  router.get('/summary', async (req: Request, res: Response, next) => {
    if (!analyticsService) {
      return next(new ServiceUnavailableError('Analytics service is not configured.'))
    }

    const tenantId = (req.headers['x-tenant-id'] as string) || 'default'
    const cacheKey = summaryKey(tenantId, req.query)

    try {
      const cached = await cache.get(CACHE_NS, cacheKey)
      if (cached) {
        analyticsCacheHits.inc()
        return res.status(200).json(cached)
      }

      // Concurrency / cache stampede protection via request coalescing
      let promise = pendingRequests.get(cacheKey)
      let isCreator = false

      if (!promise) {
        isCreator = true
        promise = analyticsService.getSummary()
        pendingRequests.set(cacheKey, promise)
      }

      analyticsCacheMisses.inc()

      const data = await promise

      if (isCreator) {
        await cache.set(CACHE_NS, cacheKey, data, CACHE_TTL)
        pendingRequests.delete(cacheKey)
      }

      res.status(200).json(data)
    } catch (error) {
      pendingRequests.delete(cacheKey)
      next(new ServiceUnavailableError(error instanceof Error ? error.message : 'Unknown analytics error'))
    }
  })

  return router
}

