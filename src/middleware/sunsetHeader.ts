import { Request, Response, NextFunction } from 'express'
import { HEADER_SUNSET, DEFAULT_SUNSET_DATE } from '../config/constants.js'

/**
 * Map of deprecated route paths (relative to mount point) to their
 * RFC-8594 Sunset header value. The date indicates when the endpoint
 * will be removed.
 *
 * Entries in this map are the sole source of truth for which endpoints
 * are deprecated and what their sunset date is.
 */
export const DEPRECATED_ENDPOINTS: Record<string, string> = {
  /**
   * POST /api/admin/refresh-secrets
   * @deprecated Use /api/admin/reload-config instead.
   */
  '/api/admin/refresh-secrets': DEFAULT_SUNSET_DATE,


}

/**
 * Middleware that adds a `Sunset` header (RFC-8594) to responses from
 * deprecated endpoints. The header value is an HTTP-date indicating when
 * the endpoint will be removed.
 *
 * This middleware should be applied early in the middleware chain so the
 * header is set before any response is sent.
 */
export function sunsetHeaderMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const sunsetDate = DEPRECATED_ENDPOINTS[req.path]

  if (sunsetDate) {
    res.setHeader(HEADER_SUNSET, sunsetDate)
  }

  next()
}
