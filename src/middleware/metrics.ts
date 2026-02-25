import { Request, Response, NextFunction } from 'express'
import { getMetricsService } from '../services/metrics/index.js'

/**
 * Middleware to track HTTP request metrics
 * 
 * Records:
 * - Request duration (histogram)
 * - Request count by method, route, and status code (counter)
 * 
 * @example
 * ```typescript
 * app.use(metricsMiddleware)
 * ```
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now()

  // Capture the original end function
  const originalEnd = res.end

  // Override res.end to capture metrics when response is sent
  res.end = function (this: Response, ...args: any[]): Response {
    const durationMs = Date.now() - startTime
    const metricsService = getMetricsService()

    // Normalize route path (replace params with placeholders)
    const route = normalizeRoute(req.route?.path || req.path)

    metricsService.recordHttpRequest({
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs,
    })

    // Call the original end function
    return originalEnd.apply(this, args)
  }

  next()
}

/**
 * Normalize route path by replacing dynamic segments with placeholders
 * 
 * @param path - Original route path
 * @returns Normalized path
 * 
 * @example
 * normalizeRoute('/api/trust/GABC123') -> '/api/trust/:address'
 * normalizeRoute('/api/bulk/verify') -> '/api/bulk/verify'
 */
function normalizeRoute(path: string): string {
  // If path already has route params (from Express route), return as-is
  if (path.includes(':')) {
    return path
  }

  // Common patterns to normalize
  const patterns = [
    { regex: /^\/api\/trust\/[A-Z0-9]+$/, replacement: '/api/trust/:address' },
    { regex: /^\/api\/bond\/[A-Z0-9]+$/, replacement: '/api/bond/:address' },
    { regex: /^\/api\/slash\/[0-9]+$/, replacement: '/api/slash/:id' },
    { regex: /^\/api\/slash\/[0-9]+\/review$/, replacement: '/api/slash/:id/review' },
    { regex: /^\/api\/slash\/[0-9]+\/execute$/, replacement: '/api/slash/:id/execute' },
  ]

  for (const { regex, replacement } of patterns) {
    if (regex.test(path)) {
      return replacement
    }
  }

  return path
}
