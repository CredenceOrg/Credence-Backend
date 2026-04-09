import { Router, type Request, type Response } from 'express'
import type { AnalyticsService } from '../services/analytics/service.js'
import { ServiceUnavailableError } from '../lib/errors.js'

export function createAnalyticsRouter(analyticsService?: AnalyticsService): Router {
  const router = Router()

  router.get('/summary', async (_req: Request, res: Response, next) => {
    if (!analyticsService) {
      return next(new ServiceUnavailableError('Analytics service is not configured.'))
    }

    try {
      const data = await analyticsService.getSummary()
      res.status(200).json(data)
    } catch (error) {
      next(new ServiceUnavailableError(error instanceof Error ? error.message : 'Unknown analytics error'))
    }
  })

  return router
}
