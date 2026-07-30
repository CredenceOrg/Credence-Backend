import { Request, Response, NextFunction } from 'express'
import { HEADER_RESPONSE_TIME_MS } from '../config/constants.js'

/**
 * Middleware that records the server-side processing time for every request
 * and exposes it via the x-response-time-ms response header. This aids
 * downstream debugging by making per-request latency observable without
 * touching the response body.
 *
 * Registered as early as possible in the middleware stack so the timer
 * covers the full request lifecycle including all downstream middleware
 * and route handlers.
 */
export function responseTimeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now()

  const originalEnd = res.end.bind(res)
  res.end = function patchedEnd(...args: unknown[]) {
    if (!res.headersSent) {
      const elapsed = Date.now() - start
      res.setHeader(HEADER_RESPONSE_TIME_MS, String(elapsed))
    }
    return (originalEnd as (...a: unknown[]) => Response)(...args)
  }

  next()
}
