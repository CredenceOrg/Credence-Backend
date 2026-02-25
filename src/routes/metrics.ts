import { Router, Request, Response } from 'express'
import { getMetricsService } from '../services/metrics/index.js'

const router = Router()

/**
 * GET /metrics
 * 
 * Prometheus metrics endpoint
 * Returns metrics in Prometheus text format for scraping
 * 
 * Includes:
 * - HTTP request duration histogram (by method, route, status)
 * - HTTP request count (by method, route, status)
 * - Business metrics (bonds, slashes, score calculations)
 * - Default Node.js metrics (memory, CPU, event loop)
 * 
 * @returns Prometheus-formatted metrics
 * 
 * @example
 * ```bash
 * curl http://localhost:3000/metrics
 * ```
 * 
 * @example Response (200 OK)
 * ```
 * # HELP http_request_duration_seconds Duration of HTTP requests in seconds
 * # TYPE http_request_duration_seconds histogram
 * http_request_duration_seconds_bucket{le="0.01",method="GET",route="/api/trust/:address",status_code="200"} 5
 * http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/trust/:address",status_code="200"} 10
 * ...
 * 
 * # HELP http_requests_total Total number of HTTP requests
 * # TYPE http_requests_total counter
 * http_requests_total{method="GET",route="/api/trust/:address",status_code="200"} 150
 * ...
 * 
 * # HELP bond_events_total Total number of bond creation events
 * # TYPE bond_events_total counter
 * bond_events_total{address="GABC..."} 5
 * ...
 * ```
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const metricsService = getMetricsService()
    const metrics = await metricsService.getMetrics()

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.status(200).send(metrics)
  } catch (error) {
    console.error('Error generating metrics:', error)
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to generate metrics',
    })
  }
})

export default router
