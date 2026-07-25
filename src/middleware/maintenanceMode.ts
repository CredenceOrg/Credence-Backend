import type { Request, Response, NextFunction } from 'express'

/**
 * The value (in seconds) returned in the `Retry-After` header when the server
 * is in maintenance mode. Callers should wait at least this long before
 * retrying their request.
 */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 60

/**
 * HTTP methods that are considered write operations.  All other methods
 * (GET, HEAD, OPTIONS) are read-only and pass through even during maintenance.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Factory that returns an Express middleware which blocks all write requests
 * (POST, PUT, PATCH, DELETE) with `503 Service Unavailable` and a
 * `Retry-After: 60` header when maintenance mode is enabled.
 *
 * Read-only requests (GET, HEAD, OPTIONS) are passed through unchanged so
 * that health checks and monitoring continue to work during a maintenance
 * window.
 *
 * @param isEnabled - A boolean flag **or** a zero-argument function that
 *   returns the current flag value.  Passing a function lets callers bind to
 *   a live config reference so the flag can be toggled without restarting the
 *   process.
 *
 * @example
 * // Static flag (resolved once at startup)
 * app.use(createMaintenanceModeMiddleware(config.maintenanceMode))
 *
 * @example
 * // Live flag via getter
 * app.use(createMaintenanceModeMiddleware(() => config.maintenanceMode))
 */
export function createMaintenanceModeMiddleware(
  isEnabled: boolean | (() => boolean),
): (req: Request, res: Response, next: NextFunction) => void {
  return function maintenanceModeMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const enabled = typeof isEnabled === 'function' ? isEnabled() : isEnabled

    if (enabled && WRITE_METHODS.has(req.method.toUpperCase())) {
      res.setHeader('Retry-After', String(MAINTENANCE_RETRY_AFTER_SECONDS))
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'The service is currently undergoing maintenance. Please retry later.',
        retryAfter: MAINTENANCE_RETRY_AFTER_SECONDS,
      })
      return
    }

    next()
  }
}
