import type { Request, Response, NextFunction } from 'express'
import { resolveSafeRedirectTarget } from '../lib/safeRedirect.js'

export interface SafeRedirectMiddlewareOptions {
  /** Extra hosts (hostname[:port]) that absolute redirect targets may point to. */
  allowedHosts?: readonly string[]
}

/**
 * Wraps `res.redirect` for the lifetime of a request so that every 302 (or
 * any other redirect status) issued while handling it is validated against
 * the open-redirect allowlist before Express writes the Location header.
 *
 * Mount this ahead of a router rather than calling the validator inside each
 * handler — that way the guarantee ("every redirect in this router is safe")
 * holds even for handlers added later that forget to validate their own
 * target, e.g.:
 *
 *   app.use('/api/admin', createSafeRedirectMiddleware({ allowedHosts }))
 *   app.use('/api/admin', createAdminRouter())
 */
export function createSafeRedirectMiddleware(options: SafeRedirectMiddlewareOptions = {}) {
  const allowedHosts = options.allowedHosts ?? []

  return function safeRedirectMiddleware(req: Request, res: Response, next: NextFunction): void {
    const originalRedirect = res.redirect.bind(res) as (...args: unknown[]) => void

    res.redirect = function (this: Response, ...args: unknown[]) {
      const url = typeof args[0] === 'number' ? args[1] : args[0]

      // Express's own "go back to the referring page" keyword — not an
      // attacker-suppliable redirect target, so it bypasses validation.
      if (url === 'back') {
        return originalRedirect(...args)
      }

      try {
        resolveSafeRedirectTarget(url, allowedHosts)
      } catch (err) {
        next(err)
        return
      }

      return originalRedirect(...args)
    } as Response['redirect']

    next()
  }
}
