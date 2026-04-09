import type { Request, Response, NextFunction } from 'express'
import { ROLE_HIERARCHY } from '../types/rbac.ts'
import type { Role, AuthenticatedUser } from '../types/rbac.ts'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Structured access-denial logger. Replace with your logger (pino, winston…). */
function logDenial(
     req: Request,
     user: AuthenticatedUser | undefined,
     reason: string,
): void {
     const entry = {
          event: 'access_denied',
          method: req.method,
          path: req.path,
          reason,
          userId: user?.id ?? null,
          userRole: user?.role ?? null,
          userAddress: user?.address ?? null,
          timestamp: new Date().toISOString(),
     }
     console.warn(JSON.stringify(entry))
}

import { UnauthorizedError, ForbiddenError } from '../lib/errors.js'

/**
 * Resolves the caller from `req.user`.
 * Throws UnauthorizedError when the caller is unauthenticated.
 */
function resolveUser(
     req: Request,
): AuthenticatedUser {
     const user = (req as any).user as AuthenticatedUser | undefined
     if (!user) {
          logDenial(req, undefined, 'unauthenticated')
          throw new UnauthorizedError('Unauthenticated')
     }
     return user
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

/**
 * Requires the caller to have **exactly** one of the listed roles.
 *
 * @example
 * router.post('/admin/slash', requireRole('admin'), handler)
 * router.get('/verify',       requireRole('admin', 'verifier'), handler)
 */
export function requireRole(...roles: Role[]) {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req)

          if (!roles.includes(user.role)) {
               logDenial(req, user, `role "${user.role}" not in [${roles.join(', ')}]`)
               throw new ForbiddenError(`Forbidden: role "${user.role}" not in [${roles.join(', ')}]`)
          }

          next()
     }
}

/**
 * Requires the caller's role to be **at least as privileged** as `minRole`
 * according to ROLE_HIERARCHY.
 *
 * @example
 * router.get('/bonds', requireMinRole('verifier'), handler)
 * // allows verifier AND admin; blocks user and public
 */
export function requireMinRole(minRole: Role) {
     return (req: Request, res: Response, next: NextFunction): void => {
          const user = resolveUser(req)

          if (ROLE_HIERARCHY[user.role] < ROLE_HIERARCHY[minRole]) {
               logDenial(req, user, `role "${user.role}" below minimum "${minRole}"`)
               throw new ForbiddenError(`Forbidden: role "${user.role}" below minimum "${minRole}"`)
          }

          next()
     }
}

/**
 * Allows any authenticated caller regardless of role.
 * Blocks only unauthenticated (no `req.user`) requests.
 *
 * @example
 * router.get('/profile', requireAnyRole(), handler)
 */
export function requireAnyRole() {
     return (req: Request, res: Response, next: NextFunction): void => {
          resolveUser(req)
          next()
     }
}