import type { Request, Response, NextFunction } from 'express'

/**
 * Path prefixes treated as privileged even when the route's auth middleware
 * hasn't attached an identity to the request. Acts as a defense-in-depth
 * backstop alongside the identity check in `isPrivilegedRequest` below, so a
 * future route added under one of these groups is covered by default even if
 * it forgets to wire up authentication.
 */
const PRIVILEGED_PATH_PREFIXES = [
  '/api/admin',
  '/api/payouts',
  '/api/bulk',
  '/api/imports',
  '/api/orgs',
]

function matchesPrivilegedPrefix(path: string): boolean {
  return PRIVILEGED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  )
}

/**
 * A request is privileged when it carries authenticated identity (a user
 * session via `requireUserAuth`, or an enforced API key via `requireApiKey`)
 * or targets a known privileged route group.
 */
function isPrivilegedRequest(req: Request): boolean {
  if ((req as any).user) return true
  if ((req as any).apiKey) return true
  if ((req as any).apiKeyRecord) return true
  return matchesPrivilegedPrefix(req.path)
}

/**
 * Centralised, per-response Cache-Control decision.
 *
 * Threat model: without an explicit `Cache-Control: no-store`, a 200 response
 * from an authenticated endpoint (admin user/audit-log listings, payout and
 * settlement data, impersonation tokens, replay diffs) is heuristically
 * cacheable by shared HTTP proxies and by the browser's disk / back-forward
 * cache. On a shared or public machine, or behind a misconfigured
 * intermediary cache, a later party could replay a previously authenticated
 * response after the session that produced it has ended, recovering
 * privileged data without ever presenting valid credentials. Defaulting
 * privileged responses to `no-store` closes that gap without requiring every
 * route author to remember to set the header themselves.
 *
 * Routes that intentionally serve cacheable, non-sensitive data (the public
 * trust-score endpoint, the JWKS document) set their own `Cache-Control`
 * header before the response is flushed; this middleware only fills in a
 * default when the route hasn't made an explicit choice, so it never
 * clobbers an intentional override.
 */
export function cacheControlMiddleware(req: Request, res: Response, next: NextFunction): void {
  const originalEnd = res.end.bind(res)

  ;(res as any).end = function patchedEnd(...args: unknown[]) {
    if (!res.headersSent && !res.getHeader('Cache-Control') && isPrivilegedRequest(req)) {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Pragma', 'no-cache')
    }
    return (originalEnd as (...a: unknown[]) => Response)(...args)
  }

  next()
}
